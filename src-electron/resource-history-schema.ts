import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  type MutationAuthorityProof,
  type ResourceEventHeader,
} from "../src/session-authority.js";
import {
  SESSION_RUNTIME_MAX_BODY_BYTES,
  SESSION_RUNTIME_MAX_RESPONSE_BYTES,
} from "../src/session-external-runtime-contract.js";
import { WORK_ITEM_CONTRACT_REVISION } from "../src/work-item.js";
import { appendResourceEventHeader } from "./session-authority-storage.js";

const RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES = 64 * 1024;
const RESOURCE_HISTORY_ENVELOPE_BYTES = 1024 * 1024;
const SESSION_RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES = SESSION_RUNTIME_MAX_BODY_BYTES + RESOURCE_HISTORY_ENVELOPE_BYTES;
const SESSION_EXECUTION_HISTORY_PAYLOAD_LIMIT_BYTES =
  SESSION_RUNTIME_MAX_BODY_BYTES + SESSION_RUNTIME_MAX_RESPONSE_BYTES + RESOURCE_HISTORY_ENVELOPE_BYTES;

export function ensureResourceHistorySchema(
  db: DatabaseSync,
  options: { backfillLegacyHistory: boolean },
): void {
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
      CHECK (length(CAST(payload_json AS BLOB)) <= ${SESSION_RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES}),
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
      CHECK (length(CAST(payload_json AS BLOB)) <= ${SESSION_EXECUTION_HISTORY_PAYLOAD_LIMIT_BYTES}),
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

  if (options.backfillLegacyHistory) {
    backfillSagaOperationIds(db);
    backfillResourceHistory(db);
  }
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
  verifySnapshotProjection(db, {
    resourceTable: "sessions_v6",
    eventTable: "session_resource_events_v6",
    resourceIdColumn: "id",
    eventResourceIdColumn: "session_id",
    label: "Session",
    payloadSchemaRevision: 2,
    readProjection: readSessionProjection,
  });

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
  verifySnapshotProjection(db, {
    resourceTable: "session_executions_v6",
    eventTable: "session_execution_events_v6",
    resourceIdColumn: "id",
    eventResourceIdColumn: "execution_id",
    label: "Session execution",
    payloadSchemaRevision: 2,
    readProjection: readSessionExecutionProjection,
  });

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
  verifyWorkItemReplay(db);
  verifyWorkItemAggregationReplay(db);

  verifySagaProjection(db, {
    projectionTable: "session_file_write_idempotency_v6",
    eventTable: "session_file_write_events_v6",
    label: "Session file write",
    operationKind: "session-file-write",
  });
  verifySagaProjection(db, {
    projectionTable: "session_transcript_export_idempotency_v6",
    eventTable: "session_transcript_export_events_v6",
    label: "Session transcript export",
    operationKind: "session-transcript-export",
  });
  verifyInteractionReplay(db);
  verifyCoordinationReplay(db);
  verifyResourceEventHeaders(db);
}

type ExpectedHeaderRow = {
  event_id: string;
  resource_kind: string;
  resource_id: string;
  root_id: string;
  owner_id: string;
  event_kind: string;
  resource_revision: number | null;
  principal_kind: string | null;
  actor_session_id: string | null;
  supersedes_event_id: string | null;
  payload_schema_revision: number;
  effect: string;
};

type StoredHeaderRow = ExpectedHeaderRow & {
  owner_kind: string;
  grant_id: string | null;
  grant_revision: number | null;
  operation_id: string;
};

function verifyResourceEventHeaders(db: DatabaseSync): void {
  const expected = db.prepare(`
    SELECT event.event_id, 'session' AS resource_kind, event.session_id AS resource_id,
      COALESCE(binding.root_session_id, event.session_id) AS root_id, event.session_id AS owner_id,
      event.event_kind, event.revision AS resource_revision, NULL AS principal_kind,
      NULL AS actor_session_id, NULL AS supersedes_event_id, 2 AS payload_schema_revision,
      'committed' AS effect
    FROM session_resource_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id
    UNION ALL
    SELECT event.event_id, 'execution', event.execution_id,
      COALESCE(binding.root_session_id, event.session_id), event.session_id,
      event.event_kind, event.revision, NULL, NULL, NULL, 2, 'committed'
    FROM session_execution_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id
    UNION ALL
    SELECT 'work-item:' || event.work_item_id || ':revision:' || event.revision,
      'work_item', event.work_item_id, item.root_session_id, item.target_session_id,
      event.event_type, event.revision,
      event.principal_kind,
      CASE WHEN event.principal_kind = 'agent' THEN event.actor_session_id ELSE NULL END,
      NULL, 1, 'committed'
    FROM work_item_events_v6 AS event
    INNER JOIN work_items_v6 AS item ON item.id = event.work_item_id
    UNION ALL
    SELECT event.event_id, 'work_item', event.parent_work_item_id,
      item.root_session_id, item.target_session_id, event.event_kind,
      event.aggregate_revision, NULL, NULL, NULL, 1, 'committed'
    FROM work_item_aggregation_events_v6 AS event
    INNER JOIN work_items_v6 AS item ON item.id = event.parent_work_item_id
    UNION ALL
    SELECT event.event_id, 'session_files', event.operation_id,
      COALESCE(binding.root_session_id, event.session_id), event.session_id,
      event.event_kind, event.revision, NULL, NULL, NULL, 1,
      CASE event.event_kind WHEN 'prepared' THEN 'none' WHEN 'applied' THEN 'committed' ELSE 'unknown' END
    FROM session_file_write_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id
    UNION ALL
    SELECT event.event_id, 'transcript', event.operation_id,
      COALESCE(binding.root_session_id, event.session_id), event.session_id,
      event.event_kind, event.revision, NULL, NULL, NULL, 1,
      CASE event.event_kind WHEN 'prepared' THEN 'none' WHEN 'applied' THEN 'committed' ELSE 'unknown' END
    FROM session_transcript_export_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id
    UNION ALL
    SELECT event.id, 'interaction', event.interaction_id,
      COALESCE(binding.root_session_id, event.session_id), event.session_id,
      event.event_kind, event.interaction_revision, event.principal_kind, event.actor_session_id,
      CASE WHEN event.interaction_revision = 1 OR event.event_kind = 'migration_baseline' THEN NULL
        ELSE 'interaction:' || event.interaction_id || ':revision:' || (event.interaction_revision - 1) END,
      1, 'committed'
    FROM session_interaction_events_v6 AS event
    LEFT JOIN session_role_bindings_v6 AS binding ON binding.session_id = event.session_id
    UNION ALL
    SELECT event.id, 'coordination_event', event.id, event.root_session_id, event.actor_session_id,
      'coordination_event_created', NULL, event.creation_principal_kind,
      CASE WHEN event.creation_principal_kind = 'agent' THEN event.actor_session_id ELSE NULL END,
      event.corrected_event_id, 1, 'committed'
    FROM coordination_events_v6 AS event
    UNION ALL
    SELECT action.id, 'coordination_event', action.event_id, event.root_session_id, event.actor_session_id,
      'coordination_event_' || action.action_type,
      (SELECT COUNT(*) FROM coordination_event_actions_v6 AS prior
       WHERE prior.event_id = action.event_id AND prior.sequence <= action.sequence),
      action.principal_kind, action.actor_session_id, NULL, 1, 'committed'
    FROM coordination_event_actions_v6 AS action
    INNER JOIN coordination_events_v6 AS event ON event.id = action.event_id
  `).all() as ExpectedHeaderRow[];
  const actual = db.prepare(`
    SELECT event_id, resource_kind, resource_id, root_id, owner_kind, owner_id,
      event_kind, resource_revision, principal_kind, actor_session_id, grant_id,
      grant_revision, operation_id, supersedes_event_id, payload_schema_revision, effect
    FROM resource_event_headers_v6
    WHERE resource_kind IN ('session', 'execution', 'work_item', 'session_files',
      'transcript', 'interaction', 'coordination_event')
  `).all() as StoredHeaderRow[];
  const actualById = new Map(actual.map((row) => [row.event_id, row]));
  if (actualById.size !== expected.length || actual.length !== expected.length) {
    throw new Error("Resource event header coverage does not match the typed event history.");
  }
  for (const row of expected) {
    const header = actualById.get(row.event_id);
    if (!header) throw new Error(`Resource event header is missing: ${row.event_id}`);
    const comparable = {
      resourceKind: header.resource_kind,
      resourceId: header.resource_id,
      rootId: header.root_id,
      ownerKind: header.owner_kind,
      ownerId: header.owner_id,
      eventKind: header.event_kind,
      resourceRevision: header.resource_revision,
      supersedesEventId: header.supersedes_event_id,
      payloadSchemaRevision: header.payload_schema_revision,
      effect: header.effect,
    };
    const expectedComparable = {
      resourceKind: row.resource_kind,
      resourceId: row.resource_id,
      rootId: row.root_id,
      ownerKind: "session",
      ownerId: row.owner_id,
      eventKind: row.event_kind,
      resourceRevision: row.resource_revision,
      supersedesEventId: row.supersedes_event_id,
      payloadSchemaRevision: row.payload_schema_revision,
      effect: row.effect,
    };
    if (stableJson(comparable) !== stableJson(expectedComparable)) {
      const differingField = Object.keys(expectedComparable).find((key) =>
        stableJson(comparable[key as keyof typeof comparable])
          !== stableJson(expectedComparable[key as keyof typeof expectedComparable]));
      throw new Error(`Resource event header ${differingField ?? "fields"} does not match its typed event: ${row.event_id}`);
    }
    if (row.principal_kind !== null
      && (header.principal_kind !== row.principal_kind || header.actor_session_id !== row.actor_session_id)) {
      throw new Error(`Resource event header principal does not match its typed event: ${row.event_id}`);
    }
    verifyHeaderGrant(db, header);
  }
}

function verifyHeaderGrant(db: DatabaseSync, header: StoredHeaderRow): void {
  if (header.principal_kind !== "agent") {
    if (header.actor_session_id !== null || header.grant_id !== null || header.grant_revision !== null) {
      throw new Error(`Resource event header has an invalid non-agent grant tuple: ${header.event_id}`);
    }
    return;
  }
  if (header.actor_session_id === null) {
    throw new Error(`Resource event header has no agent identity: ${header.event_id}`);
  }
  if (header.grant_id === null || header.grant_revision === null) {
    if (header.operation_id.startsWith("migration:")) return;
    throw new Error(`Resource event header has no agent grant identity: ${header.event_id}`);
  }
  const grant = db.prepare(`
    SELECT grantee_session_id, revision
    FROM session_authority_grants_v6
    WHERE grant_id = ?
  `).get(header.grant_id) as { grantee_session_id: string; revision: number } | undefined;
  const grantEvent = db.prepare(`
    SELECT 1
    FROM session_authority_grant_events_v6
    WHERE grant_id = ? AND grant_revision = ?
  `).get(header.grant_id, header.grant_revision);
  if (!grant || !grantEvent || grant.grantee_session_id !== header.actor_session_id || header.grant_revision > grant.revision) {
    throw new Error(`Resource event header grant does not match its agent principal: ${header.event_id}`);
  }
}

function verifyWorkItemReplay(db: DatabaseSync): void {
  const items = db.prepare(`
    SELECT id, sequence, contract_revision, kind, root_session_id, creator_session_id,
      target_session_id, parent_work_item_id, goal, scope, completion_criteria, authority,
      source_identity_json, state, revision, progress_summary, blockers_json, next_action,
      result_json, created_at, updated_at
    FROM work_items_v6
  `).all() as Array<Record<string, string | number | null>>;
  const readEvents = db.prepare(`
    SELECT revision, event_type, principal_kind, actor_session_id, payload_json, created_at
    FROM work_item_events_v6
    WHERE work_item_id = ?
    ORDER BY revision
  `);
  for (const item of items) {
    const events = readEvents.all(item.id) as Array<{
      revision: number;
      event_type: string;
      principal_kind: string;
      actor_session_id: string | null;
      payload_json: string;
      created_at: string;
    }>;
    const first = events[0];
    if (!first) throw new Error(`Work Item event replay is empty: ${item.id}`);
    for (const event of events) {
      if (event.principal_kind === "system"
        && event.event_type === "created"
        && item.kind === "root"
        && event.actor_session_id !== item.target_session_id) {
        throw new Error(`Work Item system actor does not match its canonical owner: ${item.id}`);
      }
    }
    const initial = JSON.parse(first.payload_json) as Record<string, unknown>;
    const replay = {
      kind: initial.kind,
      rootSessionId: initial.rootSessionId,
      creatorSessionId: initial.creatorSessionId,
      targetSessionId: initial.targetSessionId,
      parentWorkItemId: initial.parentWorkItemId,
      sourceIdentity: initial.sourceIdentity,
      contract: initial.contract,
      progress: initial.progress,
      state: initial.state,
      result: initial.result,
      updatedAt: first.created_at,
    };
    for (const event of events.slice(1)) {
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      if (event.event_type === "contract_revised") {
        if (stableJson(payload.before) !== stableJson(replay.contract)) {
          throw new Error(`Work Item contract event cannot replay from its predecessor: ${item.id}`);
        }
        replay.contract = payload.after;
      } else if (event.event_type === "progress" || event.event_type === "handoff") {
        replay.progress = payload;
      } else if (event.event_type === "state_transitioned") {
        if (payload.from !== replay.state) {
          throw new Error(`Work Item state event cannot replay from its predecessor: ${item.id}`);
        }
        replay.state = payload.to;
      } else if (event.event_type === "result_reported") {
        if (payload.from !== replay.state) {
          throw new Error(`Work Item result event cannot replay from its predecessor: ${item.id}`);
        }
        replay.state = payload.to;
        replay.result = payload.result;
      } else {
        throw new Error(`Work Item event kind cannot follow the baseline: ${item.id}`);
      }
      replay.updatedAt = event.created_at;
    }
    const current = {
      kind: item.kind,
      rootSessionId: item.root_session_id,
      creatorSessionId: item.creator_session_id,
      targetSessionId: item.target_session_id,
      parentWorkItemId: item.parent_work_item_id,
      sourceIdentity: JSON.parse(String(item.source_identity_json)),
      contract: {
        goal: item.goal,
        scope: item.scope,
        completionCriteria: item.completion_criteria,
        authority: item.authority,
      },
      progress: {
        progressSummary: item.progress_summary,
        blockers: JSON.parse(String(item.blockers_json)),
        nextAction: item.next_action,
      },
      state: item.state,
      result: item.result_json === null ? null : JSON.parse(String(item.result_json)),
      updatedAt: item.updated_at,
    };
    if (stableJson(replay) !== stableJson(current)
      || Number(item.contract_revision) !== WORK_ITEM_CONTRACT_REVISION
      || Number(item.sequence) < 1
      || (first.event_type === "created" && first.created_at !== item.created_at)) {
      throw new Error(`Work Item event replay does not match the current projection: ${item.id}`);
    }
  }
}

function verifyWorkItemAggregationReplay(db: DatabaseSync): void {
  const aggregations = db.prepare(`
    SELECT parent_work_item_id, aggregate_revision, updated_at
    FROM work_item_aggregations_v6
  `).all() as Array<{ parent_work_item_id: string; aggregate_revision: number; updated_at: string }>;
  const readEvents = db.prepare(`
    SELECT event.child_work_item_id, event.aggregate_revision, event.event_kind,
      event.payload_json, header.occurred_at
    FROM work_item_aggregation_events_v6 AS event
    INNER JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id
    WHERE event.parent_work_item_id = ?
    ORDER BY event.aggregate_revision
  `);
  for (const aggregation of aggregations) {
    const events = readEvents.all(aggregation.parent_work_item_id) as Array<{
      child_work_item_id: string;
      aggregate_revision: number;
      event_kind: string;
      payload_json: string;
      occurred_at: string;
    }>;
    if (events.length !== aggregation.aggregate_revision
      || events.at(-1)?.occurred_at !== aggregation.updated_at) {
      throw new Error(`Work Item aggregation event replay does not match the current projection: ${aggregation.parent_work_item_id}`);
    }
    const childAdditions = new Set<string>();
    const decisions = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      if (payload.childWorkItemId !== undefined && payload.childWorkItemId !== event.child_work_item_id) {
        throw new Error(`Work Item aggregation event child identity is inconsistent: ${aggregation.parent_work_item_id}`);
      }
      if (event.event_kind === "child_added") childAdditions.add(event.child_work_item_id);
      if (event.event_kind === "decided" || event.event_kind === "retry_requested") {
        decisions.set(event.child_work_item_id, payload);
      }
    }
    const children = db.prepare(`
      SELECT id FROM work_items_v6 WHERE parent_work_item_id = ?
    `).all(aggregation.parent_work_item_id) as Array<{ id: string }>;
    if (children.some((child) => !childAdditions.has(child.id)) || childAdditions.size !== children.length) {
      throw new Error(`Work Item aggregation child replay does not match the current projection: ${aggregation.parent_work_item_id}`);
    }
    const storedDecisions = db.prepare(`
      SELECT child_work_item_id, child_revision, decision_type, reason, replacement_work_item_id
      FROM work_item_aggregation_decisions_v6
      WHERE parent_work_item_id = ?
    `).all(aggregation.parent_work_item_id) as Array<{
      child_work_item_id: string;
      child_revision: number;
      decision_type: string;
      reason: string | null;
      replacement_work_item_id: string | null;
    }>;
    for (const decision of storedDecisions) {
      const replayed = decisions.get(decision.child_work_item_id);
      const expected = {
        childRevision: decision.child_revision,
        decision: decision.decision_type,
        reason: decision.reason,
        replacementWorkItemId: decision.replacement_work_item_id,
      };
      if (!replayed || stableJson({
        childRevision: replayed.childRevision,
        decision: replayed.decision,
        reason: replayed.reason ?? null,
        replacementWorkItemId: replayed.replacementWorkItemId ?? null,
      }) !== stableJson(expected)) {
        throw new Error(`Work Item aggregation decision replay does not match the current projection: ${decision.child_work_item_id}`);
      }
    }
    if (decisions.size !== storedDecisions.length) {
      throw new Error(`Work Item aggregation decision history has no current projection: ${aggregation.parent_work_item_id}`);
    }
  }
}

function verifyInteractionReplay(db: DatabaseSync): void {
  const interactions = db.prepare(`
    SELECT interaction.id, interaction.sequence, interaction.revision, execution.session_id,
      interaction.execution_id, interaction.kind, interaction.decision_class, interaction.state,
      interaction.public_payload_json, interaction.response_action,
      interaction.response_submitted_fields_json, interaction.response_principal_kind,
      interaction.response_actor_session_id, interaction.expiry_reason, interaction.created_at,
      interaction.resolved_at, interaction.updated_at
    FROM session_interactions_v6 AS interaction
    INNER JOIN session_executions_v6 AS execution ON execution.id = interaction.execution_id
  `).all() as Array<Record<string, string | number | null>>;
  const readHistory = db.prepare(`
    SELECT COUNT(*) AS event_count, MIN(interaction_revision) AS first_revision,
      MAX(interaction_revision) AS last_revision,
      MAX(CASE WHEN event_kind = 'migration_baseline' THEN interaction_revision END) AS baseline_revision
    FROM session_interaction_events_v6
    WHERE interaction_id = ?
  `);
  const readLatest = db.prepare(`
    SELECT projection_json FROM session_interaction_events_v6
    WHERE interaction_id = ? ORDER BY interaction_revision DESC LIMIT 1
  `);
  for (const row of interactions) {
    const history = readHistory.get(row.id) as {
      event_count: number;
      first_revision: number | null;
      last_revision: number | null;
      baseline_revision: number | null;
    };
    const firstRevision = history.first_revision;
    const lastRevision = history.last_revision;
    if (firstRevision === null
      || lastRevision === null
      || lastRevision !== row.revision
      || history.event_count !== lastRevision - firstRevision + 1
      || (firstRevision !== 1 && history.baseline_revision !== firstRevision)) {
      throw new Error(`Session interaction event history is incomplete: ${row.id}`);
    }
    const latest = readLatest.get(row.id) as { projection_json: string } | undefined;
    const principalKind = row.response_principal_kind;
    const resolvedBy = principalKind === "agent" && typeof row.response_actor_session_id === "string"
      ? { kind: "agent", sessionId: row.response_actor_session_id }
      : principalKind === "user" || principalKind === "system" ? { kind: principalKind } : null;
    const projection = {
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
    };
    if (!latest || stableJson(JSON.parse(latest.projection_json)) !== stableJson(projection)) {
      throw new Error(`Session interaction event replay does not match the current projection: ${row.id}`);
    }
  }
  const missingSupersedesTarget = db.prepare(`
    SELECT header.event_id
    FROM resource_event_headers_v6 AS header
    LEFT JOIN resource_event_headers_v6 AS superseded
      ON superseded.event_id = header.supersedes_event_id
    WHERE header.resource_kind = 'interaction'
      AND header.supersedes_event_id IS NOT NULL
      AND superseded.event_id IS NULL
    LIMIT 1
  `).get() as { event_id: string } | undefined;
  if (missingSupersedesTarget) {
    throw new Error(`Session interaction event supersedes target is missing: ${missingSupersedesTarget.event_id}`);
  }
}

function verifyCoordinationReplay(db: DatabaseSync): void {
  const rows = db.prepare(`
    SELECT operation, principal_kind, result_event_id, target_event_id, result_revision, operation_id
    FROM coordination_event_idempotency_v6
  `).all() as Array<{
    operation: string;
    principal_kind: string;
    result_event_id: string;
    target_event_id: string | null;
    result_revision: number;
    operation_id: string;
  }>;
  const findHeader = db.prepare(`
    SELECT 1 FROM resource_event_headers_v6
    WHERE operation_id = ? AND resource_kind = 'coordination_event'
      AND resource_id = ? AND COALESCE(resource_revision, 0) = ?
    LIMIT 1
  `);
  const findRevision = db.prepare(`
    SELECT 1 FROM resource_event_headers_v6
    WHERE resource_kind = 'coordination_event'
      AND resource_id = ? AND COALESCE(resource_revision, 0) = ?
    LIMIT 1
  `);
  for (const row of rows) {
    const resultRevision = row.operation === "coordination.event.correct" ? 0 : row.result_revision;
    const findReplayHeader = row.principal_kind === "legacy_unknown" ? findRevision : findHeader;
    const result = row.principal_kind === "legacy_unknown"
      ? findReplayHeader.get(row.result_event_id, resultRevision)
      : findReplayHeader.get(row.operation_id, row.result_event_id, resultRevision);
    const target = row.operation !== "coordination.event.correct" || row.target_event_id === null
      ? true
      : (row.principal_kind === "legacy_unknown"
        ? findRevision.get(row.target_event_id, row.result_revision)
        : findHeader.get(row.operation_id, row.target_event_id, row.result_revision)) !== undefined;
    if (result === undefined || !target) {
      throw new Error(`Coordination event idempotency cannot replay its result revision: ${row.result_event_id}`);
    }
  }
}

function verifySagaProjection(db: DatabaseSync, input: {
  projectionTable: string;
  eventTable: string;
  label: string;
  operationKind: "session-file-write" | "session-transcript-export";
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

  const projections = db.prepare(`
    SELECT idempotency_key, request_fingerprint, session_id, relative_path, temp_name,
      state, result_json, principal_kind, principal_id, operation_id
    FROM ${input.projectionTable}
  `).all() as Array<{
    idempotency_key: string;
    request_fingerprint: string;
    session_id: string;
    relative_path: string;
    temp_name: string;
    state: "pending" | "applied" | "rejected";
    result_json: string | null;
    principal_kind: string;
    principal_id: string;
    operation_id: string;
  }>;
  const readEvents = db.prepare(`
    SELECT event.revision, event.session_id, event.event_kind, event.payload_json,
      header.principal_kind, header.actor_session_id, header.operation_id,
      header.idempotency_key_fingerprint
    FROM ${input.eventTable} AS event
    INNER JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id
    WHERE event.operation_id = ?
    ORDER BY event.revision
  `);
  for (const projection of projections) {
    const expectedOperationId = createSagaOperationId(
      input.operationKind,
      `${projection.principal_kind}:${projection.principal_id}:${projection.idempotency_key}`,
      projection.request_fingerprint,
    );
    const legacyOperationId = `${input.operationKind}:${projection.request_fingerprint}`;
    const events = readEvents.all(projection.operation_id) as Array<{
      revision: number;
      session_id: string;
      event_kind: string;
      payload_json: string;
      principal_kind: string;
      actor_session_id: string | null;
      operation_id: string;
      idempotency_key_fingerprint: string | null;
    }>;
    const expectedFingerprint = createHash("sha256").update(projection.idempotency_key).digest("hex");
    const invalidEvent = events.find((event) => {
      if (event.session_id !== projection.session_id) return true;
      if (projection.principal_kind === "legacy_unknown") {
        return !event.operation_id.startsWith("migration:")
          || event.idempotency_key_fingerprint !== null
          || event.principal_kind !== "system"
          || event.actor_session_id !== null;
      }
      return event.operation_id !== projection.operation_id
        || event.idempotency_key_fingerprint !== expectedFingerprint
        || event.principal_kind !== projection.principal_kind
        || (projection.principal_kind === "agent" && event.actor_session_id !== projection.principal_id)
        || (projection.principal_kind !== "agent" && event.actor_session_id !== null);
    });
    const prepared = events.find((event) => event.revision === 1);
    const latest = events.at(-1);
    const preparedPayload = prepared ? JSON.parse(prepared.payload_json) as Record<string, unknown> : null;
    const latestPayload = latest ? JSON.parse(latest.payload_json) as Record<string, unknown> : null;
    const terminalKey = projection.state === "applied" ? "result" : "error";
    const expectedResult = projection.result_json === null ? undefined : JSON.parse(projection.result_json) as unknown;
    const incarnation = projection.operation_id.slice(expectedOperationId.length);
    const matchesIdentity = projection.operation_id.startsWith(expectedOperationId)
      && (incarnation === "" || /^:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incarnation));
    if ((!matchesIdentity
      && !(projection.principal_kind === "legacy_unknown" && projection.operation_id === legacyOperationId))
      || invalidEvent
      || preparedPayload?.relativePath !== projection.relative_path
      || preparedPayload?.tempName !== projection.temp_name
      || latestPayload?.relativePath !== projection.relative_path
      || (projection.state !== "pending" && stableJson(latestPayload?.[terminalKey]) !== stableJson(expectedResult))) {
      throw new Error(`${input.label} idempotency replay does not match its resource history: ${projection.idempotency_key}`);
    }
  }
}

export function getSessionResourceRevision(db: DatabaseSync, sessionId: string): number | null {
  const row = db.prepare("SELECT resource_revision FROM sessions_v6 WHERE id = ? AND deleted_at IS NULL").get(sessionId) as
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
    values: [input.sessionId, input.revision, input.eventKind, serializePayload({
      ...input.payload,
      projection: readSessionProjection(db, input.sessionId),
    }, SESSION_RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES)],
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
    values: [input.executionId, row.session_id, input.revision, input.eventKind, serializePayload({
      ...input.payload,
      projection: readSessionExecutionProjection(db, input.executionId),
    }, SESSION_EXECUTION_HISTORY_PAYLOAD_LIMIT_BYTES)],
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
    payloadSchemaRevision: input.resourceKind === "session" || input.resourceKind === "execution" ? 2 : 1,
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

function serializePayload(
  payload: Readonly<Record<string, unknown>>,
  maxBytes = RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES,
): string {
  const result = JSON.stringify(payload);
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    throw new TypeError("Resource history event payload exceeds the byte limit.");
  }
  return result;
}

function verifySnapshotProjection(db: DatabaseSync, input: {
  resourceTable: string;
  eventTable: string;
  resourceIdColumn: string;
  eventResourceIdColumn: string;
  label: string;
  payloadSchemaRevision: number;
  readProjection: (db: DatabaseSync, resourceId: string) => Readonly<Record<string, unknown>>;
}): void {
  const resources = db.prepare(`SELECT ${input.resourceIdColumn} AS id FROM ${input.resourceTable}`)
    .all() as Array<{ id: string }>;
  const readEvents = db.prepare(`
    SELECT event.payload_json, header.payload_schema_revision
    FROM ${input.eventTable} AS event
    INNER JOIN resource_event_headers_v6 AS header ON header.event_id = event.event_id
    WHERE event.${input.eventResourceIdColumn} = ?
    ORDER BY event.revision ASC
  `);
  for (const resource of resources) {
    let replayed: unknown;
    for (const row of readEvents.all(resource.id) as Array<{ payload_json: string; payload_schema_revision: number }>) {
      if (row.payload_schema_revision !== input.payloadSchemaRevision) {
        throw new Error(`${input.label} event payload schema revision is unsupported: ${resource.id}`);
      }
      const payload = JSON.parse(row.payload_json) as { projection?: unknown };
      if (payload.projection === undefined) {
        throw new Error(`${input.label} event payload cannot reconstruct the projection: ${resource.id}`);
      }
      replayed = payload.projection;
    }
    if (replayed === undefined || stableJson(replayed) !== stableJson(input.readProjection(db, resource.id))) {
      throw new Error(`${input.label} event replay does not match the current projection: ${resource.id}`);
    }
  }
}

function readSessionProjection(db: DatabaseSync, sessionId: string): Readonly<Record<string, unknown>> {
  const row = db.prepare(`
    SELECT title, state, session_kind, provider_id, catalog_revision, model_id,
      reasoning_effort, custom_agent_name, approval_mode, codex_sandbox_mode,
      allowed_additional_directories_json, runtime_policy_json, thread_id,
      character_id, character_snapshot_json, project_scope_id, workspace_path,
      is_pinned, created_at, updated_at, last_active_at, deleted_at
    FROM sessions_v6
    WHERE id = ?
  `).get(sessionId) as {
    title: string;
    state: string;
    session_kind: string;
    provider_id: string;
    catalog_revision: number;
    model_id: string;
    reasoning_effort: string;
    custom_agent_name: string;
    approval_mode: string;
    codex_sandbox_mode: string;
    allowed_additional_directories_json: string;
    runtime_policy_json: string;
    thread_id: string;
    character_id: string | null;
    character_snapshot_json: string | null;
    project_scope_id: string | null;
    workspace_path: string;
    is_pinned: number;
    created_at: string;
    updated_at: string;
    last_active_at: string;
    deleted_at: string | null;
  } | undefined;
  if (!row) throw new Error(`Session was not found: ${sessionId}`);
  return {
    title: row.title,
    state: row.state,
    sessionKind: row.session_kind,
    providerId: row.provider_id,
    catalogRevision: row.catalog_revision,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
    customAgentName: row.custom_agent_name,
    approvalMode: row.approval_mode,
    codexSandboxMode: row.codex_sandbox_mode,
    allowedAdditionalDirectories: JSON.parse(row.allowed_additional_directories_json) as unknown,
    runtimePolicy: JSON.parse(row.runtime_policy_json) as unknown,
    threadId: row.thread_id,
    characterId: row.character_id,
    characterSnapshot: row.character_snapshot_json === null ? null : JSON.parse(row.character_snapshot_json) as unknown,
    projectScopeId: row.project_scope_id,
    workspacePath: row.workspace_path,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}

function readSessionExecutionProjection(db: DatabaseSync, executionId: string): Readonly<Record<string, unknown>> {
  const row = db.prepare(`
    SELECT execution.sequence, execution.operation, execution.state, execution.request_json,
      execution.result_json, execution.error_code, execution.reason, execution.created_at,
      execution.admitted_at, execution.completed_at, execution.updated_at,
      execution.authority_proof_json, association.work_item_id
    FROM session_executions_v6 AS execution
    LEFT JOIN work_item_execution_associations_v6 AS association ON association.execution_id = execution.id
    WHERE execution.id = ?
  `).get(executionId) as {
    sequence: number;
    operation: string;
    state: string;
    request_json: string;
    result_json: string | null;
    error_code: string;
    reason: string;
    created_at: string;
    admitted_at: string | null;
    completed_at: string | null;
    updated_at: string;
    authority_proof_json: string | null;
    work_item_id: string | null;
  } | undefined;
  if (!row) throw new Error(`Session execution was not found: ${executionId}`);
  return {
    sequence: row.sequence,
    operation: row.operation,
    state: row.state,
    request: JSON.parse(row.request_json) as unknown,
    result: row.result_json === null ? null : JSON.parse(row.result_json) as unknown,
    errorCode: row.error_code,
    reason: row.reason,
    createdAt: row.created_at,
    admittedAt: row.admitted_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    authorityProof: row.authority_proof_json === null ? null : JSON.parse(row.authority_proof_json) as unknown,
    workItemId: row.work_item_id,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function backfillResourceHistory(db: DatabaseSync): void {
  const insertSessionEvent = db.prepare(`
    INSERT OR IGNORE INTO session_resource_events_v6 (
      event_id, session_id, revision, event_kind, payload_json
    ) VALUES (?, ?, ?, 'migration_baseline', ?)
  `);
  const sessions = db.prepare("SELECT id, resource_revision FROM sessions_v6")
    .all() as Array<{ id: string; resource_revision: number }>;
  for (const session of sessions) {
    insertSessionEvent.run(
      `session:${session.id}:revision:${session.resource_revision}`,
      session.id,
      session.resource_revision,
      serializePayload({ projection: readSessionProjection(db, session.id) }, SESSION_RESOURCE_HISTORY_PAYLOAD_LIMIT_BYTES),
    );
  }

  const insertExecutionEvent = db.prepare(`
    INSERT OR IGNORE INTO session_execution_events_v6 (
      event_id, execution_id, session_id, revision, event_kind, payload_json
    )
    SELECT ?, execution.id, execution.session_id, execution.revision, 'migration_baseline', ?
    FROM session_executions_v6 AS execution
    WHERE execution.id = ?
  `);
  const executions = db.prepare("SELECT id, revision FROM session_executions_v6")
    .all() as Array<{ id: string; revision: number }>;
  for (const execution of executions) {
    insertExecutionEvent.run(
      `execution:${execution.id}:revision:${execution.revision}`,
      serializePayload(
        { projection: readSessionExecutionProjection(db, execution.id) },
        SESSION_EXECUTION_HISTORY_PAYLOAD_LIMIT_BYTES,
      ),
      execution.id,
    );
  }

  db.exec(`
    INSERT OR IGNORE INTO session_file_write_events_v6 (
      event_id, operation_id, session_id, revision, event_kind, payload_json
    )
    SELECT
      'session_files:' || write.operation_id || ':revision:1',
      write.operation_id,
      write.session_id,
      1,
      CASE write.state WHEN 'pending' THEN 'prepared' WHEN 'applied' THEN 'applied' ELSE 'rejected' END,
      json_patch(json_object(
        'relativePath', write.relative_path,
        'tempName', write.temp_name,
        'migrationBaseline', 1,
        'occurredAt', write.created_at
      ), CASE write.state
        WHEN 'applied' THEN json_object('result', json(write.result_json))
        WHEN 'rejected' THEN json_object('error', json(write.result_json))
        ELSE json_object()
      END)
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
      json_patch(json_object(
        'relativePath', export.relative_path,
        'tempName', export.temp_name,
        'migrationBaseline', 1,
        'occurredAt', export.created_at
      ), CASE export.state
        WHEN 'applied' THEN json_object('result', json(export.result_json))
        WHEN 'rejected' THEN json_object('error', json(export.result_json))
        ELSE json_object()
      END)
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
      json_patch(json_object(
        'relativePath', write.relative_path,
        'tempName', write.temp_name,
        'migrationReconciliation', 1,
        'occurredAt', write.created_at
      ), CASE write.state
        WHEN 'applied' THEN json_object('result', json(write.result_json))
        WHEN 'rejected' THEN json_object('error', json(write.result_json))
        ELSE json_object()
      END)
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
      json_patch(json_object(
        'relativePath', export.relative_path,
        'tempName', export.temp_name,
        'migrationReconciliation', 1,
        'occurredAt', export.created_at
      ), CASE export.state
        WHEN 'applied' THEN json_object('result', json(export.result_json))
        WHEN 'rejected' THEN json_object('error', json(export.result_json))
        ELSE json_object()
      END)
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
      COALESCE(json_extract(event.payload_json, '$.projection.updatedAt'), ''),
      COALESCE(json_extract(event.payload_json, '$.projection.updatedAt'), ''), NULL, 2, 'committed'
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
      COALESCE(json_extract(event.payload_json, '$.projection.updatedAt'), ''),
      COALESCE(json_extract(event.payload_json, '$.projection.updatedAt'), ''), NULL, 2, 'committed'
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
      event.principal_kind,
      CASE WHEN event.principal_kind = 'agent' THEN event.actor_session_id ELSE NULL END,
      NULL, NULL, 'migration:work-item-history', NULL,
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
