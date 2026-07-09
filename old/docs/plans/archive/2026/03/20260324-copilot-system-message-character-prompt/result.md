# Copilot SystemMessage Character Prompt Result

## Status

- 状態: completed

## Summary

- Copilot では character prompt を main prompt 文字列から外し、`SessionConfig.systemMessage` `mode: "append"` に載せるようにした
- `session.send()` には user input 本文だけを送るように切り替え、character 指示と turn input の transport を分離した
- Copilot session cache key と audit `Transport Payload` も新しい経路に合わせて更新した

## Updated Files

- `src-electron/provider-runtime.ts`
- `src-electron/provider-prompt.ts`
- `src-electron/copilot-adapter.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/provider-adapter.md`
- `docs/design/prompt-composition.md`
- `docs/manual-test-checklist.md`

## Verification

- `node --import tsx scripts/tests/copilot-adapter.test.ts`
- `node --import tsx scripts/tests/audit-log-storage.test.ts`
- `npm run build`

## Commits

- `b892f01` `feat(runtime): 監査ログ構造化と DB 初期化を改善`
