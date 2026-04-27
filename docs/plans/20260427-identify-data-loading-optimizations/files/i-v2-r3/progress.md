# 進捗: i-v2-r3 / phase 3 (Red)

- スライス: `V2 runtime read-path`
- TDDフェーズ: red
- 変更方針: 本番コードは実装せず、テストのみ追加
- 追加テスト: `scripts/tests/audit-log-storage-v2-read.test.ts`
- テスト観点
  - `CREATE_V2_SCHEMA_SQL` で作成した V2 DB 上で `listSessionAuditLogs` の動作を検証
  - sessionId フィルタと `id DESC` の順序を確認
  - summary/detail/operations から `AuditLogEntry` を復元し、`assistantText` を `audit_log_details.assistant_text` で取得することを確認
  - `operations` を `seq ASC` で復元することを確認
  - `usage_json` からの usage 復元（空文字の扱いは token 列からの復元 or `null` 許容）
  - `audit_log_details` 欠損時にデフォルト値で復元されること（logicalPrompt/transportPayload/assistantText/rawItemsJson/usage）
- 実装対象: `scripts/tests/audit-log-storage-v2-read.test.ts` のみ
