# Copilot Character Prompt Surface Survey Result

## Status

- 状態: completed

## Summary

- 現状の WithMate 実装では、`src-electron/provider-prompt.ts` が `systemPromptPrefix + character.roleMarkdown` を text prompt へ結合し、`CopilotAdapter` もそれを `session.send({ prompt })` にそのまま渡している
- install 済み `@github/copilot-sdk` には `SessionConfig.systemMessage` があり、`append` / `replace` / `customize` の 3 mode で session-level system prompt を渡せる
- したがって、Copilot では character prompt を main prompt から外し、`systemMessage` に寄せる実装が可能
- `CustomAgentConfig.prompt` も別経路として使えるが、character ごとに agent を組み立てる必要があり、常設 custom agent 設計と責務が混ざるため第一候補にはしにくい
- `session.send()` 自体には user prompt 以外の別 instruction channel は見当たらないため、per-turn で分離したい場合も session-level 設定側へ寄せるのが筋

## Findings

1. 現行の結合点
   - `src-electron/provider-prompt.ts` の `composeProviderPrompt()` が `systemPromptPrefix` と `character.roleMarkdown` を `# System Prompt` にまとめている
   - `src-electron/copilot-adapter.ts` は `session.send({ prompt: prompt.composedPromptText })` を送るため、Copilot でも text prompt に同梱される
2. Copilot SDK の分離候補
   - `SessionConfig.systemMessage`
     - default `append` で SDK 管理の guardrail を残したまま追加 instruction を渡せる
     - `customize` で `identity` / `tone` / `custom_instructions` などの section override もできる
   - `customAgents[].prompt`
     - selected agent の prompt として渡せる
     - ただし既存の custom agent 選択と競合しやすい
3. 実装時の注意点
   - `buildSessionConfig()` の cache key に `systemMessage` 内容を含める必要がある
   - audit log の `systemPromptText` / `composedPromptText` は「画面表示用の合成文字列」と「実際の transport」を分けて扱う再設計余地がある
   - `session.send()` に送る text は Copilot だけ `inputPromptText` 中心へ寄せる provider-specific 分岐が必要

## Recommendation

- 第一候補は `SessionConfig.systemMessage` を使う
- 初手は `mode: "append"` で `systemPromptPrefix + character.roleMarkdown` を渡すのが安全
- `replace` は SDK guardrail を外すため避ける
- `customize` は persona 調整を細かくしたくなった時の follow-up でよい

## Verification

- `src-electron/provider-prompt.ts`
- `src-electron/copilot-adapter.ts`
- `node_modules/@github/copilot-sdk/dist/types.d.ts`
- `node_modules/@github/copilot-sdk/README.md`
