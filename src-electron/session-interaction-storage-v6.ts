import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";

import {
  SESSION_INTERACTION_PAGE_MAX,
  SESSION_INTERACTION_PUBLIC_MAX_BYTES,
  type SessionInteraction,
  type SessionInteractionExpiryReason,
  type SessionInteractionKind,
  type SessionInteractionPublicPayload,
  type SessionInteractionResponseAction,
} from "../src/session-interaction.js";
import { ensureV6Schema } from "./database-schema-v6.js";
import { openAppDatabase } from "./sqlite-connection.js";

type SessionInteractionRow = {
  sequence: number;
  id: string;
  session_id: string;
  execution_id: string;
  kind: SessionInteractionKind;
  state: "pending" | "answered" | "expired";
  public_payload_json: string;
  response_action: SessionInteractionResponseAction | null;
  response_submitted_fields_json: string | null;
  response_fingerprint: string | null;
  expiry_reason: SessionInteractionExpiryReason | null;
  created_at: string;
  resolved_at: string | null;
  updated_at: string;
};

type SessionInteractionIdempotencyRow = {
  request_fingerprint: string;
  interaction_id: string;
};

export type SessionInteractionStorageRecord = SessionInteraction & {
  responseFingerprint: string | null;
};

export type CreatePendingSessionInteractionInput = {
  id: string;
  sessionId: string;
  executionId: string;
  kind: SessionInteractionKind;
  publicPayload: SessionInteractionPublicPayload;
  createdAt: string;
};

export type RespondToSessionInteractionInput = {
  sessionId: string;
  executionId: string;
  interactionId: string;
  action: SessionInteractionResponseAction;
  submittedFields: readonly string[];
  idempotencyKey: string;
  requestFingerprint: string;
  respondedAt: string;
  expiresAt: string;
};

export type RespondToSessionInteractionResult = {
  interaction: SessionInteractionStorageRecord;
  replayed: boolean;
};

export type SessionInteractionListFilter = {
  executionId?: string;
  kind?: SessionInteractionKind;
  state?: SessionInteraction["state"];
};

export class SessionInteractionNotFoundError extends Error {
  readonly code = "INTERACTION_NOT_FOUND";

  constructor(readonly interactionId: string) {
    super(`Session interaction not found: ${interactionId}`);
    this.name = "SessionInteractionNotFoundError";
  }
}

export class SessionInteractionTargetMismatchError extends Error {
  readonly code = "INTERACTION_TARGET_MISMATCH";

  constructor(readonly interactionId: string) {
    super(`Session interaction does not belong to the requested execution: ${interactionId}`);
    this.name = "SessionInteractionTargetMismatchError";
  }
}

export class SessionInteractionExecutionStateError extends Error {
  readonly code = "EXECUTION_STATE_CONFLICT";

  constructor(readonly executionId: string, readonly state: string | null) {
    super(`Session execution cannot accept an interaction: ${executionId} (${state ?? "missing"})`);
    this.name = "SessionInteractionExecutionStateError";
  }
}

export class SessionInteractionPendingConflictError extends Error {
  readonly code = "INTERACTION_PENDING";

  constructor(readonly executionId: string) {
    super(`Session execution already has a pending interaction: ${executionId}`);
    this.name = "SessionInteractionPendingConflictError";
  }
}

export class SessionInteractionAlreadyResolvedError extends Error {
  readonly code = "INTERACTION_ALREADY_RESOLVED";

  constructor(readonly interactionId: string, readonly state: "answered" | "expired") {
    super(`Session interaction is already resolved: ${interactionId} (${state})`);
    this.name = "SessionInteractionAlreadyResolvedError";
  }
}

export class SessionInteractionIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly idempotencyKey: string) {
    super("Session interaction idempotency key was reused with a different response.");
    this.name = "SessionInteractionIdempotencyConflictError";
  }
}

export class SessionInteractionPayloadTooLargeError extends Error {
  readonly code = "RESULT_TOO_LARGE";

  constructor(readonly actualBytes: number) {
    super(`Session interaction public payload exceeds ${SESSION_INTERACTION_PUBLIC_MAX_BYTES} bytes.`);
    this.name = "SessionInteractionPayloadTooLargeError";
  }
}

export class SessionInteractionStorageV6 {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openAppDatabase(dbPath);
    ensureV6Schema(this.db);
  }

  createPending(input: CreatePendingSessionInteractionInput): SessionInteractionStorageRecord {
    const publicPayloadJson = serializePublicPayload(input.publicPayload);
    return this.transaction(() => {
      const execution = this.db.prepare(`
        SELECT session_id, state
        FROM session_executions_v6
        WHERE id = ?
      `).get(input.executionId) as { session_id: string; state: string } | undefined;
      if (!execution || execution.state !== "running") {
        throw new SessionInteractionExecutionStateError(input.executionId, execution?.state ?? null);
      }
      if (execution.session_id !== input.sessionId) {
        throw new SessionInteractionTargetMismatchError(input.id);
      }

      const pending = this.db.prepare(`
        SELECT id
        FROM session_interactions_v6
        WHERE execution_id = ? AND state = 'pending'
      `).get(input.executionId) as { id: string } | undefined;
      if (pending) {
        throw new SessionInteractionPendingConflictError(input.executionId);
      }

      this.db.prepare(`
        INSERT INTO session_interactions_v6 (
          id,
          execution_id,
          kind,
          state,
          public_payload_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        input.id,
        input.executionId,
        input.kind,
        publicPayloadJson,
        input.createdAt,
        input.createdAt,
      );
      return this.getRequired(input.id);
    });
  }

  get(interactionId: string): SessionInteractionStorageRecord | null {
    const row = this.selectInteraction("WHERE interactions.id = ?").get(interactionId) as
      | SessionInteractionRow
      | undefined;
    return row ? parseInteraction(row) : null;
  }

  getPendingForExecution(executionId: string): SessionInteractionStorageRecord | null {
    const row = this.selectInteraction(`
      WHERE interactions.execution_id = ? AND interactions.state = 'pending'
    `).get(executionId) as SessionInteractionRow | undefined;
    return row ? parseInteraction(row) : null;
  }

  listSessionInteractionsPage(
    sessionId: string,
    afterSequence: number | null,
    limit: number,
    filter: SessionInteractionListFilter = {},
  ): SessionInteractionStorageRecord[] {
    assertPageInput(afterSequence, limit);
    const clauses = ["executions.session_id = ?"];
    const parameters: Array<string | number> = [sessionId];
    if (afterSequence !== null) {
      clauses.push("interactions.sequence > ?");
      parameters.push(afterSequence);
    }
    if (filter.executionId !== undefined) {
      clauses.push("interactions.execution_id = ?");
      parameters.push(filter.executionId);
    }
    if (filter.kind !== undefined) {
      clauses.push("interactions.kind = ?");
      parameters.push(filter.kind);
    }
    if (filter.state !== undefined) {
      clauses.push("interactions.state = ?");
      parameters.push(filter.state);
    }
    parameters.push(limit);
    const rows = this.selectInteraction(`
      WHERE ${clauses.join(" AND ")}
      ORDER BY interactions.sequence ASC
      LIMIT ?
    `).all(...parameters) as SessionInteractionRow[];
    return rows.map(parseInteraction);
  }

  listExecutionInteractions(executionId: string): SessionInteractionStorageRecord[] {
    const rows = this.selectInteraction(`
      WHERE interactions.execution_id = ?
      ORDER BY interactions.sequence ASC
    `).all(executionId) as SessionInteractionRow[];
    return rows.map(parseInteraction);
  }

  respond(input: RespondToSessionInteractionInput): RespondToSessionInteractionResult {
    const submittedFieldsJson = JSON.stringify(normalizeSubmittedFields(input.submittedFields));
    return this.transaction(() => {
      const replay = this.findIdempotency(input.idempotencyKey);
      if (replay) {
        if (replay.request_fingerprint !== input.requestFingerprint) {
          throw new SessionInteractionIdempotencyConflictError(input.idempotencyKey);
        }
        const interaction = this.getRequired(replay.interaction_id);
        this.assertTarget(interaction, input);
        return { interaction, replayed: true };
      }

      const interaction = this.getRequired(input.interactionId);
      this.assertTarget(interaction, input);
      if (interaction.state !== "pending") {
        throw new SessionInteractionAlreadyResolvedError(interaction.id, interaction.state);
      }
      const execution = this.db.prepare(`
        SELECT state
        FROM session_executions_v6
        WHERE id = ?
      `).get(input.executionId) as { state: string } | undefined;
      if (!execution || execution.state !== "running") {
        throw new SessionInteractionExecutionStateError(input.executionId, execution?.state ?? null);
      }

      const updated = this.db.prepare(`
        UPDATE session_interactions_v6
        SET state = 'answered',
            response_action = ?,
            response_submitted_fields_json = ?,
            response_fingerprint = ?,
            resolved_at = ?,
            updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(
        input.action,
        submittedFieldsJson,
        input.requestFingerprint,
        input.respondedAt,
        input.respondedAt,
        input.interactionId,
      );
      if (updated.changes !== 1) {
        const current = this.getRequired(input.interactionId);
        if (current.state === "pending") {
          throw new Error(`Failed to resolve pending session interaction: ${current.id}`);
        }
        throw new SessionInteractionAlreadyResolvedError(current.id, current.state);
      }

      this.db.prepare(`
        INSERT INTO session_interaction_idempotency_v6 (
          operation,
          idempotency_key,
          request_fingerprint,
          interaction_id,
          created_at,
          expires_at
        ) VALUES ('interaction.respond', ?, ?, ?, ?, ?)
      `).run(
        input.idempotencyKey,
        input.requestFingerprint,
        input.interactionId,
        input.respondedAt,
        input.expiresAt,
      );
      return { interaction: this.getRequired(input.interactionId), replayed: false };
    });
  }

  expirePendingForRestart(expiredAt: string): SessionInteractionStorageRecord[] {
    return this.expirePending("runtime_restarted", expiredAt);
  }

  expirePendingForShutdown(expiredAt: string): SessionInteractionStorageRecord[] {
    return this.expirePending("runtime_shutdown", expiredAt);
  }

  expirePendingForExecution(
    executionId: string,
    reason: "execution_canceled" | "execution_terminal",
    expiredAt: string,
  ): SessionInteractionStorageRecord[] {
    return this.expirePending(reason, expiredAt, executionId);
  }

  cleanupExpiredResponseIdempotency(expiredBeforeOrAt: string): number {
    const result = this.db.prepare(`
      DELETE FROM session_interaction_idempotency_v6
      WHERE expires_at <= ?
    `).run(expiredBeforeOrAt);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private expirePending(
    reason: SessionInteractionExpiryReason,
    expiredAt: string,
    executionId?: string,
  ): SessionInteractionStorageRecord[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id
        FROM session_interactions_v6
        WHERE state = 'pending'${executionId === undefined ? "" : " AND execution_id = ?"}
        ORDER BY sequence ASC
      `).all(...(executionId === undefined ? [] : [executionId])) as Array<{ id: string }>;
      if (rows.length === 0) {
        return [];
      }
      this.db.prepare(`
        UPDATE session_interactions_v6
        SET state = 'expired',
            expiry_reason = ?,
            resolved_at = ?,
            updated_at = ?
        WHERE state = 'pending'${executionId === undefined ? "" : " AND execution_id = ?"}
      `).run(reason, expiredAt, expiredAt, ...(executionId === undefined ? [] : [executionId]));
      return rows.map(({ id }) => this.getRequired(id));
    });
  }

  private assertTarget(
    interaction: SessionInteractionStorageRecord,
    input: Pick<RespondToSessionInteractionInput, "sessionId" | "executionId" | "interactionId">,
  ): void {
    if (
      interaction.id !== input.interactionId
      || interaction.executionId !== input.executionId
      || interaction.sessionId !== input.sessionId
    ) {
      throw new SessionInteractionTargetMismatchError(input.interactionId);
    }
  }

  private getRequired(interactionId: string): SessionInteractionStorageRecord {
    const interaction = this.get(interactionId);
    if (!interaction) {
      throw new SessionInteractionNotFoundError(interactionId);
    }
    return interaction;
  }

  private findIdempotency(idempotencyKey: string): SessionInteractionIdempotencyRow | null {
    const row = this.db.prepare(`
      SELECT request_fingerprint, interaction_id
      FROM session_interaction_idempotency_v6
      WHERE operation = 'interaction.respond' AND idempotency_key = ?
    `).get(idempotencyKey) as SessionInteractionIdempotencyRow | undefined;
    return row ?? null;
  }

  private selectInteraction(suffix: string) {
    return this.db.prepare(`
      SELECT
        interactions.*,
        executions.session_id
      FROM session_interactions_v6 AS interactions
      INNER JOIN session_executions_v6 AS executions
        ON executions.id = interactions.execution_id
      ${suffix}
    `);
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

function parseInteraction(row: SessionInteractionRow): SessionInteractionStorageRecord {
  const base = {
    sequence: row.sequence,
    id: row.id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    kind: row.kind,
    publicPayload: JSON.parse(row.public_payload_json) as SessionInteractionPublicPayload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    responseFingerprint: row.response_fingerprint,
  };
  if (row.state === "pending") {
    return {
      ...base,
      state: "pending",
      response: null,
      expiryReason: null,
      resolvedAt: null,
    };
  }
  if (row.state === "expired") {
    if (!row.expiry_reason || !row.resolved_at) {
      throw new Error(`Invalid expired session interaction row: ${row.id}`);
    }
    return {
      ...base,
      state: "expired",
      response: null,
      expiryReason: row.expiry_reason,
      resolvedAt: row.resolved_at,
    };
  }
  if (!row.response_action || !row.response_submitted_fields_json || !row.resolved_at) {
    throw new Error(`Invalid answered session interaction row: ${row.id}`);
  }
  const submittedFields = JSON.parse(row.response_submitted_fields_json) as unknown;
  if (!Array.isArray(submittedFields) || submittedFields.some((field) => typeof field !== "string")) {
    throw new Error(`Invalid submitted fields for session interaction: ${row.id}`);
  }
  return {
    ...base,
    state: "answered",
    response: {
      action: row.response_action,
      submittedFields,
    },
    expiryReason: null,
    resolvedAt: row.resolved_at,
  };
}

function serializePublicPayload(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Session interaction public payload must be JSON serializable.");
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > SESSION_INTERACTION_PUBLIC_MAX_BYTES) {
    throw new SessionInteractionPayloadTooLargeError(byteLength);
  }
  return serialized;
}

function normalizeSubmittedFields(fields: readonly string[]): string[] {
  return [...new Set(fields)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPageInput(afterSequence: number | null, limit: number): void {
  if (afterSequence !== null && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
    throw new RangeError("Session interaction cursor sequence must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_INTERACTION_PAGE_MAX) {
    throw new RangeError(`Session interaction page limit must be between 1 and ${SESSION_INTERACTION_PAGE_MAX}.`);
  }
}
