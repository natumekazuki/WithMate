# Result

- status: completed
- summary:
  - Copilot は SDK 上に quota / context usage の観測点があり、UI 実装可能
  - Codex SDK は token usage 止まりで、残量や reset 時刻を出すには SDK 外の別経路が必要

## Findings

1. Copilot は local SDK だけでかなり取れる
   - `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts` に `client.rpc.account.getQuota()` があり、`quotaSnapshots` として `entitlementRequests`、`usedRequests`、`remainingPercentage`、`overage`、`resetDate` を取れる
   - `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts` の `assistant.usage` には token 数だけでなく `quotaSnapshots`、`cost`、`duration`、`copilotUsage` がある
   - 同じく `session.usage_info` には `tokenLimit`、`currentTokens`、`messagesLength`、`systemTokens` などの context window 使用量がある

2. current の Copilot 実装は情報を一部捨てている
   - `src-electron/copilot-adapter.ts` は `assistant.usage` を受けているが、現在は `AuditLogUsage` へ丸めて token 数だけに落としている
   - `src-electron/copilot-adapter.ts` の `COPILOT_DROPPED_RAW_EVENT_TYPES` には `session.usage_info` が入っており、現 UI / audit では見えない
   - つまり Copilot 側は adapter と `LiveSessionRunState` を拡張すれば、比較的小さい差分で `残量 / reset / context usage` を出せる

3. Codex SDK は current surface だと token usage 止まり
   - `node_modules/@openai/codex-sdk/dist/index.d.ts` の `TurnCompletedEvent` / `Usage` で取れるのは `input_tokens`、`cached_input_tokens`、`output_tokens` だけ
   - local install の `@openai/codex-sdk` には `rate limit remaining` や `quota reset` を返す event / field は見当たらない
   - `src-electron/codex-adapter.ts` も current は token usage を audit / artifact に使うだけで、残量情報は取っていない

4. Codex で残量を出すなら SDK 外の経路が要る
   - OpenAI 公式 docs には project rate limits endpoint と usage endpoint がある
   - ただし WithMate current は `@openai/codex-sdk` 経由で turn を回しており、その stream から account/project の残量は返ってこない
   - したがって Codex 側の `残量 / reset` 可視化は、stored API key を使った別 REST poller として設計する必要がある

## Recommendation

- Issue `#11` は 2 段階に切るのが自然
  1. Copilot: `assistant.usage` と `account.getQuota()` を使って premium request / context usage を出す
  2. Codex: OpenAI API の usage / rate limit endpoint を別経路で叩くかを判断する

- provider 共通 UI に最初から寄せすぎない方が安全
  - 共通で出せるのは current では `token usage` まで
  - `残量 / reset / premium request` は Copilot の方が豊富
  - 第 1 slice は `Copilot provider card` として出し、Codex は follow-up に分ける方が筋がよい

## Sources

- local:
  - `src-electron/copilot-adapter.ts`
  - `src-electron/codex-adapter.ts`
  - `src/app-state.ts`
  - `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts`
  - `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`
  - `node_modules/@openai/codex-sdk/dist/index.d.ts`
- official:
  - https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-premium-requests
  - https://docs.github.com/en/copilot/concepts/billing/copilot-requests
  - https://developers.openai.com/api/reference/resources/organization/subresources/projects/subresources/rate_limits
  - https://platform.openai.com/docs/api-reference/usage/costs?api-mode=responses&lang=curl

## Notes

- 関連実装コミット: `2eac239` `feat(copilot): premium requests と context usage を可視化`
