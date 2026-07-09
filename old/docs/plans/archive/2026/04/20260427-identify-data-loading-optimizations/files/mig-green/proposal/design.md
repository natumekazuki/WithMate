# 設計メモ (V1→V2 migration write mode)

- 方針: dry-run ロジックを壊さず、write 専用の移行経路を追加。
- 追加 export: `createMigrationWriteReport({ v1DbPath, v2DbPath, overwrite? })`。
- V1 DB は `DatabaseSync` を `readOnly: true` で開き、read/write は行わない。
- V2 DB は `CREATE_V2_SCHEMA_SQL` で初期化。
- `--write` 実行時は `--v1` と `--v2` を必須にし、既存 V2 があり `overwrite` 未指定なら throw。
- `overwrite: true` 時のみ既存 V2 を削除して再作成。
- 書き込み本体は `BEGIN IMMEDIATE` / `COMMIT`（失敗時 `ROLLBACK`）でトランザクション化。
- sessions 移行: header 行をコピー、`message_count` は有効メッセージ数、`audit_log_count` は非 background audit 数。
- `session_messages` は `user`/`assistant` のみ、`artifact_available` は artifact 有無で 0/1。
- audit logs: background phase を除外し、summary metadata と detail payload を分離して保存。
- audit log operations: `operations_json` の配列を `seq` 0-based で保存（`operation_type` / `summary` / `details` 文字列正規化）。
- app setting は legacy キーを除外しコピー、memory 系 legacy tables はコピーしない。
- JSON 破損は dry-run と同様のキー (`sessions.messages_json`, `sessions.stream_json`, `audit_logs.operations_json`, `audit_logs.raw_items_json`, `audit_logs.usage_json`) で issue 記録し、対象 payload は保護的に空値扱いでスキップ。
