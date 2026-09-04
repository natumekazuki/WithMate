import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES,
  WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES,
  WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES,
} from "../src/work-item.js";

export const APP_DATABASE_V6_FILENAME = "withmate-v6.db";
export const APP_DATABASE_V6_SCHEMA_VERSION = 6;
const SESSION_EXECUTION_ORIGIN_MIGRATION_SETTING_KEY = "session_execution_origins_v6_migrated_at";

export const V6_SCHEMA_STATUS = "foundation";

export const REQUIRED_V6_TABLES = [
  "app_settings",
  "prompt_templates",
  "model_catalog_revisions",
  "model_catalog_providers",
  "model_catalog_models",
  "characters",
  "project_scopes_v6",
  "sessions_v6",
  "session_role_bindings_v6",
  "session_messages_v6",
  "auxiliary_sessions",
  "session_turns_v6",
  "session_turn_interims_v6",
  "session_turn_provider_outputs_v6",
  "session_execution_origins_v6",
  "work_items_v6",
  "work_item_events_v6",
  "work_item_idempotency_v6",
  "work_item_execution_associations_v6",
  "work_item_aggregations_v6",
  "work_item_aggregation_decisions_v6",
  "work_item_aggregation_idempotency_v6",
  "session_execution_public_progress_v6",
  "session_turn_public_context_v6",
  "session_interactions_v6",
  "session_interaction_idempotency_v6",
  "coordination_events_v6",
  "coordination_event_actions_v6",
  "coordination_event_idempotency_v6",
  "session_transcript_export_idempotency_v6",
  "memory_entries_v6",
  "memory_entry_tags_v6",
  "memory_entry_relations_v6",
  "memory_tag_catalog_v6",
  "memory_target_tag_stats_v6",
  "memory_mutation_events_v6",
  "memory_idempotency_keys_v6",
  "memory_idempotency_forget_results_v6",
  "memory_move_events_v6",
  "memory_protected_objects_v6",
  "character_affect_events_v6",
  "character_affect_resets_v6",
  "character_affect_idempotency_v6",
  "character_affect_mutations_v6",
  "character_affect_observations_v6",
] as const;

export const FORBIDDEN_V6_TABLES = [
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
  "idx_v6_session_role_bindings_parent",
  "idx_v6_session_messages_session_seq",
  "idx_auxiliary_sessions_parent_updated",
  "idx_auxiliary_sessions_parent_created",
  "idx_v6_session_turns_session_updated",
  "idx_v6_session_turns_auxiliary_updated",
  "idx_v6_session_turns_phase_updated",
  "idx_v6_session_turn_interims_turn_seq",
  "idx_v6_session_turn_provider_outputs_turn_kind_seq",
  "idx_v6_session_execution_public_progress_updated",
  "idx_v6_session_execution_origins_source_sequence",
  "idx_v6_work_items_root_sequence",
  "idx_v6_work_items_creator_sequence",
  "idx_v6_work_items_target_sequence",
  "idx_v6_work_items_parent",
  "idx_v6_work_items_one_root_per_session",
  "idx_v6_work_item_events_item_sequence",
  "idx_v6_work_item_idempotency_item",
  "idx_v6_work_item_idempotency_expiry",
  "idx_v6_work_item_execution_item",
  "idx_v6_session_turns_id_session",
  "idx_v6_session_turn_public_context_execution",
  "idx_v6_session_interactions_execution_sequence",
  "idx_v6_session_interactions_one_pending",
  "idx_v6_session_interaction_idempotency_interaction",
  "idx_v6_session_interaction_idempotency_expires",
  "idx_v6_coordination_events_actor_sequence",
  "idx_v6_coordination_events_root_sequence",
  "idx_v6_coordination_events_target",
  "idx_v6_coordination_event_actions_event_sequence",
  "idx_v6_coordination_event_idempotency_event",
  "idx_v6_session_transcript_export_idempotency_expires",
  "idx_v6_memory_entries_target_state_updated",
  "idx_v6_memory_entry_tags_lookup",
  "idx_v6_memory_target_tag_stats_page",
  "idx_v6_memory_mutation_events_result",
  "idx_v6_memory_idempotency_response_entry",
  "idx_v6_memory_move_events_entry",
  "idx_v6_memory_move_events_idempotency",
  "idx_v6_memory_protected_objects_state",
  "idx_v6_memory_protected_objects_entry",
  "idx_v6_character_affect_events_effective",
  "idx_v6_character_affect_events_afterglow",
  "idx_v6_character_affect_events_target",
  "idx_v6_character_affect_resets_scope",
  "idx_v6_character_affect_mutations_scope",
  "idx_v6_character_affect_observations_scope",
] as const;

const REQUIRED_V6_TABLE_COLUMNS = {
  app_settings: ["setting_key", "setting_value", "updated_at"],
  prompt_templates: ["id", "name", "prompt", "created_at", "updated_at"],
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
  session_role_bindings_v6: [
    "session_id",
    "session_role",
    "role_contract_revision",
    "root_session_id",
    "parent_session_id",
    "delegation_depth",
  ],
  session_messages_v6: ["id", "session_id", "seq", "role", "body", "created_at"],
  auxiliary_sessions: ["id", "parent_session_id", "status", "created_at", "updated_at", "payload_json"],
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
    "summary",
    "error_summary",
    "started_at",
    "completed_at",
    "updated_at",
  ],
  session_turn_interims_v6: ["id", "turn_id", "seq", "body", "source", "created_at"],
  session_turn_provider_outputs_v6: [
    "id",
    "turn_id",
    "seq",
    "provider_id",
    "kind",
    "summary",
    "payload_json",
    "payload_blob_id",
    "created_at",
  ],
  session_execution_origins_v6: [
    "execution_id",
    "execution_sequence",
    "source_session_id",
    "target_session_id",
    "operation",
    "target_session_title_snapshot",
    "target_session_role_snapshot",
    "source_message_seq_anchor",
    "user_message",
    "accepted_at",
  ],
  work_items_v6: [
    "sequence",
    "id",
    "kind",
    "contract_revision",
    "root_session_id",
    "creator_session_id",
    "target_session_id",
    "parent_work_item_id",
    "goal",
    "scope",
    "completion_criteria",
    "authority",
    "source_identity_json",
    "state",
    "revision",
    "progress_summary",
    "blockers_json",
    "next_action",
    "result_json",
    "created_at",
    "updated_at",
  ],
  work_item_events_v6: [
    "sequence", "work_item_id", "revision", "event_type", "actor_session_id",
    "payload_json", "created_at",
  ],
  work_item_idempotency_v6: [
    "operation",
    "principal_session_id",
    "idempotency_key",
    "request_fingerprint",
    "work_item_id",
    "response_json",
    "created_at",
    "expires_at",
  ],
  work_item_execution_associations_v6: ["execution_id", "work_item_id", "created_at"],
  work_item_aggregations_v6: ["parent_work_item_id", "aggregate_revision", "updated_at"],
  work_item_aggregation_decisions_v6: [
    "sequence", "parent_work_item_id", "child_work_item_id", "decision_revision", "child_revision",
    "actor_session_id", "decision_type", "reason", "replacement_work_item_id", "decided_at",
  ],
  work_item_aggregation_idempotency_v6: [
    "operation", "principal_session_id", "idempotency_key", "request_fingerprint",
    "child_work_item_id", "replacement_work_item_id", "created_at", "expires_at",
  ],
  session_execution_public_progress_v6: [
    "execution_id",
    "assistant_text",
    "truncated",
    "updated_at",
  ],
  session_turn_public_context_v6: [
    "turn_id",
    "session_id",
    "execution_id",
    "effective_turn_json",
    "attachments_json",
    "created_at",
    "updated_at",
  ],
  session_interactions_v6: [
    "sequence",
    "id",
    "execution_id",
    "kind",
    "state",
    "public_payload_json",
    "response_action",
    "response_submitted_fields_json",
    "response_fingerprint",
    "expiry_reason",
    "created_at",
    "resolved_at",
    "updated_at",
  ],
  session_interaction_idempotency_v6: [
    "operation",
    "idempotency_key",
    "request_fingerprint",
    "interaction_id",
    "created_at",
    "expires_at",
  ],
  coordination_events_v6: [
    "sequence", "id", "actor_session_id", "session_role", "role_contract_revision",
    "root_session_id", "parent_session_id", "delegation_depth", "kind", "summary",
    "payload_json", "execution_id", "target_session_id", "corrected_event_id", "options_json",
    "created_at",
  ],
  coordination_event_actions_v6: [
    "sequence", "id", "event_id", "action_type", "actor_type", "actor_session_id",
    "option_id", "note", "related_event_id", "created_at",
  ],
  coordination_event_idempotency_v6: [
    "operation", "principal_session_id", "idempotency_key", "request_fingerprint",
    "result_event_id", "target_event_id", "created_at",
  ],
  session_transcript_export_idempotency_v6: [
    "operation",
    "idempotency_key",
    "request_fingerprint",
    "session_id",
    "relative_path",
    "temp_name",
    "state",
    "output_sha256",
    "byte_length",
    "output_device",
    "output_inode",
    "result_json",
    "created_at",
    "expires_at",
  ],
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
  memory_target_tag_stats_v6: ["owner_type", "owner_id", "scope_type", "scope_id", "tag_type", "tag_value", "tag_type_canonical", "tag_value_canonical", "usage_count", "latest_entry_updated_at"],
  memory_mutation_events_v6: ["id", "operation", "entry_id", "binding_id_hash", "session_id", "source_message_id", "result_status", "reason", "created_at"],
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
    "cleanup_pending_count",
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
  memory_move_events_v6: [
    "id",
    "entry_id",
    "from_owner_type",
    "from_owner_id",
    "from_scope_type",
    "from_scope_id",
    "to_owner_type",
    "to_owner_id",
    "to_scope_type",
    "to_scope_id",
    "binding_id_hash",
    "idempotency_key",
    "request_fingerprint",
    "created_at",
  ],
  memory_protected_objects_v6: [
    "object_id",
    "entry_id",
    "state",
    "role",
    "media_kind",
    "content_type",
    "display_name",
    "summary",
    "original_bytes",
    "stored_bytes",
    "sha256",
    "key_id",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  character_affect_events_v6: [
    "id",
    "character_id",
    "user_id",
    "session_id",
    "source_session_id",
    "layer",
    "target_type",
    "target_id",
    "family",
    "value_json",
    "intensity",
    "reason",
    "evidence",
    "occurred_at",
    "idempotency_key",
    "request_fingerprint",
    "correction_of_event_id",
    "state",
    "memory_entry_id",
    "supersedes_memory_entry_id",
    "created_at",
  ],
  character_affect_resets_v6: [
    "id",
    "character_id",
    "user_id",
    "session_id",
    "layer",
    "reason",
    "reset_at",
    "idempotency_key",
    "request_fingerprint",
    "created_at",
  ],
  character_affect_idempotency_v6: [
    "character_id",
    "user_id",
    "idempotency_key",
    "operation",
    "request_fingerprint",
    "event_id",
    "reset_id",
    "created_at",
  ],
  character_affect_mutations_v6: [
    "id",
    "operation",
    "character_id",
    "user_id",
    "session_id",
    "source_session_id",
    "event_id",
    "reset_id",
    "reason",
    "created_at",
  ],
  character_affect_observations_v6: [
    "id",
    "kind",
    "outcome",
    "character_id",
    "user_id",
    "session_id",
    "event_id",
    "reset_id",
    "reason",
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
    if (!hasValidSessionRoleBindingData(db)) {
      return false;
    }
    if (!hasValidScheduleSchemaIfPresent(db)) {
      return false;
    }
    if (!hasValidTerminalFailureNotificationSchemaIfPresent(db)) {
      return false;
    }
    if (!hasValidCoordinationEventSchemaIfPresent(db)) {
      return false;
    }
    if (!hasValidSessionExecutionOriginSchema(db)) {
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

function hasValidCoordinationEventSchemaIfPresent(db: DatabaseSync): boolean {
  const tables = [
    "coordination_events_v6",
    "coordination_event_actions_v6",
    "coordination_event_idempotency_v6",
  ] as const;
  const present = tables.filter((tableName) => tableExists(db, tableName));
  if (present.length === 0) return true;
  if (present.length !== tables.length) return false;
  for (const tableName of tables) {
    const expected = REQUIRED_V6_TABLE_COLUMNS[tableName];
    const actual = tableColumnNames(db, tableName);
    if (!expected.every((column) => actual.has(column))) return false;
  }
  const eventSql = tableSql(db, "coordination_events_v6");
  const actionSql = tableSql(db, "coordination_event_actions_v6");
  const idempotencySql = tableSql(db, "coordination_event_idempotency_v6");
  const normalizedActionSql = actionSql.replace(/\s+/g, " ");
  return eventSql.includes("session_role IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')")
    && eventSql.includes("role_contract_revision = 1")
    && eventSql.includes("delegation_depth BETWEEN 0 AND 2")
    && eventSql.includes("kind IN ('progress', 'decision', 'escalation', 'user_decision_required', 'blocker', 'result', 'correction')")
    && eventSql.includes("length(summary) BETWEEN 1 AND 240")
    && eventSql.includes("json_valid(payload_json)")
    && eventSql.includes("length(CAST(payload_json AS BLOB)) <= 16384")
    && eventSql.includes("json_valid(options_json)")
    && eventSql.includes("json_type(options_json) = 'array'")
    && eventSql.includes("(kind = 'escalation') = (target_session_id IS NOT NULL)")
    && eventSql.includes("(kind = 'correction') = (corrected_event_id IS NOT NULL)")
    && eventSql.includes("json_array_length(options_json) BETWEEN 2 AND 8")
    && eventSql.includes("kind <> 'user_decision_required' AND options_json = '[]'")
    && actionSql.includes("action_type IN ('responded', 'resolved', 'cancelled', 'superseded', 'consumed')")
    && actionSql.includes("actor_type IN ('session', 'trusted_gui')")
    && actionSql.includes("note IS NULL OR length(note) <= 1000")
    && actionSql.includes("actor_type = 'session' OR actor_session_id IS NULL")
    && actionSql.includes("(action_type = 'superseded') = (related_event_id IS NOT NULL)")
    && normalizedActionSql.includes("action_type <> 'consumed' OR ( actor_type = 'session' AND actor_session_id IS NOT NULL AND option_id IS NULL AND note IS NULL AND related_event_id IS NULL )")
    && idempotencySql.includes("operation IN ('coordination.event.create', 'coordination.event.resolve', 'coordination.event.consume', 'coordination.event.cancel', 'coordination.event.correct')")
    && idempotencySql.includes("PRIMARY KEY (principal_session_id, idempotency_key)")
    && hasForeignKey(db, "coordination_events_v6", "actor_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_event_actions_v6", "event_id", "coordination_events_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_event_idempotency_v6", "result_event_id", "coordination_events_v6", "id", "CASCADE");
}

function hasForeignKey(
  db: DatabaseSync,
  tableName: string,
  fromColumn: string,
  targetTable: string,
  targetColumn = "id",
  onDelete?: "CASCADE" | "RESTRICT" | "SET NULL",
): boolean {
  const keys = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
    from?: unknown;
    on_delete?: unknown;
    table?: unknown;
    to?: unknown;
  }>;
  return keys.some((key) => key.from === fromColumn
    && key.table === targetTable
    && key.to === targetColumn
    && (onDelete === undefined || key.on_delete === onDelete));
}

function hasRequiredForeignKeys(db: DatabaseSync): boolean {
  return hasForeignKey(db, "sessions_v6", "character_id", "characters")
    && hasForeignKey(db, "sessions_v6", "project_scope_id", "project_scopes_v6")
    && hasForeignKey(db, "session_role_bindings_v6", "session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_role_bindings_v6", "root_session_id", "sessions_v6", "id", "RESTRICT")
    && hasForeignKey(db, "session_role_bindings_v6", "parent_session_id", "sessions_v6", "id", "RESTRICT")
    && hasForeignKey(db, "session_messages_v6", "session_id", "sessions_v6")
    && hasForeignKey(db, "session_turns_v6", "session_id", "sessions_v6")
    && hasForeignKey(db, "session_turns_v6", "auxiliary_session_id", "auxiliary_sessions")
    && hasForeignKey(db, "session_turn_interims_v6", "turn_id", "session_turns_v6")
    && hasForeignKey(db, "session_turn_provider_outputs_v6", "turn_id", "session_turns_v6")
    && hasForeignKey(
      db,
      "session_execution_public_progress_v6",
      "execution_id",
      "session_executions_v6",
      "id",
      "CASCADE",
    )
    && hasForeignKey(db, "session_execution_origins_v6", "source_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "work_item_events_v6", "work_item_id", "work_items_v6", "id", "CASCADE")
    && hasForeignKey(db, "work_item_events_v6", "actor_session_id", "sessions_v6", "id", "SET NULL")
    && hasForeignKey(db, "coordination_events_v6", "actor_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_events_v6", "root_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_events_v6", "parent_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_events_v6", "execution_id", "session_executions_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_events_v6", "target_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_events_v6", "corrected_event_id", "coordination_events_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_event_actions_v6", "event_id", "coordination_events_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_event_actions_v6", "actor_session_id", "sessions_v6", "id", "SET NULL")
    && hasForeignKey(db, "coordination_event_actions_v6", "related_event_id", "coordination_events_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_event_idempotency_v6", "result_event_id", "coordination_events_v6", "id", "CASCADE")
    && hasForeignKey(db, "coordination_event_idempotency_v6", "target_event_id", "coordination_events_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_turn_public_context_v6", "turn_id", "session_turns_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_turn_public_context_v6", "session_id", "session_turns_v6", "session_id", "CASCADE")
    && hasForeignKey(db, "session_turn_public_context_v6", "execution_id", "session_executions_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_interactions_v6", "execution_id", "session_executions_v6", "id", "CASCADE")
    && hasForeignKey(
      db,
      "session_interaction_idempotency_v6",
      "interaction_id",
      "session_interactions_v6",
      "id",
      "CASCADE",
    )
    && hasForeignKey(
      db,
      "session_transcript_export_idempotency_v6",
      "session_id",
      "sessions_v6",
      "id",
      "CASCADE",
    )
    && hasForeignKey(db, "memory_entries_v6", "source_app_message_id", "session_messages_v6")
    && hasForeignKey(db, "memory_entries_v6", "superseded_by_id", "memory_entries_v6")
    && hasForeignKey(db, "memory_entry_tags_v6", "entry_id", "memory_entries_v6")
    && hasForeignKey(db, "memory_idempotency_keys_v6", "response_entry_id", "memory_entries_v6")
    && hasForeignKey(db, "memory_protected_objects_v6", "entry_id", "memory_entries_v6")
    && hasForeignKey(db, "character_affect_events_v6", "character_id", "characters", "id", "CASCADE")
    && hasForeignKey(db, "character_affect_events_v6", "session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "character_affect_events_v6", "source_session_id", "sessions_v6", "id", "SET NULL")
    && hasForeignKey(
      db,
      "character_affect_events_v6",
      "correction_of_event_id",
      "character_affect_events_v6",
      "id",
      "SET NULL",
    )
    && hasForeignKey(db, "character_affect_events_v6", "memory_entry_id", "memory_entries_v6", "id", "SET NULL")
    && hasForeignKey(
      db,
      "character_affect_events_v6",
      "supersedes_memory_entry_id",
      "memory_entries_v6",
      "id",
      "SET NULL",
    )
    && hasForeignKey(db, "character_affect_resets_v6", "character_id", "characters", "id", "CASCADE")
    && hasForeignKey(db, "character_affect_resets_v6", "session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "character_affect_idempotency_v6", "character_id", "characters", "id", "CASCADE")
    && hasForeignKey(
      db,
      "character_affect_idempotency_v6",
      "event_id",
      "character_affect_events_v6",
      "id",
      "CASCADE",
    )
    && hasForeignKey(
      db,
      "character_affect_idempotency_v6",
      "reset_id",
      "character_affect_resets_v6",
      "id",
      "CASCADE",
    )
    && hasForeignKey(db, "character_affect_mutations_v6", "character_id", "characters", "id", "CASCADE")
    && hasForeignKey(db, "character_affect_mutations_v6", "session_id", "sessions_v6", "id", "SET NULL")
    && hasForeignKey(db, "character_affect_mutations_v6", "source_session_id", "sessions_v6", "id", "SET NULL")
    && hasForeignKey(
      db,
      "character_affect_mutations_v6",
      "event_id",
      "character_affect_events_v6",
      "id",
      "SET NULL",
    )
    && hasForeignKey(
      db,
      "character_affect_mutations_v6",
      "reset_id",
      "character_affect_resets_v6",
      "id",
      "SET NULL",
    )
    && hasForeignKey(db, "character_affect_observations_v6", "character_id", "characters", "id", "CASCADE")
    && hasForeignKey(db, "character_affect_observations_v6", "session_id", "sessions_v6", "id", "SET NULL")
    && hasForeignKey(
      db,
      "character_affect_observations_v6",
      "event_id",
      "character_affect_events_v6",
      "id",
      "SET NULL",
    )
    && hasForeignKey(
      db,
      "character_affect_observations_v6",
      "reset_id",
      "character_affect_resets_v6",
      "id",
      "SET NULL",
    );
}

function tableSql(db: DatabaseSync, tableName: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { sql?: unknown }
    | undefined;
  return typeof row?.sql === "string" ? row.sql : "";
}

function schemaObjectSql(db: DatabaseSync, type: "table" | "trigger" | "index", name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name) as
    | { sql?: unknown }
    | undefined;
  return typeof row?.sql === "string" ? row.sql : "";
}

function hasRequiredCheckConstraints(db: DatabaseSync): boolean {
  const sessionsSql = tableSql(db, "sessions_v6");
  const sessionRoleBindingsSql = tableSql(db, "session_role_bindings_v6");
  const auxiliarySessionsSql = tableSql(db, "auxiliary_sessions");
  const sessionTurnsSql = tableSql(db, "session_turns_v6");
  const sessionTurnInterimsSql = tableSql(db, "session_turn_interims_v6");
  const sessionTurnProviderOutputsSql = tableSql(db, "session_turn_provider_outputs_v6");
  const sessionExecutionPublicProgressSql = tableSql(db, "session_execution_public_progress_v6");
  const workItemsSql = tableSql(db, "work_items_v6");
  const workItemEventsSql = tableSql(db, "work_item_events_v6");
  const workItemIdempotencySql = tableSql(db, "work_item_idempotency_v6");
  const workItemAggregationDecisionSql = tableSql(db, "work_item_aggregation_decisions_v6");
  const workItemAggregationIdempotencySql = tableSql(db, "work_item_aggregation_idempotency_v6");
  const workItemDeleteTriggerSql = schemaObjectSql(db, "trigger", "trg_v6_work_items_protect_session_delete");
  const workItemDeleteCleanupTriggerSql = schemaObjectSql(
    db,
    "trigger",
    "trg_v6_work_items_cleanup_terminal_root_session_delete",
  );
  const rootWorkItemUniqueIndexSql = schemaObjectSql(db, "index", "idx_v6_work_items_one_root_per_session");
  const sessionTurnPublicContextSql = tableSql(db, "session_turn_public_context_v6");
  const sessionInteractionsSql = tableSql(db, "session_interactions_v6");
  const sessionInteractionIdempotencySql = tableSql(db, "session_interaction_idempotency_v6");
  const sessionTranscriptExportIdempotencySql = tableSql(db, "session_transcript_export_idempotency_v6");
  const memoryEntriesSql = tableSql(db, "memory_entries_v6");
  const mutationEventsSql = tableSql(db, "memory_mutation_events_v6");
  const idempotencySql = tableSql(db, "memory_idempotency_keys_v6");
  const protectedObjectsSql = tableSql(db, "memory_protected_objects_v6");
  const affectEventsSql = tableSql(db, "character_affect_events_v6");
  const affectResetsSql = tableSql(db, "character_affect_resets_v6");
  const affectIdempotencySql = tableSql(db, "character_affect_idempotency_v6");
  const affectMutationsSql = tableSql(db, "character_affect_mutations_v6");
  const affectObservationsSql = tableSql(db, "character_affect_observations_v6");

  return sessionsSql.includes("json_valid(character_snapshot_json)")
    && sessionRoleBindingsSql.includes("session_role IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')")
    && sessionRoleBindingsSql.includes("role_contract_revision = 1")
    && sessionRoleBindingsSql.includes("delegation_depth BETWEEN 0 AND 2")
    && memoryEntriesSql.includes("state IN ('active', 'superseded', 'forgotten')")
    && auxiliarySessionsSql.includes("status IN ('active', 'closed')")
    && sessionTurnsSql.includes("phase IN ('running', 'completed', 'failed', 'canceled')")
    && sessionTurnsSql.includes("session_id IS NOT NULL OR auxiliary_session_id IS NOT NULL")
    && sessionTurnsSql.includes("NOT (session_id IS NOT NULL AND auxiliary_session_id IS NOT NULL)")
    && sessionTurnInterimsSql.includes("source IN ('stream_delta', 'running_snapshot', 'migration')")
    && sessionTurnProviderOutputsSql.includes("json_valid(payload_json)")
    && sessionTurnProviderOutputsSql.includes("kind IN")
    && sessionExecutionPublicProgressSql.includes("truncated IN (0, 1)")
    && workItemsSql.includes("contract_revision = 2")
    && workItemsSql.includes("kind IN ('root', 'delegated')")
    && workItemsSql.includes("'partially_completed'")
    && workItemsSql.includes("length(CAST(result_json AS BLOB)) <= 262144")
    && workItemsSql.includes("root_session_id = creator_session_id")
    && workItemsSql.includes("creator_session_id = target_session_id")
    && workItemsSql.includes("kind = 'delegated' AND creator_session_id <> target_session_id")
    && workItemsSql.includes("json_type(blockers_json) = 'array'")
    && workItemsSql.includes("state IN ('completed', 'partially_completed', 'failed')")
    && workItemsSql.includes("json_extract(result_json, '$.outcome') IS state")
    && workItemEventsSql.includes("'migration_baseline'")
    && workItemEventsSql.includes(`WHEN 'migration_baseline' THEN ${WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES}`)
    && workItemEventsSql.includes("UNIQUE (work_item_id, revision)")
    && rootWorkItemUniqueIndexSql.includes("WHERE kind = 'root'")
    && workItemIdempotencySql.includes("'work.revise'")
    && workItemIdempotencySql.includes("'work.history.append'")
    && workItemIdempotencySql.includes(`length(CAST(response_json AS BLOB)) <= ${WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES}`)
    && workItemAggregationDecisionSql.includes("decision_type IN ('accepted', 'excluded', 'retry_requested')")
    && workItemAggregationDecisionSql.includes("replacement_work_item_id IS NOT NULL")
    && workItemAggregationIdempotencySql.includes("operation IN ('work.aggregation.decide', 'work.aggregation.retry')")
    && hasForeignKey(db, "work_item_aggregations_v6", "parent_work_item_id", "work_items_v6", "id")
    && hasForeignKey(db, "work_item_aggregation_decisions_v6", "parent_work_item_id", "work_items_v6", "id")
    && hasForeignKey(db, "work_item_aggregation_decisions_v6", "child_work_item_id", "work_items_v6", "id")
    && hasForeignKey(db, "work_item_aggregation_decisions_v6", "replacement_work_item_id", "work_items_v6", "id")
    && workItemDeleteTriggerSql.includes("WORK_ITEM_SESSION_PROTECTED")
    && workItemDeleteTriggerSql.includes("work_item_aggregation_decisions_v6")
    && workItemDeleteTriggerSql.includes("decision.child_revision = work_items_v6.revision")
    && workItemDeleteTriggerSql.includes("root_item.state IN ('completed', 'partially_completed', 'failed', 'canceled')")
    && !workItemDeleteTriggerSql.includes("work_item_execution_associations_v6")
    && workItemDeleteCleanupTriggerSql.includes("DELETE FROM work_items_v6")
    && workItemDeleteCleanupTriggerSql.includes("DELETE FROM work_item_aggregation_decisions_v6")
    && workItemDeleteCleanupTriggerSql.includes("creator_session_id = OLD.id")
    && sessionTurnPublicContextSql.includes("json_valid(effective_turn_json)")
    && sessionTurnPublicContextSql.includes("json_type(attachments_json) = 'array'")
    && sessionInteractionsSql.includes("state IN ('pending', 'answered', 'expired')")
    && sessionInteractionsSql.includes("'execution_canceled'")
    && sessionInteractionsSql.includes("'execution_terminal'")
    && sessionInteractionsSql.includes("length(CAST(public_payload_json AS BLOB)) <= 262144")
    && sessionInteractionsSql.includes("kind = 'approval' AND response_action IN ('approve', 'deny')")
    && sessionInteractionsSql.includes("kind = 'elicitation' AND response_action IN ('accept', 'decline', 'cancel')")
    && sessionInteractionIdempotencySql.includes("operation = 'interaction.respond'")
    && sessionTranscriptExportIdempotencySql.includes("operation = 'transcript.export'")
    && sessionTranscriptExportIdempotencySql.includes("state IN ('pending', 'applied', 'rejected')")
    && memoryEntriesSql.includes("ON DELETE RESTRICT")
    && mutationEventsSql.includes("result_status TEXT NOT NULL")
    && mutationEventsSql.includes("result_status IN")
    && idempotencySql.includes("binding_id_hash TEXT NOT NULL")
    && idempotencySql.includes("PRIMARY KEY (binding_id_hash, key, operation, owner_type, owner_id, scope_type, scope_id)")
    && protectedObjectsSql.includes("state IN ('active', 'delete_pending', 'deleted')")
    && protectedObjectsSql.includes("role IN ('evidence', 'source', 'snapshot', 'artifact', 'reference', 'other')")
    && protectedObjectsSql.includes("original_bytes >= 0")
    && protectedObjectsSql.includes("stored_bytes >= 0")
    && affectEventsSql.includes("layer IN ('relationship', 'session')")
    && affectEventsSql.includes("target_type IN ('user', 'relationship', 'task', 'bug', 'artifact', 'self')")
    && affectEventsSql.includes("family IS NULL OR family IN ('joy', 'relief', 'interest', 'anticipation', 'affinity', 'gratitude', 'concern', 'frustration', 'disappointment', 'regret', 'determination', 'other')")
    && affectEventsSql.includes("json_valid(value_json)")
    && affectEventsSql.includes("intensity >= 0 AND intensity <= 1")
    && affectEventsSql.includes("state IN ('active', 'corrected')")
    && affectEventsSql.includes("user_id <> ''")
    && affectEventsSql.includes("target_id <> ''")
    && affectEventsSql.includes("layer <> 'relationship' OR target_type IN ('user', 'relationship')")
    && affectEventsSql.includes("layer = 'session' AND session_id IS NOT NULL AND source_session_id = session_id")
    && affectEventsSql.includes("layer = 'relationship' AND session_id IS NULL")
    && affectResetsSql.includes("layer IN ('relationship', 'session')")
    && affectResetsSql.includes("layer = 'session' AND session_id IS NOT NULL")
    && affectResetsSql.includes("layer = 'relationship' AND session_id IS NULL")
    && affectIdempotencySql.includes("operation IN ('record', 'correct', 'reset')")
    && affectIdempotencySql.includes("PRIMARY KEY (character_id, user_id, idempotency_key)")
    && affectIdempotencySql.includes("operation IN ('record', 'correct') AND event_id IS NOT NULL AND reset_id IS NULL")
    && affectIdempotencySql.includes("operation = 'reset' AND event_id IS NULL AND reset_id IS NOT NULL")
    && affectMutationsSql.includes("operation IN ('record', 'reject', 'correct', 'reset', 'episode_candidate', 'link_episode')")
    && affectObservationsSql.includes("kind IN ('idempotency', 'concurrency')")
    && affectObservationsSql.includes("outcome IN ('replayed', 'rejected', 'resolved')");
}

export class ExistingSessionRoleBindingSchemaError extends Error {
  constructor(cause: unknown) {
    super("Session Role binding data is invalid in the existing V6 database.", { cause });
    this.name = "ExistingSessionRoleBindingSchemaError";
  }
}

function hasValidSessionRoleBindingData(db: DatabaseSync): boolean {
  if (!tableExists(db, "session_role_bindings_v6")) return false;
  const missingOrUnexpected = db.prepare(`
    SELECT 1
    FROM sessions_v6 AS s
    LEFT JOIN session_role_bindings_v6 AS b ON b.session_id = s.id
    WHERE ((s.session_kind <> 'character-authoring' OR s.session_kind IS NULL) AND b.session_id IS NULL)
       OR (s.session_kind = 'character-authoring' AND b.session_id IS NOT NULL)
    LIMIT 1
  `).get();
  if (missingOrUnexpected) return false;
  const orphanBinding = db.prepare(`
    SELECT 1
    FROM session_role_bindings_v6 AS b
    LEFT JOIN sessions_v6 AS s ON s.id = b.session_id
    WHERE s.id IS NULL
    LIMIT 1
  `).get();
  if (orphanBinding) return false;

  const invalidHierarchy = db.prepare(`
    SELECT 1
    FROM session_role_bindings_v6 AS b
    INNER JOIN sessions_v6 AS s ON s.id = b.session_id
    LEFT JOIN sessions_v6 AS root ON root.id = b.root_session_id
    LEFT JOIN sessions_v6 AS parent ON parent.id = b.parent_session_id
    LEFT JOIN session_role_bindings_v6 AS pb ON pb.session_id = b.parent_session_id
    WHERE b.session_role NOT IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')
       OR b.role_contract_revision <> 1
       OR b.delegation_depth NOT BETWEEN 0 AND 2
       OR root.id IS NULL
       OR s.session_kind = 'character-authoring'
       OR root.session_kind = 'character-authoring'
       OR (
         b.parent_session_id IS NULL
         AND NOT (
           b.session_role IN ('standalone', 'overall-coordinator')
           AND b.root_session_id = b.session_id
           AND b.delegation_depth = 0
         )
       )
       OR (
         b.parent_session_id IS NOT NULL
         AND (
           parent.id IS NULL
           OR parent.session_kind = 'character-authoring'
           OR pb.session_id IS NULL
           OR b.root_session_id <> pb.root_session_id
           OR b.delegation_depth <> pb.delegation_depth + 1
           OR (pb.session_role = 'overall-coordinator' AND b.session_role NOT IN ('task-coordinator', 'executor'))
           OR (pb.session_role = 'task-coordinator' AND b.session_role <> 'executor')
           OR pb.session_role IN ('standalone', 'executor')
         )
       )
    LIMIT 1
  `).get();
  return !invalidHierarchy;
}

function hasValidSessionRoleBindingSchemaAndData(db: DatabaseSync): boolean {
  const expectedColumns = REQUIRED_V6_TABLE_COLUMNS.session_role_bindings_v6;
  const columns = tableColumnNames(db, "session_role_bindings_v6");
  const sessionRoleBindingsSql = tableSql(db, "session_role_bindings_v6");
  return expectedColumns.every((column) => columns.has(column))
    && hasForeignKey(db, "session_role_bindings_v6", "session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_role_bindings_v6", "root_session_id", "sessions_v6", "id", "RESTRICT")
    && hasForeignKey(db, "session_role_bindings_v6", "parent_session_id", "sessions_v6", "id", "RESTRICT")
    && sessionRoleBindingsSql.includes(
      "session_role IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')",
    )
    && sessionRoleBindingsSql.includes("role_contract_revision = 1")
    && sessionRoleBindingsSql.includes("delegation_depth BETWEEN 0 AND 2")
    && hasValidSessionRoleBindingData(db);
}

function hasValidScheduleSchemaIfPresent(db: DatabaseSync): boolean {
  const hasSchedules = tableExists(db, "session_schedules_v6");
  const hasFires = tableExists(db, "session_schedule_fires_v6");
  if (!hasSchedules && !hasFires) return true;
  if (!hasSchedules || !hasFires) return false;

  const expectedColumns = {
    session_schedules_v6: [
      "id", "session_id", "revision", "name", "trigger_type", "time_zone",
      "cron_expression", "once_local_datetime", "turn_json", "state",
      "next_fire_at", "created_at", "updated_at",
    ],
    session_schedule_fires_v6: [
      "id", "schedule_id", "session_id", "schedule_revision", "trigger_type",
      "logical_fire_at", "kind", "state", "idempotency_key", "turn_json",
      "execution_id", "error_code", "error_message", "claimed_at", "created_at", "updated_at",
    ],
  } as const;
  for (const [tableName, columns] of Object.entries(expectedColumns)) {
    const existing = tableColumnNames(db, tableName);
    if (!columns.every((column) => existing.has(column))) return false;
  }

  const indexes = new Set(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{ name?: unknown }>)
      .map((index) => index.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (![
    "idx_v6_session_schedules_session",
    "idx_v6_session_schedule_fires_logical",
    "idx_v6_session_schedule_fires_due",
    "idx_v6_session_schedule_fires_schedule",
  ].every((indexName) => indexes.has(indexName))) return false;

  const scheduleSql = tableSql(db, "session_schedules_v6");
  const fireSql = tableSql(db, "session_schedule_fires_v6");
  return hasForeignKey(db, "session_schedules_v6", "session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_schedule_fires_v6", "schedule_id", "session_schedules_v6", "id", "CASCADE")
    && hasForeignKey(db, "session_schedule_fires_v6", "session_id", "sessions_v6", "id", "CASCADE")
    && scheduleSql.includes("trigger_type IN ('once', 'cron')")
    && scheduleSql.includes("state IN ('active', 'paused', 'completed', 'deleted')")
    && scheduleSql.includes("json_valid(turn_json)")
    && fireSql.includes("kind IN ('scheduled', 'run_now')")
    && fireSql.includes("state IN ('pending', 'claimed', 'enqueued', 'failed')")
    && fireSql.includes("json_valid(turn_json)");
}

function hasValidTerminalFailureNotificationSchemaIfPresent(db: DatabaseSync): boolean {
  const tableName = "session_terminal_failure_notification_deliveries_v6";
  if (!tableExists(db, tableName)) return true;
  const columns = tableColumnNames(db, tableName);
  if (![
    "id", "source_execution_id", "source_session_id", "terminal_state",
    "target_session_id", "contract_version", "state", "enqueue_idempotency_key",
    "notification_execution_id", "error_code", "error_message", "attempt_count",
    "last_attempt_at", "next_attempt_at", "deadline_at", "claim_token", "claimed_at",
    "created_at", "updated_at",
  ].every((column) => columns.has(column))) return false;
  const indexes = new Set(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{ name?: unknown }>)
      .map((index) => index.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const sql = tableSql(db, tableName);
  const normalizedSql = sql.replace(/\s+/g, " ").toLowerCase();
  return indexes.has("idx_v6_terminal_failure_notification_due")
    && indexes.has("idx_v6_terminal_failure_notification_source")
    && hasUniqueIndexForColumns(db, tableName, ["source_execution_id"])
    && hasUniqueIndexForColumns(db, tableName, ["enqueue_idempotency_key"])
    && hasForeignKey(db, tableName, "source_execution_id", "session_executions_v6", "id", "CASCADE")
    && sql.includes("terminal_state IN ('failed', 'interrupted')")
    && sql.includes("state IN ('pending', 'enqueued', 'failed')")
    && normalizedSql.includes("check ((claim_token is null) = (claimed_at is null))")
    && normalizedSql.includes("state = 'pending' and notification_execution_id is null and error_code is null")
    && normalizedSql.includes("state = 'enqueued' and notification_execution_id is not null and error_code is null and claim_token is null")
    && normalizedSql.includes("state = 'failed' and notification_execution_id is null and error_code is not null and claim_token is null");
}

function hasUniqueIndexForColumns(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const indexes = db.prepare(`SELECT name, "unique" AS is_unique FROM pragma_index_list(?)`)
    .all(tableName) as Array<{ name?: unknown; is_unique?: unknown }>;
  return indexes.some((index) => {
    if (index.is_unique !== 1 || typeof index.name !== "string") return false;
    const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno ASC")
      .all(index.name) as Array<{ name?: unknown }>;
    return columns.length === expectedColumns.length
      && columns.every((column, position) => column.name === expectedColumns[position]);
  });
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
    is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
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

export const CREATE_V6_SESSION_ROLE_BINDINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_role_bindings_v6 (
    session_id TEXT PRIMARY KEY,
    session_role TEXT NOT NULL CHECK (session_role IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')),
    role_contract_revision INTEGER NOT NULL CHECK (role_contract_revision = 1),
    root_session_id TEXT NOT NULL,
    parent_session_id TEXT,
    delegation_depth INTEGER NOT NULL CHECK (delegation_depth BETWEEN 0 AND 2),
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (root_session_id) REFERENCES sessions_v6(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions_v6(id) ON DELETE RESTRICT,
    CHECK (
      (
        session_role IN ('standalone', 'overall-coordinator')
        AND parent_session_id IS NULL
        AND root_session_id = session_id
        AND delegation_depth = 0
      )
      OR (
        session_role = 'task-coordinator'
        AND parent_session_id IS NOT NULL
        AND parent_session_id <> session_id
        AND root_session_id <> session_id
        AND delegation_depth = 1
      )
      OR (
        session_role = 'executor'
        AND parent_session_id IS NOT NULL
        AND parent_session_id <> session_id
        AND root_session_id <> session_id
        AND delegation_depth BETWEEN 1 AND 2
      )
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_role_bindings_parent
    ON session_role_bindings_v6(parent_session_id, session_id);
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
    summary TEXT NOT NULL DEFAULT '',
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

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_turns_id_session
    ON session_turns_v6(id, session_id);
`;

export const CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_turn_interims_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    body TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('stream_delta', 'running_snapshot', 'migration')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (turn_id) REFERENCES session_turns_v6(id) ON DELETE CASCADE,
    UNIQUE (turn_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_turn_interims_turn_seq
    ON session_turn_interims_v6(turn_id, seq);
`;

export const CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_turn_provider_outputs_v6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    provider_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN (
      'operation',
      'raw_items',
      'usage',
      'logical_prompt',
      'transport_payload',
      'provider_error',
      'legacy_assistant_text',
      'quota',
      'context_telemetry',
      'background_task',
      'provider_metadata'
    )),
    summary TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    payload_blob_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (turn_id) REFERENCES session_turns_v6(id) ON DELETE CASCADE,
    UNIQUE (turn_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_turn_provider_outputs_turn_kind_seq
    ON session_turn_provider_outputs_v6(turn_id, kind, seq);
`;

export const CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_crud_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN ('session.create', 'session.rename')),
    principal_session_id TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, principal_session_id, idempotency_key),
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_crud_idempotency_expires
    ON session_crud_idempotency_v6(expires_at);
`;

export const CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_file_write_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation = 'session.files.write_text'),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    temp_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
    output_sha256 TEXT,
    byte_length INTEGER,
    file_device TEXT,
    file_inode TEXT,
    target_precondition_json TEXT CHECK (target_precondition_json IS NULL OR json_valid(target_precondition_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK (
      (output_sha256 IS NULL AND byte_length IS NULL AND file_device IS NULL AND file_inode IS NULL AND target_precondition_json IS NULL)
      OR (
        output_sha256 IS NOT NULL
        AND byte_length IS NOT NULL AND byte_length >= 0
        AND file_device IS NOT NULL
        AND file_inode IS NOT NULL
        AND (state <> 'pending' OR target_precondition_json IS NOT NULL)
      )
    ),
    PRIMARY KEY (operation, idempotency_key),
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_file_write_idempotency_expires
    ON session_file_write_idempotency_v6(state, expires_at);
`;

export const CREATE_V6_SESSION_EXECUTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_executions_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('turn.run', 'turn.enqueue')),
    state TEXT NOT NULL CHECK (state IN (
      'queued',
      'running',
      'completed',
      'failed',
      'canceled',
      'interrupted'
    )),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_code TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    admitted_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_executions_session_sequence
    ON session_executions_v6(session_id, sequence ASC);

  CREATE INDEX IF NOT EXISTS idx_v6_session_executions_session_state_sequence
    ON session_executions_v6(session_id, state, sequence ASC);

  CREATE INDEX IF NOT EXISTS idx_v6_session_executions_terminal_notification_sequence
    ON session_executions_v6(sequence ASC)
    WHERE state IN ('failed', 'interrupted')
      AND json_type(request_json, '$.terminalFailureNotification.targetSessionId') = 'text';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_executions_one_running
    ON session_executions_v6(session_id)
    WHERE state = 'running';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_executions_id_session
    ON session_executions_v6(id, session_id);
`;

export const CREATE_V6_WORK_ITEM_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS work_items_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('root', 'delegated')),
    contract_revision INTEGER NOT NULL CHECK (contract_revision = 2),
    root_session_id TEXT NOT NULL,
    creator_session_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    parent_work_item_id TEXT,
    goal TEXT NOT NULL,
    scope TEXT NOT NULL,
    completion_criteria TEXT NOT NULL,
    authority TEXT NOT NULL,
    source_identity_json TEXT NOT NULL CHECK (json_valid(source_identity_json)),
    state TEXT NOT NULL CHECK (state IN (
      'pending', 'in_progress', 'waiting', 'completed',
      'partially_completed', 'failed', 'canceled'
    )),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    progress_summary TEXT NOT NULL DEFAULT '',
    blockers_json TEXT NOT NULL DEFAULT '[]' CHECK (
      json_valid(blockers_json) AND json_type(blockers_json) = 'array'
    ),
    next_action TEXT NOT NULL DEFAULT '',
    result_json TEXT CHECK (
      result_json IS NULL
      OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 262144)
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_work_item_id) REFERENCES work_items_v6(id),
    CHECK (
      (
        kind = 'root'
        AND root_session_id = creator_session_id
        AND creator_session_id = target_session_id
        AND parent_work_item_id IS NULL
      )
      OR (kind = 'delegated' AND creator_session_id <> target_session_id)
    ),
    CHECK (
      kind = 'root'
      OR (
        length(trim(goal)) > 0
        AND length(trim(scope)) > 0
        AND length(trim(completion_criteria)) > 0
        AND length(trim(authority)) > 0
      )
    ),
    CHECK (
      kind = 'root'
      OR (
        progress_summary = ''
        AND blockers_json = '[]'
        AND next_action = ''
      )
    ),
    CHECK (
      (
        state IN ('completed', 'partially_completed', 'failed')
        AND result_json IS NOT NULL
        AND CASE
          WHEN json_valid(result_json)
          THEN json_extract(result_json, '$.outcome') IS state
          ELSE 0
        END
      )
      OR (state NOT IN ('completed', 'partially_completed', 'failed') AND result_json IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_work_items_root_sequence
    ON work_items_v6(root_session_id, sequence ASC);
  CREATE INDEX IF NOT EXISTS idx_v6_work_items_creator_sequence
    ON work_items_v6(creator_session_id, sequence ASC);
  CREATE INDEX IF NOT EXISTS idx_v6_work_items_target_sequence
    ON work_items_v6(target_session_id, sequence ASC);
  CREATE INDEX IF NOT EXISTS idx_v6_work_items_parent
    ON work_items_v6(parent_work_item_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_work_items_one_root_per_session
    ON work_items_v6(root_session_id)
    WHERE kind = 'root';

  CREATE TABLE IF NOT EXISTS work_item_events_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'created', 'migration_baseline', 'contract_revised', 'progress',
      'handoff', 'state_transitioned', 'result_reported'
    )),
    actor_session_id TEXT,
    payload_json TEXT NOT NULL CHECK (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND length(CAST(payload_json AS BLOB)) <= CASE event_type
        WHEN 'migration_baseline' THEN ${WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES}
        ELSE ${WORK_ITEM_MAX_EVENT_PAYLOAD_BYTES}
      END
    ),
    created_at TEXT NOT NULL,
    UNIQUE (work_item_id, revision),
    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_v6_work_item_events_item_sequence
    ON work_item_events_v6(work_item_id, sequence ASC);

  CREATE TABLE IF NOT EXISTS work_item_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN (
      'work.create', 'work.revise', 'work.history.append',
      'work.transition', 'work.result', 'work.cancel'
    )),
    principal_session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    response_json TEXT CHECK (
      response_json IS NULL
      OR (json_valid(response_json) AND length(CAST(response_json AS BLOB)) <= ${WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES})
    ),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, principal_session_id, idempotency_key),
    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_v6_work_item_idempotency_item
    ON work_item_idempotency_v6(work_item_id);
  CREATE INDEX IF NOT EXISTS idx_v6_work_item_idempotency_expiry
    ON work_item_idempotency_v6(expires_at);

  CREATE TABLE IF NOT EXISTS work_item_execution_associations_v6 (
    execution_id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (work_item_id) REFERENCES work_items_v6(id)
  );
  CREATE INDEX IF NOT EXISTS idx_v6_work_item_execution_item
    ON work_item_execution_associations_v6(work_item_id, execution_id);

  CREATE TABLE IF NOT EXISTS work_item_aggregations_v6 (
    parent_work_item_id TEXT PRIMARY KEY,
    aggregate_revision INTEGER NOT NULL CHECK (aggregate_revision >= 1),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (parent_work_item_id) REFERENCES work_items_v6(id)
  );

  CREATE TABLE IF NOT EXISTS work_item_aggregation_decisions_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_work_item_id TEXT NOT NULL,
    child_work_item_id TEXT NOT NULL UNIQUE,
    decision_revision INTEGER NOT NULL CHECK (decision_revision >= 1),
    child_revision INTEGER NOT NULL CHECK (child_revision >= 1),
    actor_session_id TEXT NOT NULL,
    decision_type TEXT NOT NULL CHECK (decision_type IN ('accepted', 'excluded', 'retry_requested')),
    reason TEXT,
    replacement_work_item_id TEXT UNIQUE,
    decided_at TEXT NOT NULL,
    FOREIGN KEY (parent_work_item_id) REFERENCES work_items_v6(id),
    FOREIGN KEY (child_work_item_id) REFERENCES work_items_v6(id),
    FOREIGN KEY (replacement_work_item_id) REFERENCES work_items_v6(id),
    CHECK (decision_type <> 'excluded' OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
    CHECK ((decision_type = 'retry_requested') = (replacement_work_item_id IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_v6_work_item_aggregation_decisions_parent_sequence
    ON work_item_aggregation_decisions_v6(parent_work_item_id, sequence ASC);

  CREATE TABLE IF NOT EXISTS work_item_aggregation_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN ('work.aggregation.decide', 'work.aggregation.retry')),
    principal_session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    child_work_item_id TEXT NOT NULL,
    replacement_work_item_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, principal_session_id, idempotency_key),
    FOREIGN KEY (child_work_item_id) REFERENCES work_items_v6(id),
    FOREIGN KEY (replacement_work_item_id) REFERENCES work_items_v6(id)
  );
  CREATE INDEX IF NOT EXISTS idx_v6_work_item_aggregation_idempotency_expiry
    ON work_item_aggregation_idempotency_v6(expires_at);

  CREATE TRIGGER IF NOT EXISTS trg_v6_work_items_protect_session_delete
  BEFORE DELETE ON sessions_v6
  WHEN EXISTS (
    SELECT 1 FROM work_items_v6
    WHERE (
      root_session_id = OLD.id
      OR creator_session_id = OLD.id
      OR target_session_id = OLD.id
    )
      AND (
        state IN ('pending', 'in_progress', 'waiting')
        OR (
          kind = 'delegated'
          AND parent_work_item_id IS NULL
          AND state <> 'canceled'
          AND (
            result_json IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM work_items_v6 AS root_item
              WHERE root_item.kind = 'root'
                AND root_item.root_session_id = work_items_v6.root_session_id
                AND root_item.state IN ('completed', 'partially_completed', 'failed', 'canceled')
            )
          )
        )
        OR (
          kind = 'delegated'
          AND parent_work_item_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM work_item_aggregation_decisions_v6 AS decision
            WHERE decision.child_work_item_id = work_items_v6.id
              AND decision.child_revision = work_items_v6.revision
          )
        )
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'WORK_ITEM_SESSION_PROTECTED');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_v6_work_items_cleanup_terminal_root_session_delete
  AFTER DELETE ON sessions_v6
  BEGIN
    DELETE FROM work_item_execution_associations_v6
    WHERE work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    );
    DELETE FROM work_item_aggregation_idempotency_v6
    WHERE child_work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    ) OR replacement_work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    );
    DELETE FROM work_item_aggregation_decisions_v6
    WHERE parent_work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    ) OR child_work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    ) OR replacement_work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    );
    DELETE FROM work_item_aggregations_v6
    WHERE parent_work_item_id IN (
      SELECT id FROM work_items_v6
      WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
        AND state IN ('completed', 'partially_completed', 'failed', 'canceled')
    );
    DELETE FROM work_items_v6
    WHERE (root_session_id = OLD.id OR creator_session_id = OLD.id OR target_session_id = OLD.id)
      AND state IN ('completed', 'partially_completed', 'failed', 'canceled');
  END;
`;

export const CREATE_V6_SESSION_EXECUTION_ORIGINS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_execution_origins_v6 (
    execution_id TEXT PRIMARY KEY,
    execution_sequence INTEGER NOT NULL UNIQUE,
    source_session_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('turn.run', 'turn.enqueue')),
    target_session_title_snapshot TEXT NOT NULL,
    target_session_role_snapshot TEXT NOT NULL CHECK (
      target_session_role_snapshot IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')
    ),
    source_message_seq_anchor INTEGER NOT NULL CHECK (source_message_seq_anchor >= -1),
    user_message TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    CHECK (source_session_id <> target_session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_execution_origins_source_sequence
    ON session_execution_origins_v6(source_session_id, execution_sequence ASC);
`;

export const CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_execution_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN ('turn.run', 'turn.enqueue', 'turn.cancel')),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, idempotency_key),
    FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_execution_idempotency_execution
    ON session_execution_idempotency_v6(execution_id);

  CREATE INDEX IF NOT EXISTS idx_v6_session_execution_idempotency_expires
    ON session_execution_idempotency_v6(expires_at);
`;

export const CREATE_V6_SESSION_EXECUTION_PUBLIC_PROGRESS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_execution_public_progress_v6 (
    execution_id TEXT PRIMARY KEY,
    assistant_text TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_execution_public_progress_updated
    ON session_execution_public_progress_v6(updated_at);
`;

export const CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_turn_public_context_v6 (
    turn_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    execution_id TEXT NOT NULL UNIQUE,
    effective_turn_json TEXT NOT NULL CHECK (json_valid(effective_turn_json)),
    attachments_json TEXT NOT NULL
      CHECK (json_valid(attachments_json))
      CHECK (json_type(attachments_json) = 'array'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (turn_id, session_id) REFERENCES session_turns_v6(id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id, session_id) REFERENCES session_executions_v6(id, session_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_turn_public_context_execution
    ON session_turn_public_context_v6(session_id, execution_id);
`;

export const CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_interactions_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    execution_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'elicitation')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'expired')),
    public_payload_json TEXT NOT NULL
      CHECK (json_valid(public_payload_json))
      CHECK (length(CAST(public_payload_json AS BLOB)) <= 262144),
    response_action TEXT CHECK (response_action IS NULL OR response_action IN (
      'approve',
      'deny',
      'accept',
      'decline',
      'cancel'
    )),
    response_submitted_fields_json TEXT
      CHECK (response_submitted_fields_json IS NULL OR json_valid(response_submitted_fields_json)),
    response_fingerprint TEXT,
    expiry_reason TEXT CHECK (expiry_reason IS NULL OR expiry_reason IN (
      'runtime_restarted',
      'runtime_shutdown',
      'execution_canceled',
      'execution_terminal'
    )),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE,
    CHECK (
      (state = 'pending'
        AND response_action IS NULL
        AND response_submitted_fields_json IS NULL
        AND response_fingerprint IS NULL
        AND expiry_reason IS NULL
        AND resolved_at IS NULL)
      OR
      (state = 'answered'
        AND response_action IS NOT NULL
        AND response_submitted_fields_json IS NOT NULL
        AND response_fingerprint IS NOT NULL
        AND expiry_reason IS NULL
        AND resolved_at IS NOT NULL
        AND (
          (kind = 'approval' AND response_action IN ('approve', 'deny'))
          OR
          (kind = 'elicitation' AND response_action IN ('accept', 'decline', 'cancel'))
        ))
      OR
      (state = 'expired'
        AND response_action IS NULL
        AND response_submitted_fields_json IS NULL
        AND response_fingerprint IS NULL
        AND expiry_reason IS NOT NULL
        AND resolved_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_interactions_execution_sequence
    ON session_interactions_v6(execution_id, sequence ASC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_interactions_one_pending
    ON session_interactions_v6(execution_id)
    WHERE state = 'pending';
`;

export const CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_interaction_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation = 'interaction.respond'),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, idempotency_key),
    FOREIGN KEY (interaction_id) REFERENCES session_interactions_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_interaction_idempotency_interaction
    ON session_interaction_idempotency_v6(interaction_id);

  CREATE INDEX IF NOT EXISTS idx_v6_session_interaction_idempotency_expires
    ON session_interaction_idempotency_v6(expires_at);
`;

export const CREATE_V6_COORDINATION_EVENT_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_events_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    actor_session_id TEXT NOT NULL,
    session_role TEXT NOT NULL CHECK (session_role IN ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')),
    role_contract_revision INTEGER NOT NULL CHECK (role_contract_revision = 1),
    root_session_id TEXT NOT NULL,
    parent_session_id TEXT,
    delegation_depth INTEGER NOT NULL CHECK (delegation_depth BETWEEN 0 AND 2),
    kind TEXT NOT NULL CHECK (kind IN ('progress', 'decision', 'escalation', 'user_decision_required', 'blocker', 'result', 'correction')),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 240),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)) CHECK (length(CAST(payload_json AS BLOB)) <= 16384),
    execution_id TEXT,
    target_session_id TEXT,
    corrected_event_id TEXT,
    options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)) CHECK (json_type(options_json) = 'array'),
    created_at TEXT NOT NULL,
    FOREIGN KEY (actor_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (root_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (target_session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (corrected_event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE,
    CHECK ((kind = 'escalation') = (target_session_id IS NOT NULL)),
    CHECK ((kind = 'correction') = (corrected_event_id IS NOT NULL)),
    CHECK (
      (kind = 'user_decision_required' AND json_array_length(options_json) BETWEEN 2 AND 8)
      OR (kind <> 'user_decision_required' AND options_json = '[]')
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_coordination_events_actor_sequence
    ON coordination_events_v6(actor_session_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_v6_coordination_events_root_sequence
    ON coordination_events_v6(root_session_id, sequence DESC);
  CREATE INDEX IF NOT EXISTS idx_v6_coordination_events_target
    ON coordination_events_v6(target_session_id, sequence DESC);

  CREATE TABLE IF NOT EXISTS coordination_event_actions_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK (action_type IN ('responded', 'resolved', 'cancelled', 'superseded', 'consumed')),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('session', 'trusted_gui')),
    actor_session_id TEXT,
    option_id TEXT,
    note TEXT CHECK (note IS NULL OR length(note) <= 1000),
    related_event_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (related_event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE,
    CHECK (actor_type = 'session' OR actor_session_id IS NULL),
    CHECK ((action_type = 'superseded') = (related_event_id IS NOT NULL)),
    CHECK (
      action_type <> 'consumed'
      OR (
        actor_type = 'session'
        AND actor_session_id IS NOT NULL
        AND option_id IS NULL
        AND note IS NULL
        AND related_event_id IS NULL
      )
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_coordination_event_actions_event_sequence
    ON coordination_event_actions_v6(event_id, sequence ASC);

  CREATE TABLE IF NOT EXISTS coordination_event_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation IN ('coordination.event.create', 'coordination.event.resolve', 'coordination.event.consume', 'coordination.event.cancel', 'coordination.event.correct')),
    principal_session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    result_event_id TEXT NOT NULL,
    target_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (principal_session_id, idempotency_key),
    FOREIGN KEY (result_event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (target_event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_v6_coordination_event_idempotency_event
    ON coordination_event_idempotency_v6(result_event_id, target_event_id);
`;

export const CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_transcript_export_idempotency_v6 (
    operation TEXT NOT NULL CHECK (operation = 'transcript.export'),
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    session_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    temp_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
    output_sha256 TEXT CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
    byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
    output_device TEXT,
    output_inode TEXT,
    target_precondition_json TEXT CHECK (target_precondition_json IS NULL OR json_valid(target_precondition_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (operation, idempotency_key),
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    CHECK ((output_sha256 IS NULL) = (byte_length IS NULL)),
    CHECK ((output_device IS NULL) = (output_inode IS NULL)),
    CHECK (state <> 'pending' OR output_sha256 IS NULL OR output_device IS NOT NULL),
    CHECK (
      (state = 'pending' AND result_json IS NULL)
      OR
      (state = 'applied' AND result_json IS NOT NULL AND output_sha256 IS NOT NULL)
      OR
      (state = 'rejected' AND result_json IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_session_transcript_export_idempotency_expires
    ON session_transcript_export_idempotency_v6(state, expires_at);
`;

function ensureSessionExecutionIdempotencyOperations(db: DatabaseSync): void {
  if (tableSql(db, "session_execution_idempotency_v6").includes("'turn.cancel'")) {
    return;
  }
  db.exec(`
    ALTER TABLE session_execution_idempotency_v6
      RENAME TO session_execution_idempotency_v6_legacy;
  `);
  db.exec(CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL);
  db.exec(`
    INSERT INTO session_execution_idempotency_v6 (
      operation,
      idempotency_key,
      request_fingerprint,
      execution_id,
      created_at,
      expires_at
    )
    SELECT
      operation,
      idempotency_key,
      request_fingerprint,
      execution_id,
      created_at,
      expires_at
    FROM session_execution_idempotency_v6_legacy;

    DROP TABLE session_execution_idempotency_v6_legacy;
  `);
  db.exec(CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL);
}

function ensureSessionInteractionExpiryReasons(db: DatabaseSync): void {
  if (
    !tableExists(db, "session_interactions_v6")
    || tableSql(db, "session_interactions_v6").includes("'execution_terminal'")
  ) {
    return;
  }
  const hasIdempotency = tableExists(db, "session_interaction_idempotency_v6");
  if (hasIdempotency) {
    db.exec(`
      ALTER TABLE session_interaction_idempotency_v6
        RENAME TO session_interaction_idempotency_v6_legacy;
      DROP INDEX IF EXISTS idx_v6_session_interaction_idempotency_interaction;
      DROP INDEX IF EXISTS idx_v6_session_interaction_idempotency_expires;
    `);
  }
  db.exec(`
    ALTER TABLE session_interactions_v6
      RENAME TO session_interactions_v6_legacy;
    DROP INDEX IF EXISTS idx_v6_session_interactions_execution_sequence;
    DROP INDEX IF EXISTS idx_v6_session_interactions_one_pending;
  `);
  db.exec(CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL);
  db.exec(`
    INSERT INTO session_interactions_v6 (
      sequence, id, execution_id, kind, state, public_payload_json,
      response_action, response_submitted_fields_json, response_fingerprint,
      expiry_reason, created_at, resolved_at, updated_at
    )
    SELECT
      sequence, id, execution_id, kind, state, public_payload_json,
      response_action, response_submitted_fields_json, response_fingerprint,
      expiry_reason, created_at, resolved_at, updated_at
    FROM session_interactions_v6_legacy;
  `);
  if (hasIdempotency) {
    db.exec(CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL);
    db.exec(`
      INSERT INTO session_interaction_idempotency_v6 (
        operation, idempotency_key, request_fingerprint, interaction_id, created_at, expires_at
      )
      SELECT
        operation, idempotency_key, request_fingerprint, interaction_id, created_at, expires_at
      FROM session_interaction_idempotency_v6_legacy;
      DROP TABLE session_interaction_idempotency_v6_legacy;
    `);
  }
  db.exec("DROP TABLE session_interactions_v6_legacy;");
}

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

export const CREATE_V6_MEMORY_TARGET_TAG_STATS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_target_tag_stats_v6 (
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    tag_type TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    tag_type_canonical TEXT NOT NULL,
    tag_value_canonical TEXT NOT NULL,
    usage_count INTEGER NOT NULL CHECK (usage_count > 0),
    latest_entry_updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_type, owner_id, scope_type, scope_id, tag_type_canonical, tag_value_canonical)
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_target_tag_stats_page
    ON memory_target_tag_stats_v6(
      owner_type,
      owner_id,
      scope_type,
      scope_id,
      usage_count DESC,
      latest_entry_updated_at DESC,
      tag_type_canonical ASC,
      tag_value_canonical ASC
    );
`;

export const CREATE_V6_MEMORY_MUTATION_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_mutation_events_v6 (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('append', 'forget', 'supersede')),
    entry_id TEXT,
    binding_id_hash TEXT,
    session_id TEXT,
    source_message_id TEXT,
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
    cleanup_pending_count INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending_count >= 0),
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

export const CREATE_V6_MEMORY_PROTECTED_OBJECTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_protected_objects_v6 (
    object_id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'delete_pending', 'deleted')),
    role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('evidence', 'source', 'snapshot', 'artifact', 'reference', 'other')),
    media_kind TEXT NOT NULL DEFAULT 'other',
    content_type TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL,
    original_bytes INTEGER NOT NULL CHECK (original_bytes >= 0),
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    sha256 TEXT NOT NULL DEFAULT '',
    key_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE,
    CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_v6_memory_protected_objects_state
    ON memory_protected_objects_v6(state, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_v6_memory_protected_objects_entry
    ON memory_protected_objects_v6(entry_id, state);
`;

export const CREATE_V6_MEMORY_MOVE_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_move_events_v6 (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    from_owner_type TEXT NOT NULL,
    from_owner_id TEXT NOT NULL,
    from_scope_type TEXT NOT NULL,
    from_scope_id TEXT NOT NULL,
    to_owner_type TEXT NOT NULL,
    to_owner_id TEXT NOT NULL,
    to_scope_type TEXT NOT NULL,
    to_scope_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    binding_id_hash TEXT NOT NULL,
    idempotency_key TEXT,
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES memory_entries_v6(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_memory_move_events_idempotency
    ON memory_move_events_v6(binding_id_hash, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_v6_memory_move_events_entry
    ON memory_move_events_v6(entry_id, created_at DESC);
`;

export const CREATE_V6_CHARACTER_AFFECT_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS character_affect_events_v6 (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_session_id TEXT,
    layer TEXT NOT NULL CHECK (layer IN ('relationship', 'session')),
    target_type TEXT NOT NULL CHECK (target_type IN ('user', 'relationship', 'task', 'bug', 'artifact', 'self')),
    target_id TEXT NOT NULL,
    family TEXT CHECK (family IS NULL OR family IN ('joy', 'relief', 'interest', 'anticipation', 'affinity', 'gratitude', 'concern', 'frustration', 'disappointment', 'regret', 'determination', 'other')),
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    intensity REAL NOT NULL CHECK (intensity >= 0 AND intensity <= 1),
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    correction_of_event_id TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'corrected')),
    memory_entry_id TEXT,
    supersedes_memory_entry_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (correction_of_event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (memory_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (supersedes_memory_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    UNIQUE (character_id, user_id, idempotency_key),
    CHECK (user_id <> ''),
    CHECK (target_id <> ''),
    CHECK (layer <> 'relationship' OR target_type IN ('user', 'relationship')),
    CHECK (
      (layer = 'session' AND session_id IS NOT NULL AND source_session_id = session_id)
      OR (layer = 'relationship' AND session_id IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_effective
    ON character_affect_events_v6(character_id, user_id, layer, session_id, state, occurred_at, id);

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_afterglow
    ON character_affect_events_v6(character_id, user_id, layer, state, occurred_at DESC, id ASC, session_id);

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_target
    ON character_affect_events_v6(character_id, user_id, target_type, target_id, occurred_at, id);

  CREATE TABLE IF NOT EXISTS character_affect_resets_v6 (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    layer TEXT NOT NULL CHECK (layer IN ('relationship', 'session')),
    reason TEXT NOT NULL,
    reset_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    UNIQUE (character_id, user_id, idempotency_key),
    CHECK ((layer = 'session' AND session_id IS NOT NULL) OR (layer = 'relationship' AND session_id IS NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_resets_scope
    ON character_affect_resets_v6(character_id, user_id, layer, session_id, reset_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS character_affect_idempotency_v6 (
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('record', 'correct', 'reset')),
    request_fingerprint TEXT NOT NULL,
    event_id TEXT,
    reset_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (character_id, user_id, idempotency_key),
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE CASCADE,
    CHECK (
      (operation IN ('record', 'correct') AND event_id IS NOT NULL AND reset_id IS NULL)
      OR (operation = 'reset' AND event_id IS NULL AND reset_id IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS character_affect_mutations_v6 (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('record', 'reject', 'correct', 'reset', 'episode_candidate', 'link_episode')),
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_session_id TEXT,
    event_id TEXT,
    reset_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_mutations_scope
    ON character_affect_mutations_v6(character_id, user_id, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS character_affect_observations_v6 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('idempotency', 'concurrency')),
    outcome TEXT NOT NULL CHECK (outcome IN ('replayed', 'rejected', 'resolved')),
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    event_id TEXT,
    reset_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_observations_scope
    ON character_affect_observations_v6(character_id, user_id, created_at DESC, id DESC);
`;

export const CREATE_V6_SESSION_SCHEDULES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_schedules_v6 (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK (trigger_type IN ('once', 'cron')),
    time_zone TEXT NOT NULL,
    cron_expression TEXT,
    once_local_datetime TEXT,
    turn_json TEXT NOT NULL CHECK (json_valid(turn_json)),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'deleted')),
    next_fire_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    CHECK ((trigger_type = 'cron' AND cron_expression IS NOT NULL AND once_local_datetime IS NULL) OR (trigger_type = 'once' AND cron_expression IS NULL AND once_local_datetime IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_v6_session_schedules_session ON session_schedules_v6(session_id, updated_at DESC);
`;

export const CREATE_V6_SESSION_SCHEDULE_FIRES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_schedule_fires_v6 (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    schedule_revision INTEGER NOT NULL CHECK (schedule_revision >= 1),
    trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK (trigger_type IN ('once', 'cron')),
    logical_fire_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'run_now')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'enqueued', 'failed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    turn_json TEXT NOT NULL CHECK (json_valid(turn_json)),
    execution_id TEXT,
    error_code TEXT,
    error_message TEXT,
    claimed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (schedule_id) REFERENCES session_schedules_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_session_schedule_fires_logical
    ON session_schedule_fires_v6(schedule_id, schedule_revision, logical_fire_at)
    WHERE kind = 'scheduled';
  CREATE INDEX IF NOT EXISTS idx_v6_session_schedule_fires_due ON session_schedule_fires_v6(state, logical_fire_at);
  CREATE INDEX IF NOT EXISTS idx_v6_session_schedule_fires_schedule ON session_schedule_fires_v6(schedule_id, created_at DESC);
`;

export const CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_terminal_failure_notification_deliveries_v6 (
    id TEXT PRIMARY KEY,
    source_execution_id TEXT NOT NULL UNIQUE,
    source_session_id TEXT NOT NULL,
    terminal_state TEXT NOT NULL CHECK (terminal_state IN ('failed', 'interrupted')),
    target_session_id TEXT NOT NULL,
    contract_version INTEGER NOT NULL CHECK (contract_version = 1),
    state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued', 'failed')),
    enqueue_idempotency_key TEXT NOT NULL UNIQUE,
    notification_execution_id TEXT,
    error_code TEXT,
    error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at TEXT,
    next_attempt_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    claim_token TEXT,
    claimed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (source_execution_id) REFERENCES session_executions_v6(id) ON DELETE CASCADE,
    CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),
    CHECK (
      (state = 'pending' AND notification_execution_id IS NULL AND error_code IS NULL)
      OR (state = 'enqueued' AND notification_execution_id IS NOT NULL AND error_code IS NULL AND claim_token IS NULL)
      OR (state = 'failed' AND notification_execution_id IS NULL AND error_code IS NOT NULL AND claim_token IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_v6_terminal_failure_notification_due
    ON session_terminal_failure_notification_deliveries_v6(state, next_attempt_at, deadline_at);
  CREATE INDEX IF NOT EXISTS idx_v6_terminal_failure_notification_source
    ON session_terminal_failure_notification_deliveries_v6(source_session_id, updated_at DESC);
`;

export const CREATE_V6_SCHEMA_SQL = [
  CREATE_V6_APP_SETTINGS_TABLE_SQL,
  CREATE_V6_PROMPT_TEMPLATES_TABLE_SQL,
  CREATE_V6_MODEL_CATALOG_TABLES_SQL,
  CREATE_V6_CHARACTERS_TABLE_SQL,
  CREATE_V6_PROJECT_SCOPES_TABLE_SQL,
  CREATE_V6_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_ROLE_BINDINGS_TABLE_SQL,
  CREATE_V6_SESSION_MESSAGES_TABLE_SQL,
  CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL,
  CREATE_V6_SESSION_TURNS_TABLE_SQL,
  CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL,
  CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL,
  CREATE_V6_SESSION_EXECUTIONS_TABLE_SQL,
  CREATE_V6_WORK_ITEM_TABLES_SQL,
  CREATE_V6_SESSION_EXECUTION_ORIGINS_TABLE_SQL,
  CREATE_V6_SESSION_EXECUTION_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_SESSION_SCHEDULES_TABLE_SQL,
  CREATE_V6_SESSION_SCHEDULE_FIRES_TABLE_SQL,
  CREATE_V6_SESSION_TERMINAL_FAILURE_NOTIFICATION_DELIVERIES_TABLE_SQL,
  CREATE_V6_SESSION_EXECUTION_PUBLIC_PROGRESS_TABLE_SQL,
  CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL,
  CREATE_V6_SESSION_INTERACTIONS_TABLE_SQL,
  CREATE_V6_SESSION_INTERACTION_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_COORDINATION_EVENT_TABLES_SQL,
  CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRIES_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRY_TAGS_TABLE_SQL,
  CREATE_V6_MEMORY_ENTRY_RELATIONS_TABLE_SQL,
  CREATE_V6_MEMORY_TAG_CATALOG_TABLE_SQL,
  CREATE_V6_MEMORY_TARGET_TAG_STATS_TABLE_SQL,
  CREATE_V6_MEMORY_MUTATION_EVENTS_TABLE_SQL,
  CREATE_V6_MEMORY_IDEMPOTENCY_KEYS_TABLE_SQL,
  CREATE_V6_MEMORY_IDEMPOTENCY_FORGET_RESULTS_TABLE_SQL,
  CREATE_V6_MEMORY_MOVE_EVENTS_TABLE_SQL,
  CREATE_V6_MEMORY_PROTECTED_OBJECTS_TABLE_SQL,
  CREATE_V6_CHARACTER_AFFECT_TABLES_SQL,
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
  const shouldRestoreAuxiliaryTurns =
    tableExists(db, "session_turns_v6")
    && tableColumnNames(db, "session_turns_v6").has("auxiliary_session_id");
  const shouldRestoreTurnInterims =
    shouldRestoreAuxiliaryTurns && tableExists(db, "session_turn_interims_v6");
  const shouldRestoreTurnProviderOutputs =
    shouldRestoreAuxiliaryTurns && tableExists(db, "session_turn_provider_outputs_v6");
  const shouldRestoreTurnPublicContext =
    shouldRestoreAuxiliaryTurns && tableExists(db, "session_turn_public_context_v6");
  const shouldRestoreAuditAuxiliaryOwners =
    tableExists(db, "audit_events_v6") && tableColumnNames(db, "audit_events_v6").has("auxiliary_session_id");

  db.exec("DROP TABLE IF EXISTS auxiliary_sessions_v6_rebuild;");
  // SQLite applies the parent table's delete actions during DROP TABLE, so preserve the dependent graph
  // inside the schema-repair savepoint before replacing auxiliary_sessions.
  if (shouldRestoreAuxiliaryTurns) {
    db.exec(`
      DROP TABLE IF EXISTS temp.session_turns_v6_auxiliary_restore;
      CREATE TEMP TABLE session_turns_v6_auxiliary_restore AS
      SELECT *
      FROM session_turns_v6
      WHERE auxiliary_session_id IS NOT NULL
    `);
  }
  if (shouldRestoreTurnInterims) {
    db.exec(`
      DROP TABLE IF EXISTS temp.session_turn_interims_v6_auxiliary_restore;
      CREATE TEMP TABLE session_turn_interims_v6_auxiliary_restore AS
      SELECT interims.*
      FROM session_turn_interims_v6 AS interims
      INNER JOIN session_turns_v6_auxiliary_restore AS turns
        ON turns.id = interims.turn_id
    `);
  }
  if (shouldRestoreTurnProviderOutputs) {
    db.exec(`
      DROP TABLE IF EXISTS temp.session_turn_provider_outputs_v6_auxiliary_restore;
      CREATE TEMP TABLE session_turn_provider_outputs_v6_auxiliary_restore AS
      SELECT outputs.*
      FROM session_turn_provider_outputs_v6 AS outputs
      INNER JOIN session_turns_v6_auxiliary_restore AS turns
        ON turns.id = outputs.turn_id
    `);
  }
  if (shouldRestoreTurnPublicContext) {
    db.exec(`
      DROP TABLE IF EXISTS temp.session_turn_public_context_v6_auxiliary_restore;
      CREATE TEMP TABLE session_turn_public_context_v6_auxiliary_restore AS
      SELECT context.*
      FROM session_turn_public_context_v6 AS context
      INNER JOIN session_turns_v6_auxiliary_restore AS turns
        ON turns.id = context.turn_id
    `);
  }
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
  if (shouldRestoreAuxiliaryTurns) {
    db.exec(`
      INSERT INTO session_turns_v6
      SELECT * FROM session_turns_v6_auxiliary_restore
    `);
  }
  if (shouldRestoreTurnInterims) {
    db.exec(`
      INSERT INTO session_turn_interims_v6
      SELECT * FROM session_turn_interims_v6_auxiliary_restore
    `);
  }
  if (shouldRestoreTurnProviderOutputs) {
    db.exec(`
      INSERT INTO session_turn_provider_outputs_v6
      SELECT * FROM session_turn_provider_outputs_v6_auxiliary_restore
    `);
  }
  if (shouldRestoreTurnPublicContext) {
    db.exec(`
      INSERT INTO session_turn_public_context_v6
      SELECT * FROM session_turn_public_context_v6_auxiliary_restore
    `);
  }
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
  if (shouldRestoreTurnPublicContext) {
    db.exec("DROP TABLE temp.session_turn_public_context_v6_auxiliary_restore;");
  }
  if (shouldRestoreTurnProviderOutputs) {
    db.exec("DROP TABLE temp.session_turn_provider_outputs_v6_auxiliary_restore;");
  }
  if (shouldRestoreTurnInterims) {
    db.exec("DROP TABLE temp.session_turn_interims_v6_auxiliary_restore;");
  }
  if (shouldRestoreAuxiliaryTurns) {
    db.exec("DROP TABLE temp.session_turns_v6_auxiliary_restore;");
  }
}

function backfillAuxiliarySessionsCreatedAt(db: DatabaseSync): void {
  db.exec("UPDATE auxiliary_sessions SET created_at = updated_at WHERE created_at IS NULL OR created_at = '';");
}

function ensureSessionFileWriteIdempotencyStates(db: DatabaseSync): void {
  if (!tableExists(db, "session_file_write_idempotency_v6")) {
    db.exec(CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL);
    return;
  }
  const columns = tableColumnNames(db, "session_file_write_idempotency_v6");
  if (
    tableSql(db, "session_file_write_idempotency_v6").includes("'rejected'")
    && ["output_sha256", "byte_length", "file_device", "file_inode", "target_precondition_json"].every((column) => columns.has(column))
  ) {
    return;
  }
  db.exec(`
    ALTER TABLE session_file_write_idempotency_v6
      RENAME TO session_file_write_idempotency_v6_legacy;
    DROP INDEX IF EXISTS idx_v6_session_file_write_idempotency_expires;
  `);
  db.exec(CREATE_V6_SESSION_FILE_WRITE_IDEMPOTENCY_TABLE_SQL);
  const legacyPendingHasProof = columns.has("output_sha256")
    ? "state = 'pending' AND output_sha256 IS NOT NULL"
    : "0";
  db.exec(`
    INSERT INTO session_file_write_idempotency_v6 (
      operation, idempotency_key, request_fingerprint, session_id, relative_path,
      temp_name, state, output_sha256, byte_length, file_device, file_inode, target_precondition_json,
      result_json, created_at, expires_at
    )
    SELECT
      operation, idempotency_key, request_fingerprint, session_id, relative_path,
      temp_name, CASE WHEN ${legacyPendingHasProof} THEN 'rejected' ELSE state END,
      ${columns.has("output_sha256")
        ? (columns.has("target_precondition_json") ? "output_sha256" : "CASE WHEN state = 'pending' THEN NULL ELSE output_sha256 END")
        : "NULL"},
      ${columns.has("byte_length")
        ? (columns.has("target_precondition_json") ? "byte_length" : "CASE WHEN state = 'pending' THEN NULL ELSE byte_length END")
        : "NULL"},
      ${columns.has("file_device")
        ? (columns.has("target_precondition_json") ? "file_device" : "CASE WHEN state = 'pending' THEN NULL ELSE file_device END")
        : "NULL"},
      ${columns.has("file_inode")
        ? (columns.has("target_precondition_json") ? "file_inode" : "CASE WHEN state = 'pending' THEN NULL ELSE file_inode END")
        : "NULL"},
      ${columns.has("target_precondition_json") ? "target_precondition_json" : "NULL"},
      CASE WHEN ${legacyPendingHasProof} THEN json_object(
        'code', 'RUNTIME_UNAVAILABLE',
        'message', 'A legacy pending file publish proof cannot be recovered safely.',
        'retryable', json('false'),
        'details', json_object('reason', 'legacy_publish_proof_missing_target_precondition'),
        'effect', 'indeterminate'
      ) ELSE result_json END,
      created_at, expires_at
    FROM session_file_write_idempotency_v6_legacy;
    DROP TABLE session_file_write_idempotency_v6_legacy;
  `);
}

function ensureSessionTranscriptExportProofColumns(db: DatabaseSync): void {
  if (!tableExists(db, "session_transcript_export_idempotency_v6")) {
    db.exec(CREATE_V6_SESSION_TRANSCRIPT_EXPORT_IDEMPOTENCY_TABLE_SQL);
    return;
  }
  const columns = tableColumnNames(db, "session_transcript_export_idempotency_v6");
  const hadTargetPrecondition = columns.has("target_precondition_json");
  if (!columns.has("output_device")) {
    db.exec("ALTER TABLE session_transcript_export_idempotency_v6 ADD COLUMN output_device TEXT");
  }
  if (!columns.has("output_inode")) {
    db.exec("ALTER TABLE session_transcript_export_idempotency_v6 ADD COLUMN output_inode TEXT");
  }
  if (!columns.has("target_precondition_json")) {
    db.exec("ALTER TABLE session_transcript_export_idempotency_v6 ADD COLUMN target_precondition_json TEXT");
  }
  // A legacy pending publish proof has no trustworthy target precondition. It cannot be restaged:
  // doing so would adopt the current target and could overwrite a third-party change.
  if (!hadTargetPrecondition) {
    db.exec(`
      UPDATE session_transcript_export_idempotency_v6
      SET state = 'rejected',
          result_json = json_object(
            'code', 'EXPORT_FAILED',
            'message', 'A legacy pending transcript publish proof cannot be recovered safely.',
            'retryable', json('false'),
            'details', json_object('reason', 'legacy_publish_proof_missing_target_precondition'),
            'effect', 'indeterminate'
          ),
          output_sha256 = NULL, byte_length = NULL, output_device = NULL, output_inode = NULL,
          target_precondition_json = NULL
      WHERE state = 'pending' AND output_sha256 IS NOT NULL
    `);
  }
  // Pending rows without any durable output proof are safe to restage.
  db.exec(`
    UPDATE session_transcript_export_idempotency_v6
    SET output_sha256 = NULL, byte_length = NULL, output_device = NULL, output_inode = NULL,
        target_precondition_json = NULL
    WHERE state = 'pending'
      AND (output_device IS NULL OR output_inode IS NULL OR target_precondition_json IS NULL)
  `);
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

function ensureSessionCrudIdempotencyPrincipalScope(db: DatabaseSync): void {
  if (!tableExists(db, "session_crud_idempotency_v6")) {
    db.exec(CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL);
    return;
  }
  const columns = tableColumnNames(db, "session_crud_idempotency_v6");
  const sql = tableSql(db, "session_crud_idempotency_v6");
  if (
    columns.has("principal_session_id")
    && sql.includes("PRIMARY KEY (operation, principal_session_id, idempotency_key)")
  ) {
    return;
  }
  db.exec(`
    ALTER TABLE session_crud_idempotency_v6 RENAME TO session_crud_idempotency_v6_legacy;
    DROP INDEX IF EXISTS idx_v6_session_crud_idempotency_expires;
    ${CREATE_V6_SESSION_CRUD_IDEMPOTENCY_TABLE_SQL}
    INSERT INTO session_crud_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint,
      session_id, result_json, created_at, expires_at
    )
    SELECT operation, '', idempotency_key, request_fingerprint,
      session_id, result_json, created_at, expires_at
    FROM session_crud_idempotency_v6_legacy;
    DROP TABLE session_crud_idempotency_v6_legacy;
  `);
}

function ensureWorkItemIdempotencyExpiry(db: DatabaseSync): void {
  if (!tableExists(db, "work_item_idempotency_v6")) return;
  const columns = tableColumnNames(db, "work_item_idempotency_v6");
  if (!columns.has("expires_at")) {
    db.exec(`
      ALTER TABLE work_item_idempotency_v6
      ADD COLUMN expires_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
      UPDATE work_item_idempotency_v6
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours')
      WHERE strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+24 hours') IS NOT NULL;
    `);
  }
}

function rebuildWorkItemContractV1ToV2(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_v6_work_items_protect_session_delete;
    DROP TRIGGER IF EXISTS trg_v6_work_items_cleanup_terminal_root_session_delete;
    ALTER TABLE work_item_idempotency_v6 RENAME TO work_item_idempotency_v6_legacy;
    ALTER TABLE work_item_execution_associations_v6 RENAME TO work_item_execution_associations_v6_legacy;
    ALTER TABLE work_item_aggregations_v6 RENAME TO work_item_aggregations_v6_legacy;
    ALTER TABLE work_item_aggregation_decisions_v6 RENAME TO work_item_aggregation_decisions_v6_legacy;
    ALTER TABLE work_item_aggregation_idempotency_v6 RENAME TO work_item_aggregation_idempotency_v6_legacy;
    ALTER TABLE work_items_v6 RENAME TO work_items_v6_legacy;

    DROP INDEX IF EXISTS idx_v6_work_items_root_sequence;
    DROP INDEX IF EXISTS idx_v6_work_items_creator_sequence;
    DROP INDEX IF EXISTS idx_v6_work_items_target_sequence;
    DROP INDEX IF EXISTS idx_v6_work_items_parent;
    DROP INDEX IF EXISTS idx_v6_work_item_idempotency_item;
    DROP INDEX IF EXISTS idx_v6_work_item_idempotency_expiry;
    DROP INDEX IF EXISTS idx_v6_work_item_execution_item;
    DROP INDEX IF EXISTS idx_v6_work_item_aggregation_decisions_parent_sequence;
    DROP INDEX IF EXISTS idx_v6_work_item_aggregation_idempotency_expiry;

    ${CREATE_V6_WORK_ITEM_TABLES_SQL}

    INSERT INTO work_items_v6 (
      sequence, id, kind, contract_revision, root_session_id, creator_session_id,
      target_session_id, parent_work_item_id, goal, scope, completion_criteria,
      authority, source_identity_json, state, revision, progress_summary,
      blockers_json, next_action, result_json, created_at, updated_at
    )
    SELECT
      sequence, id, 'delegated', 2, root_session_id, creator_session_id,
      target_session_id, parent_work_item_id, goal, scope, completion_criteria,
      authority, source_identity_json, state, revision, '', '[]', '', result_json,
      created_at, updated_at
    FROM work_items_v6_legacy;

    INSERT INTO work_item_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint,
      work_item_id, response_json, created_at, expires_at
    )
    SELECT operation, principal_session_id, idempotency_key, request_fingerprint,
      work_item_id, NULL, created_at, expires_at
    FROM work_item_idempotency_v6_legacy;

    INSERT INTO work_item_execution_associations_v6 (execution_id, work_item_id, created_at)
    SELECT execution_id, work_item_id, created_at
    FROM work_item_execution_associations_v6_legacy;

    INSERT INTO work_item_aggregations_v6 (parent_work_item_id, aggregate_revision, updated_at)
    SELECT parent_work_item_id, aggregate_revision, updated_at
    FROM work_item_aggregations_v6_legacy;

    INSERT INTO work_item_aggregation_decisions_v6 (
      sequence, parent_work_item_id, child_work_item_id, decision_revision,
      child_revision, actor_session_id, decision_type, reason,
      replacement_work_item_id, decided_at
    )
    SELECT sequence, parent_work_item_id, child_work_item_id, decision_revision,
      child_revision, actor_session_id, decision_type, reason,
      replacement_work_item_id, decided_at
    FROM work_item_aggregation_decisions_v6_legacy;

    INSERT INTO work_item_aggregation_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint,
      child_work_item_id, replacement_work_item_id, created_at, expires_at
    )
    SELECT operation, principal_session_id, idempotency_key, request_fingerprint,
      child_work_item_id, replacement_work_item_id, created_at, expires_at
    FROM work_item_aggregation_idempotency_v6_legacy;

    DROP TABLE work_item_aggregation_idempotency_v6_legacy;
    DROP TABLE work_item_aggregation_decisions_v6_legacy;
    DROP TABLE work_item_aggregations_v6_legacy;
    DROP TABLE work_item_execution_associations_v6_legacy;
    DROP TABLE work_item_idempotency_v6_legacy;
    DROP TABLE work_items_v6_legacy;
  `);
}

function rebuildWorkItemIdempotencyV2(db: DatabaseSync): void {
  const columns = tableColumnNames(db, "work_item_idempotency_v6");
  const responseProjection = columns.has("response_json") ? "response_json" : "NULL";
  db.exec(`
    ALTER TABLE work_item_idempotency_v6 RENAME TO work_item_idempotency_v6_legacy;
    DROP INDEX IF EXISTS idx_v6_work_item_idempotency_item;
    DROP INDEX IF EXISTS idx_v6_work_item_idempotency_expiry;
    ${CREATE_V6_WORK_ITEM_TABLES_SQL}
    INSERT INTO work_item_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint,
      work_item_id, response_json, created_at, expires_at
    )
    SELECT operation, principal_session_id, idempotency_key, request_fingerprint,
      work_item_id, ${responseProjection}, created_at, expires_at
    FROM work_item_idempotency_v6_legacy;
    DROP TABLE work_item_idempotency_v6_legacy;
  `);
}

function rebuildWorkItemEventsPayloadLimit(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE work_item_events_v6 RENAME TO work_item_events_v6_legacy;
    DROP INDEX IF EXISTS idx_v6_work_item_events_item_sequence;
    ${CREATE_V6_WORK_ITEM_TABLES_SQL}
    INSERT INTO work_item_events_v6 (
      sequence, work_item_id, revision, event_type, actor_session_id, payload_json, created_at
    )
    SELECT sequence, work_item_id, revision, event_type, actor_session_id, payload_json, created_at
    FROM work_item_events_v6_legacy;
    DROP TABLE work_item_events_v6_legacy;
  `);
}

function upgradeWorkItemContractV2(db: DatabaseSync): void {
  if (!tableExists(db, "work_items_v6")) return;
  const workItemColumns = tableColumnNames(db, "work_items_v6");
  if (!workItemColumns.has("kind")) {
    rebuildWorkItemContractV1ToV2(db);
    return;
  }
  if (!tableSql(db, "work_items_v6").includes("contract_revision = 2")) {
    throw new Error("Unsupported Work Item contract schema.");
  }
  if (
    tableExists(db, "work_item_events_v6")
    && !tableSql(db, "work_item_events_v6").includes(
      `WHEN 'migration_baseline' THEN ${WORK_ITEM_MAX_MIGRATION_BASELINE_PAYLOAD_BYTES}`,
    )
  ) {
    rebuildWorkItemEventsPayloadLimit(db);
  }
  if (tableExists(db, "work_item_idempotency_v6")) {
    const idempotencySql = tableSql(db, "work_item_idempotency_v6");
    const idempotencyColumns = tableColumnNames(db, "work_item_idempotency_v6");
    if (
      !idempotencyColumns.has("response_json")
      || !idempotencySql.includes("'work.revise'")
      || !idempotencySql.includes("'work.history.append'")
      || !idempotencySql.includes(`length(CAST(response_json AS BLOB)) <= ${WORK_ITEM_MAX_IDEMPOTENCY_RESPONSE_BYTES}`)
    ) {
      rebuildWorkItemIdempotencyV2(db);
    }
  }
  db.exec("DROP TRIGGER IF EXISTS trg_v6_work_items_protect_session_delete;");
  db.exec("DROP TRIGGER IF EXISTS trg_v6_work_items_cleanup_terminal_root_session_delete;");
}

function backfillRootWorkItemsAndBaselines(db: DatabaseSync): void {
  const invalidRoot = db.prepare(`
    SELECT item.id
    FROM work_items_v6 AS item
    LEFT JOIN session_role_bindings_v6 AS binding
      ON binding.session_id = item.root_session_id
      AND binding.root_session_id = item.root_session_id
      AND binding.parent_session_id IS NULL
      AND binding.delegation_depth = 0
      AND binding.session_role IN ('standalone', 'overall-coordinator')
    WHERE item.kind = 'root'
      AND binding.session_id IS NULL
    LIMIT 1
  `).get() as { id?: unknown } | undefined;
  if (typeof invalidRoot?.id === "string") {
    throw new Error(`Root Work Item has an ineligible owner Session: ${invalidRoot.id}`);
  }

  db.exec(`
    INSERT INTO work_items_v6 (
      id, kind, contract_revision, root_session_id, creator_session_id,
      target_session_id, parent_work_item_id, goal, scope, completion_criteria,
      authority, source_identity_json, state, revision, progress_summary,
      blockers_json, next_action, result_json, created_at, updated_at
    )
    SELECT
      'root-work-item:' || session.id,
      'root',
      2,
      session.id,
      session.id,
      session.id,
      NULL,
      session.title,
      '',
      '',
      '',
      json_object(
        'workspace', CASE WHEN trim(session.workspace_path) = '' THEN NULL ELSE session.workspace_path END,
        'repository', NULL,
        'branch', CASE
          WHEN json_type(session.runtime_policy_json, '$.branch') = 'text'
            AND trim(json_extract(session.runtime_policy_json, '$.branch')) <> ''
          THEN json_extract(session.runtime_policy_json, '$.branch')
          ELSE NULL
        END,
        'base', NULL,
        'head', NULL
      ),
      'pending',
      1,
      '',
      '[]',
      '',
      NULL,
      session.created_at,
      session.created_at
    FROM sessions_v6 AS session
    INNER JOIN session_role_bindings_v6 AS binding ON binding.session_id = session.id
    WHERE session.session_kind <> 'character-authoring'
      AND binding.session_role IN ('standalone', 'overall-coordinator')
      AND binding.root_session_id = session.id
      AND binding.parent_session_id IS NULL
      AND binding.delegation_depth = 0
      AND NOT EXISTS (
        SELECT 1
        FROM work_items_v6 AS existing
        WHERE existing.kind = 'root'
          AND existing.root_session_id = session.id
      );

    INSERT INTO work_item_events_v6 (
      work_item_id, revision, event_type, actor_session_id, payload_json, created_at
    )
    SELECT
      item.id,
      item.revision,
      'migration_baseline',
      NULL,
      json_object(
        'kind', item.kind,
        'rootSessionId', item.root_session_id,
        'creatorSessionId', item.creator_session_id,
        'targetSessionId', item.target_session_id,
        'parentWorkItemId', item.parent_work_item_id,
        'sourceIdentity', json(item.source_identity_json),
        'contract', json_object(
          'goal', item.goal,
          'scope', item.scope,
          'completionCriteria', item.completion_criteria,
          'authority', item.authority
        ),
        'progress', json_object(
          'progressSummary', item.progress_summary,
          'blockers', json(item.blockers_json),
          'nextAction', item.next_action
        ),
        'state', item.state,
        'result', CASE WHEN item.result_json IS NULL THEN NULL ELSE json(item.result_json) END
      ),
      item.updated_at
    FROM work_items_v6 AS item
    WHERE NOT EXISTS (
      SELECT 1 FROM work_item_events_v6 AS event
      WHERE event.work_item_id = item.id
    );
  `);

  const inconsistentRevision = db.prepare(`
    SELECT item.id
    FROM work_items_v6 AS item
    LEFT JOIN work_item_events_v6 AS event ON event.work_item_id = item.id
    GROUP BY item.id, item.revision
    HAVING MAX(event.revision) IS NULL OR MAX(event.revision) <> item.revision
    LIMIT 1
  `).get() as { id?: unknown } | undefined;
  if (typeof inconsistentRevision?.id === "string") {
    throw new Error(`Work Item projection and event revision disagree: ${inconsistentRevision.id}`);
  }
}

function backfillWorkItemAggregations(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO work_item_aggregations_v6 (
      parent_work_item_id, aggregate_revision, updated_at
    )
    SELECT
      child.parent_work_item_id,
      COUNT(*) + COUNT(decision.child_work_item_id),
      MAX(CASE
        WHEN decision.decided_at IS NOT NULL AND decision.decided_at > child.updated_at
        THEN decision.decided_at
        ELSE child.updated_at
      END)
    FROM work_items_v6 AS child
    LEFT JOIN work_item_aggregation_decisions_v6 AS decision
      ON decision.child_work_item_id = child.id
      AND decision.parent_work_item_id = child.parent_work_item_id
    WHERE child.parent_work_item_id IS NOT NULL
    GROUP BY child.parent_work_item_id
    ON CONFLICT(parent_work_item_id) DO NOTHING;
  `);
}

export function cleanupForbiddenV6Tables(db: DatabaseSync): void {
  for (const tableName of FORBIDDEN_V6_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${tableName};`);
  }
}

function ensureV6SchemaUnsafe(db: DatabaseSync): void {
  const targetTagStatsExisted = tableExists(db, "memory_target_tag_stats_v6");
  const sessionRoleBindingsExisted = tableExists(db, "session_role_bindings_v6");
  upgradeLegacyCoordinationEventActionSchema(db);
  if (!hasValidTerminalFailureNotificationSchemaIfPresent(db)) {
    throw new Error("Session terminal failure notification delivery schema is invalid.");
  }
  if (!hasValidCoordinationEventSchemaIfPresent(db)) {
    throw new Error("Coordination event schema is invalid.");
  }
  ensureSessionCrudIdempotencyPrincipalScope(db);
  ensureWorkItemIdempotencyExpiry(db);
  upgradeWorkItemContractV2(db);
  for (const statement of CREATE_V6_SCHEMA_SQL) {
    if (
      statement === CREATE_V6_AUXILIARY_SESSIONS_TABLE_SQL
      || statement === CREATE_V6_SESSION_TURNS_TABLE_SQL
      || statement === CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL
      || statement === CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL
      || statement === CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL
    ) {
      continue;
    }
    db.exec(statement);
  }
  if (!sessionRoleBindingsExisted) {
    db.exec(`
      INSERT INTO session_role_bindings_v6 (
        session_id, session_role, role_contract_revision, root_session_id, parent_session_id, delegation_depth
      )
      SELECT id, 'standalone', 1, id, NULL, 0
      FROM sessions_v6
      WHERE session_kind <> 'character-authoring' OR session_kind IS NULL
    `);
    db.exec(`
      UPDATE sessions_v6
      SET runtime_policy_json = json_set(runtime_policy_json, '$.sourceSchemaVersion', 6)
      WHERE json_valid(runtime_policy_json)
        AND json_extract(runtime_policy_json, '$.sourceSchemaVersion') = 5
    `);
  }

  backfillRootWorkItemsAndBaselines(db);
  backfillWorkItemAggregations(db);

  if (!hasValidTerminalFailureNotificationSchemaIfPresent(db)) {
    throw new Error("Session terminal failure notification delivery schema is invalid.");
  }
  if (!hasValidCoordinationEventSchemaIfPresent(db)) {
    throw new Error("Coordination event schema is invalid.");
  }

  const sessionColumns = tableColumnNames(db, "sessions_v6");
  if (!sessionColumns.has("is_pinned")) {
    db.exec("ALTER TABLE sessions_v6 ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1));");
  }

  ensureSessionExecutionIdempotencyOperations(db);
  ensureSessionFileWriteIdempotencyStates(db);
  ensureSessionTranscriptExportProofColumns(db);
  ensureSessionInteractionExpiryReasons(db);

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

  db.exec(CREATE_V6_SESSION_TURNS_TABLE_SQL);
  db.exec(CREATE_V6_SESSION_TURN_INTERIMS_TABLE_SQL);
  db.exec(CREATE_V6_SESSION_TURN_PROVIDER_OUTPUTS_TABLE_SQL);
  db.exec(CREATE_V6_SESSION_TURN_PUBLIC_CONTEXT_TABLE_SQL);
  upgradeSessionExecutionOriginSchema(db);
  migrateSessionExecutionOriginsOnce(db);
  if (!hasValidSessionExecutionOriginSchema(db)) {
    throw new Error("Session execution origin schema is invalid.");
  }

  if (tableExists(db, "memory_protected_objects_v6")) {
    const protectedObjectColumns = tableColumnNames(db, "memory_protected_objects_v6");
    if (!protectedObjectColumns.has("role")) {
      db.exec("ALTER TABLE memory_protected_objects_v6 ADD COLUMN role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('evidence', 'source', 'snapshot', 'artifact', 'reference', 'other'))");
    }
  }

  if (tableExists(db, "memory_idempotency_keys_v6")) {
    const idempotencyColumns = tableColumnNames(db, "memory_idempotency_keys_v6");
    if (!idempotencyColumns.has("cleanup_pending_count")) {
      db.exec("ALTER TABLE memory_idempotency_keys_v6 ADD COLUMN cleanup_pending_count INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending_count >= 0)");
      if (idempotencyColumns.has("cleanup_required")) {
        db.exec("UPDATE memory_idempotency_keys_v6 SET cleanup_pending_count = 1 WHERE cleanup_required = 1");
      }
    }
  }

  if (!targetTagStatsExisted) {
    db.exec(`
      INSERT INTO memory_target_tag_stats_v6 (
        owner_type,
        owner_id,
        scope_type,
        scope_id,
        tag_type,
        tag_value,
        tag_type_canonical,
        tag_value_canonical,
        usage_count,
        latest_entry_updated_at
      )
      SELECT
        e.owner_type,
        e.owner_id,
        e.scope_type,
        e.scope_id,
        MAX(t.tag_type),
        MAX(t.tag_value),
        t.tag_type_canonical,
        t.tag_value_canonical,
        COUNT(*),
        MAX(e.updated_at)
      FROM memory_entry_tags_v6 AS t
      INNER JOIN memory_entries_v6 AS e ON e.id = t.entry_id
      WHERE e.state = 'active'
      GROUP BY e.owner_type, e.owner_id, e.scope_type, e.scope_id, t.tag_type_canonical, t.tag_value_canonical
    `);
  }

  if (tableExists(db, "memory_mutation_events_v6")) {
    const mutationEventColumns = tableColumnNames(db, "memory_mutation_events_v6");
    if (!mutationEventColumns.has("source_message_id")) {
      db.exec("ALTER TABLE memory_mutation_events_v6 ADD COLUMN source_message_id TEXT");
    }
  }

  if (tableExists(db, "memory_move_events_v6")) {
    const moveEventColumns = tableColumnNames(db, "memory_move_events_v6");
    if (!moveEventColumns.has("reason")) {
      db.exec("ALTER TABLE memory_move_events_v6 ADD COLUMN reason TEXT NOT NULL DEFAULT ''");
    }
  }

  if (tableExists(db, "character_affect_events_v6")) {
    const affectEventColumns = tableColumnNames(db, "character_affect_events_v6");
    if (!affectEventColumns.has("family")) {
      db.exec("ALTER TABLE character_affect_events_v6 ADD COLUMN family TEXT CHECK (family IS NULL OR family IN ('joy', 'relief', 'interest', 'anticipation', 'affinity', 'gratitude', 'concern', 'frustration', 'disappointment', 'regret', 'determination', 'other'))");
    }
  }

  if (tableExists(db, "session_schedule_fires_v6")) {
    const fireColumns = tableColumnNames(db, "session_schedule_fires_v6");
    if (!fireColumns.has("session_id")) db.exec("ALTER TABLE session_schedule_fires_v6 ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
    if (!fireColumns.has("turn_json")) db.exec("ALTER TABLE session_schedule_fires_v6 ADD COLUMN turn_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(turn_json))");
  }

  if (!hasValidSessionRoleBindingSchemaAndData(db)) {
    throw new Error("Session Role binding data is invalid.");
  }

}

function hasPrimaryKeyColumns(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const columns = db.prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk ASC")
    .all(tableName) as Array<{ name?: unknown }>;
  return columns.length === expectedColumns.length
    && columns.every((column, position) => column.name === expectedColumns[position]);
}

function hasIndexForColumns(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const indexes = db.prepare("SELECT name FROM pragma_index_list(?)").all(tableName) as Array<{ name?: unknown }>;
  return indexes.some((index) => {
    if (typeof index.name !== "string") return false;
    const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno ASC")
      .all(index.name) as Array<{ name?: unknown }>;
    return columns.length === expectedColumns.length
      && columns.every((column, position) => column.name === expectedColumns[position]);
  });
}

function hasValidSessionExecutionOriginSchema(db: DatabaseSync, requireMessageAnchor = true): boolean {
  if (!tableExists(db, "session_execution_origins_v6")) return false;
  const sql = tableSql(db, "session_execution_origins_v6").replace(/\s+/g, " ").toLowerCase();
  return hasPrimaryKeyColumns(db, "session_execution_origins_v6", ["execution_id"])
    && hasUniqueIndexForColumns(db, "session_execution_origins_v6", ["execution_sequence"])
    && hasIndexForColumns(db, "session_execution_origins_v6", ["source_session_id", "execution_sequence"])
    && hasForeignKey(db, "session_execution_origins_v6", "source_session_id", "sessions_v6", "id", "CASCADE")
    && hasForeignKey(db, "work_items_v6", "parent_work_item_id", "work_items_v6", "id")
    && hasForeignKey(db, "work_item_idempotency_v6", "work_item_id", "work_items_v6", "id", "CASCADE")
    && hasForeignKey(db, "work_item_execution_associations_v6", "execution_id", "session_executions_v6", "id", "CASCADE")
    && hasForeignKey(db, "work_item_execution_associations_v6", "work_item_id", "work_items_v6", "id")
    && sql.includes("operation in ('turn.run', 'turn.enqueue')")
    && sql.includes("target_session_role_snapshot in ('standalone', 'overall-coordinator', 'task-coordinator', 'executor')")
    && (!requireMessageAnchor || sql.includes("source_message_seq_anchor >= -1"))
    && sql.includes("source_session_id <> target_session_id");
}

function migrateSessionExecutionOriginsOnce(db: DatabaseSync): void {
  if (!tableExists(db, "session_executions_v6") || !tableExists(db, "session_execution_origins_v6")) return;
  const marker = db.prepare("SELECT 1 FROM app_settings WHERE setting_key = ?")
    .get(SESSION_EXECUTION_ORIGIN_MIGRATION_SETTING_KEY);
  if (marker) return;
  if (tableExists(db, "session_terminal_failure_notification_deliveries_v6")) {
    db.exec(`
      DELETE FROM session_execution_origins_v6
      WHERE execution_id IN (
        SELECT notification_execution_id
        FROM session_terminal_failure_notification_deliveries_v6
        WHERE notification_execution_id IS NOT NULL
      )
    `);
  }
  db.exec(`
    INSERT OR IGNORE INTO session_execution_origins_v6 (
      execution_id, execution_sequence, source_session_id, target_session_id,
      operation, target_session_title_snapshot, target_session_role_snapshot,
      source_message_seq_anchor, user_message, accepted_at
    )
    SELECT
      execution.id,
      execution.sequence,
      trim(json_extract(execution.request_json, '$.initiator.sessionId')),
      execution.session_id,
      execution.operation,
      target.title,
      binding.session_role,
      COALESCE((
        SELECT MAX(source_turn.user_message_seq)
        FROM session_turns_v6 AS source_turn
        WHERE source_turn.session_id = trim(json_extract(execution.request_json, '$.initiator.sessionId'))
          AND source_turn.started_at <= execution.created_at
      ), (
        SELECT MAX(message.seq)
        FROM session_messages_v6 AS message
        WHERE message.session_id = trim(json_extract(execution.request_json, '$.initiator.sessionId'))
          AND message.created_at <= execution.created_at
      ), -1),
      json_extract(execution.request_json, '$.turn.userMessage'),
      execution.created_at
    FROM session_executions_v6 AS execution
    INNER JOIN sessions_v6 AS source
      ON source.id = trim(json_extract(execution.request_json, '$.initiator.sessionId'))
    INNER JOIN sessions_v6 AS target ON target.id = execution.session_id
    INNER JOIN session_role_bindings_v6 AS binding ON binding.session_id = target.id
    WHERE json_type(execution.request_json, '$.initiator.sessionId') = 'text'
      AND json_extract(execution.request_json, '$.initiator.kind') = 'session'
      AND json_type(execution.request_json, '$.turn.userMessage') = 'text'
      AND trim(json_extract(execution.request_json, '$.initiator.sessionId')) <> execution.session_id
      AND NOT EXISTS (
        SELECT 1
        FROM session_terminal_failure_notification_deliveries_v6 AS delivery
        WHERE delivery.notification_execution_id = execution.id
      )
  `);
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(SESSION_EXECUTION_ORIGIN_MIGRATION_SETTING_KEY);
}

function upgradeSessionExecutionOriginSchema(db: DatabaseSync): void {
  if (!tableExists(db, "session_execution_origins_v6")) return;
  const columns = tableColumnNames(db, "session_execution_origins_v6");
  const hasMessageAnchor = columns.has("source_message_seq_anchor");
  if (!hasValidSessionExecutionOriginSchema(db, hasMessageAnchor)) {
    throw new Error("Session execution origin schema is invalid.");
  }
  if (hasMessageAnchor) return;
  db.exec(`
    ALTER TABLE session_execution_origins_v6
      ADD COLUMN source_message_seq_anchor INTEGER NOT NULL DEFAULT -1
      CHECK (source_message_seq_anchor >= -1);
    UPDATE session_execution_origins_v6
    SET source_message_seq_anchor = COALESCE((
      SELECT MAX(source_turn.user_message_seq)
      FROM session_turns_v6 AS source_turn
      WHERE source_turn.session_id = session_execution_origins_v6.source_session_id
        AND source_turn.started_at <= session_execution_origins_v6.accepted_at
    ), (
      SELECT MAX(message.seq)
      FROM session_messages_v6 AS message
      WHERE message.session_id = session_execution_origins_v6.source_session_id
        AND message.created_at <= session_execution_origins_v6.accepted_at
    ), -1);
  `);
}

function upgradeLegacyCoordinationEventActionSchema(db: DatabaseSync): void {
  if (!tableExists(db, "coordination_event_actions_v6")
    || !tableExists(db, "coordination_event_idempotency_v6")) {
    return;
  }
  const actionSql = tableSql(db, "coordination_event_actions_v6");
  const idempotencySql = tableSql(db, "coordination_event_idempotency_v6");
  if (actionSql.includes("'responded'") && idempotencySql.includes("'coordination.event.consume'")) {
    return;
  }
  const hasSupportedLegacyActions = (
    actionSql.includes("action_type IN ('resolved', 'cancelled', 'superseded')")
      || actionSql.includes("action_type IN ('resolved', 'cancelled', 'superseded', 'consumed')")
  )
    && actionSql.includes("(action_type = 'superseded') = (related_event_id IS NOT NULL)")
  const hasSupportedLegacyIdempotency = (
    idempotencySql.includes("operation IN ('coordination.event.create', 'coordination.event.resolve', 'coordination.event.cancel', 'coordination.event.correct')")
      || idempotencySql.includes("operation IN ('coordination.event.create', 'coordination.event.resolve', 'coordination.event.consume', 'coordination.event.cancel', 'coordination.event.correct')")
  ) && idempotencySql.includes("PRIMARY KEY (principal_session_id, idempotency_key)");
  if (!hasSupportedLegacyActions || !hasSupportedLegacyIdempotency) return;

  db.exec(`
    DROP INDEX IF EXISTS idx_v6_coordination_event_actions_event_sequence;
    DROP INDEX IF EXISTS idx_v6_coordination_event_idempotency_event;
    ALTER TABLE coordination_event_actions_v6 RENAME TO coordination_event_actions_v6_legacy;
    ALTER TABLE coordination_event_idempotency_v6 RENAME TO coordination_event_idempotency_v6_legacy;
    ${CREATE_V6_COORDINATION_EVENT_TABLES_SQL}
    INSERT INTO coordination_event_actions_v6 (
      sequence, id, event_id, action_type, actor_type, actor_session_id,
      option_id, note, related_event_id, created_at
    )
    SELECT legacy.sequence, legacy.id, legacy.event_id,
      CASE
        WHEN legacy.action_type = 'resolved'
          AND legacy.actor_type = 'trusted_gui'
          AND events.kind = 'blocker'
        THEN 'responded'
        ELSE legacy.action_type
      END,
      legacy.actor_type, legacy.actor_session_id, legacy.option_id, legacy.note,
      legacy.related_event_id, legacy.created_at
    FROM coordination_event_actions_v6_legacy AS legacy
    INNER JOIN coordination_events_v6 AS events ON events.id = legacy.event_id;
    INSERT INTO coordination_event_idempotency_v6 (
      operation, principal_session_id, idempotency_key, request_fingerprint,
      result_event_id, target_event_id, created_at
    )
    SELECT operation, principal_session_id, idempotency_key, request_fingerprint,
      result_event_id, target_event_id, created_at
    FROM coordination_event_idempotency_v6_legacy;
    DROP TABLE coordination_event_idempotency_v6_legacy;
    DROP TABLE coordination_event_actions_v6_legacy;
  `);
}

export function ensureV6Schema(db: DatabaseSync): void {
  const sessionRoleBindingsExisted = tableExists(db, "session_role_bindings_v6");
  if (sessionRoleBindingsExisted && !hasValidSessionRoleBindingSchemaAndData(db)) {
    throw new ExistingSessionRoleBindingSchemaError(
      new Error("Session Role binding schema or data failed pre-migration validation."),
    );
  }
  runWithSavepoint(db, "ensure_v6_schema", () => ensureV6SchemaUnsafe(db));
}
