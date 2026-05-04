import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const APP_DATABASE_V4_FILENAME = "withmate-v4.db";
export const APP_DATABASE_V4_SCHEMA_VERSION = 4;

export const V4_SCHEMA_STATUS = "ready-for-implementation";

export const REQUIRED_V4_TABLES = [
  "mate_profile",
  "mate_profile_sections",
  "mate_profile_revisions",
  "mate_profile_revision_sections",
  "mate_growth_settings",
  "mate_growth_model_preferences",
  "mate_growth_runs",
  "mate_growth_cursors",
  "mate_growth_events",
  "mate_growth_event_links",
  "mate_growth_event_profile_item_links",
  "mate_memory_tags",
  "mate_memory_tag_catalog",
  "mate_embedding_settings",
  "mate_semantic_embeddings",
  "mate_growth_event_actions",
  "mate_growth_event_evidence",
  "mate_profile_items",
  "mate_profile_item_tags",
  "mate_profile_item_sources",
  "mate_profile_item_relations",
  "mate_forgotten_tombstones",
  "mate_project_digests",
  "provider_instruction_targets",
  "provider_instruction_sync_runs",
] as const;

export function isValidV4Database(dbPath: string): boolean {
  if (basename(dbPath) !== APP_DATABASE_V4_FILENAME) {
    return false;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const placeholders = REQUIRED_V4_TABLES.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${placeholders})
    `,
      )
      .all(...REQUIRED_V4_TABLES) as Array<{ name: string }>;
    const tableNames = new Set(rows.map((row) => row.name));
    return REQUIRED_V4_TABLES.every((tableName) => tableNames.has(tableName));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export const CREATE_V4_MATE_PROFILE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile (
    id TEXT PRIMARY KEY CHECK (id = 'current'),
    state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'deleted')),
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    theme_main TEXT NOT NULL DEFAULT '#6f8cff',
    theme_sub TEXT NOT NULL DEFAULT '#6fb8c7',
    avatar_file_path TEXT NOT NULL DEFAULT '',
    avatar_sha256 TEXT NOT NULL DEFAULT '',
    avatar_byte_size INTEGER NOT NULL DEFAULT 0,
    active_revision_id TEXT,
    profile_generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
`;

export const CREATE_V4_MATE_PROFILE_SECTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_sections (
    mate_id TEXT NOT NULL,
    section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes')),
    file_path TEXT NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    updated_by_revision_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (mate_id, section_key),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
  );
`;

export const CREATE_V4_MATE_PROFILE_REVISIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_revisions (
    id TEXT PRIMARY KEY,
    mate_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    parent_revision_id TEXT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
      'staging',
      'committing_files',
      'ready',
      'failed'
    )),
    kind TEXT NOT NULL CHECK (kind IN (
      'initial',
      'manual_edit',
      'growth_apply',
      'growth_correct',
      'growth_forget',
      'growth_disable',
      'growth_enable',
      'avatar_update',
      'profile_delete',
      'restore'
    )),
    source_growth_event_id TEXT,
    summary TEXT NOT NULL,
    snapshot_dir_path TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL CHECK (created_by IN ('user', 'system')),
    created_at TEXT NOT NULL,
    ready_at TEXT,
    failed_at TEXT,
    reverted_by_revision_id TEXT,
    UNIQUE (mate_id, seq),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
    FOREIGN KEY (reverted_by_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_profile_revisions_mate_seq
    ON mate_profile_revisions(mate_id, seq DESC);

  CREATE INDEX IF NOT EXISTS idx_mate_profile_revisions_growth_event
    ON mate_profile_revisions(source_growth_event_id);
`;

export const CREATE_V4_MATE_PROFILE_REVISION_SECTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_revision_sections (
    revision_id TEXT NOT NULL,
    section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes', 'avatar')),
    file_path TEXT NOT NULL DEFAULT '',
    before_sha256 TEXT NOT NULL DEFAULT '',
    after_sha256 TEXT NOT NULL DEFAULT '',
    before_byte_size INTEGER NOT NULL DEFAULT 0,
    after_byte_size INTEGER NOT NULL DEFAULT 0,
    diff_path TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (revision_id, section_key),
    FOREIGN KEY (revision_id) REFERENCES mate_profile_revisions(id) ON DELETE CASCADE
  );
`;

export const CREATE_V4_MATE_GROWTH_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_settings (
    mate_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_apply_enabled INTEGER NOT NULL DEFAULT 1,
    min_auto_apply_confidence INTEGER NOT NULL DEFAULT 75,
    memory_candidate_mode TEXT NOT NULL DEFAULT 'every_turn' CHECK (memory_candidate_mode IN ('every_turn', 'threshold', 'manual')),
    memory_candidate_timeout_seconds INTEGER NOT NULL DEFAULT 60,
    apply_interval_minutes INTEGER NOT NULL DEFAULT 60,
    retrieval_strategy TEXT NOT NULL DEFAULT 'hybrid' CHECK (retrieval_strategy IN ('hybrid', 'sql_only')),
    retrieval_sql_candidate_limit INTEGER NOT NULL DEFAULT 80,
    retrieval_embedding_candidate_limit INTEGER NOT NULL DEFAULT 40,
    retrieval_final_limit INTEGER NOT NULL DEFAULT 12,
    pending_count_threshold INTEGER NOT NULL DEFAULT 10,
    pending_salience_threshold INTEGER NOT NULL DEFAULT 300,
    cooldown_seconds INTEGER NOT NULL DEFAULT 900,
    timeout_seconds INTEGER NOT NULL DEFAULT 180,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
  );
`;

export const CREATE_V4_MATE_GROWTH_MODEL_PREFERENCES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_model_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mate_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (
      'memory_candidate',
      'profile_update',
      'project_digest'
    )),
    priority INTEGER NOT NULL CHECK (priority >= 1),
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL DEFAULT 'low',
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN (
      'unknown',
      'available',
      'unavailable',
      'failed'
    )),
    last_error_preview TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (mate_id, purpose, priority),
    UNIQUE (mate_id, purpose, provider_id, model, reasoning_effort),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_model_preferences_enabled
    ON mate_growth_model_preferences(mate_id, purpose, enabled, priority);
`;

export const CREATE_V4_MATE_GROWTH_RUNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mate_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('session', 'companion', 'manual', 'system', 'mate_talk')),
    source_session_id TEXT,
    source_audit_log_id INTEGER,
    project_digest_id TEXT,
    trigger_reason TEXT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN (
      'queued',
      'extracting',
      'consolidating',
      'applying',
      'completed',
      'failed',
      'canceled',
      'skipped',
      'recovered'
    )),
    operation_id TEXT NOT NULL DEFAULT '',
    input_hash TEXT NOT NULL DEFAULT '',
    output_revision_id TEXT,
    output_hash TEXT NOT NULL DEFAULT '',
    candidate_count INTEGER NOT NULL DEFAULT 0,
    applied_count INTEGER NOT NULL DEFAULT 0,
    invalid_count INTEGER NOT NULL DEFAULT 0,
    error_preview TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (output_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (project_digest_id) REFERENCES mate_project_digests(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_runs_source
    ON mate_growth_runs(source_type, source_session_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_mate_growth_runs_status
    ON mate_growth_runs(status, started_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_growth_runs_operation
    ON mate_growth_runs(mate_id, operation_id)
    WHERE operation_id <> '';
`;

export const CREATE_V4_MATE_GROWTH_CURSORS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_cursors (
    mate_id TEXT NOT NULL,
    cursor_key TEXT NOT NULL CHECK (cursor_key IN (
      'extraction_cursor',
      'consolidation_cursor',
      'applied_event_watermark',
      'project_digest_cursor'
    )),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'session', 'companion', 'project')),
    scope_id TEXT NOT NULL DEFAULT '',
    last_message_id TEXT NOT NULL DEFAULT '',
    last_audit_log_id INTEGER,
    last_growth_event_id TEXT NOT NULL DEFAULT '',
    last_profile_generation INTEGER NOT NULL DEFAULT 0,
    content_fingerprint TEXT NOT NULL DEFAULT '',
    updated_by_run_id INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (mate_id, cursor_key, scope_type, scope_id),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by_run_id) REFERENCES mate_growth_runs(id) ON DELETE SET NULL
  );
`;

export const CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_events (
    id TEXT PRIMARY KEY,
    mate_id TEXT NOT NULL,
    source_growth_run_id INTEGER,
    source_type TEXT NOT NULL CHECK (source_type IN ('session', 'companion', 'manual', 'system', 'mate_talk')),
    source_session_id TEXT,
    source_audit_log_id INTEGER,
    project_digest_id TEXT,
    growth_source_type TEXT NOT NULL CHECK (growth_source_type IN (
      'explicit_user_instruction',
      'user_correction',
      'repeated_user_behavior',
      'assistant_inference',
      'tool_or_file_observation'
    )),
    kind TEXT NOT NULL CHECK (kind IN (
      'conversation',
      'preference',
      'relationship',
      'work_style',
      'boundary',
      'project_context',
      'curiosity',
      'observation',
      'correction'
    )),
    target_section TEXT NOT NULL DEFAULT 'none' CHECK (target_section IN ('bond', 'work_style', 'project_digest', 'core', 'none')),
    statement TEXT NOT NULL,
    statement_fingerprint TEXT NOT NULL DEFAULT '',
    rationale_preview TEXT NOT NULL DEFAULT '',
    retention TEXT NOT NULL DEFAULT 'auto' CHECK (retention IN ('auto', 'force')),
    relation TEXT NOT NULL DEFAULT 'new' CHECK (relation IN ('new', 'reinforces', 'updates', 'contradicts')),
    target_claim_key TEXT NOT NULL DEFAULT '',
    confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
    salience_score INTEGER NOT NULL DEFAULT 0 CHECK (salience_score >= 0 AND salience_score <= 100),
    recurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_count >= 1),
    policy_decision TEXT NOT NULL DEFAULT 'pending' CHECK (policy_decision IN ('pending', 'auto_apply', 'manual_only')),
    projection_allowed INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN (
      'candidate',
      'applied',
      'corrected',
      'superseded',
      'disabled',
      'forgotten',
      'failed'
    )),
    applied_revision_id TEXT,
    corrected_by_event_id TEXT,
    superseded_by_event_id TEXT,
    forgotten_revision_id TEXT,
    disabled_revision_id TEXT,
    content_redacted INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    decay_after_at TEXT,
    created_at TEXT NOT NULL,
    applied_at TEXT,
    updated_at TEXT NOT NULL,
    forgotten_at TEXT,
    disabled_at TEXT,
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (source_growth_run_id) REFERENCES mate_growth_runs(id) ON DELETE SET NULL,
    FOREIGN KEY (applied_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (corrected_by_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
    FOREIGN KEY (superseded_by_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
    FOREIGN KEY (forgotten_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (disabled_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_events_state_created
    ON mate_growth_events(state, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_mate_growth_events_target_state
    ON mate_growth_events(target_section, state, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_mate_growth_events_project
    ON mate_growth_events(project_digest_id, state, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_mate_growth_events_fingerprint
    ON mate_growth_events(statement_fingerprint, state);

  CREATE INDEX IF NOT EXISTS idx_mate_growth_events_seen
    ON mate_growth_events(last_seen_at DESC, salience_score DESC);
`;

export const CREATE_V4_MATE_GROWTH_EVENT_LINKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_event_links (
    source_growth_event_id TEXT NOT NULL,
    target_growth_event_id TEXT NOT NULL,
    link_type TEXT NOT NULL CHECK (link_type IN (
      'related',
      'reinforces',
      'updates',
      'contradicts',
      'supersedes'
    )),
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_growth_event_id, target_growth_event_id, link_type),
    FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
    FOREIGN KEY (target_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_event_links_target
    ON mate_growth_event_links(target_growth_event_id, link_type);
`;

export const CREATE_V4_MATE_GROWTH_EVENT_PROFILE_ITEM_LINKS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_event_profile_item_links (
    growth_event_id TEXT NOT NULL,
    profile_item_id TEXT NOT NULL,
    link_type TEXT NOT NULL CHECK (link_type IN (
      'related',
      'reinforces',
      'updates',
      'contradicts',
      'supersedes'
    )),
    created_at TEXT NOT NULL,
    PRIMARY KEY (growth_event_id, profile_item_id, link_type),
    FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_event_profile_item_links_item
    ON mate_growth_event_profile_item_links(profile_item_id, link_type);
`;

export const CREATE_V4_MATE_MEMORY_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_memory_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL,
    tag_type TEXT NOT NULL,
    tag_value TEXT NOT NULL DEFAULT '',
    tag_value_normalized TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (memory_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_memory_tags_memory
    ON mate_memory_tags(memory_id);

  CREATE INDEX IF NOT EXISTS idx_mate_memory_tags_lookup
    ON mate_memory_tags(tag_type, tag_value_normalized);
`;

export const CREATE_V4_MATE_MEMORY_TAG_CATALOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_memory_tag_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_type TEXT NOT NULL,
    tag_value TEXT NOT NULL DEFAULT '',
    tag_value_normalized TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
    usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
    created_by TEXT NOT NULL CHECK (created_by IN ('app', 'llm', 'user')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_memory_tag_catalog_unique
    ON mate_memory_tag_catalog(tag_type, tag_value_normalized);

  CREATE INDEX IF NOT EXISTS idx_mate_memory_tag_catalog_lookup
    ON mate_memory_tag_catalog(tag_type, usage_count DESC, updated_at DESC);
`;

export const CREATE_V4_MATE_EMBEDDING_SETTINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_embedding_settings (
    mate_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    backend_type TEXT NOT NULL DEFAULT 'local_transformers_js' CHECK (backend_type IN (
      'local_transformers_js'
    )),
    model_id TEXT NOT NULL DEFAULT 'Xenova/multilingual-e5-small',
    source_model_id TEXT NOT NULL DEFAULT 'intfloat/multilingual-e5-small',
    dimension INTEGER NOT NULL DEFAULT 384,
    cache_policy TEXT NOT NULL DEFAULT 'download_once_local_cache' CHECK (cache_policy IN (
      'download_once_local_cache'
    )),
    cache_state TEXT NOT NULL DEFAULT 'missing' CHECK (cache_state IN (
      'missing',
      'downloading',
      'ready',
      'failed',
      'stale'
    )),
    cache_dir_path TEXT NOT NULL DEFAULT '',
    cache_manifest_sha256 TEXT NOT NULL DEFAULT '',
    model_revision TEXT NOT NULL DEFAULT '',
    cache_size_bytes INTEGER NOT NULL DEFAULT 0,
    cache_updated_at TEXT,
    last_verified_at TEXT,
    last_status TEXT NOT NULL DEFAULT 'unknown' CHECK (last_status IN (
      'unknown',
      'available',
      'unavailable',
      'failed'
    )),
    last_error_preview TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
  );
`;

export const CREATE_V4_MATE_SEMANTIC_EMBEDDINGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_semantic_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mate_id TEXT NOT NULL,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('growth_event', 'profile_item', 'tag_catalog')),
    owner_id TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    embedding_backend_type TEXT NOT NULL DEFAULT '',
    embedding_model_id TEXT NOT NULL DEFAULT '',
    dimension INTEGER NOT NULL CHECK (dimension > 0),
    vector_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (owner_type, owner_id, embedding_backend_type, embedding_model_id, text_hash),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_semantic_embeddings_owner
    ON mate_semantic_embeddings(owner_type, owner_id);

  CREATE INDEX IF NOT EXISTS idx_mate_semantic_embeddings_model
    ON mate_semantic_embeddings(embedding_backend_type, embedding_model_id, dimension);
`;

export const CREATE_V4_MATE_GROWTH_EVENT_ACTIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_event_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    growth_event_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'extract',
      'auto_apply',
      'manual_apply',
      'correct',
      'forget',
      'disable',
      'enable',
      'restore',
      'redact',
      'fail'
    )),
    actor TEXT NOT NULL CHECK (actor IN ('system', 'user')),
    revision_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_event_actions_event
    ON mate_growth_event_actions(growth_event_id, id);
`;

export const CREATE_V4_MATE_GROWTH_EVENT_EVIDENCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_growth_event_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    growth_event_id TEXT NOT NULL,
    source_session_id TEXT,
    source_message_id TEXT,
    source_audit_log_id INTEGER,
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
      'message',
      'audit_log',
      'manual_note',
      'system',
      'tool_output',
      'repo_file',
      'terminal_output'
    )),
    source_role TEXT NOT NULL CHECK (source_role IN ('user', 'assistant', 'tool', 'system', 'file')),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'chat_message',
      'tool_output',
      'repo_file',
      'terminal_output',
      'manual_note',
      'system'
    )),
    trust_level TEXT NOT NULL CHECK (trust_level IN (
      'user_authored',
      'assistant_generated',
      'untrusted_external'
    )),
    quote_preview TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_growth_event_evidence_event
    ON mate_growth_event_evidence(growth_event_id, id);
`;

export const CREATE_V4_MATE_PROFILE_ITEMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_items (
    id TEXT PRIMARY KEY,
    mate_id TEXT NOT NULL,
    section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes', 'project_digest')),
    project_digest_id TEXT,
    category TEXT NOT NULL CHECK (category IN ('persona', 'voice', 'preference', 'relationship', 'work_style', 'boundary', 'project_context', 'note')),
    claim_key TEXT NOT NULL,
    claim_value TEXT NOT NULL DEFAULT '',
    claim_value_normalized TEXT NOT NULL DEFAULT '',
    rendered_text TEXT NOT NULL,
    normalized_claim TEXT NOT NULL,
    confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
    salience_score INTEGER NOT NULL DEFAULT 0 CHECK (salience_score BETWEEN 0 AND 100),
    recurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (recurrence_count >= 1),
    projection_allowed INTEGER NOT NULL DEFAULT 0 CHECK (projection_allowed IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'forgotten', 'superseded')),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_revision_id TEXT,
    updated_revision_id TEXT,
    disabled_revision_id TEXT,
    forgotten_revision_id TEXT,
    disabled_at TEXT,
    forgotten_at TEXT,
    superseded_by_item_id TEXT,
    content_redacted INTEGER NOT NULL DEFAULT 0 CHECK (content_redacted IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((section_key = 'project_digest') = (project_digest_id IS NOT NULL)),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (project_digest_id) REFERENCES mate_project_digests(id) ON DELETE CASCADE,
    FOREIGN KEY (created_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (updated_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (disabled_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (forgotten_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (superseded_by_item_id) REFERENCES mate_profile_items(id) ON DELETE SET NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_profile_items_active_claim_global
    ON mate_profile_items(mate_id, section_key, claim_key)
    WHERE state = 'active' AND project_digest_id IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_mate_profile_items_active_claim_project
    ON mate_profile_items(mate_id, project_digest_id, claim_key)
    WHERE state = 'active' AND project_digest_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_mate_profile_items_render
    ON mate_profile_items(mate_id, section_key, state, salience_score DESC, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_mate_profile_items_projection
    ON mate_profile_items(mate_id, section_key, projection_allowed, state, salience_score DESC);
`;

export const CREATE_V4_MATE_PROFILE_ITEM_TAGS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_item_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_item_id TEXT NOT NULL,
    tag_type TEXT NOT NULL,
    tag_value TEXT NOT NULL DEFAULT '',
    tag_value_normalized TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mate_profile_item_tags_item
    ON mate_profile_item_tags(profile_item_id);

  CREATE INDEX IF NOT EXISTS idx_mate_profile_item_tags_lookup
    ON mate_profile_item_tags(tag_type, tag_value_normalized);
`;

export const CREATE_V4_MATE_PROFILE_ITEM_SOURCES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_item_sources (
    profile_item_id TEXT NOT NULL,
    growth_event_id TEXT NOT NULL,
    link_type TEXT NOT NULL CHECK (link_type IN ('created_by', 'reinforced_by', 'corrected_by', 'superseded_by')),
    created_revision_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_item_id, growth_event_id, link_type),
    FOREIGN KEY (profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE,
    FOREIGN KEY (growth_event_id) REFERENCES mate_growth_events(id) ON DELETE CASCADE,
    FOREIGN KEY (created_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_profile_item_sources_event
    ON mate_profile_item_sources(growth_event_id);
`;

export const CREATE_V4_MATE_PROFILE_ITEM_RELATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_profile_item_relations (
    from_profile_item_id TEXT NOT NULL,
    to_profile_item_id TEXT NOT NULL,
    relation_type TEXT NOT NULL CHECK (relation_type IN ('reinforces', 'updates', 'contradicts', 'supersedes')),
    source_growth_event_id TEXT,
    created_revision_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (from_profile_item_id, to_profile_item_id, relation_type),
    FOREIGN KEY (from_profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE,
    FOREIGN KEY (to_profile_item_id) REFERENCES mate_profile_items(id) ON DELETE CASCADE,
    FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
    FOREIGN KEY (created_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_profile_item_relations_to
    ON mate_profile_item_relations(to_profile_item_id, relation_type);
`;

export const CREATE_V4_MATE_FORGOTTEN_TOMBSTONES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_forgotten_tombstones (
    id TEXT PRIMARY KEY,
    mate_id TEXT NOT NULL,
    hmac_digest TEXT NOT NULL,
    hmac_version INTEGER NOT NULL,
    hmac_key_id TEXT NOT NULL DEFAULT 'default',
    digest_kind TEXT NOT NULL CHECK (digest_kind IN ('normalized_claim', 'growth_statement', 'rendered_text')),
    category TEXT NOT NULL CHECK (category IN ('persona', 'voice', 'preference', 'relationship', 'work_style', 'boundary', 'project_context', 'note')),
    section_key TEXT NOT NULL CHECK (section_key IN ('core', 'bond', 'work_style', 'notes', 'project_digest')),
    project_digest_id TEXT,
    source_growth_event_id TEXT,
    source_profile_item_id TEXT,
    redaction_revision_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (mate_id, hmac_version, hmac_key_id, digest_kind, hmac_digest),
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (project_digest_id) REFERENCES mate_project_digests(id) ON DELETE SET NULL,
    FOREIGN KEY (source_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL,
    FOREIGN KEY (source_profile_item_id) REFERENCES mate_profile_items(id) ON DELETE SET NULL,
    FOREIGN KEY (redaction_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );
`;

export const CREATE_V4_MATE_PROJECT_DIGESTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mate_project_digests (
    id TEXT PRIMARY KEY,
    mate_id TEXT NOT NULL,
    project_type TEXT NOT NULL CHECK (project_type IN ('git')),
    project_key TEXT NOT NULL UNIQUE,
    workspace_path TEXT NOT NULL,
    git_root TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL,
    digest_file_path TEXT NOT NULL,
    sha256 TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    active_revision_id TEXT,
    last_growth_event_id TEXT,
    last_compiled_at TEXT,
    disabled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (mate_id) REFERENCES mate_profile(id) ON DELETE CASCADE,
    FOREIGN KEY (active_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (last_growth_event_id) REFERENCES mate_growth_events(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_mate_project_digests_project_key
    ON mate_project_digests(project_key);
`;

export const CREATE_V4_PROVIDER_INSTRUCTION_TARGETS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS provider_instruction_targets (
    provider_id TEXT NOT NULL,
    target_id TEXT NOT NULL DEFAULT 'main',
    enabled INTEGER NOT NULL DEFAULT 0,
    root_directory TEXT NOT NULL DEFAULT '',
    instruction_relative_path TEXT NOT NULL DEFAULT '',
    write_mode TEXT NOT NULL CHECK (write_mode IN ('managed_file', 'managed_block')),
    projection_scope TEXT NOT NULL DEFAULT 'mate_only' CHECK (projection_scope IN ('mate_only')),
    fail_policy TEXT NOT NULL CHECK (fail_policy IN ('block_session', 'warn_continue')),
    requires_restart INTEGER NOT NULL DEFAULT 0,
    last_sync_state TEXT NOT NULL CHECK (last_sync_state IN ('never', 'stale', 'redaction_required', 'synced', 'skipped', 'failed')),
    last_synced_revision_id TEXT,
    last_sync_run_id INTEGER,
    last_error_preview TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, target_id)
  );

  CREATE INDEX IF NOT EXISTS idx_provider_instruction_targets_enabled
    ON provider_instruction_targets(enabled, provider_id, target_id);
`;

export const CREATE_V4_PROVIDER_INSTRUCTION_SYNC_RUNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS provider_instruction_sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    target_id TEXT NOT NULL DEFAULT 'main',
    mate_revision_id TEXT,
    write_mode TEXT NOT NULL,
    projection_scope TEXT NOT NULL,
    projection_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('synced', 'skipped', 'failed')),
    error_preview TEXT NOT NULL DEFAULT '',
    requires_restart INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    FOREIGN KEY (provider_id, target_id) REFERENCES provider_instruction_targets(provider_id, target_id) ON DELETE CASCADE,
    FOREIGN KEY (mate_revision_id) REFERENCES mate_profile_revisions(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_provider_instruction_sync_runs_provider
    ON provider_instruction_sync_runs(provider_id, target_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_provider_instruction_sync_runs_revision
    ON provider_instruction_sync_runs(mate_revision_id, id DESC);
`;

export const CREATE_V4_SCHEMA_SQL = [
  CREATE_V4_MATE_PROFILE_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_SECTIONS_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_REVISIONS_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_REVISION_SECTIONS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_SETTINGS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_MODEL_PREFERENCES_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_RUNS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_CURSORS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_EVENTS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_EVENT_LINKS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_EVENT_PROFILE_ITEM_LINKS_TABLE_SQL,
  CREATE_V4_MATE_MEMORY_TAGS_TABLE_SQL,
  CREATE_V4_MATE_MEMORY_TAG_CATALOG_TABLE_SQL,
  CREATE_V4_MATE_EMBEDDING_SETTINGS_TABLE_SQL,
  CREATE_V4_MATE_SEMANTIC_EMBEDDINGS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_EVENT_ACTIONS_TABLE_SQL,
  CREATE_V4_MATE_GROWTH_EVENT_EVIDENCE_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_ITEMS_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_ITEM_TAGS_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_ITEM_SOURCES_TABLE_SQL,
  CREATE_V4_MATE_PROFILE_ITEM_RELATIONS_TABLE_SQL,
  CREATE_V4_MATE_FORGOTTEN_TOMBSTONES_TABLE_SQL,
  CREATE_V4_MATE_PROJECT_DIGESTS_TABLE_SQL,
  CREATE_V4_PROVIDER_INSTRUCTION_TARGETS_TABLE_SQL,
  CREATE_V4_PROVIDER_INSTRUCTION_SYNC_RUNS_TABLE_SQL,
] as const;
