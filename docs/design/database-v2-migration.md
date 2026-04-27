# Database V2 Migration

- 作成日: 2026-04-27
- 対象: V1 `withmate.db` から V2 `withmate-v2.db` への移行方針

## Goal

WithMate の DB を V2 として新規定義し、V1 の巨大 JSON / legacy Memory / Monologue schema を引きずらない保存構造へ移行する。

V1 から V2 への移行は app 起動時の破壊的 migration ではなく、別スクリプトで行う。

## Decision

- V1 DB filename は `withmate.db` とする。
- V2 DB filename は `withmate-v2.db` とする。
- V1 schema の SQL 正本は `src-electron/database-schema-v1.ts` に集約する。
- V2 schema の SQL 正本は `src-electron/database-schema-v2.ts` に置く。
- V1 から V2 への移行処理は app runtime へ混ぜず、専用 migration script として実装する。
- V1 DB は読み取り元として残し、自動削除しない。
- V2 では MemoryGeneration / Monologue / memory legacy table を正本 schema に含めない。
- V1 `sessions.stream_json` は独り言 legacy 表現として扱い、V2 へ移行しない。

## V1 Schema Source

`src-electron/database-schema-v1.ts` は、現在の production schema を表す。

- `app_settings`
- `sessions`
- `audit_logs`
- `model_catalog_revisions`
- `model_catalog_providers`
- `model_catalog_models`
- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`

V1 の storage class は当面この schema source を参照し、既存 DB 互換を維持する。

## V2 Schema

V2 は data loading optimization を前提に、一覧用 metadata と詳細 payload を分離する。SQL 定数の正本は `src-electron/database-schema-v2.ts` に置く。

### Sessions

- `sessions`
  - session header / 一覧表示に必要な軽量列だけを持つ
  - `message_count` / `audit_log_count` を denormalized counter として持つ
- `session_messages`
  - 1 message = 1 row
  - `session_id`, `seq`, `role`, `text`, `accent`, `artifact_available`, `created_at`
- `session_message_artifacts`
  - 1 message artifact = 1 row
  - message 本文一覧では読まず、artifact 展開時だけ読む

V2 では `sessions.messages_json` と `sessions.stream_json` を正本にしない。Home 一覧と session summary は `sessions` だけを読む。

### Audit Logs

- `audit_logs`
  - 一覧用 metadata / preview / counters を持つ
  - `assistant_text_preview`, `operation_count`, `raw_item_count`, token count, `has_error` を持つ
- `audit_log_details`
  - `logical_prompt_json`
  - `transport_payload_json`
  - `assistant_text`
  - `raw_items_json`
  - `usage_json`
- `audit_log_operations`
  - 1 operation = 1 row
  - audit timeline / operation list はこの table を読む

V2 では audit log 一覧で detail JSON を読まない。
`raw_items_json` はデバッグ用途の raw payload として肥大化しやすいが、通常 UI で検索・並び替え・個別ページングしないため、実運用バランスとして `audit_log_details` の detail blob に残す。

### App Settings / Model Catalog

V2 でも次の共通 table は保持する。

- `app_settings`
- `model_catalog_revisions`
- `model_catalog_providers`
- `model_catalog_models`

### Removed Legacy Domains

V2 の正本 schema には次を含めない。

- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- `sessions.stream_json`
- MemoryGeneration / Character Reflection 用 settings key
- background memory / monologue log

V1 DB は legacy data として保持されるため、V2 正本 schema はこれらの退避先を持たない。

## Migration Mapping

### Copy

- `sessions` header 列を V2 `sessions` へコピーする。
- `app_settings` は MemoryGeneration / Character Reflection 用 legacy key を除外してコピーする。
- `model_catalog_*` は revision の整合を保ってコピーする。

### Transform

- V1 `sessions.messages_json` は JSON 配列として parse し、配列 index を `seq` として `session_messages` へ insert する。
- message `role` は `user` / `assistant` 以外を skip し、migration report に記録する。
- message `accent` は boolean を `0` / `1` へ変換する。
- message `artifact` は存在する場合だけ `artifact_available = 1` にし、`session_message_artifacts.artifact_json` へ JSON 文字列として保存する。
- V1 `audit_logs.assistant_text` は `assistant_text_preview` と `audit_log_details.assistant_text` へ分ける。
- V1 `audit_logs.operations_json` は配列長を `operation_count` に保存し、配列要素を `audit_log_operations` へ `seq` 付きで展開する。
- V1 `audit_logs.raw_items_json` は配列長を `raw_item_count` に保存し、全文は `audit_log_details.raw_items_json` へ移す。
- V1 `audit_logs.usage_json` は token count 列へ展開し、全文は `audit_log_details.usage_json` へ移す。
- V1 `audit_logs.logical_prompt_json` / `transport_payload_json` は `audit_log_details` へ移す。

### Skip

- `sessions.stream_json`
- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- MemoryGeneration / Character Reflection 用 setting key
- background memory / monologue log

skip した件数と理由は migration report に記録する。

### Broken JSON

V1 の broken JSON は V2 本体へ raw 退避列を増やさない。対象 row / field を skip し、migration report に次を記録する。

- source table
- source id
- source column
- error kind
- action

## Migration Script Requirements

V1 -> V2 migration script は次を満たす。

- `scripts/migrate-database-v1-to-v2.ts --dry-run --v1 <path>` で V1 DB を読み取り専用で確認する
- `scripts/migrate-database-v1-to-v2.ts --write --v1 <path> --v2 <path> [--overwrite]` で V2 DB を作成する
- `dry-run` で件数、推定 JSON size、skip 対象、broken JSON を出す
- V2 DB 作成前に既存 V2 DB の扱いを明示する
- V1 DB と V2 DB に同一 path または SQLite companion file の衝突がある場合は、`--overwrite` 指定があっても拒否する
- `--overwrite` 指定時は既存 V2 DB と `-wal` / `-shm` を退避し、migration 失敗時は作成途中の V2 DB を削除して退避 DB を復旧する
- V1 DB は変更しない
- V2 DB 作成は transaction で行う
- migration report を出力する
- sessions / messages / audit logs の移行件数を記録する
- legacy Memory / Monologue data は移行しないか、別 archive として明示する
- broken JSON と skip row を migration report に記録する
- V2 schema が JSON payload として扱う列には、parse に失敗した V1 JSON 文字列をそのまま持ち込まない
- `audit_logs.assistant_text_preview` は一覧用の bounded preview とし、全文は `audit_log_details.assistant_text` に保存する

### Dry-run Report

dry-run report は JSON で出力し、次を含める。

- `v1Counts`
  - V1 table の入力件数
- `plannedV2Counts`
  - V2 table ごとの insert 予定件数
  - `sessionMessageArtifacts` と `auditLogOperations` も含める
- `skipped`
  - `streamEntries`
  - `backgroundAuditLogs`
  - legacy app settings
  - memory legacy table 件数
  - invalid message / audit operation 件数
- `estimatedSourceBytes`
  - `messages_json`
  - `stream_json`
  - `operations_json`
  - `raw_items_json`
  - `usage_json`
- `issues`
  - source table / id / column / error kind / action

### Write Report

write mode の report は dry-run と同じ集計構造を返し、実際に insert した V2 件数を `plannedV2Counts` に反映する。

write mode では dry-run と同じ変換ロジックを使う。V1 の broken JSON は V2 へ raw 退避せず、対象 payload を空文字または skip として扱い、`issues` に記録する。

`--overwrite` は V2 DB だけを対象にする。V1 DB と同一 path の指定、または `withmate.db-wal` / `withmate.db-shm` など SQLite companion file と衝突する指定は、既存データ破壊につながるため migration 開始前に拒否する。

write mode は session / audit log の header row を先に読み、`messages_json`、`stream_json`、`logical_prompt_json`、`transport_payload_json`、`assistant_text`、`operations_json`、`raw_items_json`、`usage_json` は対象 row の処理時に個別取得する。migration 中に単一 row の巨大 payload は扱うが、重い payload 全件を `.all()` で同時に保持しない。

## Startup Policy

app runtime は V2 migration を暗黙実行しない。

- V1 DB だけ存在する場合:
  - 当面は V1 `withmate.db` を開き、既存 runtime 互換を維持する
- V2 DB が存在する場合:
  - V2 DB を正本として開く
- V1 DB と V2 DB が両方存在する場合:
  - V2 DB を優先して開く
- V1 DB は backup / rollback source として残す

### Runtime Read-path First Slice

最初の runtime 対応 slice では、既存 IPC / preload / renderer contract を変更しない。

- `withmate-v2.db` が存在する場合だけ V2 read-path を使う
- app 起動時に V1 -> V2 migration script は呼ばない
- V2 runtime write-path はまだ切り替えない
- V1-only install は既存 V1 storage class で読み書きする

V2 read-path は既存 DTO shape を復元する互換 layer として扱う。

- runtime の DB 判定は `withmate-v2.db` の filename で行う
- runtime は `withmate-v2.db` を選択する前に、V2 の必須 table が存在することを検証する。空または未完成の V2 DB は V1 を shadow しない。
- V2 DB では `PersistentStoreLifecycleService` が V1 `SessionStorage` / `AuditLogStorage` を生成せず、`SessionStorageV2Read` / `AuditLogStorageV2Read` を使う
- V2 DB では session / audit log の write-capable method を明示エラーにし、V2 schema へ V1 writer が legacy column を作らないようにする
- V2 DB では legacy memory storage を生成しない。`SessionMemoryStorageV2Read` / `ProjectMemoryStorageV2Read` / `CharacterMemoryStorageV2Read` は read-only/no-op adapter として振る舞い、V2 DB に memory legacy table を作成しない。
- session summary は V2 `sessions` だけから復元し、`session_messages` / `session_message_artifacts` を読まない
- session detail は V2 `sessions`、`session_messages`、`session_message_artifacts` から `Session` を復元する
- V2 には `stream_json` がないため、session detail の `stream` は `[]` として復元する
- audit logs は既存 IPC contract 維持のため、当面は V2 `audit_logs`、`audit_log_details`、`audit_log_operations` から `AuditLogEntry[]` を復元する
- `assistantText` は `audit_log_details.assistant_text` の全文を使い、`audit_logs.assistant_text_preview` は一覧用 preview として保持する
- V2 read adapter は missing detail row を empty detail として扱い、既存 UI の表示を壊さない

## Related

- `src-electron/database-schema-v1.ts`
- `src-electron/database-schema-v2.ts`
- `docs/design/database-schema.md`
- `docs/design/data-loading-performance-audit.md`
