# V2 audit log read adapter 実装サマリ

- slice: V2 runtime read-path / phase 3
- mode: green
- 変更:
  - `src-electron/audit-log-storage-v2-read.ts` を追加
- 実装 API:
  - `AuditLogStorageV2Read`
  - `constructor(dbPath: string)`
  - `listSessionAuditLogs(sessionId: string)`
  - `close()`
- 読み取り挙動:
  - `audit_logs` 単体を `session_id = ?`、`id DESC` で取得
  - `audit_log_details` を `LEFT JOIN` して `AuditLogEntry` を復元
  - `audit_log_operations` を `sessionId` 絞りで取得し `seq ASC` で復元
  - detail 欠損時は `logicalPrompt`/`transportPayload`/`assistantText`/`rawItemsJson` を既定値化
  - `usage_json` 優先、無い場合は summary token (`input_tokens` など) で再構成
- 検証注意:
  - `npm run build:electron` は pass
  - `audit-log-storage-v2-read.test.ts` は fixture 側 SQL の引数数不一致 (`26 values for 27 columns`) により起動時点で失敗
