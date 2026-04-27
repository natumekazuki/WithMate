import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";

export const APP_DATABASE_V2_FILENAME = "withmate-v2.db";
export const APP_DATABASE_V2_SCHEMA_VERSION = 2;

export const V2_SCHEMA_STATUS = "ready-for-implementation";

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const V2_SCHEMA_DESIGN_NOTES = [
  "V2 は withmate-v2.db を正本にし、V1 withmate.db からの移行は別スクリプトで行う。",
  "V2 では MemoryGeneration / Monologue legacy table を正本 schema に含めない。",
  "V2 では session 一覧用 header と message/detail payload を分離する。",
  "V2 では audit log 一覧用 metadata と detail payload を分離する。",
  "V2 では UI 一覧・ページングに効く単位を row 化し、raw debug payload は必要最小限だけ detail blob に残す。",
  "V1 sessions.stream_json は独り言 legacy 表現のため V2 正本 schema と migration 対象から除外する。",
] as const;

export const CREATE_V2_APP_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const CREATE_V2_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    task_title TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL DEFAULT ${DEFAULT_CATALOG_REVISION},
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
    codex_sandbox_mode TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_CODEX_SANDBOX_MODE)},
    model TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_MODEL_ID)},
    reasoning_effort TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_REASONING_EFFORT)},
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
`;

export const CREATE_V2_SESSION_MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL DEFAULT '',
    accent INTEGER NOT NULL DEFAULT 0,
    artifact_available INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v2_session_messages_session_seq
    ON session_messages(session_id, seq);

  CREATE INDEX IF NOT EXISTS idx_v2_session_messages_session_id_desc
    ON session_messages(session_id, id DESC);
`;

export const CREATE_V2_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_message_artifacts (
    message_id INTEGER PRIMARY KEY,
    artifact_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (message_id) REFERENCES session_messages(id) ON DELETE CASCADE
  );
`;

export const CREATE_V2_AUDIT_LOGS_TABLE_SQL = `
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
`;

export const CREATE_V2_AUDIT_LOG_DETAILS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log_details (
    audit_log_id INTEGER PRIMARY KEY,
    logical_prompt_json TEXT NOT NULL DEFAULT '{}',
    transport_payload_json TEXT NOT NULL DEFAULT '',
    assistant_text TEXT NOT NULL DEFAULT '',
    raw_items_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE
  );
`;

export const CREATE_V2_AUDIT_LOG_OPERATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_log_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    operation_type TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    UNIQUE (audit_log_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v2_audit_log_operations_log_seq
    ON audit_log_operations(audit_log_id, seq);
`;

export const CREATE_V2_MODEL_CATALOG_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS model_catalog_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS model_catalog_providers (
    revision INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    label TEXT NOT NULL,
    default_model_id TEXT NOT NULL,
    default_reasoning_effort TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (revision, provider_id),
    FOREIGN KEY (revision) REFERENCES model_catalog_revisions(revision) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS model_catalog_models (
    revision INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    label TEXT NOT NULL,
    reasoning_efforts_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (revision, provider_id, model_id),
    FOREIGN KEY (revision) REFERENCES model_catalog_revisions(revision) ON DELETE CASCADE
  );
`;

export const CREATE_V2_SCHEMA_SQL = [
  CREATE_V2_APP_SETTINGS_TABLE_SQL,
  CREATE_V2_SESSIONS_TABLE_SQL,
  CREATE_V2_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V2_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL,
  CREATE_V2_AUDIT_LOGS_TABLE_SQL,
  CREATE_V2_AUDIT_LOG_DETAILS_TABLE_SQL,
  CREATE_V2_AUDIT_LOG_OPERATIONS_TABLE_SQL,
  CREATE_V2_MODEL_CATALOG_TABLES_SQL,
] as const;

export const V2_SESSION_SUMMARY_COLUMNS = [
  "id",
  "task_title",
  "task_summary",
  "status",
  "updated_at",
  "provider",
  "catalog_revision",
  "workspace_label",
  "workspace_path",
  "branch",
  "session_kind",
  "character_id",
  "character_name",
  "character_icon_path",
  "character_theme_main",
  "character_theme_sub",
  "run_state",
  "approval_mode",
  "codex_sandbox_mode",
  "model",
  "reasoning_effort",
  "custom_agent_name",
  "allowed_additional_directories_json",
  "thread_id",
  "message_count",
  "audit_log_count",
] as const;

export const V2_AUDIT_LOG_SUMMARY_COLUMNS = [
  "id",
  "session_id",
  "created_at",
  "phase",
  "provider",
  "model",
  "reasoning_effort",
  "approval_mode",
  "thread_id",
  "assistant_text_preview",
  "operation_count",
  "raw_item_count",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "has_error",
  "error_message",
  "detail_available",
] as const;
