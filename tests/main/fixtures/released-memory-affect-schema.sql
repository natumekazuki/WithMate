-- Synthetic schema captured from e60cee1cc31a805be29bfa42c98bddce6a6f113e.
-- Release preview.6 and this restoration point have identical storage schema.

  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );


  CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_prompt_templates_name
    ON prompt_templates(name COLLATE NOCASE);


  CREATE TABLE IF NOT EXISTS provider_model_cache (
    provider_id TEXT NOT NULL,
    provider_json TEXT NOT NULL,
    context_key TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, context_key)
  );


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

CREATE TABLE IF NOT EXISTS coordination_records_v7 (
    id TEXT PRIMARY KEY, crew_root_session_id TEXT NOT NULL REFERENCES sessions_v6(id) ON DELETE CASCADE,
    initiator_session_id TEXT NOT NULL, initiator_kind TEXT NOT NULL, initiator_incarnation_id TEXT NOT NULL,
    respondent_session_id TEXT, respondent_kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','resolved','withdrawn','corrected')), payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
  );
  CREATE INDEX IF NOT EXISTS idx_coordination_v7_crew ON coordination_records_v7(crew_root_session_id,state);
  CREATE INDEX IF NOT EXISTS idx_coordination_v7_respondent ON coordination_records_v7(respondent_session_id,state);

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


  CREATE TABLE IF NOT EXISTS session_graphs_v6 (
    session_id TEXT PRIMARY KEY REFERENCES sessions_v6(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
  );
  CREATE TABLE IF NOT EXISTS session_graph_topics_v6 (
    session_id TEXT NOT NULL REFERENCES session_graphs_v6(session_id) ON DELETE CASCADE,
    id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
  );
  CREATE TABLE IF NOT EXISTS session_graph_records_v6 (
    session_id TEXT NOT NULL, id TEXT NOT NULL, topic_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('requirement', 'constraint', 'decision', 'activity', 'observation', 'issue')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id, topic_id) REFERENCES session_graph_topics_v6(session_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_session_graph_records_topic ON session_graph_records_v6(session_id, topic_id, updated_at DESC, id);
  CREATE INDEX IF NOT EXISTS idx_session_graph_records_recent ON session_graph_records_v6(session_id, updated_at DESC, id);
  CREATE TABLE IF NOT EXISTS session_graph_relations_v6 (
    session_id TEXT NOT NULL, id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), PRIMARY KEY (session_id, id),
    FOREIGN KEY (session_id, from_id) REFERENCES session_graph_records_v6(session_id, id) ON DELETE CASCADE,
    FOREIGN KEY (session_id, to_id) REFERENCES session_graph_records_v6(session_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_session_graph_relations_from ON session_graph_relations_v6(session_id, from_id);
  CREATE INDEX IF NOT EXISTS idx_session_graph_relations_to ON session_graph_relations_v6(session_id, to_id);


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
    custom_agent_name TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    display_after_message_index INTEGER,
    character_id TEXT,
    character_snapshot_json TEXT,
    character_snapshot_invalid INTEGER NOT NULL DEFAULT 0,
    character_icon_path TEXT,
    client_request_id TEXT,
    creation_context_json TEXT,
    creation_request_json TEXT
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
    source_auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE SET NULL,
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


  CREATE TABLE IF NOT EXISTS character_affect_events_v6 (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    source_session_id TEXT,
    layer TEXT NOT NULL CHECK (layer IN ('relationship', 'session')),
    target_type TEXT NOT NULL CHECK (target_type IN ('user', 'character', 'relationship', 'task', 'bug', 'artifact', 'self')),
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
    auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE CASCADE,
    source_auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    FOREIGN KEY (source_session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (correction_of_event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (memory_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (supersedes_memory_entry_id) REFERENCES memory_entries_v6(id) ON DELETE SET NULL,
    UNIQUE (character_id, user_id, idempotency_key),
    CHECK (user_id <> ''),
    CHECK (target_id <> ''),
    CHECK (layer <> 'relationship' OR target_type IN ('user', 'character', 'relationship')),
    CHECK (session_id IS NULL OR auxiliary_session_id IS NULL),
    CHECK (source_session_id IS NULL OR source_auxiliary_session_id IS NULL),
    CHECK (
      (layer = 'session' AND session_id IS NOT NULL AND source_session_id = session_id AND auxiliary_session_id IS NULL)
      OR (layer = 'session' AND auxiliary_session_id IS NOT NULL AND source_auxiliary_session_id = auxiliary_session_id AND session_id IS NULL)
      OR (layer = 'relationship' AND session_id IS NULL AND auxiliary_session_id IS NULL)
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
    auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE CASCADE,
    UNIQUE (character_id, user_id, idempotency_key),
    CHECK ((layer = 'session' AND ((session_id IS NOT NULL AND auxiliary_session_id IS NULL) OR (session_id IS NULL AND auxiliary_session_id IS NOT NULL))) OR (layer = 'relationship' AND session_id IS NULL AND auxiliary_session_id IS NULL))
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
    auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE SET NULL,
    source_auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE SET NULL,
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
    auxiliary_session_id TEXT REFERENCES auxiliary_sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (event_id) REFERENCES character_affect_events_v6(id) ON DELETE SET NULL,
    FOREIGN KEY (reset_id) REFERENCES character_affect_resets_v6(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_observations_scope
    ON character_affect_observations_v6(character_id, user_id, created_at DESC, id DESC);
  
  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_events_auxiliary_effective
    ON character_affect_events_v6(character_id, user_id, layer, auxiliary_session_id, state, occurred_at, id);
  CREATE INDEX IF NOT EXISTS idx_v6_character_affect_resets_auxiliary_scope
    ON character_affect_resets_v6(character_id, user_id, layer, auxiliary_session_id, reset_at DESC, id DESC);


PRAGMA user_version = 6;

