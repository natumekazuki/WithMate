import type { DatabaseSync } from "node:sqlite";

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
};

type SessionExecutionIdempotencyRow = {
  request_fingerprint: string;
  execution_id: string;
};

export type EnqueueSessionExecutionInput = {
  id: string;
  sessionId: string;
  request: unknown;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: string;
  expiresAt: string;
  origin?: SessionExecutionOriginSnapshot;
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
      const replay = this.findIdempotency("turn.enqueue", input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== input.requestFingerprint) {
          throw new SessionExecutionIdempotencyConflictError("turn.enqueue", input.idempotencyKey);
        }
        const execution = this.getRequired(replay.execution_id);
        return { execution, replayed: true };
      }

      const queuedCount = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM session_executions_v6
        WHERE session_id = ? AND state = 'queued'
      `).get(input.sessionId) as { count: number };
      if (queuedCount.count >= SESSION_EXECUTION_QUEUE_LIMIT) {
        throw new SessionExecutionQueueFullError(input.sessionId);
      }

      this.db.prepare(`
        INSERT INTO session_executions_v6 (
          id,
          session_id,
          operation,
          state,
          request_json,
          created_at,
          updated_at
        ) VALUES (?, ?, 'turn.enqueue', 'queued', ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        requestJson,
        input.createdAt,
        input.createdAt,
      );
      this.insertOriginSnapshot(input.id, input.sessionId, input.origin, input.createdAt);
      this.db.prepare(`
        INSERT INTO session_execution_idempotency_v6 (
          operation,
          idempotency_key,
          request_fingerprint,
          execution_id,
          created_at,
          expires_at
        ) VALUES ('turn.enqueue', ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey,
        input.requestFingerprint,
        input.id,
        input.createdAt,
        input.expiresAt,
      );

      return { execution: this.getRequired(input.id), replayed: false };
    });
  }

  startImmediate(input: StartSessionExecutionInput): EnqueueSessionExecutionResult {
    const requestJson = serializeJson(input.request, "Session execution request");
    return this.transaction(() => {
      const replay = this.findIdempotency("turn.run", input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== input.requestFingerprint) {
          throw new SessionExecutionIdempotencyConflictError("turn.run", input.idempotencyKey);
        }
        return { execution: this.getRequired(replay.execution_id), replayed: true };
      }

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

      this.db.prepare(`
        INSERT INTO session_executions_v6 (
          id,
          session_id,
          operation,
          state,
          request_json,
          created_at,
          admitted_at,
          updated_at
        ) VALUES (?, ?, 'turn.run', 'running', ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        requestJson,
        input.createdAt,
        input.createdAt,
        input.createdAt,
      );
      this.insertOriginSnapshot(input.id, input.sessionId, input.origin, input.createdAt);
      this.db.prepare(`
        INSERT INTO session_execution_idempotency_v6 (
          operation,
          idempotency_key,
          request_fingerprint,
          execution_id,
          created_at,
          expires_at
        ) VALUES ('turn.run', ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey,
        input.requestFingerprint,
        input.id,
        input.createdAt,
        input.expiresAt,
      );
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
    idempotencyKey: string,
    requestFingerprint: string,
  ): SessionExecutionStorageRecord | null {
    const replay = this.findIdempotency(operation, idempotencyKey);
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

      const updated = this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'running', admitted_at = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(admittedAt, admittedAt, next.id);
      if (updated.changes !== 1) {
        return null;
      }
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
            updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(failedAt, failedAt, next.id);
      if (updated.changes !== 1) {
        return null;
      }
      this.updateIdempotencyExpiry(next.id, expiresAt);
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
            updated_at = ?
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
        SET state = 'canceled', completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(canceledAt, canceledAt, executionId);
      this.updateIdempotencyExpiry(executionId, expiresAt);
      return this.getRequired(executionId);
    });
  }

  cancelQueuedIdempotent(input: {
    executionId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    canceledAt: string;
    expiresAt: string;
  }): SessionExecutionStorageRecord {
    return this.transaction(() => {
      const replay = this.resolveIdempotency("turn.cancel", input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        return replay;
      }
      const execution = this.getRequired(input.executionId);
      if (execution.state !== "queued") {
        throw new SessionExecutionStateConflictError(execution.id, execution.state);
      }
      this.db.prepare(`
        UPDATE session_executions_v6
        SET state = 'canceled', completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(input.canceledAt, input.canceledAt, input.executionId);
      this.insertIdempotency(
        "turn.cancel",
        input.idempotencyKey,
        input.requestFingerprint,
        input.executionId,
        input.canceledAt,
        input.expiresAt,
      );
      this.updateIdempotencyExpiry(input.executionId, input.expiresAt);
      return this.getRequired(input.executionId);
    });
  }

  recordIdempotency(input: {
    operation: SessionExecutionMutationOperation;
    idempotencyKey: string;
    requestFingerprint: string;
    executionId: string;
    createdAt: string;
    expiresAt: string;
  }): SessionExecutionStorageRecord {
    return this.transaction(() => {
      const replay = this.resolveIdempotency(input.operation, input.idempotencyKey, input.requestFingerprint);
      if (replay) {
        return replay;
      }
      const execution = this.getRequired(input.executionId);
      this.insertIdempotency(
        input.operation,
        input.idempotencyKey,
        input.requestFingerprint,
        input.executionId,
        input.createdAt,
        input.expiresAt,
      );
      return execution;
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
            updated_at = ?
        WHERE state = 'running'
      `).run(reason, interruptedAt, interruptedAt);
      for (const { id } of runningIds) {
        this.updateIdempotencyExpiry(id, expiresAt);
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

  private findIdempotency(
    operation: SessionExecutionMutationOperation,
    idempotencyKey: string,
  ): SessionExecutionIdempotencyRow | null {
    const row = this.db.prepare(`
      SELECT request_fingerprint, execution_id
      FROM session_execution_idempotency_v6
      WHERE operation = ? AND idempotency_key = ?
    `).get(operation, idempotencyKey) as SessionExecutionIdempotencyRow | undefined;
    return row ?? null;
  }

  private insertIdempotency(
    operation: SessionExecutionMutationOperation,
    idempotencyKey: string,
    requestFingerprint: string,
    executionId: string,
    createdAt: string,
    expiresAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO session_execution_idempotency_v6 (
        operation,
        idempotency_key,
        request_fingerprint,
        execution_id,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(operation, idempotencyKey, requestFingerprint, executionId, createdAt, expiresAt);
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

  private updateIdempotencyExpiry(executionId: string, expiresAt: string): void {
    this.db.prepare(`
      UPDATE session_execution_idempotency_v6
      SET expires_at = ?
      WHERE execution_id = ?
    `).run(expiresAt, executionId);
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
