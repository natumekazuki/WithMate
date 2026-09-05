import type { DatabaseSync } from "node:sqlite";

import {
  COORDINATION_EVENT_DECISION_CLASS_BY_KIND,
  COORDINATION_EVENT_KINDS,
} from "../src/coordination-event.js";

export const CREATE_COORDINATION_EVENT_AUTHORITY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_event_decision_class_registry_v6 (
    kind TEXT PRIMARY KEY,
    decision_class TEXT NOT NULL,
    mapping_revision INTEGER NOT NULL CHECK (mapping_revision > 0),
    CHECK (decision_class IN ('agent_delegable', 'user_only', 'deny_or_cancel'))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS coordination_event_user_receipts_v6 (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL CHECK (user_id = 'local-user'),
    event_id TEXT NOT NULL,
    event_revision INTEGER NOT NULL CHECK (event_revision > 0),
    response_kind TEXT NOT NULL CHECK (response_kind IN ('option', 'text', 'cancel')),
    option_id TEXT,
    note TEXT CHECK (note IS NULL OR length(note) <= 1000),
    created_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE,
    CHECK (
      (response_kind = 'option' AND option_id IS NOT NULL AND note IS NULL)
      OR (response_kind = 'text' AND option_id IS NULL AND note IS NOT NULL)
      OR (response_kind = 'cancel' AND option_id IS NULL AND note IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_v6_coordination_event_user_receipts_revision
    ON coordination_event_user_receipts_v6(event_id, event_revision);

  CREATE TRIGGER IF NOT EXISTS coordination_event_user_receipts_no_update_v6
  BEFORE UPDATE ON coordination_event_user_receipts_v6
  BEGIN
    SELECT RAISE(ABORT, 'coordination event user receipts are append-only');
  END;
`;

export function ensureCoordinationEventAuthoritySchema(db: DatabaseSync): void {
  db.exec("SAVEPOINT coordination_event_authority_schema");
  try {
    db.exec(CREATE_COORDINATION_EVENT_AUTHORITY_TABLES_SQL);
    const eventColumns = tableColumnNames(db, "coordination_events_v6");
    if (!eventColumns.has("decision_class")) {
      db.exec(`
        ALTER TABLE coordination_events_v6
          ADD COLUMN decision_class TEXT NOT NULL DEFAULT 'deny_or_cancel'
          CHECK (decision_class IN ('agent_delegable', 'user_only', 'deny_or_cancel'));
      `);
    }
    seedDecisionClassRegistry(db);
    if (!eventColumns.has("decision_class")) {
      db.exec(`
        UPDATE coordination_events_v6
        SET decision_class = (
          SELECT registry.decision_class
          FROM coordination_event_decision_class_registry_v6 AS registry
          WHERE registry.kind = coordination_events_v6.kind
        );
      `);
    }

    const actionColumns = tableColumnNames(db, "coordination_event_actions_v6");
    if (!actionColumns.has("principal_kind")) {
      db.exec(`
        ALTER TABLE coordination_event_actions_v6
          ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'agent'
          CHECK (principal_kind IN ('user', 'agent', 'system'));
        UPDATE coordination_event_actions_v6
        SET principal_kind = CASE actor_type WHEN 'trusted_gui' THEN 'user' ELSE 'agent' END;
      `);
    }
    if (!actionColumns.has("receipt_id")) {
      db.exec("ALTER TABLE coordination_event_actions_v6 ADD COLUMN receipt_id TEXT;");
    }
    const receiptColumns = tableColumnNames(db, "coordination_event_user_receipts_v6");
    if (!receiptColumns.has("user_id")) {
      db.exec(`
        ALTER TABLE coordination_event_user_receipts_v6
          ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-user' CHECK (user_id = 'local-user');
      `);
    }
    db.exec("DROP TRIGGER IF EXISTS coordination_event_user_receipts_no_delete_v6;");

    backfillUserReceipts(db);
    ensurePrincipalScopedIdempotency(db);
    backfillCoordinationEventHeaders(db);
    verifyDecisionClassRegistry(db);
    db.exec("RELEASE coordination_event_authority_schema");
  } catch (error) {
    db.exec("ROLLBACK TO coordination_event_authority_schema");
    db.exec("RELEASE coordination_event_authority_schema");
    throw error;
  }
}

function backfillCoordinationEventHeaders(db: DatabaseSync): void {
  db.exec(`
    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.id, 'coordination_event', event.id, event.root_session_id, 'session', event.actor_session_id,
      'coordination_event_created', NULL, 'system', NULL, NULL, NULL,
      'migration:coordination-event-history', NULL, event.created_at, event.created_at,
      event.corrected_event_id, 1, 'committed'
    FROM coordination_events_v6 AS event;

    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      action.id, 'coordination_event', action.event_id, event.root_session_id, 'session', event.actor_session_id,
      'coordination_event_' || action.action_type,
      (SELECT COUNT(*) FROM coordination_event_actions_v6 AS prior
       WHERE prior.event_id = action.event_id AND prior.sequence <= action.sequence),
      action.principal_kind, action.actor_session_id, NULL, NULL,
      'migration:coordination-event-history', NULL, action.created_at, action.created_at,
      NULL, 1, 'committed'
    FROM coordination_event_actions_v6 AS action
    INNER JOIN coordination_events_v6 AS event ON event.id = action.event_id;
  `);
}

function seedDecisionClassRegistry(db: DatabaseSync): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO coordination_event_decision_class_registry_v6 (
      kind, decision_class, mapping_revision
    ) VALUES (?, ?, 1)
  `);
  for (const kind of COORDINATION_EVENT_KINDS) {
    insert.run(kind, COORDINATION_EVENT_DECISION_CLASS_BY_KIND[kind]);
  }
}

function verifyDecisionClassRegistry(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT kind, decision_class, mapping_revision
    FROM coordination_event_decision_class_registry_v6
    ORDER BY kind
  `).all() as Array<{ kind: string; decision_class: string; mapping_revision: number }>;
  if (rows.length !== COORDINATION_EVENT_KINDS.length) {
    throw new Error("Coordination event decision class registry is incomplete.");
  }
  for (const row of rows) {
    if (!COORDINATION_EVENT_KINDS.includes(row.kind as (typeof COORDINATION_EVENT_KINDS)[number])
      || row.decision_class !== COORDINATION_EVENT_DECISION_CLASS_BY_KIND[row.kind as (typeof COORDINATION_EVENT_KINDS)[number]]
      || row.mapping_revision !== 1) {
      throw new Error("Coordination event decision class registry does not match the current mapping.");
    }
  }
}

function backfillUserReceipts(db: DatabaseSync): void {
  db.exec(`
    INSERT OR IGNORE INTO coordination_event_user_receipts_v6 (
      receipt_id, user_id, event_id, event_revision, response_kind, option_id, note, created_at
    )
    SELECT
      'coordination-receipt:legacy:' || actions.id,
      'local-user',
      actions.event_id,
      (
        SELECT COUNT(*)
        FROM coordination_event_actions_v6 AS prior_actions
        WHERE prior_actions.event_id = actions.event_id
          AND prior_actions.sequence <= actions.sequence
      ),
      CASE
        WHEN actions.action_type = 'cancelled' THEN 'cancel'
        WHEN actions.option_id IS NOT NULL THEN 'option'
        ELSE 'text'
      END,
      actions.option_id,
      CASE WHEN actions.action_type = 'cancelled' THEN NULL ELSE actions.note END,
      actions.created_at
    FROM coordination_event_actions_v6 AS actions
    WHERE actions.actor_type = 'trusted_gui'
      AND actions.action_type IN ('responded', 'resolved', 'cancelled')
      AND (
        actions.action_type = 'cancelled'
        OR actions.option_id IS NOT NULL
        OR actions.note IS NOT NULL
      );

    UPDATE coordination_event_actions_v6
    SET receipt_id = 'coordination-receipt:legacy:' || id
    WHERE actor_type = 'trusted_gui'
      AND action_type IN ('responded', 'resolved', 'cancelled')
      AND receipt_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM coordination_event_user_receipts_v6 AS receipts
        WHERE receipts.receipt_id = 'coordination-receipt:legacy:' || coordination_event_actions_v6.id
      );
  `);
}

function ensurePrincipalScopedIdempotency(db: DatabaseSync): void {
  const columns = tableColumnNames(db, "coordination_event_idempotency_v6");
  if (columns.has("principal_kind")
    && columns.has("principal_id")
    && columns.has("result_revision")
    && columns.has("operation_id")) {
    return;
  }
  db.exec(`
    ALTER TABLE coordination_event_idempotency_v6
      RENAME TO coordination_event_idempotency_v6_legacy_authority;
    DROP INDEX IF EXISTS idx_v6_coordination_event_idempotency_event;

    CREATE TABLE coordination_event_idempotency_v6 (
      operation TEXT NOT NULL CHECK (operation IN ('coordination.event.create', 'coordination.event.resolve', 'coordination.event.consume', 'coordination.event.cancel', 'coordination.event.correct')),
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'agent', 'legacy_unknown')),
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      result_event_id TEXT NOT NULL,
      target_event_id TEXT,
      result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
      operation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (principal_kind, principal_id, idempotency_key),
      FOREIGN KEY (result_event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE,
      FOREIGN KEY (target_event_id) REFERENCES coordination_events_v6(id) ON DELETE CASCADE
    ) STRICT;

    INSERT INTO coordination_event_idempotency_v6 (
      operation, principal_kind, principal_id, idempotency_key, request_fingerprint,
      result_event_id, target_event_id, result_revision, operation_id, created_at
    )
    SELECT
      legacy.operation,
      'legacy_unknown',
      legacy.principal_session_id,
      legacy.idempotency_key,
      legacy.request_fingerprint,
      legacy.result_event_id,
      legacy.target_event_id,
      COALESCE((
        SELECT COUNT(*)
        FROM coordination_event_actions_v6 AS actions
        WHERE actions.event_id = legacy.result_event_id
      ), 0),
      'coordination-operation:legacy:' || legacy.rowid,
      legacy.created_at
    FROM coordination_event_idempotency_v6_legacy_authority AS legacy;

    DROP TABLE coordination_event_idempotency_v6_legacy_authority;

    CREATE INDEX idx_v6_coordination_event_idempotency_event
      ON coordination_event_idempotency_v6(result_event_id, target_event_id);
  `);
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}
