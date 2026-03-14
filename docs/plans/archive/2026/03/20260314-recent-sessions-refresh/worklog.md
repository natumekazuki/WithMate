# Worklog

## Timeline

### 0001
- 日時: 2026-03-14
- チェックポイント: 実装着手
- 実施内容: 表示要素の分解と生成元の棚卸しを行った
- 検証:
- メモ: 未実装
- 関連コミット:

### 0002
- 日時: 2026-03-14
- チェックポイント: Recent Sessions と空 session 表示の整理を実装
- 実施内容: Home card から待機 badge と taskSummary を削除し、`Workspace : <path>` と `updatedAt: yyyy/MM/dd HH:mm` を表示する形へ変更した。session の `updatedAt` 生成を共通 helper へ寄せ、空 session の初期 assistant メッセージも撤去した。関連 docs を更新した
- 検証: `npm run typecheck`, `npm run build`
- メモ: legacy の `just now` は読み込み時のみ現在時刻へ寄せる互換処理を残した
- 関連コミット:

## Open Items
- なし

