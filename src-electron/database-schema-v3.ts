import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_APPROVAL_MODE } from "../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../src/codex-sandbox-mode.js";
import { DEFAULT_CATALOG_REVISION, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "../src/model-catalog.js";

export const APP_DATABASE_V3_FILENAME = "withmate-v3.db";
export const APP_DATABASE_V3_SCHEMA_VERSION = 3;

export const V3_SCHEMA_STATUS = "ready-for-implementation";
export const V3_TEXT_PREVIEW_MAX_LENGTH = 500;
export const V3_OPERATION_SUMMARY_MAX_LENGTH = 500;
export const V3_DETAILS_PREVIEW_MAX_LENGTH = 500;
export const V3_SUMMARY_JSON_MAX_LENGTH = 8192;

export const REQUIRED_V3_TABLES = [
  "sessions",
  "session_messages",
  "session_message_artifacts",
  "audit_logs",
  "audit_log_details",
  "audit_log_operations",
  "companion_groups",
  "companion_sessions",
  "companion_messages",
  "companion_message_artifacts",
  "companion_merge_runs",
  "companion_audit_logs",
  "companion_audit_log_details",
  "companion_audit_log_operations",
  "blob_objects",
] as const;

export function isValidV3Database(dbPath: string): boolean {
  if (basename(dbPath) !== APP_DATABASE_V3_FILENAME) {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const placeholders = REQUIRED_V3_TABLES.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${placeholders})
    `).all(...REQUIRED_V3_TABLES) as Array<{ name: string }>;
    const tableNames = new Set(rows.map((row) => row.name));
    return REQUIRED_V3_TABLES.every((tableName) => tableNames.has(tableName));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const V3_SCHEMA_DESIGN_NOTES = [
  "V3 は withmate-v3.db を正本にし、V2 withmate-v2.db からの移行は別スクリプトで行う。",
  "V3 では prompt / provider response / raw items / diff rows / artifact detail を DB 外 compressed blob に保存する。",
  "V3 の SQLite schema は一覧・検索・削除判定に必要な metadata と blob ref だけを持つ。",
  "V3 では Companion / CompanionAudit tables を schema source に含める。",
] as const;

export const CREATE_V3_APP_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const CREATE_V3_BLOB_OBJECTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS blob_objects (
    blob_id TEXT PRIMARY KEY,
    codec TEXT NOT NULL CHECK (codec IN ('br', 'gzip')),
    content_type TEXT NOT NULL CHECK (content_type IN ('text/plain', 'application/json')),
    original_bytes INTEGER NOT NULL,
    stored_bytes INTEGER NOT NULL,
    raw_sha256 TEXT NOT NULL,
    stored_sha256 TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'delete_pending')),
    created_at TEXT NOT NULL,
    last_verified_at TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_v3_blob_objects_state
    ON blob_objects(state, created_at);
`;

export const CREATE_V3_SESSIONS_TABLE_SQL = `
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
    approval_mode TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_APPROVAL_MODE)},
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

  CREATE INDEX IF NOT EXISTS idx_v3_sessions_last_active
    ON sessions(last_active_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v3_sessions_workspace
    ON sessions(workspace_path, last_active_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v3_sessions_character
    ON sessions(character_id, last_active_at DESC);
`;

export const CREATE_V3_SESSION_MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text_preview TEXT NOT NULL DEFAULT '' CHECK (length(text_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    text_blob_id TEXT,
    text_original_bytes INTEGER NOT NULL DEFAULT 0,
    text_stored_bytes INTEGER NOT NULL DEFAULT 0,
    accent INTEGER NOT NULL DEFAULT 0,
    artifact_available INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (text_blob_id) REFERENCES blob_objects(blob_id),
    UNIQUE (session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_session_messages_session_seq
    ON session_messages(session_id, seq);

  CREATE INDEX IF NOT EXISTS idx_v3_session_messages_text_blob
    ON session_messages(text_blob_id);
`;

export const CREATE_V3_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_message_artifacts (
    message_id INTEGER PRIMARY KEY,
    artifact_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (length(artifact_summary_json) <= ${V3_SUMMARY_JSON_MAX_LENGTH}),
    artifact_blob_id TEXT,
    artifact_original_bytes INTEGER NOT NULL DEFAULT 0,
    artifact_stored_bytes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (message_id) REFERENCES session_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_blob_id) REFERENCES blob_objects(blob_id)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_session_message_artifacts_blob
    ON session_message_artifacts(artifact_blob_id);
`;

export const CREATE_V3_AUDIT_LOGS_TABLE_SQL = `
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
    assistant_text_preview TEXT NOT NULL DEFAULT '' CHECK (length(assistant_text_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    operation_count INTEGER NOT NULL DEFAULT 0,
    raw_item_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    has_error INTEGER NOT NULL DEFAULT 0,
    error_message_preview TEXT NOT NULL DEFAULT '' CHECK (length(error_message_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    detail_available INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v3_audit_logs_session_id_desc
    ON audit_logs(session_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v3_audit_logs_session_created
    ON audit_logs(session_id, created_at DESC, id DESC);
`;

export const CREATE_V3_AUDIT_LOG_DETAILS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log_details (
    audit_log_id INTEGER PRIMARY KEY,
    logical_prompt_blob_id TEXT,
    transport_payload_blob_id TEXT,
    assistant_text_blob_id TEXT,
    raw_items_blob_id TEXT,
    usage_metadata_json TEXT NOT NULL DEFAULT '',
    usage_blob_id TEXT,
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (logical_prompt_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (transport_payload_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (assistant_text_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (raw_items_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (usage_blob_id) REFERENCES blob_objects(blob_id)
  );
`;

export const CREATE_V3_AUDIT_LOG_OPERATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_log_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    operation_type TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= ${V3_OPERATION_SUMMARY_MAX_LENGTH}),
    details_preview TEXT NOT NULL DEFAULT '' CHECK (length(details_preview) <= ${V3_DETAILS_PREVIEW_MAX_LENGTH}),
    details_blob_id TEXT,
    FOREIGN KEY (audit_log_id) REFERENCES audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (details_blob_id) REFERENCES blob_objects(blob_id),
    UNIQUE (audit_log_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_audit_log_operations_log_seq
    ON audit_log_operations(audit_log_id, seq);

  CREATE INDEX IF NOT EXISTS idx_v3_audit_log_operations_details_blob
    ON audit_log_operations(details_blob_id);
`;

export const CREATE_V3_COMPANION_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS companion_groups (
    id TEXT PRIMARY KEY,
    repo_root TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS companion_sessions (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES companion_groups(id) ON DELETE CASCADE,
    task_title TEXT NOT NULL,
    status TEXT NOT NULL,
    repo_root TEXT NOT NULL,
    focus_path TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    base_snapshot_ref TEXT NOT NULL DEFAULT '',
    base_snapshot_commit TEXT NOT NULL DEFAULT '',
    companion_branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    selected_paths_json TEXT NOT NULL DEFAULT '[]',
    changed_files_summary_json TEXT NOT NULL DEFAULT '[]' CHECK (length(changed_files_summary_json) <= ${V3_SUMMARY_JSON_MAX_LENGTH}),
    sibling_warnings_summary_json TEXT NOT NULL DEFAULT '[]' CHECK (length(sibling_warnings_summary_json) <= ${V3_SUMMARY_JSON_MAX_LENGTH}),
    allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]',
    run_state TEXT NOT NULL DEFAULT 'idle',
    thread_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL DEFAULT ${DEFAULT_CATALOG_REVISION},
    model TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_MODEL_ID)},
    reasoning_effort TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_REASONING_EFFORT)},
    custom_agent_name TEXT NOT NULL DEFAULT '',
    approval_mode TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_APPROVAL_MODE)},
    codex_sandbox_mode TEXT NOT NULL DEFAULT ${sqlStringLiteral(DEFAULT_CODEX_SANDBOX_MODE)},
    character_id TEXT NOT NULL,
    character_name TEXT NOT NULL,
    character_role_preview TEXT NOT NULL DEFAULT '' CHECK (length(character_role_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    character_role_blob_id TEXT,
    character_icon_path TEXT NOT NULL,
    character_theme_main TEXT NOT NULL DEFAULT '#6f8cff',
    character_theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
    message_count INTEGER NOT NULL DEFAULT 0,
    audit_log_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (character_role_blob_id) REFERENCES blob_objects(blob_id)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_companion_sessions_group_status
    ON companion_sessions(group_id, status, updated_at);

  CREATE TABLE IF NOT EXISTS companion_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES companion_sessions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text_preview TEXT NOT NULL DEFAULT '' CHECK (length(text_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    text_blob_id TEXT,
    text_original_bytes INTEGER NOT NULL DEFAULT 0,
    text_stored_bytes INTEGER NOT NULL DEFAULT 0,
    accent INTEGER NOT NULL DEFAULT 0,
    artifact_available INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (text_blob_id) REFERENCES blob_objects(blob_id),
    UNIQUE(session_id, position)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_companion_messages_session_position
    ON companion_messages(session_id, position);

  CREATE TABLE IF NOT EXISTS companion_message_artifacts (
    message_id INTEGER PRIMARY KEY,
    artifact_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (length(artifact_summary_json) <= ${V3_SUMMARY_JSON_MAX_LENGTH}),
    artifact_blob_id TEXT,
    artifact_original_bytes INTEGER NOT NULL DEFAULT 0,
    artifact_stored_bytes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (message_id) REFERENCES companion_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_blob_id) REFERENCES blob_objects(blob_id)
  );

  CREATE TABLE IF NOT EXISTS companion_merge_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES companion_sessions(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL REFERENCES companion_groups(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    selected_paths_json TEXT NOT NULL DEFAULT '[]',
    changed_files_summary_json TEXT NOT NULL DEFAULT '[]' CHECK (length(changed_files_summary_json) <= ${V3_SUMMARY_JSON_MAX_LENGTH}),
    sibling_warnings_summary_json TEXT NOT NULL DEFAULT '[]' CHECK (length(sibling_warnings_summary_json) <= ${V3_SUMMARY_JSON_MAX_LENGTH}),
    diff_snapshot_blob_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (diff_snapshot_blob_id) REFERENCES blob_objects(blob_id)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_companion_merge_runs_session_created
    ON companion_merge_runs(session_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_v3_companion_merge_runs_group_created
    ON companion_merge_runs(group_id, created_at);
`;

export const CREATE_V3_COMPANION_AUDIT_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS companion_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    phase TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    approval_mode TEXT NOT NULL,
    thread_id TEXT NOT NULL DEFAULT '',
    assistant_text_preview TEXT NOT NULL DEFAULT '' CHECK (length(assistant_text_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    operation_count INTEGER NOT NULL DEFAULT 0,
    raw_item_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    cached_input_tokens INTEGER,
    output_tokens INTEGER,
    has_error INTEGER NOT NULL DEFAULT 0,
    error_message_preview TEXT NOT NULL DEFAULT '' CHECK (length(error_message_preview) <= ${V3_TEXT_PREVIEW_MAX_LENGTH}),
    detail_available INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v3_companion_audit_logs_session_id_desc
    ON companion_audit_logs(session_id, id DESC);

  CREATE TABLE IF NOT EXISTS companion_audit_log_details (
    audit_log_id INTEGER PRIMARY KEY,
    logical_prompt_blob_id TEXT,
    transport_payload_blob_id TEXT,
    assistant_text_blob_id TEXT,
    raw_items_blob_id TEXT,
    usage_metadata_json TEXT NOT NULL DEFAULT '',
    usage_blob_id TEXT,
    FOREIGN KEY (audit_log_id) REFERENCES companion_audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (logical_prompt_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (transport_payload_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (assistant_text_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (raw_items_blob_id) REFERENCES blob_objects(blob_id),
    FOREIGN KEY (usage_blob_id) REFERENCES blob_objects(blob_id)
  );

  CREATE TABLE IF NOT EXISTS companion_audit_log_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_log_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    operation_type TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= ${V3_OPERATION_SUMMARY_MAX_LENGTH}),
    details_preview TEXT NOT NULL DEFAULT '' CHECK (length(details_preview) <= ${V3_DETAILS_PREVIEW_MAX_LENGTH}),
    details_blob_id TEXT,
    FOREIGN KEY (audit_log_id) REFERENCES companion_audit_logs(id) ON DELETE CASCADE,
    FOREIGN KEY (details_blob_id) REFERENCES blob_objects(blob_id),
    UNIQUE (audit_log_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v3_companion_audit_log_operations_log_seq
    ON companion_audit_log_operations(audit_log_id, seq);
`;

export const CREATE_V3_MODEL_CATALOG_TABLES_SQL = `
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

export const CREATE_V3_SCHEMA_SQL = [
  CREATE_V3_APP_SETTINGS_TABLE_SQL,
  CREATE_V3_BLOB_OBJECTS_TABLE_SQL,
  CREATE_V3_SESSIONS_TABLE_SQL,
  CREATE_V3_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V3_SESSION_MESSAGE_ARTIFACTS_TABLE_SQL,
  CREATE_V3_AUDIT_LOGS_TABLE_SQL,
  CREATE_V3_AUDIT_LOG_DETAILS_TABLE_SQL,
  CREATE_V3_AUDIT_LOG_OPERATIONS_TABLE_SQL,
  CREATE_V3_COMPANION_TABLES_SQL,
  CREATE_V3_COMPANION_AUDIT_TABLES_SQL,
  CREATE_V3_MODEL_CATALOG_TABLES_SQL,
] as const;
