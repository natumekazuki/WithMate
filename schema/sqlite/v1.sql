CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
  workspace_key TEXT NOT NULL CHECK (length(workspace_key) > 0),
  allowed_additional_directories_json TEXT NOT NULL
    CHECK (json_valid(allowed_additional_directories_json)
      AND json_type(allowed_additional_directories_json) = 'array'),
  default_character_id TEXT NOT NULL CHECK (length(default_character_id) > 0),
  max_concurrent_child_runs INTEGER NOT NULL CHECK (max_concurrent_child_runs >= 0),
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active', 'archived', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= created_at)
) STRICT;

CREATE INDEX sessions_lifecycle_activity_idx
  ON sessions(lifecycle_status, last_activity_at DESC, id DESC);
CREATE INDEX sessions_workspace_activity_idx
  ON sessions(workspace_key, last_activity_at DESC, id DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_blocks_json TEXT NOT NULL
    CHECK (json_valid(content_blocks_json)
      AND json_type(content_blocks_json) = 'array'
      AND length(CAST(content_blocks_json AS BLOB)) <= 4194304),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX messages_session_ordinal_uq ON messages(session_id, ordinal);
CREATE UNIQUE INDEX messages_id_session_uq ON messages(id, session_id);
CREATE INDEX messages_session_created_idx ON messages(session_id, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  initiating_message_id TEXT NOT NULL,
  final_assistant_message_id TEXT,
  retry_of_run_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN (
    'queued', 'starting', 'active', 'canceling', 'finalizing',
    'completed', 'failed', 'canceled', 'interrupted'
  )),
  execution_snapshot_json TEXT NOT NULL
    CHECK (json_valid(execution_snapshot_json)
      AND json_type(execution_snapshot_json) = 'object'),
  failure_origin TEXT CHECK (failure_origin IN (
    'provider', 'transport', 'process', 'application', 'persistence', 'unknown'
  )),
  provider_error_code TEXT,
  error_summary TEXT,
  cancel_requested_at INTEGER,
  cancel_acknowledged_at INTEGER,
  terminal_event_received_at INTEGER,
  external_side_effect_state TEXT NOT NULL
    CHECK (external_side_effect_state IN ('none', 'present', 'unknown')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  terminal_at INTEGER,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  CHECK ((phase IN ('completed', 'failed', 'canceled', 'interrupted')) = (terminal_at IS NOT NULL)),
  CHECK (final_assistant_message_id IS NULL OR phase = 'completed'),
  CHECK (phase NOT IN ('failed', 'interrupted') OR failure_origin IS NOT NULL),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (initiating_message_id, session_id)
    REFERENCES messages(id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (final_assistant_message_id, session_id)
    REFERENCES messages(id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (retry_of_run_id, session_id)
    REFERENCES runs(id, session_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX runs_one_non_terminal_per_session_uq
  ON runs(session_id)
  WHERE phase IN ('queued', 'starting', 'active', 'canceling', 'finalizing');
CREATE UNIQUE INDEX runs_session_ordinal_uq ON runs(session_id, ordinal);
CREATE UNIQUE INDEX runs_id_session_uq ON runs(id, session_id);
CREATE INDEX runs_session_phase_updated_idx ON runs(session_id, phase, updated_at DESC);
CREATE INDEX runs_initiating_message_idx ON runs(initiating_message_id);
CREATE INDEX runs_retry_of_idx ON runs(retry_of_run_id) WHERE retry_of_run_id IS NOT NULL;

CREATE TABLE provider_bindings (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
  external_conversation_id TEXT,
  persistence_mode TEXT NOT NULL CHECK (persistence_mode IN ('persistent', 'ephemeral')),
  binding_state TEXT NOT NULL
    CHECK (binding_state IN ('creating', 'active', 'invalidated', 'superseded')),
  created_by_run_attempt_id TEXT NOT NULL,
  superseded_by_binding_id TEXT,
  invalidated_at INTEGER,
  invalidation_reason TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (binding_state = 'creating'
      AND external_conversation_id IS NULL
      AND superseded_by_binding_id IS NULL
      AND invalidated_at IS NULL
      AND invalidation_reason IS NULL)
    OR
    (binding_state = 'active'
      AND external_conversation_id IS NOT NULL
      AND superseded_by_binding_id IS NULL
      AND invalidated_at IS NULL
      AND invalidation_reason IS NULL)
    OR
    (binding_state = 'invalidated'
      AND superseded_by_binding_id IS NULL
      AND invalidated_at IS NOT NULL
      AND invalidation_reason IS NOT NULL)
    OR
    (binding_state = 'superseded'
      AND external_conversation_id IS NOT NULL
      AND superseded_by_binding_id IS NOT NULL
      AND invalidated_at IS NOT NULL
      AND invalidation_reason IS NOT NULL)
  ),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_run_attempt_id) REFERENCES run_attempts(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (superseded_by_binding_id) REFERENCES provider_bindings(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX provider_bindings_one_open_per_session_uq
  ON provider_bindings(session_id)
  WHERE binding_state IN ('creating', 'active');
CREATE UNIQUE INDEX provider_bindings_session_ordinal_uq
  ON provider_bindings(session_id, ordinal);
CREATE UNIQUE INDEX provider_bindings_external_conversation_uq
  ON provider_bindings(provider_id, external_conversation_id)
  WHERE external_conversation_id IS NOT NULL;
CREATE INDEX provider_bindings_state_idx ON provider_bindings(binding_state, invalidated_at);

CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  provider_binding_id TEXT,
  attempt_reason TEXT NOT NULL CHECK (attempt_reason IN ('initial', 'stale_binding_recovery')),
  attempt_state TEXT NOT NULL
    CHECK (attempt_state IN ('preparing', 'active', 'succeeded', 'failed', 'interrupted')),
  external_execution_id TEXT,
  failure_origin TEXT CHECK (failure_origin IN (
    'provider', 'transport', 'process', 'application', 'unknown'
  )),
  provider_error_code TEXT,
  error_summary TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  terminal_at INTEGER,
  CHECK ((ordinal = 1 AND attempt_reason = 'initial')
    OR (ordinal >= 2 AND attempt_reason = 'stale_binding_recovery')),
  CHECK ((attempt_state IN ('succeeded', 'failed', 'interrupted')) = (terminal_at IS NOT NULL)),
  CHECK (attempt_state NOT IN ('active', 'succeeded')
    OR (provider_binding_id IS NOT NULL AND started_at IS NOT NULL AND external_execution_id IS NOT NULL)),
  CHECK (attempt_state NOT IN ('failed', 'interrupted') OR failure_origin IS NOT NULL),
  CHECK (attempt_state != 'succeeded'
    OR (failure_origin IS NULL AND provider_error_code IS NULL AND error_summary IS NULL)),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_binding_id) REFERENCES provider_bindings(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX run_attempts_one_non_terminal_per_run_uq
  ON run_attempts(run_id) WHERE attempt_state IN ('preparing', 'active');
CREATE UNIQUE INDEX run_attempts_one_succeeded_per_run_uq
  ON run_attempts(run_id) WHERE attempt_state = 'succeeded';
CREATE UNIQUE INDEX run_attempts_run_ordinal_uq ON run_attempts(run_id, ordinal);
CREATE UNIQUE INDEX run_attempts_binding_external_uq
  ON run_attempts(provider_binding_id, external_execution_id)
  WHERE external_execution_id IS NOT NULL;

CREATE TABLE run_dispatches (
  run_attempt_id TEXT PRIMARY KEY,
  dispatch_state TEXT NOT NULL
    CHECK (dispatch_state IN ('pending', 'dispatching', 'accepted', 'rejected', 'ambiguous', 'aborted')),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  provider_idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  dispatching_at INTEGER,
  resolved_at INTEGER,
  CHECK (
    (dispatch_state = 'pending' AND dispatching_at IS NULL AND resolved_at IS NULL)
    OR (dispatch_state = 'dispatching' AND dispatching_at IS NOT NULL AND resolved_at IS NULL)
    OR (dispatch_state IN ('accepted', 'rejected', 'ambiguous')
      AND dispatching_at IS NOT NULL AND resolved_at IS NOT NULL)
    OR (dispatch_state = 'aborted' AND dispatching_at IS NULL AND resolved_at IS NOT NULL)
  ),
  FOREIGN KEY (run_attempt_id) REFERENCES run_attempts(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX run_dispatches_state_created_idx ON run_dispatches(dispatch_state, created_at);

CREATE TABLE idempotency_records (
  idempotency_key TEXT PRIMARY KEY
    CHECK (length(idempotency_key) = 36
      AND idempotency_key = lower(idempotency_key)
      AND substr(idempotency_key, 9, 1) = '-'
      AND substr(idempotency_key, 14, 1) = '-'
      AND substr(idempotency_key, 19, 1) = '-'
      AND substr(idempotency_key, 24, 1) = '-'
      AND length(replace(idempotency_key, '-', '')) = 32
      AND replace(idempotency_key, '-', '') NOT GLOB '*[^0-9a-f]*'),
  scope_session_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  record_state TEXT NOT NULL CHECK (record_state IN ('in_progress', 'completed', 'expired')),
  response_kind TEXT CHECK (response_kind IN ('success', 'error')),
  response_ref_type TEXT CHECK (response_ref_type IN ('run', 'session', 'delivery', 'interaction', 'none')),
  response_ref_id TEXT,
  response_envelope_json TEXT
    CHECK (response_envelope_json IS NULL OR (
      json_valid(response_envelope_json)
      AND json_type(response_envelope_json) = 'object'
      AND length(CAST(response_envelope_json AS BLOB)) <= 16384
    )),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER,
  CHECK (
    (record_state = 'in_progress'
      AND response_kind IS NULL AND response_ref_type IS NULL
      AND response_ref_id IS NULL AND response_envelope_json IS NULL
      AND completed_at IS NULL AND expires_at IS NULL)
    OR
    (record_state = 'completed'
      AND response_kind IS NOT NULL AND response_ref_type IS NOT NULL
      AND response_envelope_json IS NOT NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL
      AND ((response_ref_type = 'none' AND response_ref_id IS NULL)
        OR (response_ref_type <> 'none' AND response_ref_id IS NOT NULL)))
    OR
    (record_state = 'expired'
      AND response_kind IS NULL AND response_ref_type IS NULL
      AND response_ref_id IS NULL AND response_envelope_json IS NULL
      AND completed_at IS NOT NULL AND expires_at IS NOT NULL)
  ),
  FOREIGN KEY (scope_session_id) REFERENCES sessions(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idempotency_records_state_created_idx
  ON idempotency_records(record_state, created_at);
CREATE INDEX idempotency_records_expires_idx
  ON idempotency_records(expires_at) WHERE record_state = 'completed';
CREATE INDEX idempotency_records_scope_session_idx
  ON idempotency_records(scope_session_id, created_at);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  event_code TEXT NOT NULL CHECK (length(event_code) BETWEEN 1 AND 64),
  subject_type TEXT,
  subject_id TEXT,
  dedupe_key TEXT,
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 1024),
  created_at INTEGER NOT NULL,
  CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX run_events_run_ordinal_uq ON run_events(run_id, ordinal);
CREATE UNIQUE INDEX run_events_run_dedupe_uq
  ON run_events(run_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX run_events_run_code_ordinal_idx ON run_events(run_id, event_code, ordinal);

CREATE TABLE run_input_deliveries (
  message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  run_attempt_id TEXT NOT NULL,
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('pending', 'dispatching', 'accepted', 'rejected', 'ambiguous')),
  resolution_code TEXT CHECK (resolution_code IS NULL OR length(resolution_code) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL,
  dispatching_at INTEGER,
  resolved_at INTEGER,
  CHECK (
    (delivery_state = 'pending'
      AND dispatching_at IS NULL AND resolved_at IS NULL AND resolution_code IS NULL)
    OR (delivery_state = 'dispatching'
      AND dispatching_at IS NOT NULL AND resolved_at IS NULL AND resolution_code IS NULL)
    OR (delivery_state = 'accepted'
      AND dispatching_at IS NOT NULL AND resolved_at IS NOT NULL AND resolution_code IS NULL)
    OR (delivery_state IN ('rejected', 'ambiguous')
      AND dispatching_at IS NOT NULL AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  ),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (run_attempt_id) REFERENCES run_attempts(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX run_input_deliveries_run_state_idx
  ON run_input_deliveries(run_id, delivery_state, created_at);
CREATE INDEX run_input_deliveries_attempt_state_idx
  ON run_input_deliveries(run_attempt_id, delivery_state);

CREATE TABLE run_output_items (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  category TEXT NOT NULL CHECK (category IN (
    'assistant_detail', 'operation', 'interaction', 'telemetry', 'diagnostic', 'provider_metadata'
  )),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  provider_item_id TEXT,
  summary TEXT NOT NULL CHECK (length(CAST(summary AS BLOB)) <= 4096),
  completion_state TEXT NOT NULL CHECK (completion_state IN ('complete', 'partial')),
  payload_state TEXT NOT NULL CHECK (payload_state IN (
    'none', 'pending', 'stored', 'omitted_size_limit',
    'omitted_redaction', 'omitted_persistence'
  )),
  payload_original_byte_length INTEGER CHECK (payload_original_byte_length >= 0),
  stored_payload_id TEXT,
  redaction_state TEXT NOT NULL CHECK (redaction_state IN ('not_required', 'redacted', 'unknown')),
  created_at INTEGER NOT NULL,
  CHECK (
    (payload_state = 'none'
      AND payload_original_byte_length IS NULL AND stored_payload_id IS NULL
      AND redaction_state = 'not_required')
    OR (payload_state IN ('pending', 'stored', 'omitted_size_limit', 'omitted_persistence')
      AND payload_original_byte_length IS NOT NULL
      AND redaction_state IN ('not_required', 'redacted')
      AND ((payload_state = 'stored' AND stored_payload_id = id)
        OR (payload_state <> 'stored' AND stored_payload_id IS NULL)))
    OR (payload_state = 'omitted_redaction'
      AND payload_original_byte_length IS NOT NULL AND stored_payload_id IS NULL
      AND redaction_state = 'unknown')
  ),
  CHECK (payload_state <> 'stored' OR redaction_state <> 'unknown'),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (stored_payload_id) REFERENCES run_output_payloads(output_item_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX run_output_items_run_ordinal_uq ON run_output_items(run_id, ordinal);
CREATE UNIQUE INDEX run_output_items_provider_item_uq
  ON run_output_items(run_id, provider_item_id) WHERE provider_item_id IS NOT NULL;
CREATE INDEX run_output_items_run_category_ordinal_idx
  ON run_output_items(run_id, category, ordinal);

CREATE TABLE run_output_payloads (
  output_item_id TEXT PRIMARY KEY,
  payload_format TEXT NOT NULL CHECK (payload_format IN ('text', 'json', 'binary')),
  media_type TEXT,
  content BLOB NOT NULL,
  byte_length INTEGER NOT NULL
    CHECK (byte_length BETWEEN 0 AND 16777216 AND byte_length = length(content)),
  content_sha256 TEXT NOT NULL
    CHECK (length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (output_item_id) REFERENCES run_output_items(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE session_relations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  orchestration_root_session_id TEXT NOT NULL,
  created_by_parent_run_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL CHECK (length(correlation_id) > 0),
  label TEXT CHECK (label IS NULL OR length(label) <= 128),
  purpose_summary TEXT CHECK (purpose_summary IS NULL OR length(purpose_summary) <= 512),
  created_at INTEGER NOT NULL,
  CHECK (parent_session_id <> child_session_id),
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (child_session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (orchestration_root_session_id) REFERENCES sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_parent_run_id, parent_session_id)
    REFERENCES runs(id, session_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX session_relations_parent_created_idx
  ON session_relations(parent_session_id, created_at);
CREATE INDEX session_relations_root_created_idx
  ON session_relations(orchestration_root_session_id, created_at);
CREATE INDEX session_relations_root_child_idx
  ON session_relations(orchestration_root_session_id, child_session_id);
CREATE UNIQUE INDEX session_relations_correlation_uq ON session_relations(correlation_id);
CREATE UNIQUE INDEX session_relations_child_uq ON session_relations(child_session_id);

CREATE TABLE delegations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  session_relation_id TEXT NOT NULL,
  initial_instruction_message_id TEXT NOT NULL,
  latest_instruction_message_id TEXT NOT NULL,
  latest_child_run_id TEXT NOT NULL,
  mention_text TEXT CHECK (mention_text IS NULL OR length(mention_text) <= 128),
  workflow_state TEXT NOT NULL CHECK (workflow_state IN ('active', 'clarification_required', 'closed')),
  closure_reason TEXT CHECK (closure_reason IN (
    'completed', 'failed', 'canceled', 'interrupted', 'abandoned'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  CHECK ((workflow_state = 'closed') = (closure_reason IS NOT NULL)),
  FOREIGN KEY (session_relation_id) REFERENCES session_relations(id) ON DELETE RESTRICT,
  FOREIGN KEY (initial_instruction_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (latest_instruction_message_id) REFERENCES messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (latest_child_run_id) REFERENCES runs(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX delegations_relation_uq ON delegations(session_relation_id);
CREATE INDEX delegations_state_updated_idx ON delegations(workflow_state, updated_at DESC);
CREATE INDEX delegations_latest_run_idx ON delegations(latest_child_run_id);

CREATE TABLE child_result_deliveries (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  delegation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  child_run_id TEXT NOT NULL,
  availability_state TEXT NOT NULL CHECK (availability_state IN ('pending', 'available')),
  terminal_phase_snapshot TEXT CHECK (terminal_phase_snapshot IN (
    'completed', 'failed', 'canceled', 'interrupted'
  )),
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 1024),
  available_at INTEGER,
  first_collected_by_parent_run_id TEXT,
  first_collected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  CHECK ((availability_state = 'pending'
      AND terminal_phase_snapshot IS NULL AND result_summary IS NULL AND available_at IS NULL)
    OR (availability_state = 'available'
      AND terminal_phase_snapshot IS NOT NULL AND available_at IS NOT NULL)),
  CHECK ((first_collected_by_parent_run_id IS NULL) = (first_collected_at IS NULL)),
  FOREIGN KEY (delegation_id) REFERENCES delegations(id) ON DELETE RESTRICT,
  FOREIGN KEY (child_run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_collected_by_parent_run_id) REFERENCES runs(id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX child_result_deliveries_run_uq ON child_result_deliveries(child_run_id);
CREATE UNIQUE INDEX child_result_deliveries_delegation_ordinal_uq
  ON child_result_deliveries(delegation_id, ordinal);
CREATE INDEX child_result_deliveries_availability_idx
  ON child_result_deliveries(availability_state, first_collected_at, available_at);
CREATE INDEX child_result_deliveries_delegation_idx
  ON child_result_deliveries(delegation_id, ordinal);
