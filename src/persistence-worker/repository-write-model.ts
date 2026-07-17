import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS,
  normalizeAllowedAdditionalDirectories,
} from "../shared/allowed-additional-directories.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import { MAX_SESSION_CONCURRENT_CHILD_RUNS } from "../shared/session-limits.js";
import {
  REPOSITORY_WRITE_OPERATIONS,
  type ChildResultCollectCommand,
  type ChildResultCollectResult,
  type ChildStartCommand,
  type ChildStartResult,
  type NormalRunAdmissionCommand,
  type NormalRunAdmissionResult,
  type ProviderBindingResolutionCommand,
  type ProviderBindingResolutionResult,
  type RepositoryCapacityExceededDetails,
  type RepositoryCommandErrorCode,
  type RepositoryCommandResult,
  type RetryRunAdmissionCommand,
  type RetryRunAdmissionResult,
  type RunAdmissionBindingIntent,
  type RunAdmissionDispatch,
  type RunAdmissionDraft,
  type RunDispatchBeginCommand,
  type RunDispatchBeginResult,
  type RunDispatchResolutionCommand,
  type RunDispatchResolutionResult,
  type RunInputAdmissionCommand,
  type RunInputAdmissionResult,
  type RunInputBeginCommand,
  type RunInputBeginResult,
  type RunInputResolutionCode,
  type RunInputResolutionCommand,
  type RunInputResolutionResult,
  type RunOutputAppendCommand,
  type RunOutputAppendResult,
  type RunOutputDraft,
  type RunOutputPayloadCommand,
  type RunOutputResolvePendingCommand,
  type RunOutputResolvePendingResult,
  type RunTerminalCommand,
  type RunTerminalOutputDraft,
  type RunTerminalPreDispatchResolution,
  type RunTerminalResult,
  type SessionCreateCommand,
  type SessionCreateResult,
  type SessionDeleteSubtreeCommand,
  type SessionDeleteSubtreeResult,
  type SessionDeletionCleanupCompleteCommand,
  type SessionDeletionCleanupCompleteResult,
  type StartupRepairResult,
  type SessionLifecycleStatus,
  type SessionTransitionCommand,
  type SessionTransitionResult,
} from "../shared/repository-write-model.js";
import { executeWriteTransaction } from "./request-executor.js";

export const DEFAULT_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const RUN_OUTPUT_PAYLOAD_LIMITS = {
  itemBytes: 16 * 1024 * 1024,
  runBytes: 64 * 1024 * 1024,
  sessionBytes: 256 * 1024 * 1024,
  appBytes: 1024 * 1024 * 1024,
  minimumReserveBytes: 1024 * 1024 * 1024,
} as const;
export const RUN_OUTPUT_SQLITE_WRITE_MARGIN_BYTES = 64 * 1024;

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
  databasePath?: string;
  diskCapacity?: () => Readonly<{ availableBytes: number; totalBytes: number }>;
  payloadLimits?: Partial<typeof RUN_OUTPUT_PAYLOAD_LIMITS>;
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
  const payloadLimits = resolvePayloadLimits(options.payloadLimits);
  const diskCapacity = options.diskCapacity ?? createDiskCapacityProbe(options.databasePath);
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
      REPOSITORY_WRITE_OPERATIONS.sessionDeleteSubtree,
      write((payload) =>
        runDecoded(decodeSessionDeleteSubtree(payload), (command) => {
          const now = readClock(clock);
          return executeWriteTransaction(database, () => deleteSessionSubtree(database, command, now));
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.sessionDeletionCleanupComplete,
      write((payload) =>
        runDecoded(decodeSessionDeletionCleanupComplete(payload), (command) => {
          const now = readClock(clock);
          return executeWriteTransaction(database, () => completeSessionDeletionCleanup(database, command, now));
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.startupRepair,
      write((payload) =>
        runDecoded(decodeStartupRepair(payload), () => {
          const now = readClock(clock);
          return executeWriteTransaction(database, () => repairStartupState(database, now));
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
      REPOSITORY_WRITE_OPERATIONS.runRetry,
      write((payload) =>
        runDecoded(decodeRetryRunAdmission(payload), (command) => {
          const prepared = prepareRetryRunAdmission(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            admitRetryRun(database, prepared, now, retentionMs, maxConcurrentRuns, maxConcurrentRunsPerProvider),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.childStart,
      write((payload) =>
        runDecoded(decodeChildStart(payload), (command) => {
          const prepared = prepareChildStart(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            startChild(database, prepared, now, retentionMs, maxConcurrentRuns, maxConcurrentRunsPerProvider),
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
    [
      REPOSITORY_WRITE_OPERATIONS.runInputAdmit,
      write((payload) =>
        runDecoded(decodeRunInputAdmission(payload), (command) => {
          const prepared = prepareRunInputAdmission(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            admitRunInput(database, prepared, now, retentionMs, ephemeralBindingOwners),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.runInputBegin,
      write((payload) =>
        runDecoded(decodeRunInputBegin(payload), (command) => {
          const now = readClock(clock);
          return executeWriteTransaction(database, () => beginRunInput(database, command, now, ephemeralBindingOwners));
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.runInputResolve,
      write((payload) =>
        runDecoded(decodeRunInputResolution(payload), (command) => {
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            resolveRunInput(database, command, now, ephemeralBindingOwners),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.runOutputAppend,
      write((payload) =>
        runDecoded(decodeRunOutputAppend(payload), (command) => {
          const prepared = prepareRunOutputAppend(command);
          const now = readClock(clock);
          return executeWriteTransaction(database, () =>
            appendRunOutput(database, prepared, now, payloadLimits, diskCapacity),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.runOutputResolvePending,
      write((payload) =>
        runDecoded(decodeRunOutputResolvePending(payload), (command) => {
          const prepared = prepareRunOutputResolvePending(command);
          const now = readClock(clock);
          return executeRepositoryTransaction(database, () =>
            resolvePendingRunOutput(database, prepared, now, payloadLimits, diskCapacity),
          );
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.runTerminal,
      write((payload) =>
        runDecoded(decodeRunTerminal(payload), (command) => {
          const prepared = prepareRunTerminal(command);
          const now = readClock(clock);
          const ephemeralBindingId = readTerminalEphemeralBindingId(database, command);
          const result = executeRepositoryTransaction(database, () => terminalRun(database, prepared, now));
          if (result.ok && ephemeralBindingId !== undefined) ephemeralBindingOwners.delete(ephemeralBindingId);
          return result;
        }),
      ),
    ],
    [
      REPOSITORY_WRITE_OPERATIONS.childResultCollect,
      write((payload) =>
        runDecoded(decodeChildResultCollect(payload), (command) => {
          const prepared = prepareChildResultCollect(command);
          const now = readClock(clock);
          return executeRepositoryTransaction(database, () => collectChildResult(database, prepared, now, retentionMs));
        }),
      ),
    ],
  ]);
}

function executeRepositoryTransaction<T>(database: DatabaseSync, operation: () => RepositorySynchronousResult<T>): T {
  try {
    return executeWriteTransaction(database, operation);
  } catch (error) {
    if (error instanceof RepositoryTransactionRollback) return error.result as T;
    throw error;
  }
}

function repairStartupState(database: DatabaseSync, now: number): RepositoryCommandResult<StartupRepairResult> {
  const expiredIdempotencyRecords = Number(
    database
      .prepare(
        `
      UPDATE idempotency_records
      SET record_state = 'expired', response_kind = NULL, response_ref_type = NULL,
          response_ref_id = NULL, response_envelope_json = NULL
      WHERE record_state = 'completed' AND expires_at <= ?
    `,
      )
      .run(now).changes,
  );
  database
    .prepare(
      `
      UPDATE runs
      SET external_side_effect_state = 'unknown', updated_at = MAX(updated_at, ?), version = version + 1
      WHERE external_side_effect_state = 'none'
        AND id IN (
          SELECT a.run_id
          FROM run_attempts a
          JOIN runs r ON r.id = a.run_id
          JOIN sessions s ON s.id = r.session_id
          JOIN provider_bindings b ON b.created_by_run_attempt_id = a.id
            AND b.session_id = r.session_id AND b.provider_id = s.provider_id
          WHERE b.binding_state = 'creating'
            AND (r.phase IN ('canceling', 'completed', 'failed', 'canceled', 'interrupted')
              OR a.attempt_state IN ('succeeded', 'failed', 'interrupted'))
        )
    `,
    )
    .run(now);
  const invalidatedBindings = Number(
    database
      .prepare(
        `
      UPDATE provider_bindings
      SET binding_state = 'invalidated', invalidated_at = ?,
          invalidation_reason = 'conversation_start_ambiguous'
      WHERE binding_state = 'creating' AND EXISTS (
        SELECT 1
        FROM run_attempts a
        JOIN runs r ON r.id = a.run_id
        JOIN sessions s ON s.id = r.session_id
        WHERE a.id = provider_bindings.created_by_run_attempt_id
          AND provider_bindings.session_id = r.session_id
          AND provider_bindings.provider_id = s.provider_id
          AND (r.phase IN ('canceling', 'completed', 'failed', 'canceled', 'interrupted')
            OR a.attempt_state IN ('succeeded', 'failed', 'interrupted'))
      )
    `,
      )
      .run(now).changes,
  );
  const abortedDispatches = Number(
    database
      .prepare(
        `
      UPDATE run_dispatches
      SET dispatch_state = 'aborted', resolved_at = ?
      WHERE dispatch_state = 'pending' AND run_attempt_id IN (
        SELECT a.id
        FROM run_attempts a
        JOIN runs r ON r.id = a.run_id
        JOIN sessions s ON s.id = r.session_id
        JOIN provider_bindings b
          ON (b.id = a.provider_binding_id
            OR (a.provider_binding_id IS NULL AND b.created_by_run_attempt_id = a.id))
          AND b.session_id = r.session_id AND b.provider_id = s.provider_id
          AND EXISTS (
            SELECT 1
            FROM run_attempts creator_a
            JOIN runs creator_r ON creator_r.id = creator_a.run_id
            WHERE creator_a.id = b.created_by_run_attempt_id
              AND creator_r.session_id = r.session_id
          )
          AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
        WHERE (r.phase IN ('canceling', 'completed', 'failed', 'canceled', 'interrupted')
          OR a.attempt_state IN ('succeeded', 'failed', 'interrupted')
          OR b.binding_state IN ('invalidated', 'superseded'))
      )
    `,
      )
      .run(now).changes,
  );
  const abortedInputDeliveries = Number(
    database
      .prepare(
        `
      UPDATE run_input_deliveries
      SET delivery_state = 'aborted', resolution_code = 'run_terminal_not_sent', resolved_at = ?
      WHERE delivery_state = 'pending'
        AND run_id IN (SELECT id FROM runs WHERE phase IN ('completed', 'failed', 'canceled', 'interrupted'))
        AND EXISTS (
          SELECT 1
          FROM run_attempts a
          JOIN runs r ON r.id = a.run_id
          JOIN messages m ON m.id = run_input_deliveries.message_id AND m.session_id = r.session_id
          WHERE a.id = run_input_deliveries.run_attempt_id AND a.run_id = run_input_deliveries.run_id
        )
    `,
      )
      .run(now).changes,
  );
  const ambiguousInputDeliveries = Number(
    database
      .prepare(
        `
      UPDATE run_input_deliveries
      SET delivery_state = 'ambiguous', resolution_code = 'process_unknown', resolved_at = ?
      WHERE delivery_state = 'dispatching'
        AND run_id IN (SELECT id FROM runs WHERE phase IN ('completed', 'failed', 'canceled', 'interrupted'))
        AND EXISTS (
          SELECT 1
          FROM run_attempts a
          JOIN runs r ON r.id = a.run_id
          JOIN messages m ON m.id = run_input_deliveries.message_id AND m.session_id = r.session_id
          WHERE a.id = run_input_deliveries.run_attempt_id AND a.run_id = run_input_deliveries.run_id
        )
    `,
      )
      .run(now).changes,
  );
  const repairedDelegations = Number(
    database
      .prepare(
        `
        UPDATE delegations
        SET latest_child_run_id = (
              SELECT r.id
              FROM session_relations sr JOIN runs r ON r.session_id = sr.child_session_id
              WHERE sr.id = delegations.session_relation_id
              ORDER BY r.ordinal DESC LIMIT 1
            ),
            latest_instruction_message_id = (
              SELECT r.initiating_message_id
              FROM session_relations sr JOIN runs r ON r.session_id = sr.child_session_id
              WHERE sr.id = delegations.session_relation_id
              ORDER BY r.ordinal DESC LIMIT 1
            ),
            updated_at = ?, version = version + 1
        WHERE EXISTS (
          SELECT 1
          FROM session_relations sr JOIN runs r ON r.session_id = sr.child_session_id
          WHERE sr.id = delegations.session_relation_id
          ORDER BY r.ordinal DESC LIMIT 1
        ) AND (
          latest_child_run_id <> (
            SELECT r.id
            FROM session_relations sr JOIN runs r ON r.session_id = sr.child_session_id
            WHERE sr.id = delegations.session_relation_id
            ORDER BY r.ordinal DESC LIMIT 1
          )
          OR latest_instruction_message_id <> (
            SELECT r.initiating_message_id
            FROM session_relations sr JOIN runs r ON r.session_id = sr.child_session_id
            WHERE sr.id = delegations.session_relation_id
            ORDER BY r.ordinal DESC LIMIT 1
          )
        )
      `,
      )
      .run(now).changes,
  );
  const availableChildResults = Number(
    database
      .prepare(
        `
      UPDATE child_result_deliveries
      SET availability_state = 'available',
          terminal_phase_snapshot = (SELECT phase FROM runs WHERE id = child_run_id),
          available_at = (SELECT terminal_at FROM runs WHERE id = child_run_id),
          updated_at = ?, version = version + 1
      WHERE availability_state = 'pending'
        AND child_run_id IN (
          SELECT id FROM runs WHERE phase IN ('completed', 'failed', 'canceled', 'interrupted')
        )
        AND EXISTS (
          SELECT 1
          FROM runs r
          JOIN delegations g ON g.id = child_result_deliveries.delegation_id
          JOIN session_relations sr ON sr.id = g.session_relation_id
          WHERE r.id = child_result_deliveries.child_run_id
            AND sr.child_session_id = r.session_id
        )
    `,
      )
      .run(now).changes,
  );
  const storedOutputPayloads = Number(
    database
      .prepare(
        `
      UPDATE run_output_items
      SET payload_state = 'stored', stored_payload_id = id
      WHERE payload_state = 'pending'
        AND run_id IN (SELECT id FROM runs WHERE phase IN ('completed', 'failed', 'canceled', 'interrupted'))
        AND EXISTS (SELECT 1 FROM run_output_payloads p WHERE p.output_item_id = run_output_items.id)
    `,
      )
      .run().changes,
  );
  const omittedOutputPayloads = Number(
    database
      .prepare(
        `
      UPDATE run_output_items
      SET payload_state = 'omitted_persistence'
      WHERE payload_state = 'pending'
        AND run_id IN (SELECT id FROM runs WHERE phase IN ('completed', 'failed', 'canceled', 'interrupted'))
        AND NOT EXISTS (SELECT 1 FROM run_output_payloads p WHERE p.output_item_id = run_output_items.id)
    `,
      )
      .run().changes,
  );

  return success(
    {
      repairedAt: now,
      repaired: {
        expiredIdempotencyRecords,
        invalidatedBindings,
        abortedDispatches,
        settledInputDeliveries: abortedInputDeliveries + ambiguousInputDeliveries,
        availableChildResults,
        repairedDelegations,
        storedOutputPayloads,
        omittedOutputPayloads,
      },
      inspection: inspectStartupState(database),
    },
    false,
  );
}

function inspectStartupState(database: DatabaseSync): StartupRepairResult["inspection"] {
  return {
    safeDispatchCandidates: scalarCount(
      database,
      `
        SELECT COUNT(*) AS count
        FROM run_dispatches d
        JOIN run_attempts a ON a.id = d.run_attempt_id
        JOIN runs r ON r.id = a.run_id
        JOIN sessions s ON s.id = r.session_id
        JOIN provider_bindings b ON b.id = a.provider_binding_id
          AND b.session_id = r.session_id AND b.provider_id = s.provider_id
        JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
        JOIN runs creator_r ON creator_r.id = creator_a.run_id AND creator_r.session_id = r.session_id
        WHERE d.dispatch_state = 'pending' AND r.phase IN ('queued', 'starting')
          AND a.attempt_state = 'preparing' AND b.binding_state = 'active'
          AND b.persistence_mode = 'persistent'
      `,
    ),
    providerBindingCandidates: scalarCount(
      database,
      `
        SELECT COUNT(*) AS count
        FROM provider_bindings b
        JOIN run_attempts a ON a.id = b.created_by_run_attempt_id
        JOIN runs r ON r.id = a.run_id
        JOIN sessions s ON s.id = r.session_id
        WHERE b.binding_state = 'creating'
          AND b.session_id = r.session_id AND b.provider_id = s.provider_id
      `,
    ),
    providerDispatchCandidates: scalarCount(
      database,
      `
        SELECT COUNT(*) AS count
        FROM run_dispatches d
        JOIN run_attempts a ON a.id = d.run_attempt_id
        JOIN runs r ON r.id = a.run_id
        JOIN sessions s ON s.id = r.session_id
        JOIN provider_bindings b ON b.id = a.provider_binding_id
          AND b.session_id = r.session_id AND b.provider_id = s.provider_id
        JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
        JOIN runs creator_r ON creator_r.id = creator_a.run_id AND creator_r.session_id = r.session_id
        WHERE d.dispatch_state IN ('dispatching', 'ambiguous')
          AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      `,
    ),
    ephemeralResumeBlockedRuns: scalarCount(
      database,
      `
        SELECT COUNT(DISTINCT r.id) AS count
        FROM runs r
        JOIN run_attempts a ON a.run_id = r.id AND a.attempt_state IN ('preparing', 'active')
        JOIN sessions s ON s.id = r.session_id
        JOIN provider_bindings b ON b.id = a.provider_binding_id
          AND b.session_id = r.session_id AND b.provider_id = s.provider_id
          AND b.created_by_run_attempt_id = a.id
        WHERE r.phase IN ('queued', 'starting', 'active', 'canceling', 'finalizing')
          AND b.binding_state = 'active' AND b.persistence_mode = 'ephemeral'
      `,
    ),
    diagnosticRuns: scalarCount(
      database,
      `
        SELECT COUNT(*) AS count FROM runs r
        WHERE r.phase IN ('queued', 'starting', 'active', 'canceling', 'finalizing')
          AND (SELECT COUNT(*) FROM run_attempts a
               WHERE a.run_id = r.id AND a.attempt_state IN ('preparing', 'active')) <> 1
      `,
    ),
    diagnosticIdempotencyRecords: scalarCount(
      database,
      `
        SELECT COUNT(*) AS count
        FROM idempotency_records i
        WHERE i.record_state = 'in_progress' OR (i.record_state = 'completed' AND (
          (i.response_ref_type = 'session' AND NOT EXISTS (
            SELECT 1 FROM sessions s WHERE s.id = i.response_ref_id AND s.id = i.scope_session_id
          ))
          OR (i.response_ref_type = 'run' AND NOT EXISTS (
            SELECT 1 FROM runs r WHERE r.id = i.response_ref_id AND r.session_id = i.scope_session_id
          ))
          OR (i.response_ref_type = 'delivery' AND (
            (i.operation = 'repository.child.start' AND NOT EXISTS (
              SELECT 1 FROM child_result_deliveries d
              JOIN delegations g ON g.id = d.delegation_id
              JOIN session_relations sr ON sr.id = g.session_relation_id
              WHERE d.id = i.response_ref_id AND sr.parent_session_id = i.scope_session_id
            ))
            OR (i.operation = 'repository.child-result.collect' AND NOT EXISTS (
              SELECT 1 FROM child_result_deliveries d
              JOIN runs cr ON cr.id = d.child_run_id
              WHERE d.id = i.response_ref_id AND cr.session_id = i.scope_session_id
            ))
            OR (i.operation = 'run.input.admit' AND NOT EXISTS (
              SELECT 1 FROM run_input_deliveries rd
              JOIN messages m ON m.id = rd.message_id
              WHERE rd.message_id = i.response_ref_id AND m.session_id = i.scope_session_id
            ))
            OR i.operation NOT IN (
              'repository.child.start', 'repository.child-result.collect', 'run.input.admit'
            )
          ))
          OR (i.response_ref_type = 'interaction' AND NOT EXISTS (
            SELECT 1 FROM run_input_deliveries rd
            JOIN messages m ON m.id = rd.message_id
            WHERE rd.message_id = i.response_ref_id AND m.session_id = i.scope_session_id
          ))
        ))
      `,
    ),
    diagnosticChildResults: scalarCount(
      database,
      `
        SELECT COUNT(*) AS count
        FROM child_result_deliveries d
        JOIN runs r ON r.id = d.child_run_id
        JOIN delegations g ON g.id = d.delegation_id
        JOIN session_relations sr ON sr.id = g.session_relation_id
        WHERE sr.child_session_id <> r.session_id
          OR (d.availability_state = 'available' AND (
            r.phase NOT IN ('completed', 'failed', 'canceled', 'interrupted')
            OR d.terminal_phase_snapshot IS NULL
            OR d.terminal_phase_snapshot <> r.phase
          ))
      `,
    ),
  };
}

function scalarCount(database: DatabaseSync, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}

function rollbackWith<T>(result: RepositoryCommandResult<T>): never {
  throw new RepositoryTransactionRollback(result);
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

function deleteSessionSubtree(
  database: DatabaseSync,
  command: SessionDeleteSubtreeCommand,
  now: number,
): RepositoryCommandResult<SessionDeleteSubtreeResult> {
  const requestFingerprint = fingerprintJson(
    canonicalJsonString({ sessionId: command.sessionId, workspaceKey: command.workspaceKey }),
  );
  const existing = database
    .prepare(
      `
      SELECT workspace_key, root_session_id, request_fingerprint, deleted_session_count
      FROM session_deletion_manifests WHERE deletion_id = ?
    `,
    )
    .get(command.deletionId) as
    | {
        workspace_key: string;
        root_session_id: string;
        request_fingerprint: string;
        deleted_session_count: number;
      }
    | undefined;
  if (existing !== undefined) {
    if (
      existing.workspace_key !== command.workspaceKey ||
      existing.root_session_id !== command.sessionId ||
      existing.request_fingerprint !== requestFingerprint
    ) {
      return failure("idempotency_conflict", "Session deletion ID was reused for a different request.");
    }
    return success(
      {
        cleanupToken: command.deletionId,
        deletedSessionCount: existing.deleted_session_count,
        localOnly: true,
      },
      true,
    );
  }
  const completed = database
    .prepare(
      `
      SELECT workspace_key, request_fingerprint, deleted_session_count
      FROM session_deletion_completion_tombstones WHERE deletion_id = ?
    `,
    )
    .get(command.deletionId) as
    | {
        workspace_key: string;
        request_fingerprint: string;
        deleted_session_count: number;
      }
    | undefined;
  if (completed !== undefined) {
    if (completed.workspace_key !== command.workspaceKey || completed.request_fingerprint !== requestFingerprint) {
      return failure("idempotency_conflict", "Session deletion ID was reused for a different request.");
    }
    return success(
      {
        cleanupToken: command.deletionId,
        deletedSessionCount: completed.deleted_session_count,
        localOnly: true,
      },
      true,
    );
  }
  const subtree = database
    .prepare(
      `
      WITH RECURSIVE subtree(id, workspace_key) AS (
        SELECT id, workspace_key FROM sessions WHERE id = ? AND workspace_key = ?
        UNION
        SELECT child.id, child.workspace_key
        FROM session_relations sr
        JOIN subtree parent ON parent.id = sr.parent_session_id
        JOIN sessions child ON child.id = sr.child_session_id
      )
      SELECT id, workspace_key FROM subtree ORDER BY id
    `,
    )
    .all(command.sessionId, command.workspaceKey) as Array<{ id: string; workspace_key: string }>;
  if (subtree.length === 0) return failure("not_found", "Session subtree root was not found.");
  if (subtree.some((row) => row.workspace_key !== command.workspaceKey)) {
    return failure("reference_invalid", "Session subtree crosses a workspace boundary.");
  }

  const sessionIds = subtree.map((row) => row.id);
  const sessionIdsJson = JSON.stringify(sessionIds);
  const busy = database
    .prepare(
      `
      SELECT 1 FROM runs
      WHERE session_id IN (SELECT value FROM json_each(?))
        AND phase IN ('queued','starting','active','canceling','finalizing')
      LIMIT 1
    `,
    )
    .get(sessionIdsJson);
  if (busy !== undefined) return failure("session_busy", "Session subtree has a non-terminal Run.");

  const runRows = database
    .prepare(
      `
      SELECT id, session_id, ordinal FROM runs
      WHERE session_id IN (SELECT value FROM json_each(?))
      ORDER BY session_id, ordinal DESC
    `,
    )
    .all(sessionIdsJson) as Array<{ id: string; session_id: string; ordinal: number }>;
  const runIds = runRows.map((row) => row.id);
  const runIdsJson = JSON.stringify(runIds);
  const relationIds = selectStringIds(
    database,
    `
      SELECT id FROM session_relations
      WHERE parent_session_id IN (SELECT value FROM json_each(?))
        OR child_session_id IN (SELECT value FROM json_each(?))
        OR orchestration_root_session_id IN (SELECT value FROM json_each(?))
    `,
    sessionIdsJson,
    sessionIdsJson,
    sessionIdsJson,
  );
  const relationIdsJson = JSON.stringify(relationIds);
  const delegationIds = selectStringIds(
    database,
    "SELECT id FROM delegations WHERE session_relation_id IN (SELECT value FROM json_each(?))",
    relationIdsJson,
  );
  const delegationIdsJson = JSON.stringify(delegationIds);
  const deliveryIds = selectStringIds(
    database,
    "SELECT id FROM child_result_deliveries WHERE delegation_id IN (SELECT value FROM json_each(?))",
    delegationIdsJson,
  );
  const deliveryIdsJson = JSON.stringify(deliveryIds);

  database
    .prepare(
      `
      INSERT INTO session_deletion_manifests (
        deletion_id, workspace_key, root_session_id, request_fingerprint, deleted_session_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(command.deletionId, command.workspaceKey, command.sessionId, requestFingerprint, sessionIds.length, now);
  const insertDeletionItem = database.prepare(
    "INSERT INTO session_deletion_items (deletion_id, ordinal, session_id) VALUES (?, ?, ?)",
  );
  for (const [index, sessionId] of sessionIds.entries()) {
    insertDeletionItem.run(command.deletionId, index + 1, sessionId);
  }

  // Binding/Attempt and output item/payload pairs form intentional deferred cycles that must disappear together.
  database.exec("PRAGMA defer_foreign_keys = ON;");

  database
    .prepare(
      `
      DELETE FROM run_events
      WHERE run_id NOT IN (SELECT value FROM json_each(?))
        AND (
          (subject_type = 'session' AND subject_id IN (SELECT value FROM json_each(?)))
          OR (subject_type = 'run' AND subject_id IN (SELECT value FROM json_each(?)))
          OR (subject_type = 'session_relation' AND subject_id IN (SELECT value FROM json_each(?)))
          OR (subject_type = 'delegation' AND subject_id IN (SELECT value FROM json_each(?)))
          OR (subject_type = 'child_result_delivery' AND subject_id IN (SELECT value FROM json_each(?)))
        )
    `,
    )
    .run(runIdsJson, sessionIdsJson, runIdsJson, relationIdsJson, delegationIdsJson, deliveryIdsJson);
  database
    .prepare(
      `
      UPDATE idempotency_records
      SET record_state = 'expired', response_kind = NULL, response_ref_type = NULL,
        response_ref_id = NULL, response_envelope_json = NULL
      WHERE scope_session_id NOT IN (SELECT value FROM json_each(?))
        AND record_state = 'completed'
        AND (
          (response_ref_type = 'session' AND response_ref_id IN (SELECT value FROM json_each(?)))
          OR (response_ref_type = 'run' AND response_ref_id IN (SELECT value FROM json_each(?)))
          OR (response_ref_type = 'delivery' AND response_ref_id IN (SELECT value FROM json_each(?)))
        )
    `,
    )
    .run(sessionIdsJson, sessionIdsJson, runIdsJson, deliveryIdsJson);
  database
    .prepare("DELETE FROM idempotency_records WHERE scope_session_id IN (SELECT value FROM json_each(?))")
    .run(sessionIdsJson);
  database
    .prepare("DELETE FROM child_result_deliveries WHERE id IN (SELECT value FROM json_each(?))")
    .run(deliveryIdsJson);
  database.prepare("DELETE FROM delegations WHERE id IN (SELECT value FROM json_each(?))").run(delegationIdsJson);
  database.prepare("DELETE FROM session_relations WHERE id IN (SELECT value FROM json_each(?))").run(relationIdsJson);
  database.prepare("DELETE FROM run_events WHERE run_id IN (SELECT value FROM json_each(?))").run(runIdsJson);
  database.prepare("DELETE FROM run_input_deliveries WHERE run_id IN (SELECT value FROM json_each(?))").run(runIdsJson);
  database
    .prepare(
      `
      DELETE FROM run_output_payloads
      WHERE output_item_id IN (
        SELECT id FROM run_output_items WHERE run_id IN (SELECT value FROM json_each(?))
      )
    `,
    )
    .run(runIdsJson);
  database.prepare("DELETE FROM run_output_items WHERE run_id IN (SELECT value FROM json_each(?))").run(runIdsJson);
  database
    .prepare(
      `
      DELETE FROM run_dispatches
      WHERE run_attempt_id IN (
        SELECT id FROM run_attempts WHERE run_id IN (SELECT value FROM json_each(?))
      )
    `,
    )
    .run(runIdsJson);
  database
    .prepare("DELETE FROM provider_bindings WHERE session_id IN (SELECT value FROM json_each(?))")
    .run(sessionIdsJson);
  database.prepare("DELETE FROM run_attempts WHERE run_id IN (SELECT value FROM json_each(?))").run(runIdsJson);
  const deleteRun = database.prepare("DELETE FROM runs WHERE id = ?");
  for (const run of runRows) deleteRun.run(run.id);
  database.prepare("DELETE FROM messages WHERE session_id IN (SELECT value FROM json_each(?))").run(sessionIdsJson);
  const deleteSession = database.prepare("DELETE FROM sessions WHERE id = ?");
  for (const sessionId of sessionIds) deleteSession.run(sessionId);

  return success({ cleanupToken: command.deletionId, deletedSessionCount: sessionIds.length, localOnly: true }, false);
}

function completeSessionDeletionCleanup(
  database: DatabaseSync,
  command: SessionDeletionCleanupCompleteCommand,
  now: number,
): RepositoryCommandResult<SessionDeletionCleanupCompleteResult> {
  const completed = database
    .prepare("SELECT workspace_key FROM session_deletion_completion_tombstones WHERE deletion_id = ?")
    .get(command.cleanupToken) as { workspace_key: string } | undefined;
  if (completed !== undefined) {
    if (completed.workspace_key !== command.workspaceKey) {
      return failure("not_found", "Session deletion cleanup manifest was not found.");
    }
    return success({ cleanupToken: command.cleanupToken, cleanupCompleted: true }, true);
  }
  const inserted = database
    .prepare(
      `
      INSERT INTO session_deletion_completion_tombstones (
        deletion_id, workspace_key, request_fingerprint, deleted_session_count, completed_at
      )
      SELECT deletion_id, workspace_key, request_fingerprint, deleted_session_count, ?
      FROM session_deletion_manifests
      WHERE deletion_id = ? AND workspace_key = ?
    `,
    )
    .run(now, command.cleanupToken, command.workspaceKey);
  if (inserted.changes !== 1) return failure("not_found", "Session deletion cleanup manifest was not found.");
  const deleted = database
    .prepare("DELETE FROM session_deletion_manifests WHERE deletion_id = ? AND workspace_key = ?")
    .run(command.cleanupToken, command.workspaceKey);
  if (deleted.changes !== 1) throw new Error("Session deletion cleanup manifest disappeared during completion.");
  return success({ cleanupToken: command.cleanupToken, cleanupCompleted: true }, false);
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
    (value) => decodeRunAdmissionReplay(database, command, value),
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
  const capacityExceeded = findRunCapacityExceeded(
    database,
    session.provider_id,
    maxConcurrentRuns,
    maxConcurrentRunsPerProvider,
  );
  if (capacityExceeded !== undefined) return capacityFailure(capacityExceeded);
  if (hasAdmissionIdentityConflict(database, command)) {
    return failure("lifecycle_conflict", "Run admission identity already exists.");
  }

  const binding = resolveAdmissionBinding<NormalRunAdmissionResult>(database, command, session.provider_id);
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
  insertRunAdmissionRows(
    database,
    command,
    command.message.id,
    null,
    runOrdinal,
    prepared.executionSnapshotJson,
    prepared.dispatchFingerprint,
    binding.providerBindingId,
    session.provider_id,
    now,
  );
  advanceSessionActivity(database, command.sessionId, session.updated_at, session.last_activity_at, now);
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

function admitRetryRun(
  database: DatabaseSync,
  prepared: PreparedRetryRunAdmission,
  now: number,
  retentionMs: number,
  maxConcurrentRuns: number,
  maxConcurrentRunsPerProvider: number,
): RepositoryCommandResult<RetryRunAdmissionResult> {
  const command = prepared.command;
  const idempotency = checkIdempotency<RetryRunAdmissionResult>(
    database,
    command.idempotencyKey,
    "run.retry",
    prepared.fingerprint,
    command.sessionId,
    "run",
    command.run.id,
    now,
    (value) => decodeRunAdmissionReplay(database, command, value),
  );
  if (idempotency.kind !== "new") return idempotency.result;

  const session = database
    .prepare(
      `
      SELECT provider_id, lifecycle_status, updated_at, last_activity_at
      FROM sessions WHERE id = ? AND workspace_key = ?
    `,
    )
    .get(command.sessionId, command.workspaceKey) as AdmissionSessionRow | undefined;
  if (session === undefined) return failure("not_found", "Session was not found.");
  if (session.lifecycle_status !== "active") {
    return failure("lifecycle_conflict", "Run admission requires an active Session.");
  }
  if (command.run.executionSnapshot.providerId !== session.provider_id) {
    return failure("reference_invalid", "Run execution snapshot Provider does not match the Session.");
  }

  const source = database
    .prepare(
      `
      SELECT r.initiating_message_id, r.phase, m.role
      FROM runs r
      JOIN messages m ON m.id = r.initiating_message_id AND m.session_id = r.session_id
      WHERE r.id = ? AND r.session_id = ?
    `,
    )
    .get(command.retryOfRunId, command.sessionId) as RetrySourceRow | undefined;
  if (source === undefined || source.role !== "user") {
    return failure("reference_invalid", "Retry source Run or user Message is invalid.");
  }
  if (!isTerminalRunPhase(source.phase)) {
    return failure("lifecycle_conflict", "Retry source Run must be terminal.");
  }
  if (hasNonTerminalRun(database, command.sessionId)) {
    return failure("session_busy", "Session already has a non-terminal Run.");
  }
  const capacityExceeded = findRunCapacityExceeded(
    database,
    session.provider_id,
    maxConcurrentRuns,
    maxConcurrentRunsPerProvider,
  );
  if (capacityExceeded !== undefined) return capacityFailure(capacityExceeded);
  if (hasRunAdmissionIdentityConflict(database, command.run.id, command.attemptId, command.bindingIntent)) {
    return failure("lifecycle_conflict", "Run admission identity already exists.");
  }

  const binding = resolveAdmissionBinding<RetryRunAdmissionResult>(database, command, session.provider_id);
  if (!binding.ok) return binding.result;
  const runOrdinal = nextOrdinal(database, "runs", "session_id", command.sessionId);
  insertRunAdmissionRows(
    database,
    command,
    source.initiating_message_id,
    command.retryOfRunId,
    runOrdinal,
    prepared.executionSnapshotJson,
    prepared.dispatchFingerprint,
    binding.providerBindingId,
    session.provider_id,
    now,
  );
  advanceSessionActivity(database, command.sessionId, session.updated_at, session.last_activity_at, now);

  const value: RetryRunAdmissionResult = {
    sessionId: command.sessionId,
    messageId: source.initiating_message_id,
    runId: command.run.id,
    retryOfRunId: command.retryOfRunId,
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
    "run.retry",
    prepared.fingerprint,
    "run",
    command.run.id,
    value,
    now,
    retentionMs,
  );
  return success(value, false);
}

function startChild(
  database: DatabaseSync,
  prepared: PreparedChildStart,
  now: number,
  retentionMs: number,
  maxConcurrentRuns: number,
  maxConcurrentRunsPerProvider: number,
): RepositoryCommandResult<ChildStartResult> {
  const { command } = prepared;
  const idempotency = checkIdempotency<ChildStartResult>(
    database,
    command.idempotencyKey,
    REPOSITORY_WRITE_OPERATIONS.childStart,
    prepared.fingerprint,
    command.parentSessionId,
    "delivery",
    command.deliveryId,
    now,
    (value) => decodeChildStartReplay(database, command, value),
  );
  if (idempotency.kind !== "new") return idempotency.result;

  const parentSession = database
    .prepare("SELECT lifecycle_status FROM sessions WHERE id = ? AND workspace_key = ?")
    .get(command.parentSessionId, command.workspaceKey) as { lifecycle_status: SessionLifecycleStatus } | undefined;
  if (parentSession === undefined) return failure("not_found", "Parent Session was not found.");
  if (parentSession.lifecycle_status !== "active") {
    return failure("lifecycle_conflict", "Child admission requires an active parent Session.");
  }
  const parentRun = database
    .prepare(
      `
      SELECT r.phase, COALESCE(sr.orchestration_root_session_id, r.session_id) AS root_session_id
      FROM runs r
      LEFT JOIN session_relations sr ON sr.child_session_id = r.session_id
      WHERE r.id = ? AND r.session_id = ?
    `,
    )
    .get(command.parentRunId, command.parentSessionId) as
    { phase: NonTerminalRunPhase | TerminalRunPhase; root_session_id: string } | undefined;
  if (parentRun === undefined) return failure("reference_invalid", "Parent Run does not belong to the parent Session.");
  if (parentRun.phase !== "active") {
    return failure("lifecycle_conflict", "Child admission requires an active parent Run.");
  }
  if (command.run.executionSnapshot.providerId !== command.childSession.providerId) {
    return failure("reference_invalid", "Child Run execution snapshot Provider does not match the child Session.");
  }
  const root = database
    .prepare("SELECT max_concurrent_child_runs FROM sessions WHERE id = ?")
    .get(parentRun.root_session_id) as { max_concurrent_child_runs: number } | undefined;
  if (root === undefined) return failure("reference_invalid", "Orchestration root Session was not found.");
  const rootCurrent = countNonTerminalChildren(database, parentRun.root_session_id);
  if (rootCurrent >= root.max_concurrent_child_runs) {
    return capacityFailure({
      scope: "root",
      rootSessionId: parentRun.root_session_id,
      current: rootCurrent,
      limit: root.max_concurrent_child_runs,
    });
  }
  const capacityExceeded = findRunCapacityExceeded(
    database,
    command.childSession.providerId,
    maxConcurrentRuns,
    maxConcurrentRunsPerProvider,
  );
  if (capacityExceeded !== undefined) return capacityFailure(capacityExceeded);
  if (hasChildStartIdentityConflict(database, command)) {
    return failure("lifecycle_conflict", "Child admission identity already exists.");
  }

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
      command.childSession.id,
      command.childSession.providerId,
      command.workspaceKey,
      prepared.directoriesJson,
      command.childSession.defaultCharacterId,
      command.childSession.maxConcurrentChildRuns,
      now,
      now,
      now,
    );
  database
    .prepare(
      `
      INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at)
      VALUES (?, ?, 1, 'user', ?, ?)
    `,
    )
    .run(command.message.id, command.childSession.id, prepared.contentBlocksJson, now);
  const admissionCommand: RunAdmissionCommand = {
    sessionId: command.childSession.id,
    run: command.run,
    attemptId: command.attemptId,
    bindingIntent: {
      kind: "create",
      bindingId: command.binding.id,
      persistenceMode: command.binding.persistenceMode,
    },
    dispatch: command.dispatch,
  };
  insertRunAdmissionRows(
    database,
    admissionCommand,
    command.message.id,
    null,
    1,
    prepared.executionSnapshotJson,
    prepared.dispatchFingerprint,
    null,
    command.childSession.providerId,
    now,
  );
  database
    .prepare(
      `
      INSERT INTO session_relations (
        id, parent_session_id, child_session_id, orchestration_root_session_id,
        created_by_parent_run_id, correlation_id, label, purpose_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      command.relation.id,
      command.parentSessionId,
      command.childSession.id,
      parentRun.root_session_id,
      command.parentRunId,
      command.relation.correlationId,
      command.relation.label,
      command.relation.purposeSummary,
      now,
    );
  database
    .prepare(
      `
      INSERT INTO delegations (
        id, session_relation_id, initial_instruction_message_id, latest_instruction_message_id,
        latest_child_run_id, mention_text, workflow_state, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 0)
    `,
    )
    .run(
      command.delegation.id,
      command.relation.id,
      command.message.id,
      command.message.id,
      command.run.id,
      command.delegation.mentionText,
      now,
      now,
    );
  database
    .prepare(
      `
      INSERT INTO child_result_deliveries (
        id, delegation_id, ordinal, child_run_id, availability_state,
        created_at, updated_at, version
      ) VALUES (?, ?, 1, ?, 'pending', ?, ?, 0)
    `,
    )
    .run(command.deliveryId, command.delegation.id, command.run.id, now, now);

  const value: ChildStartResult = {
    parentSessionId: command.parentSessionId,
    parentRunId: command.parentRunId,
    childSessionId: command.childSession.id,
    orchestrationRootSessionId: parentRun.root_session_id,
    relationId: command.relation.id,
    correlationId: command.relation.correlationId,
    delegationId: command.delegation.id,
    deliveryId: command.deliveryId,
    messageId: command.message.id,
    runId: command.run.id,
    attemptId: command.attemptId,
    bindingId: command.binding.id,
    bindingState: "creating",
    dispatchState: "pending",
    admittedAt: now,
  };
  completeIdempotency(
    database,
    command.idempotencyKey,
    command.parentSessionId,
    REPOSITORY_WRITE_OPERATIONS.childStart,
    prepared.fingerprint,
    "delivery",
    command.deliveryId,
    value,
    now,
    retentionMs,
  );
  return success(value, false);
}

function insertRunAdmissionRows(
  database: DatabaseSync,
  command: RunAdmissionCommand,
  initiatingMessageId: string,
  retryOfRunId: string | null,
  runOrdinal: number,
  executionSnapshotJson: string,
  dispatchFingerprint: string,
  providerBindingId: string | null,
  providerId: string,
  now: number,
): void {
  database
    .prepare(
      `
      INSERT INTO runs (
        id, session_id, ordinal, initiating_message_id, retry_of_run_id, phase,
        execution_snapshot_json, external_side_effect_state, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 'none', ?, ?, 0)
    `,
    )
    .run(
      command.run.id,
      command.sessionId,
      runOrdinal,
      initiatingMessageId,
      retryOfRunId,
      executionSnapshotJson,
      now,
      now,
    );
  database
    .prepare(
      `
      INSERT INTO run_attempts (
        id, run_id, ordinal, provider_binding_id, attempt_reason, attempt_state, created_at
      ) VALUES (?, ?, 1, ?, 'initial', 'preparing', ?)
    `,
    )
    .run(command.attemptId, command.run.id, providerBindingId, now);
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
        providerId,
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
    .run(command.attemptId, dispatchFingerprint, command.dispatch.providerIdempotencyKey, now);
}

function advanceSessionActivity(
  database: DatabaseSync,
  sessionId: string,
  currentUpdatedAt: number,
  currentLastActivityAt: number,
  now: number,
): void {
  database
    .prepare("UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?")
    .run(Math.max(now, currentUpdatedAt), Math.max(now, currentLastActivityAt), sessionId);
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
    (row.persistence_mode === "persistent" && command.resolution.ephemeralOwnerToken !== null) ||
    (row.persistence_mode === "ephemeral" && command.resolution.ephemeralOwnerToken === null)
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
      WHERE id = ? AND session_id = ? AND provider_id = ? AND binding_state = 'creating'
    `,
    )
    .run(command.resolution.externalConversationId, command.bindingId, command.sessionId, row.session_provider_id);
  const attemptUpdate = database
    .prepare(
      `
      UPDATE run_attempts SET provider_binding_id = ?
      WHERE id = ? AND run_id = ? AND attempt_state = 'preparing' AND provider_binding_id IS NULL
    `,
    )
    .run(command.bindingId, command.attemptId, command.runId);
  const runUpdate = database
    .prepare(
      `
      UPDATE runs SET external_side_effect_state = 'present', updated_at = MAX(updated_at, ?),
        version = version + 1
      WHERE id = ? AND session_id = ? AND phase IN ('queued','starting','active','canceling','finalizing')
    `,
    )
    .run(now, command.runId, command.sessionId);
  if (bindingUpdate.changes !== 1 || attemptUpdate.changes !== 1 || runUpdate.changes !== 1) {
    return bindingResolutionFailure(failure("lifecycle_conflict", "Provider binding activation conflicted."));
  }
  const execution: ProviderBindingResolutionExecution = {
    result: success(
      bindingResolutionValue(
        command,
        command.resolution.externalConversationId,
        row.persistence_mode === "ephemeral" ? "registered" : "not_applicable",
      ),
      false,
    ),
  };
  return row.persistence_mode === "ephemeral" && command.resolution.ephemeralOwnerToken !== null
    ? {
        ...execution,
        registerEphemeralOwner: { bindingId: command.bindingId, token: command.resolution.ephemeralOwnerToken },
      }
    : execution;
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
    (row.run_phase !== "queued" && row.run_phase !== "starting")
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
      WHERE id = ? AND session_id = ? AND phase IN ('queued','starting')
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
  const tokenFailure = validateExplicitResolutionToken<RunDispatchResolutionResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (tokenFailure !== undefined) return tokenFailure;
  const replay = replayRunDispatchResolution(command, row);
  if (replay !== undefined) return replay;
  const ownershipFailure = validateResolutionOwnership<RunDispatchResolutionResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (ownershipFailure !== undefined) return ownershipFailure;

  if (command.outcome.kind === "accepted") {
    if (
      (row.dispatch_state !== "dispatching" && row.dispatch_state !== "ambiguous") ||
      row.attempt_state !== "preparing" ||
      row.binding_state !== "active" ||
      row.provider_binding_id !== command.bindingId ||
      (row.run_phase !== "starting" && row.run_phase !== "canceling")
    ) {
      return failure("lifecycle_conflict", "Accepted Run dispatch resolution state changed.");
    }
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
        WHERE run_attempt_id = ? AND dispatch_state = ?
      `,
      )
      .run(now, command.attemptId, row.dispatch_state);
    const runUpdate = database
      .prepare(
        `
        UPDATE runs SET phase = CASE WHEN phase = 'starting' THEN 'active' ELSE phase END,
          started_at = COALESCE(started_at, ?), external_side_effect_state = 'present',
          updated_at = MAX(updated_at, ?), version = version + 1
        WHERE id = ? AND session_id = ? AND phase IN ('starting','canceling')
      `,
      )
      .run(now, now, command.runId, command.sessionId);
    if (attemptUpdate.changes !== 1 || dispatchUpdate.changes !== 1 || runUpdate.changes !== 1) {
      return failure("lifecycle_conflict", "Accepted Run dispatch resolution conflicted.");
    }
    return success(dispatchResolutionValue(command, "accepted", command.outcome.externalExecutionId, now), false);
  }

  if (
    row.dispatch_state !== "dispatching" ||
    row.attempt_state !== "preparing" ||
    row.binding_state !== "active" ||
    row.provider_binding_id !== command.bindingId ||
    (row.run_phase !== "starting" && row.run_phase !== "canceling")
  ) {
    return failure("lifecycle_conflict", "Run dispatch resolution state changed.");
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
  if (command.outcome.kind === "ambiguous") {
    const runUpdate = database
      .prepare(
        `
        UPDATE runs SET external_side_effect_state = CASE
            WHEN external_side_effect_state = 'present' THEN 'present' ELSE 'unknown' END,
          updated_at = MAX(updated_at, ?), version = version + 1
        WHERE id = ? AND session_id = ? AND phase IN ('starting','canceling')
      `,
      )
      .run(now, command.runId, command.sessionId);
    if (runUpdate.changes !== 1) return failure("lifecycle_conflict", "Ambiguous Run dispatch resolution conflicted.");
  }
  return success(dispatchResolutionValue(command, command.outcome.kind, null, now), false);
}

function admitRunInput(
  database: DatabaseSync,
  prepared: PreparedRunInputAdmission,
  now: number,
  retentionMs: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<RunInputAdmissionResult> {
  const command = prepared.command;
  const idempotency = checkIdempotency<RunInputAdmissionResult>(
    database,
    command.idempotencyKey,
    "run.input.admit",
    prepared.fingerprint,
    command.sessionId,
    "delivery",
    command.message.id,
    now,
  );
  if (idempotency.kind !== "new") {
    if (idempotency.kind === "replay" && idempotency.result.ok) {
      const current = readRunInputAdmissionResult(database, command.message.id, command.sessionId);
      return current === undefined
        ? failure("reference_invalid", "Idempotent Run input Delivery is invalid.")
        : success(current, true);
    }
    return idempotency.result;
  }

  const gate = database
    .prepare(
      `
      SELECT s.lifecycle_status, s.updated_at, s.last_activity_at,
        r.phase AS run_phase, a.attempt_state, a.provider_binding_id,
        b.persistence_mode, b.binding_state, b.external_conversation_id, d.dispatch_state
      FROM sessions s
      JOIN runs r ON r.session_id = s.id AND r.id = ?
      JOIN run_attempts a ON a.run_id = r.id AND a.id = ?
      JOIN provider_bindings b ON b.id = a.provider_binding_id
        AND b.session_id = s.id AND b.provider_id = s.provider_id
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = s.id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      WHERE s.id = ? AND s.workspace_key = ?
    `,
    )
    .get(command.runId, command.attemptId, command.sessionId, command.workspaceKey) as
    RunInputAdmissionGateRow | undefined;
  if (gate === undefined) return failure("not_found", "Run input target was not found.");
  const ownershipFailure = validateDispatchOwnership<RunInputAdmissionResult>(
    gate.provider_binding_id,
    command.ephemeralOwnerToken,
    gate,
    ephemeralBindingOwners,
  );
  if (ownershipFailure !== undefined) return ownershipFailure;
  if (
    gate.lifecycle_status !== "active" ||
    gate.run_phase !== "active" ||
    gate.attempt_state !== "active" ||
    gate.binding_state !== "active" ||
    gate.dispatch_state !== "accepted"
  ) {
    return failure("lifecycle_conflict", "Run input admission Gate is not satisfied.");
  }
  if (
    database.prepare("SELECT 1 FROM messages WHERE id = ?").get(command.message.id) !== undefined ||
    database.prepare("SELECT 1 FROM run_input_deliveries WHERE message_id = ?").get(command.message.id) !== undefined
  ) {
    return failure("lifecycle_conflict", "Run input identity already exists.");
  }

  const ordinal = nextOrdinal(database, "messages", "session_id", command.sessionId);
  database
    .prepare(
      `
      INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at)
      VALUES (?, ?, ?, 'user', ?, ?)
    `,
    )
    .run(command.message.id, command.sessionId, ordinal, prepared.contentBlocksJson, now);
  database
    .prepare(
      `
      INSERT INTO run_input_deliveries (
        message_id, run_id, run_attempt_id, delivery_state, created_at
      ) VALUES (?, ?, ?, 'pending', ?)
    `,
    )
    .run(command.message.id, command.runId, command.attemptId, now);
  advanceSessionActivity(database, command.sessionId, gate.updated_at, gate.last_activity_at, now);

  const value: RunInputAdmissionResult = {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    messageId: command.message.id,
    bindingId: gate.provider_binding_id,
    deliveryState: "pending",
    resolutionCode: null,
    admittedAt: now,
    dispatchingAt: null,
    resolvedAt: null,
  };
  completeIdempotency(
    database,
    command.idempotencyKey,
    command.sessionId,
    "run.input.admit",
    prepared.fingerprint,
    "delivery",
    command.message.id,
    value,
    now,
    retentionMs,
  );
  return success(value, false);
}

function beginRunInput(
  database: DatabaseSync,
  command: RunInputBeginCommand,
  now: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<RunInputBeginResult> {
  const row = readRunInputTransitionRow(database, command);
  if (row === undefined) return failure("not_found", "Run input delivery was not found.");
  if (
    row.delivery_state === "dispatching" &&
    row.dispatching_at !== null &&
    row.provider_binding_id === command.bindingId
  ) {
    return success(runInputBeginValue(command, row.dispatching_at, false), true);
  }
  const ownershipFailure = validateDispatchOwnership<RunInputBeginResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (ownershipFailure !== undefined) return ownershipFailure;
  if (
    row.lifecycle_status !== "active" ||
    row.run_phase !== "active" ||
    row.attempt_state !== "active" ||
    row.provider_binding_id !== command.bindingId ||
    row.dispatch_state !== "accepted" ||
    row.delivery_state !== "pending"
  ) {
    return failure("lifecycle_conflict", "Run input begin Gate is not satisfied.");
  }
  const update = database
    .prepare(
      `
      UPDATE run_input_deliveries SET delivery_state = 'dispatching', dispatching_at = ?
      WHERE message_id = ? AND run_id = ? AND run_attempt_id = ? AND delivery_state = 'pending'
    `,
    )
    .run(now, command.messageId, command.runId, command.attemptId);
  if (update.changes !== 1) return failure("lifecycle_conflict", "Run input begin conflicted.");
  return success(runInputBeginValue(command, now, true), false);
}

function resolveRunInput(
  database: DatabaseSync,
  command: RunInputResolutionCommand,
  now: number,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<RunInputResolutionResult> {
  const row = readRunInputTransitionRow(database, command);
  if (row === undefined) return failure("not_found", "Run input delivery was not found.");
  const tokenFailure = validateExplicitResolutionToken<RunInputResolutionResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (tokenFailure !== undefined) return tokenFailure;
  const replay = replayRunInputResolution(command, row);
  if (replay !== undefined) return replay;
  const ownershipFailure = validateResolutionOwnership<RunInputResolutionResult>(
    command.bindingId,
    command.ephemeralOwnerToken,
    row,
    ephemeralBindingOwners,
  );
  if (ownershipFailure !== undefined) return ownershipFailure;
  if (row.provider_binding_id !== command.bindingId || row.delivery_state !== "dispatching") {
    return failure("lifecycle_conflict", "Run input resolution state changed.");
  }
  const resolutionCode = command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode;
  const update = database
    .prepare(
      `
      UPDATE run_input_deliveries
      SET delivery_state = ?, resolution_code = ?, resolved_at = ?
      WHERE message_id = ? AND run_id = ? AND run_attempt_id = ? AND delivery_state = 'dispatching'
    `,
    )
    .run(command.outcome.kind, resolutionCode, now, command.messageId, command.runId, command.attemptId);
  if (update.changes !== 1) return failure("lifecycle_conflict", "Run input resolution conflicted.");
  return success(runInputResolutionValue(command, resolutionCode, now), false);
}

function appendRunOutput(
  database: DatabaseSync,
  prepared: PreparedRunOutputAppend,
  now: number,
  limits: ResolvedPayloadLimits,
  diskCapacity: DiskCapacityProbe,
): RepositoryCommandResult<RunOutputAppendResult> {
  const { command } = prepared;
  const scope = database
    .prepare(
      `
      SELECT r.phase, s.workspace_key FROM runs r
      JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ? AND r.session_id = ?
    `,
    )
    .get(command.runId, command.sessionId) as { phase: string; workspace_key: string } | undefined;
  if (scope === undefined) return failure("not_found", "Run was not found in the Session.");
  if (scope.workspace_key !== command.workspaceKey)
    return failure("reference_invalid", "Workspace scope does not match.");

  const existing = readOutputReplayRow(database, command.runId, command.item.id, command.item.providerItemId);
  if (existing !== undefined) {
    return outputReplayMatches(database, prepared, existing)
      ? success(outputAppendValue(command.sessionId, command.runId, existing), true)
      : failure("lifecycle_conflict", "Run output identity was already used differently.");
  }
  if (database.prepare("SELECT 1 FROM run_output_items WHERE id = ?").get(command.item.id) !== undefined) {
    return failure("reference_invalid", "Run output ID belongs to another Run.");
  }
  if (!isWritableOutputPhase(scope.phase)) {
    return failure("lifecycle_conflict", "New Run output requires an active Run.");
  }

  const ordinal = nextOrdinal(database, "run_output_items", "run_id", command.runId);
  const stored =
    prepared.payload?.state === "stored" &&
    canStorePayload(database, command.runId, command.sessionId, prepared.payload, limits, diskCapacity);
  const payloadState =
    prepared.payload?.state === "stored" && !stored ? "omitted_size_limit" : command.item.payload.state;
  insertOutputItem(database, command.runId, ordinal, command.item, payloadState, now);
  if (stored && prepared.payload?.state === "stored")
    insertOutputPayload(database, command.item.id, prepared.payload, now);
  const value: RunOutputAppendResult = {
    sessionId: command.sessionId,
    runId: command.runId,
    outputItemId: command.item.id,
    ordinal,
    payloadState,
    storedByteLength: stored && prepared.payload?.state === "stored" ? prepared.payload.content.byteLength : null,
    createdAt: now,
  };
  return success(value, false);
}

function resolvePendingRunOutput(
  database: DatabaseSync,
  prepared: PreparedRunOutputResolvePending,
  now: number,
  limits: ResolvedPayloadLimits,
  diskCapacity: DiskCapacityProbe,
): RepositoryCommandResult<RunOutputResolvePendingResult> {
  const { command } = prepared;
  const row = database
    .prepare(
      `
      SELECT o.payload_state, o.payload_original_byte_length, o.redaction_state,
             r.phase, s.workspace_key
      FROM run_output_items o
      JOIN runs r ON r.id = o.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE o.id = ? AND o.run_id = ? AND r.session_id = ?
    `,
    )
    .get(command.outputItemId, command.runId, command.sessionId) as
    | {
        payload_state: string;
        payload_original_byte_length: number;
        redaction_state: "not_required" | "redacted";
        phase: string;
        workspace_key: string;
      }
    | undefined;
  if (row === undefined) return failure("not_found", "Pending Run output was not found.");
  if (row.workspace_key !== command.workspaceKey)
    return failure("reference_invalid", "Workspace scope does not match.");
  if (!isTerminalRunPhase(row.phase))
    return failure("lifecycle_conflict", "Pending output resolves after Run terminal commit.");
  if (row.payload_state !== "pending") {
    const replayState = resolvedPendingReplayState(prepared, row.payload_state);
    if (replayState === null)
      return failure("lifecycle_conflict", "Run output payload is already resolved differently.");
    const payload = database
      .prepare(
        "SELECT byte_length, content_sha256, payload_format, media_type FROM run_output_payloads WHERE output_item_id = ?",
      )
      .get(command.outputItemId) as
      { byte_length: number; content_sha256: string; payload_format: string; media_type: string | null } | undefined;
    if (
      row.payload_state === "stored" &&
      (prepared.payload === undefined ||
        payload === undefined ||
        !pendingStoredReplayMatches(prepared.payload, payload))
    ) {
      return failure("lifecycle_conflict", "Stored Run output payload differs from the replay.");
    }
    return success(pendingResolutionValue(command, replayState, payload?.byte_length ?? null), true);
  }

  let state = command.resolution.state;
  let storedByteLength: number | null = null;
  if (prepared.payload?.state === "stored") {
    const payloadWithOriginal = { ...prepared.payload, originalByteLength: row.payload_original_byte_length };
    if (canStorePayload(database, command.runId, command.sessionId, payloadWithOriginal, limits, diskCapacity)) {
      insertOutputPayload(database, command.outputItemId, prepared.payload, now);
      state = "stored";
      storedByteLength = prepared.payload.content.byteLength;
    } else {
      state = "omitted_size_limit";
    }
  }
  const storedPayloadId = state === "stored" ? command.outputItemId : null;
  const update = database
    .prepare(
      "UPDATE run_output_items SET payload_state = ?, stored_payload_id = ? WHERE id = ? AND payload_state = 'pending'",
    )
    .run(state, storedPayloadId, command.outputItemId);
  if (update.changes !== 1)
    return rollbackWith(failure("lifecycle_conflict", "Run output payload resolution conflicted."));
  return success(pendingResolutionValue(command, state, storedByteLength), false);
}

function terminalRun(
  database: DatabaseSync,
  prepared: PreparedRunTerminal,
  now: number,
): RepositoryCommandResult<RunTerminalResult> {
  const { command } = prepared;
  const rows = database
    .prepare(
      `
      SELECT r.phase, r.final_assistant_message_id, r.failure_origin, r.provider_error_code,
             r.error_summary, r.terminal_at, a.attempt_state, s.workspace_key,
             s.provider_id AS session_provider_id,
             s.updated_at AS session_updated_at, s.last_activity_at AS session_last_activity_at,
             a.provider_binding_id, d.dispatch_state,
             b.id AS binding_id, b.session_id AS binding_session_id, b.provider_id AS binding_provider_id,
             b.persistence_mode, b.binding_state,
             b.created_by_run_attempt_id, creator_r.session_id AS binding_creator_session_id,
             b.invalidation_reason
      FROM runs r
      JOIN run_attempts a ON a.id = ? AND a.run_id = r.id
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      LEFT JOIN provider_bindings b
        ON b.id = a.provider_binding_id
        OR (a.provider_binding_id IS NULL AND b.created_by_run_attempt_id = a.id)
      LEFT JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
      LEFT JOIN runs creator_r ON creator_r.id = creator_a.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE r.id = ? AND r.session_id = ?
    `,
    )
    .all(command.attemptId, command.runId, command.sessionId) as unknown as TerminalGateRow[];
  const [row] = rows;
  if (row === undefined) return failure("not_found", "Run and Attempt were not found in the Session.");
  if (rows.length !== 1) {
    return failure("reference_invalid", "Run Attempt resolves to multiple Provider Bindings.");
  }
  if (row.workspace_key !== command.workspaceKey)
    return failure("reference_invalid", "Workspace scope does not match.");
  if (
    row.binding_id !== null &&
    (row.binding_session_id !== command.sessionId ||
      row.binding_provider_id !== row.session_provider_id ||
      row.binding_creator_session_id !== command.sessionId)
  ) {
    return failure("reference_invalid", "Provider Binding does not match the Run Session and Provider scope.");
  }
  if (row.persistence_mode === "ephemeral" && row.created_by_run_attempt_id !== command.attemptId) {
    return failure("reference_invalid", "Ephemeral Provider Binding does not belong to the Run Attempt.");
  }
  if (isTerminalRunPhase(row.phase)) return replayTerminalRun(database, prepared, row);
  if (!isNonTerminalRunPhase(row.phase)) return failure("lifecycle_conflict", "Run cannot transition to terminal.");
  if ((command.outcome.kind === "completed" || command.outcome.kind === "failed") && row.attempt_state !== "active") {
    return failure("lifecycle_conflict", "Completed and failed outcomes require an active Attempt.");
  }
  if (
    (command.outcome.kind === "canceled" || command.outcome.kind === "interrupted") &&
    row.attempt_state !== "preparing" &&
    row.attempt_state !== "active"
  ) {
    return failure("lifecycle_conflict", "Canceled and interrupted outcomes require a live Attempt.");
  }
  const preparationFailure = validateTerminalPreparation(command, row);
  if (preparationFailure !== undefined) return preparationFailure;

  const child = readChildTerminalRow(database, command.runId);
  if ((child === undefined) !== (command.childResult === null)) {
    return failure("reference_invalid", "Child result metadata does not match Run ownership.");
  }
  if (command.childResult?.workflowState === "clarification_required" && command.outcome.kind !== "completed") {
    return failure("request_invalid", "Only a completed child Run may require clarification.");
  }
  if (child !== undefined && child.availability_state !== "pending") {
    return failure("lifecycle_conflict", "Child Delivery is already available.");
  }

  if (hasTerminalIdentityConflict(database, command, prepared.terminalDedupeKey)) {
    return failure("reference_invalid", "Terminal event, Message, or output identity is already in use.");
  }
  const inputResolution = settleRunInputDeliveriesForTerminal(database, command, now);
  if (inputResolution !== undefined) return rollbackWith(inputResolution);
  const preparationResolution = applyTerminalPreparationResolution(database, command, row, now);
  if (preparationResolution !== undefined) return rollbackWith(preparationResolution);
  let nextOutputOrdinal = nextOrdinal(database, "run_output_items", "run_id", command.runId);
  for (const output of command.outputs) {
    if (readOutputReplayRow(database, command.runId, output.id, output.providerItemId) !== undefined) {
      return rollbackWith(failure("lifecycle_conflict", "Terminal output identity already exists."));
    }
    insertOutputItem(database, command.runId, nextOutputOrdinal, output, output.payload.state, now);
    nextOutputOrdinal += 1;
  }

  const finalMessageId =
    command.outcome.kind === "completed" ? (command.outcome.finalAssistantMessage?.id ?? null) : null;
  if (prepared.finalMessageJson !== null && finalMessageId !== null) {
    const messageOrdinal = nextOrdinal(database, "messages", "session_id", command.sessionId);
    database
      .prepare(
        "INSERT INTO messages (id, session_id, ordinal, role, content_blocks_json, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)",
      )
      .run(finalMessageId, command.sessionId, messageOrdinal, prepared.finalMessageJson, now);
  }

  const runFailureFields = terminalRunFailureFields(command);
  const attemptFailureFields = terminalAttemptFailureFields(command);
  const attemptState =
    command.outcome.kind === "completed" ? "succeeded" : command.outcome.kind === "failed" ? "failed" : "interrupted";
  const attemptUpdate = database
    .prepare(
      `
      UPDATE run_attempts SET attempt_state = ?, failure_origin = ?, provider_error_code = ?,
        error_summary = ?, terminal_at = ?
      WHERE id = ? AND run_id = ? AND attempt_state IN ('preparing','active')
    `,
    )
    .run(
      attemptState,
      attemptFailureFields.failureOrigin,
      attemptFailureFields.providerErrorCode,
      attemptFailureFields.errorSummary,
      now,
      command.attemptId,
      command.runId,
    );
  if (attemptUpdate.changes !== 1)
    return rollbackWith(failure("lifecycle_conflict", "Attempt terminal transition conflicted."));

  const runUpdate = database
    .prepare(
      `
      UPDATE runs SET phase = ?, final_assistant_message_id = ?, failure_origin = ?,
        provider_error_code = ?, error_summary = ?,
        external_side_effect_state = CASE WHEN ? = 1 THEN
          CASE WHEN external_side_effect_state = 'present' THEN 'present' ELSE 'unknown' END
          ELSE external_side_effect_state END,
        terminal_event_received_at = ?,
        terminal_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND session_id = ? AND phase IN ('queued','starting','active','canceling','finalizing')
    `,
    )
    .run(
      command.outcome.kind,
      finalMessageId,
      runFailureFields.failureOrigin,
      runFailureFields.providerErrorCode,
      runFailureFields.errorSummary,
      command.preDispatchResolution.kind === "binding_creation_ambiguous" ? 1 : 0,
      now,
      now,
      now,
      command.runId,
      command.sessionId,
    );
  if (runUpdate.changes !== 1)
    return rollbackWith(failure("lifecycle_conflict", "Run terminal transition conflicted."));

  const eventOrdinal = nextOrdinal(database, "run_events", "run_id", command.runId);
  database
    .prepare(
      `
      INSERT INTO run_events (id, run_id, ordinal, event_code, subject_type, subject_id, dedupe_key, summary, created_at)
      VALUES (?, ?, ?, 'run.terminal', 'run', ?, ?, ?, ?)
    `,
    )
    .run(command.terminalEvent.id, command.runId, eventOrdinal, command.runId, prepared.terminalDedupeKey, null, now);

  let childDeliveryId: string | null = null;
  let delegationState: "clarification_required" | "closed" | null = null;
  if (child !== undefined && command.childResult !== null) {
    childDeliveryId = child.delivery_id;
    delegationState = command.childResult.workflowState;
    const deliveryUpdate = database
      .prepare(
        `
        UPDATE child_result_deliveries SET availability_state = 'available', terminal_phase_snapshot = ?,
          result_summary = ?, available_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND child_run_id = ? AND availability_state = 'pending'
      `,
      )
      .run(command.outcome.kind, command.childResult.resultSummary, now, now, child.delivery_id, command.runId);
    if (deliveryUpdate.changes !== 1)
      return rollbackWith(failure("lifecycle_conflict", "Child Delivery transition conflicted."));
    const closureReason = delegationState === "closed" ? command.outcome.kind : null;
    const delegationUpdate = database
      .prepare(
        `
        UPDATE delegations SET workflow_state = ?, closure_reason = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND latest_child_run_id = ?
      `,
      )
      .run(delegationState, closureReason, now, child.delegation_id, command.runId);
    if (delegationUpdate.changes !== 1)
      return rollbackWith(failure("lifecycle_conflict", "Delegation transition conflicted."));
  }
  advanceSessionActivity(database, command.sessionId, row.session_updated_at, row.session_last_activity_at, now);
  return success(
    terminalResult(command, finalMessageId, command.terminalEvent.id, childDeliveryId, delegationState, now),
    false,
  );
}

function validateTerminalPreparation(
  command: RunTerminalCommand,
  row: TerminalGateRow,
): RepositoryCommandResult<RunTerminalResult> | undefined {
  const resolution = command.preDispatchResolution.kind;
  if (resolution === "not_applicable") {
    if (
      row.binding_state === "creating" ||
      isUnresolvedTerminalDispatch(row.dispatch_state) ||
      (row.attempt_state === "active" && row.dispatch_state !== "accepted")
    ) {
      return failure("lifecycle_conflict", "Run preparation must be resolved before terminal transition.");
    }
    return undefined;
  }
  if (command.outcome.kind !== "canceled" && command.outcome.kind !== "interrupted") {
    return failure("request_invalid", "Pre-dispatch resolution requires a canceled or interrupted outcome.");
  }
  if (row.attempt_state !== "preparing" || row.dispatch_state !== "pending" || row.binding_id === null) {
    return failure("lifecycle_conflict", "Pre-dispatch resolution state changed.");
  }
  if (resolution === "dispatch_not_sent") {
    return row.binding_state === "active" && row.provider_binding_id === row.binding_id
      ? undefined
      : failure("lifecycle_conflict", "Pending Dispatch does not have an active Binding.");
  }
  return row.binding_state === "creating" &&
    row.provider_binding_id === null &&
    row.created_by_run_attempt_id === command.attemptId
    ? undefined
    : failure("lifecycle_conflict", "Pending Binding creation state changed.");
}

function applyTerminalPreparationResolution(
  database: DatabaseSync,
  command: RunTerminalCommand,
  row: TerminalGateRow,
  now: number,
): RepositoryCommandResult<RunTerminalResult> | undefined {
  const resolution = command.preDispatchResolution.kind;
  if (resolution === "binding_creation_not_sent" || resolution === "binding_creation_ambiguous") {
    const invalidationReason =
      resolution === "binding_creation_not_sent" ? "conversation_start_not_sent" : "conversation_start_ambiguous";
    const bindingUpdate = database
      .prepare(
        `
        UPDATE provider_bindings
        SET binding_state = 'invalidated', invalidated_at = ?, invalidation_reason = ?
        WHERE id = ? AND session_id = ? AND provider_id = ?
          AND binding_state = 'creating' AND created_by_run_attempt_id = ?
      `,
      )
      .run(now, invalidationReason, row.binding_id, command.sessionId, row.session_provider_id, command.attemptId);
    const dispatchUpdate = abortPendingDispatch(database, command.attemptId, now);
    if (bindingUpdate.changes !== 1 || dispatchUpdate !== 1) {
      return failure("lifecycle_conflict", "Binding creation abort conflicted.");
    }
  } else if (resolution === "dispatch_not_sent") {
    if (abortPendingDispatch(database, command.attemptId, now) !== 1) {
      return failure("lifecycle_conflict", "Pending Dispatch abort conflicted.");
    }
  }

  if (row.persistence_mode === "ephemeral" && row.binding_state === "active") {
    const bindingUpdate = database
      .prepare(
        `
        UPDATE provider_bindings
        SET binding_state = 'invalidated', invalidated_at = ?, invalidation_reason = 'ephemeral_run_terminal'
        WHERE id = ? AND session_id = ? AND provider_id = ?
          AND binding_state = 'active' AND persistence_mode = 'ephemeral'
          AND created_by_run_attempt_id = ?
      `,
      )
      .run(now, row.binding_id, command.sessionId, row.session_provider_id, command.attemptId);
    if (bindingUpdate.changes !== 1) return failure("lifecycle_conflict", "Ephemeral Binding invalidation conflicted.");
  }
  return undefined;
}

function settleRunInputDeliveriesForTerminal(
  database: DatabaseSync,
  command: RunTerminalCommand,
  now: number,
): RepositoryCommandResult<RunTerminalResult> | undefined {
  database
    .prepare(
      `
      UPDATE run_input_deliveries
      SET delivery_state = 'aborted', resolution_code = 'run_terminal_not_sent', resolved_at = ?
      WHERE run_id = ? AND run_attempt_id = ? AND delivery_state = 'pending'
        AND EXISTS (
          SELECT 1 FROM messages m
          JOIN runs r ON r.id = run_input_deliveries.run_id AND r.session_id = m.session_id
          JOIN run_attempts a ON a.id = run_input_deliveries.run_attempt_id AND a.run_id = r.id
          WHERE m.id = run_input_deliveries.message_id
        )
    `,
    )
    .run(now, command.runId, command.attemptId);
  database
    .prepare(
      `
      UPDATE run_input_deliveries
      SET delivery_state = 'ambiguous', resolution_code = 'process_unknown', resolved_at = ?
      WHERE run_id = ? AND run_attempt_id = ? AND delivery_state = 'dispatching'
        AND EXISTS (
          SELECT 1 FROM messages m
          JOIN runs r ON r.id = run_input_deliveries.run_id AND r.session_id = m.session_id
          JOIN run_attempts a ON a.id = run_input_deliveries.run_attempt_id AND a.run_id = r.id
          WHERE m.id = run_input_deliveries.message_id
        )
    `,
    )
    .run(now, command.runId, command.attemptId);
  const unresolved = database
    .prepare(
      `
      SELECT 1 FROM run_input_deliveries
      WHERE run_id = ? AND run_attempt_id = ? AND delivery_state IN ('pending', 'dispatching')
      LIMIT 1
    `,
    )
    .get(command.runId, command.attemptId);
  return unresolved === undefined
    ? undefined
    : failure("lifecycle_conflict", "Run input delivery terminal resolution conflicted.");
}

function abortPendingDispatch(database: DatabaseSync, attemptId: string, now: number): number {
  return Number(
    database
      .prepare(
        `
        UPDATE run_dispatches SET dispatch_state = 'aborted', resolved_at = ?
        WHERE run_attempt_id = ? AND dispatch_state = 'pending'
      `,
      )
      .run(now, attemptId).changes,
  );
}

function collectChildResult(
  database: DatabaseSync,
  prepared: PreparedChildResultCollect,
  now: number,
  retentionMs: number,
): RepositoryCommandResult<ChildResultCollectResult> {
  const { command } = prepared;
  const row = readCollectRow(database, command.deliveryId);
  if (row === undefined) return failure("not_found", "Child result Delivery was not found.");
  if (
    row.parent_session_id !== command.parentSessionId ||
    row.child_session_id !== command.childSessionId ||
    row.workspace_key !== command.workspaceKey
  ) {
    return failure("reference_invalid", "Child result scope does not match.");
  }
  if (row.availability_state !== "available" || row.terminal_phase_snapshot === null || row.available_at === null) {
    return failure("lifecycle_conflict", "Child result is not available.");
  }
  const parentRun = database
    .prepare("SELECT 1 FROM runs WHERE id = ? AND session_id = ?")
    .get(command.collectingParentRunId, command.parentSessionId);
  if (parentRun === undefined)
    return failure("reference_invalid", "Collecting Run does not belong to the parent Session.");

  const idempotency = checkIdempotency<ChildResultCollectResult>(
    database,
    command.idempotencyKey,
    REPOSITORY_WRITE_OPERATIONS.childResultCollect,
    prepared.fingerprint,
    command.childSessionId,
    "delivery",
    command.deliveryId,
    now,
    (value) => decodeChildResultCollectReplay(database, command.deliveryId, command.childSessionId, value),
  );
  if (idempotency.kind !== "new") return idempotency.result;
  if (database.prepare("SELECT 1 FROM run_events WHERE id = ?").get(command.eventId) !== undefined) {
    return failure("reference_invalid", "Collection event ID is already in use.");
  }

  const firstCollectedBy = row.first_collected_by_parent_run_id ?? command.collectingParentRunId;
  const firstCollectedAt = row.first_collected_at ?? now;
  if (row.first_collected_at === null) {
    const update = database
      .prepare(
        `
        UPDATE child_result_deliveries SET first_collected_by_parent_run_id = ?, first_collected_at = ?,
          updated_at = ?, version = version + 1
        WHERE id = ? AND first_collected_at IS NULL
      `,
      )
      .run(command.collectingParentRunId, now, now, command.deliveryId);
    if (update.changes !== 1) return rollbackWith(failure("lifecycle_conflict", "Child result collection conflicted."));
  }
  const eventOrdinal = nextOrdinal(database, "run_events", "run_id", command.collectingParentRunId);
  database
    .prepare(
      `
      INSERT INTO run_events (id, run_id, ordinal, event_code, subject_type, subject_id, dedupe_key, summary, created_at)
      VALUES (?, ?, ?, 'child.result.collected', 'child_result_delivery', ?, ?, ?, ?)
    `,
    )
    .run(
      command.eventId,
      command.collectingParentRunId,
      eventOrdinal,
      command.deliveryId,
      command.idempotencyKey,
      null,
      now,
    );
  const value: ChildResultCollectResult = {
    deliveryId: command.deliveryId,
    delegationId: row.delegation_id,
    childSessionId: row.child_session_id,
    childRunId: row.child_run_id,
    terminalPhase: row.terminal_phase_snapshot,
    finalAssistantMessageId: row.final_assistant_message_id,
    resultSummary: row.result_summary,
    firstCollectedByParentRunId: firstCollectedBy,
    firstCollectedAt,
  };
  completeIdempotency(
    database,
    command.idempotencyKey,
    command.childSessionId,
    REPOSITORY_WRITE_OPERATIONS.childResultCollect,
    prepared.fingerprint,
    "delivery",
    command.deliveryId,
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
  expectedRefType: "session" | "run" | "delivery",
  expectedRefId: string,
  now: number,
  decodeReplay?: (value: unknown) => T | undefined,
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
    !hasResponseReference(database, operation, expectedRefType, expectedRefId, expectedScopeSessionId)
  ) {
    return { kind: "failure", result: failure("reference_invalid", "Idempotent response reference is invalid.") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.response_envelope_json);
  } catch {
    return { kind: "failure", result: failure("reference_invalid", "Idempotent response envelope is invalid.") };
  }
  const replay = decodeReplay === undefined ? (parsed as T) : decodeReplay(parsed);
  if (replay === undefined) {
    return { kind: "failure", result: failure("reference_invalid", "Idempotent response envelope is invalid.") };
  }
  return { kind: "replay", result: success(replay, true) };
}

function decodeChildResultCollectReplay(
  database: DatabaseSync,
  deliveryId: string,
  childSessionId: string,
  value: unknown,
): ChildResultCollectResult | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "deliveryId",
      "delegationId",
      "childSessionId",
      "childRunId",
      "terminalPhase",
      "finalAssistantMessageId",
      "resultSummary",
      "firstCollectedByParentRunId",
      "firstCollectedAt",
    ])
  ) {
    return undefined;
  }
  const row = readCollectRow(database, deliveryId);
  if (
    row === undefined ||
    row.child_session_id !== childSessionId ||
    row.terminal_phase_snapshot === null ||
    row.first_collected_by_parent_run_id === null ||
    row.first_collected_at === null ||
    value.deliveryId !== deliveryId ||
    value.delegationId !== row.delegation_id ||
    value.childSessionId !== row.child_session_id ||
    value.childRunId !== row.child_run_id ||
    value.terminalPhase !== row.terminal_phase_snapshot ||
    value.finalAssistantMessageId !== row.final_assistant_message_id ||
    value.resultSummary !== row.result_summary ||
    value.firstCollectedByParentRunId !== row.first_collected_by_parent_run_id ||
    value.firstCollectedAt !== row.first_collected_at
  ) {
    return undefined;
  }
  return value as ChildResultCollectResult;
}

function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: NormalRunAdmissionCommand,
  value: unknown,
): NormalRunAdmissionResult | undefined;
function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: RetryRunAdmissionCommand,
  value: unknown,
): RetryRunAdmissionResult | undefined;
function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: NormalRunAdmissionCommand | RetryRunAdmissionCommand,
  value: unknown,
): NormalRunAdmissionResult | RetryRunAdmissionResult | undefined {
  const isRetry = "retryOfRunId" in command;
  const keys = [
    "sessionId",
    "messageId",
    "runId",
    "attemptId",
    "bindingId",
    "bindingState",
    "dispatchState",
    "admittedAt",
    ...(isRetry ? ["retryOfRunId"] : []),
  ];
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) return undefined;
  const row = database
    .prepare(
      `
      SELECT r.initiating_message_id, r.retry_of_run_id, r.created_at,
        a.id AS attempt_id, b.id AS binding_id, b.persistence_mode
      FROM runs r
      JOIN sessions s ON s.id = r.session_id
      JOIN run_attempts a ON a.id = ? AND a.run_id = r.id
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      JOIN provider_bindings b ON b.id = ?
        AND (a.provider_binding_id = b.id
          OR (a.provider_binding_id IS NULL AND b.created_by_run_attempt_id = a.id))
        AND b.session_id = r.session_id AND b.provider_id = s.provider_id
      JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
      JOIN runs creator_r ON creator_r.id = creator_a.run_id AND creator_r.session_id = r.session_id
      WHERE r.id = ? AND r.session_id = ? AND s.workspace_key = ?
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
    `,
    )
    .get(
      command.attemptId,
      command.bindingIntent.bindingId,
      command.run.id,
      command.sessionId,
      command.workspaceKey,
    ) as
    | Readonly<{
        initiating_message_id: string;
        retry_of_run_id: string | null;
        created_at: number;
        attempt_id: string;
        binding_id: string;
        persistence_mode: "persistent" | "ephemeral";
      }>
    | undefined;
  const retryOfRunId = isRetry ? command.retryOfRunId : null;
  if (
    row === undefined ||
    row.retry_of_run_id !== retryOfRunId ||
    value.sessionId !== command.sessionId ||
    value.messageId !== row.initiating_message_id ||
    value.runId !== command.run.id ||
    value.attemptId !== row.attempt_id ||
    value.bindingId !== row.binding_id ||
    (command.bindingIntent.kind === "create" && row.persistence_mode !== command.bindingIntent.persistenceMode) ||
    value.bindingState !== (command.bindingIntent.kind === "create" ? "creating" : "active") ||
    value.dispatchState !== "pending" ||
    value.admittedAt !== row.created_at ||
    (isRetry && value.retryOfRunId !== retryOfRunId)
  ) {
    return undefined;
  }
  return value as unknown as NormalRunAdmissionResult | RetryRunAdmissionResult;
}

function decodeChildStartReplay(
  database: DatabaseSync,
  command: ChildStartCommand,
  value: unknown,
): ChildStartResult | undefined {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "parentSessionId",
      "parentRunId",
      "childSessionId",
      "orchestrationRootSessionId",
      "relationId",
      "correlationId",
      "delegationId",
      "deliveryId",
      "messageId",
      "runId",
      "attemptId",
      "bindingId",
      "bindingState",
      "dispatchState",
      "admittedAt",
    ])
  ) {
    return undefined;
  }
  const row = database
    .prepare(
      `
      SELECT sr.parent_session_id, sr.created_by_parent_run_id, sr.child_session_id,
        sr.orchestration_root_session_id, sr.id AS relation_id, sr.correlation_id, sr.created_at,
        g.id AS delegation_id, d.id AS delivery_id, g.initial_instruction_message_id AS message_id,
        r.id AS run_id, a.id AS attempt_id, b.id AS binding_id, b.persistence_mode
      FROM child_result_deliveries d
      JOIN delegations g ON g.id = d.delegation_id
      JOIN session_relations sr ON sr.id = g.session_relation_id
      JOIN runs r ON r.id = d.child_run_id AND r.session_id = sr.child_session_id
      JOIN run_attempts a ON a.run_id = r.id AND a.ordinal = 1
      JOIN sessions child_s ON child_s.id = r.session_id
      JOIN provider_bindings b ON b.created_by_run_attempt_id = a.id
        AND b.session_id = r.session_id AND b.provider_id = child_s.provider_id
      JOIN run_dispatches rd ON rd.run_attempt_id = a.id
      WHERE d.id = ?
    `,
    )
    .get(command.deliveryId) as ChildStartReplayRow | undefined;
  if (
    row === undefined ||
    row.parent_session_id !== command.parentSessionId ||
    row.created_by_parent_run_id !== command.parentRunId ||
    row.child_session_id !== command.childSession.id ||
    row.relation_id !== command.relation.id ||
    row.correlation_id !== command.relation.correlationId ||
    row.delegation_id !== command.delegation.id ||
    row.delivery_id !== command.deliveryId ||
    row.message_id !== command.message.id ||
    row.run_id !== command.run.id ||
    row.attempt_id !== command.attemptId ||
    row.binding_id !== command.binding.id ||
    row.persistence_mode !== command.binding.persistenceMode ||
    value.parentSessionId !== row.parent_session_id ||
    value.parentRunId !== row.created_by_parent_run_id ||
    value.childSessionId !== row.child_session_id ||
    value.orchestrationRootSessionId !== row.orchestration_root_session_id ||
    value.relationId !== row.relation_id ||
    value.correlationId !== row.correlation_id ||
    value.delegationId !== row.delegation_id ||
    value.deliveryId !== row.delivery_id ||
    value.messageId !== row.message_id ||
    value.runId !== row.run_id ||
    value.attemptId !== row.attempt_id ||
    value.bindingId !== row.binding_id ||
    value.bindingState !== "creating" ||
    value.dispatchState !== "pending" ||
    value.admittedAt !== row.created_at
  ) {
    return undefined;
  }
  return value as ChildStartResult;
}

function completeIdempotency<T extends object>(
  database: DatabaseSync,
  key: string,
  scopeSessionId: string,
  operation: string,
  fingerprint: string,
  refType: "session" | "run" | "delivery",
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
  if (allowedAdditionalDirectories === undefined) throw invalidCommand();
  const directoriesJson = JSON.stringify(allowedAdditionalDirectories);
  if (Buffer.byteLength(directoriesJson) > ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes) {
    throw invalidCommand();
  }
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

function prepareRetryRunAdmission(command: RetryRunAdmissionCommand): PreparedRetryRunAdmission {
  const executionSnapshotJson = canonicalJsonString(command.run.executionSnapshot);
  const providerRequestJson = canonicalJsonString(command.dispatch.providerRequest);
  if (Buffer.byteLength(executionSnapshotJson) > 256 * 1024 || Buffer.byteLength(providerRequestJson) > 256 * 1024) {
    throw invalidCommand();
  }
  const dispatchFingerprint = fingerprintJson(providerRequestJson);
  return {
    command,
    executionSnapshotJson,
    dispatchFingerprint,
    fingerprint: fingerprint({
      operation: "run.retry",
      sessionId: command.sessionId,
      workspaceKey: command.workspaceKey,
      retryOfRunId: command.retryOfRunId,
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

function prepareChildStart(command: ChildStartCommand): PreparedChildStart {
  const allowedAdditionalDirectories = normalizeAllowedAdditionalDirectories(
    command.childSession.allowedAdditionalDirectories,
  );
  if (allowedAdditionalDirectories === undefined) throw invalidCommand();
  const directoriesJson = JSON.stringify(allowedAdditionalDirectories);
  const contentBlocksJson = canonicalJsonString(command.message.contentBlocks);
  const executionSnapshotJson = canonicalJsonString(command.run.executionSnapshot);
  const providerRequestJson = canonicalJsonString(command.dispatch.providerRequest);
  if (
    Buffer.byteLength(directoriesJson) > ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes ||
    Buffer.byteLength(contentBlocksJson) > 4 * 1024 * 1024 ||
    Buffer.byteLength(executionSnapshotJson) > 256 * 1024 ||
    Buffer.byteLength(providerRequestJson) > 256 * 1024
  ) {
    throw invalidCommand();
  }
  const dispatchFingerprint = fingerprintJson(providerRequestJson);
  return {
    command,
    directoriesJson,
    contentBlocksJson,
    executionSnapshotJson,
    dispatchFingerprint,
    fingerprint: fingerprintJson(
      canonicalJsonString({
        operation: REPOSITORY_WRITE_OPERATIONS.childStart,
        parentSessionId: command.parentSessionId,
        parentRunId: command.parentRunId,
        workspaceKey: command.workspaceKey,
        childSession: {
          ...command.childSession,
          allowedAdditionalDirectories,
        },
        relation: command.relation,
        delegation: command.delegation,
        message: { id: command.message.id, contentBlocks: JSON.parse(contentBlocksJson) },
        run: { id: command.run.id, executionSnapshot: JSON.parse(executionSnapshotJson) },
        attemptId: command.attemptId,
        binding: command.binding,
        dispatch: {
          requestFingerprint: dispatchFingerprint,
          providerIdempotencyKey: command.dispatch.providerIdempotencyKey,
        },
        deliveryId: command.deliveryId,
      }),
    ),
  };
}

function prepareRunDispatchBegin(command: RunDispatchBeginCommand): PreparedRunDispatchBegin {
  const providerRequestJson = canonicalJsonString(command.providerRequest);
  if (Buffer.byteLength(providerRequestJson) > 256 * 1024) throw invalidCommand();
  return { command, requestFingerprint: fingerprintJson(providerRequestJson) };
}

function prepareRunInputAdmission(command: RunInputAdmissionCommand): PreparedRunInputAdmission {
  const contentBlocksJson = canonicalJsonString(command.message.contentBlocks);
  if (Buffer.byteLength(contentBlocksJson) > 4 * 1024 * 1024) throw invalidCommand();
  return {
    command,
    contentBlocksJson,
    fingerprint: fingerprint({
      operation: "run.input.admit",
      sessionId: command.sessionId,
      workspaceKey: command.workspaceKey,
      runId: command.runId,
      attemptId: command.attemptId,
      message: { id: command.message.id, contentBlocks: JSON.parse(contentBlocksJson) },
    }),
  };
}

function prepareRunOutputAppend(command: RunOutputAppendCommand): PreparedRunOutputAppend {
  return { command, payload: prepareStoredPayload(command.item.payload) };
}

function prepareRunOutputResolvePending(command: RunOutputResolvePendingCommand): PreparedRunOutputResolvePending {
  return {
    command,
    payload:
      command.resolution.state === "stored"
        ? preparePayloadBytes({
            state: "stored",
            originalByteLength: 0,
            redactionState: "not_required",
            payloadFormat: command.resolution.payloadFormat,
            mediaType: command.resolution.mediaType,
            content: command.resolution.content,
          })
        : undefined,
  };
}

function prepareRunTerminal(command: RunTerminalCommand): PreparedRunTerminal {
  const finalMessageJson =
    command.outcome.kind === "completed" && command.outcome.finalAssistantMessage !== null
      ? canonicalJsonString(command.outcome.finalAssistantMessage.contentBlocks)
      : null;
  if (finalMessageJson !== null && Buffer.byteLength(finalMessageJson) > 4 * 1024 * 1024) throw invalidCommand();
  return {
    command,
    finalMessageJson,
    // Keep exact-replay identity stable after a pending output resolves without exposing it through RunEvent.summary.
    terminalDedupeKey: fingerprintJson(
      canonicalJsonString({ operation: REPOSITORY_WRITE_OPERATIONS.runTerminal, command }),
    ),
  };
}

function prepareChildResultCollect(command: ChildResultCollectCommand): PreparedChildResultCollect {
  return {
    command,
    fingerprint: fingerprint({
      operation: "child-result.collect",
      parentSessionId: command.parentSessionId,
      childSessionId: command.childSessionId,
      workspaceKey: command.workspaceKey,
      deliveryId: command.deliveryId,
      collectingParentRunId: command.collectingParentRunId,
      eventId: command.eventId,
    }),
  };
}

function prepareStoredPayload(payload: RunOutputPayloadCommand): PreparedStoredPayload | undefined {
  return payload.state === "stored" ? preparePayloadBytes(payload) : undefined;
}

function preparePayloadBytes(
  payload: Extract<RunOutputPayloadCommand, Readonly<{ state: "stored" }>>,
): PreparedStoredPayload {
  const content = Buffer.from(payload.content);
  if (payload.payloadFormat === "text" || payload.payloadFormat === "json") {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
      if (payload.payloadFormat === "json") JSON.parse(decoded);
    } catch {
      throw invalidCommand();
    }
  }
  return {
    ...payload,
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
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
    !isDenseBoundedStringArray(
      session.allowedAdditionalDirectories,
      ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxItems,
      ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength,
    ) ||
    !Number.isSafeInteger(session.maxConcurrentChildRuns) ||
    (session.maxConcurrentChildRuns as number) < 0 ||
    (session.maxConcurrentChildRuns as number) > MAX_SESSION_CONCURRENT_CHILD_RUNS
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

function decodeSessionDeleteSubtree(
  payload: Readonly<Record<string, unknown>>,
): DecodeResult<SessionDeleteSubtreeCommand> {
  if (
    !hasExactKeys(payload, ["deletionId", "sessionId", "workspaceKey"]) ||
    !isCanonicalUuid(payload.deletionId) ||
    !isBoundedString(payload.sessionId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024)
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as SessionDeleteSubtreeCommand };
}

function decodeSessionDeletionCleanupComplete(
  payload: Readonly<Record<string, unknown>>,
): DecodeResult<SessionDeletionCleanupCompleteCommand> {
  if (
    !hasExactKeys(payload, ["cleanupToken", "workspaceKey"]) ||
    !isCanonicalUuid(payload.cleanupToken) ||
    !isBoundedString(payload.workspaceKey, 1_024)
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as SessionDeletionCleanupCompleteCommand };
}

function decodeStartupRepair(
  payload: Readonly<Record<string, unknown>>,
): DecodeResult<Readonly<Record<string, never>>> {
  return hasExactKeys(payload, []) ? { ok: true, value: {} } : decodeFailure();
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

function decodeRetryRunAdmission(payload: Readonly<Record<string, unknown>>): DecodeResult<RetryRunAdmissionCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "idempotencyKey",
      "retryOfRunId",
      "run",
      "attemptId",
      "bindingIntent",
      "dispatch",
    ]) ||
    !isBoundedString(payload.sessionId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isBoundedString(payload.retryOfRunId, 1_024) ||
    !isBoundedString(payload.attemptId, 1_024) ||
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
  return { ok: true, value: payload as unknown as RetryRunAdmissionCommand };
}

function decodeChildStart(payload: Readonly<Record<string, unknown>>): DecodeResult<ChildStartCommand> {
  if (
    !hasExactKeys(payload, [
      "parentSessionId",
      "parentRunId",
      "workspaceKey",
      "idempotencyKey",
      "childSession",
      "relation",
      "delegation",
      "message",
      "run",
      "attemptId",
      "binding",
      "dispatch",
      "deliveryId",
    ]) ||
    !isBoundedString(payload.parentSessionId, 1_024) ||
    !isBoundedString(payload.parentRunId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isBoundedString(payload.attemptId, 1_024) ||
    !isBoundedString(payload.deliveryId, 1_024) ||
    !isPlainObject(payload.childSession) ||
    !hasExactKeys(payload.childSession, [
      "id",
      "providerId",
      "allowedAdditionalDirectories",
      "defaultCharacterId",
      "maxConcurrentChildRuns",
    ]) ||
    !isBoundedString(payload.childSession.id, 1_024) ||
    !isBoundedString(payload.childSession.providerId, 1_024) ||
    !isDenseBoundedStringArray(
      payload.childSession.allowedAdditionalDirectories,
      ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxItems,
      ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength,
    ) ||
    !isBoundedString(payload.childSession.defaultCharacterId, 1_024) ||
    !Number.isSafeInteger(payload.childSession.maxConcurrentChildRuns) ||
    (payload.childSession.maxConcurrentChildRuns as number) < 0 ||
    (payload.childSession.maxConcurrentChildRuns as number) > MAX_SESSION_CONCURRENT_CHILD_RUNS ||
    !isPlainObject(payload.relation) ||
    !hasExactKeys(payload.relation, ["id", "correlationId", "label", "purposeSummary"]) ||
    !isBoundedString(payload.relation.id, 1_024) ||
    !isBoundedString(payload.relation.correlationId, 1_024) ||
    !isNullableBoundedText(payload.relation.label, 128) ||
    !isNullableBoundedText(payload.relation.purposeSummary, 512) ||
    !isPlainObject(payload.delegation) ||
    !hasExactKeys(payload.delegation, ["id", "mentionText"]) ||
    !isBoundedString(payload.delegation.id, 1_024) ||
    !isNullableBoundedText(payload.delegation.mentionText, 128) ||
    !isPlainObject(payload.message) ||
    !hasExactKeys(payload.message, ["id", "contentBlocks"]) ||
    !isBoundedString(payload.message.id, 1_024) ||
    !isDenseJsonArray(payload.message.contentBlocks, 10_000) ||
    !isPlainObject(payload.run) ||
    !hasExactKeys(payload.run, ["id", "executionSnapshot"]) ||
    !isBoundedString(payload.run.id, 1_024) ||
    !isRunExecutionSnapshot(payload.run.executionSnapshot) ||
    !isPlainObject(payload.binding) ||
    !hasExactKeys(payload.binding, ["id", "persistenceMode"]) ||
    !isBoundedString(payload.binding.id, 1_024) ||
    (payload.binding.persistenceMode !== "persistent" && payload.binding.persistenceMode !== "ephemeral") ||
    !isPlainObject(payload.dispatch) ||
    !hasExactKeys(payload.dispatch, ["providerRequest", "providerIdempotencyKey"]) ||
    !isPlainObject(payload.dispatch.providerRequest) ||
    !isJsonValue(payload.dispatch.providerRequest) ||
    (payload.dispatch.providerIdempotencyKey !== null &&
      !isBoundedString(payload.dispatch.providerIdempotencyKey, 4_096))
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as ChildStartCommand };
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
  if (
    resolution.kind !== "active" ||
    !hasExactKeys(resolution, ["kind", "externalConversationId", "ephemeralOwnerToken"]) ||
    !isBoundedString(resolution.externalConversationId, 4_096) ||
    (resolution.ephemeralOwnerToken !== null && !isCanonicalUuid(resolution.ephemeralOwnerToken))
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

function decodeRunInputAdmission(payload: Readonly<Record<string, unknown>>): DecodeResult<RunInputAdmissionCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "idempotencyKey",
      "runId",
      "attemptId",
      "ephemeralOwnerToken",
      "message",
    ]) ||
    !isBoundedString(payload.sessionId, 1_024) ||
    !isBoundedString(payload.workspaceKey, 1_024) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isBoundedString(payload.runId, 1_024) ||
    !isBoundedString(payload.attemptId, 1_024) ||
    (payload.ephemeralOwnerToken !== null && !isCanonicalUuid(payload.ephemeralOwnerToken)) ||
    !isPlainObject(payload.message) ||
    !hasExactKeys(payload.message, ["id", "contentBlocks"]) ||
    !isBoundedString(payload.message.id, 1_024) ||
    !isDenseJsonArray(payload.message.contentBlocks, 10_000)
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunInputAdmissionCommand };
}

function decodeRunInputBegin(payload: Readonly<Record<string, unknown>>): DecodeResult<RunInputBeginCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "runId",
      "attemptId",
      "messageId",
      "bindingId",
      "ephemeralOwnerToken",
    ]) ||
    !hasRunInputScope(payload) ||
    (payload.ephemeralOwnerToken !== null && !isCanonicalUuid(payload.ephemeralOwnerToken))
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunInputBeginCommand };
}

function decodeRunInputResolution(payload: Readonly<Record<string, unknown>>): DecodeResult<RunInputResolutionCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "runId",
      "attemptId",
      "messageId",
      "bindingId",
      "ephemeralOwnerToken",
      "outcome",
    ]) ||
    !hasRunInputScope(payload) ||
    (payload.ephemeralOwnerToken !== null && !isCanonicalUuid(payload.ephemeralOwnerToken)) ||
    !isPlainObject(payload.outcome)
  ) {
    return decodeFailure();
  }
  const outcome = payload.outcome;
  if (outcome.kind === "accepted") {
    if (!hasExactKeys(outcome, ["kind"])) return decodeFailure();
  } else if (
    (outcome.kind !== "rejected" && outcome.kind !== "ambiguous") ||
    !hasExactKeys(outcome, ["kind", "resolutionCode"]) ||
    !isRunInputResolutionCode(outcome.resolutionCode) ||
    (outcome.kind === "rejected" && outcome.resolutionCode !== "provider_rejected") ||
    (outcome.kind === "ambiguous" &&
      outcome.resolutionCode !== "transport_unknown" &&
      outcome.resolutionCode !== "process_unknown")
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunInputResolutionCommand };
}

function decodeRunOutputAppend(payload: Readonly<Record<string, unknown>>): DecodeResult<RunOutputAppendCommand> {
  if (
    !hasExactKeys(payload, ["sessionId", "workspaceKey", "runId", "item"]) ||
    !isBoundedString(payload.sessionId, 1024) ||
    !isBoundedString(payload.workspaceKey, 1024) ||
    !isBoundedString(payload.runId, 1024) ||
    !isRunOutputDraft(payload.item, false)
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunOutputAppendCommand };
}

function decodeRunOutputResolvePending(
  payload: Readonly<Record<string, unknown>>,
): DecodeResult<RunOutputResolvePendingCommand> {
  if (
    !hasExactKeys(payload, ["sessionId", "workspaceKey", "runId", "outputItemId", "resolution"]) ||
    !isBoundedString(payload.sessionId, 1024) ||
    !isBoundedString(payload.workspaceKey, 1024) ||
    !isBoundedString(payload.runId, 1024) ||
    !isBoundedString(payload.outputItemId, 1024) ||
    !isPlainObject(payload.resolution)
  ) {
    return decodeFailure();
  }
  const resolution = payload.resolution;
  if (resolution.state === "stored") {
    if (
      !hasExactKeys(resolution, ["state", "payloadFormat", "mediaType", "content"]) ||
      !isPayloadFormat(resolution.payloadFormat) ||
      !(resolution.mediaType === null || isBoundedString(resolution.mediaType, 256)) ||
      !(resolution.content instanceof Uint8Array)
    ) {
      return decodeFailure();
    }
  } else if (
    (resolution.state !== "omitted_size_limit" && resolution.state !== "omitted_persistence") ||
    !hasExactKeys(resolution, ["state"])
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunOutputResolvePendingCommand };
}

function decodeRunTerminal(payload: Readonly<Record<string, unknown>>): DecodeResult<RunTerminalCommand> {
  if (
    !hasExactKeys(payload, [
      "sessionId",
      "workspaceKey",
      "runId",
      "attemptId",
      "terminalEvent",
      "preDispatchResolution",
      "outcome",
      "outputs",
      "childResult",
    ]) ||
    !isBoundedString(payload.sessionId, 1024) ||
    !isBoundedString(payload.workspaceKey, 1024) ||
    !isBoundedString(payload.runId, 1024) ||
    !isBoundedString(payload.attemptId, 1024) ||
    !isPlainObject(payload.terminalEvent) ||
    !hasExactKeys(payload.terminalEvent, ["id", "dedupeKey"]) ||
    !isBoundedString(payload.terminalEvent.id, 1024) ||
    !isBoundedString(payload.terminalEvent.dedupeKey, 1024) ||
    !isRunTerminalPreDispatchResolution(payload.preDispatchResolution) ||
    !isRunTerminalOutcome(payload.outcome) ||
    !isDenseTerminalOutputs(payload.outputs) ||
    !isChildTerminalResult(payload.childResult)
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as RunTerminalCommand };
}

function decodeChildResultCollect(payload: Readonly<Record<string, unknown>>): DecodeResult<ChildResultCollectCommand> {
  if (
    !hasExactKeys(payload, [
      "parentSessionId",
      "childSessionId",
      "workspaceKey",
      "idempotencyKey",
      "deliveryId",
      "collectingParentRunId",
      "eventId",
    ]) ||
    !isBoundedString(payload.parentSessionId, 1024) ||
    !isBoundedString(payload.childSessionId, 1024) ||
    !isBoundedString(payload.workspaceKey, 1024) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isBoundedString(payload.deliveryId, 1024) ||
    !isBoundedString(payload.collectingParentRunId, 1024) ||
    !isBoundedString(payload.eventId, 1024)
  ) {
    return decodeFailure();
  }
  return { ok: true, value: payload as unknown as ChildResultCollectCommand };
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

function findRunCapacityExceeded(
  database: DatabaseSync,
  providerId: string,
  maxConcurrentRuns: number,
  maxConcurrentRunsPerProvider: number,
): RepositoryCapacityExceededDetails | undefined {
  const nonTerminal = "('queued','starting','active','canceling','finalizing')";
  const total = database.prepare(`SELECT count(*) AS count FROM runs WHERE phase IN ${nonTerminal}`).get() as {
    count: number;
  };
  if (total.count >= maxConcurrentRuns) {
    return { scope: "application", current: total.count, limit: maxConcurrentRuns };
  }
  const provider = database
    .prepare(
      `
      SELECT count(*) AS count FROM runs r
      JOIN sessions s ON s.id = r.session_id
      WHERE r.phase IN ${nonTerminal} AND s.provider_id = ?
    `,
    )
    .get(providerId) as { count: number };
  if (provider.count >= maxConcurrentRunsPerProvider) {
    return {
      scope: "provider",
      providerId,
      current: provider.count,
      limit: maxConcurrentRunsPerProvider,
    };
  }
  return undefined;
}

function countNonTerminalChildren(database: DatabaseSync, rootSessionId: string): number {
  const row = database
    .prepare(
      `
      SELECT count(*) AS count
      FROM runs r
      JOIN session_relations sr ON sr.child_session_id = r.session_id
      WHERE sr.orchestration_root_session_id = ?
        AND r.phase IN ('queued','starting','active','canceling','finalizing')
    `,
    )
    .get(rootSessionId) as { count: number };
  return row.count;
}

function selectStringIds(database: DatabaseSync, sql: string, ...params: string[]): string[] {
  return (database.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id);
}

function hasChildStartIdentityConflict(database: DatabaseSync, command: ChildStartCommand): boolean {
  return (
    database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(command.childSession.id) !== undefined ||
    database.prepare("SELECT 1 FROM messages WHERE id = ?").get(command.message.id) !== undefined ||
    database.prepare("SELECT 1 FROM runs WHERE id = ?").get(command.run.id) !== undefined ||
    database.prepare("SELECT 1 FROM run_attempts WHERE id = ?").get(command.attemptId) !== undefined ||
    database.prepare("SELECT 1 FROM provider_bindings WHERE id = ?").get(command.binding.id) !== undefined ||
    database
      .prepare("SELECT 1 FROM session_relations WHERE id = ? OR correlation_id = ?")
      .get(command.relation.id, command.relation.correlationId) !== undefined ||
    database.prepare("SELECT 1 FROM delegations WHERE id = ?").get(command.delegation.id) !== undefined ||
    database.prepare("SELECT 1 FROM child_result_deliveries WHERE id = ?").get(command.deliveryId) !== undefined
  );
}

function hasAdmissionIdentityConflict(database: DatabaseSync, command: NormalRunAdmissionCommand): boolean {
  return (
    database.prepare("SELECT 1 FROM messages WHERE id = ?").get(command.message.id) !== undefined ||
    hasRunAdmissionIdentityConflict(database, command.run.id, command.attemptId, command.bindingIntent)
  );
}

function hasRunAdmissionIdentityConflict(
  database: DatabaseSync,
  runId: string,
  attemptId: string,
  bindingIntent: RunAdmissionBindingIntent,
): boolean {
  return (
    database.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId) !== undefined ||
    database.prepare("SELECT 1 FROM run_attempts WHERE id = ?").get(attemptId) !== undefined ||
    (bindingIntent.kind === "create" &&
      database.prepare("SELECT 1 FROM provider_bindings WHERE id = ?").get(bindingIntent.bindingId) !== undefined)
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
        a.provider_binding_id,
        a.attempt_state,
        r.phase AS run_phase,
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
    row.binding_state === "active" &&
    row.external_conversation_id === command.resolution.externalConversationId &&
    row.provider_binding_id === command.bindingId
  ) {
    const ephemeralOwnership =
      row.persistence_mode === "persistent"
        ? "not_applicable"
        : ephemeralBindingOwners.get(command.bindingId) === command.resolution.ephemeralOwnerToken
          ? "registered"
          : "unavailable";
    return {
      result: success(
        bindingResolutionValue(command, command.resolution.externalConversationId, ephemeralOwnership),
        true,
      ),
    };
  }
  return undefined;
}

function bindingResolutionValue(
  command: ProviderBindingResolutionCommand,
  externalConversationId: string,
  ephemeralOwnership: ProviderBindingResolutionResult["ephemeralOwnership"],
): ProviderBindingResolutionResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    bindingId: command.bindingId,
    bindingState: "active",
    externalConversationId,
    ephemeralOwnership,
  };
}

function bindingResolutionFailure(
  result: RepositoryCommandResult<ProviderBindingResolutionResult>,
): ProviderBindingResolutionExecution {
  return { result };
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
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = s.id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      WHERE s.id = ? AND s.workspace_key = ? AND r.id = ? AND a.id = ?
    `,
    )
    .get(command.bindingId, command.sessionId, command.workspaceKey, command.runId, command.attemptId) as
    DispatchTransitionRow | undefined;
}

function readRunInputTransitionRow(database: DatabaseSync, command: RunInputScope): RunInputTransitionRow | undefined {
  return database
    .prepare(
      `
      SELECT s.lifecycle_status, r.phase AS run_phase,
        a.provider_binding_id, a.attempt_state,
        b.persistence_mode, b.binding_state, b.external_conversation_id,
        d.dispatch_state,
        i.delivery_state, i.resolution_code, i.dispatching_at, i.resolved_at
      FROM run_input_deliveries i
      JOIN messages m ON m.id = i.message_id
      JOIN runs r ON r.id = i.run_id AND r.session_id = m.session_id
      JOIN run_attempts a ON a.id = i.run_attempt_id AND a.run_id = r.id
      JOIN sessions s ON s.id = r.session_id
      JOIN provider_bindings b ON b.id = ? AND b.session_id = s.id AND b.provider_id = s.provider_id
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = s.id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      JOIN run_dispatches d ON d.run_attempt_id = a.id
      WHERE i.message_id = ? AND s.id = ? AND s.workspace_key = ? AND r.id = ? AND a.id = ?
    `,
    )
    .get(
      command.bindingId,
      command.messageId,
      command.sessionId,
      command.workspaceKey,
      command.runId,
      command.attemptId,
    ) as RunInputTransitionRow | undefined;
}

function readRunInputAdmissionResult(
  database: DatabaseSync,
  messageId: string,
  sessionId: string,
): RunInputAdmissionResult | undefined {
  const row = database
    .prepare(
      `
      SELECT i.message_id, i.run_id, i.run_attempt_id, i.delivery_state,
        i.resolution_code, i.created_at, i.dispatching_at, i.resolved_at,
        b.id AS provider_binding_id
      FROM run_input_deliveries i
      JOIN messages m ON m.id = i.message_id AND m.session_id = ?
      JOIN run_attempts a ON a.id = i.run_attempt_id AND a.run_id = i.run_id
      JOIN runs r ON r.id = i.run_id AND r.session_id = m.session_id
      JOIN sessions s ON s.id = r.session_id
      JOIN provider_bindings b ON b.id = a.provider_binding_id
        AND b.session_id = r.session_id AND b.provider_id = s.provider_id
        AND EXISTS (
          SELECT 1
          FROM run_attempts creator_a
          JOIN runs creator_r ON creator_r.id = creator_a.run_id
          WHERE creator_a.id = b.created_by_run_attempt_id
            AND creator_r.session_id = r.session_id
        )
        AND (b.persistence_mode = 'persistent' OR b.created_by_run_attempt_id = a.id)
      WHERE i.message_id = ?
    `,
    )
    .get(sessionId, messageId) as RunInputOutcomeRow | undefined;
  if (row === undefined || row.provider_binding_id === null) return undefined;
  return {
    sessionId,
    runId: row.run_id,
    attemptId: row.run_attempt_id,
    messageId: row.message_id,
    bindingId: row.provider_binding_id,
    deliveryState: row.delivery_state === "dispatching" ? "pending" : row.delivery_state,
    resolutionCode: row.resolution_code,
    admittedAt: row.created_at,
    dispatchingAt: row.dispatching_at,
    resolvedAt: row.resolved_at,
  };
}

function validateDispatchOwnership<T>(
  bindingId: string,
  ephemeralOwnerToken: string | null,
  row: BindingOwnershipRow,
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

function validateResolutionOwnership<T>(
  bindingId: string,
  ephemeralOwnerToken: string | null,
  row: BindingOwnershipRow,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<T> | undefined {
  const tokenFailure = validateExplicitResolutionToken<T>(bindingId, ephemeralOwnerToken, row, ephemeralBindingOwners);
  if (tokenFailure !== undefined) return tokenFailure;
  if (row.binding_state !== "active" || row.external_conversation_id === null) {
    return failure("reference_invalid", "Run resolution requires an active Provider binding.");
  }
  return undefined;
}

function validateExplicitResolutionToken<T>(
  bindingId: string,
  ephemeralOwnerToken: string | null,
  row: BindingOwnershipRow,
  ephemeralBindingOwners: ReadonlyMap<string, string>,
): RepositoryCommandResult<T> | undefined {
  if (ephemeralOwnerToken === null) return undefined;
  if (row.persistence_mode === "persistent") {
    return failure("request_invalid", "Persistent Binding does not accept ephemeral ownership.");
  }
  return ephemeralBindingOwners.get(bindingId) === ephemeralOwnerToken
    ? undefined
    : failure("reference_invalid", "Ephemeral Binding live ownership token does not match.");
}

function readTerminalEphemeralBindingId(database: DatabaseSync, command: RunTerminalCommand): string | undefined {
  const row = database
    .prepare(
      `
      SELECT b.id FROM run_attempts a
      JOIN runs r ON r.id = a.run_id
      JOIN sessions s ON s.id = r.session_id
      JOIN provider_bindings b ON b.id = a.provider_binding_id
        AND b.session_id = r.session_id AND b.provider_id = s.provider_id
        AND b.created_by_run_attempt_id = a.id
      WHERE a.id = ? AND a.run_id = ? AND r.session_id = ? AND s.workspace_key = ?
        AND b.persistence_mode = 'ephemeral'
    `,
    )
    .get(command.attemptId, command.runId, command.sessionId, command.workspaceKey) as { id: string } | undefined;
  return row?.id;
}

function runInputBeginValue(
  command: RunInputBeginCommand,
  dispatchingAt: number,
  sendAllowed: boolean,
): RunInputBeginResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    messageId: command.messageId,
    bindingId: command.bindingId,
    deliveryState: "dispatching",
    dispatchingAt,
    sendAllowed,
  };
}

function replayRunInputResolution(
  command: RunInputResolutionCommand,
  row: RunInputTransitionRow,
): RepositoryCommandResult<RunInputResolutionResult> | undefined {
  if (
    row.delivery_state === command.outcome.kind &&
    row.resolved_at !== null &&
    row.provider_binding_id === command.bindingId &&
    row.resolution_code === (command.outcome.kind === "accepted" ? null : command.outcome.resolutionCode)
  ) {
    return success(runInputResolutionValue(command, row.resolution_code, row.resolved_at), true);
  }
  return undefined;
}

function runInputResolutionValue(
  command: RunInputResolutionCommand,
  resolutionCode: RunInputResolutionCode | null,
  resolvedAt: number,
): RunInputResolutionResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    messageId: command.messageId,
    bindingId: command.bindingId,
    deliveryState: command.outcome.kind,
    resolutionCode,
    resolvedAt,
  };
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

function resolveAdmissionBinding<T>(
  database: DatabaseSync,
  command: RunAdmissionCommand,
  providerId: string,
): BindingResolution<T> {
  const openBindings = database
    .prepare(
      `
      SELECT b.id, b.provider_id, b.persistence_mode, b.binding_state,
        creator_r.session_id AS creator_session_id, s.provider_id AS session_provider_id
      FROM provider_bindings b
      LEFT JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
      LEFT JOIN runs creator_r ON creator_r.id = creator_a.run_id
      JOIN sessions s ON s.id = b.session_id
      WHERE b.session_id = ? AND b.binding_state IN ('creating', 'active')
    `,
    )
    .all(command.sessionId) as unknown as readonly Readonly<{
    id: string;
    provider_id: string;
    persistence_mode: "persistent" | "ephemeral";
    binding_state: "creating" | "active";
    creator_session_id: string | null;
    session_provider_id: string;
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
    binding.provider_id !== binding.session_provider_id ||
    binding.creator_session_id !== command.sessionId ||
    binding.persistence_mode !== "persistent" ||
    binding.binding_state !== "active"
  ) {
    return { ok: false, result: failure("reference_invalid", "Active Provider binding does not match.") };
  }
  return { ok: true, providerBindingId: binding.id };
}

function nextOrdinal(
  database: DatabaseSync,
  table: "messages" | "runs" | "provider_bindings" | "run_output_items" | "run_events",
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
  operation: string,
  refType: "session" | "run" | "delivery",
  refId: string,
  scopeSessionId: string,
): boolean {
  if (refType === "session") {
    return refId === scopeSessionId && database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(refId) !== undefined;
  }
  if (refType === "delivery") {
    if (operation === REPOSITORY_WRITE_OPERATIONS.childStart) {
      return (
        database
          .prepare(
            `
            SELECT 1 FROM child_result_deliveries d
            JOIN delegations g ON g.id = d.delegation_id
            JOIN session_relations sr ON sr.id = g.session_relation_id
            WHERE d.id = ? AND sr.parent_session_id = ?
          `,
          )
          .get(refId, scopeSessionId) !== undefined
      );
    }
    if (operation === REPOSITORY_WRITE_OPERATIONS.childResultCollect) {
      return (
        database
          .prepare(
            `
            SELECT 1 FROM child_result_deliveries d
            JOIN runs r ON r.id = d.child_run_id
            WHERE d.id = ? AND r.session_id = ?
          `,
          )
          .get(refId, scopeSessionId) !== undefined
      );
    }
    return (
      database
        .prepare(
          `
          SELECT 1 FROM run_input_deliveries i
          JOIN messages m ON m.id = i.message_id
          WHERE i.message_id = ? AND m.session_id = ?
        `,
        )
        .get(refId, scopeSessionId) !== undefined
    );
  }
  return (
    database.prepare("SELECT 1 FROM runs WHERE id = ? AND session_id = ?").get(refId, scopeSessionId) !== undefined
  );
}

function canResumeProviderBinding(database: DatabaseSync, sessionId: string, providerId: string): boolean {
  const rows = database
    .prepare(
      `
      SELECT b.provider_id, b.persistence_mode, b.binding_state,
        creator_r.session_id AS creator_session_id, s.provider_id AS session_provider_id
      FROM provider_bindings b
      LEFT JOIN run_attempts creator_a ON creator_a.id = b.created_by_run_attempt_id
      LEFT JOIN runs creator_r ON creator_r.id = creator_a.run_id
      JOIN sessions s ON s.id = b.session_id
      WHERE b.session_id = ? AND b.binding_state IN ('creating', 'active')
    `,
    )
    .all(sessionId) as unknown as readonly Readonly<{
    provider_id: string;
    persistence_mode: "persistent" | "ephemeral";
    binding_state: "creating" | "active";
    creator_session_id: string | null;
    session_provider_id: string;
  }>[];
  return (
    rows.length === 0 ||
    (rows.length === 1 &&
      rows[0]?.binding_state === "active" &&
      rows[0].persistence_mode === "persistent" &&
      rows[0].provider_id === providerId &&
      rows[0].provider_id === rows[0].session_provider_id &&
      rows[0].creator_session_id === sessionId)
  );
}

function resolvePayloadLimits(overrides: Partial<typeof RUN_OUTPUT_PAYLOAD_LIMITS> | undefined): ResolvedPayloadLimits {
  const limits = { ...RUN_OUTPUT_PAYLOAD_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > RUN_OUTPUT_PAYLOAD_LIMITS[name as keyof typeof limits]) {
      throw new RangeError(`Payload limit ${name} must not exceed its safety ceiling.`);
    }
  }
  return limits;
}

function createDiskCapacityProbe(databasePath: string | undefined): DiskCapacityProbe {
  if (databasePath === undefined || databasePath === ":memory:") {
    return () => ({ availableBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER });
  }
  return () => {
    const stats = fs.statfsSync(path.dirname(databasePath));
    return {
      availableBytes: boundedFsBytes(stats.bavail, stats.bsize),
      totalBytes: boundedFsBytes(stats.blocks, stats.bsize),
    };
  };
}

function boundedFsBytes(blocks: number | bigint, blockSize: number | bigint): number {
  const value = BigInt(blocks) * BigInt(blockSize);
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

function canStorePayload(
  database: DatabaseSync,
  runId: string,
  sessionId: string,
  payload: PreparedStoredPayload,
  limits: ResolvedPayloadLimits,
  diskCapacity: DiskCapacityProbe,
): boolean {
  const storedBytes = payload.content.byteLength;
  if (payload.originalByteLength > limits.itemBytes || storedBytes > limits.itemBytes) return false;
  const sums = database
    .prepare(
      `
      SELECT
        COALESCE(SUM(CASE WHEN o.run_id = ? THEN p.byte_length ELSE 0 END), 0) AS run_bytes,
        COALESCE(SUM(CASE WHEN r.session_id = ? THEN p.byte_length ELSE 0 END), 0) AS session_bytes,
        COALESCE(SUM(p.byte_length), 0) AS app_bytes
      FROM run_output_payloads p
      JOIN run_output_items o ON o.id = p.output_item_id
      JOIN runs r ON r.id = o.run_id
    `,
    )
    .get(runId, sessionId) as { run_bytes: number; session_bytes: number; app_bytes: number };
  if (
    sums.run_bytes + storedBytes > limits.runBytes ||
    sums.session_bytes + storedBytes > limits.sessionBytes ||
    sums.app_bytes + storedBytes > limits.appBytes
  ) {
    return false;
  }
  try {
    const capacity = diskCapacity();
    const reserve = Math.max(limits.minimumReserveBytes, Math.ceil(capacity.totalBytes * 0.1));
    // The payload BLOB is not the whole commit cost: SQLite may also extend database, index, and WAL pages.
    return capacity.availableBytes - storedBytes - RUN_OUTPUT_SQLITE_WRITE_MARGIN_BYTES >= reserve;
  } catch {
    return false;
  }
}

function insertOutputItem(
  database: DatabaseSync,
  runId: string,
  ordinal: number,
  item: RunOutputDraft | RunTerminalOutputDraft,
  payloadState: RunOutputPayloadCommand["state"] | "pending",
  now: number,
): void {
  const payload = item.payload;
  const originalByteLength = payload.state === "none" ? null : payload.originalByteLength;
  const storedPayloadId = payloadState === "stored" ? item.id : null;
  const redactionState =
    payload.state === "none"
      ? "not_required"
      : payload.state === "omitted_redaction"
        ? "unknown"
        : payload.redactionState;
  database
    .prepare(
      `
      INSERT INTO run_output_items (
        id, run_id, ordinal, category, kind, provider_item_id, summary, completion_state,
        payload_state, payload_original_byte_length, stored_payload_id, redaction_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      item.id,
      runId,
      ordinal,
      item.category,
      item.kind,
      item.providerItemId,
      item.summary,
      item.completionState,
      payloadState,
      originalByteLength,
      storedPayloadId,
      redactionState,
      now,
    );
}

function insertOutputPayload(
  database: DatabaseSync,
  outputItemId: string,
  payload: PreparedStoredPayload,
  now: number,
): void {
  database
    .prepare(
      `
      INSERT INTO run_output_payloads (
        output_item_id, payload_format, media_type, content, byte_length, content_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      outputItemId,
      payload.payloadFormat,
      payload.mediaType,
      payload.content,
      payload.content.byteLength,
      payload.contentSha256,
      now,
    );
}

function readOutputReplayRow(
  database: DatabaseSync,
  runId: string,
  itemId: string,
  providerItemId: string | null,
): OutputReplayRow | undefined {
  return database
    .prepare(
      `
      SELECT o.*, p.payload_format, p.media_type, p.byte_length, p.content_sha256
      FROM run_output_items o
      LEFT JOIN run_output_payloads p ON p.output_item_id = o.id
      WHERE o.run_id = ? AND (o.id = ? OR (? IS NOT NULL AND o.provider_item_id = ?))
    `,
    )
    .get(runId, itemId, providerItemId, providerItemId) as OutputReplayRow | undefined;
}

function outputReplayMatches(database: DatabaseSync, prepared: PreparedRunOutputAppend, row: OutputReplayRow): boolean {
  const item = prepared.command.item;
  if (
    row.id !== item.id ||
    row.category !== item.category ||
    row.kind !== item.kind ||
    row.provider_item_id !== item.providerItemId ||
    row.summary !== item.summary ||
    row.completion_state !== item.completionState ||
    row.payload_original_byte_length !== (item.payload.state === "none" ? null : item.payload.originalByteLength) ||
    row.redaction_state !==
      (item.payload.state === "none"
        ? "not_required"
        : item.payload.state === "omitted_redaction"
          ? "unknown"
          : item.payload.redactionState)
  ) {
    return false;
  }
  if (item.payload.state === "stored") {
    if (row.payload_state === "omitted_size_limit") return row.stored_payload_id === null;
    return (
      row.payload_state === "stored" &&
      prepared.payload !== undefined &&
      row.payload_format === prepared.payload.payloadFormat &&
      row.media_type === prepared.payload.mediaType &&
      row.byte_length === prepared.payload.content.byteLength &&
      row.content_sha256 === prepared.payload.contentSha256
    );
  }
  return (
    row.payload_state === item.payload.state &&
    database.prepare("SELECT 1 FROM run_output_payloads WHERE output_item_id = ?").get(row.id) === undefined
  );
}

function outputAppendValue(sessionId: string, runId: string, row: OutputReplayRow): RunOutputAppendResult {
  return {
    sessionId,
    runId,
    outputItemId: row.id,
    ordinal: row.ordinal,
    payloadState: row.payload_state as RunOutputAppendResult["payloadState"],
    storedByteLength: row.byte_length,
    createdAt: row.created_at,
  };
}

function isWritableOutputPhase(phase: string): boolean {
  return phase === "active" || phase === "canceling" || phase === "finalizing";
}

function resolvedPendingReplayState(
  prepared: PreparedRunOutputResolvePending,
  storedState: string,
): RunOutputResolvePendingResult["payloadState"] | null {
  if (prepared.command.resolution.state === storedState)
    return storedState as RunOutputResolvePendingResult["payloadState"];
  if (prepared.command.resolution.state === "stored" && storedState === "omitted_size_limit")
    return "omitted_size_limit";
  return null;
}

function pendingStoredReplayMatches(
  payload: PreparedStoredPayload,
  row: { byte_length: number; content_sha256: string; payload_format: string; media_type: string | null },
): boolean {
  return (
    row.byte_length === payload.content.byteLength &&
    row.content_sha256 === payload.contentSha256 &&
    row.payload_format === payload.payloadFormat &&
    row.media_type === payload.mediaType
  );
}

function pendingResolutionValue(
  command: RunOutputResolvePendingCommand,
  state: RunOutputResolvePendingResult["payloadState"],
  storedByteLength: number | null,
): RunOutputResolvePendingResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    outputItemId: command.outputItemId,
    payloadState: state,
    storedByteLength,
  };
}

function terminalRunFailureFields(command: RunTerminalCommand): Readonly<{
  failureOrigin: string | null;
  providerErrorCode: string | null;
  errorSummary: string | null;
}> {
  if (command.outcome.kind === "failed" || command.outcome.kind === "interrupted") {
    return {
      failureOrigin: command.outcome.failureOrigin,
      providerErrorCode: command.outcome.providerErrorCode,
      errorSummary: command.outcome.errorSummary,
    };
  }
  return { failureOrigin: null, providerErrorCode: null, errorSummary: null };
}

function terminalAttemptFailureFields(command: RunTerminalCommand): ReturnType<typeof terminalRunFailureFields> {
  if (command.outcome.kind === "canceled") {
    return { failureOrigin: "application", providerErrorCode: null, errorSummary: null };
  }
  return terminalRunFailureFields(command);
}

function hasTerminalIdentityConflict(
  database: DatabaseSync,
  command: RunTerminalCommand,
  terminalDedupeKey: string,
): boolean {
  if (
    database
      .prepare("SELECT 1 FROM run_events WHERE id = ? OR (run_id = ? AND dedupe_key = ?)")
      .get(command.terminalEvent.id, command.runId, terminalDedupeKey) !== undefined
  ) {
    return true;
  }
  const finalMessageId = command.outcome.kind === "completed" ? command.outcome.finalAssistantMessage?.id : undefined;
  if (
    finalMessageId !== undefined &&
    database.prepare("SELECT 1 FROM messages WHERE id = ?").get(finalMessageId) !== undefined
  ) {
    return true;
  }
  return command.outputs.some(
    (output) =>
      database.prepare("SELECT 1 FROM run_output_items WHERE id = ?").get(output.id) !== undefined ||
      (output.providerItemId !== null &&
        database
          .prepare("SELECT 1 FROM run_output_items WHERE run_id = ? AND provider_item_id = ?")
          .get(command.runId, output.providerItemId) !== undefined),
  );
}

function readChildTerminalRow(database: DatabaseSync, runId: string): ChildTerminalRow | undefined {
  return database
    .prepare(
      `
      SELECT d.id AS delivery_id, d.delegation_id, d.availability_state
      FROM child_result_deliveries d
      JOIN delegations g ON g.id = d.delegation_id
      WHERE d.child_run_id = ? AND g.latest_child_run_id = ?
    `,
    )
    .get(runId, runId) as ChildTerminalRow | undefined;
}

function replayTerminalRun(
  database: DatabaseSync,
  prepared: PreparedRunTerminal,
  row: TerminalGateRow,
): RepositoryCommandResult<RunTerminalResult> {
  const { command } = prepared;
  const failureFields = terminalRunFailureFields(command);
  const event = database
    .prepare("SELECT id, dedupe_key, summary FROM run_events WHERE run_id = ? AND event_code = 'run.terminal'")
    .get(command.runId) as { id: string; dedupe_key: string | null; summary: string | null } | undefined;
  const message =
    row.final_assistant_message_id === null
      ? undefined
      : (database
          .prepare("SELECT content_blocks_json FROM messages WHERE id = ? AND session_id = ? AND role = 'assistant'")
          .get(row.final_assistant_message_id, command.sessionId) as { content_blocks_json: string } | undefined);
  const expectedFinalId =
    command.outcome.kind === "completed" ? (command.outcome.finalAssistantMessage?.id ?? null) : null;
  if (
    !terminalPreparationReplayMatches(command, row) ||
    row.phase !== command.outcome.kind ||
    row.final_assistant_message_id !== expectedFinalId ||
    row.failure_origin !== failureFields.failureOrigin ||
    row.provider_error_code !== failureFields.providerErrorCode ||
    row.error_summary !== failureFields.errorSummary ||
    event?.id !== command.terminalEvent.id ||
    event.dedupe_key !== prepared.terminalDedupeKey ||
    event.summary !== null ||
    (prepared.finalMessageJson === null
      ? message !== undefined
      : message?.content_blocks_json !== prepared.finalMessageJson) ||
    !terminalOutputsReplay(database, command.runId, command.outputs)
  ) {
    return failure("lifecycle_conflict", "Run terminal outcome differs from the replay.");
  }
  const child = database
    .prepare("SELECT id, terminal_phase_snapshot, result_summary FROM child_result_deliveries WHERE child_run_id = ?")
    .get(command.runId) as { id: string; terminal_phase_snapshot: string; result_summary: string | null } | undefined;
  if (
    (child === undefined) !== (command.childResult === null) ||
    (child !== undefined &&
      (child.terminal_phase_snapshot !== command.outcome.kind ||
        child.result_summary !== command.childResult?.resultSummary))
  ) {
    return failure("lifecycle_conflict", "Child terminal result differs from the replay.");
  }
  return success(
    terminalResult(
      command,
      expectedFinalId,
      command.terminalEvent.id,
      child?.id ?? null,
      command.childResult?.workflowState ?? null,
      row.terminal_at as number,
    ),
    true,
  );
}

function terminalPreparationReplayMatches(command: RunTerminalCommand, row: TerminalGateRow): boolean {
  const resolution = command.preDispatchResolution.kind;
  if (resolution === "binding_creation_not_sent" || resolution === "binding_creation_ambiguous") {
    return (
      row.binding_state === "invalidated" &&
      row.invalidation_reason ===
        (resolution === "binding_creation_not_sent" ? "conversation_start_not_sent" : "conversation_start_ambiguous") &&
      row.created_by_run_attempt_id === command.attemptId &&
      row.dispatch_state === "aborted"
    );
  }
  if (resolution === "dispatch_not_sent") {
    return (
      row.dispatch_state === "aborted" &&
      row.provider_binding_id === row.binding_id &&
      (row.persistence_mode === "persistent" ||
        (row.persistence_mode === "ephemeral" &&
          row.binding_state === "invalidated" &&
          row.invalidation_reason === "ephemeral_run_terminal"))
    );
  }
  if (row.binding_state === "creating" || isUnresolvedTerminalDispatch(row.dispatch_state)) {
    return false;
  }
  return (
    row.persistence_mode !== "ephemeral" ||
    (row.binding_state === "invalidated" && row.invalidation_reason === "ephemeral_run_terminal")
  );
}

function isUnresolvedTerminalDispatch(dispatchState: TerminalGateRow["dispatch_state"]): boolean {
  return dispatchState === "pending" || dispatchState === "dispatching" || dispatchState === "ambiguous";
}

function terminalOutputsReplay(
  database: DatabaseSync,
  runId: string,
  outputs: readonly RunTerminalOutputDraft[],
): boolean {
  return outputs.every((output) => {
    const row = readOutputReplayRow(database, runId, output.id, output.providerItemId);
    if (row === undefined) return false;
    const immutableFieldsMatch =
      row.id === output.id &&
      row.category === output.category &&
      row.kind === output.kind &&
      row.provider_item_id === output.providerItemId &&
      row.summary === output.summary &&
      row.completion_state === output.completionState &&
      row.payload_original_byte_length ===
        (output.payload.state === "none" ? null : output.payload.originalByteLength) &&
      row.redaction_state ===
        (output.payload.state === "none"
          ? "not_required"
          : output.payload.state === "omitted_redaction"
            ? "unknown"
            : output.payload.redactionState);
    if (!immutableFieldsMatch) return false;
    if (output.payload.state === "pending") {
      if (row.payload_state === "stored") {
        return row.stored_payload_id === row.id && row.byte_length !== null && row.content_sha256 !== null;
      }
      return (
        (row.payload_state === "pending" ||
          row.payload_state === "omitted_size_limit" ||
          row.payload_state === "omitted_persistence") &&
        row.stored_payload_id === null &&
        row.byte_length === null
      );
    }
    return row.payload_state === output.payload.state && row.stored_payload_id === null && row.byte_length === null;
  });
}

function terminalResult(
  command: RunTerminalCommand,
  finalAssistantMessageId: string | null,
  terminalEventId: string,
  childDeliveryId: string | null,
  delegationState: RunTerminalResult["delegationState"],
  terminalAt: number,
): RunTerminalResult {
  return {
    sessionId: command.sessionId,
    runId: command.runId,
    attemptId: command.attemptId,
    phase: command.outcome.kind,
    finalAssistantMessageId,
    terminalEventId,
    childDeliveryId,
    delegationState,
    terminalAt,
  };
}

function readCollectRow(database: DatabaseSync, deliveryId: string): CollectRow | undefined {
  return database
    .prepare(
      `
      SELECT d.delegation_id, d.child_run_id, d.availability_state, d.terminal_phase_snapshot,
             d.result_summary, d.available_at, d.first_collected_by_parent_run_id, d.first_collected_at,
             r.final_assistant_message_id, r.session_id AS child_session_id,
             sr.parent_session_id, s.workspace_key
      FROM child_result_deliveries d
      JOIN runs r ON r.id = d.child_run_id
      JOIN delegations g ON g.id = d.delegation_id
      JOIN session_relations sr ON sr.id = g.session_relation_id AND sr.child_session_id = r.session_id
      JOIN sessions s ON s.id = r.session_id
      WHERE d.id = ?
    `,
    )
    .get(deliveryId) as CollectRow | undefined;
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

function capacityFailure<T>(details: RepositoryCapacityExceededDetails): RepositoryCommandResult<T> {
  const message =
    details.scope === "root"
      ? "Child Run capacity is exhausted."
      : details.scope === "application"
        ? "Application Run capacity is exhausted."
        : "Provider Run capacity is exhausted.";
  return { ok: false, error: { code: "capacity_exceeded", message, retryable: true, details }, replayed: false };
}

function failure<T>(
  code: Exclude<RepositoryCommandErrorCode, "capacity_exceeded">,
  message: string,
  retryable = false,
): RepositoryCommandResult<T> {
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

function isNullableBoundedText(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isRunOutputDraft(value: unknown, allowPending: boolean): value is RunOutputDraft | RunTerminalOutputDraft {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "category", "kind", "providerItemId", "summary", "completionState", "payload"]) &&
    isBoundedString(value.id, 1_024) &&
    isRunOutputCategory(value.category) &&
    isBoundedString(value.kind, 64) &&
    (value.providerItemId === null || isBoundedString(value.providerItemId, 1_024)) &&
    typeof value.summary === "string" &&
    Buffer.byteLength(value.summary) <= 4_096 &&
    (value.completionState === "complete" || value.completionState === "partial") &&
    isRunOutputPayload(value.payload, allowPending)
  );
}

function isDenseTerminalOutputs(value: unknown): value is RunTerminalOutputDraft[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  const ids = new Set<string>();
  const providerItemIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isRunOutputDraft(value[index], true)) return false;
    const output = value[index] as RunTerminalOutputDraft;
    if (ids.has(output.id)) return false;
    ids.add(output.id);
    if (output.providerItemId !== null) {
      if (providerItemIds.has(output.providerItemId)) return false;
      providerItemIds.add(output.providerItemId);
    }
  }
  return true;
}

function isRunOutputPayload(value: unknown, allowPending: boolean): boolean {
  if (!isPlainObject(value) || typeof value.state !== "string") return false;
  if (value.state === "none") return hasExactKeys(value, ["state"]);
  if (value.state === "stored") {
    return (
      !allowPending &&
      hasExactKeys(value, ["state", "originalByteLength", "redactionState", "payloadFormat", "mediaType", "content"]) &&
      isNonNegativeSafeInteger(value.originalByteLength) &&
      isRunOutputRedactionState(value.redactionState) &&
      isPayloadFormat(value.payloadFormat) &&
      (value.mediaType === null || isBoundedString(value.mediaType, 256)) &&
      value.content instanceof Uint8Array
    );
  }
  if (value.state === "omitted_redaction") {
    return hasExactKeys(value, ["state", "originalByteLength"]) && isNonNegativeSafeInteger(value.originalByteLength);
  }
  if (value.state === "pending" || value.state === "omitted_size_limit" || value.state === "omitted_persistence") {
    return (
      (value.state !== "pending" || allowPending) &&
      hasExactKeys(value, ["state", "originalByteLength", "redactionState"]) &&
      isNonNegativeSafeInteger(value.originalByteLength) &&
      isRunOutputRedactionState(value.redactionState)
    );
  }
  return false;
}

function isRunTerminalPreDispatchResolution(value: unknown): value is RunTerminalPreDispatchResolution {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["kind"]) &&
    (value.kind === "not_applicable" ||
      value.kind === "binding_creation_not_sent" ||
      value.kind === "binding_creation_ambiguous" ||
      value.kind === "dispatch_not_sent")
  );
}

function isRunTerminalOutcome(value: unknown): value is RunTerminalCommand["outcome"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "completed") {
    if (!hasExactKeys(value, ["kind", "finalAssistantMessage"])) return false;
    if (value.finalAssistantMessage === null) return true;
    return (
      isPlainObject(value.finalAssistantMessage) &&
      hasExactKeys(value.finalAssistantMessage, ["id", "contentBlocks"]) &&
      isBoundedString(value.finalAssistantMessage.id, 1_024) &&
      isDenseJsonArray(value.finalAssistantMessage.contentBlocks, 1_024)
    );
  }
  if (value.kind === "canceled") return hasExactKeys(value, ["kind"]);
  return (
    (value.kind === "failed" || value.kind === "interrupted") &&
    hasExactKeys(value, ["kind", "failureOrigin", "providerErrorCode", "errorSummary"]) &&
    isFailureOrigin(value.failureOrigin) &&
    (value.providerErrorCode === null || isBoundedString(value.providerErrorCode, 1_024)) &&
    (value.errorSummary === null || isBoundedString(value.errorSummary, 4_096))
  );
}

function isChildTerminalResult(value: unknown): value is RunTerminalCommand["childResult"] {
  return (
    value === null ||
    (isPlainObject(value) &&
      hasExactKeys(value, ["workflowState", "resultSummary"]) &&
      (value.workflowState === "clarification_required" || value.workflowState === "closed") &&
      (value.resultSummary === null || isBoundedString(value.resultSummary, 1_024)))
  );
}

function isRunOutputCategory(value: unknown): boolean {
  return ["assistant_detail", "operation", "interaction", "telemetry", "diagnostic", "provider_metadata"].includes(
    value as string,
  );
}

function isRunOutputRedactionState(value: unknown): value is "not_required" | "redacted" {
  return value === "not_required" || value === "redacted";
}

function isPayloadFormat(value: unknown): value is "text" | "json" | "binary" {
  return value === "text" || value === "json" || value === "binary";
}

function isFailureOrigin(value: unknown): boolean {
  return ["provider", "transport", "process", "application", "unknown"].includes(value as string);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function hasRunInputScope(value: Readonly<Record<string, unknown>>): boolean {
  return hasDispatchScope(value) && isBoundedString(value.messageId, 1_024);
}

function isRunInputResolutionCode(value: unknown): value is RunInputResolutionCode {
  return (
    value === "provider_rejected" ||
    value === "transport_unknown" ||
    value === "process_unknown" ||
    value === "run_terminal_not_sent"
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

function isTerminalRunPhase(value: string): value is TerminalRunPhase {
  return value === "completed" || value === "failed" || value === "canceled" || value === "interrupted";
}

function invalidCommand(): RepositoryCommandDecodeError {
  return new RepositoryCommandDecodeError();
}

function decodeFailure(): DecodeFailure {
  return { ok: false };
}

class RepositoryCommandDecodeError extends Error {}
class RepositoryTransactionRollback extends Error {
  constructor(readonly result: unknown) {
    super("Repository transaction rolled back for a domain conflict.");
  }
}

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
type PreparedRetryRunAdmission = Readonly<{
  command: RetryRunAdmissionCommand;
  executionSnapshotJson: string;
  dispatchFingerprint: string;
  fingerprint: string;
}>;
type PreparedChildStart = Readonly<{
  command: ChildStartCommand;
  directoriesJson: string;
  contentBlocksJson: string;
  executionSnapshotJson: string;
  dispatchFingerprint: string;
  fingerprint: string;
}>;
type RunAdmissionCommand = Readonly<{
  sessionId: string;
  run: RunAdmissionDraft;
  attemptId: string;
  bindingIntent: RunAdmissionBindingIntent;
  dispatch: RunAdmissionDispatch;
}>;
type PreparedRunDispatchBegin = Readonly<{
  command: RunDispatchBeginCommand;
  requestFingerprint: string;
}>;
type PreparedRunInputAdmission = Readonly<{
  command: RunInputAdmissionCommand;
  contentBlocksJson: string;
  fingerprint: string;
}>;
type PreparedStoredPayload = Readonly<{
  state: "stored";
  originalByteLength: number;
  redactionState: "not_required" | "redacted";
  payloadFormat: "text" | "json" | "binary";
  mediaType: string | null;
  content: Buffer;
  contentSha256: string;
}>;
type PreparedRunOutputAppend = Readonly<{
  command: RunOutputAppendCommand;
  payload: PreparedStoredPayload | undefined;
}>;
type PreparedRunOutputResolvePending = Readonly<{
  command: RunOutputResolvePendingCommand;
  payload: PreparedStoredPayload | undefined;
}>;
type PreparedRunTerminal = Readonly<{
  command: RunTerminalCommand;
  finalMessageJson: string | null;
  terminalDedupeKey: string;
}>;
type PreparedChildResultCollect = Readonly<{
  command: ChildResultCollectCommand;
  fingerprint: string;
}>;
type ResolvedPayloadLimits = typeof RUN_OUTPUT_PAYLOAD_LIMITS;
type RepositorySynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;
type DiskCapacityProbe = () => Readonly<{ availableBytes: number; totalBytes: number }>;
type OutputReplayRow = Readonly<{
  id: string;
  ordinal: number;
  category: string;
  kind: string;
  provider_item_id: string | null;
  summary: string;
  completion_state: string;
  payload_state: string;
  payload_original_byte_length: number | null;
  stored_payload_id: string | null;
  redaction_state: string;
  created_at: number;
  payload_format: string | null;
  media_type: string | null;
  byte_length: number | null;
  content_sha256: string | null;
}>;
type TerminalGateRow = Readonly<{
  phase: string;
  final_assistant_message_id: string | null;
  failure_origin: string | null;
  provider_error_code: string | null;
  error_summary: string | null;
  terminal_at: number | null;
  attempt_state: string;
  provider_binding_id: string | null;
  dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
  binding_id: string | null;
  binding_session_id: string | null;
  binding_provider_id: string | null;
  persistence_mode: "persistent" | "ephemeral" | null;
  binding_state: "creating" | "active" | "invalidated" | "superseded" | null;
  created_by_run_attempt_id: string | null;
  binding_creator_session_id: string | null;
  invalidation_reason: string | null;
  workspace_key: string;
  session_provider_id: string;
  session_updated_at: number;
  session_last_activity_at: number;
}>;
type ChildTerminalRow = Readonly<{
  delivery_id: string;
  delegation_id: string;
  availability_state: "pending" | "available";
}>;
type CollectRow = Readonly<{
  delegation_id: string;
  child_run_id: string;
  availability_state: "pending" | "available";
  terminal_phase_snapshot: TerminalRunPhase | null;
  result_summary: string | null;
  available_at: number | null;
  first_collected_by_parent_run_id: string | null;
  first_collected_at: number | null;
  final_assistant_message_id: string | null;
  child_session_id: string;
  parent_session_id: string;
  workspace_key: string;
}>;
type ChildStartReplayRow = Readonly<{
  parent_session_id: string;
  created_by_parent_run_id: string;
  child_session_id: string;
  orchestration_root_session_id: string;
  relation_id: string;
  correlation_id: string;
  created_at: number;
  delegation_id: string;
  delivery_id: string;
  message_id: string;
  run_id: string;
  attempt_id: string;
  binding_id: string;
  persistence_mode: "persistent" | "ephemeral";
}>;
type BindingResolution<T> =
  | Readonly<{ ok: true; providerBindingId: string | null }>
  | Readonly<{ ok: false; result: RepositoryCommandResult<T> }>;
type NonTerminalRunPhase = "queued" | "starting" | "active" | "canceling" | "finalizing";
type TerminalRunPhase = "completed" | "failed" | "canceled" | "interrupted";
type AdmissionSessionRow = Readonly<{
  provider_id: string;
  lifecycle_status: SessionLifecycleStatus;
  updated_at: number;
  last_activity_at: number;
}>;
type RetrySourceRow = Readonly<{
  initiating_message_id: string;
  phase: NonTerminalRunPhase | TerminalRunPhase;
  role: "user" | "assistant";
}>;
type BindingResolutionRow = Readonly<{
  binding_provider_id: string;
  persistence_mode: "persistent" | "ephemeral";
  binding_state: "creating" | "active" | "invalidated" | "superseded";
  external_conversation_id: string | null;
  provider_binding_id: string | null;
  attempt_state: "preparing" | "active" | "succeeded" | "failed" | "interrupted";
  run_phase: NonTerminalRunPhase | "completed" | "failed" | "canceled" | "interrupted";
  session_provider_id: string;
  dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
}>;
type ProviderBindingResolutionExecution = Readonly<{
  result: RepositoryCommandResult<ProviderBindingResolutionResult>;
  registerEphemeralOwner?: Readonly<{ bindingId: string; token: string }>;
}>;
type DispatchScope = Readonly<{
  sessionId: string;
  workspaceKey: string;
  runId: string;
  attemptId: string;
  bindingId: string;
}>;
type RunInputScope = DispatchScope & Readonly<{ messageId: string }>;
type BindingOwnershipRow = Readonly<{
  persistence_mode: "persistent" | "ephemeral";
  binding_state: "creating" | "active" | "invalidated" | "superseded";
  external_conversation_id: string | null;
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
type RunInputAdmissionGateRow = BindingOwnershipRow &
  Readonly<{
    lifecycle_status: SessionLifecycleStatus;
    updated_at: number;
    last_activity_at: number;
    run_phase: NonTerminalRunPhase | TerminalRunPhase;
    provider_binding_id: string;
    attempt_state: "preparing" | "active" | "succeeded" | "failed" | "interrupted";
    dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
  }>;
type RunInputTransitionRow = BindingOwnershipRow &
  Readonly<{
    lifecycle_status: SessionLifecycleStatus;
    run_phase: NonTerminalRunPhase | TerminalRunPhase;
    provider_binding_id: string | null;
    attempt_state: "preparing" | "active" | "succeeded" | "failed" | "interrupted";
    dispatch_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
    delivery_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
    resolution_code: RunInputResolutionCode | null;
    dispatching_at: number | null;
    resolved_at: number | null;
  }>;
type RunInputOutcomeRow = Readonly<{
  message_id: string;
  run_id: string;
  run_attempt_id: string;
  provider_binding_id: string | null;
  delivery_state: "pending" | "dispatching" | "accepted" | "rejected" | "ambiguous" | "aborted";
  resolution_code: RunInputResolutionCode | null;
  created_at: number;
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
