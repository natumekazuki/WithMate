# 実装サマリー

## 変更ファイル
- `scripts/tests/database-v1-to-v2-migration.test.ts`

## 対応内容
- `createMigrationWriteReport`（write API）を前提とした red テストを 1 件追加。
- テストは V1 フィクスチャ DB から V2 DB を生成し、以下を検証する期待を宣言。
  - V2 主要テーブルのスキーマ作成
  - sessions header のコピー + `message_count` / `audit_log_count`
  - `session_messages` への message 展開
  - `session_message_artifacts` への artifact 分離
  - `audit_logs` の background 以外のみコピー
  - `audit_log_details` への detail payload コピー
  - `audit_log_operations` の `seq` 付き保存
  - legacy app setting / memory legacy table の除外
  - V1 sessions 件数の不変

## 対応状況
- レビュー観点: write API の実装は未着手（red のみ）

## フォローアップ
- Green フェーズで `scripts/migrate-database-v1-to-v2.ts` の `createMigrationWriteReport` を実装。
- 必要に応じて migration の seq 定義（0-based か 1-based）と detail JSON 取り込みルールを仕様と整合。
