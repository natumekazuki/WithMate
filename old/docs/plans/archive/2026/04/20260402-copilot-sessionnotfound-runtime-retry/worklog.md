# worklog

## 2026-04-02

- user 報告の `Copilot / SessionNotFound / agent 切り替えで一時回復` を起点に既存 recovery 実装を確認した
- `resumeSession()` fallback はあるが、cached session reuse 中の `session.send()` failure は `shouldRetryCopilotTurn()` に入っていないことを確認した
- `src-electron/copilot-adapter.ts` で missing session を adapter retry classifier に追加し、partial 判定を user-visible partial 基準へ変更した
- `scripts/tests/copilot-adapter.test.ts` に `SessionNotFound` retry と `rawItems only` 非blocking 判定の回帰を追加した
- `npm run build` と `node --import tsx scripts/tests/copilot-adapter.test.ts` を通した
- commit `b15a4e9` `fix(copilot): retry stale cached sessions`
  - checkpoint: cached Copilot session の `SessionNotFound` recovery、retry partial 判定見直し、provider-adapter design 同期
