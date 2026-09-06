import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const AUTHORITY_SCHEMA_SAVEPOINT = "session_interaction_authority_schema";

export function ensureSessionInteractionAuthoritySchema(
  db: DatabaseSync,
  options: { backfillLegacyHistory: boolean } = {
    backfillLegacyHistory: !tableExists(db, "session_interaction_events_v6"),
  },
): void {
  db.exec(`SAVEPOINT ${AUTHORITY_SCHEMA_SAVEPOINT};`);
  try {
    const interactionColumns = tableColumnNames(db, "session_interactions_v6");
    if (interactionColumns.size === 0) {
      throw new Error("Session interaction base schema is missing.");
    }
    if (!interactionColumns.has("decision_class")) {
      db.exec(`
        ALTER TABLE session_interactions_v6
          ADD COLUMN decision_class TEXT NOT NULL DEFAULT 'user_only'
          CHECK (decision_class IN ('user_only', 'agent_delegable', 'deny_or_cancel'));
      `);
    }
    if (!interactionColumns.has("revision")) {
      db.exec(`
        ALTER TABLE session_interactions_v6
          ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
        UPDATE session_interactions_v6
        SET revision = CASE WHEN state = 'pending' THEN 1 ELSE 2 END;
      `);
    }
    if (!interactionColumns.has("response_principal_kind")) {
      db.exec(`
        ALTER TABLE session_interactions_v6
          ADD COLUMN response_principal_kind TEXT
          CHECK (response_principal_kind IS NULL OR response_principal_kind IN ('user', 'agent', 'system'));
      `);
    }
    if (!interactionColumns.has("response_actor_session_id")) {
      db.exec("ALTER TABLE session_interactions_v6 ADD COLUMN response_actor_session_id TEXT;");
    }

    ensurePrincipalScopedIdempotency(db);

    db.exec(`
      UPDATE session_interactions_v6
      SET response_principal_kind = 'system',
          response_actor_session_id = NULL
      WHERE state = 'expired' AND response_principal_kind IS NULL;
    `);

    db.exec(CREATE_SESSION_INTERACTION_EVENTS_SQL);
    if (options.backfillLegacyHistory) {
      backfillInteractionBaselines(db);
      backfillInteractionEventHeaders(db);
    }
    db.exec(`RELEASE SAVEPOINT ${AUTHORITY_SCHEMA_SAVEPOINT};`);
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${AUTHORITY_SCHEMA_SAVEPOINT};`);
    } finally {
      db.exec(`RELEASE SAVEPOINT ${AUTHORITY_SCHEMA_SAVEPOINT};`);
    }
    throw error;
  }
}

function ensurePrincipalScopedIdempotency(db: DatabaseSync): void {
  const columns = tableColumnNames(db, "session_interaction_idempotency_v6");
  if (columns.has("principal_kind") && columns.has("principal_id") && columns.has("result_revision")) {
    return;
  }
  db.exec(`
    ALTER TABLE session_interaction_idempotency_v6
      RENAME TO session_interaction_idempotency_v6_legacy_authority;
    DROP INDEX IF EXISTS idx_v6_session_interaction_idempotency_interaction;
    DROP INDEX IF EXISTS idx_v6_session_interaction_idempotency_expires;

    CREATE TABLE session_interaction_idempotency_v6 (
      operation TEXT NOT NULL CHECK (operation = 'interaction.respond'),
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'agent', 'legacy_unknown')),
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (operation, principal_kind, principal_id, idempotency_key),
      FOREIGN KEY (interaction_id) REFERENCES session_interactions_v6(id) ON DELETE CASCADE
    );

    INSERT INTO session_interaction_idempotency_v6 (
      operation, principal_kind, principal_id, idempotency_key, request_fingerprint,
      interaction_id, result_revision, created_at, expires_at
    )
    SELECT
      legacy.operation,
      'legacy_unknown',
      'migration',
      legacy.idempotency_key,
      legacy.request_fingerprint,
      legacy.interaction_id,
      interactions.revision,
      legacy.created_at,
      legacy.expires_at
    FROM session_interaction_idempotency_v6_legacy_authority AS legacy
    INNER JOIN session_interactions_v6 AS interactions ON interactions.id = legacy.interaction_id;

    DROP TABLE session_interaction_idempotency_v6_legacy_authority;

    CREATE INDEX idx_v6_session_interaction_idempotency_interaction
      ON session_interaction_idempotency_v6(interaction_id);
    CREATE INDEX idx_v6_session_interaction_idempotency_expires
      ON session_interaction_idempotency_v6(expires_at);
  `);
}

const CREATE_SESSION_INTERACTION_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS session_interaction_events_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    interaction_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    interaction_revision INTEGER NOT NULL CHECK (interaction_revision >= 1),
    event_kind TEXT NOT NULL CHECK (event_kind IN ('created', 'migration_baseline', 'answered', 'expired')),
    decision_class TEXT NOT NULL CHECK (decision_class IN ('user_only', 'agent_delegable', 'deny_or_cancel')),
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'agent', 'system')),
    actor_session_id TEXT,
    idempotency_key_fingerprint TEXT,
    projection_json TEXT NOT NULL
      CHECK (json_valid(projection_json))
      CHECK (length(CAST(projection_json AS BLOB)) <= 524288),
    response_action TEXT CHECK (
      response_action IS NULL OR response_action IN ('approve', 'deny', 'accept', 'decline', 'cancel')
    ),
    response_submitted_fields_json TEXT CHECK (
      response_submitted_fields_json IS NULL OR json_valid(response_submitted_fields_json)
    ),
    expiry_reason TEXT CHECK (
      expiry_reason IS NULL OR expiry_reason IN (
        'runtime_restarted', 'runtime_shutdown', 'execution_canceled', 'execution_terminal'
      )
    ),
    occurred_at TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    UNIQUE (interaction_id, interaction_revision)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v6_session_interaction_events_session_sequence
    ON session_interaction_events_v6(session_id, sequence ASC);
  CREATE INDEX IF NOT EXISTS idx_v6_session_interaction_events_execution_sequence
    ON session_interaction_events_v6(execution_id, sequence ASC);

  CREATE TRIGGER IF NOT EXISTS session_interaction_events_no_update_v6
  BEFORE UPDATE ON session_interaction_events_v6 BEGIN
    SELECT RAISE(ABORT, 'session interaction events are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS session_interaction_events_no_delete_v6
  BEFORE DELETE ON session_interaction_events_v6 BEGIN
    SELECT RAISE(ABORT, 'session interaction events are append-only');
  END;
`;

function backfillInteractionBaselines(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT interactions.*, executions.session_id, idempotency.idempotency_key
    FROM session_interactions_v6 AS interactions
    INNER JOIN session_executions_v6 AS executions ON executions.id = interactions.execution_id
    LEFT JOIN session_interaction_idempotency_v6 AS idempotency
      ON idempotency.interaction_id = interactions.id
    WHERE NOT EXISTS (
      SELECT 1 FROM session_interaction_events_v6 AS events
      WHERE events.interaction_id = interactions.id
    )
    ORDER BY interactions.sequence ASC
  `).all() as Array<Record<string, string | number | null>>;
  const insert = db.prepare(`
    INSERT INTO session_interaction_events_v6 (
      id, interaction_id, session_id, execution_id, interaction_revision, event_kind,
      decision_class, principal_kind, actor_session_id, idempotency_key_fingerprint,
      projection_json, response_action, response_submitted_fields_json, expiry_reason, occurred_at, committed_at
    ) VALUES (?, ?, ?, ?, ?, 'migration_baseline', ?, 'system', NULL, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const idempotencyKey = typeof row.idempotency_key === "string" ? row.idempotency_key : null;
    insert.run(
      `interaction:${row.id}:revision:${row.revision}`,
      row.id,
      row.session_id,
      row.execution_id,
      row.revision,
      row.decision_class,
      idempotencyKey === null ? null : createHash("sha256").update(idempotencyKey).digest("hex"),
      serializeBaselineProjection(row),
      row.response_action,
      row.response_submitted_fields_json,
      row.expiry_reason,
      row.resolved_at ?? row.created_at,
      row.updated_at,
    );
  }
}

function backfillInteractionEventHeaders(db: DatabaseSync): void {
  db.exec(`
    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.id,
      'interaction',
      event.interaction_id,
      COALESCE(binding.root_session_id, event.session_id),
      'session',
      event.session_id,
      event.event_kind,
      event.interaction_revision,
      event.principal_kind,
      event.actor_session_id,
      NULL,
      NULL,
      'migration:interaction-history',
      event.idempotency_key_fingerprint,
      event.occurred_at,
      event.committed_at,
      NULL,
      1,
      'committed'
    FROM session_interaction_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id;
  `);
}

function serializeBaselineProjection(row: Record<string, string | number | null>): string {
  const principalKind = row.response_principal_kind;
  const resolvedBy = principalKind === "agent" && typeof row.response_actor_session_id === "string"
    ? { kind: "agent", sessionId: row.response_actor_session_id }
    : principalKind === "user" || principalKind === "system" ? { kind: principalKind } : null;
  return JSON.stringify({
    sequence: row.sequence,
    revision: row.revision,
    id: row.id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    kind: row.kind,
    decisionClass: row.decision_class,
    state: row.state,
    publicPayload: JSON.parse(String(row.public_payload_json)),
    response: row.response_action === null ? null : {
      action: row.response_action,
      submittedFields: JSON.parse(String(row.response_submitted_fields_json)),
    },
    expiryReason: row.expiry_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy,
    updatedAt: row.updated_at,
  });
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName) !== undefined;
}
