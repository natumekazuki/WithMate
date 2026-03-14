# Worklog

## Timeline

### 0001

- 日時: 2026-03-14
- チェックポイント: 原因確認
- 実施内容:
  - `src/App.tsx`
  - `src-electron/main.ts`
  - `src-electron/model-catalog-storage.ts`
  を確認した
- メモ: Session Window が `session.catalogRevision` 固定で catalog を読んでいるため、active revision import 後も旧 catalog に留まる
- 関連コミット:

### 0002

- 日時: 2026-03-14
- チェックポイント: active catalog 追従の実装
- 実施内容:
  - `src/App.tsx` を更新し、Session Window の model / depth 候補が常に active catalog を参照するようにした
  - model / depth を変更した時に `session.catalogRevision` も active revision へ更新するようにした
  - `docs/design/model-catalog.md` と `docs/design/session-persistence.md` を current behavior に合わせて更新した
  - `docs/manual-test-checklist.md` に既存 session での catalog import 反映確認を追加した
- 検証:
  - `npm run typecheck`
  - `npm run build`
- 関連コミット:
