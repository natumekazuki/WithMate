import type { DatabaseSync } from "node:sqlite";

export function ensureSessionAuthoritySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_authority_operation_registry_v6 (
      operation TEXT PRIMARY KEY,
      mapping_revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      scope_source TEXT NOT NULL,
      effect_class TEXT NOT NULL,
      decision_class TEXT NOT NULL,
      CHECK (mapping_revision > 0),
      CHECK (effect_class IN ('read', 'local_mutation', 'external_side_effect')),
      CHECK (decision_class IN ('agent_delegable', 'user_only', 'deny_or_cancel'))
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_authority_grants_v6 (
      grant_id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      issuer_kind TEXT NOT NULL,
      issuer_id TEXT NOT NULL,
      issuer_grant_id TEXT,
      issuer_grant_revision INTEGER,
      grantee_session_id TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      relation_selector TEXT NOT NULL,
      target_session_roles_json TEXT NOT NULL,
      effect_class TEXT NOT NULL,
      delegable INTEGER NOT NULL,
      child_ceiling_json TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      revision INTEGER NOT NULL,
      mapping_revision INTEGER NOT NULL,
      provenance_json TEXT NOT NULL,
      CHECK (issuer_kind IN ('user', 'agent', 'system')),
      CHECK ((issuer_grant_id IS NULL) = (issuer_grant_revision IS NULL)),
      CHECK (json_valid(actions_json)),
      CHECK (json_type(actions_json) = 'array'),
      CHECK (json_valid(target_session_roles_json)),
      CHECK (json_type(target_session_roles_json) = 'array'),
      CHECK (effect_class IN ('read', 'local_mutation', 'external_side_effect')),
      CHECK (delegable IN (0, 1)),
      CHECK (json_valid(child_ceiling_json)),
      CHECK (json_type(child_ceiling_json) = 'array'),
      CHECK (revision > 0),
      CHECK (mapping_revision > 0),
      CHECK (json_valid(provenance_json))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS session_authority_grants_active_v6
      ON session_authority_grants_v6(grantee_session_id, root_session_id, revoked_at, effective_at, expires_at);

    CREATE INDEX IF NOT EXISTS session_authority_grants_issuer_v6
      ON session_authority_grants_v6(issuer_grant_id, revoked_at);

    CREATE TABLE IF NOT EXISTS session_authority_grant_events_v6 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      grant_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      grant_revision INTEGER NOT NULL,
      principal_kind TEXT NOT NULL,
      actor_session_id TEXT,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      CHECK (event_kind IN ('baseline_issued', 'delegated', 'revoked')),
      CHECK (grant_revision > 0),
      CHECK (principal_kind IN ('user', 'agent', 'system')),
      CHECK (json_valid(payload_json))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS session_authority_grant_events_grant_v6
      ON session_authority_grant_events_v6(grant_id, sequence);

    CREATE TABLE IF NOT EXISTS resource_event_headers_v6 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      resource_revision INTEGER,
      principal_kind TEXT NOT NULL,
      actor_session_id TEXT,
      grant_id TEXT,
      grant_revision INTEGER,
      operation_id TEXT NOT NULL,
      idempotency_key_fingerprint TEXT,
      occurred_at TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      supersedes_event_id TEXT,
      payload_schema_revision INTEGER NOT NULL,
      effect TEXT NOT NULL,
      CHECK (owner_kind = 'session'),
      CHECK (resource_revision IS NULL OR resource_revision > 0),
      CHECK (principal_kind IN ('user', 'agent', 'system')),
      CHECK ((grant_id IS NULL) = (grant_revision IS NULL)),
      CHECK (payload_schema_revision > 0),
      CHECK (effect IN ('none', 'committed', 'unknown'))
    ) STRICT;

    CREATE INDEX IF NOT EXISTS resource_event_headers_resource_v6
      ON resource_event_headers_v6(resource_kind, resource_id, sequence);
    CREATE INDEX IF NOT EXISTS resource_event_headers_root_v6
      ON resource_event_headers_v6(root_id, sequence);

    CREATE TRIGGER IF NOT EXISTS session_authority_grant_events_no_update_v6
    BEFORE UPDATE ON session_authority_grant_events_v6
    BEGIN
      SELECT RAISE(ABORT, 'authority grant events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_authority_grant_events_no_delete_v6
    BEFORE DELETE ON session_authority_grant_events_v6
    BEGIN
      SELECT RAISE(ABORT, 'authority grant events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS resource_event_headers_no_update_v6
    BEFORE UPDATE ON resource_event_headers_v6
    BEGIN
      SELECT RAISE(ABORT, 'resource event headers are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS resource_event_headers_no_delete_v6
    BEFORE DELETE ON resource_event_headers_v6
    BEGIN
      SELECT RAISE(ABORT, 'resource event headers are append-only');
    END;
  `);
}
