# V2 DB Schema / Migration 設計案

この文書は canonical docs へ反映するための proposal であり、反映先候補は `docs/design/database-v2-migration.md` と `docs/design/database-schema.md`。

## Goal

V2 DB `withmate-v2.db` は、起動・一覧・監査ログ表示で巨大 JSON を読まない保存構造にする。V1 `withmate.db` は legacy data として残し、V1→V2 は通常起動ではなく別 migration script で実行する。

## Decisions

- V2 DB filename は `withmate-v2.db`。
- V2 schema source は `src-electron/database-schema-v2.ts`。
- V1 schema source は `src-electron/database-schema-v1.ts`。
- V1 DB は migration script の read-only 入力として扱う。
- V2 正本 schema には MemoryGeneration / monologue / memory legacy tables を含めない。
- `sessions` は header と messages を分ける。
- `audit_logs` は list 用 summary と detail payload を分ける。
- audit list API は `limit` / cursor 前提にする。
- V1 `sessions.stream_json` は独り言 legacy 表現のため V2 へ移行しない。

## V2 Tables

### `sessions`

責務:

- Home 一覧
- session 選択前の summary
- detail hydrate 要否判定
- message/audit 件数表示

V2 では `messages_json` と `stream_json` を持たない。

DDL 案:

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_title TEXT NOT NULL,
  task_summary TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  catalog_revision INTEGER NOT NULL DEFAULT 1,
  workspace_label TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  session_kind TEXT NOT NULL DEFAULT 'default',
  character_id TEXT NOT NULL,
  character_name TEXT NOT NULL,
  character_icon_path TEXT NOT NULL,
  character_theme_main TEXT NOT NULL DEFAULT '#6f8cff',
  character_theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
  run_state TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  codex_sandbox_mode TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  custom_agent_name TEXT NOT NULL DEFAULT '',
  allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  audit_log_count INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_sessions_last_active
  ON sessions(last_active_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_v2_sessions_workspace
  ON sessions(workspace_path, last_active_at DESC);

CREATE INDEX IF NOT EXISTS idx_v2_sessions_character
  ON sessions(character_id, last_active_at DESC);
```

### `session_messages`

責務:

- session detail の message 履歴
- message pagination / windowing
- V1 `sessions.messages_json` の展開先

DDL 案:

```sql
CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL DEFAULT '',
  accent INTEGER NOT NULL DEFAULT 0,
  artifact_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_v2_session_messages_session_seq
  ON session_messages(session_id, seq);

CREATE INDEX IF NOT EXISTS idx_v2_session_messages_session_id_desc
  ON session_messages(session_id, id DESC);
```

### `audit_logs`

責務:

- 監査ログ一覧
- latest N 件取得
- cursor pagination
- error / usage / operation count の軽量表示

V2 list API はこの table だけを読む。detail JSON は読まない。

DDL 案:

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  phase TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  assistant_text_preview TEXT NOT NULL DEFAULT '',
  operation_count INTEGER NOT NULL DEFAULT 0,
  raw_item_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  has_error INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  detail_available INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_v2_audit_logs_session_id_desc
  ON audit_logs(session_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_v2_audit_logs_session_created
  ON audit_logs(session_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_v2_audit_logs_phase
  ON audit_logs(session_id, phase, id DESC);
```

### `audit_log_details`

責務:

- 監査ログ詳細 modal 展開時の payload
- V1 `audit_logs` の重い JSON 列の移行先

DDL 案:

```sql
CREATE TABLE IF NOT EXISTS audit_log_details (
  audit_log_id INTEGER PRIMARY KEY,
  logical_prompt_json TEXT NOT NULL DEFAULT '{}',
  transport_payload_json TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  operations_json TEXT NOT NULL DEFAULT '[]',
  raw_items_json TEXT NOT NULL DEFAULT '[]',
  usage_json TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE
);
```

### `app_settings`

V2 でも app 共通設定は保持する。ただし MemoryGeneration / Character Reflection 用 legacy key は migration 対象外。

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### `model_catalog_*`

V2 でも model catalog は保持する。

- `model_catalog_revisions`
- `model_catalog_providers`
- `model_catalog_models`

## V2 API 定数案

`src-electron/database-schema-v2.ts` に次を置く。

- `APP_DATABASE_V2_FILENAME`
- `APP_DATABASE_V2_SCHEMA_VERSION`
- `V2_SCHEMA_STATUS`
- `V2_SCHEMA_DESIGN_NOTES`
- `CREATE_V2_APP_SETTINGS_TABLE_SQL`
- `CREATE_V2_SESSIONS_TABLE_SQL`
- `CREATE_V2_SESSION_MESSAGES_TABLE_SQL`
- `CREATE_V2_AUDIT_LOGS_TABLE_SQL`
- `CREATE_V2_AUDIT_LOG_DETAILS_TABLE_SQL`
- `CREATE_V2_MODEL_CATALOG_TABLES_SQL`
- `CREATE_V2_SCHEMA_SQL`
- `V2_SESSION_SUMMARY_COLUMNS`
- `V2_AUDIT_LOG_SUMMARY_COLUMNS`

`V2_SESSION_SUMMARY_COLUMNS` は `messages_json` / `stream_json` を含めない。`V2_AUDIT_LOG_SUMMARY_COLUMNS` は `logical_prompt_json` / `transport_payload_json` / `operations_json` / `raw_items_json` を含めない。

## Migration

### 入力と出力

- input: V1 `withmate.db`
- input schema: `src-electron/database-schema-v1.ts`
- output: V2 `withmate-v2.db`
- output schema: `src-electron/database-schema-v2.ts`

通常起動では migration を暗黙実行しない。migration script は dry-run と write mode を持つ。

### Transaction

write mode は次を 1 transaction で実行する。

1. V2 DB を作成する。
2. V2 schema を作成する。
3. V1 sessions header を V2 `sessions` へ copy する。
4. V1 `messages_json` を `session_messages` へ transform する。
5. V1 `audit_logs` を V2 `audit_logs` と `audit_log_details` へ transform する。
6. `app_settings` と `model_catalog_*` を copy する。
7. count 整合を検証する。
8. migration report を出力する。

### Copy

- `sessions` header
- `app_settings` の non-legacy key
- `model_catalog_*`

### Transform

- `sessions.messages_json` -> `session_messages`
- `audit_logs.assistant_text` -> `audit_logs.assistant_text_preview` と `audit_log_details.assistant_text`
- `audit_logs.operations_json` -> `audit_logs.operation_count` と `audit_log_details.operations_json`
- `audit_logs.raw_items_json` -> `audit_logs.raw_item_count` と `audit_log_details.raw_items_json`
- `audit_logs.usage_json` -> `audit_logs.input_tokens` / `cached_input_tokens` / `output_tokens` と `audit_log_details.usage_json`
- `audit_logs.logical_prompt_json` -> `audit_log_details.logical_prompt_json`
- `audit_logs.transport_payload_json` -> `audit_log_details.transport_payload_json`

### Skip

- `sessions.stream_json`
- `session_memories`
- `project_scopes`
- `project_memory_entries`
- `character_scopes`
- `character_memory_entries`
- MemoryGeneration / Character Reflection 用 setting key
- background memory / monologue log

Skip 理由:

- MemoryGeneration と独り言は機能削除対象。
- V2 正本 schema に legacy domain を持ち込むと、data loading optimization の構造改善が崩れる。
- V1 DB は legacy data として保持されるため、過去データの原本は失われない。

### Broken JSON

V2 schema に raw legacy 退避列は追加しない。broken JSON は対象 field を skip し、migration report に次を記録する。

- source table
- source id
- source column
- error kind
- action: `skipped`

## Query Policy

### Session

- `listSessionSummaries()` は `sessions` の summary columns のみを読む。
- `getSession(sessionId)` は `sessions` と `session_messages` を読む。
- message pagination を導入する場合は `session_messages(session_id, seq)` を使う。
- Home 起動時に `session_messages` を読まない。

### Audit Log

- `listSessionAuditLogs(sessionId, { limit, cursor })` は `audit_logs` の summary columns のみを読む。
- cursor は `id` の降順を基本にする。
- `getAuditLogDetail(auditLogId)` は `audit_log_details` を読む。
- modal 初期表示で detail JSON を読まない。

## Validation

- schema test:
  - V2 DDL が SQLite で作成できる。
  - legacy memory tables が作られない。
  - `sessions` に `messages_json` / `stream_json` がない。
  - `audit_logs` に detail JSON columns がない。
- migration test:
  - V1 messages が seq 付き row へ展開される。
  - V1 audit logs が summary/detail に分かれる。
  - broken JSON が report に出る。
  - V1 DB が変更されない。
- storage test:
  - session list は message table を読まない。
  - audit list は detail table を読まない。
  - limit/cursor が効く。

## Design Gate

- 推奨: repo-sync-required
- 理由: DB 正本 schema と migration 方針が canonical docs に影響するため、実装と同じ task で `docs/design/database-v2-migration.md` と `docs/design/database-schema.md` を更新する必要がある。
