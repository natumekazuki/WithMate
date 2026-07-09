# 進行提案 (implementer-v2-audit-write-red)

- slice id: `implementer-v2-audit-write-red`
- phase: `V2 write path / audit`
- tdd mode: `red`
- 目的: `AuditLogStorageV2Read` の write API 未実装を前提に、`createAuditLog` / `updateAuditLog` / `clearAuditLogs` の仕様をテストで固定する。
- 対象ファイル: `scripts/tests/audit-log-storage-v2-read.test.ts`
- 実装方針:
  - 実装コードは変更しない。
  - 変更は失敗する Red テストの追加のみ。
  - `AuditLogStorageV2Read` の既存 read テストに、V2 audit split schema 書込時の期待を追加。

## 追加する Red テスト

- `createAuditLog`:
  - `audit_logs`、`audit_log_details`、`audit_log_operations` への保存を期待する。
  - `listSessionAuditLogs` で `AuditLogEntry` が `logicalPrompt` / `transportPayload` / `usage` / `operations` を含む full shape で復元されることを検証する。
- `updateAuditLog`:
  - summary / detail / operations の値が置換されること。
  - 更新後も `audit_log_operations` が旧件数を残さず、新しい operations だけになることを検証する。
- `clearAuditLogs`:
  - `audit_logs` 全削除後に `audit_log_details` と `audit_log_operations` も残らないことを検証する。
