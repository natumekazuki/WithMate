import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";

export const APP_DATABASE_V1_FILENAME = "withmate.db";
export const APP_DATABASE_V1_SCHEMA_VERSION = 1;

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const CREATE_APP_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const CREATE_SESSIONS_TABLE_SQL = `
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
    messages_json TEXT NOT NULL,
    stream_json TEXT NOT NULL,
    last_active_at INTEGER NOT NULL
  );
`;

export const LEGACY_SESSION_COLUMN_DEFINITIONS = {
  model: `TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_MODEL_ID)}`,
  reasoning_effort: `TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_REASONING_EFFORT)}`,
  codex_sandbox_mode: `TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_CODEX_SANDBOX_MODE)}`,
  catalog_revision: `INTEGER NOT NULL DEFAULT ${DEFAULT_CATALOG_REVISION}`,
  custom_agent_name: "TEXT NOT NULL DEFAULT ''",
  allowed_additional_directories_json: "TEXT NOT NULL DEFAULT '[]'",
  character_theme_main: "TEXT NOT NULL DEFAULT '#6f8cff'",
  character_theme_sub: "TEXT NOT NULL DEFAULT '#6fb8c7'",
} as const;

export const CREATE_AUDIT_LOGS_TABLE_SQL = `
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
    logical_prompt_json TEXT NOT NULL DEFAULT '{}',
    transport_payload_json TEXT NOT NULL DEFAULT '',
    assistant_text TEXT NOT NULL DEFAULT '',
    operations_json TEXT NOT NULL DEFAULT '[]',
    raw_items_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`;

export const LEGACY_AUDIT_LOG_COLUMN_DEFINITIONS = {
  logical_prompt_json: "TEXT NOT NULL DEFAULT '{}'",
  transport_payload_json: "TEXT NOT NULL DEFAULT ''",
} as const;

export const CREATE_MODEL_CATALOG_TABLES_SQL = `
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

export const CREATE_SESSION_MEMORIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_memories (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    workspace_path TEXT NOT NULL,
    thread_id TEXT NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL DEFAULT 1,
    goal TEXT NOT NULL DEFAULT '',
    decisions_json TEXT NOT NULL DEFAULT '[]',
    open_questions_json TEXT NOT NULL DEFAULT '[]',
    next_actions_json TEXT NOT NULL DEFAULT '[]',
    notes_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
`;

export const CREATE_PROJECT_MEMORY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS project_scopes (
    id TEXT PRIMARY KEY,
    project_type TEXT NOT NULL,
    project_key TEXT NOT NULL UNIQUE,
    workspace_path TEXT NOT NULL,
    git_root TEXT,
    git_remote_url TEXT,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_memory_entries (
    id TEXT PRIMARY KEY,
    project_scope_id TEXT NOT NULL REFERENCES project_scopes(id) ON DELETE CASCADE,
    source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_project_memory_entries_scope
    ON project_memory_entries(project_scope_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_project_memory_entries_category
    ON project_memory_entries(project_scope_id, category, updated_at DESC);
`;

export const CREATE_CHARACTER_MEMORY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS character_scopes (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS character_memory_entries (
    id TEXT PRIMARY KEY,
    character_scope_id TEXT NOT NULL REFERENCES character_scopes(id) ON DELETE CASCADE,
    source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    keywords_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_character_memory_entries_scope
    ON character_memory_entries(character_scope_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_character_memory_entries_category
    ON character_memory_entries(character_scope_id, category, updated_at DESC);
`;
