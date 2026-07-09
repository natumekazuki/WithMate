# 設計ノート: V2 audit log read adapter (Red phase)

## スコープ

- 対象スライス: `V2 runtime read-path`
- 対象フェーズ: red
- 対象ファイル: `scripts/tests/audit-log-storage-v2-read.test.ts`
- 本体実装: `src-electron/audit-log-storage-v2-read.ts` は未実装扱い

## 期待仕様

- テスト DB は `CREATE_V2_SCHEMA_SQL` で作成する。
- `AuditLogStorageV2Read` は `constructor(dbPath: string)`、`listSessionAuditLogs(sessionId: string): AuditLogEntry[]`、`close(): void` を持つ。
- `listSessionAuditLogs` は V2 `audit_logs` の `session_id` フィルタと `id DESC` の順序を満たす。
- `audit_log_details` と `audit_log_operations` を結合し、`AuditLogEntry` の公開 shape を復元する。
- `assistantText` は `audit_log_details.assistant_text` を参照する。
- `operations` は `seq ASC` でソートされる。
- `usage` は `audit_log_details.usage_json` から復元。空の場合は `token` 列から再構成も可、許容される場合は `null`。
- `audit_log_details` が欠損していても、次をデフォルトで復元する。
  - `logicalPrompt`: 空文字列3項目
  - `transportPayload`: `null`
  - `assistantText`: 空文字
  - `rawItemsJson`: `"[]"`
  - `usage`: `null`