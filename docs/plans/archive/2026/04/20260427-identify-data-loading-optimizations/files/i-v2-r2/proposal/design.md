# 設計ノート: V2 session read adapter test

## スコープ

- 対象スライス: `V2 runtime read-path`
- 対象フェーズ: red
- 変更対象ファイル: `scripts/tests/session-storage-v2-read.test.ts`
- 本体実装: `src-electron/session-storage-v2-read.ts` は未実装として扱う

## 期待仕様

- test DB は `CREATE_V2_SCHEMA_SQL` を使って作成する。
- `SessionStorageV2Read` は `listSessionSummaries()`、`getSession(sessionId)`、`close()` を持つ。
- `listSessionSummaries()` は V2 `sessions` header だけから summary shape を復元する。
- `getSession()` は V2 `session_messages` を `seq ASC` で復元し、`session_message_artifacts` から artifact を戻す。
- V2 には `stream_json` がないため、`stream` は `[]` として返す。
- 壊れた `allowed_additional_directories_json` は summary では skip、detail では throw する。
