# Audit Log Prompt Schema Redesign Worklog

## 2026-03-24

- plan を作成した
- 現行 `audit_logs` が `system_prompt_text / input_prompt_text / composed_prompt_text` 固定であることを確認した
- `src/App.tsx` の Audit Log overlay も同じ 3 セクション前提であることを確認した
- `src/app-state.ts` / `src-electron/provider-runtime.ts` の shared type を `logicalPrompt` / `transportPayload` ベースへ更新した
- `src-electron/audit-log-storage.ts` を `logical_prompt_json` / `transport_payload_json` の write-path へ切り替えた
- `src-electron/codex-adapter.ts` / `src-electron/copilot-adapter.ts` で provider ごとの transport payload 要約を返すようにした
- `src/App.tsx` の Audit Log overlay を `Logical Prompt` / `Transport Payload` 表示へ更新した
- `scripts/tests/audit-log-storage.test.ts` / `scripts/tests/copilot-adapter.test.ts` を更新し、`node --import tsx scripts/tests/audit-log-storage.test.ts`、`node --import tsx scripts/tests/copilot-adapter.test.ts`、`npm run build` を通した
- `docs/design/audit-log.md` / `docs/design/provider-adapter.md` / `docs/design/prompt-composition.md` / `docs/manual-test-checklist.md` を更新した
- `.ai_context/` はこの repo に存在しないため更新対象なし、`README.md` は今回の内部監査構造変更では入口仕様が変わらないため更新不要と判断した
- コミット: `b892f01` `feat(runtime): 監査ログ構造化と DB 初期化を改善`
