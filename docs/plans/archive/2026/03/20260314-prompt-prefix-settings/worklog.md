# Worklog

## Timeline

### 0001

- 日時: 2026-03-14
- チェックポイント: 現行 prompt / settings / audit log の確認
- 実施内容:
  - `docs/design/prompt-composition.md`
  - `docs/design/settings-ui.md`
  - `docs/design/audit-log.md`
  - `src-electron/model-catalog-storage.ts`
  - `src/HomeApp.tsx`
  を確認した
- 検証: 設定永続化機構が未実装で、prompt も監査ログも構造化されていないことを確認
- メモ: `System Prompt Prefix` は app 設定で持つのが自然
- 関連コミット:

### 0002

- 日時: 2026-03-14
- チェックポイント: app settings / prompt composition / audit log / settings UI の実装
- 実施内容:
  - `src-electron/app-settings-storage.ts` を追加し、SQLite の `app_settings` table で `System Prompt Prefix` を保持するようにした
  - `src-electron/main.ts` に settings IPC と prompt composition への settings 注入を追加した
  - `src-electron/codex-adapter.ts` で `system / input / composed prompt` を返す構造に変更した
  - `src-electron/audit-log-storage.ts` を新列対応と旧 schema 互換の両立に更新した
  - `src/HomeApp.tsx` の Settings overlay に `System Prompt Prefix` 編集 UI を追加した
  - `src/App.tsx` の audit log overlay を `System Prompt / Input Prompt / Composed Prompt` 表示へ変更した
  - 関連 Design Doc / README / 実機テスト項目表を更新した
- 検証:
  - `npm run typecheck`
  - `npm run build`
- メモ: audit log table は旧列を残しつつ、新列 `system_prompt_text` / `input_prompt_text` / `composed_prompt_text` を正本にした
- 関連コミット:

## Open Items

- なし
