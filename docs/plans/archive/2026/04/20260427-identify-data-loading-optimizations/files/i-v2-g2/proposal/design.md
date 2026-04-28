# V2 session read adapter design

- `SessionStorageV2Read` は read-only に限定し、V2 `sessions` と `session_messages`、必要時 `session_message_artifacts` から既存 `Session` / `SessionSummary` shape を復元する。
- `listSessionSummaries()` は V2 `sessions` の header 列のみ参照する。
- `getSession(sessionId)` は対象 header と message rows を読み、message は `seq ASC` で返す。
- `artifact_available=1` の message は `session_message_artifacts.artifact_json` を parse して message artifact に戻す。
- `stream` は全て `[]` とし、V1 `stream_json` 依存を再導入しない。
- `allowed_additional_directories_json` が壊れている row は summary 取得時に skip、detail 取得時に throw する。
