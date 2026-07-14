import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { REPOSITORY_READ_LIMITS, REPOSITORY_READ_OPERATIONS } from "../shared/repository-read-model.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";

const INLINE_MESSAGE_BYTES = 64 * 1024;
const MAX_PAGE_JSON_BYTES = 192 * 1024;

export const REPOSITORY_PAGE_SQL = {
  messages: `
    SELECT m.id, m.session_id, m.ordinal, m.role,
           length(CAST(m.content_blocks_json AS BLOB)) AS content_byte_length,
           CASE WHEN length(CAST(m.content_blocks_json AS BLOB)) <= ? THEN m.content_blocks_json END AS inline_content,
           m.created_at, s.workspace_key
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.session_id = ? AND s.workspace_key = ? AND m.ordinal > ?
    ORDER BY m.ordinal ASC LIMIT ?
  `,
  runEvents: `
    SELECT e.id, e.run_id, e.ordinal, e.event_code, e.subject_type, e.subject_id, e.summary, e.created_at
    FROM run_events e
    JOIN runs r ON r.id = e.run_id JOIN sessions s ON s.id = r.session_id
    WHERE e.run_id = ? AND r.session_id = ? AND s.workspace_key = ? AND e.ordinal > ?
    ORDER BY e.ordinal ASC LIMIT ?
  `,
  runOutputs: `
    SELECT o.id, o.run_id, o.ordinal, o.category, o.kind, o.summary, o.completion_state,
           o.payload_state, o.payload_original_byte_length, o.stored_payload_id, o.redaction_state, o.created_at
    FROM run_output_items o
    JOIN runs r ON r.id = o.run_id JOIN sessions s ON s.id = r.session_id
    WHERE o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
      AND o.ordinal > ?
    ORDER BY o.ordinal ASC LIMIT ?
  `,
  runOutputsByCategory: `
    SELECT o.id, o.run_id, o.ordinal, o.category, o.kind, o.summary, o.completion_state,
           o.payload_state, o.payload_original_byte_length, o.stored_payload_id, o.redaction_state, o.created_at
    FROM run_output_items o
    JOIN runs r ON r.id = o.run_id JOIN sessions s ON s.id = r.session_id
    WHERE o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
      AND o.category = ? AND o.ordinal > ?
    ORDER BY o.ordinal ASC LIMIT ?
  `,
} as const;

export type RepositoryReadOperation = Readonly<{
  requestClass: "read";
  execute: (payload: Readonly<Record<string, unknown>>) => Readonly<{ result: unknown }>;
}>;

export class RepositoryReadError extends Error {
  constructor(
    readonly code: "request_invalid" | "cursor_invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export function createRepositoryReadOperations(database: DatabaseSync): ReadonlyMap<string, RepositoryReadOperation> {
  const read = (execute: RepositoryReadOperation["execute"]): RepositoryReadOperation => ({
    requestClass: "read",
    execute,
  });
  return new Map([
    [REPOSITORY_READ_OPERATIONS.sessionsPage, read((payload) => ({ result: sessionsPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.sessionGet, read((payload) => ({ result: sessionGet(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.messagesPage, read((payload) => ({ result: messagesPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runGet, read((payload) => ({ result: runGet(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runEventsPage, read((payload) => ({ result: runEventsPage(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runOutputCounts, read((payload) => ({ result: runOutputCounts(database, payload) }))],
    [REPOSITORY_READ_OPERATIONS.runOutputsPage, read((payload) => ({ result: runOutputsPage(database, payload) }))],
    [
      REPOSITORY_READ_OPERATIONS.runInputDeliveriesPage,
      read((payload) => ({ result: runInputDeliveriesPage(database, payload) })),
    ],
    [
      REPOSITORY_READ_OPERATIONS.runOutputPayloadMetadata,
      read((payload) => ({ result: runOutputPayloadMetadata(database, payload) })),
    ],
    [REPOSITORY_READ_OPERATIONS.childResultsPage, read((payload) => ({ result: childResultsPage(database, payload) }))],
    [
      REPOSITORY_READ_OPERATIONS.sessionDeletionCleanupPage,
      read((payload) => ({ result: sessionDeletionCleanupPage(database, payload) })),
    ],
    [REPOSITORY_READ_OPERATIONS.recoveryGet, read((payload) => ({ result: recoveryGet(database, payload) }))],
  ]);
}

function sessionsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["workspaceKey", "lifecycleStatus", "cursor", "limit"]);
  const workspaceKey = requiredString(payload.workspaceKey, "workspaceKey");
  const lifecycleStatus = optionalEnum(payload.lifecycleStatus, ["active", "archived", "closed"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.sessions);
  const scope = scopeDigest({ workspaceKey, lifecycleStatus: lifecycleStatus ?? null });
  const cursor = decodeCursor(payload.cursor, "sessions", scope, 2);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor[0]) || typeof cursor[1] !== "string")) {
    throw invalidCursor();
  }
  const cursorTime = cursor?.[0] as number | undefined;
  const cursorId = cursor?.[1] as string | undefined;

  const rows = database
    .prepare(
      `
      WITH page_sessions AS MATERIALIZED (
        SELECT id, workspace_key, default_character_id, lifecycle_status,
               created_at, updated_at, last_activity_at
        FROM sessions
        WHERE workspace_key = ?
          AND (? IS NULL OR lifecycle_status = ?)
          AND (? IS NULL OR last_activity_at < ? OR (last_activity_at = ? AND id < ?))
        ORDER BY last_activity_at DESC, id DESC
        LIMIT ?
      )
      SELECT s.*,
        (SELECT id FROM runs WHERE session_id = s.id
          AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1) AS active_run_id,
        (SELECT created_at FROM runs WHERE session_id = s.id
          AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1) AS active_run_created_at,
        (SELECT id FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_id,
        (SELECT phase FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_phase,
        (SELECT terminal_at FROM runs
          WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_terminal_at
      FROM page_sessions s
      ORDER BY s.last_activity_at DESC, s.id DESC
    `,
    )
    .all(
      workspaceKey,
      lifecycleStatus ?? null,
      lifecycleStatus ?? null,
      cursorTime ?? null,
      cursorTime ?? null,
      cursorTime ?? null,
      cursorId ?? null,
      limit + 1,
    ) as unknown as readonly SessionPageRow[];
  const page = splitPage(rows, limit);
  const mappedPage = budgetPage(page, (row) => ({
    id: row.id,
    workspaceKey: row.workspace_key,
    defaultCharacterId: row.default_character_id,
    lifecycleStatus: row.lifecycle_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    executionState: row.active_run_id !== null ? "running" : (row.latest_run_phase ?? "not_started"),
    ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
    ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }),
    stateChangedAt:
      row.active_run_id === null
        ? (row.latest_run_terminal_at ?? row.created_at)
        : (row.active_run_created_at ?? row.created_at),
  }));
  return {
    items: mappedPage.items,
    ...(mappedPage.hasMore
      ? {
          nextCursor: encodeCursor("sessions", scope, [mappedPage.lastRow!.last_activity_at, mappedPage.lastRow!.id]),
        }
      : {}),
  };
}

function sessionGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["sessionId", "workspaceKey"]);
  const sessionId = requiredString(payload.sessionId, "sessionId");
  const workspaceKey = requiredString(payload.workspaceKey, "workspaceKey");
  const row = database
    .prepare(
      `
      SELECT s.id, s.provider_id, s.workspace_key, s.default_character_id, s.max_concurrent_child_runs,
        s.lifecycle_status, s.created_at, s.updated_at, s.last_activity_at,
        length(CAST(s.allowed_additional_directories_json AS BLOB)) AS directories_byte_length,
        CASE WHEN length(CAST(s.allowed_additional_directories_json AS BLOB)) <= ?
          THEN s.allowed_additional_directories_json END AS inline_directories,
        (SELECT id FROM runs WHERE session_id = s.id
          AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1) AS active_run_id,
        (SELECT id FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_id,
        (SELECT phase FROM runs WHERE session_id = s.id ORDER BY ordinal DESC LIMIT 1) AS latest_run_phase
      FROM sessions s WHERE s.id = ? AND s.workspace_key = ?
    `,
    )
    .get(INLINE_MESSAGE_BYTES, sessionId, workspaceKey) as SessionDetailRow | undefined;
  if (row === undefined) throw notFound();
  return {
    session: {
      id: row.id,
      providerId: row.provider_id,
      workspaceKey: row.workspace_key,
      allowedAdditionalDirectoriesByteLength: row.directories_byte_length,
      allowedAdditionalDirectoriesState: row.inline_directories === null ? "chunked" : "inline",
      ...(row.inline_directories === null
        ? {}
        : { allowedAdditionalDirectories: JSON.parse(row.inline_directories) as unknown }),
      defaultCharacterId: row.default_character_id,
      maxConcurrentChildRuns: row.max_concurrent_child_runs,
      lifecycleStatus: row.lifecycle_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActivityAt: row.last_activity_at,
    },
    execution: {
      state: row.active_run_id !== null ? "running" : (row.latest_run_phase ?? "not_started"),
      ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }),
      ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }),
    },
  };
}

function messagesPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readSessionScope(payload, ["sessionId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.messages);
  const cursorScope = scopeDigest(scope);
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "messages", cursorScope);
  const rows = database
    .prepare(REPOSITORY_PAGE_SQL.messages)
    .all(
      INLINE_MESSAGE_BYTES,
      scope.sessionId,
      scope.workspaceKey,
      afterOrdinal,
      limit + 1,
    ) as unknown as readonly MessageRow[];
  assertScopeExists(database, scope.sessionId, scope.workspaceKey);
  const page = splitPage(rows, limit);
  return ordinalPage(scope, page, "messages", cursorScope, (row) => ({
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    role: row.role,
    contentByteLength: row.content_byte_length,
    contentState: row.inline_content === null ? "chunked" : "inline",
    ...(row.inline_content === null ? {} : { contentBlocks: JSON.parse(row.inline_content) as unknown }),
    createdAt: row.created_at,
  }));
}

function runGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey"]);
  const row = database
    .prepare(
      `
      SELECT r.id, r.session_id, r.ordinal, r.initiating_message_id, r.final_assistant_message_id,
        r.retry_of_run_id, r.phase, r.failure_origin, r.provider_error_code, r.error_summary,
        r.cancel_requested_at, r.cancel_acknowledged_at, r.terminal_event_received_at,
        r.external_side_effect_state, r.created_at, r.started_at, r.terminal_at, r.updated_at, r.version,
        length(CAST(r.execution_snapshot_json AS BLOB)) AS execution_snapshot_byte_length,
        CASE WHEN length(CAST(r.execution_snapshot_json AS BLOB)) <= ?
          THEN r.execution_snapshot_json END AS inline_execution_snapshot,
        s.workspace_key FROM runs r JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
    `,
    )
    .get(INLINE_MESSAGE_BYTES, scope.runId, scope.sessionId, scope.workspaceKey) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound();
  const { inline_execution_snapshot: inlineSnapshot, workspace_key: _workspaceKey, ...metadata } = row;
  return {
    sessionId: scope.sessionId,
    workspaceKey: scope.workspaceKey,
    run: {
      ...snakeToCamel(metadata),
      executionSnapshotState: inlineSnapshot === null ? "chunked" : "inline",
      ...(typeof inlineSnapshot === "string" ? { executionSnapshot: JSON.parse(inlineSnapshot) as unknown } : {}),
    },
  };
}

function runEventsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.events);
  const cursorScope = runCursorScope(scope);
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "run_events", cursorScope);
  const rows = database
    .prepare(REPOSITORY_PAGE_SQL.runEvents)
    .all(scope.runId, scope.sessionId, scope.workspaceKey, afterOrdinal, limit + 1) as unknown as readonly OrdinalRow[];
  assertRunScopeExists(database, scope);
  const page = splitPage(rows, limit);
  return ordinalPage(scope, page, "run_events", cursorScope, (row) => ({
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    eventCode: row.event_code,
    ...(row.subject_type === null ? {} : { subjectType: row.subject_type }),
    ...(row.subject_id === null ? {} : { subjectId: row.subject_id }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    createdAt: row.created_at,
  }));
}

function runOutputCounts(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey"]);
  assertRunScopeExists(database, scope);
  const rows = database
    .prepare(
      `
      SELECT category, count(*) AS item_count,
             sum(CASE WHEN completion_state = 'partial' THEN 1 ELSE 0 END) AS partial_count
      FROM run_output_items WHERE run_id = ? GROUP BY category
    `,
    )
    .all(scope.runId) as unknown as readonly Readonly<{
    category: string;
    item_count: number;
    partial_count: number;
  }>[];
  return {
    ...scope,
    totalCount: rows.reduce((sum, row) => sum + row.item_count, 0),
    partialCount: rows.reduce((sum, row) => sum + row.partial_count, 0),
    byCategory: Object.fromEntries(rows.map((row) => [row.category, row.item_count])),
  };
}

function runInputDeliveriesPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey", "cursor", "limit"]);
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.runInputDeliveries);
  const cursorScope = runCursorScope(scope);
  const cursor = decodeCursor(payload.cursor, "run_input_deliveries", cursorScope, 2);
  if (
    cursor !== undefined &&
    (!Number.isSafeInteger(cursor[0]) || (cursor[0] as number) < 0 || typeof cursor[1] !== "string")
  ) {
    throw invalidCursor();
  }
  const afterCreatedAt = cursor?.[0] as number | undefined;
  const afterMessageId = cursor?.[1] as string | undefined;
  const rows = database
    .prepare(
      `
      SELECT i.message_id, i.run_id, i.run_attempt_id AS attempt_id,
             a.provider_binding_id AS binding_id, i.delivery_state,
             i.created_at, i.dispatching_at
      FROM run_input_deliveries i
      JOIN run_attempts a ON a.id = i.run_attempt_id AND a.run_id = i.run_id
      JOIN runs r ON r.id = i.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE i.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
        AND i.delivery_state IN ('pending', 'dispatching')
        AND (? IS NULL OR i.created_at > ? OR (i.created_at = ? AND i.message_id > ?))
      ORDER BY i.created_at ASC, i.message_id ASC
      LIMIT ?
    `,
    )
    .all(
      scope.runId,
      scope.sessionId,
      scope.workspaceKey,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterCreatedAt ?? null,
      afterMessageId ?? null,
      limit + 1,
    ) as unknown as readonly RunInputDeliveryRow[];
  assertRunScopeExists(database, scope);
  const page = splitPage(rows, limit);
  const budgeted = budgetPage(page, (row) => ({
    messageId: row.message_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    bindingId: row.binding_id,
    deliveryState: row.delivery_state,
    createdAt: row.created_at,
    dispatchingAt: row.dispatching_at,
  }));
  return {
    ...scope,
    items: budgeted.items,
    ...(budgeted.hasMore && budgeted.lastRow !== undefined
      ? {
          nextCursor: encodeCursor("run_input_deliveries", cursorScope, [
            budgeted.lastRow.created_at,
            budgeted.lastRow.message_id,
          ]),
        }
      : {}),
  };
}

function runOutputsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey", "category", "cursor", "limit"]);
  const category = optionalString(payload.category, "category");
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.outputs);
  const cursorScope = scopeDigest({ ...scope, category: category ?? null });
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "run_outputs", cursorScope);
  const rows = (category === undefined
    ? database
        .prepare(REPOSITORY_PAGE_SQL.runOutputs)
        .all(scope.runId, scope.sessionId, scope.workspaceKey, afterOrdinal, limit + 1)
    : database
        .prepare(REPOSITORY_PAGE_SQL.runOutputsByCategory)
        .all(
          scope.runId,
          scope.sessionId,
          scope.workspaceKey,
          category,
          afterOrdinal,
          limit + 1,
        )) as unknown as readonly OrdinalRow[];
  assertRunScopeExists(database, scope);
  const page = splitPage(rows, limit);
  return ordinalPage(scope, page, "run_outputs", cursorScope, (row) => ({
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    category: row.category,
    kind: row.kind,
    summary: row.summary,
    completionState: row.completion_state,
    payloadState: row.payload_state,
    ...(row.payload_original_byte_length === null
      ? {}
      : { payloadOriginalByteLength: row.payload_original_byte_length }),
    ...(row.stored_payload_id === null ? {} : { storedPayloadId: row.stored_payload_id }),
    redactionState: row.redaction_state,
    createdAt: row.created_at,
  }));
}

function runOutputPayloadMetadata(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "outputItemId", "workspaceKey"]);
  const outputItemId = requiredString(payload.outputItemId, "outputItemId");
  const row = database
    .prepare(
      `
      SELECT o.id AS output_item_id, p.payload_format, p.media_type, p.byte_length,
             p.content_sha256, p.created_at, s.workspace_key
      FROM run_output_items o
      JOIN runs r ON r.id = o.run_id
      JOIN sessions s ON s.id = r.session_id
      JOIN run_output_payloads p ON p.output_item_id = o.id
      WHERE o.id = ? AND o.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
    `,
    )
    .get(outputItemId, scope.runId, scope.sessionId, scope.workspaceKey) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound();
  return { ...scope, ...snakeToCamel(row) };
}

function childResultsPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["parentSessionId", "workspaceKey", "delegationId", "cursor", "limit"]);
  const parentSessionId = requiredString(payload.parentSessionId, "parentSessionId");
  const workspaceKey = requiredString(payload.workspaceKey, "workspaceKey");
  const delegationId = requiredString(payload.delegationId, "delegationId");
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.childResults);
  const cursorScope = scopeDigest({ workspaceKey, parentSessionId, delegationId });
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "child_results", cursorScope);
  const rows = database
    .prepare(
      `
      SELECT d.id, d.delegation_id, d.ordinal, d.child_run_id, d.availability_state,
             d.terminal_phase_snapshot, d.result_summary, d.available_at,
             d.first_collected_by_parent_run_id, d.first_collected_at, d.created_at, d.updated_at,
             rel.parent_session_id, rel.child_session_id, rel.orchestration_root_session_id,
             s.workspace_key
      FROM child_result_deliveries d
      JOIN delegations g ON g.id = d.delegation_id
      JOIN session_relations rel ON rel.id = g.session_relation_id
      JOIN sessions s ON s.id = rel.parent_session_id
      JOIN sessions child ON child.id = rel.child_session_id AND child.workspace_key = s.workspace_key
      JOIN sessions root ON root.id = rel.orchestration_root_session_id AND root.workspace_key = s.workspace_key
      JOIN runs child_run ON child_run.id = d.child_run_id AND child_run.session_id = rel.child_session_id
      WHERE d.delegation_id = ? AND rel.parent_session_id = ? AND s.workspace_key = ? AND d.ordinal > ?
      ORDER BY d.ordinal ASC LIMIT ?
    `,
    )
    .all(delegationId, parentSessionId, workspaceKey, afterOrdinal, limit + 1) as unknown as readonly OrdinalRow[];
  if (rows.length === 0) {
    const exists = database
      .prepare(
        `
      SELECT 1 FROM delegations g JOIN session_relations rel ON rel.id = g.session_relation_id
      JOIN sessions s ON s.id = rel.parent_session_id
      JOIN sessions child ON child.id = rel.child_session_id AND child.workspace_key = s.workspace_key
      JOIN sessions root ON root.id = rel.orchestration_root_session_id AND root.workspace_key = s.workspace_key
      WHERE g.id = ? AND rel.parent_session_id = ? AND s.workspace_key = ?
    `,
      )
      .get(delegationId, parentSessionId, workspaceKey);
    if (exists === undefined) throw notFound();
  }
  const page = splitPage(rows, limit);
  return ordinalPage({ parentSessionId, workspaceKey, delegationId }, page, "child_results", cursorScope, (row) => ({
    id: row.id,
    delegationId: row.delegation_id,
    ordinal: row.ordinal,
    childRunId: row.child_run_id,
    availabilityState: row.availability_state,
    ...(row.terminal_phase_snapshot === null ? {} : { terminalPhaseSnapshot: row.terminal_phase_snapshot }),
    ...(row.result_summary === null ? {} : { resultSummary: row.result_summary }),
    ...(row.available_at === null ? {} : { availableAt: row.available_at }),
    ...(row.first_collected_by_parent_run_id === null
      ? {}
      : { firstCollectedByParentRunId: row.first_collected_by_parent_run_id }),
    ...(row.first_collected_at === null ? {} : { firstCollectedAt: row.first_collected_at }),
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    orchestrationRootSessionId: row.orchestration_root_session_id,
    workspaceKey: row.workspace_key,
  }));
}

function sessionDeletionCleanupPage(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  assertExactKeys(payload, ["cleanupToken", "workspaceKey", "cursor", "limit"]);
  const cleanupToken = requiredString(payload.cleanupToken, "cleanupToken");
  if (!isCanonicalUuid(cleanupToken)) throw invalidRequest("cleanupToken");
  const workspaceKey = requiredString(payload.workspaceKey, "workspaceKey");
  const limit = readLimit(payload.limit, REPOSITORY_READ_LIMITS.sessionDeletionItems);
  const cursorScope = scopeDigest({ cleanupToken, workspaceKey });
  const afterOrdinal = decodeOrdinalCursor(payload.cursor, "session_deletion_items", cursorScope);
  const manifest = database
    .prepare(
      `
      SELECT deleted_session_count FROM session_deletion_manifests
      WHERE deletion_id = ? AND workspace_key = ?
    `,
    )
    .get(cleanupToken, workspaceKey) as { deleted_session_count: number } | undefined;
  if (manifest === undefined) throw notFound();
  const rows = database
    .prepare(
      `
      SELECT ordinal, session_id FROM session_deletion_items
      WHERE deletion_id = ? AND ordinal > ?
      ORDER BY ordinal ASC LIMIT ?
    `,
    )
    .all(cleanupToken, afterOrdinal, limit + 1) as unknown as ReadonlyArray<OrdinalRow & { session_id: string }>;
  const page = splitPage(rows, limit);
  return ordinalPage(
    {
      cleanupToken,
      deletedSessionCount: manifest.deleted_session_count,
      localOnly: true,
    },
    page,
    "session_deletion_items",
    cursorScope,
    (row) => ({ ordinal: row.ordinal, sessionId: row.session_id }),
  );
}

function recoveryGet(database: DatabaseSync, payload: Readonly<Record<string, unknown>>): unknown {
  const scope = readRunScope(payload, ["sessionId", "runId", "workspaceKey"]);
  const row = database
    .prepare(
      `
    SELECT r.id AS run_id, r.session_id, r.phase AS run_phase, r.updated_at AS run_updated_at,
           a.id AS attempt_id, a.ordinal AS attempt_ordinal, a.attempt_state,
           a.external_execution_id, b.id AS binding_id, b.provider_id, b.persistence_mode,
           b.binding_state, b.external_conversation_id, d.dispatch_state,
           d.provider_idempotency_key, s.workspace_key
    FROM runs r JOIN sessions s ON s.id = r.session_id
    LEFT JOIN run_attempts a ON a.id = (
      SELECT id FROM run_attempts WHERE run_id = r.id ORDER BY ordinal DESC LIMIT 1)
    LEFT JOIN provider_bindings b ON b.id = COALESCE(
      a.provider_binding_id,
      (
        SELECT pb.id FROM provider_bindings pb
        WHERE pb.created_by_run_attempt_id = a.id
        ORDER BY CASE pb.binding_state
          WHEN 'creating' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
          pb.ordinal DESC
        LIMIT 1
      )
    )
    LEFT JOIN run_dispatches d ON d.run_attempt_id = a.id
    WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
  `,
    )
    .get(scope.runId, scope.sessionId, scope.workspaceKey) as Record<string, unknown> | undefined;
  if (row === undefined) throw notFound();
  return snakeToCamelWithNulls(row);
}

function readSessionScope(payload: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  assertExactKeys(payload, keys);
  return {
    sessionId: requiredString(payload.sessionId, "sessionId"),
    workspaceKey: requiredString(payload.workspaceKey, "workspaceKey"),
  };
}

function readRunScope(payload: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  const scope = readSessionScope(payload, keys);
  return { ...scope, runId: requiredString(payload.runId, "runId") };
}

function assertScopeExists(database: DatabaseSync, sessionId: string, workspaceKey: string): void {
  if (
    database.prepare("SELECT 1 FROM sessions WHERE id = ? AND workspace_key = ?").get(sessionId, workspaceKey) ===
    undefined
  ) {
    throw notFound();
  }
}

function assertRunScopeExists(
  database: DatabaseSync,
  scope: Readonly<{ sessionId: string; runId: string; workspaceKey: string }>,
): void {
  if (
    database
      .prepare(
        `
    SELECT 1 FROM runs r JOIN sessions s ON s.id = r.session_id
    WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
  `,
      )
      .get(scope.runId, scope.sessionId, scope.workspaceKey) === undefined
  )
    throw notFound();
}

function ordinalPage<T extends OrdinalRow, R>(
  scope: object,
  page: Readonly<{ items: readonly T[]; hasMore: boolean }>,
  kind: string,
  cursorScope: string,
  map: (row: T) => R,
): unknown {
  const budgeted = budgetPage(page, map);
  return {
    ...scope,
    items: budgeted.items,
    ...(budgeted.hasMore && budgeted.lastRow !== undefined
      ? { nextCursor: encodeCursor(kind, cursorScope, [budgeted.lastRow.ordinal]) }
      : {}),
  };
}

function budgetPage<T extends Readonly<Record<string, unknown>>, R>(
  page: Readonly<{ items: readonly T[]; hasMore: boolean }>,
  map: (row: T) => R,
): Readonly<{
  items: readonly (R | Readonly<{ omitted: true; reason: "response_size_limit"; ordinal?: number }>)[];
  hasMore: boolean;
  lastRow?: T;
}> {
  const items: (R | Readonly<{ omitted: true; reason: "response_size_limit"; ordinal?: number }>)[] = [];
  let bytes = 0;
  let consumed = 0;
  for (const row of page.items) {
    const item = map(row);
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    if (itemBytes > MAX_PAGE_JSON_BYTES) {
      const ordinal = typeof row.ordinal === "number" ? row.ordinal : undefined;
      items.push({ omitted: true, reason: "response_size_limit", ...(ordinal === undefined ? {} : { ordinal }) });
      consumed += 1;
      continue;
    }
    if (bytes + itemBytes > MAX_PAGE_JSON_BYTES) break;
    items.push(item);
    bytes += itemBytes;
    consumed += 1;
  }
  return {
    items,
    hasMore: page.hasMore || consumed < page.items.length,
    ...(consumed === 0 ? {} : { lastRow: page.items[consumed - 1] }),
  };
}

function splitPage<T>(rows: readonly T[], limit: number): Readonly<{ items: readonly T[]; hasMore: boolean }> {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

function encodeCursor(kind: string, scope: string, key: readonly (string | number)[]): string {
  return `v1.${Buffer.from(JSON.stringify({ v: 1, q: kind, s: scope, k: key })).toString("base64url")}`;
}

function decodeCursor(value: unknown, kind: string, scope: string, keyLength: number): readonly unknown[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2_048 || !value.startsWith("v1.")) throw invalidCursor();
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(3), "base64url").toString("utf8")) as unknown;
    if (!isPlainObject(decoded) || Object.keys(decoded).sort().join(",") !== "k,q,s,v") throw invalidCursor();
    if (
      decoded.v !== 1 ||
      decoded.q !== kind ||
      decoded.s !== scope ||
      !Array.isArray(decoded.k) ||
      decoded.k.length !== keyLength
    ) {
      throw invalidCursor();
    }
    if (encodeCursor(kind, scope, decoded.k as readonly (string | number)[]) !== value) throw invalidCursor();
    if (!decoded.k.every((item) => typeof item === "string" || Number.isSafeInteger(item))) throw invalidCursor();
    return decoded.k;
  } catch (error) {
    if (error instanceof RepositoryReadError) throw error;
    throw invalidCursor();
  }
}

function decodeOrdinalCursor(value: unknown, kind: string, scope: string): number {
  const cursor = decodeCursor(value, kind, scope, 1);
  if (cursor === undefined) return 0;
  if (!Number.isSafeInteger(cursor[0]) || (cursor[0] as number) < 0) throw invalidCursor();
  return cursor[0] as number;
}

function readLimit(value: unknown, limits: Readonly<{ default: number; max: number }>): number {
  if (value === undefined) return limits.default;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > limits.max) {
    throw invalidRequest("limit");
  }
  return value as number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw invalidRequest(field);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw invalidRequest("enum");
  return value as T;
}

function assertExactKeys(payload: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw invalidRequest("payload");
}

function snakeToCamel(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()), value]),
  );
}

function snakeToCamelWithNulls(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function runCursorScope(scope: Readonly<{ workspaceKey: string; sessionId: string; runId: string }>): string {
  return scopeDigest(scope);
}

function scopeDigest(scope: Readonly<Record<string, unknown>>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function invalidRequest(field: string): RepositoryReadError {
  return new RepositoryReadError("request_invalid", `Repository read request field is invalid: ${field}.`);
}

function invalidCursor(): RepositoryReadError {
  return new RepositoryReadError("cursor_invalid", "Repository read cursor is invalid.");
}

function notFound(): RepositoryReadError {
  return new RepositoryReadError("not_found", "Repository resource was not found.");
}

type OrdinalRow = Readonly<Record<string, unknown> & { ordinal: number }>;
type RunInputDeliveryRow = Readonly<Record<string, unknown>> &
  Readonly<{
    message_id: string;
    run_id: string;
    attempt_id: string;
    binding_id: string | null;
    delivery_state: "pending" | "dispatching";
    created_at: number;
    dispatching_at: number | null;
  }>;
type MessageRow = Readonly<{
  id: string;
  session_id: string;
  ordinal: number;
  role: string;
  content_byte_length: number;
  inline_content: string | null;
  created_at: number;
  workspace_key: string;
}>;
type SessionPageRow = Readonly<{
  id: string;
  workspace_key: string;
  default_character_id: string;
  lifecycle_status: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  active_run_id: string | null;
  active_run_created_at: number | null;
  latest_run_id: string | null;
  latest_run_phase: string | null;
  latest_run_terminal_at: number | null;
}>;
type SessionDetailRow = Omit<SessionPageRow, "active_run_created_at" | "latest_run_terminal_at"> &
  Readonly<{
    provider_id: string;
    directories_byte_length: number;
    inline_directories: string | null;
    max_concurrent_child_runs: number;
  }>;
