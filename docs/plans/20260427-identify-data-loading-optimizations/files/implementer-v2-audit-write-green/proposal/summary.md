# 進行提案 (implementer-v2-audit-write-green)

- slice id: `implementer-v2-audit-write-green`
- phase: `V2 write path / audit`
- tdd mode: `green`
- 目的: `AuditLogStorageV2Read` に write API を実装し、既存の read 挙動を維持しつつ `createAuditLog` / `updateAuditLog` / `clearAuditLogs` を有効化する。
- 対象ファイル: `src-electron/audit-log-storage-v2-read.ts`

## 追加する実装要件

- `createAuditLog`: summary/detail/operations を transaction 内で順次 insert。
- `updateAuditLog`: 対象 id がない場合は V1 と同じく `audit log {id} の更新に失敗したよ。` を throw。
- `updateAuditLog`: 既存 detail/operations を削除してから再作成し、operations を置換。
- `clearAuditLogs`: `audit_logs` を一括 delete（FK cascade で `audit_log_details` / `audit_log_operations` は物理削除）。
- `assistant_text_preview`: 500 文字上限。
- `operation_count`: `operations.length`。
- `raw_item_count`: `rawItemsJson` の JSON 配列長、parse 不可なら `0`。
- `token columns`: `usage` から `input_tokens` / `cached_input_tokens` / `output_tokens` を保存。
- `usage_json`: `usage` があれば `JSON.stringify(usage)`、なければ空文字。
- `has_error`: `errorMessage` が空文字でなければ `1`。
- `transportPayload` が `null` の場合 `transport_payload_json` は空文字。
- `main.ts` の writable guard は method 有無チェックのみのため、`AuditLogStorageV2Read` に本提案の実装追加で通過すると想定。
- リスト返却形状は既存 `listSessionAuditLogs` 経由の再構成で維持。

## 進行上の方針

- リポジトリ本体は未編集。
- 提案は `changes.patch` + `summary.md` + `result.md` + `progress.md` を更新。
