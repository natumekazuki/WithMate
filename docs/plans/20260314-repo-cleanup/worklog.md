# Worklog

## Timeline

### 0001

- 日時: 2026-03-14
- チェックポイント: 棚卸し開始
- 実施内容: git status、ルート構成、`mock/`、`docs/plans/`、`package.json`、主要 docs を確認して cleanup 対象の候補を洗い出した
- 検証: `git status --short`、`Get-ChildItem`、`rg` による参照確認
- メモ: `mock/`、`ui-static-mock.md`、`ui-react-mock.md`、browser fallback、Codex SDK spike script、単発 Plan 群が主な整理対象候補
- 関連コミット: 未作成

### 0002

- 日時: 2026-03-14
- チェックポイント: 現状スナップショット固定
- 実施内容: cleanup 前の全差分をステージし、現時点の desktop prototype 一式を復元可能な状態でコミットした
- 検証: `git commit -m "feat(app): checkpoint current desktop prototype"`
- メモ: cleanup はこのコミットを基点に進める
- 関連コミット: `1aca726 feat(app): checkpoint current desktop prototype`

## Open Items

- cleanup 対象の最終確定
- cleanup 実装と docs 同期
- cleanup 後コミット
