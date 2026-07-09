# Worklog

## Timeline

### 0001
- 日時: 2026-03-14
- チェックポイント: 着手
- 実施内容: character theme color の適用範囲と保存方針を整理した
- 検証:
- メモ: 実装前
- 関連コミット:

### 0002
- 日時: 2026-03-14
- チェックポイント: theme color 実装
- 実施内容: character に `main / sub` の 2 色テーマを追加し、Character Editor に color picker + RGB 入力を実装した。Session Window は session snapshot に保存した theme を使って主要な色を切り替えるようにした。
- 検証:
  - `npm run typecheck`
  - `npm run build`
- メモ: 既存 character / session は default color を使って後方互換を保つ。
- 関連コミット:
