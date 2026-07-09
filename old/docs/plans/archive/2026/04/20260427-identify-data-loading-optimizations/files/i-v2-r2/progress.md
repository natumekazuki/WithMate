# 進捗: i-v2-r2 / phase 2 (Red)

- スライス: `V2 runtime read-path`
- TDDフェーズ: red
- 変更方針: 本番実装は行わず test だけ追加する
- 追加テスト: `scripts/tests/session-storage-v2-read.test.ts`
- 追加テスト観点
  - `CREATE_V2_SCHEMA_SQL` で作成した V2 DB から `listSessionSummaries()` が header のみで一覧復元できること
  - `session_messages` の seq 非順挿入と `session_message_artifacts` の紐付けを前提に、`getSession()` が `messages` を `seq ASC` で返すこと
  - V2 では `stream` が `[]` で返ること
  - `getSession()` の missing ID が `null` を返すこと
  - `allowed_additional_directories_json` が不正な row は summary を skip し、detail 取得時は例外になること
- 実装対象: なし
