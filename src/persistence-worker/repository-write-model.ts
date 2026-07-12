import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import {
  REPOSITORY_WRITE_OPERATIONS,
  type NormalRunAdmissionCommand,
  type NormalRunAdmissionResult,
  type ProviderBindingResolutionCommand,
  type ProviderBindingResolutionResult,
  type RepositoryCommandErrorCode,
  type RepositoryCommandResult,
  type RunDispatchBeginCommand,
  type RunDispatchBeginResult,
  type RunDispatchResolutionCommand,
  type RunDispatchResolutionResult,
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

export type RepositoryWriteCapacityOptions = Readonly<{
  maxConcurrentRuns: number;
  maxConcurrentRunsPerProvider: number;
}>;

type WriteOptions = Readonly<{
  clock?: () => number;
  idempotencyRetentionMs?: number;
}> &
  Partial<RepositoryWriteCapacityOptions>;

export function createRepositoryWriteOperations(
  database: DatabaseSync,
  options: WriteOptions = {},
): ReadonlyMap<string, RepositoryWriteOperation> {
  const clock = options.clock ?? Date.now;
  const retentionMs = options.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
  const maxConcurrentRunsPerProvider = options.maxConcurrentRunsPerProvider ?? 4;
  const ephemeralBindingOwners = new Map<string, string>();
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    throw new RangeError("idempotencyRetentionMs must be a positive safe integer.");
  }
  if (
    !Number.isSafeInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1 ||
    !Number.isSafeInteger(maxConcurrentRunsPerProvider) ||
    maxConcurrentRunsPerProvider < 1
  ) {
    throw new RangeError("Run capacity limits must be positive safe integers.");
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
    [
      REPOSITORY_WRITE_OPERATIONS.runAdmit,
      write((payload) =>
        runDecoded(decodeNormalRunAdmission(payload), (command) => {
          const prepared = prepareNormalRunAdmission(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            admitNormalRun(database, prepared, now, retentionMs, maxConcurrentRuns, maxConcurrentRunsPerProvider),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.bindingResolve,
      write((payload) =>
        runDecoded(decodeProviderBindingResolution(payload), (command) => {
          const now = readClock(clock);
          const execution = executeWriteTransaction(database, () =>
            resolveProviderBinding(database, command, now, ephemeralBindingOwners),
          );
          if (execution.registerEphemeralOwner !== undefined) {
            ephemeralBindingOwners.set(
              execution.registerEphemeralOwner.bindingId,
              execution.registerEphemeralOwner.token,
            );
          }
          if (execution.removeEphemeralOwner) ephemeralBindingOwners.delete(command.bindingId);
          return execution.result;
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.dispatchBegin,
      write((payload) =>
        runDecoded(decodeRunDispatchBegin(payload), (command) => {
          const prepared = prepareRunDispatchBegin(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            beginRunDispatch(database, prepared, now, ephemeralBindingOwners),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.dispatchResolve,
      write((payload) =>
        runDecoded(decodeRunDispatchResolution(payload), (command) => {
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            resolveRunDispatch(database, command, now, ephemeralBindingOwners),
          );
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
    "session",
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
    "session",
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

function admitNormalRun(
  database: DatabaseSync,
  prepared: PreparedNormalRunAdmission,
  now: number,
  retentionMs: number,
  maxConcurrentRuns: number,
  maxConcurrentRunsPerProvider: number,
): RepositoryCommandResult<NormalRunAdmissionResult> {
  const command = prepared.command;
  const idempotency = checkIdempotency<NormalRunAdmissionResult>(
    database,
    command.idempotencyKey,
    "run.admit",
    prepared.fingerprint,
    command.sessionId,
    "run",
    command.run.id,
    now,
  );
  if (idempotency.kind !== "new") return idempotency.result;

  const session = database
    .prepare(
      `
      SELECT provider_id, lifecycle_status, updated_at, last_activity_at
      FROM sessions WHERE id = ? AND workspace_key = ?
    `,
    )
    .get(command.sessionId, command.workspaceKey) as
    | Readonly<{
        provider_id: string;
        lifecycle_status: SessionLifecycleStatus;
        updated_at: number;
        last_activity_at: number;
      }>
    | undefined;
  if (session === undefined) return failure("not_found", "Session was not found.");
  if (session.lifecycle_status !== "active") {
    return failure("lifecycle_conflict", "Run admission requires an active Session.");
  }
  if (command.run.executionSnapshot.providerId !== session.provider_id) {
    return failure("reference_invalid", "Run execution snapshot Provider does not match the Session.");
  }
  if (hasNonTerminalRun(database, command.sessionId)) {
    return failure("session_busy", "Session already has a non-terminal Run.");
  }
  if (!hasRunCapacity(database, session.provider_id, maxConcurrentRuns, maxConcurrentRunsPerProvider)) {
    return failure("capacity_exceeded", "Run capacity is exhausted.", true);
  }
  if (hasAdmissionIdentityConflict(database, command)) {
    return failure("lifecycle_conflict", "Run admission identity already exists.");
  }

  const binding = resolveAdmissionBinding(database, command, session.provider_id);
  if (!binding.ok) return binding.result;
  const messageOrdinal = nextOrdinal(database, "messages", "session_id", command.sessionId);
  const runOrdinal = nextOrdinal(database, "runs", "session_id", command.sessionId);

  database
    .prepare(
      `
      INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at)
      VALUES (?, ?, ?, 'user', ?, ?)
    `,
    )
    .run(command.message.id, command.sessionId, messageOrdinal, prepared.contentBlocksJson, now);
  database
    .prepare(
      `
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, phase, execution_snapshot_json,
        external_side_effect_state, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, 'queued', ?, 'none', ?, ?, 0)
    `,
    )
    .run(command.run.id, command.sessionId, runOrdinal, command.message.id, prepared.executionSnapshotJson, now, now);
  database
    .prepare(
      `
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state, created_at
      ) VALUES (?, ?, 1, ?, 'initial', 'preparing', ?)
    `,
    )
    .run(command.attemptId, command.run.id, binding.providerBindingId, now);
  if (command.bindingIntent.kind === "create") {
    const bindingOrdinal = nextOrdinal(database, "provider_bindings", "session_id", command.sessionId);
    database
      .prepare(
        `
        INSERT INTO provider_bindings (
          id, session_id, ordinal, provider_id, persistence_mode, binding_state,
          created_by_run_attempt_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)
      `,
      )
      .run(
        command.bindingIntent.bindingId,
        command.sessionId,
        bindingOrdinal,
        session.provider_id,
        command.bindingIntent.persistenceMode,
        command.attemptId,
        now,
      );
  }
  database
    .prepare(
      `
      INSERT INTO run_dispatches (
        run_attempt_id, dispatch_state, request_fingerprint, provider_idempotency_key, created_at
      ) VALUES (?, 'pending', ?, ?, ?)
    `,
    )
    .run(command.attemptId, prepared.dispatchFingerprint, command.dispatch.providerIdempotencyKey, now);

  const updatedAt = Math.max(now, session.updated_at);
  const lastActivityAt = Math.max(now, session.last_activity_at);
  database
    .prepare("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
    .run(updatedAt, lastActivityAt, command.sessionId);
  const value: NormalRunAdmissionResult = {
    sessionId: command.sessionId,
    messageId: command.message.id,
    runId: command.run.id,
    attemptId: command.attemptId,
    bindingId: command.bindingIntent.bindingId,
    bindingState: command.bindingIntent.kind === "create" ? "creating" : "active",
    dispatchState: "pending",
    admittedAt: now,
  };
  completeIdempotency(
    database,
    command.idempotencyKey,
    command.sessionId,
    "run.admit",
    prepared.fingerprint,
    "run",
    command.run.id,
    value,
    now,
    retentionMs,
  );
  return success(value, false);
}

function resolveProviderBinding(
  database: DatabaseSync,
  command: ProviderBindingResolutionCommand,
  now: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): ProviderBindingResolutionExecution {
  const row = readBindingResolutionRow(database, command);
  if (row === undefined) {
    return bindingResolutionFailure(failure("not_found", "Provider binding resolution target was not found."));
  }
  if (row.session_provider_id !== row.binding_provider_id) {
    return bindingResolutionFailure(
      failure("reference_invalid", "Provider binding does not match the Session Provider."),
    );
  }
  if (
    command.resolution.kind === "active" &&
    ((row.persistence_mode === "persistent" && command.resolution.ephemeralOwnerToken !== null) ||
      (row.persistence_mode === "ephemeral" && command.resolution.ephemeralOwnerToken === null))
  ) {
    return bindingResolutionFailure(failure("request_invalid", "Ephemeral ownership does not match persistence mode."));
  }
  const replay = replayBindingResolution(command, row, ephemeralBindingOwners);
  if (replay !== undefined) return replay;
  if (
    row.binding_state !== "creating" ||
    row.attempt_state !== "preparing" ||
    row.provider_binding_id !== null ||
    !isNonTerminalRunPhase(row.run_phase) ||
    row.dispatch_state !== "pending"
  ) {
    return bindingResolutionFailure(failure("lifecycle_conflict", "Provider binding resolution state changed."));
  }

  if (command.resolution.kind === "active") {
    const duplicate = database
      .prepare(
        `
        SELECT 1 FROM provider_bindings
        WHERE provider_id = ? AND external_conversation_id = ? AND id <> ?
      `,
      )
      .get(row.binding_provider_id, command.resolution.externalConversationId, command.bindingId);
    if (duplicate !== undefined) {
      return bindingResolutionFailure(failure("reference_invalid", "External conversation is already bound."));
    }
    const bindingUpdate = database
      .prepare(
        `
        UPDATE provider_bindings SET binding_state = 'active', external_conversation_id = ?
        WHERE id = ? AND binding_state = 'creating'
      `,
      )
      .run(command.resolution.externalConversationId, command.bindingId);
    const attemptUpdate = database
      .prepare(
        `
        UPDATE run_attempts SET provider_binding_id = ?
        WHERE id = ? AND run_id = ? AND attempt_state = 'preparing' AND provider_binding_id IS NULL
      `,
      )
      .run(command.bindingId, command.attemptId, command.runId);
    if (bindingUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
      return bindingResolutionFailure(failure("lifecycle_conflict", "Provider binding activation conflicted."));
    }
    const execution: ProviderBindingResolutionExecution = {
      result: success(
        bindingResolutionValue(
          command,
          row.run_phase,
          "active",
          "preparing",
          "pending",
          row.persistence_mode === "ephemeral" ? "registered" : "not_applicable",
        ),
        false,
      ),
      removeEphemeralOwner: false,
    };
    return row.persistence_mode === "ephemeral" && command.resolution.ephemeralOwnerToken !== null
      ? {
          ...execution,
          registerEphemeralOwner: { bindingId: command.bindingId, token: command.resolution.ephemeralOwnerToken },
        }
      : execution;
  }

  const bindingUpdate = database
    .prepare(
      `
      UPDATE provider_bindings SET binding_state = 'invalidated', invalidated_at = ?,
        invalidation_reason = 'conversation_start_ambiguous'
      WHERE id = ? AND binding_state = 'creating'
    `,
    )
    .run(now, command.bindingId);
  const attemptUpdate = database
    .prepare(
      `
      UPDATE run_attempts SET attempt_state = 'interrupted', failure_origin = ?, error_summary = ?, terminal_at = ?
      WHERE id = ? AND run_id = ? AND attempt_state = 'preparing' AND provider_binding_id IS NULL
    `,
    )
    .run(command.resolution.failureOrigin, command.resolution.errorSummary, now, command.attemptId, command.runId);
  const runUpdate = database
    .prepare(
      `
      UPDATE runs SET phase = 'interrupted', failure_origin = ?, error_summary = ?, terminal_at = ?,
        updated_at = MAX(updated_at, ?), version = version + 1
      WHERE id = ? AND session_id = ? AND phase IN ('queued','starting','active','canceling','finalizing')
    `,
    )
    .run(command.resolution.failureOrigin, command.resolution.errorSummary, now, now, command.runId, command.sessionId);
  const dispatchUpdate = database
    .prepare(
      `
      UPDATE run_dispatches SET dispatch_state = 'aborted', resolved_at = ?
      WHERE run_attempt_id = ? AND dispatch_state = 'pending'
    `,
    )
    .run(now, command.attemptId);
  if (
    bindingUpdate.changes !== 1 ||
    attemptUpdate.changes !== 1 ||
    runUpdate.changes !== 1 ||
    dispatchUpdate.changes !== 1
  ) {
    return bindingResolutionFailure(failure("lifecycle_conflict", "Ambiguous binding resolution conflicted."));
  }
  return {
    result: success(
      bindingResolutionValue(command, "interrupted", "invalidated", "interrupted", "aborted", "not_applicable"),
      false,
    ),
    removeEphemeralOwner: true,
  };
}

function beginRunDispatch(
  database: DatabaseSync,
  prepared: PreparedRunDispatchBegin,
  now: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<RunDispatchBeginResult> {
  const command = prepared.command;
  const row = readDispatchTransitionRow(database, command);
  if (row === undefined) return failure("not_found", "Run dispatch target was not found.");
  if (row.request_fingerprint !== prepared.requestFingerprint) {
    return failure("idempotency_conflict", "Provider request fingerprint does not match the admitted Dispatch.");
  }
  if (
    row.dispatch_state === "dispatching" &&
    row.attempt_state === "preparing" &&
    row.binding_state === "active" &&
    row.provider_binding_id === command.bindingId &&
    (row.run_phase === "starting" || row.run_phase === "canceling") &&
    row.dispatching_at !== null
  ) {
    return success(dispatchBeginValue(command, row.run_phase, row.dispatching_at, false), true);
  }
  const ownershipFailure = validateDispatchOwnership<RunDispatchBeginResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (ownershipFailure !== undefined) return ownershipFailure;
  if (
    row.dispatch_state !== "pending" ||
    row.attempt_state !== "preparing" ||
    row.binding_state !== "active" ||
    row.provider_binding_id !== command.bindingId ||
    (row.run_phase !== "queued" && row.run_phase !== "starting" && row.run_phase !== "canceling")
  ) {
    return failure("lifecycle_conflict", "Run dispatch Gate is not satisfied.");
  }
  const dispatchUpdate = database
    .prepare(
      `
      UPDATE run_dispatches SET dispatch_state = 'dispatching', dispatching_at = ?
      WHERE run_attempt_id = ? AND dispatch_state = 'pending'
    `,
    )
    .run(now, command.attemptId);
  const runUpdate = database
    .prepare(
      `
      UPDATE runs SET phase = CASE WHEN phase = 'queued' THEN 'starting' ELSE phase END,
        updated_at = MAX(updated_at, ?), version = version + 1
      WHERE id = ? AND session_id = ? AND phase IN ('queued','starting','canceling')
    `,
    )
    .run(now, command.runId, command.sessionId);
  if (dispatchUpdate.changes !== 1 || runUpdate.changes !== 1) {
    return failure("lifecycle_conflict", "Run dispatch begin conflicted.");
  }
  const runPhase = row.run_phase === "queued" ? "starting" : row.run_phase;
  return success(dispatchBeginValue(command, runPhase, now, true), false);
}

function resolveRunDispatch(
  database: DatabaseSync,
  command: RunDispatchResolutionCommand,
  now: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<RunDispatchResolutionResult> {
  const row = readDispatchTransitionRow(database, command);
  if (row === undefined) return failure("not_found", "Run dispatch target was not found.");
  const replay = replayRunDispatchResolution(command, row);
  if (replay !== undefined) return replay;
  const ownershipFailure = validateDispatchOwnership<RunDispatchResolutionResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (ownershipFailure !== undefined) return ownershipFailure;
  if (
    row.dispatch_state !== "dispatching" ||
    row.attempt_state !== "preparing" ||
    row.binding_state !== "active" ||
    row.provider_binding_id !== command.bindingId ||
    (row.run_phase !== "starting" && row.run_phase !== "canceling")
  ) {
    return failure("lifecycle_conflict", "Run dispatch resolution state changed.");
  }

  if (command.outcome.kind === "accepted") {
    const duplicate = database
      .prepare(
        `
        SELECT 1 FROM run_attempts
        WHERE provider_binding_id = ? AND external_execution_id = ? AND id <> ?
      `,
      )
      .get(command.bindingId, command.outcome.externalExecutionId, command.attemptId);
    if (duplicate !== undefined) {
      return failure("reference_invalid", "External execution is already bound to another Attempt.");
    }
    const attemptUpdate = database
      .prepare(
        `
        UPDATE run_attempts SET attempt_state = 'active', external_execution_id = ?, started_at = ?
        WHERE id = ? AND run_id = ? AND attempt_state = 'preparing' AND provider_binding_id = ?
      `,
      )
      .run(command.outcome.externalExecutionId, now, command.attemptId, command.runId, command.bindingId);
    const dispatchUpdate = database
      .prepare(
        `
        UPDATE run_dispatches SET dispatch_state = 'accepted', resolved_at = ?
        WHERE run_attempt_id = ? AND dispatch_state = 'dispatching'
      `,
      )
      .run(now, command.attemptId);
    const runUpdate = database
      .prepare(
        `
        UPDATE runs SET phase = CASE WHEN phase = 'starting' THEN 'active' ELSE phase END,
          started_at = COALESCE(started_at, ?), updated_at = MAX(updated_at, ?), version = version + 1
        WHERE id = ? AND session_id = ? AND phase IN ('starting','canceling')
      `,
      )
      .run(now, now, command.runId, command.sessionId);
    if (attemptUpdate.changes !== 1 || dispatchUpdate.changes !== 1 || runUpdate.changes !== 1) {
      return failure("lifecycle_conflict", "Accepted Run dispatch resolution conflicted.");
    }
    return success(dispatchResolutionValue(command, "accepted", command.outcome.externalExecutionId, now), false);
  }

  const dispatchUpdate = database
    .prepare(
      `
      UPDATE run_dispatches SET dispatch_state = ?, resolved_at = ?
      WHERE run_attempt_id = ? AND dispatch_state = 'dispatching'
    `,
    )
    .run(command.outcome.kind, now, command.attemptId);
  if (dispatchUpdate.changes !== 1) return failure("lifecycle_conflict", "Run dispatch resolution conflicted.");
  return success(dispatchResolutionValue(command, command.outcome.kind, null, now), false);
}

function checkIdempotency<T>(
  database: DatabaseSync,
  key: string,
  operation: string,
  fingerprint: string,
  expectedScopeSessionId: string,
  expectedRefType: "session" | "run",
  expectedRefId: string,
  now: number,
): Readonly<{ kind: "new" }> | Readonly<{ kind: "replay" | "failure"; result: RepositoryCommandResult<T> }> {
  const row = database.prepare("SELECT * FROM idempotency_records WHERE idempotency_key = ?").get(key) as
    IdempotencyRow | undefined;
  if (row === undefined) return { kind: "new" };
  const expired = row.record_state === "expired" || (row.expires_at !== null && row.expires_at <= now);
  if (expired && row.record_state === "completed") {
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
  if (expired) {
    return { kind: "failure", result: failure("idempotency_expired", "Idempotency key has expired.") };
  }
  if (
    row.response_kind !== "success" ||
    row.response_ref_type !== expectedRefType ||
    row.response_ref_id !== expectedRefId ||
    row.response_envelope_json === null ||
    !hasResponseReference(database, expectedRefType, expectedRefId, expectedScopeSessionId)
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
  refType: "session" | "run",
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
  const allowedAdditionalDirectories = normalizeAllowedAdditionalDirectories(
    command.session.allowedAdditionalDirectories,
  );
  const directoriesJson = JSON.stringify(allowedAdditionalDirectories);
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
        allowedAdditionalDirectories,
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

function prepareNormalRunAdmission(command: NormalRunAdmissionCommand): PreparedNormalRunAdmission {
  const contentBlocksJson = canonicalJsonString(command.message.contentBlocks);
  const executionSnapshotJson = canonicalJsonString(command.run.executionSnapshot);
  const providerRequestJson = canonicalJsonString(command.dispatch.providerRequest);
  if (
    Buffer.byteLength(contentBlocksJson) > 4 * 1024 * 1024 ||
    Buffer.byteLength(executionSnapshotJson) > 256 * 1024 ||
    Buffer.byteLength(providerRequestJson) > 256 * 1024
  ) {
    throw invalidCommand();
  }
  const dispatchFingerprint = fingerprintJson(providerRequestJson);
  return {
    command,
    contentBlocksJson,
    executionSnapshotJson,
    dispatchFingerprint,
    fingerprint: fingerprint({
      operation: "run.admit",
      sessionId: command.sessionId,
      workspaceKey: command.workspaceKey,
      message: { id: command.message.id, contentBlocks: JSON.parse(contentBlocksJson) },
      run: { id: command.run.id, executionSnapshot: JSON.parse(executionSnapshotJson) },
      attemptId: command.attemptId,
      bindingIntent:
        command.bindingIntent.kind === "create"
          ? {
              kind: "create",
              bindingId: command.bindingIntent.bindingId,
              persistenceMode: command.bindingIntent.persistenceMode,
            }
          : { kind: "reuse", bindingId: command.bindingIntent.bindingId },
      dispatch: {
        requestFingerprint: dispatchFingerprint,
        providerIdempotencyKey: command.dispatch.providerIdempotencyKey,
      },
    }),
  };
}

function prepareRunDispatchBegin(command: RunDispatchBeginCommand): PreparedRunDispatchBegin {
  const providerRequestJson = canonicalJsonString(command.providerRequest);
  if (Buffer.byteLength(providerRequestJson) > 256 * 1024) throw invalidCommand();
  return { command, requestFingerprint: fingerprintJson(providerRequestJson) };
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
    !isDenseBoundedStringArray(session.allowedAdditionalDirectories, 1_024, 32_768) ||
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

function decodeNormalRunAdmission(payload: Readonly<Record<string, unknown>>): DecodeResult<NormalRunAdmissionCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "idempotencyKey",
      "message",
      "run",
      "attemptId",
      "bindingIntent",
      "dispatch",
    ]) ||
    !isBoundedString(payload.sessionId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isBoundedString(payload.attemptId, 1_024) ||
    !isPlainObject(payload.message) ||
    !hasExactKeys(payload.message, ["id", "contentBlocks"]) ||
    !isBoundedString(payload.message.id, 1_024) ||
    !isDenseJsonArray(payload.message.contentBlocks, 10_000) ||
    !isPlainObject(payload.run) ||
    !hasExactKeys(payload.run, ["id", "executionSnapshot"]) ||
    !isBoundedString(payload.run.id, 1_024) ||
    !isRunExecutionSnapshot(payload.run.executionSnapshot) ||
    !isBindingIntent(payload.bindingIntent) ||
    !isPlainObject(payload.dispatch) ||
    !hasExactKeys(payload.dispatch, ["providerRequest", "providerIdempotencyKey"]) ||
    !isPlainObject(payload.dispatch.providerRequest) ||
    !isJsonValue(payload.dispatch.providerRequest) ||
    (payload.dispatch.providerIdempotencyKey !== null &&
      !isBoundedString(payload.dispatch.providerIdempotencyKey, 4_096))
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as NormalRunAdmissionCommand };
}

function decodeProviderBindingResolution(
  payload: Readonly<Record<string, unknown>>,
): DecodeResult<ProviderBindingResolutionCommand> {
  if (
    !hasExactKeys(payload, ["sessionId", "workspaceKey", "runId", "attemptId", "bindingId", "resolution"]) ||
    !isBoundedString(payload.sessionId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024) ||
    !isBoundedString(payload.runId, 1_024) ||
    !isBoundedString(payload.attemptId, 1_024) ||
    !isBoundedString(payload.bindingId, 1_024) ||
    !isPlainObject(payload.resolution)
  ) {
    return decodeFailure();
  }
  const resolution = payload.resolution;
  if (resolution.kind === "active") {
    if (
      !hasExactKeys(resolution, ["kind", "externalConversationId", "ephemeralOwnerToken"]) ||
      !isBoundedString(resolution.externalConversationId, 4_096) ||
      (resolution.ephemeralOwnerToken !== null && !isCanonicalUuid(resolution.ephemeralOwnerToken))
    ) {
      return decodeFailure();
    }
  } else if (
    resolution.kind !== "ambiguous" ||
    !hasExactKeys(resolution, ["kind", "failureOrigin", "errorSummary"]) ||
    (resolution.failureOrigin !== "transport" &&
      resolution.failureOrigin !== "process" &&
      resolution.failureOrigin !== "unknown") ||
    (resolution.errorSummary !== null && !isBoundedString(resolution.errorSummary, 1_024))
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as ProviderBindingResolutionCommand };
}

function decodeRunDispatchBegin(payload: Readonly<Record<string, unknown>>): DecodeResult<RunDispatchBeginCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "runId",
      "attemptId",
      "bindingId",
      "providerRequest",
      "ephemeralOwnerToken",
    ]) ||
    !hasDispatchScope(payload) ||
    !isPlainObject(payload.providerRequest) ||
    !isJsonValue(payload.providerRequest) ||
    (payload.ephemeralOwnerToken !== null && !isCanonicalUuid(payload.ephemeralOwnerToken))
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunDispatchBeginCommand };
}

function decodeRunDispatchResolution(
  payload: Readonly<Record<string, unknown>>,
): DecodeResult<RunDispatchResolutionCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "runId",
      "attemptId",
      "bindingId",
      "ephemeralOwnerToken",
      "outcome",
    ]) ||
    !hasDispatchScope(payload) ||
    (payload.ephemeralOwnerToken !== null && !isCanonicalUuid(payload.ephemeralOwnerToken)) ||
    !isPlainObject(payload.outcome)
  ) {
    return decodeFailure();
  }
  const outcome = payload.outcome;
  if (outcome.kind === "accepted") {
    if (
      !hasExactKeys(outcome, ["kind", "externalExecutionId"]) ||
      !isBoundedString(outcome.externalExecutionId, 4_096)
    ) {
      return decodeFailure();
    }
  } else if ((outcome.kind !== "rejected" && outcome.kind !== "ambiguous") || !hasExactKeys(outcome, ["kind"])) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunDispatchResolutionCommand };
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

function hasRunCapacity(
  database: DatabaseSync,
  providerId: string,
  maxConcurrentRuns: number,
  maxConcurrentRunsPerProvider: number,
): boolean {
  const nonTerminal = "('queued','starting','active','canceling','finalizing')";
  const total = database.prepare(`SELECT count(*) AS count FROM runs WHERE phase IN ${nonTerminal}`).get() as {
    count: number;
  };
  if (total.count >= maxConcurrentRuns) return false;
  const provider = database
    .prepare(
      `
      SELECT count(*) AS count FROM runs r
      JOIN sessions s ON s.id = r.session_id
      WHERE r.phase IN ${nonTerminal} AND s.provider_id = ?
    `,
    )
    .get(providerId) as { count: number };
  return provider.count < maxConcurrentRunsPerProvider;
}

function hasAdmissionIdentityConflict(database: DatabaseSync, command: NormalRunAdmissionCommand): boolean {
  return (
    database.prepare("SELECT 1 FROM messages WHERE id = ?").get(command.message.id) !== undefined ||
    database.prepare("SELECT 1 FROM runs WHERE id = ?").get(command.run.id) !== undefined ||
    database.prepare("SELECT 1 FROM run_attempts WHERE id = ?").get(command.attemptId) !== undefined ||
    (command.bindingIntent.kind === "create" &&
      database.prepare("SELECT 1 FROM provider_bindings WHERE id = ?").get(command.bindingIntent.bindingId) !==
        undefined)
  );
}

function readBindingResolutionRow(
  database: DatabaseSync,
  command: ProviderBindingResolutionCommand,
): BindingResolutionRow | undefined {
  return database
    .prepare(
      `
      SELECT
        b.provider_id AS binding_provider_id,
        b.persistence_mode,
        b.binding_state,
        b.external_conversation_id,
        b.invalidation_reason,
        a.provider_binding_id,
        a.attempt_state,
        a.failure_origin AS attempt_failure_origin,
        a.error_summary AS attempt_error_summary,
        r.phase AS run_phase,
        r.failure_origin AS run_failure_origin,
        r.error_summary AS run_error_summary,
        s.provider_id AS session_provider_id,
        d.dispatch_state
      FROM provider_bindings b
      JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
      JOIN runs r ON r.id = a.run_id
      JOIN sessions s ON s.id = b.session_id AND s.id = r.session_id
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      WHERE b.id = ? AND b.session_id = ? AND s.workspace_key = ?
        AND r.id = ? AND a.id = ?
    `,
    )
    .get(command.bindingId, command.sessionId, command.workspaceKey, command.runId, command.attemptId) as
    BindingResolutionRow | undefined;
}

function replayBindingResolution(
  command: ProviderBindingResolutionCommand,
  row: BindingResolutionRow,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): ProviderBindingResolutionExecution | undefined {
  if (
    command.resolution.kind === "active" &&
    row.binding_state === "active" &&
    row.external_conversation_id === command.resolution.externalConversationId &&
    row.provider_binding_id === command.bindingId &&
    row.attempt_state === "preparing" &&
    isNonTerminalRunPhase(row.run_phase) &&
    row.dispatch_state === "pending"
  ) {
    const ephemeralOwnership =
      row.persistence_mode === "persistent"
        ? "not_applicable"
        : ephemeralBindingOwners.get(command.bindingId) === command.resolution.ephemeralOwnerToken
          ? "registered"
          : "unavailable";
    return {
      result: success(
        bindingResolutionValue(command, row.run_phase, "active", "preparing", "pending", ephemeralOwnership),
        true,
      ),
      removeEphemeralOwner: false,
    };
  }
  if (
    command.resolution.kind === "ambiguous" &&
    row.binding_state === "invalidated" &&
    row.invalidation_reason === "conversation_start_ambiguous" &&
    row.attempt_state === "interrupted" &&
    row.attempt_failure_origin === command.resolution.failureOrigin &&
    row.attempt_error_summary === command.resolution.errorSummary &&
    row.run_phase === "interrupted" &&
    row.run_failure_origin === command.resolution.failureOrigin &&
    row.run_error_summary === command.resolution.errorSummary &&
    row.dispatch_state === "aborted"
  ) {
    return {
      result: success(
        bindingResolutionValue(command, "interrupted", "invalidated", "interrupted", "aborted", "not_applicable"),
        true,
      ),
      removeEphemeralOwner: true,
    };
  }
  return undefined;
}

function bindingResolutionValue(
  command: ProviderBindingResolutionCommand,
  runPhase: NonTerminalRunPhase | "interrupted",
  bindingState: "active" | "invalidated",
  attemptState: "preparing" | "interrupted",
  dispatchState: "pending" | "aborted",
  ephemeralOwnership: ProviderBindingResolutionResult["ephemeralOwnership"],
): ProviderBindingResolutionResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    bindingId: command.bindingId,
    bindingState,
    attemptState,
    runPhase,
    dispatchState,
    ephemeralOwnership,
  };
}

function bindingResolutionFailure(
  result: RepositoryCommandResult<ProviderBindingResolutionResult>,
): ProviderBindingResolutionExecution {
  return { result, removeEphemeralOwner: false };
}

function readDispatchTransitionRow(database: DatabaseSync, command: DispatchScope): DispatchTransitionRow | undefined {
  return database
    .prepare(
      `
      SELECT
        b.persistence_mode,
        b.binding_state,
        b.external_conversation_id,
        a.provider_binding_id,
        a.attempt_state,
        a.external_execution_id,
        r.phase AS run_phase,
        d.dispatch_state,
        d.request_fingerprint,
        d.dispatching_at,
        d.resolved_at
      FROM run_attempts a
      JOIN runs r ON r.id = a.run_id
      JOIN sessions s ON s.id = r.session_id
      JOIN provider_bindings b ON b.id = ? AND b.session_id = s.id AND b.provider_id = s.provider_id
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      WHERE s.id = ? AND s.workspace_key = ? AND r.id = ? AND a.id = ?
    `,
    )
    .get(command.bindingId, command.sessionId, command.workspaceKey, command.runId, command.attemptId) as
    DispatchTransitionRow | undefined;
}

function validateDispatchOwnership<T>(
  bindingId: string,
  ephemeralOwnerToken: string | null,
  row: DispatchTransitionRow,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<T> | undefined {
  if (row.binding_state !== "active" || row.external_conversation_id === null) {
    return failure("reference_invalid", "Run dispatch requires an active Provider binding.");
  }
  if (row.persistence_mode === "persistent") {
    return ephemeralOwnerToken === null
      ? undefined
      : failure("request_invalid", "Persistent Binding does not accept ephemeral ownership.");
  }
  return ephemeralOwnerToken !== null && ephemeralBindingOwners.get(bindingId) === ephemeralOwnerToken
    ? undefined
    : failure("reference_invalid", "Ephemeral Binding live ownership is unavailable.");
}

function dispatchBeginValue(
  command: RunDispatchBeginCommand,
  runPhase: "starting" | "canceling",
  dispatchingAt: number,
  sendAllowed: boolean,
): RunDispatchBeginResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    bindingId: command.bindingId,
    runPhase,
    dispatchState: "dispatching",
    dispatchingAt,
    sendAllowed,
  };
}

function replayRunDispatchResolution(
  command: RunDispatchResolutionCommand,
  row: DispatchTransitionRow,
): RepositoryCommandResult<RunDispatchResolutionResult> | undefined {
  if (
    command.outcome.kind === "accepted" &&
    row.dispatch_state === "accepted" &&
    row.resolved_at !== null &&
    row.external_execution_id === command.outcome.externalExecutionId &&
    row.provider_binding_id === command.bindingId
  ) {
    return success(
      dispatchResolutionValue(command, "accepted", command.outcome.externalExecutionId, row.resolved_at),
      true,
    );
  }
  if (
    (command.outcome.kind === "rejected" || command.outcome.kind === "ambiguous") &&
    row.dispatch_state === command.outcome.kind &&
    row.resolved_at !== null &&
    row.provider_binding_id === command.bindingId
  ) {
    return success(dispatchResolutionValue(command, command.outcome.kind, null, row.resolved_at), true);
  }
  return undefined;
}

function dispatchResolutionValue(
  command: RunDispatchResolutionCommand,
  dispatchState: "accepted" | "rejected" | "ambiguous",
  externalExecutionId: string | null,
  resolvedAt: number,
): RunDispatchResolutionResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    bindingId: command.bindingId,
    dispatchState,
    externalExecutionId,
    resolvedAt,
  };
}

function resolveAdmissionBinding(
  database: DatabaseSync,
  command: NormalRunAdmissionCommand,
  providerId: string,
): BindingResolution {
  const openBindings = database
    .prepare(
      `
      SELECT id, provider_id, persistence_mode, binding_state FROM provider_bindings
      WHERE session_id = ? AND binding_state IN ('creating', 'active')
    `,
    )
    .all(command.sessionId) as unknown as readonly Readonly<{
    id: string;
    provider_id: string;
    persistence_mode: "persistent" | "ephemeral";
    binding_state: "creating" | "active";
  }>[];
  if (command.bindingIntent.kind === "create") {
    if (openBindings.length !== 0) {
      return { ok: false, result: failure("reference_invalid", "Session already has an open Provider binding.") };
    }
    return { ok: true, providerBindingId: null };
  }
  const binding = openBindings.length === 1 ? openBindings[0] : undefined;
  if (
    binding === undefined ||
    binding.id !== command.bindingIntent.bindingId ||
    binding.provider_id !== providerId ||
    binding.persistence_mode !== "persistent" ||
    binding.binding_state !== "active"
  ) {
    return { ok: false, result: failure("reference_invalid", "Active Provider binding does not match.") };
  }
  return { ok: true, providerBindingId: binding.id };
}

function nextOrdinal(
  database: DatabaseSync,
  table: "messages" | "runs" | "provider_bindings",
  column: string,
  id: string,
) {
  const row = database
    .prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM ${table} WHERE ${column} = ?`)
    .get(id) as { ordinal: number };
  return row.ordinal;
}

function hasResponseReference(
  database: DatabaseSync,
  refType: "session" | "run",
  refId: string,
  scopeSessionId: string,
): boolean {
  if (refType === "session") {
    return refId === scopeSessionId && database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(refId) !== undefined;
  }
  return (
    database.prepare("SELECT 1 FROM runs WHERE id = ? AND session_id = ?").get(refId, scopeSessionId) !== undefined
  );
}

function canResumeProviderBinding(database: DatabaseSync, sessionId: string, providerId: string): boolean {
  const rows = database
    .prepare(
      `
      SELECT provider_id, persistence_mode, binding_state FROM provider_bindings
      WHERE session_id = ? AND binding_state IN ('creating', 'active')
    `,
    )
    .all(sessionId) as unknown as readonly Readonly<{
    provider_id: string;
    persistence_mode: "persistent" | "ephemeral";
    binding_state: "creating" | "active";
  }>[];
  return (
    rows.length === 0 ||
    (rows.length === 1 &&
      rows[0]?.binding_state === "active" &&
      rows[0].persistence_mode === "persistent" &&
      rows[0].provider_id === providerId)
  );
}

function normalizeAllowedAdditionalDirectories(directories: readonly string[]): readonly string[] {
  const normalized = directories.map((value) => {
    const pathApi = path.win32.isAbsolute(value) ? path.win32 : path.posix.isAbsolute(value) ? path.posix : undefined;
    if (pathApi === undefined) throw invalidCommand();
    const normalizedValue = pathApi.normalize(value);
    const comparisonKey = pathApi === path.win32 ? normalizedValue.toLocaleLowerCase("en-US") : normalizedValue;
    return { pathApi, value: normalizedValue, comparisonKey };
  });
  normalized.sort((left, right) =>
    left.pathApi === right.pathApi
      ? left.comparisonKey.length - right.comparisonKey.length || left.comparisonKey.localeCompare(right.comparisonKey)
      : left.pathApi === path.win32
        ? -1
        : 1,
  );
  const retained: typeof normalized = [];
  for (const candidate of normalized) {
    const redundant = retained.some((parent) => {
      if (parent.pathApi !== candidate.pathApi) return false;
      const relative = parent.pathApi.relative(parent.comparisonKey, candidate.comparisonKey);
      return (
        relative === "" ||
        (!parent.pathApi.isAbsolute(relative) && !relative.startsWith(`..${parent.pathApi.sep}`) && relative !== "..")
      );
    });
    if (!redundant) retained.push(candidate);
  }
  return retained.map(({ value }) => value);
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

function fingerprintJson(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value));
}

function toCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonicalJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, toCanonicalJson(value[key])]),
    );
  }
  throw invalidCommand();
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

function hasDispatchScope(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isBoundedString(value.sessionId, 1_024) &&
    isBoundedString(value.workspaceKey, 1_024) &&
    isBoundedString(value.runId, 1_024) &&
    isBoundedString(value.attemptId, 1_024) &&
    isBoundedString(value.bindingId, 1_024)
  );
}

function isDenseBoundedStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isBoundedString(value[index], maxLength)) return false;
  }
  return true;
}

function isDenseJsonArray(value: unknown, maxItems: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isJsonValue(value[index])) return false;
  }
  return true;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], depth + 1)) return false;
    }
    return true;
  }
  return isPlainObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isBindingIntent(value: unknown): value is NormalRunAdmissionCommand["bindingIntent"] {
  if (!isPlainObject(value) || !isBoundedString(value.bindingId, 1_024)) return false;
  if (value.kind === "reuse") return hasExactKeys(value, ["kind", "bindingId"]);
  return (
    value.kind === "create" &&
    hasExactKeys(value, ["kind", "bindingId", "persistenceMode"]) &&
    (value.persistenceMode === "persistent" || value.persistenceMode === "ephemeral")
  );
}

function isRunExecutionSnapshot(value: unknown): value is NormalRunAdmissionCommand["run"]["executionSnapshot"] {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["providerId", "model", "reasoning", "approval", "sandbox", "workspace", "character"]) &&
    isBoundedString(value.providerId, 1_024) &&
    isBoundedString(value.model, 1_024) &&
    isJsonValue(value.reasoning) &&
    isJsonValue(value.approval) &&
    isJsonValue(value.sandbox) &&
    isPlainObject(value.workspace) &&
    isJsonValue(value.workspace) &&
    (value.character === null || (isPlainObject(value.character) && isJsonValue(value.character)))
  );
}

function isLifecycleStatus(value: unknown): value is SessionLifecycleStatus {
  return value === "active" || value === "archived" || value === "closed";
}

function isNonTerminalRunPhase(value: string): value is NonTerminalRunPhase {
  return (
    value === "queued" || value === "starting" || value === "active" || value === "canceling" || value === "finalizing"
  );
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
type PreparedNormalRunAdmission = Readonly<{
  command: NormalRunAdmissionCommand;
  contentBlocksJson: string;
  executionSnapshotJson: string;
  dispatchFingerprint: string;
  fingerprint: string;
}>;
type PreparedRunDispatchBegin = Readonly<{
  command: RunDispatchBeginCommand;
  requestFingerprint: string;
}>;
type BindingResolution =
  | Readonly<{ ok: true; providerBindingId: string | null }>
  | Readonly<{ ok: false; result: RepositoryCommandResult<NormalRunAdmissionResult> }>;
type NonTerminalRunPhase = "queued" | "starting" | "active" | "canceling" | "finalizing";
type BindingResolutionRow = Readonly<{
  binding_provider_id: string;
  persistence_mode: "persistent" | "ephemeral";
  binding_state: "creating" | "active" | "invalidated" | "superseded";
  external_conversation_id: string | null;
  invalidation_reason: string | null;
  provider_binding_id: string | null;
  attempt_state: "preparing" | "active" | "succeeded" | "failed" | "interrupted";
  attempt_failure_origin: string | null;
  attempt_error_summary: string | null;
  run_phase: NonTerminalRunPhase | "completed" | "failed" | "canceled" | "interrupted";
  run_failure_origin: string | null;
  run_error_summary: string | null;
  session_provider_id: string;
  dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
}>;
type ProviderBindingResolutionExecution = Readonly<{
  result: RepositoryCommandResult<ProviderBindingResolutionResult>;
  registerEphemeralOwner?: Readonly<{ bindingId: string; token: string }>;
  removeEphemeralOwner: boolean;
}>;
type DispatchScope = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  bindingId: string;
}>;
type DispatchTransitionRow = Readonly<{
  persistence_mode: "persistent" | "ephemeral";
  binding_state: "creating" | "active" | "invalidated" | "superseded";
  external_conversation_id: string | null;
  provider_binding_id: string | null;
  attempt_state: "preparing" | "active" | "succeeded" | "failed" | "interrupted";
  external_execution_id: string | null;
  run_phase: NonTerminalRunPhase | "completed" | "failed" | "canceled" | "interrupted";
  dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
  request_fingerprint: string;
  dispatching_at: number | null;
  resolved_at: number | null;
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
