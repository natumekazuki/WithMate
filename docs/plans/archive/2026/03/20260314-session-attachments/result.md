# Result

## Status

- 状態: 完了

## Completed

- Session Window composer に `File / Folder / Image` picker を追加した
- textarea の `@path` を Main Process で解決して attachment chip に反映するようにした
- 通常ファイル/フォルダは prompt 参照 + `additionalDirectories`、画像は SDK structured input に分けた
- prompt composition / provider adapter / desktop UI / audit log / manual test checklist を更新した

## Remaining Issues

- `@path` の入力補助 UI は今後改善余地がある
- 添付だけで送信するケースは未対応

## Related Commits

- 

## Rollback Guide

- 戻し先候補: この Plan 開始前の `master`
- 理由: 添付 UX と Main Process API の追加をまとめて戻せる

## Related Docs

- `docs/design/prompt-composition.md`
- `docs/design/provider-adapter.md`
- `docs/design/desktop-ui.md`
- `docs/design/audit-log.md`
- `docs/manual-test-checklist.md`
