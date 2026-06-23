import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CREATE_APP_SETTINGS_TABLE_SQL, CREATE_MODEL_CATALOG_TABLES_SQL } from "./database-schema-v1.js";

export const APP_DATABASE_V6_FILENAME = "withmate-v6.db";
export const APP_DATABASE_V6_SCHEMA_VERSION = 6;

export const V6_SCHEMA_STATUS = "foundation";

export const REQUIRED_V6_TABLES = [
  "app_settings",
  "model_catalog_revisions",
  "model_catalog_providers",
  "model_catalog_models",
  "characters",
  "project_scopes_v6",
  "sessions_v6",
  "session_messages_v6",
  "audit_events_v6",
  "memory_entries_v6",
  "memory_entry_tags_v6",
  "memory_entry_relations_v6",
  "memory_tag_catalog_v6",
  "memory_mutation_events_v6",
  "memory_idempotency_keys_v6",
] as const;

export function resolveV6FreshDatabasePath(userDataPath: string): string {
  return join(userDataPath, APP_DATABASE_V6_FILENAME);
}

export function readV6DatabaseUserVersion(dbPath: string): number | null {
  if (basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
    return null;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function isValidV6Database(dbPath: string): boolean {
  if (basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    if (row?.user_version !== APP_DATABASE_V6_SCHEMA_VERSION) {
      return false;
    }

    const existingTables = new Set(
      (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name?: unknown }>)
        .map((table) => table.name)
        .filter((name): name is string => typeof name === "string"),
    );
    return REQUIRED_V6_TABLES.every((tableName) => existingTables.has(tableName));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export const CREATE_V6_CHARACTERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_file_path TEXT NOT NULL DEFAULT '',
    theme_main TEXT NOT NULL DEFAULT '#6f8cff',
    theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_characters_single_default
    ON characters(is_default)
    WHERE is_default = 1;

  CREATE INDEX IF NOT EXISTS idx_v6_characters_state_updated
    ON characters(state, updated_at DESC);
`;

export const CREATE_V6_PROJECT_SCOPES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS project_scopes_v6 (
    id TEXT PRIMARY KEY,
    project_type TEXT NOT NULL CHECK (project_type IN ('git', 'directory')),
    project_key TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    git_root TEXT NOT NULL DEFAULT '',
    git_remote_url TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_type, project_key)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_project_scopes_key
    ON project_scopes_v6(project_type, project_key);

  CREATE INDEX IF NOT EXISTS idx_v6_project_scopes_workspace
    ON project_scopes_v6(workspace_path);
`;

export const CREATE_V6_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sessions_v6 (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'archived')),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    character_id TEXT,
    character_snapshot_json TEXT NOT NULL DEFAULT '',
    project_scope_id TEXT,
    workspace_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL,
    FOREIGN KEY (project_scope_id) REFERENCES project_scopes_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_sessions_last_active
    ON sessions_v6(last_active_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_sessions_project
    ON sessions_v6(project_scope_id, last_active_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_sessions_character
    ON sessions_v6(character_id, last_active_at DESC);
`;

export const CREATE_V6_SESSION_MESSAGES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_messages_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    UNIQUE (session_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_messages_session_seq
    ON session_messages_v6(session_id, seq);
`;

export const CREATE_V6_AUDIT_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_events_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'session_turn',
      'memory_mutation',
      'runtime_binding',
      'diagnostic'
    )),
    provider_id TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_audit_events_session_created
    ON audit_events_v6(session_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_audit_events_type_created
    ON audit_events_v6(event_type, created_at DESC);
`;

export const CREATE_V6_MEMORY_ENTRIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entries_v6 (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('character', 'project', 'user')),
    owner_id TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('session', 'project', 'character', 'global')),
    scope_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'decision',
      'constraint',
      'convention',
      'context',
      'deferred',
      'preference',
      'relationship',
      'boundary',
      'note'
    )),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    preview TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'forgotten')),
    source_type TEXT NOT NULL CHECK (source_type IN ('agent', 'manual', 'migration')),
    source_session_id TEXT,
    source_message_id TEXT,
    source_provider_id TEXT,
    superseded_by_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    forgotten_at TEXT,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (superseded_by_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    CHECK ((state = 'active') = (superseded_by_id IS NULL AND forgotten_at IS NULL) OR state <> 'active'),
    CHECK (state <> 'superseded' OR (superseded_by_id IS NOT NULL AND forgotten_at IS NULL)),
    CHECK (state <> 'forgotten' OR forgotten_at IS NOT NULL)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_entries_target_state_updated
    ON memory_entries_v6(owner_type, owner_id, scope_type, scope_id, state, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_memory_entries_kind_state
    ON memory_entries_v6(kind, state, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_memory_entries_source_session
    ON memory_entries_v6(source_session_id);
`;

export const CREATE_V6_MEMORY_ENTRY_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entry_tags_v6 (
    entry_id TEXT NOT NULL,
    tag_type TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    tag_type_canonical TEXT NOT NULL,
    tag_value_canonical TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag_type_canonical, tag_value_canonical),
    FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_entry_tags_lookup
    ON memory_entry_tags_v6(tag_type_canonical, tag_value_canonical, entry_id);
`;

export const CREATE_V6_MEMORY_ENTRY_RELATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entry_relations_v6 (
    source_entry_id TEXT NOT NULL,
    target_entry_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'related')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_entry_id, target_entry_id, relation_type),
    FOREIGN KEY (source_entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (target_entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_entry_relations_target
    ON memory_entry_relations_v6(target_entry_id, relation_type);
`;

export const CREATE_V6_MEMORY_TAG_CATALOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_tag_catalog_v6 (
    tag_type TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    tag_type_canonical TEXT NOT NULL,
    tag_value_canonical TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
    usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tag_type_canonical, tag_value_canonical)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_tag_catalog_lookup
    ON memory_tag_catalog_v6(tag_type_canonical, usage_count DESC, updated_at DESC);
`;

export const CREATE_V6_MEMORY_MUTATION_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_mutation_events_v6 (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('append', 'forget', 'supersede')),
    entry_id TEXT,
    binding_id_hash TEXT,
    session_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_mutation_events_entry
    ON memory_mutation_events_v6(entry_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_memory_mutation_events_session
    ON memory_mutation_events_v6(session_id, created_at DESC);
`;

export const CREATE_V6_MEMORY_IDEMPOTENCY_KEYS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_idempotency_keys_v6 (
    key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('append', 'forget')),
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    response_entry_id TEXT,
    operation_created INTEGER NOT NULL CHECK (operation_created IN (0, 1)),
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (key, operation, owner_type, owner_id, scope_type, scope_id),
    FOREIGN KEY (response_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_idempotency_response_entry
    ON memory_idempotency_keys_v6(response_entry_id);
`;

export const CREATE_V6_SCHEMA_SQL = [
  CREATE_APP_SETTINGS_TABLE_SQL,
  CREATE_MODEL_CATALOG_TABLES_SQL,
  CREATE_V6_CHARACTERS_TABLE_SQL,
  CREATE_V6_PROJECT_SCOPES_TABLE_SQL,
  CREATE_V6_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V6_AUDIT_EVENTS_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRIES_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRY_TAGS_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRY_RELATIONS_TABLE_SQL,
  CREATE_V6_MEMORY_TAG_CATALOG_TABLE_SQL,
  CREATE_V6_MEMORY_MUTATION_EVENTS_TABLE_SQL,
  CREATE_V6_MEMORY_IDEMPOTENCY_KEYS_TABLE_SQL,
  `PRAGMA user_version = ${APP_DATABASE_V6_SCHEMA_VERSION};`,
] as const;
