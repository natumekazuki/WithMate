import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import {
  REPOSITORY_WRITE_OPERATIONS,
  type RepositoryCommandErrorCode,
  type RepositoryCommandResult,
  type SessionCreateCommand,
  type SessionCreateResult,
  type SessionLifecycleStatus,
  type SessionTransitionCommand,
  type SessionTransitionResult,
} from "../shared/repository-write-model.js";
import { executeWriteTransaction } from "./request-executor.js";

export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type RepositoryWriteOperation = Readonly<{
  requestClass: "write";
  execute: (payload: Readonly<Record<string, unknown>>) => Readonly<{ result: unknown }>;
}>;

type WriteOptions = Readonly<{
  clock?: () => number;
  idempotencyRetentionMs?: number;
}>;

export function createRepositoryWriteOperations(
  database: DatabaseSync,
  options: WriteOptions = {},
): ReadonlyMap<string, RepositoryWriteOperation> {
  const clock = options.clock ?? Date.now;
  const retentionMs = options.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    throw new RangeError("idempotencyRetentionMs must be a positive safe integer.");
  }
  return new Map([
    [
      REPOSITORY_WRITE_OPERATIONS.sessionCreate,
      write((payload) =>
        runDecoded(decodeSessionCreate(payload), (command) => {
          const prepared = prepareSessionCreate(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () => createSession(database, prepared, now, retentionMs));
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.sessionTransition,
      write((payload) =>
        runDecoded(decodeSessionTransition(payload), (command) => {
          const prepared = prepareSessionTransition(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () => transitionSession(database, prepared, now, retentionMs));
        }),
      ),
    ],
  ]);
}

function write(execute: (payload: Readonly<Record<string, unknown>>) => unknown): RepositoryWriteOperation {
  return { requestClass: "write", execute: (payload) => ({ result: execute(payload) }) };
}

function createSession(
  database: DatabaseSync,
  prepared: PreparedSessionCreate,
  now: number,
  retentionMs: number,
): RepositoryCommandResult<SessionCreateResult> {
  const idempotency = checkIdempotency<SessionCreateResult>(
    database,
    prepared.command.idempotencyKey,
    "session.create",
    prepared.fingerprint,
    prepared.command.session.id,
    now,
  );
  if (idempotency.kind !== "new") return idempotency.result;

  if (database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(prepared.command.session.id) !== undefined) {
    return failure("lifecycle_conflict", "Session already exists.");
  }
  const session = prepared.command.session;
  database
    .prepare(
      `
      INSERT INTO sessions (
        id, provider_id, workspace_key, allowed_additional_directories_json,
        default_character_id, max_concurrent_child_runs, lifecycle_status,
        created_at, updated_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `,
    )
    .run(
      session.id,
      session.providerId,
      session.workspaceKey,
      prepared.directoriesJson,
      session.defaultCharacterId,
      session.maxConcurrentChildRuns,
      now,
      now,
      now,
    );
  const value: SessionCreateResult = {
    sessionId: session.id,
    workspaceKey: session.workspaceKey,
    lifecycleStatus: "active",
    createdAt: now,
  };
  completeIdempotency(
    database,
    prepared.command.idempotencyKey,
    session.id,
    "session.create",
    prepared.fingerprint,
    "session",
    session.id,
    value,
    now,
    retentionMs,
  );
  return success(value, false);
}

function transitionSession(
  database: DatabaseSync,
  prepared: PreparedSessionTransition,
  now: number,
  retentionMs: number,
): RepositoryCommandResult<SessionTransitionResult> {
  const command = prepared.command;
  const idempotency = checkIdempotency<SessionTransitionResult>(
    database,
    command.idempotencyKey,
    prepared.operation,
    prepared.fingerprint,
    command.sessionId,
    now,
  );
  if (idempotency.kind !== "new") return idempotency.result;

  const row = database
    .prepare("SELECT lifecycle_status, updated_at, provider_id FROM sessions WHERE id = ? AND workspace_key = ?")
    .get(command.sessionId, command.workspaceKey) as
    Readonly<{ lifecycle_status: SessionLifecycleStatus; updated_at: number; provider_id: string }> | undefined;
  if (row === undefined) return failure("not_found", "Session was not found.");
  if (row.lifecycle_status !== command.expectedLifecycleStatus) {
    return failure("lifecycle_conflict", "Session lifecycle changed before the command committed.");
  }
  if (command.targetLifecycleStatus !== "active" && hasNonTerminalRun(database, command.sessionId)) {
    return failure("session_busy", "Session has a non-terminal Run.");
  }
  if (
    command.targetLifecycleStatus === "active" &&
    !canResumeProviderBinding(database, command.sessionId, row.provider_id)
  ) {
    return failure("reference_invalid", "Provider binding cannot be resumed for this Session.");
  }
  const updatedAt = Math.max(now, row.updated_at);
  const update = database
    .prepare(
      `
      UPDATE sessions SET lifecycle_status = ?, updated_at = ?
      WHERE id = ? AND workspace_key = ? AND lifecycle_status = ?
    `,
    )
    .run(
      command.targetLifecycleStatus,
      updatedAt,
      command.sessionId,
      command.workspaceKey,
      command.expectedLifecycleStatus,
    );
  if (update.changes !== 1) return failure("lifecycle_conflict", "Session lifecycle update conflicted.");
  const value: SessionTransitionResult = {
    sessionId: command.sessionId,
    lifecycleStatus: command.targetLifecycleStatus,
    updatedAt,
  };
  completeIdempotency(
    database,
    command.idempotencyKey,
    command.sessionId,
    prepared.operation,
    prepared.fingerprint,
    "session",
    command.sessionId,
    value,
    now,
    retentionMs,
  );
  return success(value, false);
}

function checkIdempotency<T>(
  database: DatabaseSync,
  key: string,
  operation: string,
  fingerprint: string,
  expectedScopeSessionId: string,
  now: number,
): Readonly<{ kind: "new" }> | Readonly<{ kind: "replay" | "failure"; result: RepositoryCommandResult<T> }> {
  const row = database.prepare("SELECT * FROM idempotency_records WHERE idempotency_key = ?").get(key) as
    IdempotencyRow | undefined;
  if (row === undefined) return { kind: "new" };
  if (
    row.scope_session_id !== expectedScopeSessionId ||
    row.operation !== operation ||
    row.request_fingerprint !== fingerprint
  ) {
    return { kind: "failure", result: failure("idempotency_conflict", "Idempotency key was used differently.") };
  }
  if (row.record_state === "in_progress") {
    return { kind: "failure", result: failure("idempotency_in_progress", "Idempotent command is in progress.", true) };
  }
  if (row.record_state === "expired" || (row.expires_at !== null && row.expires_at <= now)) {
    if (row.record_state === "completed") {
      database
        .prepare(
          `
        UPDATE idempotency_records SET record_state = 'expired', response_kind = NULL,
          response_ref_type = NULL, response_ref_id = NULL, response_envelope_json = NULL
        WHERE idempotency_key = ? AND record_state = 'completed'
      `,
        )
        .run(key);
    }
    return { kind: "failure", result: failure("idempotency_expired", "Idempotency key has expired.") };
  }
  if (
    row.response_kind !== "success" ||
    row.response_ref_type !== "session" ||
    row.response_ref_id !== expectedScopeSessionId ||
    row.response_envelope_json === null ||
    database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(expectedScopeSessionId) === undefined
  ) {
    return { kind: "failure", result: failure("reference_invalid", "Idempotent response reference is invalid.") };
  }
  return {
    kind: "replay",
    result: success(JSON.parse(row.response_envelope_json) as T, true),
  };
}

function completeIdempotency<T extends object>(
  database: DatabaseSync,
  key: string,
  scopeSessionId: string,
  operation: string,
  fingerprint: string,
  refType: "session",
  refId: string,
  value: T,
  now: number,
  retentionMs: number,
): void {
  const envelope = JSON.stringify(value);
  if (Buffer.byteLength(envelope) > 16 * 1024) throw new RangeError("Idempotency response envelope is too large.");
  database
    .prepare(
      `
    INSERT INTO idempotency_records (
      idempotency_key, scope_session_id, operation, request_fingerprint, record_state,
      response_kind, response_ref_type, response_ref_id, response_envelope_json,
      created_at, completed_at, expires_at
    ) VALUES (?, ?, ?, ?, 'completed', 'success', ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(key, scopeSessionId, operation, fingerprint, refType, refId, envelope, now, now, now + retentionMs);
}

function prepareSessionCreate(command: SessionCreateCommand): PreparedSessionCreate {
  const directoriesJson = JSON.stringify(command.session.allowedAdditionalDirectories);
  if (Buffer.byteLength(directoriesJson) > 4 * 1024 * 1024) throw invalidCommand();
  return {
    command,
    directoriesJson,
    fingerprint: fingerprint({
      operation: "session.create",
      session: {
        id: command.session.id,
        providerId: command.session.providerId,
        workspaceKey: command.session.workspaceKey,
        allowedAdditionalDirectories: command.session.allowedAdditionalDirectories,
        defaultCharacterId: command.session.defaultCharacterId,
        maxConcurrentChildRuns: command.session.maxConcurrentChildRuns,
      },
    }),
  };
}

function prepareSessionTransition(command: SessionTransitionCommand): PreparedSessionTransition {
  const operation = lifecycleOperation(command.expectedLifecycleStatus, command.targetLifecycleStatus);
  return {
    command,
    operation,
    fingerprint: fingerprint({
      operation,
      sessionId: command.sessionId,
      workspaceKey: command.workspaceKey,
      expectedLifecycleStatus: command.expectedLifecycleStatus,
      targetLifecycleStatus: command.targetLifecycleStatus,
    }),
  };
}

function decodeSessionCreate(payload: Readonly<Record<string, unknown>>): DecodeResult<SessionCreateCommand> {
  if (!hasExactKeys(payload, ["idempotencyKey", "session"]) || !isCanonicalUuid(payload.idempotencyKey)) {
    return decodeFailure();
  }
  if (!isPlainObject(payload.session)) return decodeFailure();
  const session = payload.session;
  if (
    !hasExactKeys(session, [
      "id",
      "providerId",
      "workspaceKey",
      "allowedAdditionalDirectories",
      "defaultCharacterId",
      "maxConcurrentChildRuns",
    ]) ||
    !isBoundedString(session.id, 1_024) ||
    !isBoundedString(session.providerId, 1_024) ||
    !isBoundedString(session.workspaceKey, 1_024) ||
    !isBoundedString(session.defaultCharacterId, 1_024) ||
    !Array.isArray(session.allowedAdditionalDirectories) ||
    session.allowedAdditionalDirectories.length > 1_024 ||
    !session.allowedAdditionalDirectories.every((value) => isBoundedString(value, 32_768)) ||
    !Number.isSafeInteger(session.maxConcurrentChildRuns) ||
    (session.maxConcurrentChildRuns as number) < 0
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as SessionCreateCommand };
}

function decodeSessionTransition(payload: Readonly<Record<string, unknown>>): DecodeResult<SessionTransitionCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "idempotencyKey",
      "expectedLifecycleStatus",
      "targetLifecycleStatus",
    ]) ||
    !isBoundedString(payload.sessionId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    (payload.expectedLifecycleStatus !== "active" && payload.expectedLifecycleStatus !== "archived") ||
    !isLifecycleStatus(payload.targetLifecycleStatus)
  ) {
    return decodeFailure();
  }
  try {
    lifecycleOperation(payload.expectedLifecycleStatus, payload.targetLifecycleStatus);
  } catch {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as SessionTransitionCommand };
}

function lifecycleOperation(expected: "active" | "archived", target: SessionLifecycleStatus): string {
  if (expected === "active" && target === "archived") return "session.archive";
  if (expected === "archived" && target === "active") return "session.unarchive";
  if ((expected === "active" || expected === "archived") && target === "closed") return "session.close";
  throw invalidCommand();
}

function hasNonTerminalRun(database: DatabaseSync, sessionId: string): boolean {
  return (
    database
      .prepare(
        `
        SELECT 1 FROM runs WHERE session_id = ?
          AND phase IN ('queued','starting','active','canceling','finalizing') LIMIT 1
      `,
      )
      .get(sessionId) !== undefined
  );
}

function canResumeProviderBinding(database: DatabaseSync, sessionId: string, providerId: string): boolean {
  const rows = database
    .prepare(
      `
      SELECT provider_id, binding_state FROM provider_bindings
      WHERE session_id = ? AND binding_state IN ('creating', 'active')
    `,
    )
    .all(sessionId) as unknown as readonly Readonly<{
    provider_id: string;
    binding_state: "creating" | "active";
  }>[];
  return (
    rows.length === 0 ||
    (rows.length === 1 && rows[0]?.binding_state === "active" && rows[0].provider_id === providerId)
  );
}

function runDecoded<T, R>(
  decoded: DecodeResult<T>,
  run: (value: T) => RepositoryCommandResult<R>,
): RepositoryCommandResult<R> {
  if (!decoded.ok) return failure("request_invalid", "Repository command is invalid.");
  try {
    return run(decoded.value);
  } catch (error) {
    if (error instanceof RepositoryCommandDecodeError) {
      return failure("request_invalid", "Repository command is invalid.");
    }
    throw error;
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function success<T>(value: T, replayed: boolean): RepositoryCommandResult<T> {
  return { ok: true, value, replayed };
}

function failure<T>(code: RepositoryCommandErrorCode, message: string, retryable = false): RepositoryCommandResult<T> {
  return { ok: false, error: { code, message, retryable }, replayed: false };
}

function readClock(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Repository clock returned an invalid timestamp.");
  return now;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function isLifecycleStatus(value: unknown): value is SessionLifecycleStatus {
  return value === "active" || value === "archived" || value === "closed";
}

function invalidCommand(): RepositoryCommandDecodeError {
  return new RepositoryCommandDecodeError();
}

function decodeFailure(): DecodeFailure {
  return { ok: false };
}

class RepositoryCommandDecodeError extends Error {}

type DecodeFailure = Readonly<{ ok: false }>;
type DecodeResult<T> = Readonly<{ ok: true; value: T }> | DecodeFailure;
type PreparedSessionCreate = Readonly<{
  command: SessionCreateCommand;
  directoriesJson: string;
  fingerprint: string;
}>;
type PreparedSessionTransition = Readonly<{
  command: SessionTransitionCommand;
  operation: string;
  fingerprint: string;
}>;
type IdempotencyRow = Readonly<{
  scope_session_id: string;
  operation: string;
  request_fingerprint: string;
  record_state: "in_progress" | "completed" | "expired";
  response_kind: "success" | "error" | null;
  response_ref_type: "run" | "session" | "delivery" | "interaction" | "none" | null;
  response_ref_id: string | null;
  response_envelope_json: string | null;
  expires_at: number | null;
}>;
