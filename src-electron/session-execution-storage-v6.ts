import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MutationAuthorityProof } from "../src/session-authority.js";
import { SESSION_AUTHORITY_MAPPING_REVISION } from "../src/session-authority.js";

import {
  SESSION_EXECUTION_QUEUE_LIMIT,
  type SessionExecutionMutationOperation,
  type SessionExecutionOriginSnapshot,
  type SessionInboundExecutionRecord,
  type SessionExecutionOperation,
  type SessionOutboundExecutionRecord,
  type SessionExecutionState,
  type SessionExecutionStorageRecord,
} from "../src/session-execution.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";
import { appendSessionExecutionEvent, claimSessionContainerRevision, getSessionResourceRevision } from "./resource-history-schema.js";
import { assertGrantProofCurrent } from "./session-authority-storage.js";
import { ResourceBudgetStorage } from "./resource-budget-storage.js";

type SessionExecutionRow = {
  sequence: number;
  id: string;
  session_id: string;
  operation: SessionExecutionOperation;
  state: SessionExecutionState;
  request_json: string;
  result_json: string | null;
  error_code: string;
  reason: string;
  created_at: string;
  admitted_at: string | null;
  completed_at: string | null;
  updated_at: string;
  revision: number;
  authority_proof_json: string | null;
};

type SessionExecutionIdempotencyRow = {
  request_fingerprint: string;
  execution_id: string;
};

export type EnqueueSessionExecutionInput = {
  id: string;
  expectedContainerRevision: number;
  sessionId: string;
  request: unknown;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
  expiresAt: string;
  origin?: SessionExecutionOriginSnapshot;
  workItemId?: string;
  proof: MutationAuthorityProof;
  terminalFailureNotificationProof?: MutationAuthorityProof;
};

export type EnqueueSessionExecutionResult = {
  execution: SessionExecutionStorageRecord;
  replayed: boolean;
};

export type StartSessionExecutionInput = EnqueueSessionExecutionInput;

export type CompleteSessionExecutionInput = {
  executionId: string;
  state: Extract<SessionExecutionState, "completed" | "failed" | "canceled">;
  result: unknown | null;
  errorCode: string;
  reason: string;
  completedAt: string;
  expiresAt: string;
  uncertain?: boolean;
};

export class SessionExecutionQueueFullError extends Error {
  readonly code = "QUEUE_FULL";

  constructor(readonly sessionId: string) {
    super(`Session execution queue is full: ${sessionId}`);
    this.name = "SessionExecutionQueueFullError";
  }
}

export class SessionExecutionIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly operation: SessionExecutionMutationOperation, readonly idempotencyKey: string) {
    super(`Session execution idempotency key was reused with a different request: ${operation}`);
    this.name = "SessionExecutionIdempotencyConflictError";
  }
}

export class SessionExecutionWorkItemAssociationError extends Error {
  readonly code = "WORK_ITEM_EXECUTION_FORBIDDEN";

  constructor(readonly workItemId: string, readonly targetSessionId: string) {
    super(`Work Item is not an active target for the Session execution: ${workItemId} (${targetSessionId})`);
    this.name = "SessionExecutionWorkItemAssociationError";
  }
}

export class SessionExecutionBusyError extends Error {
  readonly code = "SESSION_BUSY";

  constructor(readonly sessionId: string) {
    super(`Session already has a running execution: ${sessionId}`);
    this.name = "SessionExecutionBusyError";
  }
}

export class SessionExecutionStateConflictError extends Error {
  readonly code = "EXECUTION_STATE_CONFLICT";

  constructor(readonly executionId: string, readonly state: SessionExecutionState) {
    super(`Session execution state does not allow this transition: ${executionId} (${state})`);
    this.name = "SessionExecutionStateConflictError";
  }
}

export class SessionExecutionStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  enqueue(input: EnqueueSessionExecutionInput): EnqueueSessionExecutionResult {
    const requestJson = JSON.stringify(input.request);
    if (requestJson === undefined) {
      throw new TypeError("Session execution request must be JSON serializable.");
    }
    return this.transaction(() => {
      const replay = this.findIdempotency("turn.enqueue", input.proof, input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== input.requestFingerprint) {
          throw new SessionExecutionIdempotencyConflictError("turn.enqueue", input.idempotencyKey);
        }
        const execution = this.getRequired(replay.execution_id);
        return { execution, replayed: true };
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
      this.assertTerminalFailureNotificationAuthority(input);

      const queuedCount = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM session_executions_v6
        WHERE session_id = ? AND state = 'queued'
      `).get(input.sessionId) as { count: number };
      if (queuedCount.count >= SESSION_EXECUTION_QUEUE_LIMIT) {
        throw new SessionExecutionQueueFullError(input.sessionId);
      }

      new ResourceBudgetStorage(this.db).reserveQueuedTurn({
        sessionId: input.sessionId,
        executionId: input.id,
        idempotencyKey: `turn.enqueue:${mutationPrincipalIdentity(input.proof).kind}:${mutationPrincipalIdentity(input.proof).id}:${input.idempotencyKey}`,
        createdAt: input.createdAt,
      });

      this.db.prepare(`
        INSERT INTO session_executions_v6 (
          id,
          session_id,
          operation,
          state,
          request_json,
          authority_proof_json,
          created_at,
          updated_at
        ) VALUES (?, ?, 'turn.enqueue', 'queued', ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        requestJson,
        JSON.stringify(input.proof),
        input.createdAt,
        input.createdAt,
      );
      this.insertOriginSnapshot(input.id, input.sessionId, input.origin, input.createdAt);
      this.insertWorkItemAssociation(input.id, input.workItemId, input.sessionId, input.createdAt);
      const principal = mutationPrincipalIdentity(input.proof);
      this.db.prepare(`
        INSERT INTO session_execution_idempotency_v6 (
          operation,
          principal_kind,
          principal_id,
          idempotency_key,
          request_fingerprint,
          execution_id,
          created_at,
          expires_at
        ) VALUES ('turn.enqueue', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        principal.kind,
        principal.id,
        input.idempotencyKey,
        input.requestFingerprint,
        input.id,
        input.createdAt,
        input.expiresAt,
      );

      appendSessionExecutionEvent(this.db, {
        executionId: input.id,
        revision: 1,
        eventKind: "queued",
        proof: input.proof,
        operationId: executionOperationId("turn.enqueue", input.proof, input.idempotencyKey, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: executionHistoryPayload(this.getRequired(input.id)),
      });
      claimSessionContainerRevision(this.db, {
        sessionId: input.sessionId,
        expectedRevision: input.expectedContainerRevision,
        eventKind: "execution_created",
        proof: input.proof,
        operationId: executionOperationId("turn.enqueue", input.proof, input.idempotencyKey, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: { executionId: input.id, executionOperation: "turn.enqueue" },
      });

      return { execution: this.getRequired(input.id), replayed: false };
    });
  }

  startImmediate(input: StartSessionExecutionInput): EnqueueSessionExecutionResult {
    const requestJson = serializeJson(input.request, "Session execution request");
    return this.transaction(() => {
      const replay = this.findIdempotency("turn.run", input.proof, input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== input.requestFingerprint) {
          throw new SessionExecutionIdempotencyConflictError("turn.run", input.idempotencyKey);
        }
        return { execution: this.getRequired(replay.execution_id), replayed: true };
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
      this.assertTerminalFailureNotificationAuthority(input);

      const occupied = this.db.prepare(`
        SELECT id
        FROM session_executions_v6
        WHERE session_id = ? AND state IN ('queued', 'running')
        ORDER BY sequence ASC
        LIMIT 1
      `).get(input.sessionId) as { id: string } | undefined;
      if (occupied) {
        throw new SessionExecutionBusyError(input.sessionId);
      }

      new ResourceBudgetStorage(this.db).reserveImmediateTurn({
        sessionId: input.sessionId,
        executionId: input.id,
        idempotencyKey: `turn.run:${mutationPrincipalIdentity(input.proof).kind}:${mutationPrincipalIdentity(input.proof).id}:${input.idempotencyKey}`,
        createdAt: input.createdAt,
      });

      this.db.prepare(`
        INSERT INTO session_executions_v6 (
          id,
          session_id,
          operation,
          state,
          request_json,
          authority_proof_json,
          created_at,
          admitted_at,
          updated_at
        ) VALUES (?, ?, 'turn.run', 'running', ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        requestJson,
        JSON.stringify(input.proof),
        input.createdAt,
        input.createdAt,
        input.createdAt,
      );
      this.insertOriginSnapshot(input.id, input.sessionId, input.origin, input.createdAt);
      this.insertWorkItemAssociation(input.id, input.workItemId, input.sessionId, input.createdAt);
      const principal = mutationPrincipalIdentity(input.proof);
      this.db.prepare(`
        INSERT INTO session_execution_idempotency_v6 (
          operation,
          principal_kind,
          principal_id,
          idempotency_key,
          request_fingerprint,
          execution_id,
          created_at,
          expires_at
        ) VALUES ('turn.run', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        principal.kind,
        principal.id,
        input.idempotencyKey,
        input.requestFingerprint,
        input.id,
        input.createdAt,
        input.expiresAt,
      );
      appendSessionExecutionEvent(this.db, {
        executionId: input.id,
        revision: 1,
        eventKind: "started",
        proof: input.proof,
        operationId: executionOperationId("turn.run", input.proof, input.idempotencyKey, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: executionHistoryPayload(this.getRequired(input.id)),
      });
      claimSessionContainerRevision(this.db, {
        sessionId: input.sessionId,
        expectedRevision: input.expectedContainerRevision,
        eventKind: "execution_created",
        proof: input.proof,
        operationId: executionOperationId("turn.run", input.proof, input.idempotencyKey, input.requestFingerprint),
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.createdAt,
        payload: { executionId: input.id, executionOperation: "turn.run" },
      });
      return { execution: this.getRequired(input.id), replayed: false };
    });
  }

  get(executionId: string): SessionExecutionStorageRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM session_executions_v6
      WHERE id = ?
    `).get(executionId) as SessionExecutionRow | undefined;
    return row ? parseExecution(row) : null;
  }

  resolveIdempotency(
    operation: SessionExecutionMutationOperation,
    proof: MutationAuthorityProof,
    idempotencyKey: string,
    requestFingerprint: string,
  ): SessionExecutionStorageRecord | null {
    const replay = this.findIdempotency(operation, proof, idempotencyKey);
    if (!replay) {
      return null;
    }
    if (replay.request_fingerprint !== requestFingerprint) {
      throw new SessionExecutionIdempotencyConflictError(operation, idempotencyKey);
    }
    return this.getRequired(replay.execution_id);
  }

  listSessionExecutions(sessionId: string): SessionExecutionStorageRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM session_executions_v6
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId) as SessionExecutionRow[];
    return rows.map(parseExecution);
  }

  listSessionExecutionsPage(
    sessionId: string,
    afterSequence: number | null,
    limit: number,
  ): SessionExecutionStorageRecord[] {
    return Array.from(this.iterateSessionExecutionsPage(sessionId, afterSequence, limit));
  }

  *iterateSessionExecutionsPage(
    sessionId: string,
    afterSequence: number | null,
    limit: number,
  ): IterableIterator<SessionExecutionStorageRecord> {
    const rows = afterSequence === null
      ? this.db.prepare(`
          SELECT *
          FROM session_executions_v6
          WHERE session_id = ?
          ORDER BY sequence ASC
          LIMIT ?
        `).iterate(sessionId, limit) as IterableIterator<SessionExecutionRow>
      : this.db.prepare(`
          SELECT *
          FROM session_executions_v6
          WHERE session_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `).iterate(sessionId, afterSequence, limit) as IterableIterator<SessionExecutionRow>;
    for (const row of rows) {
      yield parseExecution(row);
    }
  }

  listQueuedSessionIds(): string[] {
    const rows = this.db.prepare(`
      SELECT session_id
      FROM session_executions_v6
      WHERE state = 'queued'
      GROUP BY session_id
      ORDER BY MIN(sequence) ASC
    `).all() as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  listQueuedSessionIdsForRoot(rootSessionId: string): string[] {
    const rows = this.db.prepare(`
      SELECT execution.session_id
      FROM session_executions_v6 AS execution
      INNER JOIN session_role_bindings_v6 AS binding ON binding.session_id = execution.session_id
      WHERE execution.state = 'queued' AND binding.root_session_id = ?
      GROUP BY execution.session_id
      ORDER BY MIN(execution.sequence) ASC
    `).all(rootSessionId) as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  }

  getRootSessionId(sessionId: string): string {
    const row = this.db.prepare(`
      SELECT root_session_id
      FROM session_role_bindings_v6
      WHERE session_id = ?
    `).get(sessionId) as { root_session_id: string } | undefined;
    if (!row) throw new Error(`Session role binding was not found: ${sessionId}`);
    return row.root_session_id;
  }

  listTerminalFailureNotificationCandidates(limit: number): SessionExecutionStorageRecord[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Terminal failure notification candidate limit must be a positive integer.");
    }
    const rows = this.db.prepare(`
      SELECT execution.*
      FROM session_executions_v6 AS execution
      WHERE execution.state IN ('failed', 'interrupted')
        AND json_type(
          execution.request_json,
          '$.terminalFailureNotification.targetSessionId'
        ) = 'text'
        AND length(trim(json_extract(
          execution.request_json,
          '$.terminalFailureNotification.targetSessionId'
        ))) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM session_terminal_failure_notification_deliveries_v6 AS delivery
          WHERE delivery.source_execution_id = execution.id
        )
      ORDER BY execution.sequence ASC
      LIMIT ?
    `).all(limit) as SessionExecutionRow[];
    return rows.map(parseExecution);
  }

  listSessionExecutionProjectionRecords(sessionId: string): SessionExecutionStorageRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM session_executions_v6
      WHERE session_id = ?
        AND (
          state IN ('queued', 'running')
          OR sequence = (
            SELECT MAX(sequence)
            FROM session_executions_v6
            WHERE session_id = ?
              AND state IN ('completed', 'failed', 'canceled', 'interrupted')
          )
        )
      ORDER BY sequence ASC
    `).all(sessionId, sessionId) as SessionExecutionRow[];
    return rows.map(parseExecution);
  }

  listSessionOutboundExecutions(sourceSessionId: string): SessionOutboundExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT execution_sequence, execution_id, target_session_id, operation,
             target_session_title_snapshot, target_session_role_snapshot,
             source_message_seq_anchor, user_message, accepted_at
      FROM session_execution_origins_v6
      WHERE source_session_id = ?
      ORDER BY execution_sequence ASC
    `).all(sourceSessionId) as Array<{
      execution_sequence: number;
      execution_id: string;
      target_session_id: string;
      operation: SessionExecutionOperation;
      target_session_title_snapshot: string;
      target_session_role_snapshot: SessionOutboundExecutionRecord["targetSessionRole"];
      source_message_seq_anchor: number;
      user_message: string;
      accepted_at: string;
    }>;
    return rows.map((row) => ({
      sequence: row.execution_sequence,
      executionId: row.execution_id,
      targetSessionId: row.target_session_id,
      sourceMessageSequence: row.source_message_seq_anchor,
      operation: row.operation,
      targetSessionTitle: row.target_session_title_snapshot,
      targetSessionRole: row.target_session_role_snapshot,
      userMessage: row.user_message,
      createdAt: row.accepted_at,
    }));
  }

  listSessionInboundExecutions(targetSessionId: string): SessionInboundExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT execution.*, turn.user_message_seq AS target_message_sequence
      FROM session_turn_public_context_v6 AS context
      INNER JOIN session_executions_v6 AS execution
        ON execution.id = context.execution_id
        AND execution.session_id = context.session_id
      INNER JOIN session_turns_v6 AS turn
        ON turn.id = context.turn_id
        AND turn.session_id = context.session_id
      WHERE context.session_id = ?
        AND execution.state IN ('completed', 'failed', 'canceled', 'interrupted')
        AND turn.user_message_seq IS NOT NULL
        AND json_extract(execution.request_json, '$.initiator.kind') = 'session'
      ORDER BY turn.user_message_seq ASC, execution.sequence ASC
    `).all(targetSessionId) as Array<SessionExecutionRow & { target_message_sequence: number }>;
    return rows.map((row) => ({
      execution: parseExecution(row),
      targetMessageSequence: row.target_message_sequence,
    }));
  }

  getExecutionOriginSourceSessionId(executionId: string): string | null {
    const row = this.db.prepare(`
      SELECT source_session_id
      FROM session_execution_origins_v6
      WHERE execution_id = ?
    `).get(executionId) as { source_session_id: string } | undefined;
    return row?.source_session_id ?? null;
  }

  getExecutionWorkItemId(executionId: string): string | null {
    const row = this.db.prepare(`
      SELECT work_item_id
      FROM work_item_execution_associations_v6
      WHERE execution_id = ?
    `).get(executionId) as { work_item_id: string } | undefined;
    return row?.work_item_id ?? null;
  }

  admitNextQueued(sessionId: string, admittedAt: string): SessionExecutionStorageRecord | null {
    return this.transaction(() => {
      const running = this.db.prepare(`
        SELECT id
        FROM session_executions_v6
        WHERE session_id = ? AND state = 'running'
        LIMIT 1
      `).get(sessionId) as { id: string } | undefined;
      if (running) {
        return null;
      }

      const next = this.db.prepare(`
        SELECT id
        FROM session_executions_v6
        WHERE session_id = ? AND state = 'queued'
        ORDER BY sequence ASC
        LIMIT 1
      `).get(sessionId) as { id: string } | undefined;
      if (!next) {
        return null;
      }

      new ResourceBudgetStorage(this.db).startQueuedTurn({
        sessionId,
        executionId: next.id,
        startedAt: admittedAt,
      });

      const updated = this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'running', admitted_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND state = 'queued'
      `).run(admittedAt, admittedAt, next.id);
      if (updated.changes !== 1) {
        return null;
      }
      this.appendStoredExecutionEvent(next.id, "admitted", admittedAt);
      return this.getRequired(next.id);
    });
  }

  failNextQueued(
    sessionId: string,
    failedAt: string,
    expiresAt: string,
  ): SessionExecutionStorageRecord | null {
    return this.transaction(() => {
      const next = this.db.prepare(`
        SELECT id
        FROM session_executions_v6
        WHERE session_id = ? AND state = 'queued'
        ORDER BY sequence ASC
        LIMIT 1
      `).get(sessionId) as { id: string } | undefined;
      if (!next) {
        return null;
      }
      const updated = this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'failed',
            error_code = 'QUEUE_ADMISSION_FAILURE',
            reason = 'queue_admission_exhausted',
            completed_at = ?,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND state = 'queued'
      `).run(failedAt, failedAt, next.id);
      if (updated.changes !== 1) {
        return null;
      }
      this.updateIdempotencyExpiry(next.id, expiresAt);
      this.appendStoredExecutionEvent(next.id, "failed", failedAt);
      new ResourceBudgetStorage(this.db).settleTurn({
        sessionId,
        executionId: next.id,
        outcome: "failed",
        settledAt: failedAt,
      });
      return this.getRequired(next.id);
    });
  }

  completeRunning(input: CompleteSessionExecutionInput): SessionExecutionStorageRecord {
    const resultJson = input.result === null
      ? null
      : serializeJson(input.result, "Session execution result");
    return this.transaction(() => {
      const execution = this.getRequired(input.executionId);
      if (execution.state !== "running") {
        throw new SessionExecutionStateConflictError(execution.id, execution.state);
      }
      this.db.prepare(`
        UPDATE session_executions_v6
        SET state = ?,
            result_json = ?,
            error_code = ?,
            reason = ?,
            completed_at = ?,
            updated_at = ?,
            revision = revision + 1
        WHERE id = ? AND state = 'running'
      `).run(
        input.state,
        resultJson,
        input.errorCode,
        input.reason,
        input.completedAt,
        input.completedAt,
        input.executionId,
      );
      this.updateIdempotencyExpiry(input.executionId, input.expiresAt);
      this.appendStoredExecutionEvent(input.executionId, input.state, input.completedAt);
      new ResourceBudgetStorage(this.db).settleTurn({
        sessionId: execution.sessionId,
        executionId: input.executionId,
        outcome: input.state,
        settledAt: input.completedAt,
        uncertain: input.uncertain,
      });
      return this.getRequired(input.executionId);
    });
  }

  cancelQueued(
    executionId: string,
    canceledAt: string,
    expiresAt: string,
  ): SessionExecutionStorageRecord {
    return this.transaction(() => {
      const execution = this.getRequired(executionId);
      if (execution.state !== "queued") {
        throw new SessionExecutionStateConflictError(execution.id, execution.state);
      }
      this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'canceled', completed_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND state = 'queued'
      `).run(canceledAt, canceledAt, executionId);
      this.updateIdempotencyExpiry(executionId, expiresAt);
      this.appendStoredExecutionEvent(executionId, "canceled", canceledAt);
      new ResourceBudgetStorage(this.db).settleTurn({
        sessionId: execution.sessionId,
        executionId,
        outcome: "canceled",
        settledAt: canceledAt,
      });
      return this.getRequired(executionId);
    });
  }

  cancelQueuedIdempotent(input: {
    executionId: string;
    expectedRevision: number;
    idempotencyKey: string;
    requestFingerprint: string;
    canceledAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): SessionExecutionStorageRecord {
    return this.transaction(() => {
      const replay = this.resolveIdempotency("turn.cancel", input.proof, input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        return replay;
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.canceledAt));
      const execution = this.getRequired(input.executionId);
      const actualRevision = this.getExecutionRevision(input.executionId);
      if (actualRevision !== input.expectedRevision) {
        throw new SessionExecutionRevisionConflictError(input.executionId, input.expectedRevision, actualRevision);
      }
      if (execution.state !== "queued") {
        throw new SessionExecutionStateConflictError(execution.id, execution.state);
      }
      this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'canceled', completed_at = ?, updated_at = ?, revision = revision + 1,
            authority_proof_json = ?
        WHERE id = ? AND state = 'queued'
      `).run(input.canceledAt, input.canceledAt, JSON.stringify(input.proof), input.executionId);
      this.insertIdempotency(
        "turn.cancel",
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.executionId,
        input.canceledAt,
        input.expiresAt,
      );
      this.updateIdempotencyExpiry(input.executionId, input.expiresAt);
      this.appendStoredExecutionEvent(
        input.executionId,
        "canceled",
        input.canceledAt,
        input.proof,
        executionOperationId("turn.cancel", input.proof, input.idempotencyKey, input.requestFingerprint),
        input.idempotencyKey,
      );
      new ResourceBudgetStorage(this.db).settleTurn({
        sessionId: execution.sessionId,
        executionId: input.executionId,
        outcome: "canceled",
        settledAt: input.canceledAt,
      });
      return this.getRequired(input.executionId);
    });
  }

  recordIdempotency(input: {
    operation: SessionExecutionMutationOperation;
    idempotencyKey: string;
    requestFingerprint: string;
    executionId: string;
    expectedRevision: number;
    createdAt: string;
    expiresAt: string;
    proof: MutationAuthorityProof;
  }): SessionExecutionStorageRecord {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(input.operation, input.proof, input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        return replay;
      }
      assertGrantProofCurrent(this.db, input.proof, new Date(input.createdAt));
      const execution = this.getRequired(input.executionId);
      const actualRevision = this.getExecutionRevision(input.executionId);
      if (actualRevision !== input.expectedRevision) {
        throw new SessionExecutionRevisionConflictError(input.executionId, input.expectedRevision, actualRevision);
      }
      this.db.prepare(`
        UPDATE session_executions_v6
        SET revision = revision + 1, updated_at = ?, authority_proof_json = ?
        WHERE id = ?
      `).run(input.createdAt, JSON.stringify(input.proof), input.executionId);
      this.insertIdempotency(
        input.operation,
        input.proof,
        input.idempotencyKey,
        input.requestFingerprint,
        input.executionId,
        input.createdAt,
        input.expiresAt,
      );
      this.appendStoredExecutionEvent(
        input.executionId,
        "cancel_requested",
        input.createdAt,
        input.proof,
        executionOperationId("turn.cancel", input.proof, input.idempotencyKey, input.requestFingerprint),
        input.idempotencyKey,
      );
      return this.getRequired(execution.id);
    });
  }

  interruptRunningForRestart(
    interruptedAt: string,
    expiresAt: string,
  ): SessionExecutionStorageRecord[] {
    return this.interruptRunning(interruptedAt, expiresAt, "runtime_restarted");
  }

  interruptRunningForShutdown(
    interruptedAt: string,
    expiresAt: string,
  ): SessionExecutionStorageRecord[] {
    return this.interruptRunning(interruptedAt, expiresAt, "runtime_shutdown");
  }

  private interruptRunning(
    interruptedAt: string,
    expiresAt: string,
    reason: "runtime_restarted" | "runtime_shutdown",
  ): SessionExecutionStorageRecord[] {
    return this.transaction(() => {
      const runningIds = this.db.prepare(`
        SELECT id
        FROM session_executions_v6
        WHERE state = 'running'
        ORDER BY sequence ASC
      `).all() as Array<{ id: string }>;
      if (runningIds.length === 0) {
        return [];
      }
      this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'interrupted',
            reason = ?,
            completed_at = ?,
            updated_at = ?,
            revision = revision + 1
        WHERE state = 'running'
      `).run(reason, interruptedAt, interruptedAt);
      for (const { id } of runningIds) {
        this.updateIdempotencyExpiry(id, expiresAt);
        this.appendStoredExecutionEvent(id, "interrupted", interruptedAt);
        const execution = this.getRequired(id);
        new ResourceBudgetStorage(this.db).settleTurn({
          sessionId: execution.sessionId,
          executionId: id,
          outcome: "interrupted",
          settledAt: interruptedAt,
        });
      }
      return runningIds.map(({ id }) => this.getRequired(id));
    });
  }

  cleanupExpiredIdempotency(expiredBeforeOrAt: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_execution_idempotency_v6
      WHERE expires_at <= ?
        AND EXISTS (
          SELECT 1
          FROM session_executions_v6
          WHERE session_executions_v6.id = session_execution_idempotency_v6.execution_id
            AND session_executions_v6.state IN ('completed', 'failed', 'canceled', 'interrupted')
        )
    `).run(expiredBeforeOrAt);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private getRequired(executionId: string): SessionExecutionStorageRecord {
    const execution = this.get(executionId);
    if (!execution) {
      throw new Error(`Session execution not found: ${executionId}`);
    }
    return execution;
  }

  getSessionContainerRevision(sessionId: string): number {
    const revision = getSessionResourceRevision(this.db, sessionId);
    if (revision === null) throw new Error(`Session container was not found: ${sessionId}`);
    return revision;
  }

  private getExecutionRevision(executionId: string): number {
    const row = this.db.prepare("SELECT revision FROM session_executions_v6 WHERE id = ?").get(executionId) as
      | { revision: number }
      | undefined;
    if (!row) throw new Error(`Session execution not found: ${executionId}`);
    return row.revision;
  }

  private findIdempotency(
    operation: SessionExecutionMutationOperation,
    proof: MutationAuthorityProof,
    idempotencyKey: string,
  ): SessionExecutionIdempotencyRow | null {
    const principal = mutationPrincipalIdentity(proof);
    const row = this.db.prepare(`
      SELECT request_fingerprint, execution_id
      FROM session_execution_idempotency_v6
      WHERE operation = ? AND principal_kind = ? AND principal_id = ? AND idempotency_key = ?
    `).get(operation, principal.kind, principal.id, idempotencyKey) as SessionExecutionIdempotencyRow | undefined;
    if (row) return row;
    const legacy = this.db.prepare(`
      SELECT request_fingerprint, execution_id
      FROM session_execution_idempotency_v6
      WHERE operation = ? AND principal_kind = 'legacy_unknown' AND idempotency_key = ?
      LIMIT 1
    `).get(operation, idempotencyKey) as SessionExecutionIdempotencyRow | undefined;
    if (legacy) {
      throw new SessionExecutionIdempotencyResponseUnavailableError(operation, idempotencyKey, legacy.execution_id);
    }
    return null;
  }

  private insertIdempotency(
    operation: SessionExecutionMutationOperation,
    proof: MutationAuthorityProof,
    idempotencyKey: string,
    requestFingerprint: string,
    executionId: string,
    createdAt: string,
    expiresAt: string,
  ): void {
    const principal = mutationPrincipalIdentity(proof);
    this.db.prepare(`
      INSERT INTO session_execution_idempotency_v6 (
        operation,
        principal_kind,
        principal_id,
        idempotency_key,
        request_fingerprint,
        execution_id,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(operation, principal.kind, principal.id, idempotencyKey, requestFingerprint, executionId, createdAt, expiresAt);
  }

  private insertOriginSnapshot(
    executionId: string,
    targetSessionId: string,
    origin: SessionExecutionOriginSnapshot | undefined,
    acceptedAt: string,
  ): void {
    if (!origin || origin.sourceSessionId === targetSessionId) return;
    this.db.prepare(`
      INSERT INTO session_execution_origins_v6 (
        execution_id, execution_sequence, source_session_id, target_session_id,
        operation, target_session_title_snapshot, target_session_role_snapshot,
        source_message_seq_anchor, user_message, accepted_at
      )
      SELECT id, sequence, ?, session_id, operation, ?, ?,
        COALESCE((
          SELECT MAX(message.seq)
          FROM session_messages_v6 AS message
          WHERE message.session_id = ?
        ), -1),
        ?, ?
      FROM session_executions_v6
      WHERE id = ? AND session_id = ?
    `).run(
      origin.sourceSessionId,
      origin.targetSessionTitle,
      origin.targetSessionRole,
      origin.sourceSessionId,
      origin.userMessage,
      acceptedAt,
      executionId,
      targetSessionId,
    );
  }

  private insertWorkItemAssociation(
    executionId: string,
    workItemId: string | undefined,
    targetSessionId: string,
    createdAt: string,
  ): void {
    if (!workItemId) return;
    const result = this.db.prepare(`
      INSERT INTO work_item_execution_associations_v6 (execution_id, work_item_id, created_at)
      SELECT ?, id, ?
      FROM work_items_v6
      WHERE id = ?
        AND target_session_id = ?
        AND state IN ('pending', 'in_progress', 'waiting')
    `).run(executionId, createdAt, workItemId, targetSessionId);
    if (result.changes !== 1) {
      throw new SessionExecutionWorkItemAssociationError(workItemId, targetSessionId);
    }
  }

  private updateIdempotencyExpiry(executionId: string, expiresAt: string): void {
    this.db.prepare(`
      UPDATE session_execution_idempotency_v6
      SET expires_at = ?
      WHERE execution_id = ?
    `).run(expiresAt, executionId);
  }

  private assertTerminalFailureNotificationAuthority(input: EnqueueSessionExecutionInput): void {
    const request = input.request && typeof input.request === "object" && !Array.isArray(input.request)
      ? input.request as Record<string, unknown>
      : {};
    const notification = request.terminalFailureNotification as {
      targetSessionId?: unknown;
      sourceSession?: { sessionId?: unknown };
    } | null | undefined;
    const proof = input.terminalFailureNotificationProof;
    if (!notification) {
      if (proof) throw new TypeError("A terminal failure notification proof requires a notification request.");
      return;
    }
    if (!proof || proof.principal.kind !== "agent") {
      throw new TypeError("A terminal failure notification requires an agent authority proof.");
    }
    const sourceId = notification.sourceSession?.sessionId;
    const targetId = notification.targetSessionId;
    if (typeof sourceId !== "string" || typeof targetId !== "string") {
      throw new TypeError("The terminal failure notification source and target Session IDs are required.");
    }
    if (sourceId !== input.sessionId || sourceId === targetId) {
      throw new TypeError("The terminal failure notification source or target does not match the execution.");
    }
    const bindings = this.db.prepare(`
      SELECT session_id, session_role, root_session_id, parent_session_id
      FROM session_role_bindings_v6
      WHERE session_id IN (?, ?)
      ORDER BY session_id
    `).all(sourceId, targetId) as Array<{
      session_id: string;
      session_role: "standalone" | "overall-coordinator" | "task-coordinator" | "executor";
      root_session_id: string;
      parent_session_id: string | null;
    }>;
    const source = bindings.find((row) => row.session_id === sourceId);
    const target = bindings.find((row) => row.session_id === targetId);
    const scope = proof.resolvedScope;
    if (!source || !target || source.root_session_id !== target.root_session_id
      || proof.principal.actorSessionId !== sourceId
      || proof.operation !== "turn.enqueue"
      || proof.action !== "turn.enqueue"
      || proof.effectClass !== "external_side_effect"
      || scope.resourceKind !== "execution"
      || scope.resourceId !== targetId
      || scope.rootSessionId !== source.root_session_id
      || scope.ownerKind !== "session"
      || scope.ownerId !== targetId
      || !sessionRelationMatches(source, target, scope.relation)) {
      throw new TypeError("The terminal failure notification authority proof does not match its canonical Session scope.");
    }
    assertGrantProofCurrent(this.db, proof, new Date(input.createdAt), target.session_role);
  }

  private appendStoredExecutionEvent(
    executionId: string,
    eventKind: string,
    occurredAt: string,
    proofOverride?: MutationAuthorityProof,
    operationId = `execution-lifecycle:${executionId}`,
    idempotencyKey: string | null = null,
  ): void {
    const row = this.db.prepare("SELECT * FROM session_executions_v6 WHERE id = ?")
      .get(executionId) as SessionExecutionRow | undefined;
    if (!row) throw new Error(`Session execution not found: ${executionId}`);
    const proof = proofOverride ?? decodeExecutionMutationProof(this.db, row, occurredAt);
    appendSessionExecutionEvent(this.db, {
      executionId,
      revision: row.revision,
      eventKind,
      proof,
      operationId,
      idempotencyKey,
      occurredAt,
      payload: executionHistoryPayload(parseExecution(row)),
    });
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseExecution(row: SessionExecutionRow): SessionExecutionStorageRecord {
  return {
    sequence: row.sequence,
    revision: row.revision,
    id: row.id,
    sessionId: row.session_id,
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
  };
}

function serializeJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${label} must be JSON serializable.`);
  }
  return serialized;
}

export class SessionExecutionIdempotencyResponseUnavailableError extends Error {
  readonly code = "IDEMPOTENCY_RESPONSE_UNAVAILABLE";
  readonly effect = "applied" as const;

  constructor(
    readonly operation: SessionExecutionMutationOperation,
    readonly idempotencyKey: string,
    readonly executionId: string,
  ) {
    super(`The original Session execution response is unavailable after migration: ${operation}`);
    this.name = "SessionExecutionIdempotencyResponseUnavailableError";
  }
}

export class SessionExecutionRevisionConflictError extends Error {
  readonly code = "EXECUTION_REVISION_CONFLICT";

  constructor(
    readonly executionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Session execution revision is stale: ${executionId}`);
    this.name = "SessionExecutionRevisionConflictError";
  }
}

function executionOperationId(
  operation: SessionExecutionMutationOperation,
  proof: MutationAuthorityProof,
  idempotencyKey: string,
  requestFingerprint: string,
): string {
  const principal = mutationPrincipalIdentity(proof);
  const identity = createHash("sha256")
    .update(principal.kind)
    .update("\0")
    .update(principal.id)
    .update("\0")
    .update(idempotencyKey)
    .update("\0")
    .update(requestFingerprint)
    .digest("hex");
  return `session-execution:${operation}:${identity}`;
}

function mutationPrincipalIdentity(proof: MutationAuthorityProof): {
  kind: "agent" | "user" | "system";
  id: string;
} {
  if (proof.principal.kind === "agent") {
    return { kind: "agent", id: proof.principal.actorSessionId };
  }
  if (proof.principal.kind === "user") {
    return { kind: "user", id: "local-user" };
  }
  return { kind: "system", id: proof.principal.service };
}

function sessionRelationMatches(
  source: { session_id: string; root_session_id: string; parent_session_id: string | null },
  target: { session_id: string; root_session_id: string; parent_session_id: string | null },
  relation: MutationAuthorityProof["resolvedScope"]["relation"],
): boolean {
  if (source.session_id === target.session_id) return relation === "self";
  return (source.parent_session_id === target.session_id && relation === "parent")
    || (target.parent_session_id === source.session_id && relation === "direct_child")
    || (source.parent_session_id !== null
      && source.parent_session_id === target.parent_session_id
      && relation === "sibling")
    || (target.session_id === source.root_session_id && relation === "root_owner")
    || (source.session_id === source.root_session_id && relation === "root_member");
}

function executionHistoryPayload(execution: SessionExecutionStorageRecord): Readonly<Record<string, unknown>> {
  return {
    operation: execution.operation,
    state: execution.state,
    errorCode: execution.errorCode,
    reason: execution.reason,
    createdAt: execution.createdAt,
    admittedAt: execution.admittedAt,
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
  };
}

function decodeExecutionMutationProof(
  db: DatabaseSync,
  row: SessionExecutionRow,
  evaluatedAt: string,
): MutationAuthorityProof {
  if (row.authority_proof_json !== null) {
    return JSON.parse(row.authority_proof_json) as MutationAuthorityProof;
  }
  const binding = db.prepare("SELECT root_session_id FROM session_role_bindings_v6 WHERE session_id = ?")
    .get(row.session_id) as { root_session_id: string } | undefined;
  return {
    principal: { kind: "system", service: "session-execution-migration-recovery" },
    operation: row.operation,
    mappingRevision: SESSION_AUTHORITY_MAPPING_REVISION,
    action: row.operation,
    resolvedScope: {
      resourceKind: "execution",
      resourceId: row.id,
      rootSessionId: binding?.root_session_id ?? row.session_id,
      ownerKind: "session",
      ownerId: row.session_id,
      relation: "self",
    },
    effectClass: "external_side_effect",
    grantId: null,
    grantRevision: null,
    evaluatedAt,
  };
}
