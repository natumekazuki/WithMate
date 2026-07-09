# Worklog

## Timeline

### 0001

- 日時: 2026-03-15
- チェックポイント: Plan 作成
- 実施内容: Session composer の `@path` 候補表示と添付解決正本の見直しを対象として plan を作成した
- 検証: 未実施
- メモ: 候補表示と添付正本化は段階を分けて進める
- 関連コミット: なし

### 0002

- 日時: 2026-03-15
- チェックポイント: workspace file path 検索と `@path` 候補表示
- 実施内容: workspace file path 検索 API と composer の `@path` 候補表示を実装した
- 検証: 実装確認
- メモ: 初段では textarea 入力中の候補表示導線を優先した
- 関連コミット: `cd3b29c` `feat(session): add @path workspace suggestions`

### 0003

- 日時: 2026-03-15
- チェックポイント: 添付正本の `@path` 統一
- 実施内容: picker で選んだ file / folder / image を textarea の `@path` へ挿入する方式へ変更し、添付解決の正本を textarea の `@path` に統一した
- 検証: `npm run typecheck`, `npm run build`
- メモ: picker 導線と手入力導線を 1 つの解決系へ揃えた
- 関連コミット:
  - `8a45ed0` `feat(session): make textarea @path the attachment source`
  - `f37170f` `docs(plan): record @path attachment source checkpoint`

## Open Items

- なし
