import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { MESSAGE_CONTENT_LIMITS, snapshotMessageContentBlocks } from "../shared/message-content.js";
import { isCanonicalUuid, isPlainObject } from "../shared/persistence-runtime-protocol.js";
import {
  RUN_WRITE_PAYLOAD_LIMITS,
  type NormalRunAdmissionCommand,
  type NormalRunAdmissionResult,
  type RepositoryJsonValue,
  type RetryRunAdmissionCommand,
  type RetryRunAdmissionResult,
  type RunAdmissionDispatch,
} from "../shared/repository-write-model.js";

export type PreparedNormalRunAdmissionIdempotency = Readonly<{
  contentBlocksJson: string;
  executionSnapshotJson: string;
  dispatchFingerprint: string;
  fingerprint: string;
}>;

export type PreparedRetryRunAdmissionIdempotency = Readonly<{
  executionSnapshotJson: string;
  dispatchFingerprint: string;
  fingerprint: string;
}>;

export function prepareNormalRunAdmissionIdempotency(
  command: NormalRunAdmissionCommand,
): PreparedNormalRunAdmissionIdempotency | undefined {
  const contentBlocksJson = canonicalJsonString(command.message.contentBlocks);
  const executionSnapshotJson = canonicalJsonString(command.run.executionSnapshot);
  const providerRequestJson = canonicalJsonString(command.dispatch.providerRequest);
  if (
    contentBlocksJson === undefined ||
    executionSnapshotJson === undefined ||
    providerRequestJson === undefined ||
    !isAdmissionProviderRequest(
      command.message.contentBlocks,
      command.run.executionSnapshot,
      command.dispatch.providerRequest,
    ) ||
    Buffer.byteLength(contentBlocksJson) > MESSAGE_CONTENT_LIMITS.maxJsonBytes ||
    Buffer.byteLength(executionSnapshotJson) > RUN_WRITE_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes ||
    Buffer.byteLength(providerRequestJson) > RUN_WRITE_PAYLOAD_LIMITS.providerRequestMaxJsonBytes
  ) {
    return undefined;
  }
  const dispatchFingerprint = fingerprintJson(providerRequestJson);
  return {
    contentBlocksJson,
    executionSnapshotJson,
    dispatchFingerprint,
    fingerprint: fingerprint({
      operation: "run.admit",
      sessionId: command.sessionId,
      workspaceKey: command.workspaceKey,
      message: { contentBlocks: JSON.parse(contentBlocksJson) },
      run: { executionSnapshot: JSON.parse(executionSnapshotJson) },
      dispatch: {
        requestFingerprint: dispatchFingerprint,
        providerIdempotencyKey: command.dispatch.providerIdempotencyKey,
      },
    }),
  };
}

export function prepareRetryRunAdmissionIdempotency(
  command: RetryRunAdmissionCommand,
): PreparedRetryRunAdmissionIdempotency | undefined {
  const executionSnapshotJson = canonicalJsonString(command.run.executionSnapshot);
  const providerRequestJson = canonicalJsonString(command.dispatch.providerRequest);
  if (
    executionSnapshotJson === undefined ||
    providerRequestJson === undefined ||
    Buffer.byteLength(executionSnapshotJson) > RUN_WRITE_PAYLOAD_LIMITS.executionSnapshotMaxJsonBytes ||
    Buffer.byteLength(providerRequestJson) > RUN_WRITE_PAYLOAD_LIMITS.providerRequestMaxJsonBytes
  ) {
    return undefined;
  }
  const dispatchFingerprint = fingerprintJson(providerRequestJson);
  return {
    executionSnapshotJson,
    dispatchFingerprint,
    fingerprint: fingerprint({
      operation: "run.retry",
      sessionId: command.sessionId,
      workspaceKey: command.workspaceKey,
      retryOfRunId: command.retryOfRunId,
      run: { executionSnapshot: JSON.parse(executionSnapshotJson) },
      dispatch: {
        requestFingerprint: dispatchFingerprint,
        providerIdempotencyKey: command.dispatch.providerIdempotencyKey,
      },
    }),
  };
}

export function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: NormalRunAdmissionCommand,
  value: unknown,
  responseRefId: string,
): NormalRunAdmissionResult | undefined;
export function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: RetryRunAdmissionCommand,
  value: unknown,
  responseRefId: string,
): RetryRunAdmissionResult | undefined;
export function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: NormalRunAdmissionCommand | RetryRunAdmissionCommand,
  value: unknown,
  responseRefId: string,
): NormalRunAdmissionResult | RetryRunAdmissionResult | undefined;
export function decodeRunAdmissionReplay(
  database: DatabaseSync,
  command: NormalRunAdmissionCommand | RetryRunAdmissionCommand,
  value: unknown,
  responseRefId: string,
): NormalRunAdmissionResult | RetryRunAdmissionResult | undefined {
  const isRetry = "retryOfRunId" in command;
  const keys = [
    "sessionId",
    "messageId",
    "runId",
    "attemptId",
    "bindingId",
    "runPhase",
    "bindingState",
    "dispatchState",
    "admittedAt",
    ...(isRetry ? ["retryOfRunId"] : []),
  ];
  if (!isPlainObject(value) || !hasExactKeys(value, keys)) return undefined;
  const messageId = value.messageId;
  const runId = value.runId;
  const attemptId = value.attemptId;
  const bindingId = value.bindingId;
  if (
    value.sessionId !== command.sessionId ||
    !isBoundedString(messageId, 1_024) ||
    !isBoundedString(runId, 1_024) ||
    runId !== responseRefId ||
    !isBoundedString(attemptId, 1_024) ||
    !isBoundedString(bindingId, 1_024)
  ) {
    return undefined;
  }
  const row = database
    .prepare(
      `
      SELECT r.initiating_message_id, r.retry_of_run_id, r.phase AS run_phase, r.created_at,
        a.id AS attempt_id, a.provider_binding_id, b.id AS binding_id, b.created_by_run_attempt_id,
        b.persistence_mode, b.binding_state, d.dispatch_state
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
    .get(attemptId, bindingId, runId, command.sessionId, command.workspaceKey) as RunAdmissionReplayRow | undefined;
  const retryOfRunId = isRetry ? command.retryOfRunId : null;
  if (
    row === undefined ||
    row.retry_of_run_id !== retryOfRunId ||
    messageId !== row.initiating_message_id ||
    value.attemptId !== row.attempt_id ||
    value.bindingId !== row.binding_id ||
    row.persistence_mode !== "persistent" ||
    value.runPhase !== "queued" ||
    value.bindingState !== (row.created_by_run_attempt_id === row.attempt_id ? "creating" : "active") ||
    value.dispatchState !== "pending" ||
    value.admittedAt !== row.created_at ||
    (isRetry && value.retryOfRunId !== retryOfRunId)
  ) {
    return undefined;
  }
  return {
    ...(value as unknown as NormalRunAdmissionResult | RetryRunAdmissionResult),
    runPhase: row.run_phase,
    bindingState: row.binding_state,
    dispatchState: row.dispatch_state,
  };
}

export function decodeRunAdmissionProbeCommand(
  value: unknown,
): NormalRunAdmissionCommand | RetryRunAdmissionCommand | undefined {
  if (!isPlainObject(value)) return undefined;
  const retry = Object.hasOwn(value, "retryOfRunId");
  const expectedKeys = retry
    ? ["sessionId", "workspaceKey", "idempotencyKey", "retryOfRunId", "run", "dispatch"]
    : ["sessionId", "workspaceKey", "idempotencyKey", "message", "run", "dispatch"];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !isBoundedString(value.sessionId, 1_024) ||
    !isBoundedString(value.workspaceKey, 1_024) ||
    !isCanonicalUuid(value.idempotencyKey) ||
    (retry && !isBoundedString(value.retryOfRunId, 1_024)) ||
    !isPlainObject(value.run) ||
    !hasExactKeys(value.run, ["executionSnapshot"]) ||
    !isRunExecutionSnapshot(value.run.executionSnapshot) ||
    !isPlainObject(value.dispatch) ||
    !hasExactKeys(value.dispatch, ["providerRequest", "providerIdempotencyKey"]) ||
    !isPlainObject(value.dispatch.providerRequest) ||
    !isJsonValue(value.dispatch.providerRequest) ||
    (value.dispatch.providerIdempotencyKey !== null && !isBoundedString(value.dispatch.providerIdempotencyKey, 4_096))
  ) {
    return undefined;
  }
  if (retry) {
    const command = value as unknown as RetryRunAdmissionCommand;
    return prepareRetryRunAdmissionIdempotency(command) === undefined ? undefined : command;
  }
  if (!isPlainObject(value.message) || !hasExactKeys(value.message, ["contentBlocks"])) return undefined;
  const contentBlocks = snapshotMessageContentBlocks(value.message.contentBlocks);
  if (contentBlocks === undefined) return undefined;
  const command = { ...(value as unknown as NormalRunAdmissionCommand), message: { contentBlocks } };
  return prepareNormalRunAdmissionIdempotency(command) === undefined ? undefined : command;
}

export function isAdmissionProviderRequest(
  contentBlocks: NormalRunAdmissionCommand["message"]["contentBlocks"],
  snapshot: NormalRunAdmissionCommand["run"]["executionSnapshot"],
  providerRequest: RunAdmissionDispatch["providerRequest"],
): boolean {
  return (
    isPlainObject(providerRequest) &&
    hasExactKeys(providerRequest, ["providerId", "definitionVersion", "contentBlocks", "startTurn"]) &&
    providerRequest.providerId === snapshot.providerId &&
    providerRequest.definitionVersion === snapshot.definitionVersion &&
    isPlainObject(providerRequest.startTurn) &&
    isJsonValue(providerRequest.startTurn) &&
    canonicalJsonString(providerRequest.contentBlocks) === canonicalJsonString(contentBlocks)
  );
}

export function isRunExecutionSnapshot(value: unknown): value is NormalRunAdmissionCommand["run"]["executionSnapshot"] {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["providerId", "definitionVersion", "modelSelection", "settings", "workspace", "character"]) &&
    isBoundedString(value.providerId, 1_024) &&
    isBoundedString(value.definitionVersion, 1_024) &&
    (value.modelSelection === "explicit" || value.modelSelection === "inherited") &&
    isPlainObject(value.settings) &&
    isJsonValue(value.settings) &&
    isPlainObject(value.workspace) &&
    isJsonValue(value.workspace) &&
    (value.character === null || (isPlainObject(value.character) && isJsonValue(value.character)))
  );
}

function isJsonValue(value: unknown, depth = 0): value is RepositoryJsonValue {
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

function canonicalJsonString(value: unknown): string | undefined {
  try {
    return JSON.stringify(toCanonicalJson(value));
  } catch {
    return undefined;
  }
}

function toCanonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("JSON number is invalid.");
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
  throw new TypeError("JSON value is invalid.");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function fingerprintJson(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

type RunAdmissionReplayRow = Readonly<{
  initiating_message_id: string;
  retry_of_run_id: string | null;
  run_phase: NormalRunAdmissionResult["runPhase"];
  created_at: number;
  attempt_id: string;
  provider_binding_id: string | null;
  binding_id: string;
  created_by_run_attempt_id: string;
  persistence_mode: "persistent" | "ephemeral";
  binding_state: NormalRunAdmissionResult["bindingState"];
  dispatch_state: NormalRunAdmissionResult["dispatchState"];
}>;
