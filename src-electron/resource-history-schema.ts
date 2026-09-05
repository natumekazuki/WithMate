import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { MutationAuthorityProof, ResourceEventHeader } from "../src/session-authority.js";
import { appendResourceEventHeader } from "./session-authority-storage.js";

const RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES = 64 * 1024;

export function ensureResourceHistorySchema(db: DatabaseSync): void {
  const sessionColumns = tableColumnNames(db, "sessions_v6");
  if (!sessionColumns.has("resource_revision")) {
    db.exec("ALTER TABLE sessions_v6 ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 1 CHECK (resource_revision >= 1)");
  }
  const executionColumns = tableColumnNames(db, "session_executions_v6");
  if (!executionColumns.has("revision")) {
    db.exec("ALTER TABLE session_executions_v6 ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)");
  }
  if (!executionColumns.has("authority_proof_json")) {
    db.exec("ALTER TABLE session_executions_v6 ADD COLUMN authority_proof_json TEXT CHECK (authority_proof_json IS NULL OR json_valid(authority_proof_json))");
  }
  ensureJsonColumn(db, "session_file_write_idempotency_v6", "authority_proof_json");
  ensureJsonColumn(db, "session_transcript_export_idempotency_v6", "authority_proof_json");
  ensureTextColumn(db, "session_file_write_idempotency_v6", "operation_id");
  ensureTextColumn(db, "session_transcript_export_idempotency_v6", "operation_id");

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_resource_events_v6 (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      CHECK (revision >= 1),
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      CHECK (length(CAST(payload_json AS BLOB)) <= ${RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES}),
      UNIQUE (session_id, revision)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_resource_events_session_v6
      ON session_resource_events_v6(session_id, revision);

    CREATE TABLE IF NOT EXISTS session_execution_events_v6 (
      event_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      CHECK (revision >= 1),
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      CHECK (length(CAST(payload_json AS BLOB)) <= ${RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES}),
      UNIQUE (execution_id, revision)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_execution_events_execution_v6
      ON session_execution_events_v6(execution_id, revision);

    CREATE TABLE IF NOT EXISTS session_file_write_events_v6 (
      event_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('prepared', 'applied', 'rejected')),
      payload_json TEXT NOT NULL,
      CHECK (revision >= 1),
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      CHECK (length(CAST(payload_json AS BLOB)) <= ${RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES}),
      UNIQUE (operation_id, revision)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_transcript_export_events_v6 (
      event_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('prepared', 'applied', 'rejected')),
      payload_json TEXT NOT NULL,
      CHECK (revision >= 1),
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      CHECK (length(CAST(payload_json AS BLOB)) <= ${RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES}),
      UNIQUE (operation_id, revision)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS work_item_aggregation_events_v6 (
      event_id TEXT PRIMARY KEY,
      parent_work_item_id TEXT NOT NULL,
      child_work_item_id TEXT NOT NULL,
      aggregate_revision INTEGER NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('migration_baseline', 'child_added', 'decided', 'retry_requested')),
      payload_json TEXT NOT NULL,
      CHECK (aggregate_revision >= 1),
      CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
      CHECK (length(CAST(payload_json AS BLOB)) <= ${RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES}),
      UNIQUE (parent_work_item_id, aggregate_revision)
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS session_resource_events_no_update_v6
    BEFORE UPDATE ON session_resource_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session resource events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_resource_events_no_delete_v6
    BEFORE DELETE ON session_resource_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session resource events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_execution_events_no_update_v6
    BEFORE UPDATE ON session_execution_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session execution events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_execution_events_no_delete_v6
    BEFORE DELETE ON session_execution_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session execution events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_file_write_events_no_update_v6
    BEFORE UPDATE ON session_file_write_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session file write events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_file_write_events_no_delete_v6
    BEFORE DELETE ON session_file_write_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session file write events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_transcript_export_events_no_update_v6
    BEFORE UPDATE ON session_transcript_export_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session transcript export events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS session_transcript_export_events_no_delete_v6
    BEFORE DELETE ON session_transcript_export_events_v6 BEGIN
      SELECT RAISE(ABORT, 'session transcript export events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS work_item_aggregation_events_no_update_v6
    BEFORE UPDATE ON work_item_aggregation_events_v6 BEGIN
      SELECT RAISE(ABORT, 'Work Item aggregation events are append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS work_item_aggregation_events_no_delete_v6
    BEFORE DELETE ON work_item_aggregation_events_v6 BEGIN
      SELECT RAISE(ABORT, 'Work Item aggregation events are append-only');
    END;
  `);

  backfillSagaOperationIds(db);
  backfillResourceHistory(db);
  verifyResourceHistoryProjections(db);
}

export function verifyResourceHistoryProjections(db: DatabaseSync): void {
  const missingSession = db.prepare(`
    SELECT session.id
    FROM sessions_v6 AS session
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS event_count, MIN(revision) AS first_revision, MAX(revision) AS last_revision
      FROM session_resource_events_v6 GROUP BY session_id
    ) AS history ON history.session_id = session.id
    WHERE history.event_count IS NULL
      OR history.event_count != history.last_revision - history.first_revision + 1
      OR history.last_revision != session.resource_revision
      OR (history.first_revision != 1 AND NOT EXISTS (
        SELECT 1 FROM session_resource_events_v6 AS first_event
        WHERE first_event.session_id = session.id
          AND first_event.revision = history.first_revision
          AND first_event.event_kind = 'migration_baseline'
      ))
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (missingSession) {
    throw new Error(`Session projection has no matching resource event: ${missingSession.id}`);
  }

  const missingExecution = db.prepare(`
    SELECT execution.id
    FROM session_executions_v6 AS execution
    LEFT JOIN (
      SELECT execution_id, COUNT(*) AS event_count, MIN(revision) AS first_revision, MAX(revision) AS last_revision
      FROM session_execution_events_v6 GROUP BY execution_id
    ) AS history ON history.execution_id = execution.id
    WHERE history.event_count IS NULL
      OR history.event_count != history.last_revision - history.first_revision + 1
      OR history.last_revision != execution.revision
      OR (history.first_revision != 1 AND NOT EXISTS (
        SELECT 1 FROM session_execution_events_v6 AS first_event
        WHERE first_event.execution_id = execution.id
          AND first_event.revision = history.first_revision
          AND first_event.event_kind = 'migration_baseline'
      ))
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (missingExecution) {
    throw new Error(`Session execution projection has no matching resource event: ${missingExecution.id}`);
  }

  const missingWorkItem = db.prepare(`
    SELECT item.id
    FROM work_items_v6 AS item
    LEFT JOIN (
      SELECT work_item_id, COUNT(*) AS event_count, MIN(revision) AS first_revision, MAX(revision) AS last_revision
      FROM work_item_events_v6 GROUP BY work_item_id
    ) AS history ON history.work_item_id = item.id
    WHERE history.event_count IS NULL
      OR history.event_count != history.last_revision - history.first_revision + 1
      OR history.last_revision != item.revision
      OR (history.first_revision != 1 AND NOT EXISTS (
        SELECT 1 FROM work_item_events_v6 AS first_event
        WHERE first_event.work_item_id = item.id
          AND first_event.revision = history.first_revision
          AND first_event.event_type = 'migration_baseline'
      ))
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (missingWorkItem) {
    throw new Error(`Work Item projection has no matching resource event: ${missingWorkItem.id}`);
  }

  const missingAggregation = db.prepare(`
    SELECT aggregation.parent_work_item_id AS id
    FROM work_item_aggregations_v6 AS aggregation
    LEFT JOIN (
      SELECT parent_work_item_id, COUNT(*) AS event_count,
        MIN(aggregate_revision) AS first_revision, MAX(aggregate_revision) AS last_revision
      FROM work_item_aggregation_events_v6 GROUP BY parent_work_item_id
    ) AS history ON history.parent_work_item_id = aggregation.parent_work_item_id
    WHERE history.event_count IS NULL
      OR history.event_count != history.last_revision - history.first_revision + 1
      OR history.last_revision != aggregation.aggregate_revision
      OR (history.first_revision != 1 AND NOT EXISTS (
        SELECT 1 FROM work_item_aggregation_events_v6 AS first_event
        WHERE first_event.parent_work_item_id = aggregation.parent_work_item_id
          AND first_event.aggregate_revision = history.first_revision
          AND first_event.event_kind = 'migration_baseline'
      ))
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (missingAggregation) {
    throw new Error(`Work Item aggregation projection has no matching resource event: ${missingAggregation.id}`);
  }

  verifySagaProjection(db, {
    projectionTable: "session_file_write_idempotency_v6",
    eventTable: "session_file_write_events_v6",
    label: "Session file write",
  });
  verifySagaProjection(db, {
    projectionTable: "session_transcript_export_idempotency_v6",
    eventTable: "session_transcript_export_events_v6",
    label: "Session transcript export",
  });
}

function verifySagaProjection(db: DatabaseSync, input: {
  projectionTable: string;
  eventTable: string;
  label: string;
}): void {
  const mismatch = db.prepare(`
    SELECT projection.idempotency_key AS id
    FROM ${input.projectionTable} AS projection
    LEFT JOIN (
      SELECT operation_id, COUNT(*) AS event_count, MIN(revision) AS first_revision, MAX(revision) AS last_revision
      FROM ${input.eventTable}
      GROUP BY operation_id
    ) AS history ON history.operation_id = projection.operation_id
    LEFT JOIN ${input.eventTable} AS event
      ON event.operation_id = history.operation_id AND event.revision = history.last_revision
    WHERE projection.operation_id IS NULL
      OR event.event_id IS NULL
      OR event.event_kind != CASE projection.state
        WHEN 'pending' THEN 'prepared'
        WHEN 'applied' THEN 'applied'
        ELSE 'rejected'
      END
      OR history.event_count != history.last_revision
      OR history.first_revision != 1
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (mismatch) throw new Error(`${input.label} projection has no matching resource event: ${mismatch.id}`);
}

export function getSessionResourceRevision(db: DatabaseSync, sessionId: string): number | null {
  const row = db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ?").get(sessionId) as
    | { resource_revision: number }
    | undefined;
  return row?.resource_revision ?? null;
}

export function claimSessionContainerRevision(db: DatabaseSync, input: {
  sessionId: string;
  expectedRevision: number;
  eventKind: string;
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey: string | null;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}): number {
  const changed = db.prepare(`
    UPDATE sessions_v6
    SET resource_revision = resource_revision + 1, updated_at = ?
    WHERE id = ? AND resource_revision = ?
  `).run(input.occurredAt, input.sessionId, input.expectedRevision);
  if (changed.changes !== 1) {
    const current = getSessionResourceRevision(db, input.sessionId);
    if (current === null) throw new Error(`Session container was not found: ${input.sessionId}`);
    throw new SessionResourceRevisionConflictError(input.sessionId, input.expectedRevision, current);
  }
  const revision = input.expectedRevision + 1;
  appendSessionResourceEvent(db, { ...input, revision });
  return revision;
}

export function appendSessionResourceEvent(db: DatabaseSync, input: {
  sessionId: string;
  revision: number;
  eventKind: string;
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey: string | null;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}): void {
  const identity = requireSessionIdentity(db, input.sessionId);
  const eventId = `session:${input.sessionId}:revision:${input.revision}`;
  insertPayload(db, "session_resource_events_v6", {
    eventId,
    columns: ["session_id", "revision", "event_kind", "payload_json"],
    values: [input.sessionId, input.revision, input.eventKind, serializePayload(input.payload)],
  });
  appendResourceEventHeader(db, createHeader({
    eventId,
    resourceKind: "session",
    resourceId: input.sessionId,
    rootId: identity.rootSessionId,
    ownerId: input.sessionId,
    eventKind: input.eventKind,
    resourceRevision: input.revision,
    proof: input.proof,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
  }));
}

export function appendSessionExecutionEvent(db: DatabaseSync, input: {
  executionId: string;
  revision: number;
  eventKind: string;
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey: string | null;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}): void {
  const row = db.prepare(`
    SELECT execution.session_id, COALESCE(binding.root_session_id, execution.session_id) AS root_session_id
    FROM session_executions_v6 AS execution
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = execution.session_id
    WHERE execution.id = ?
  `).get(input.executionId) as { session_id: string; root_session_id: string } | undefined;
  if (!row) throw new Error(`Session execution was not found: ${input.executionId}`);
  const eventId = `execution:${input.executionId}:revision:${input.revision}`;
  insertPayload(db, "session_execution_events_v6", {
    eventId,
    columns: ["execution_id", "session_id", "revision", "event_kind", "payload_json"],
    values: [input.executionId, row.session_id, input.revision, input.eventKind, serializePayload(input.payload)],
  });
  appendResourceEventHeader(db, createHeader({
    eventId,
    resourceKind: "execution",
    resourceId: input.executionId,
    rootId: row.root_session_id,
    ownerId: row.session_id,
    eventKind: input.eventKind,
    resourceRevision: input.revision,
    proof: input.proof,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
  }));
}

export function appendWorkItemEventHeader(db: DatabaseSync, input: {
  workItemId: string;
  revision: number;
  eventKind: string;
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey: string | null;
  occurredAt: string;
}): void {
  const row = db.prepare("SELECT root_session_id, target_session_id FROM work_items_v6 WHERE id = ?")
    .get(input.workItemId) as { root_session_id: string; target_session_id: string } | undefined;
  if (!row) throw new Error(`Work Item was not found: ${input.workItemId}`);
  appendResourceEventHeader(db, createHeader({
    eventId: `work-item:${input.workItemId}:revision:${input.revision}`,
    resourceKind: "work_item",
    resourceId: input.workItemId,
    rootId: row.root_session_id,
    ownerId: row.target_session_id,
    eventKind: input.eventKind,
    resourceRevision: input.revision,
    proof: input.proof,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
  }));
}

export function appendWorkItemAggregationEvent(db: DatabaseSync, input: {
  parentWorkItemId: string;
  childWorkItemId: string;
  aggregateRevision: number;
  eventKind: "migration_baseline" | "child_added" | "decided" | "retry_requested";
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}): void {
  const row = db.prepare("SELECT root_session_id, target_session_id FROM work_items_v6 WHERE id = ?")
    .get(input.parentWorkItemId) as { root_session_id: string; target_session_id: string } | undefined;
  if (!row) throw new Error(`Work Item aggregation parent was not found: ${input.parentWorkItemId}`);
  const eventId = `work-item-aggregation:${input.parentWorkItemId}:revision:${input.aggregateRevision}`;
  insertPayload(db, "work_item_aggregation_events_v6", {
    eventId,
    columns: ["parent_work_item_id", "child_work_item_id", "aggregate_revision", "event_kind", "payload_json"],
    values: [input.parentWorkItemId, input.childWorkItemId, input.aggregateRevision, input.eventKind, serializePayload(input.payload)],
  });
  appendResourceEventHeader(db, createHeader({
    eventId,
    resourceKind: "work_item",
    resourceId: input.parentWorkItemId,
    rootId: row.root_session_id,
    ownerId: row.target_session_id,
    eventKind: input.eventKind,
    resourceRevision: input.aggregateRevision,
    proof: input.proof,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
  }));
}

export function appendSessionFileSagaEvent(db: DatabaseSync, input: {
  table: "session_file_write_events_v6" | "session_transcript_export_events_v6";
  resourceKind: "session_files" | "transcript";
  operationId: string;
  sessionId: string;
  revision: number;
  eventKind: "prepared" | "applied" | "rejected";
  proof: MutationAuthorityProof;
  idempotencyKey: string;
  occurredAt: string;
  effect: ResourceEventHeader["effect"];
  payload: Readonly<Record<string, unknown>>;
}): void {
  const identity = requireSessionIdentity(db, input.sessionId);
  const eventId = `${input.resourceKind}:${input.operationId}:revision:${input.revision}`;
  insertPayload(db, input.table, {
    eventId,
    columns: ["operation_id", "session_id", "revision", "event_kind", "payload_json"],
    values: [input.operationId, input.sessionId, input.revision, input.eventKind, serializePayload(input.payload)],
  });
  appendResourceEventHeader(db, {
    ...createHeader({
      eventId,
      resourceKind: input.resourceKind,
      resourceId: input.operationId,
      rootId: identity.rootSessionId,
      ownerId: input.sessionId,
      eventKind: input.eventKind,
      resourceRevision: input.revision,
      proof: input.proof,
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
    }),
    effect: input.effect,
  });
}

export function createSagaOperationId(
  kind: "session-file-write" | "session-transcript-export",
  idempotencyKey: string,
  requestFingerprint: string,
): string {
  const identity = createHash("sha256")
    .update(idempotencyKey)
    .update("\0")
    .update(requestFingerprint)
    .digest("hex");
  return `${kind}:${identity}`;
}

export class SessionResourceRevisionConflictError extends Error {
  readonly code = "SESSION_REVISION_CONFLICT";

  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Session resource revision is stale: ${sessionId}`);
    this.name = "SessionResourceRevisionConflictError";
  }
}

function createHeader(input: {
  eventId: string;
  resourceKind: ResourceEventHeader["resourceKind"];
  resourceId: string;
  rootId: string;
  ownerId: string;
  eventKind: string;
  resourceRevision: number | null;
  proof: MutationAuthorityProof;
  operationId: string;
  idempotencyKey: string | null;
  occurredAt: string;
}): ResourceEventHeader {
  return {
    eventId: input.eventId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    rootId: input.rootId,
    ownerKind: "session",
    ownerId: input.ownerId,
    eventKind: input.eventKind,
    resourceRevision: input.resourceRevision,
    principalKind: input.proof.principal.kind,
    actorSessionId: input.proof.principal.kind === "agent" ? input.proof.principal.actorSessionId : null,
    grantId: input.proof.principal.kind === "agent" ? input.proof.grantId : null,
    grantRevision: input.proof.principal.kind === "agent" ? input.proof.grantRevision : null,
    operationId: input.operationId,
    idempotencyKeyFingerprint: input.idempotencyKey === null
      ? null
      : createHash("sha256").update(input.idempotencyKey).digest("hex"),
    occurredAt: input.occurredAt,
    committedAt: input.occurredAt,
    supersedesEventId: null,
    payloadSchemaRevision: 1,
    effect: "committed",
  };
}

function requireSessionIdentity(db: DatabaseSync, sessionId: string): { rootSessionId: string } {
  const row = db.prepare(`
    SELECT COALESCE(binding.root_session_id, session.id) AS root_session_id
    FROM sessions_v6 AS session
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = session.id
    WHERE session.id = ?
  `).get(sessionId) as { root_session_id: string } | undefined;
  if (!row) throw new Error(`Session was not found: ${sessionId}`);
  return { rootSessionId: row.root_session_id };
}

function insertPayload(db: DatabaseSync, table: string, input: {
  eventId: string;
  columns: readonly string[];
  values: readonly SQLInputValue[];
}): void {
  const placeholders = input.columns.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${table} (event_id, ${input.columns.join(", ")}) VALUES (?, ${placeholders})`)
    .run(input.eventId, ...input.values);
}

function serializePayload(payload: Readonly<Record<string, unknown>>): string {
  const result = JSON.stringify(payload);
  if (Buffer.byteLength(result, "utf8") > RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES) {
    throw new TypeError("Resource history event payload exceeds the byte limit.");
  }
  return result;
}

function backfillResourceHistory(db: DatabaseSync): void {
  db.exec(`
    INSERT OR IGNORE INTO session_resource_events_v6 (event_id, session_id, revision, event_kind, payload_json)
    SELECT
      'session:' || session.id || ':revision:' || session.resource_revision,
      session.id,
      session.resource_revision,
      'migration_baseline',
      json_object(
        'title', session.title,
        'state', session.state,
        'sessionKind', session.session_kind,
        'providerId', session.provider_id,
        'modelId', session.model_id,
        'workspacePath', session.workspace_path,
        'updatedAt', session.updated_at
      )
    FROM sessions_v6 AS session;

    INSERT OR IGNORE INTO session_execution_events_v6 (
      event_id, execution_id, session_id, revision, event_kind, payload_json
    )
    SELECT
      'execution:' || execution.id || ':revision:' || execution.revision,
      execution.id,
      execution.session_id,
      execution.revision,
      'migration_baseline',
      json_object(
        'operation', execution.operation,
        'state', execution.state,
        'errorCode', execution.error_code,
        'reason', execution.reason,
        'createdAt', execution.created_at,
        'admittedAt', execution.admitted_at,
        'completedAt', execution.completed_at,
        'updatedAt', execution.updated_at
      )
    FROM session_executions_v6 AS execution;

    INSERT OR IGNORE INTO session_file_write_events_v6 (
      event_id, operation_id, session_id, revision, event_kind, payload_json
    )
    SELECT
      'session_files:' || write.operation_id || ':revision:1',
      write.operation_id,
      write.session_id,
      1,
      CASE write.state WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END,
      json_object(
        'relativePath', write.relative_path,
        'tempName', write.temp_name,
        'migrationBaseline', 1,
        'occurredAt', write.created_at
      )
    FROM session_file_write_idempotency_v6 AS write;

    INSERT OR IGNORE INTO session_transcript_export_events_v6 (
      event_id, operation_id, session_id, revision, event_kind, payload_json
    )
    SELECT
      'transcript:' || export.operation_id || ':revision:1',
      export.operation_id,
      export.session_id,
      1,
      CASE export.state WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END,
      json_object(
        'relativePath', export.relative_path,
        'tempName', export.temp_name,
        'migrationBaseline', 1,
        'occurredAt', export.created_at
      )
    FROM session_transcript_export_idempotency_v6 AS export;

    INSERT OR IGNORE INTO session_file_write_events_v6 (
      event_id, operation_id, session_id, revision, event_kind, payload_json
    )
    SELECT
      'session_files:' || write.operation_id || ':revision:' || (history.last_revision + 1),
      write.operation_id,
      write.session_id,
      history.last_revision + 1,
      CASE write.state WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END,
      json_object(
        'relativePath', write.relative_path,
        'tempName', write.temp_name,
        'migrationReconciliation', 1,
        'occurredAt', write.created_at
      )
    FROM session_file_write_idempotency_v6 AS write
    INNER JOIN (
      SELECT operation_id, MAX(revision) AS last_revision
      FROM session_file_write_events_v6
      GROUP BY operation_id
    ) AS history ON history.operation_id = write.operation_id
    INNER JOIN session_file_write_events_v6 AS latest
      ON latest.operation_id = history.operation_id AND latest.revision = history.last_revision
    WHERE latest.event_kind != CASE write.state
      WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END;

    INSERT OR IGNORE INTO session_transcript_export_events_v6 (
      event_id, operation_id, session_id, revision, event_kind, payload_json
    )
    SELECT
      'transcript:' || export.operation_id || ':revision:' || (history.last_revision + 1),
      export.operation_id,
      export.session_id,
      history.last_revision + 1,
      CASE export.state WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END,
      json_object(
        'relativePath', export.relative_path,
        'tempName', export.temp_name,
        'migrationReconciliation', 1,
        'occurredAt', export.created_at
      )
    FROM session_transcript_export_idempotency_v6 AS export
    INNER JOIN (
      SELECT operation_id, MAX(revision) AS last_revision
      FROM session_transcript_export_events_v6
      GROUP BY operation_id
    ) AS history ON history.operation_id = export.operation_id
    INNER JOIN session_transcript_export_events_v6 AS latest
      ON latest.operation_id = history.operation_id AND latest.revision = history.last_revision
    WHERE latest.event_kind != CASE export.state
      WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END;

    WITH aggregation_source AS (
      SELECT
        child.parent_work_item_id,
        child.id AS child_work_item_id,
        child.created_at AS occurred_at,
        child.sequence * 2 AS sort_order,
        'child_added' AS event_kind,
        json_object(
          'childWorkItemId', child.id,
          'childRevision', 1,
          'occurredAt', child.created_at
        ) AS payload_json
      FROM work_items_v6 AS child
      WHERE child.parent_work_item_id IS NOT NULL
      UNION ALL
      SELECT
        decision.parent_work_item_id,
        decision.child_work_item_id,
        decision.decided_at,
        decision.sequence * 2 + 1,
        CASE WHEN decision.decision_type = 'retry_requested' THEN 'retry_requested' ELSE 'decided' END,
        json_object(
          'childWorkItemId', decision.child_work_item_id,
          'childRevision', decision.child_revision,
          'decision', decision.decision_type,
          'reason', decision.reason,
          'replacementWorkItemId', decision.replacement_work_item_id,
          'occurredAt', decision.decided_at
        )
      FROM work_item_aggregation_decisions_v6 AS decision
    ), numbered AS (
      SELECT *, row_number() OVER (
        PARTITION BY parent_work_item_id
        ORDER BY occurred_at, sort_order, child_work_item_id
      ) AS aggregate_revision
      FROM aggregation_source
    )
    INSERT OR IGNORE INTO work_item_aggregation_events_v6 (
      event_id, parent_work_item_id, child_work_item_id, aggregate_revision, event_kind, payload_json
    )
    SELECT
      'work-item-aggregation:' || parent_work_item_id || ':revision:' || aggregate_revision,
      parent_work_item_id, child_work_item_id, aggregate_revision, event_kind, payload_json
    FROM numbered;
  `);

  if (!tableExists(db, "resource_event_headers_v6")) return;
  db.exec(`
    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.event_id, 'session', event.session_id,
      COALESCE(binding.root_session_id, event.session_id), 'session', event.session_id,
      event.event_kind, event.revision, 'system', NULL, NULL, NULL,
      'migration:session-history', NULL,
      COALESCE(json_extract(event.payload_json, '$.updatedAt'), ''),
      COALESCE(json_extract(event.payload_json, '$.updatedAt'), ''), NULL, 1, 'committed'
    FROM session_resource_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id;

    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.event_id, 'execution', event.execution_id,
      COALESCE(binding.root_session_id, event.session_id), 'session', event.session_id,
      event.event_kind, event.revision, 'system', NULL, NULL, NULL,
      'migration:execution-history', NULL,
      COALESCE(json_extract(event.payload_json, '$.updatedAt'), ''),
      COALESCE(json_extract(event.payload_json, '$.updatedAt'), ''), NULL, 1, 'committed'
    FROM session_execution_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id;

    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.event_id, 'session_files', event.operation_id,
      COALESCE(binding.root_session_id, event.session_id), 'session', event.session_id,
      event.event_kind, event.revision, 'system', NULL, NULL, NULL,
      'migration:session-file-write-history', NULL,
      COALESCE(json_extract(event.payload_json, '$.occurredAt'), ''),
      COALESCE(json_extract(event.payload_json, '$.occurredAt'), ''), NULL, 1,
      CASE event.event_kind WHEN 'prepared' THEN 'none' WHEN 'applied' THEN 'committed' ELSE 'unknown' END
    FROM session_file_write_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id;

    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.event_id, 'transcript', event.operation_id,
      COALESCE(binding.root_session_id, event.session_id), 'session', event.session_id,
      event.event_kind, event.revision, 'system', NULL, NULL, NULL,
      'migration:session-transcript-history', NULL,
      COALESCE(json_extract(event.payload_json, '$.occurredAt'), ''),
      COALESCE(json_extract(event.payload_json, '$.occurredAt'), ''), NULL, 1,
      CASE event.event_kind WHEN 'prepared' THEN 'none' WHEN 'applied' THEN 'committed' ELSE 'unknown' END
    FROM session_transcript_export_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id;

    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      'work-item:' || event.work_item_id || ':revision:' || event.revision,
      'work_item', event.work_item_id, item.root_session_id, 'session', item.target_session_id,
      event.event_type, event.revision,
      CASE WHEN event.actor_session_id IS NULL THEN 'system' ELSE 'agent' END,
      event.actor_session_id, NULL, NULL, 'migration:work-item-history', NULL,
      event.created_at, event.created_at, NULL, 1, 'committed'
    FROM work_item_events_v6 AS event
    INNER JOIN work_items_v6 AS item ON item.id = event.work_item_id;

    INSERT OR IGNORE INTO resource_event_headers_v6 (
      event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id,
      grant_id, grant_revision, operation_id, idempotency_key_fingerprint,
      occurred_at, committed_at, supersedes_event_id, payload_schema_revision, effect
    )
    SELECT
      event.event_id, 'work_item', event.parent_work_item_id,
      parent.root_session_id, 'session', parent.target_session_id,
      event.event_kind, event.aggregate_revision, 'system', NULL, NULL, NULL,
      'migration:work-item-aggregation-history', NULL,
      COALESCE(json_extract(event.payload_json, '$.occurredAt'), aggregation.updated_at),
      COALESCE(json_extract(event.payload_json, '$.occurredAt'), aggregation.updated_at), NULL, 1, 'committed'
    FROM work_item_aggregation_events_v6 AS event
    INNER JOIN work_items_v6 AS parent ON parent.id = event.parent_work_item_id
    INNER JOIN work_item_aggregations_v6 AS aggregation
      ON aggregation.parent_work_item_id = event.parent_work_item_id;
  `);
}

function ensureJsonColumn(db: DatabaseSync, tableName: string, columnName: string): void {
  if (!tableExists(db, tableName) || tableColumnNames(db, tableName).has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT CHECK (${columnName} IS NULL OR json_valid(${columnName}))`);
}

function ensureTextColumn(db: DatabaseSync, tableName: string, columnName: string): void {
  if (!tableExists(db, tableName) || tableColumnNames(db, tableName).has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} TEXT`);
}

function backfillSagaOperationIds(db: DatabaseSync): void {
  backfillSagaOperationIdsForTable(db, {
    projectionTable: "session_file_write_idempotency_v6",
    eventTable: "session_file_write_events_v6",
    operation: "session.files.write_text",
    operationKind: "session-file-write",
  });
  backfillSagaOperationIdsForTable(db, {
    projectionTable: "session_transcript_export_idempotency_v6",
    eventTable: "session_transcript_export_events_v6",
    operation: "transcript.export",
    operationKind: "session-transcript-export",
  });
}

function backfillSagaOperationIdsForTable(db: DatabaseSync, input: {
  projectionTable: string;
  eventTable: string;
  operation: "session.files.write_text" | "transcript.export";
  operationKind: "session-file-write" | "session-transcript-export";
}): void {
  const rows = db.prepare(`
    SELECT principal_kind, principal_id, idempotency_key, request_fingerprint, session_id, operation_id
    FROM ${input.projectionTable}
    WHERE operation = ?
    ORDER BY idempotency_key
  `).all(input.operation) as Array<{
    idempotency_key: string;
    request_fingerprint: string;
    session_id: string;
    operation_id: string | null;
    principal_kind: string;
    principal_id: string;
  }>;
  const claimed = new Set(rows.flatMap((row) => row.operation_id === null ? [] : [row.operation_id]));
  const update = db.prepare(`
    UPDATE ${input.projectionTable}
    SET operation_id = ?
    WHERE operation = ? AND idempotency_key = ? AND operation_id IS NULL
  `);
  for (const row of rows) {
    if (row.operation_id !== null) continue;
    const legacyOperationId = `${input.operationKind}:${row.request_fingerprint}`;
    const legacyEvent = db.prepare(`
      SELECT 1 FROM ${input.eventTable}
      WHERE operation_id = ? AND session_id = ?
      LIMIT 1
    `).get(legacyOperationId, row.session_id);
    const operationId = legacyEvent !== undefined && !claimed.has(legacyOperationId)
      ? legacyOperationId
      : createSagaOperationId(
        input.operationKind,
        `${row.principal_kind}:${row.principal_id}:${row.idempotency_key}`,
        row.request_fingerprint,
      );
    update.run(operationId, input.operation, row.idempotency_key);
    claimed.add(operationId);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${input.projectionTable}_operation_id
    ON ${input.projectionTable}(operation_id)`);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) !== undefined;
}

function tableColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}
