# Worklog

## Timeline

### 0001
- 日時: 2026-03-14
- チェックポイント: 実装着手
- 実施内容: Characters 側を Recent Sessions と同じ検索 + action toolbar パターンへ寄せる方針を決めた
- 検証:
- メモ: 未実装
- 関連コミット:

### 0002
- 日時: 2026-03-14
- チェックポイント: Characters 検索と toolbar 共通化を実装
- 実施内容: Home の検索アイコンを SVG に置き換え、Recent Sessions / Characters の両方で同じ toolbar パターンを使うようにした。Characters には `name / description` の部分一致検索を追加し、card 装飾も Recent Sessions と同じ温度感へ寄せた。関連 docs を更新した
- 検証: `npm run typecheck`, `npm run build`
- メモ: Characters 検索一致 0 件時の空状態も追加した
- 関連コミット:

## Open Items
- なし
