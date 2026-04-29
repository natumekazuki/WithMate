# V2 audit log read adapter design

- `AuditLogStorageV2Read` は read-only のみを提供し、V2 スキーマの分割テーブルを統合して V1 の `AuditLogEntry` 形に復元する。
- `audit_logs` を主表として `session_id` 絞り込みで一覧を取得し、`id DESC` で並び替える。
- details がない場合も row は残すため、`LEFT JOIN` を利用して以下の既定値で穴埋めする。
  - `logicalPrompt`: `systemText` / `inputText` / `composedText` は空文字
  - `transportPayload`: `null`
  - `assistantText`: 空文字
  - `rawItemsJson`: `"[]"`
  - `usage`: `null`
- `assistantText` は detail の `assistant_text` を優先する。
- `usage` は `audit_log_details.usage_json` が使える場合はそれを採用し、使えない場合のみ summary token 列で再構成する。
- `audit_log_operations` は一度に取得し、`audit_log_id` でグループ化して `seq ASC` で復元する。
