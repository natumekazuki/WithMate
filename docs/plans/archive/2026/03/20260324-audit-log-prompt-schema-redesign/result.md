# Audit Log Prompt Schema Redesign Result

## Status

- 状態: completed

## Summary

- audit log の prompt 監査を、固定 3 カラムから `logicalPrompt` と `transportPayload` の 2 層へ再設計した
- SQLite `audit_logs` は `logical_prompt_json` / `transport_payload_json` を正本にし、provider adapter も Codex / Copilot それぞれの transport 要約を返すようにした
- Session Window の Audit Log overlay も `Logical Prompt` / `Transport Payload` 表示へ切り替えた

## Updated Files

- `src/app-state.ts`
- `src-electron/provider-runtime.ts`
- `src-electron/provider-prompt.ts`
- `src-electron/audit-log-storage.ts`
- `src-electron/main.ts`
- `src-electron/codex-adapter.ts`
- `src-electron/copilot-adapter.ts`
- `src/App.tsx`
- `scripts/tests/audit-log-storage.test.ts`
- `scripts/tests/copilot-adapter.test.ts`
- `docs/design/audit-log.md`
- `docs/design/provider-adapter.md`
- `docs/design/prompt-composition.md`
- `docs/manual-test-checklist.md`

## Verification

- `node --import tsx scripts/tests/audit-log-storage.test.ts`
- `node --import tsx scripts/tests/copilot-adapter.test.ts`
- `npm run build`

## Commits

- `b892f01` `feat(runtime): 監査ログ構造化と DB 初期化を改善`
