import path from "node:path";
import { createHash } from "node:crypto";

import { ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS } from "../../shared/allowed-additional-directories.js";
import { APPLICATION_RUN_LIMITS } from "../../shared/application-run-model.js";
import {
  APPLICATION_RUN_OUTPUT_CATEGORIES,
  APPLICATION_RUN_OUTPUT_LIMITS,
} from "../../shared/application-run-output-model.js";
import { APPLICATION_SESSION_MESSAGE_LIMITS } from "../../shared/application-session-message-model.js";
import { APPLICATION_SESSION_RUN_LIMITS } from "../../shared/application-session-run-model.js";
import { isCanonicalUuid } from "../../shared/persistence-runtime-protocol.js";
import { MAX_SESSION_CONCURRENT_CHILD_RUNS } from "../../shared/session-limits.js";
import {
  SESSION_METADATA_LIMITS,
  canonicalizeSessionQuery,
  isCanonicalSessionTitle,
  isLocalRepositoryKey,
} from "../../shared/session-metadata.js";
import {
  RUNTIME_IPC_LIMITS,
  RUNTIME_IPC_PROTOCOL_FAMILY,
  RUNTIME_IPC_PROTOCOL_VERSION,
  RuntimeIpcProtocolError,
  runtimeProtocolFailure,
} from "./runtime-ipc-common.js";
import { snapshotRuntimeWireValue, type RuntimeWireValue } from "./runtime-ipc-value.js";

export { RUNTIME_IPC_LIMITS, RUNTIME_IPC_PROTOCOL_FAMILY, RUNTIME_IPC_PROTOCOL_VERSION, RuntimeIpcProtocolError };

export const RUNTIME_IPC_OPERATIONS = [
  "session.create",
  "session.update_title",
  "session.list",
  "session.list_local_repositories",
  "session.read",
  "session.read_directories_chunk",
  "session.archive",
  "session.unarchive",
  "session.close",
  "session.delete",
  "session.messages",
  "session.message_content_chunk",
  "session.runs",
  "run.status",
  "run.events",
  "run.follow",
  "run.output_counts",
  "run.outputs",
  "run.output_preview",
  "run.output_chunk",
  "run.output_export",
] as const;

export type RuntimeIpcOperation = (typeof RUNTIME_IPC_OPERATIONS)[number];
export type RuntimeIpcOperationPayload = Readonly<Record<string, unknown>>;

export const RUNTIME_IPC_CLIENT_SCOPED_OPERATIONS = new Set<RuntimeIpcOperation>([
  "session.list",
  "session.list_local_repositories",
  "session.read",
  "session.read_directories_chunk",
  "session.messages",
  "session.message_content_chunk",
  "session.runs",
  "run.status",
  "run.events",
  "run.follow",
  "run.output_counts",
  "run.outputs",
  "run.output_preview",
  "run.output_chunk",
  "run.output_export",
]);

export type RuntimeIpcHandshakeRequest = Readonly<{
  protocolVersion: typeof RUNTIME_IPC_PROTOCOL_VERSION;
  kind: "handshake_request";
  clientId: string;
}>;

export type RuntimeIpcHandshakeResponse = Readonly<{
  protocolVersion: typeof RUNTIME_IPC_PROTOCOL_VERSION;
  kind: "handshake_response";
  clientId: string;
  hostGenerationId: string;
}>;

export type RuntimeIpcHandshakeRejection = Readonly<{
  protocolVersion: typeof RUNTIME_IPC_PROTOCOL_VERSION;
  kind: "handshake_rejection";
  clientId: string;
  error: Readonly<{
    code: "version_mismatch" | "authorization_failed" | "resource_exhausted";
    message: string;
    retryable: false;
  }>;
}>;

export type RuntimeIpcRequest = Readonly<{
  protocolVersion: typeof RUNTIME_IPC_PROTOCOL_VERSION;
  kind: "request";
  hostGenerationId: string;
  clientId: string;
  requestId: string;
  requestSequence: number;
  operation: RuntimeIpcOperation;
  payload: RuntimeIpcOperationPayload;
}>;

export type RuntimeIpcCancel = Readonly<{
  protocolVersion: typeof RUNTIME_IPC_PROTOCOL_VERSION;
  kind: "cancel";
  hostGenerationId: string;
  clientId: string;
  requestId: string;
  requestSequence: number;
}>;

export type RuntimeIpcFailure =
  | Readonly<{
      code: "operation_failed";
      message: string;
      retryable: false;
      execution: "started";
    }>
  | Readonly<{
      code: "protocol_failure" | "request_rejected";
      message: string;
      retryable: false;
      execution: "not_started";
    }>
  | Readonly<{
      code: "resource_exhausted";
      message: string;
      retryable: true;
      execution: "not_started";
    }>
  | Readonly<{
      code: "runtime_unavailable";
      message: string;
      retryable: true;
      execution: "not_started";
    }>
  | Readonly<{
      code: "runtime_unavailable";
      message: string;
      retryable: false;
      execution: "unknown";
    }>;

type RuntimeIpcResponseBase = Readonly<{
  protocolVersion: typeof RUNTIME_IPC_PROTOCOL_VERSION;
  kind: "response";
  hostGenerationId: string;
  clientId: string;
  requestId: string;
  requestSequence: number;
  operation: RuntimeIpcOperation;
}>;

export type RuntimeIpcSuccessResponse = RuntimeIpcResponseBase &
  Readonly<{ outcome: "success"; value: RuntimeWireValue }>;

export type RuntimeIpcFailureResponse = RuntimeIpcResponseBase &
  Readonly<{ outcome: "failure"; error: RuntimeIpcFailure }>;

export type RuntimeIpcResponse = RuntimeIpcSuccessResponse | RuntimeIpcFailureResponse;
export type RuntimeIpcEnvelope =
  | RuntimeIpcHandshakeRequest
  | RuntimeIpcHandshakeResponse
  | RuntimeIpcHandshakeRejection
  | RuntimeIpcRequest
  | RuntimeIpcCancel
  | RuntimeIpcResponse;

export function deriveRuntimeRequestId(clientId: string, requestSequence: number): string {
  if (!isCanonicalUuid(clientId) || !isPositiveSafeInteger(requestSequence)) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  const bytes = createHash("sha256")
    .update(RUNTIME_IPC_PROTOCOL_FAMILY)
    .update("\0")
    .update(clientId)
    .update("\0")
    .update(String(requestSequence))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decodeRuntimeIpcEnvelope(value: unknown): RuntimeIpcEnvelope {
  const envelope = snapshotEnvelopeRecord(value);
  if (envelope.protocolVersion !== RUNTIME_IPC_PROTOCOL_VERSION) {
    throw runtimeProtocolFailure("version_mismatch");
  }
  switch (envelope.kind) {
    case "handshake_request":
      return decodeHandshakeRequest(envelope);
    case "handshake_response":
      return decodeHandshakeResponse(envelope);
    case "handshake_rejection":
      return decodeHandshakeRejection(envelope);
    case "request":
      return decodeRequest(envelope);
    case "cancel":
      return decodeCancel(envelope);
    case "response":
      return decodeResponse(envelope);
    default:
      throw runtimeProtocolFailure("invalid_envelope");
  }
}

export function encodeRuntimeIpcEnvelope(value: RuntimeIpcEnvelope): string {
  const line = JSON.stringify(decodeRuntimeIpcEnvelope(value));
  if (Buffer.byteLength(line) > RUNTIME_IPC_LIMITS.maxLineBytes) {
    throw runtimeProtocolFailure("line_too_large");
  }
  return `${line}\n`;
}

export function snapshotRuntimeOperationPayload(
  operation: RuntimeIpcOperation,
  value: unknown,
): RuntimeIpcOperationPayload {
  switch (operation) {
    case "session.create":
      return snapshotSessionCreate(value);
    case "session.update_title":
      return snapshotSessionUpdateTitle(value);
    case "session.list":
      return snapshotSessionList(value);
    case "session.list_local_repositories":
      return snapshotCursorPage(value, 100);
    case "session.read":
      return snapshotSessionScope(value);
    case "session.read_directories_chunk":
      return snapshotChunk(value, ["sessionId"], 256 * 1024);
    case "session.archive":
    case "session.unarchive":
    case "session.delete":
      return snapshotSessionWrite(value);
    case "session.close":
      return snapshotSessionClose(value);
    case "session.messages":
      return snapshotSessionPage(value, APPLICATION_SESSION_MESSAGE_LIMITS.messagesMaxItems);
    case "session.message_content_chunk":
      return snapshotChunk(value, ["sessionId", "messageId"], APPLICATION_SESSION_MESSAGE_LIMITS.chunkMaxBytes);
    case "session.runs":
      return snapshotSessionPage(value, APPLICATION_SESSION_RUN_LIMITS.runsMaxItems);
    case "run.status":
    case "run.output_counts":
      return snapshotRunScope(value);
    case "run.events":
      return snapshotRunEvents(value);
    case "run.follow":
      return snapshotRunFollow(value);
    case "run.outputs":
      return snapshotRunOutputs(value);
    case "run.output_preview":
      return snapshotRunOutputPreview(value);
    case "run.output_chunk":
      return snapshotRunOutputChunk(value);
    case "run.output_export":
      return snapshotRunOutputExport(value);
  }
}

function decodeHandshakeRequest(envelope: Readonly<Record<string, unknown>>): RuntimeIpcHandshakeRequest {
  requireExactKeys(envelope, ["protocolVersion", "kind", "clientId"]);
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "handshake_request",
    clientId: canonicalUuid(envelope.clientId),
  };
}

function decodeHandshakeResponse(envelope: Readonly<Record<string, unknown>>): RuntimeIpcHandshakeResponse {
  requireExactKeys(envelope, ["protocolVersion", "kind", "clientId", "hostGenerationId"]);
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "handshake_response",
    clientId: canonicalUuid(envelope.clientId),
    hostGenerationId: canonicalUuid(envelope.hostGenerationId),
  };
}

function decodeHandshakeRejection(envelope: Readonly<Record<string, unknown>>): RuntimeIpcHandshakeRejection {
  requireExactKeys(envelope, ["protocolVersion", "kind", "clientId", "error"]);
  const error = snapshotRecord(envelope.error, ["code", "message", "retryable"]);
  requireExactKeys(error, ["code", "message", "retryable"]);
  if (
    !["version_mismatch", "authorization_failed", "resource_exhausted"].includes(error.code as string) ||
    error.retryable !== false
  ) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "handshake_rejection",
    clientId: canonicalUuid(envelope.clientId),
    error: {
      code: error.code as RuntimeIpcHandshakeRejection["error"]["code"],
      message: failureMessage(error.message),
      retryable: false,
    },
  };
}

function decodeRequest(envelope: Readonly<Record<string, unknown>>): RuntimeIpcRequest {
  requireExactKeys(envelope, [
    "protocolVersion",
    "kind",
    "hostGenerationId",
    "clientId",
    "requestId",
    "requestSequence",
    "operation",
    "payload",
  ]);
  const correlation = decodeCorrelation(envelope);
  const operation = runtimeOperation(envelope.operation);
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "request",
    ...correlation,
    operation,
    payload: snapshotRuntimeOperationPayload(operation, envelope.payload),
  };
}

function decodeCancel(envelope: Readonly<Record<string, unknown>>): RuntimeIpcCancel {
  requireExactKeys(envelope, [
    "protocolVersion",
    "kind",
    "hostGenerationId",
    "clientId",
    "requestId",
    "requestSequence",
  ]);
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "cancel",
    ...decodeCorrelation(envelope),
  };
}

function decodeResponse(envelope: Readonly<Record<string, unknown>>): RuntimeIpcResponse {
  const correlation = decodeCorrelation(envelope);
  const operation = runtimeOperation(envelope.operation);
  if (envelope.outcome === "success") {
    requireExactKeys(envelope, [
      "protocolVersion",
      "kind",
      "hostGenerationId",
      "clientId",
      "requestId",
      "requestSequence",
      "operation",
      "outcome",
      "value",
    ]);
    return {
      protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
      kind: "response",
      ...correlation,
      operation,
      outcome: "success",
      value: snapshotRuntimeWireValue(envelope.value),
    };
  }
  if (envelope.outcome !== "failure") throw runtimeProtocolFailure("invalid_envelope");
  requireExactKeys(envelope, [
    "protocolVersion",
    "kind",
    "hostGenerationId",
    "clientId",
    "requestId",
    "requestSequence",
    "operation",
    "outcome",
    "error",
  ]);
  return {
    protocolVersion: RUNTIME_IPC_PROTOCOL_VERSION,
    kind: "response",
    ...correlation,
    operation,
    outcome: "failure",
    error: decodeFailure(envelope.error),
  };
}

function decodeCorrelation(envelope: Readonly<Record<string, unknown>>) {
  const hostGenerationId = canonicalUuid(envelope.hostGenerationId);
  const clientId = canonicalUuid(envelope.clientId);
  const requestSequence = positiveSafeInteger(envelope.requestSequence);
  const requestId = canonicalUuid(envelope.requestId);
  if (requestId !== deriveRuntimeRequestId(clientId, requestSequence)) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  return { hostGenerationId, clientId, requestId, requestSequence };
}

function decodeFailure(value: unknown): RuntimeIpcFailure {
  const failure = snapshotRecord(value, ["code", "message", "retryable", "execution"]);
  requireExactKeys(failure, ["code", "message", "retryable", "execution"]);
  const message = failureMessage(failure.message);
  switch (failure.code) {
    case "operation_failed":
      if (failure.retryable !== false || failure.execution !== "started") invalid();
      return { code: failure.code, message, retryable: false, execution: "started" };
    case "protocol_failure":
    case "request_rejected":
      if (failure.retryable !== false || failure.execution !== "not_started") invalid();
      return { code: failure.code, message, retryable: false, execution: "not_started" };
    case "resource_exhausted":
      if (failure.retryable !== true || failure.execution !== "not_started") invalid();
      return { code: failure.code, message, retryable: true, execution: "not_started" };
    case "runtime_unavailable":
      if (failure.execution === "not_started" && failure.retryable === true) {
        return { code: failure.code, message, retryable: true, execution: "not_started" };
      }
      if (failure.execution === "unknown" && failure.retryable === false) {
        return { code: failure.code, message, retryable: false, execution: "unknown" };
      }
      invalid();
    default:
      invalid();
  }
}

function snapshotSessionCreate(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, [
    "title",
    "workspacePath",
    "idempotencyKey",
    "providerId",
    "allowedAdditionalDirectories",
    "defaultCharacterId",
    "maxConcurrentChildRuns",
  ]);
  if (
    !isCanonicalSessionTitle(payload.title) ||
    !isAbsolutePath(payload.workspacePath, ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isIdentifier(payload.providerId) ||
    !isIdentifier(payload.defaultCharacterId) ||
    !isIntegerInRange(payload.maxConcurrentChildRuns, 0, MAX_SESSION_CONCURRENT_CHILD_RUNS)
  ) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  const allowedAdditionalDirectories = snapshotStringArray(
    payload.allowedAdditionalDirectories,
    ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxItems,
    (item) => isAbsolutePath(item, ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength),
  );
  if (
    Buffer.byteLength(JSON.stringify(allowedAdditionalDirectories)) > ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxJsonBytes
  ) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  return {
    title: payload.title,
    workspacePath: payload.workspacePath,
    idempotencyKey: payload.idempotencyKey,
    providerId: payload.providerId,
    allowedAdditionalDirectories,
    defaultCharacterId: payload.defaultCharacterId,
    maxConcurrentChildRuns: payload.maxConcurrentChildRuns,
  };
}

function snapshotSessionUpdateTitle(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, ["sessionId", "idempotencyKey", "title"]);
  if (
    !isIdentifier(payload.sessionId) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !isCanonicalSessionTitle(payload.title)
  ) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  return { sessionId: payload.sessionId, idempotencyKey: payload.idempotencyKey, title: payload.title };
}

function snapshotSessionList(value: unknown): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, [
    "workspacePath",
    "lifecycleStatus",
    "localRepositoryKeys",
    "query",
    "cursor",
    "limit",
  ]);
  const output: Record<string, unknown> = {};
  if (has(payload, "workspacePath")) {
    if (!isAbsolutePath(payload.workspacePath, ALLOWED_ADDITIONAL_DIRECTORIES_LIMITS.maxPathLength)) invalid();
    output.workspacePath = payload.workspacePath;
  }
  if (has(payload, "lifecycleStatus")) {
    if (!["active", "archived", "closed"].includes(payload.lifecycleStatus as string)) invalid();
    output.lifecycleStatus = payload.lifecycleStatus;
  }
  if (has(payload, "localRepositoryKeys")) {
    const localRepositoryKeys = snapshotStringArray(
      payload.localRepositoryKeys,
      SESSION_METADATA_LIMITS.repositoryFilterMaxItems,
      isLocalRepositoryKey,
    );
    if (localRepositoryKeys.length === 0) invalid();
    output.localRepositoryKeys = localRepositoryKeys;
  }
  if (has(payload, "query")) {
    if (typeof payload.query !== "string" || canonicalizeSessionQuery(payload.query) !== payload.query) invalid();
    output.query = payload.query;
  }
  copyOptionalCursorAndLimit(payload, output, 100);
  return output;
}

function snapshotCursorPage(value: unknown, maxItems: number): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["cursor", "limit"]);
  const output: Record<string, unknown> = {};
  copyOptionalCursorAndLimit(payload, output, maxItems);
  return output;
}

function snapshotSessionScope(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, ["sessionId"]);
  if (!isIdentifier(payload.sessionId)) invalid();
  return { sessionId: payload.sessionId };
}

function snapshotSessionWrite(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, ["sessionId", "idempotencyKey"]);
  if (!isIdentifier(payload.sessionId) || !isCanonicalUuid(payload.idempotencyKey)) invalid();
  return { sessionId: payload.sessionId, idempotencyKey: payload.idempotencyKey };
}

function snapshotSessionClose(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, ["sessionId", "idempotencyKey", "expectedLifecycleStatus"]);
  if (
    !isIdentifier(payload.sessionId) ||
    !isCanonicalUuid(payload.idempotencyKey) ||
    !["active", "archived"].includes(payload.expectedLifecycleStatus as string)
  ) {
    invalid();
  }
  return {
    sessionId: payload.sessionId,
    idempotencyKey: payload.idempotencyKey,
    expectedLifecycleStatus: payload.expectedLifecycleStatus,
  };
}

function snapshotSessionPage(value: unknown, maxItems: number): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["sessionId", "cursor", "limit"]);
  if (!has(payload, "sessionId") || !isIdentifier(payload.sessionId)) invalid();
  const output: Record<string, unknown> = { sessionId: payload.sessionId };
  copyOptionalCursorAndLimit(payload, output, maxItems);
  return output;
}

function snapshotChunk(value: unknown, scopeKeys: readonly string[], maxBytes: number): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, [...scopeKeys, "offset", "maxBytes"]);
  const output: Record<string, unknown> = {};
  for (const key of scopeKeys) {
    if (!isIdentifier(payload[key])) invalid();
    output[key] = payload[key];
  }
  if (
    !isIntegerInRange(payload.offset, 0, Number.MAX_SAFE_INTEGER) ||
    !isIntegerInRange(payload.maxBytes, 1, maxBytes)
  ) {
    invalid();
  }
  output.offset = payload.offset;
  output.maxBytes = payload.maxBytes;
  return output;
}

function snapshotRunScope(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, ["sessionId", "runId"]);
  if (!isIdentifier(payload.sessionId) || !isIdentifier(payload.runId)) invalid();
  return { sessionId: payload.sessionId, runId: payload.runId };
}

function snapshotRunEvents(value: unknown): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["sessionId", "runId", "cursor", "limit"]);
  const output = snapshotRunScopeFields(payload);
  copyOptionalCursorAndLimit(payload, output, APPLICATION_RUN_LIMITS.eventsMaxItems);
  return output;
}

function snapshotRunFollow(value: unknown): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["sessionId", "runId", "cursor", "limit", "waitMs", "pollMs"]);
  const output = snapshotRunScopeFields(payload);
  copyOptionalCursorAndLimit(payload, output, APPLICATION_RUN_LIMITS.eventsMaxItems);
  if (has(payload, "waitMs")) {
    if (!isIntegerInRange(payload.waitMs, 0, APPLICATION_RUN_LIMITS.followMaxWaitMs)) invalid();
    output.waitMs = payload.waitMs;
  }
  if (has(payload, "pollMs")) {
    if (
      !isIntegerInRange(payload.pollMs, APPLICATION_RUN_LIMITS.followMinPollMs, APPLICATION_RUN_LIMITS.followMaxPollMs)
    ) {
      invalid();
    }
    output.pollMs = payload.pollMs;
  }
  return output;
}

function snapshotRunOutputs(value: unknown): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["sessionId", "runId", "category", "cursor", "limit"]);
  const output = snapshotRunScopeFields(payload);
  if (has(payload, "category")) {
    if (!APPLICATION_RUN_OUTPUT_CATEGORIES.includes(payload.category as never)) invalid();
    output.category = payload.category;
  }
  copyOptionalCursorAndLimit(payload, output, APPLICATION_RUN_OUTPUT_LIMITS.outputsMaxItems);
  return output;
}

function snapshotRunOutputPreview(value: unknown): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["sessionId", "runId", "outputItemId", "maxBytes"]);
  const output = snapshotRunOutputScopeFields(payload);
  if (has(payload, "maxBytes")) {
    if (!isIntegerInRange(payload.maxBytes, 1, APPLICATION_RUN_OUTPUT_LIMITS.previewMaxBytes)) invalid();
    output.maxBytes = payload.maxBytes;
  }
  return output;
}

function snapshotRunOutputChunk(value: unknown): RuntimeIpcOperationPayload {
  const payload = optionalPayload(value, ["sessionId", "runId", "outputItemId", "offset", "maxBytes"]);
  const output = snapshotRunOutputScopeFields(payload);
  if (!has(payload, "offset") || !isIntegerInRange(payload.offset, 0, Number.MAX_SAFE_INTEGER)) invalid();
  output.offset = payload.offset;
  if (has(payload, "maxBytes")) {
    if (!isIntegerInRange(payload.maxBytes, 1, APPLICATION_RUN_OUTPUT_LIMITS.chunkMaxBytes)) invalid();
    output.maxBytes = payload.maxBytes;
  }
  return output;
}

function snapshotRunOutputExport(value: unknown): RuntimeIpcOperationPayload {
  const payload = exactPayload(value, ["sessionId", "runId", "outputItemId", "destination"]);
  const output = snapshotRunOutputScopeFields(payload);
  if (!isAbsolutePath(payload.destination, APPLICATION_RUN_OUTPUT_LIMITS.maxDestinationPathLength)) invalid();
  output.destination = payload.destination;
  return output;
}

function snapshotRunScopeFields(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (
    !has(payload, "sessionId") ||
    !has(payload, "runId") ||
    !isIdentifier(payload.sessionId) ||
    !isIdentifier(payload.runId)
  ) {
    invalid();
  }
  return { sessionId: payload.sessionId, runId: payload.runId };
}

function snapshotRunOutputScopeFields(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output = snapshotRunScopeFields(payload);
  if (!has(payload, "outputItemId") || !isIdentifier(payload.outputItemId)) invalid();
  output.outputItemId = payload.outputItemId;
  return output;
}

function copyOptionalCursorAndLimit(
  payload: Readonly<Record<string, unknown>>,
  output: Record<string, unknown>,
  maxItems: number,
): void {
  if (has(payload, "cursor")) {
    if (!isBoundedString(payload.cursor, 2_048)) invalid();
    output.cursor = payload.cursor;
  }
  if (has(payload, "limit")) {
    if (!isIntegerInRange(payload.limit, 1, maxItems)) invalid();
    output.limit = payload.limit;
  }
}

function exactPayload(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const payload = snapshotRecord(value, keys);
  requireExactKeys(payload, keys);
  return payload;
}

function optionalPayload(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return snapshotRecord(value, keys);
}

function snapshotEnvelopeRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw runtimeProtocolFailure("invalid_envelope");
  const keys = Object.keys(value);
  if (
    keys.length > RUNTIME_IPC_LIMITS.maxObjectEntries ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  return snapshotRecord(value, keys);
}

function snapshotRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw runtimeProtocolFailure("invalid_envelope");
  const keys = Object.keys(value);
  if (
    keys.length > allowedKeys.length ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw runtimeProtocolFailure("invalid_envelope");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable) invalid();
    try {
      snapshot[key] =
        "value" in descriptor
          ? descriptor.value
          : typeof descriptor.get === "function"
            ? descriptor.get.call(value)
            : undefined;
    } catch {
      invalid();
    }
  }
  return snapshot;
}

function snapshotStringArray(
  value: unknown,
  maxItems: number,
  validate: (item: unknown) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  const length = value.length;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1 ||
    ownKeys.some((key, index) => key !== (index === length ? "length" : String(index)))
  ) {
    invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    const item = descriptor.value;
    if (!validate(item)) invalid();
    output.push(item as string);
  }
  return output;
}

function requireExactKeys(record: Readonly<Record<string, unknown>>, requiredKeys: readonly string[]): void {
  const keys = Object.keys(record);
  if (keys.length !== requiredKeys.length || requiredKeys.some((key) => !has(record, key))) invalid();
}

function runtimeOperation(value: unknown): RuntimeIpcOperation {
  if (typeof value !== "string" || !RUNTIME_IPC_OPERATIONS.includes(value as RuntimeIpcOperation)) invalid();
  return value as RuntimeIpcOperation;
}

function canonicalUuid(value: unknown): string {
  if (!isCanonicalUuid(value)) invalid();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (!isPositiveSafeInteger(value)) invalid();
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, 1_024);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function isAbsolutePath(value: unknown, maxLength: number): value is string {
  return isBoundedString(value, maxLength) && path.isAbsolute(value);
}

function failureMessage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > RUNTIME_IPC_LIMITS.maxFailureMessageBytes
  ) {
    invalid();
  }
  return value;
}

function has(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalid(): never {
  throw runtimeProtocolFailure("invalid_envelope");
}
