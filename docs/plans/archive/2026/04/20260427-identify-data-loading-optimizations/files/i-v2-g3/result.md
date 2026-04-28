# V2 audit log read adapter 結果

- phase: green (implementation)
- slice id: `i-v2-g3`
- tdd_phase: `green`

## 実装要約

- `src-electron/audit-log-storage-v2-read.ts` を新規実装。
- `AuditLogStorageV2Read`:
  - `constructor(dbPath: string)` で `openAppDatabase(dbPath)` を使用
  - `listSessionAuditLogs(sessionId)` で `audit_logs` を `session_id` で絞り、`id DESC` で整列
  - `LEFT JOIN` で `audit_log_details` を吸収し、欠損時は既定値を返却
  - `audit_log_operations` を `sessionId` 絞り取り＋`audit_log_id` 毎に `seq ASC` で復元
- `assistantText` は detail の `assistant_text` を優先（details がない場合は空文字）
- `usage` は `usage_json` 優先、無い場合は `input_tokens/cached_input_tokens/output_tokens` から復元

## 検証結果

- `npx tsx --test scripts/tests/audit-log-storage-v2-read.test.ts scripts/tests/audit-log-storage.test.ts`
  - `audit-log-storage-v2-read.test.ts`: **failed**
  - 失敗原因: `insertSessionHeader` の `INSERT INTO sessions ... VALUES` で 26 values と 27 columns 指定不一致 (`ERR_SQLITE_ERROR: 26 values for 27 columns`) により、テスト前処理で停止
- `npm run build:electron`: **pass**
