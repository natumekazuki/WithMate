# Worklog

## Timeline

### 0001

- 日時: 2026-03-14
- チェックポイント: 現行 prompt composition の確認
- 実施内容:
  - `src-electron/codex-adapter.ts`
  - `docs/design/prompt-composition.md`
  を確認した
- メモ: 現行は `FIXED_SYSTEM_PROMPT` が先頭に常時注入されている
- 関連コミット:

### 0002

- 日時: 2026-03-14
- チェックポイント: 固定システム指示の撤去
- 実施内容:
  - `src-electron/codex-adapter.ts` から `FIXED_SYSTEM_PROMPT` を削除した
  - prompt composition を `System Prompt Prefix + character role + session context + user input` に変更した
  - `docs/design/prompt-composition.md` と関連 docs の文言を current behavior に更新した
- 検証:
  - `npm run typecheck`
  - `npm run build`
- 関連コミット:
