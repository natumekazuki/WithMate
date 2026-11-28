import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openAppDatabaseReadOnly } from "./sqlite-connection.js";
import { migrateLegacySessionTurnsV6 } from "./migrations/migrate-session-turn-storage-v6.js";
import {
  removeRetiredMemoryAffectDatabaseData,
  RETIRED_MEMORY_AFFECT_TABLES,
} from "./migrations/memory-affect-removal.js";
import { CREATE_V7_COORDINATION_RECORDS_SQL } from "../coordination/coordination-schema-v7.js";
import { CREATE_LOCAL_PR_SCHEMA_SQL } from "../local-pr/local-pr-schema.js";

/** 通常起動で使用するV6 DBのファイル名。 */
export const APP_DATABASE_V6_FILENAME = "withmate-v6.db";
/** 新規作成と既存ファイル判定に使うSQLiteユーザー版番号。 */
export const APP_DATABASE_V6_SCHEMA_VERSION = 6;

/** V6の基盤スキーマ定義に付随する設計ステータス。 */
export const V6_SCHEMA_STATUS = "foundation";

// 外部キーを有効にしたまま、廃止したテーブルを子から親の順に削除する。
/** 廃止したSession Graphの永続テーブルを削除順に並べた一覧。 */
export const RETIRED_SESSION_GRAPH_TABLES = [
  "session_graph_relations_v6",
  "session_graph_records_v6",
  "session_graph_topics_v6",
  "session_graphs_v6",
] as const;

/** V6の有効性確認で存在を求める基盤テーブル。後から追加できる機能表は必ずしも含まない。 */
export const REQUIRED_V6_TABLES = [
  "app_settings",
  "prompt_templates",
  "provider_model_cache",
  "characters",
  "project_scopes_v6",
  "sessions_v6",
  "session_lifecycle_operations_v6",
  "coordination_records_v7",
  "session_messages_v6",
  "session_file_pins_v6",
  "auxiliary_sessions",
  "auxiliary_session_messages",
  "session_turns_v6",
  "session_turn_queue_v6",
] as const;

/** V6では残してはならない退役テーブルと旧形式名の一覧。 */
export const FORBIDDEN_V6_TABLES = [
  ...RETIRED_MEMORY_AFFECT_TABLES,
  ...RETIRED_SESSION_GRAPH_TABLES,
  "session_turn_interims_v6",
  "session_turn_provider_outputs_v6",
  "audit_events_v6",
  "session_memories",
  "project_memory_entries",
  "project_scopes",
  "character_memory_entries",
  "character_scopes",
] as const;

const REQUIRED_V6_INDEXES = [
  "idx_v6_prompt_templates_name",
  "idx_v6_characters_state_updated",
  "idx_v6_project_scopes_key",
  "idx_v6_sessions_last_active",
  "idx_v6_sessions_root",
  "idx_v6_sessions_parent",
  "idx_v6_session_lifecycle_operations_kind_phase",
  "idx_coordination_v7_crew",
  "idx_coordination_v7_respondent",
  "idx_v6_session_messages_session_seq",
  "idx_auxiliary_sessions_parent_updated",
  "idx_v6_session_turns_session_updated",
  "idx_v6_session_turns_auxiliary_updated",
  "idx_v6_session_turns_phase_updated",
  "idx_v6_session_turn_queue_owner_state",
  "idx_v6_session_turn_queue_main_request",
  "idx_v6_session_turn_queue_auxiliary_request",
] as const;

const REQUIRED_V6_TABLE_COLUMNS = {
  app_settings: ["setting_key", "setting_value", "updated_at"],
  prompt_templates: ["id", "name", "prompt", "created_at", "updated_at"],
  provider_model_cache: [
    "provider_id",
    "provider_json",
    "context_key",
    "fetched_at",
  ],
  characters: [
    "id",
    "name",
    "description",
    "icon_file_path",
    "theme_main",
    "theme_sub",
    "state",
    "is_default",
    "created_at",
    "updated_at",
    "archived_at",
  ],
  project_scopes_v6: [
    "id",
    "project_type",
    "project_key",
    "workspace_path",
    "git_root",
    "git_remote_url",
    "display_name",
    "created_at",
    "updated_at",
  ],
  sessions_v6: [
    "id",
    "title",
    "state",
    "session_kind",
    "session_role",
    "root_session_id",
    "parent_session_id",
    "created_by_session_id",
    "description",
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
  session_messages_v6: [
    "id",
    "session_id",
    "seq",
    "role",
    "body",
    "created_at",
  ],
  session_lifecycle_operations_v6: [
    "operation_id",
    "kind",
    "input_json",
    "targets_json",
    "resources_json",
    "prepared_json",
    "phase",
    "created_at",
    "updated_at",
  ],
  coordination_records_v7: [
    "id",
    "crew_root_session_id",
    "initiator_session_id",
    "initiator_kind",
    "initiator_incarnation_id",
    "respondent_session_id",
    "respondent_kind",
    "state",
    "payload_json",
  ],
  session_file_pins_v6: [
    "session_id",
    "root_kind",
    "root_path",
    "relative_path",
    "relative_path_key",
    "kind",
    "root_label",
  ],
  session_turn_queue_v6: [
    "sequence",
    "queue_position",
    "id",
    "session_id",
    "auxiliary_session_id",
    "incarnation_id",
    "request_id",
    "state",
    "captured_json",
    "accepted_json",
    "dispatched_json",
    "turn_id",
    "input_turn_id",
    "user_message_seq",
    "reason",
    "released_at",
    "created_at",
    "updated_at",
  ],
  auxiliary_sessions: ["id", "parent_session_id", "created_at", "updated_at"],
  auxiliary_session_messages: [
    "auxiliary_session_id",
    "seq",
    "role",
    "body",
    "artifact_body",
    "created_at",
  ],
  session_turns_v6: [
    "id",
    "session_id",
    "auxiliary_session_id",
    "phase",
    "provider_id",
    "model_id",
    "reasoning_effort",
    "approval_mode",
    "sandbox_mode",
    "user_message_seq",
    "assistant_message_seq",
    "thread_id",
    "error_summary",
    "started_at",
    "completed_at",
    "updated_at",
  ],
} as const satisfies Record<
  (typeof REQUIRED_V6_TABLES)[number],
  readonly string[]
>;

/** ユーザーデータ直下に新規V6 DBのパスを解決する。ファイルは作成しない。 */
export function resolveV6FreshDatabasePath(userDataPath: string): string {
  return join(userDataPath, APP_DATABASE_V6_FILENAME);
}

/** V6のファイル名に対して読み取り専用でユーザー版番号を取得し、取得できなければnullを返す。 */
export function readV6DatabaseUserVersion(dbPath: string): number | null {
  if (basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
    return null;
  }

  let db: DatabaseSync | null = null;
  try {
    db = openAppDatabaseReadOnly(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    return typeof row?.user_version === "number" ? row.user_version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** V6のファイル名・版番号・テーブル・列・索引・制約を確認し、外部キー違反のある行や読み取れないDBを拒否する。 */
export function isValidV6Database(dbPath: string): boolean {
  if (basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = openAppDatabaseReadOnly(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    if (row?.user_version !== APP_DATABASE_V6_SCHEMA_VERSION) {
      return false;
    }

    const existingTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .all() as Array<{ name?: unknown }>
      )
        .map((table) => table.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (
      !REQUIRED_V6_TABLES.every((tableName) => existingTables.has(tableName))
    ) {
      return false;
    }
    if (
      FORBIDDEN_V6_TABLES.some((tableName) => existingTables.has(tableName))
    ) {
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

/** V6のファイル名と版番号、必須・禁止テーブルだけを調べる簡易判定。列・索引・格納行の整合性は検証しない。 */
export function isValidV6DatabaseShallow(dbPath: string): boolean {
  if (basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = openAppDatabaseReadOnly(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    if (row?.user_version !== APP_DATABASE_V6_SCHEMA_VERSION) {
      return false;
    }

    const existingTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
          .all() as Array<{ name?: unknown }>
      )
        .map((table) => table.name)
        .filter((name): name is string => typeof name === "string"),
    );
    return (
      REQUIRED_V6_TABLES.every((tableName) => existingTables.has(tableName)) &&
      !FORBIDDEN_V6_TABLES.some((tableName) => existingTables.has(tableName))
    );
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** 必須列を確認する。Auxiliaryの詳細は旧payload列または正規化済みの列一式のどちらかを認める。 */
function hasRequiredColumns(db: DatabaseSync): boolean {
  for (const [tableName, expectedColumns] of Object.entries(
    REQUIRED_V6_TABLE_COLUMNS,
  )) {
    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
          name?: unknown;
        }>
      )
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!expectedColumns.every((column) => columns.has(column))) {
      return false;
    }
  }

  const auxiliaryColumns = tableColumnNames(db, "auxiliary_sessions");
  const normalizedColumns = [
    "title",
    "description",
    "run_state",
    "preview",
    "provider_id",
    "catalog_revision",
    "model_id",
    "reasoning_effort",
    "approval_mode",
    "codex_sandbox_mode",
    "codex_speed",
    "codex_reviewer",
    "withmate_reviewer_explicit",
    "custom_agent_name",
    "thread_id",
    "display_after_message_index",
    "character_id",
    "character_snapshot_json",
    "character_snapshot_invalid",
    "character_icon_path",
    "client_request_id",
    "creation_context_json",
    "creation_request_json",
  ];
  if (
    !auxiliaryColumns.has("payload_json") &&
    !normalizedColumns.every((name) => auxiliaryColumns.has(name))
  ) {
    return false;
  }

  return true;
}

/** SQLiteのスキーマ情報から必須インデックス名が揃っているか確認する。 */
function hasRequiredIndexes(db: DatabaseSync): boolean {
  const indexes = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
        .all() as Array<{ name?: unknown }>
    )
      .map((index) => index.name)
      .filter((name): name is string => typeof name === "string"),
  );
  return REQUIRED_V6_INDEXES.every((indexName) => indexes.has(indexName));
}

/** 指定した参照元列・参照先と、指定がある場合は親削除時の動作まで一致する外部キーを探す。 */
function hasForeignKey(
  db: DatabaseSync,
  tableName: string,
  fromColumn: string,
  targetTable: string,
  targetColumn = "id",
  onDelete?: "CASCADE" | "RESTRICT" | "SET NULL",
): boolean {
  const keys = db
    .prepare(`PRAGMA foreign_key_list(${tableName})`)
    .all() as Array<{
    from?: unknown;
    on_delete?: unknown;
    table?: unknown;
    to?: unknown;
  }>;
  return keys.some(
    (key) =>
      key.from === fromColumn &&
      key.table === targetTable &&
      key.to === targetColumn &&
      (onDelete === undefined || key.on_delete === onDelete),
  );
}

/** Sessionと会話・受付などの関係を支える所定の外部キーが宣言されているか確認する。 */
function hasRequiredForeignKeys(db: DatabaseSync): boolean {
  return (
    hasForeignKey(db, "sessions_v6", "character_id", "characters") &&
    hasForeignKey(
      db,
      "coordination_records_v7",
      "crew_root_session_id",
      "sessions_v6",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(db, "sessions_v6", "project_scope_id", "project_scopes_v6") &&
    hasForeignKey(db, "session_messages_v6", "session_id", "sessions_v6") &&
    hasForeignKey(
      db,
      "session_file_pins_v6",
      "session_id",
      "sessions_v6",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      db,
      "session_turn_queue_v6",
      "session_id",
      "sessions_v6",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      db,
      "session_turn_queue_v6",
      "auxiliary_session_id",
      "auxiliary_sessions",
      "id",
      "CASCADE",
    ) &&
    hasForeignKey(
      db,
      "auxiliary_session_messages",
      "auxiliary_session_id",
      "auxiliary_sessions",
    ) &&
    hasForeignKey(db, "session_turns_v6", "session_id", "sessions_v6") &&
    hasForeignKey(
      db,
      "session_turns_v6",
      "auxiliary_session_id",
      "auxiliary_sessions",
    )
  );
}

/** テーブルのDDLをSQLiteから取得する。未作成などで取得できない場合は空文字列を返す。 */
function tableSql(db: DatabaseSync, tableName: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql : "";
}

/** 保存JSONや状態の許容値、Turn所有者の排他性など、必須の制約がDDLに含まれるか確認する。 */
function hasRequiredCheckConstraints(db: DatabaseSync): boolean {
  const sessionsSql = tableSql(db, "sessions_v6");
  const lifecycleSql = tableSql(db, "session_lifecycle_operations_v6");
  const coordinationSql = tableSql(db, "coordination_records_v7");
  const filePinsSql = tableSql(db, "session_file_pins_v6");
  const turnQueueSql = tableSql(db, "session_turn_queue_v6");
  const sessionTurnsSql = tableSql(db, "session_turns_v6");

  return (
    sessionsSql.includes("json_valid(character_snapshot_json)") &&
    lifecycleSql.includes("kind IN ('create', 'delete')") &&
    lifecycleSql.includes("phase IN ('preparing', 'applied', 'complete')") &&
    coordinationSql.includes(
      "state IN ('open','resolved','withdrawn','corrected')",
    ) &&
    coordinationSql.includes("json_valid(payload_json)") &&
    filePinsSql.includes(
      "root_kind IN ('workspace', 'session-folder', 'crew-folder', 'additional')",
    ) &&
    filePinsSql.includes("kind IN ('file', 'directory')") &&
    filePinsSql.includes("root_path <> ''") &&
    filePinsSql.includes("relative_path <> ''") &&
    filePinsSql.includes("relative_path_key <> ''") &&
    filePinsSql.includes(
      "PRIMARY KEY (session_id, root_kind, root_path, relative_path_key)",
    ) &&
    turnQueueSql.includes(
      "state IN ('queued', 'starting', 'running', 'completed', 'failed', 'canceled', 'interrupted')",
    ) &&
    turnQueueSql.includes("json_valid(captured_json)") &&
    turnQueueSql.includes(
      "accepted_json IS NULL OR json_valid(accepted_json)",
    ) &&
    turnQueueSql.includes(
      "dispatched_json IS NULL OR json_valid(dispatched_json)",
    ) &&
    turnQueueSql.includes("FOREIGN KEY (auxiliary_session_id)") &&
    sessionTurnsSql.includes(
      "phase IN ('running', 'completed', 'failed', 'canceled')",
    ) &&
    sessionTurnsSql.includes(
      "session_id IS NOT NULL OR auxiliary_session_id IS NOT NULL",
    ) &&
    sessionTurnsSql.includes(
      "NOT (session_id IS NOT NULL AND auxiliary_session_id IS NOT NULL)",
    )
  );
}

/** 定義の有無とは別に、保存済み行が外部キーに違反していないことをSQLiteで確認する。 */
function hasNoForeignKeyViolations(db: DatabaseSync): boolean {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  return violations.length === 0;
}

/** アプリ共通設定をキー・値・更新時刻で保持するV6のDDL。 */
export const CREATE_V6_APP_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/** 再利用するプロンプト本文を名前や更新時刻とともに保持するV6のDDL。 */
export const CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_prompt_templates_name
    ON prompt_templates(name COLLATE NOCASE);
`;

/** プロバイダーごとのモデル取得結果をコンテキストキーで区別して保存するV6のDDL。 */
export const CREATE_V6_PROVIDER_MODEL_CACHE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS provider_model_cache (
    provider_id TEXT NOT NULL,
    provider_json TEXT NOT NULL,
    context_key TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, context_key)
  );
`;

/** Characterカタログの表示・定義参照・状態を管理するV6のDDL。 */
export const CREATE_V6_CHARACTERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon_file_path TEXT NOT NULL DEFAULT '',
    theme_main TEXT NOT NULL DEFAULT '#6f8cff',
    theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
    -- Legacy metadata retained until a future table-rebuild migration; runtime code does not read or write it.
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

/** Projectの識別キーとworkspace・Git情報を保存し、Sessionから共有できるようにするV6のDDL。 */
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

/** 通常Sessionの識別子・親子関係・実行設定・Characterスナップショットを会話本文から分離して保持するV6のDDL。 */
export const CREATE_V6_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sessions_v6 (
    id TEXT PRIMARY KEY,
    incarnation_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'failed', 'archived')),
    session_kind TEXT NOT NULL DEFAULT 'default',
    session_role TEXT NOT NULL DEFAULT 'standalone',
    root_session_id TEXT,
    parent_session_id TEXT,
    created_by_session_id TEXT,
    description TEXT NOT NULL DEFAULT '',
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
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    instructions_json TEXT NOT NULL DEFAULT '""',
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

  CREATE INDEX IF NOT EXISTS idx_v6_sessions_root ON sessions_v6(root_session_id);
  CREATE INDEX IF NOT EXISTS idx_v6_sessions_parent ON sessions_v6(parent_session_id);
`;

/** Sessionの作成・削除操作を、準備内容と再開に使う段階とともに保持するV6のDDL。 */
export const CREATE_V6_SESSION_LIFECYCLE_OPERATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_lifecycle_operations_v6 (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'delete')),
    input_json TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    resources_json TEXT NOT NULL DEFAULT '[]',
    prepared_json TEXT,
    phase TEXT NOT NULL CHECK (phase IN ('preparing', 'applied', 'complete')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_v6_session_lifecycle_operations_kind_phase
    ON session_lifecycle_operations_v6(kind, phase);
`;

/** 親Session内のルートと相対パスを識別キーとしてファイルのピンを保存し、親の削除に追従させるV6のDDL。 */
export const CREATE_V6_SESSION_FILE_PINS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_file_pins_v6 (
    session_id TEXT NOT NULL,
    root_kind TEXT NOT NULL CHECK (root_kind IN ('workspace', 'session-folder', 'crew-folder', 'additional')),
    root_path TEXT NOT NULL CHECK (root_path <> ''),
    relative_path TEXT NOT NULL CHECK (relative_path <> ''),
    relative_path_key TEXT NOT NULL CHECK (relative_path_key <> ''),
    kind TEXT NOT NULL CHECK (kind IN ('file', 'directory')),
    root_label TEXT NOT NULL,
    PRIMARY KEY (session_id, root_kind, root_path, relative_path_key),
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
  );
`;

/** 通常Sessionの会話本文をSession内で一意な順序番号とともに保存するV6のDDL。 */
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

/** Auxiliaryのメタデータと順序付き会話を別テーブルに保存するV6のDDL。 */
export const CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS auxiliary_sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    run_state TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle', 'running', 'error')),
    preview TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT 'codex',
    catalog_revision INTEGER NOT NULL DEFAULT 1,
    model_id TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT 'medium',
    approval_mode TEXT NOT NULL DEFAULT '',
    codex_sandbox_mode TEXT NOT NULL DEFAULT '',
    codex_speed TEXT NOT NULL DEFAULT '',
    codex_reviewer TEXT NOT NULL DEFAULT '',
    withmate_reviewer_explicit INTEGER NOT NULL DEFAULT 0 CHECK (withmate_reviewer_explicit IN (0, 1)),
    custom_agent_name TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    display_after_message_index INTEGER,
    character_id TEXT,
    character_snapshot_json TEXT,
    character_snapshot_invalid INTEGER NOT NULL DEFAULT 0,
    character_icon_path TEXT,
    client_request_id TEXT,
    creation_context_json TEXT,
    creation_request_json TEXT,
    instructions_json TEXT NOT NULL DEFAULT '""'
  );

  CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
    ON auxiliary_sessions(parent_session_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS auxiliary_session_messages (
    auxiliary_session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    body TEXT NOT NULL CHECK (json_valid(body)),
    artifact_body TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (auxiliary_session_id, seq),
    FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE CASCADE
  );
`;

/** MainまたはAuxiliaryの一方だけを所有者とする最小Turnの実行情報を保存するV6のDDL。 */
export const CREATE_V6_SESSION_TURNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_turns_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    auxiliary_session_id TEXT,
    phase TEXT NOT NULL CHECK (phase IN ('running', 'completed', 'failed', 'canceled')),
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    approval_mode TEXT NOT NULL DEFAULT '',
    sandbox_mode TEXT NOT NULL DEFAULT '',
    user_message_seq INTEGER CHECK (user_message_seq IS NULL OR user_message_seq >= 0),
    assistant_message_seq INTEGER CHECK (assistant_message_seq IS NULL OR assistant_message_seq >= 0),
    thread_id TEXT NOT NULL DEFAULT '',
    error_summary TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE CASCADE,
    CHECK (session_id IS NOT NULL OR auxiliary_session_id IS NOT NULL),
    CHECK (NOT (session_id IS NOT NULL AND auxiliary_session_id IS NOT NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_turns_session_updated
    ON session_turns_v6(session_id, updated_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_session_turns_auxiliary_updated
    ON session_turns_v6(auxiliary_session_id, updated_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_session_turns_phase_updated
    ON session_turns_v6(phase, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_session_turns_session_failed_message
    ON session_turns_v6(session_id, assistant_message_seq, id DESC)
    WHERE phase = 'failed' AND session_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_v6_session_turns_auxiliary_failed_message
    ON session_turns_v6(auxiliary_session_id, assistant_message_seq, id DESC)
    WHERE phase = 'failed' AND auxiliary_session_id IS NOT NULL;
`;

/** 受付順と実行順、受付・予定・採用入力と状態を保存し、所有者ごとのリクエストID重複を防ぐV6のDDL。 */
export const CREATE_V6_SESSION_TURN_QUEUE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_turn_queue_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_position INTEGER NOT NULL DEFAULT 0 CHECK (queue_position >= 0),
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    auxiliary_session_id TEXT,
    incarnation_id TEXT NOT NULL CHECK (incarnation_id <> ''),
    request_id TEXT NOT NULL CHECK (request_id <> ''),
    state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'completed', 'failed', 'canceled', 'interrupted')),
    captured_json TEXT NOT NULL CHECK (json_valid(captured_json)),
    accepted_json TEXT CHECK (accepted_json IS NULL OR json_valid(accepted_json)),
    dispatched_json TEXT CHECK (dispatched_json IS NULL OR json_valid(dispatched_json)),
    source_display_position INTEGER CHECK (source_display_position IS NULL OR source_display_position >= 0),
    source_display_verified INTEGER NOT NULL DEFAULT 0 CHECK (source_display_verified IN (0, 1)),
    turn_id TEXT,
    input_turn_id TEXT,
    user_message_seq INTEGER CHECK (user_message_seq IS NULL OR user_message_seq >= 0),
    reason TEXT,
    released_at TEXT CHECK (released_at IS NULL OR state = 'interrupted'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (auxiliary_session_id) REFERENCES auxiliary_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_v6_session_turn_queue_owner_state
    ON session_turn_queue_v6(session_id, auxiliary_session_id, incarnation_id, state, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_turn_queue_main_request
    ON session_turn_queue_v6(session_id, incarnation_id, request_id) WHERE auxiliary_session_id IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_turn_queue_auxiliary_request
    ON session_turn_queue_v6(auxiliary_session_id, incarnation_id, request_id) WHERE auxiliary_session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_v6_session_turn_queue_main_message
    ON session_turn_queue_v6(session_id, incarnation_id, user_message_seq)
    WHERE auxiliary_session_id IS NULL AND user_message_seq IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_v6_session_turn_queue_auxiliary_message
    ON session_turn_queue_v6(auxiliary_session_id, incarnation_id, user_message_seq)
    WHERE auxiliary_session_id IS NOT NULL AND user_message_seq IS NOT NULL;
`;

/** 新規V6のテーブルと機能表の作成SQLを依存順に並べ、最後に版番号を設定する。 */
export const CREATE_V6_SCHEMA_SQL = [
  CREATE_V6_APP_SETTINGS_TABLE_SQL,
  CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL,
  CREATE_V6_PROVIDER_MODEL_CACHE_TABLE_SQL,
  CREATE_V6_CHARACTERS_TABLE_SQL,
  CREATE_V6_PROJECT_SCOPES_TABLE_SQL,
  CREATE_V6_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_LIFECYCLE_OPERATIONS_TABLE_SQL,
  CREATE_V7_COORDINATION_RECORDS_SQL,
  // 機能テーブルの追加を理由に、既存の古い V6 ファイルを旧版からのインポートで置き換えてはならない。
  CREATE_LOCAL_PR_SCHEMA_SQL,
  CREATE_V6_SESSION_FILE_PINS_TABLE_SQL,
  CREATE_V6_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_TURNS_TABLE_SQL,
  CREATE_V6_SESSION_TURN_QUEUE_TABLE_SQL,
  `PRAGMA user_version = ${APP_DATABASE_V6_SCHEMA_VERSION};`,
] as const;

/** 指定名のテーブルが現行のSQLiteスキーマ内に存在するか確認する。 */
function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: unknown } | undefined;
  return row?.name === tableName;
}

/** SQLiteの列定義から、既存表で利用可能な列名の集合を取得する。 */
function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name?: unknown;
      }>
    )
      .map((column) => column.name)
      .filter((name): name is string => typeof name === "string"),
  );
}

/** 旧Auxiliaryの識別子とpayloadを保ったまま表を作り直し、作成時刻列がない場合は更新時刻を引き継ぐ。 */
function rebuildAuxiliarySessionsTable(
  db: DatabaseSync,
  columns: Set<string>,
): void {
  const createdAtExpression = columns.has("created_at")
    ? "created_at"
    : "updated_at";
  db.exec("DROP TABLE IF EXISTS auxiliary_sessions_v6_rebuild;");
  db.exec(`
    CREATE TABLE auxiliary_sessions_v6_rebuild (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO auxiliary_sessions_v6_rebuild (
      id,
      parent_session_id,
      created_at,
      updated_at,
      payload_json
    )
    SELECT
      id,
      parent_session_id,
      ${createdAtExpression},
      updated_at,
      payload_json
    FROM auxiliary_sessions
  `);
  db.exec("DROP TABLE auxiliary_sessions;");
  db.exec(
    "ALTER TABLE auxiliary_sessions_v6_rebuild RENAME TO auxiliary_sessions;",
  );
}

/** 作成時刻が空またはNULLの既存Auxiliaryに限り、保存済み更新時刻で補う。 */
function backfillAuxiliarySessionsCreatedAt(db: DatabaseSync): void {
  db.exec(
    "UPDATE auxiliary_sessions SET created_at = updated_at WHERE created_at IS NULL OR created_at = '';",
  );
}

/** 処理をセーブポイントで囲み、途中で失敗した場合はその範囲をロールバックして失敗を伝える。 */
function runWithSavepoint(
  db: DatabaseSync,
  savepointName: string,
  run: () => void,
): void {
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

/** 退役済みテーブルのうち禁止一覧にあるものだけを、存在する場合に削除する。 */
export function cleanupForbiddenV6Tables(db: DatabaseSync): void {
  for (const tableName of FORBIDDEN_V6_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${tableName};`);
  }
}

/** 既存V6の列追加や旧Turn・受付の移行、禁止テーブルの整理を行う。失敗時の巻き戻しは呼び出し側が担う。 */
function ensureV6SchemaUnsafe(db: DatabaseSync): void {
  db.exec(
    "DROP TABLE IF EXISTS model_catalog_models; DROP TABLE IF EXISTS model_catalog_providers; DROP TABLE IF EXISTS model_catalog_revisions;",
  );
  removeRetiredMemoryAffectDatabaseData(db);
  if (tableExists(db, "sessions_v6")) {
    const sessionColumns = tableColumnNames(db, "sessions_v6");
    for (const [name, definition] of [
      ["session_role", "TEXT NOT NULL DEFAULT 'standalone'"],
      ["root_session_id", "TEXT"],
      ["parent_session_id", "TEXT"],
      ["created_by_session_id", "TEXT"],
      ["description", "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!sessionColumns.has(name))
        db.exec(`ALTER TABLE sessions_v6 ADD COLUMN ${name} ${definition}`);
    }
  }
  for (const statement of CREATE_V6_SCHEMA_SQL) {
    if (
      statement === CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL ||
      statement === CREATE_V6_SESSION_TURNS_TABLE_SQL ||
      statement === CREATE_V6_SESSION_TURN_QUEUE_TABLE_SQL
    ) {
      continue;
    }
    db.exec(statement);
  }

  if (!tableSql(db, "session_file_pins_v6").includes("'crew-folder'")) {
    db.exec(
      CREATE_V6_SESSION_FILE_PINS_TABLE_SQL.replace(
        "IF NOT EXISTS session_file_pins_v6",
        "session_file_pins_v6_rebuild",
      ),
    );
    db.exec(`
      INSERT INTO session_file_pins_v6_rebuild
        (session_id, root_kind, root_path, relative_path, relative_path_key, kind, root_label)
      SELECT session_id, root_kind, root_path, relative_path, relative_path_key, kind, root_label
      FROM session_file_pins_v6;
      DROP TABLE session_file_pins_v6;
      ALTER TABLE session_file_pins_v6_rebuild RENAME TO session_file_pins_v6;
    `);
  }

  const sessionColumns = tableColumnNames(db, "sessions_v6");
  // 既存 Session は指示なしで始まり、会話や設定の項目は書き換えない。
  if (!sessionColumns.has("instructions_json")) {
    db.exec(
      `ALTER TABLE sessions_v6 ADD COLUMN instructions_json TEXT NOT NULL DEFAULT '""'`,
    );
  }
  if (!sessionColumns.has("is_pinned")) {
    db.exec(
      "ALTER TABLE sessions_v6 ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1));",
    );
  }

  if (!sessionColumns.has("incarnation_id")) {
    db.exec(
      "ALTER TABLE sessions_v6 ADD COLUMN incarnation_id TEXT NOT NULL DEFAULT '';",
    );
  }
  db.exec(
    "UPDATE sessions_v6 SET incarnation_id = 'legacy:' || id WHERE TRIM(COALESCE(incarnation_id, '')) = '';",
  );
  db.exec(
    "UPDATE sessions_v6 SET root_session_id = id WHERE root_session_id IS NULL;",
  );

  if (!tableExists(db, "auxiliary_sessions")) {
    db.exec(CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL);
  } else {
    const auxiliaryColumns = tableColumnNames(db, "auxiliary_sessions");
    db.exec(CREATE_V6_SESSION_TURNS_TABLE_SQL);
    migrateLegacySessionTurnsV6(db);
    const hasRetainedAuxiliaryTurns =
      tableExists(db, "session_turns_v6") &&
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM session_turns_v6 WHERE auxiliary_session_id IS NOT NULL LIMIT 1",
          )
          .get(),
      );
    const shouldRebuildAuxiliarySessions =
      auxiliaryColumns.has("payload_json") &&
      !hasRetainedAuxiliaryTurns &&
      hasForeignKey(
        db,
        "auxiliary_sessions",
        "parent_session_id",
        "sessions_v6",
      );
    if (shouldRebuildAuxiliarySessions) {
      rebuildAuxiliarySessionsTable(db, auxiliaryColumns);
    } else if (!auxiliaryColumns.has("created_at")) {
      db.exec(
        "ALTER TABLE auxiliary_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
      );
    }
    if (
      !auxiliaryColumns.has("payload_json") &&
      !auxiliaryColumns.has("description")
    ) {
      db.exec(
        "ALTER TABLE auxiliary_sessions ADD COLUMN description TEXT NOT NULL DEFAULT ''",
      );
    }
    backfillAuxiliarySessionsCreatedAt(db);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_auxiliary_sessions_parent_updated
        ON auxiliary_sessions(parent_session_id, updated_at DESC)
    `);
  }

  db.exec(CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL);
  const auxiliaryColumns = tableColumnNames(db, "auxiliary_sessions");
  // 旧 Auxiliary テーブルの構成が確定してから列を追加する。
  if (!auxiliaryColumns.has("instructions_json")) {
    db.exec(
      `ALTER TABLE auxiliary_sessions ADD COLUMN instructions_json TEXT NOT NULL DEFAULT '""'`,
    );
  }
  if (
    !auxiliaryColumns.has("payload_json") &&
    !auxiliaryColumns.has("withmate_reviewer_explicit")
  ) {
    db.exec(
      "ALTER TABLE auxiliary_sessions ADD COLUMN withmate_reviewer_explicit INTEGER NOT NULL DEFAULT 0 CHECK (withmate_reviewer_explicit IN (0, 1))",
    );
  }

  db.exec("DROP INDEX IF EXISTS idx_auxiliary_sessions_parent_created");

  db.exec(CREATE_V6_SESSION_TURNS_TABLE_SQL);
  migrateLegacySessionTurnsV6(db);
  if (
    tableExists(db, "session_turn_queue_v6") &&
    !tableColumnNames(db, "session_turn_queue_v6").has("auxiliary_session_id")
  ) {
    const previousSequence = db
      .prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'session_turn_queue_v6'",
      )
      .get() as { seq: number } | undefined;
    db.exec(
      "ALTER TABLE session_turn_queue_v6 RENAME TO session_turn_queue_previous_v6",
    );
    db.exec("DROP INDEX IF EXISTS idx_v6_session_turn_queue_owner_state");
    db.exec(CREATE_V6_SESSION_TURN_QUEUE_TABLE_SQL);
    db.exec(`INSERT INTO session_turn_queue_v6
      (sequence, queue_position, id, session_id, incarnation_id, request_id, state, captured_json, turn_id,
        user_message_seq, reason, released_at, created_at, updated_at)
      SELECT sequence, sequence, id, session_id, incarnation_id, request_id, state, captured_json, turn_id,
        user_message_seq, reason, released_at, created_at, updated_at FROM session_turn_queue_previous_v6`);
    db.exec("DROP TABLE session_turn_queue_previous_v6");
    if (previousSequence) {
      db.prepare(
        "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'session_turn_queue_v6'",
      ).run(previousSequence.seq);
      if (
        !db
          .prepare(
            "SELECT 1 FROM sqlite_sequence WHERE name = 'session_turn_queue_v6'",
          )
          .get()
      ) {
        db.prepare(
          "INSERT INTO sqlite_sequence (name, seq) VALUES ('session_turn_queue_v6', ?)",
        ).run(previousSequence.seq);
      }
    }
  }
  db.exec(CREATE_V6_SESSION_TURN_QUEUE_TABLE_SQL);
  if (!tableColumnNames(db, "session_turn_queue_v6").has("queue_position")) {
    db.exec(
      "ALTER TABLE session_turn_queue_v6 ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0 CHECK (queue_position >= 0)",
    );
    db.exec("UPDATE session_turn_queue_v6 SET queue_position = sequence");
  }
  const queueColumns = tableColumnNames(db, "session_turn_queue_v6");
  for (const name of ["accepted_json", "dispatched_json"]) {
    if (!queueColumns.has(name)) {
      db.exec(
        `ALTER TABLE session_turn_queue_v6 ADD COLUMN ${name} TEXT CHECK (${name} IS NULL OR json_valid(${name}))`,
      );
    }
  }
  if (!queueColumns.has("source_display_position")) {
    db.exec(
      "ALTER TABLE session_turn_queue_v6 ADD COLUMN source_display_position INTEGER CHECK (source_display_position IS NULL OR source_display_position >= 0)",
    );
  }
  if (!queueColumns.has("source_display_verified")) {
    db.exec(
      "ALTER TABLE session_turn_queue_v6 ADD COLUMN source_display_verified INTEGER NOT NULL DEFAULT 0 CHECK (source_display_verified IN (0, 1))",
    );
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_v6_session_turn_queue_sender ON session_turn_queue_v6(
    json_extract(accepted_json, '$.origin.actorKind'),
    json_extract(accepted_json, '$.origin.actorSessionId'),
    json_extract(accepted_json, '$.origin.actorIncarnationId'),
    json_extract(accepted_json, '$.origin.actorTurnId'), sequence)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_v6_session_messages_steer_sender ON session_messages_v6(
    json_extract(body, '$.turnInput.origin.actorKind'),
    json_extract(body, '$.turnInput.origin.actorSessionId'),
    json_extract(body, '$.turnInput.origin.actorIncarnationId'),
    json_extract(body, '$.turnInput.origin.actorTurnId'), id)
    WHERE role='user' AND json_extract(body, '$.turnInput.origin.operation')='steer'`);
  cleanupForbiddenV6Tables(db);
  // 古い Graph の初期化マーカーを、対応するテーブルと同じセーブポイント内で削除する。
  db.exec(
    "DELETE FROM app_settings WHERE setting_key = 'session_graph_agent_origin_contract_initialized_at';",
  );
  if (tableColumnNames(db, "session_turns_v6").has("summary")) {
    db.exec("ALTER TABLE session_turns_v6 DROP COLUMN summary");
  }
}

/** V6の作成・更新・廃止テーブル整理を同じセーブポイントで実施し、失敗時は更新を巻き戻す。 */
export function ensureV6Schema(db: DatabaseSync): void {
  runWithSavepoint(db, "ensure_v6_schema", () => ensureV6SchemaUnsafe(db));
}
