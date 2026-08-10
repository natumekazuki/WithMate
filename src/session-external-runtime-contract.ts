import { APPROVAL_MODE_VALUES, type ApprovalMode } from "./approval-mode.js";
import { CODEX_SANDBOX_MODE_VALUES, type CodexSandboxMode } from "./codex-sandbox-mode.js";
import { isModelReasoningEffort, type ModelReasoningEffort } from "./model-catalog.js";
import type { SessionExecution } from "./session-execution.js";

export const SESSION_RUNTIME_REQUEST_SCHEMA_VERSION = "withmate-session-request-v1" as const;
export const SESSION_RUNTIME_RESULT_SCHEMA_VERSION = "withmate-session-result-v1" as const;
export const SESSION_RUNTIME_ERROR_SCHEMA_VERSION = "withmate-session-error-v1" as const;
export const SESSION_RUNTIME_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const SESSION_RUNTIME_DEFAULT_LIST_LIMIT = 50;
export const SESSION_RUNTIME_MAX_LIST_LIMIT = 500;
export const SESSION_RUNTIME_DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS = 300_000;

export const SESSION_RUNTIME_OPERATIONS = [
  "turn.run",
  "turn.enqueue",
  "turn.list",
  "turn.get",
  "turn.cancel",
] as const;

export type SessionRuntimeOperation = (typeof SESSION_RUNTIME_OPERATIONS)[number];
export type SessionRuntimeAdapterKind = "cli" | "mcp";
export type SessionRuntimeEffect = "not_applied" | "applied" | "indeterminate";

export type SessionRuntimeTurnRequest = {
  userMessage: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
};

export type SessionRuntimeRunInput = {
  sessionId: string;
  catalogRevision: number;
  idempotencyKey: string;
  responseMode: "wait" | "deferred";
  waitTimeoutMs?: number;
  turn: SessionRuntimeTurnRequest;
};

export type SessionRuntimeEnqueueInput = Omit<SessionRuntimeRunInput, "responseMode" | "waitTimeoutMs">;
export type SessionRuntimeExecutionInput = { sessionId: string; executionId: string };
export type SessionRuntimeListInput = { sessionId: string; limit: number; cursor?: string };

export type SessionRuntimeRequestEnvelope = {
  schemaVersion: typeof SESSION_RUNTIME_REQUEST_SCHEMA_VERSION;
  operation: SessionRuntimeOperation;
  input: unknown;
};

export type SessionRuntimeResultEnvelope = {
  schemaVersion: typeof SESSION_RUNTIME_RESULT_SCHEMA_VERSION;
  operation: SessionRuntimeOperation;
  result: unknown;
};

export type SessionRuntimeError = {
  schemaVersion: typeof SESSION_RUNTIME_ERROR_SCHEMA_VERSION;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    effect: SessionRuntimeEffect;
    details: Record<string, string | number | boolean>;
  };
};

export class SessionRuntimeValidationError extends Error {
  readonly code: string;
  readonly details: Record<string, string | number | boolean>;

  constructor(message: string, details: Record<string, string | number | boolean> = {}, code = "INVALID_INPUT") {
    super(message);
    this.name = "SessionRuntimeValidationError";
    this.code = code;
    this.details = details;
  }
}

export function parseSessionRuntimeRequestEnvelope(value: unknown): SessionRuntimeRequestEnvelope {
  const record = requireObject(value, "request");
  assertKeys(record, ["schemaVersion", "operation", "input"], "request");
  if (record.schemaVersion !== SESSION_RUNTIME_REQUEST_SCHEMA_VERSION) {
    throw invalid("schemaVersion", "Unsupported Session runtime request schemaVersion.");
  }
  if (!SESSION_RUNTIME_OPERATIONS.includes(record.operation as SessionRuntimeOperation)) {
    throw invalid("operation", "Unsupported Session runtime operation.");
  }
  return {
    schemaVersion: SESSION_RUNTIME_REQUEST_SCHEMA_VERSION,
    operation: record.operation as SessionRuntimeOperation,
    input: parseSessionRuntimeOperationInput(record.operation as SessionRuntimeOperation, record.input),
  };
}

export function parseSessionRuntimeOperationInput(operation: SessionRuntimeOperation, value: unknown): unknown {
  if (!SESSION_RUNTIME_OPERATIONS.includes(operation)) {
    throw invalid("operation", "Unsupported Session runtime operation.");
  }
  if (operation === "turn.run") {
    return parseTurnRunInput(value);
  }
  if (operation === "turn.enqueue") {
    return parseTurnEnqueueInput(value);
  }
  if (operation === "turn.list") {
    return parseTurnListInput(value);
  }
  if (operation === "turn.get" || operation === "turn.cancel") {
    return parseExecutionInput(value);
  }
  throw invalid("operation", "Unsupported Session runtime operation.");
}

export function createSessionRuntimeResult(
  operation: SessionRuntimeOperation,
  result: unknown,
): SessionRuntimeResultEnvelope {
  return { schemaVersion: SESSION_RUNTIME_RESULT_SCHEMA_VERSION, operation, result };
}

export function createSessionRuntimeError(input: {
  code: string;
  message: string;
  retryable?: boolean;
  effect?: SessionRuntimeEffect;
  details?: Record<string, string | number | boolean>;
}): SessionRuntimeError {
  return {
    schemaVersion: SESSION_RUNTIME_ERROR_SCHEMA_VERSION,
    error: {
      code: input.code,
      message: input.message,
      retryable: input.retryable ?? false,
      effect: input.effect ?? "not_applied",
      details: input.details ?? {},
    },
  };
}

export function projectSessionExecution(execution: SessionExecution): SessionExecution {
  return {
    id: execution.id,
    sessionId: execution.sessionId,
    operation: execution.operation,
    state: execution.state,
    result: projectTurnResult(execution.result),
    errorCode: execution.errorCode,
    reason: execution.reason,
    createdAt: execution.createdAt,
    admittedAt: execution.admittedAt,
    completedAt: execution.completedAt,
    updatedAt: execution.updatedAt,
  };
}

function projectTurnResult(result: unknown): { assistantText: string } | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const assistantText = (result as Record<string, unknown>).assistantText;
  return typeof assistantText === "string" ? { assistantText } : null;
}

function parseTurnRunInput(value: unknown): SessionRuntimeRunInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "catalogRevision", "idempotencyKey", "responseMode", "waitTimeoutMs", "turn"], "input");
  const responseMode = requireEnum(record.responseMode, ["wait", "deferred"] as const, "responseMode");
  if (responseMode === "deferred" && record.waitTimeoutMs !== undefined) {
    throw invalid("waitTimeoutMs", "waitTimeoutMs is only valid when responseMode is wait.");
  }
  return {
    ...parseTurnMutationBase(record),
    responseMode,
    ...(record.waitTimeoutMs === undefined
      ? {}
      : { waitTimeoutMs: requireInteger(record.waitTimeoutMs, "waitTimeoutMs", 1, SESSION_RUNTIME_MAX_WAIT_TIMEOUT_MS) }),
  };
}

function parseTurnEnqueueInput(value: unknown): SessionRuntimeEnqueueInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "catalogRevision", "idempotencyKey", "turn"], "input");
  return parseTurnMutationBase(record);
}

function parseTurnMutationBase(record: Record<string, unknown>): SessionRuntimeEnqueueInput {
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    catalogRevision: requireInteger(record.catalogRevision, "catalogRevision", 1, Number.MAX_SAFE_INTEGER),
    idempotencyKey: requireNonEmptyString(record.idempotencyKey, "idempotencyKey"),
    turn: parseTurnRequest(record.turn),
  };
}

function parseTurnRequest(value: unknown): SessionRuntimeTurnRequest {
  const record = requireObject(value, "turn");
  assertKeys(record, ["userMessage", "model", "reasoningEffort", "approvalMode", "codexSandboxMode"], "turn");
  const reasoningEffort = record.reasoningEffort;
  if (!isModelReasoningEffort(reasoningEffort)) {
    throw invalid("reasoningEffort", "reasoningEffort is invalid.");
  }
  return {
    userMessage: requireNonEmptyString(record.userMessage, "userMessage"),
    model: requireNonEmptyString(record.model, "model"),
    reasoningEffort,
    approvalMode: requireEnum(record.approvalMode, APPROVAL_MODE_VALUES, "approvalMode"),
    codexSandboxMode: requireEnum(record.codexSandboxMode, CODEX_SANDBOX_MODE_VALUES, "codexSandboxMode"),
  };
}

function parseExecutionInput(value: unknown): SessionRuntimeExecutionInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "executionId"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    executionId: requireNonEmptyString(record.executionId, "executionId"),
  };
}

function parseTurnListInput(value: unknown): SessionRuntimeListInput {
  const record = requireObject(value, "input");
  assertKeys(record, ["sessionId", "limit", "cursor"], "input");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "sessionId"),
    limit: record.limit === undefined
      ? SESSION_RUNTIME_DEFAULT_LIST_LIMIT
      : requireInteger(record.limit, "limit", 1, SESSION_RUNTIME_MAX_LIST_LIMIT, "LIMIT_EXCEEDED"),
    ...(record.cursor === undefined ? {} : { cursor: requireNonEmptyString(record.cursor, "cursor") }),
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(field, `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknownKey) {
    throw invalid(`${field}.${unknownKey}`, `Unknown field: ${unknownKey}.`);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(field, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireInteger(value: unknown, field: string, min: number, max: number, code = "INVALID_INPUT"): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(field, `${field} must be an integer from ${min} through ${max}.`, code);
  }
  return value as number;
}

function requireEnum<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw invalid(field, `${field} is invalid.`);
  }
  return value as T[number];
}

function invalid(field: string, message: string, code = "INVALID_INPUT"): SessionRuntimeValidationError {
  return new SessionRuntimeValidationError(message, { field }, code);
}
