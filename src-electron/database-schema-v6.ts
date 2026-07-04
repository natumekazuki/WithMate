import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  "auxiliary_sessions",
  "audit_events_v6",
  "memory_entries_v6",
  "memory_entry_tags_v6",
  "memory_entry_relations_v6",
  "memory_tag_catalog_v6",
  "memory_mutation_events_v6",
  "memory_idempotency_keys_v6",
  "memory_idempotency_forget_results_v6",
] as const;

const FORBIDDEN_V6_TABLES = [
  "session_memories",
  "project_scopes",
  "project_memory_entries",
  "character_scopes",
  "character_memory_entries",
] as const;

const REQUIRED_V6_INDEXES = [
  "idx_v6_characters_state_updated",
  "idx_v6_project_scopes_key",
  "idx_v6_sessions_last_active",
  "idx_v6_session_messages_session_seq",
  "idx_auxiliary_sessions_parent_updated",
  "idx_auxiliary_sessions_parent_created",
  "idx_v6_audit_events_session_created",
  "idx_v6_audit_events_auxiliary_session_created",
  "idx_v6_audit_events_type_created",
  "idx_v6_memory_entries_target_state_updated",
  "idx_v6_memory_entry_tags_lookup",
  "idx_v6_memory_mutation_events_result",
  "idx_v6_memory_idempotency_response_entry",
] as const;

const REQUIRED_V6_TABLE_COLUMNS = {
  app_settings: ["setting_key", "setting_value", "updated_at"],
  model_catalog_revisions: ["revision", "source", "imported_at", "is_active"],
  model_catalog_providers: ["revision", "provider_id", "label", "default_model_id", "default_reasoning_effort", "sort_order"],
  model_catalog_models: ["revision", "provider_id", "model_id", "label", "reasoning_efforts_json", "sort_order"],
  characters: ["id", "name", "description", "icon_file_path", "theme_main", "theme_sub", "state", "is_default", "created_at", "updated_at", "archived_at"],
  project_scopes_v6: ["id", "project_type", "project_key", "workspace_path", "git_root", "git_remote_url", "display_name", "created_at", "updated_at"],
  sessions_v6: [
    "id",
    "title",
    "state",
    "session_kind",
    "provider_id",
    "catalog_revision",
    "model_id",
    "reasoning_effort",
    "custom_agent_name",
    "approval_mode",
    "codex_sandbox_mode",
    "allowed_additional_directories_json",
    "runtime_policy_json",
    "thread_id",
    "character_id",
    "character_snapshot_json",
    "project_scope_id",
    "workspace_path",
    "created_at",
    "updated_at",
    "last_active_at",
  ],
  session_messages_v6: ["id", "session_id", "seq", "role", "body", "created_at"],
  auxiliary_sessions: ["id", "parent_session_id", "status", "created_at", "updated_at", "payload_json"],
  audit_events_v6: ["id", "session_id", "auxiliary_session_id", "event_type", "provider_id", "summary", "metadata_json", "created_at"],
  memory_entries_v6: [
    "id",
    "owner_type",
    "owner_id",
    "scope_type",
    "scope_id",
    "kind",
    "title",
    "body",
    "body_sha256",
    "preview",
    "state",
    "source_type",
    "source_session_id",
    "source_app_message_id",
    "source_provider_message_id",
    "source_provider_id",
    "superseded_by_id",
    "created_at",
    "updated_at",
    "forgotten_at",
  ],
  memory_entry_tags_v6: ["entry_id", "tag_type", "tag_value", "tag_type_canonical", "tag_value_canonical", "created_at"],
  memory_entry_relations_v6: ["source_entry_id", "target_entry_id", "relation_type", "created_at"],
  memory_tag_catalog_v6: ["tag_type", "tag_value", "tag_type_canonical", "tag_value_canonical", "description", "aliases_json", "state", "usage_count", "created_at", "updated_at"],
  memory_mutation_events_v6: ["id", "operation", "entry_id", "binding_id_hash", "session_id", "result_status", "reason", "created_at"],
  memory_idempotency_keys_v6: [
    "key",
    "operation",
    "binding_id_hash",
    "owner_type",
    "owner_id",
    "scope_type",
    "scope_id",
    "response_entry_id",
    "operation_created",
    "request_fingerprint",
    "created_at",
  ],
  memory_idempotency_forget_results_v6: [
    "key",
    "operation",
    "binding_id_hash",
    "owner_type",
    "owner_id",
    "scope_type",
    "scope_id",
    "entry_id",
    "result_status",
    "created_at",
  ],
} as const satisfies Record<(typeof REQUIRED_V6_TABLES)[number], readonly string[]>;

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
    if (!REQUIRED_V6_TABLES.every((tableName) => existingTables.has(tableName))) {
      return false;
    }
    if (FORBIDDEN_V6_TABLES.some((tableName) => existingTables.has(tableName))) {
      return false;
    }
    if (!hasRequiredColumns(db)) {
      return false;
    }
    if (!hasRequiredIndexes(db)) {
      return false;
    }
    if (!hasRequiredForeignKeys(db)) {
      return false;
    }
    if (!hasRequiredCheckConstraints(db)) {
      return false;
    }
    return hasNoForeignKeyViolations(db);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export function isValidV6DatabaseShallow(dbPath: string): boolean {
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
    return REQUIRED_V6_TABLES.every((tableName) => existingTables.has(tableName))
      && !FORBIDDEN_V6_TABLES.some((tableName) => existingTables.has(tableName));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function hasRequiredColumns(db: DatabaseSync): boolean {
  for (const [tableName, expectedColumns] of Object.entries(REQUIRED_V6_TABLE_COLUMNS)) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!expectedColumns.every((column) => columns.has(column))) {
      return false;
    }
  }

  return true;
}

function hasRequiredIndexes(db: DatabaseSync): boolean {
  const indexes = new Set(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{ name?: unknown }>)
      .map((index) => index.name)
      .filter((name): name is string => typeof name === "string"),
  );
  return REQUIRED_V6_INDEXES.every((indexName) => indexes.has(indexName));
}

function hasForeignKey(db: DatabaseSync, tableName: string, fromColumn: string, targetTable: string): boolean {
  const keys = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    from?: unknown;
    table?: unknown;
  }>;
  return keys.some((key) => key.from === fromColumn && key.table === targetTable);
}

function hasRequiredForeignKeys(db: DatabaseSync): boolean {
  return hasForeignKey(db, "sessions_v6", "character_id", "characters")
    && hasForeignKey(db, "sessions_v6", "project_scope_id", "project_scopes_v6")
    && hasForeignKey(db, "session_messages_v6", "session_id", "sessions_v6")
    && hasForeignKey(db, "audit_events_v6", "session_id", "sessions_v6")
    && hasForeignKey(db, "audit_events_v6", "auxiliary_session_id", "auxiliary_sessions")
    && hasForeignKey(db, "memory_entries_v6", "source_app_message_id", "session_messages_v6")
    && hasForeignKey(db, "memory_entries_v6", "superseded_by_id", "memory_entries_v6")
    && hasForeignKey(db, "memory_entry_tags_v6", "entry_id", "memory_entries_v6")
    && hasForeignKey(db, "memory_idempotency_keys_v6", "response_entry_id", "memory_entries_v6");
}

function tableSql(db: DatabaseSync, tableName: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { sql?: unknown }
    | undefined;
  return typeof row?.sql === "string" ? row.sql : "";
}

function hasRequiredCheckConstraints(db: DatabaseSync): boolean {
  const sessionsSql = tableSql(db, "sessions_v6");
  const auxiliarySessionsSql = tableSql(db, "auxiliary_sessions");
  const memoryEntriesSql = tableSql(db, "memory_entries_v6");
  const mutationEventsSql = tableSql(db, "memory_mutation_events_v6");
  const idempotencySql = tableSql(db, "memory_idempotency_keys_v6");

  return sessionsSql.includes("json_valid(character_snapshot_json)")
    && memoryEntriesSql.includes("state IN ('active', 'superseded', 'forgotten')")
    && auxiliarySessionsSql.includes("status IN ('active', 'closed')")
    && memoryEntriesSql.includes("ON DELETE RESTRICT")
    && mutationEventsSql.includes("result_status TEXT NOT NULL")
    && mutationEventsSql.includes("result_status IN")
    && idempotencySql.includes("binding_id_hash TEXT NOT NULL")
    && idempotencySql.includes("PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id)");
}

function hasNoForeignKeyViolations(db: DatabaseSync): boolean {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  return violations.length === 0;
}

export const CREATE_V6_APP_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const CREATE_V6_MODEL_CATALOG_TABLES_SQL = `
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
    session_kind TEXT NOT NULL DEFAULT 'default',
    provider_id TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL DEFAULT '',
    custom_agent_name TEXT NOT NULL DEFAULT '',
    approval_mode TEXT NOT NULL,
    codex_sandbox_mode TEXT NOT NULL DEFAULT '',
    allowed_additional_directories_json TEXT NOT NULL DEFAULT '[]',
    runtime_policy_json TEXT NOT NULL DEFAULT '{}',
    thread_id TEXT NOT NULL DEFAULT '',
    character_id TEXT,
    character_snapshot_json TEXT DEFAULT NULL,
    project_scope_id TEXT,
    workspace_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL,
    FOREIGN KEY (project_scope_id) REFERENCES project_scopes_v6(id) ON DELETE SET NULL,
    CHECK (
      character_id IS NULL
      OR (
        character_snapshot_json IS NOT NULL
        AND character_snapshot_json <> ''
        AND json_valid(character_snapshot_json)
      )
    )
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
    artifact_body TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    UNIQUE (session_id, seq),
    UNIQUE (id, session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_messages_session_seq
    ON session_messages_v6(session_id, seq);
`;

export const CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
    ON auxiliary_sessions(parent_session_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_created
    ON auxiliary_sessions(parent_session_id, created_at ASC);
`;

export const CREATE_V6_AUDIT_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_events_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    auxiliary_session_id TEXT,
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
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_audit_events_session_created
    ON audit_events_v6(session_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_audit_events_auxiliary_session_created
    ON audit_events_v6(auxiliary_session_id, created_at DESC, id DESC);

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
    source_app_message_id INTEGER,
    source_provider_message_id TEXT,
    source_provider_id TEXT,
    superseded_by_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    forgotten_at TEXT,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (source_app_message_id, source_session_id) REFERENCES session_messages_v6(id, session_id) ON DELETE SET NULL,
    FOREIGN KEY (superseded_by_id) REFERENCES memory_entries_v6(id) ON DELETE RESTRICT,
    CHECK (owner_type <> 'user' OR owner_id = 'local-user'),
    CHECK (scope_type <> 'global' OR scope_id = 'global'),
    CHECK (
      (owner_type <> 'user' AND scope_type <> 'global')
      OR (owner_type = 'user' AND owner_id = 'local-user' AND scope_type = 'global' AND scope_id = 'global')
    ),
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
    result_status TEXT NOT NULL CHECK (result_status IN (
      'success',
      'already_forgotten',
      'not_found',
      'forbidden',
      'failed'
    )),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_mutation_events_entry
    ON memory_mutation_events_v6(entry_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_memory_mutation_events_session
    ON memory_mutation_events_v6(session_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_memory_mutation_events_result
    ON memory_mutation_events_v6(operation, result_status, created_at DESC);
`;

export const CREATE_V6_MEMORY_IDEMPOTENCY_KEYS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_idempotency_keys_v6 (
    key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('append', 'forget')),
    binding_id_hash TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    response_entry_id TEXT,
    operation_created INTEGER NOT NULL CHECK (operation_created IN (0, 1)),
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id),
    FOREIGN KEY (response_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_idempotency_response_entry
    ON memory_idempotency_keys_v6(response_entry_id);
`;

export const CREATE_V6_MEMORY_IDEMPOTENCY_FORGET_RESULTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_idempotency_forget_results_v6 (
    key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation = 'forget'),
    binding_id_hash TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    result_status TEXT NOT NULL CHECK (result_status IN (
      'forgotten',
      'already_forgotten',
      'not_found'
    )),
    created_at TEXT NOT NULL,
    PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id, entry_id),
    FOREIGN KEY (
      binding_id_hash,
      key,
      operation,
      owner_type,
      owner_id,
      scope_type,
      scope_id
    ) REFERENCES memory_idempotency_keys_v6(
      binding_id_hash,
      key,
      operation,
      owner_type,
      owner_id,
      scope_type,
      scope_id
    ) ON DELETE CASCADE
  );
`;

export const CREATE_V6_SCHEMA_SQL = [
  CREATE_V6_APP_SETTINGS_TABLE_SQL,
  CREATE_V6_MODEL_CATALOG_TABLES_SQL,
  CREATE_V6_CHARACTERS_TABLE_SQL,
  CREATE_V6_PROJECT_SCOPES_TABLE_SQL,
  CREATE_V6_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_AUDIT_EVENTS_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRIES_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRY_TAGS_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRY_RELATIONS_TABLE_SQL,
  CREATE_V6_MEMORY_TAG_CATALOG_TABLE_SQL,
  CREATE_V6_MEMORY_MUTATION_EVENTS_TABLE_SQL,
  CREATE_V6_MEMORY_IDEMPOTENCY_KEYS_TABLE_SQL,
  CREATE_V6_MEMORY_IDEMPOTENCY_FORGET_RESULTS_TABLE_SQL,
  `PRAGMA user_version = ${APP_DATABASE_V6_SCHEMA_VERSION};`,
] as const;

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { name?: unknown }
    | undefined;
  return row?.name === tableName;
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

function rebuildAuxiliarySessionsTable(db: DatabaseSync, columns: Set<string>): void {
  const createdAtExpression = columns.has("created_at") ? "created_at" : "updated_at";
  const shouldRestoreAuditAuxiliaryOwners =
    tableExists(db, "audit_events_v6") && tableColumnNames(db, "audit_events_v6").has("auxiliary_session_id");

  db.exec("DROP TABLE IF EXISTS auxiliary_sessions_v6_rebuild;");
  if (shouldRestoreAuditAuxiliaryOwners) {
    db.exec("DROP TABLE IF EXISTS temp.audit_events_v6_auxiliary_owner_restore;");
    db.exec(`
      CREATE TEMP TABLE audit_events_v6_auxiliary_owner_restore AS
      SELECT id AS audit_event_id, auxiliary_session_id
      FROM audit_events_v6
      WHERE auxiliary_session_id IS NOT NULL
    `);
  }
  db.exec(`
    CREATE TABLE auxiliary_sessions_v6_rebuild (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO auxiliary_sessions_v6_rebuild (
      id,
      parent_session_id,
      status,
      created_at,
      updated_at,
      payload_json
    )
    SELECT
      id,
      parent_session_id,
      status,
      ${createdAtExpression},
      updated_at,
      payload_json
    FROM auxiliary_sessions
  `);
  db.exec("DROP TABLE auxiliary_sessions;");
  db.exec("ALTER TABLE auxiliary_sessions_v6_rebuild RENAME TO auxiliary_sessions;");
  if (shouldRestoreAuditAuxiliaryOwners) {
    db.exec(`
      UPDATE audit_events_v6
      SET auxiliary_session_id = (
        SELECT auxiliary_session_id
        FROM audit_events_v6_auxiliary_owner_restore
        WHERE audit_event_id = audit_events_v6.id
      )
      WHERE id IN (
        SELECT audit_event_id
        FROM audit_events_v6_auxiliary_owner_restore
      )
      AND EXISTS (
        SELECT 1
        FROM auxiliary_sessions
        WHERE id = (
          SELECT auxiliary_session_id
          FROM audit_events_v6_auxiliary_owner_restore
          WHERE audit_event_id = audit_events_v6.id
        )
      )
    `);
    db.exec("DROP TABLE temp.audit_events_v6_auxiliary_owner_restore;");
  }
}

function backfillAuxiliarySessionsCreatedAt(db: DatabaseSync): void {
  db.exec("UPDATE auxiliary_sessions SET created_at = updated_at WHERE created_at IS NULL OR created_at = '';");
}

function runWithSavepoint(db: DatabaseSync, savepointName: string, run: () => void): void {
  db.exec(`SAVEPOINT ${savepointName};`);
  try {
    run();
    db.exec(`RELEASE SAVEPOINT ${savepointName};`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${savepointName};`);
    }
    throw error;
  }
}

function ensureV6SchemaUnsafe(db: DatabaseSync): void {
  for (const statement of CREATE_V6_SCHEMA_SQL) {
    if (statement === CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL || statement === CREATE_V6_AUDIT_EVENTS_TABLE_SQL) {
      continue;
    }
    db.exec(statement);
  }

  if (!tableExists(db, "auxiliary_sessions")) {
    db.exec(CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL);
  } else {
    const auxiliaryColumns = tableColumnNames(db, "auxiliary_sessions");
    const shouldRebuildAuxiliarySessions = hasForeignKey(db, "auxiliary_sessions", "parent_session_id", "sessions_v6")
      || !tableSql(db, "auxiliary_sessions").includes("status IN ('active', 'closed')");
    if (shouldRebuildAuxiliarySessions) {
      rebuildAuxiliarySessionsTable(db, auxiliaryColumns);
    } else if (!auxiliaryColumns.has("created_at")) {
      db.exec("ALTER TABLE auxiliary_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
    }
    backfillAuxiliarySessionsCreatedAt(db);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
        ON auxiliary_sessions(parent_session_id, updated_at DESC)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_created
        ON auxiliary_sessions(parent_session_id, created_at ASC)
    `);
  }

  if (!tableExists(db, "audit_events_v6")) {
    db.exec(CREATE_V6_AUDIT_EVENTS_TABLE_SQL);
  } else {
    const auditColumns = tableColumnNames(db, "audit_events_v6");
    if (!auditColumns.has("auxiliary_session_id")) {
      db.exec(`
        ALTER TABLE audit_events_v6
        ADD COLUMN auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE SET NULL
      `);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_v6_audit_events_session_created
        ON audit_events_v6(session_id, created_at DESC, id DESC)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_v6_audit_events_auxiliary_session_created
        ON audit_events_v6(auxiliary_session_id, created_at DESC, id DESC)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_v6_audit_events_type_created
        ON audit_events_v6(event_type, created_at DESC)
    `);
  }

}

export function ensureV6Schema(db: DatabaseSync): void {
  runWithSavepoint(db, "ensure_v6_schema", () => ensureV6SchemaUnsafe(db));
}
