# Copilot SystemMessage Character Prompt Worklog

## 2026-03-24

- plan を作成した
- 前提調査として `docs/plans/archive/2026/03/20260324-copilot-character-prompt-surface-survey/` の結果を参照する方針を確定した
- `src-electron/provider-runtime.ts` / `src-electron/provider-prompt.ts` に `systemBodyText` / `inputBodyText` を追加し、監査表示と transport 本文を分けた
- `src-electron/copilot-adapter.ts` で `SessionConfig.systemMessage` `mode: "append"` を組み立て、`session.send()` には `inputBodyText` を送るようにした
- Copilot session cache key に `systemMessage` 内容を含めるよう更新した
- `scripts/tests/copilot-adapter.test.ts` に systemMessage 変換テストを追加し、`node --import tsx scripts/tests/copilot-adapter.test.ts`、`node --import tsx scripts/tests/audit-log-storage.test.ts`、`npm run build` を通した
- `docs/design/provider-adapter.md` / `docs/design/prompt-composition.md` / `docs/manual-test-checklist.md` を更新した
- コミット: `b892f01` `feat(runtime): 監査ログ構造化と DB 初期化を改善`
