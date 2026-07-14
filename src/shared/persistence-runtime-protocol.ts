import {
  PERSISTENCE_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type PersistenceError,
  type PersistenceErrorCode,
  type PersistenceFailureEffect,
  type PersistenceRequestClass,
  type WorkerToMainMessage,
} from "./persistence-protocol.js";

export type ProtocolDecodeFailure = Readonly<{
  ok: false;
  code: "protocol_invalid" | "protocol_version_unsupported";
}>;

export type ProtocolDecodeResult<T> = Readonly<{ ok: true; value: T }> | ProtocolDecodeFailure;

const canonicalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const operationPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const requestClasses = new Set<PersistenceRequestClass>(["read", "write", "maintenance"]);
const failureEffects = new Set<PersistenceFailureEffect>(["none", "unknown"]);
const errorCodes = new Set<PersistenceErrorCode>([
  "protocol_invalid",
  "protocol_version_unsupported",
  "worker_not_ready",
  "worker_closing",
  "worker_crashed",
  "worker_start_failed",
  "worker_shutdown_forced",
  "request_canceled",
  "request_timeout",
  "request_id_duplicate",
  "queue_full",
  "request_invalid",
  "cursor_invalid",
  "not_found",
  "operation_not_supported",
  "database_path_invalid",
  "database_busy",
  "database_identity_mismatch",
  "database_schema_unknown",
  "database_schema_too_new",
  "database_schema_too_old",
  "database_schema_verification_failed",
  "database_integrity_check_failed",
  "database_pragma_mismatch",
  "database_wal_unavailable",
  "database_bootstrap_failed",
  "schema_artifact_invalid",
  "database_unavailable",
  "response_too_large",
  "payload_chunk_invalid",
  "payload_chunk_too_large",
  "operation_failed",
  "internal_error",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && canonicalUuidPattern.test(value);
}

export function decodeMainToWorkerMessage(value: unknown): ProtocolDecodeResult<MainToWorkerMessage> {
  const base = decodeBase(value);
  if (!base.ok) {
    return base;
  }

  switch (base.value.kind) {
    case "request":
      if (
        !hasExactKeys(base.value, [
          "protocolVersion",
          "generationId",
          "kind",
          "requestId",
          "requestSequence",
          "operation",
          "requestClass",
          "payload",
        ]) ||
        !isCanonicalUuid(base.value.requestId) ||
        !Number.isSafeInteger(base.value.requestSequence) ||
        (base.value.requestSequence as number) < 1 ||
        typeof base.value.operation !== "string" ||
        base.value.operation.length > 128 ||
        !operationPattern.test(base.value.operation) ||
        !isPersistenceRequestClass(base.value.requestClass) ||
        !isPlainObject(base.value.payload)
      ) {
        return invalid();
      }
      return success(base.value as MainToWorkerMessage);
    case "cancel":
    case "shutdown":
      if (
        !hasExactKeys(base.value, ["protocolVersion", "generationId", "kind", "requestId"]) ||
        !isCanonicalUuid(base.value.requestId)
      ) {
        return invalid();
      }
      return success(base.value as MainToWorkerMessage);
    default:
      return invalid();
  }
}

export function decodeWorkerToMainMessage(value: unknown): ProtocolDecodeResult<WorkerToMainMessage> {
  const base = decodeBase(value);
  if (!base.ok) {
    return base;
  }

  switch (base.value.kind) {
    case "ready":
      return hasExactKeys(base.value, ["protocolVersion", "generationId", "kind"])
        ? success(base.value as WorkerToMainMessage)
        : invalid();
    case "startupFailed":
      return hasExactKeys(base.value, ["protocolVersion", "generationId", "kind", "error"]) &&
        isPersistenceError(base.value.error)
        ? success(base.value as WorkerToMainMessage)
        : invalid();
    case "response":
      return decodeResponse(base.value);
    case "closed":
      return hasExactKeys(base.value, ["protocolVersion", "generationId", "kind", "requestId", "checkpoint"]) &&
        isCanonicalUuid(base.value.requestId) &&
        (base.value.checkpoint === "completed" || base.value.checkpoint === "failed")
        ? success(base.value as WorkerToMainMessage)
        : invalid();
    default:
      return invalid();
  }
}

function decodeBase(value: unknown): ProtocolDecodeResult<Record<string, unknown>> {
  if (!isPlainObject(value) || !isCanonicalUuid(value.generationId) || typeof value.kind !== "string") {
    return invalid();
  }
  if (value.protocolVersion !== PERSISTENCE_PROTOCOL_VERSION) {
    return { ok: false, code: "protocol_version_unsupported" };
  }
  return success(value);
}

function decodeResponse(value: Record<string, unknown>): ProtocolDecodeResult<WorkerToMainMessage> {
  if (!isCanonicalUuid(value.requestId) || typeof value.ok !== "boolean") {
    return invalid();
  }
  if (value.ok) {
    return hasExactKeys(value, ["protocolVersion", "generationId", "kind", "requestId", "ok", "result"])
      ? success(value as WorkerToMainMessage)
      : invalid();
  }
  return hasExactKeys(value, ["protocolVersion", "generationId", "kind", "requestId", "ok", "error"]) &&
    isPersistenceError(value.error)
    ? success(value as WorkerToMainMessage)
    : invalid();
}

function isPersistenceError(value: unknown): value is PersistenceError {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ["code", "message", "retryable", "effect"]) &&
    typeof value.code === "string" &&
    errorCodes.has(value.code as PersistenceErrorCode) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 512 &&
    typeof value.retryable === "boolean" &&
    typeof value.effect === "string" &&
    failureEffects.has(value.effect as PersistenceFailureEffect)
  );
}

function isPersistenceRequestClass(value: unknown): value is PersistenceRequestClass {
  return typeof value === "string" && requestClasses.has(value as PersistenceRequestClass);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function success<T>(value: T): ProtocolDecodeResult<T> {
  return { ok: true, value };
}

function invalid(): ProtocolDecodeFailure {
  return { ok: false, code: "protocol_invalid" };
}
