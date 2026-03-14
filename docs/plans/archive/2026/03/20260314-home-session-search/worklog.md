# Worklog

## Timeline

### 0001
- 日時: 2026-03-14
- チェックポイント: 実装着手
- 実施内容: 検索対象に使える session field を棚卸しし、`taskTitle` と `workspacePath` に絞る方針を確定した
- 検証:
- メモ: 未実装
- 関連コミット:

### 0002
- 日時: 2026-03-14
- チェックポイント: Home の session 検索を実装
- 実施内容: `Recent Sessions` の上部に検索入力を追加し、`taskTitle / workspacePath / workspaceLabel` の部分一致で `running / interrupted` chip と idle card を同時に絞り込むようにした。一致 0 件用の空状態も追加し、関連 docs を更新した
- 検証: `npm run typecheck`, `npm run build`
- メモ: 会話本文や metadata 全文検索は入れず、resume picker 用途に限定した
- 関連コミット:

## Open Items
- なし
