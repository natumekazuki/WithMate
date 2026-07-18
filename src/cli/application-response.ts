import { normalizeHostAbsolutePath, WORKSPACE_PATH_MAX_LENGTH } from "../shared/workspace-path.js";
import {
  CLI_EXIT_CODES,
  CLI_SCHEMA_VERSION,
  CLI_SESSION_LIMITS,
  type CliApplicationError,
  type CliApplicationIssue,
  type CliApplicationResponse,
  type CliCommandIdentity,
  type CliExitCode,
  type CliOperationOutput,
  type CliPersistenceError,
  type CliPersistenceStatus,
  type CliRuntimeFailureOutput,
  type CliSessionOperation,
  type CliStructuredOutput,
  type CliValidatedCommand,
} from "./contract.js";

export type CliOperationProjectionResult =
  | Readonly<{ ok: true; output: CliOperationOutput; exitCode: CliExitCode }>
  | Readonly<{ ok: false; output: CliRuntimeFailureOutput; exitCode: typeof CLI_EXIT_CODES.runtimeFailure }>;

type OperationMode = "read" | "write";
type CommandFor<TOperation extends CliSessionOperation> = Extract<
  CliValidatedCommand,
  Readonly<{ identity: CliCommandIdentity<TOperation> }>
>;

const operationModes: Readonly<Record<CliSessionOperation, OperationMode>> = {
  create: "write",
  list: "read",
  read: "read",
  "directories-chunk": "read",
  archive: "write",
  unarchive: "write",
  close: "write",
};

export function projectCliOperationOutput(
  command: CliValidatedCommand,
  applicationResponse: unknown,
): CliOperationProjectionResult {
  try {
    const projected = projectApplicationResponse(
      command,
      operationModes[command.identity.operation],
      applicationResponse,
    );
    const output = {
      schemaVersion: CLI_SCHEMA_VERSION,
      kind: "operation",
      command: { namespace: "session", operation: command.identity.operation },
      applicationResponse: projected,
    } as CliOperationOutput;
    return { ok: true, output, exitCode: exitCodeForApplicationResponse(projected) };
  } catch {
    return {
      ok: false,
      output: runtimeProjectionFailure(command.identity),
      exitCode: CLI_EXIT_CODES.runtimeFailure,
    };
  }
}

export function serializeCliStructuredOutput(output: CliStructuredOutput): string {
  const serialized = JSON.stringify(output);
  if (serialized === undefined) throw new TypeError("CLI output could not be serialized.");
  return `${serialized}\n`;
}

function projectApplicationResponse(
  command: CliValidatedCommand,
  mode: OperationMode,
  value: unknown,
): CliApplicationResponse<unknown, OperationMode> {
  const response = record(value);
  const overallStatus = response.overallStatus;
  if (overallStatus === "success") {
    const persistence = projectPersistenceStatus(response.persistence);
    if (mode === "read" ? persistence.status !== "read" : persistence.status !== "committed") malformed();
    return {
      overallStatus,
      value: projectOperationValue(command, response.value),
      persistence,
    } as CliApplicationResponse<unknown, OperationMode>;
  }
  if (overallStatus === "partial_success") {
    const persistence = projectPersistenceStatus(response.persistence);
    const issues = projectIssues(response.issues);
    const projectedValue = projectOperationValue(command, response.value);
    if (issues.length === 0) malformed();
    if (mode === "read") {
      if (persistence.status !== "read" || issues.some((issue) => issue.kind !== "omission")) malformed();
      if (isCommandFor(command, "list")) {
        const page = record(projectedValue);
        if (!Array.isArray(page.items) || page.items.length + issues.length > command.limit) malformed();
      }
    } else {
      if (
        persistence.status !== "failed" ||
        issues.some((issue) => issue.kind !== "persistence" || issue.effect !== persistence.effect)
      ) {
        malformed();
      }
    }
    return {
      overallStatus,
      value: projectedValue,
      issues,
      persistence,
    } as CliApplicationResponse<unknown, OperationMode>;
  }
  if (overallStatus !== "failure") malformed();
  const error = projectApplicationError(response.error);
  const persistence = projectPersistenceStatus(response.persistence);
  if (!failureCombinationIsValid(mode, error, persistence)) malformed();
  return { overallStatus, error, persistence } as CliApplicationResponse<unknown, OperationMode>;
}

function projectOperationValue(command: CliValidatedCommand, value: unknown): unknown {
  if (isCommandFor(command, "create")) return projectCreateValue(value, command.workspacePath);
  if (isCommandFor(command, "list")) return projectListValue(value, command);
  if (isCommandFor(command, "read")) return projectReadValue(value, command.sessionId);
  if (isCommandFor(command, "directories-chunk")) {
    return projectDirectoriesChunkValue(value, command.sessionId, command.offset, command.maxBytes);
  }
  if (isCommandFor(command, "archive")) return projectTransitionValue(value, command.sessionId, "archived");
  if (isCommandFor(command, "unarchive")) return projectTransitionValue(value, command.sessionId, "active");
  if (isCommandFor(command, "close")) return projectTransitionValue(value, command.sessionId, "closed");
  malformed();
}

function projectCreateValue(value: unknown, expectedWorkspacePath: string): unknown {
  const item = record(value);
  const sessionId = boundedString(item.sessionId);
  const workspacePath = normalizedAbsolutePath(item.workspacePath);
  const createdAt = nonNegativeInteger(item.createdAt);
  if (item.lifecycleStatus !== "active" || !sameHostPathIdentity(workspacePath, expectedWorkspacePath)) malformed();
  return { sessionId, workspacePath, lifecycleStatus: "active", createdAt };
}

function projectListValue(value: unknown, command: CommandFor<"list">): unknown {
  const page = record(value);
  const items = snapshotDenseArray(page.items, command.limit).map(projectListItem);
  const expectedWorkspacePath = command.workspacePath;
  if (
    (expectedWorkspacePath !== undefined &&
      items.some((item) => !sameHostPathIdentity(item.workspacePath, expectedWorkspacePath))) ||
    (command.lifecycleStatus !== undefined && items.some((item) => item.lifecycleStatus !== command.lifecycleStatus))
  ) {
    malformed();
  }
  const nextCursor = optionalBoundedString(page.nextCursor, CLI_SESSION_LIMITS.maxCursorLength);
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

function projectListItem(value: unknown): Readonly<Record<string, string | number>> {
  const item = record(value);
  const id = boundedString(item.id);
  const workspacePath = normalizedAbsolutePath(item.workspacePath);
  const defaultCharacterId = boundedString(item.defaultCharacterId);
  const lifecycleStatus = lifecycle(item.lifecycleStatus);
  const createdAt = nonNegativeInteger(item.createdAt);
  const updatedAt = nonNegativeInteger(item.updatedAt);
  const lastActivityAt = nonNegativeInteger(item.lastActivityAt);
  const stateChangedAt = nonNegativeInteger(item.stateChangedAt);
  const executionState = executionStateValue(item.executionState);
  const activeRunId = optionalBoundedString(item.activeRunId);
  const latestRunId = optionalBoundedString(item.latestRunId);
  validateExecution(executionState, activeRunId, latestRunId);
  if (lifecycleStatus !== "active" && executionState === "running") malformed();
  return {
    id,
    workspacePath,
    defaultCharacterId,
    lifecycleStatus,
    createdAt,
    updatedAt,
    lastActivityAt,
    executionState,
    ...(activeRunId === undefined ? {} : { activeRunId }),
    ...(latestRunId === undefined ? {} : { latestRunId }),
    stateChangedAt,
  };
}

function projectReadValue(value: unknown, expectedSessionId: string): unknown {
  const result = record(value);
  const session = record(result.session);
  const execution = projectExecution(result.execution);
  const lifecycleStatus = lifecycle(session.lifecycleStatus);
  if (lifecycleStatus !== "active" && execution.state === "running") malformed();
  const sessionId = boundedString(session.id);
  if (sessionId !== expectedSessionId) malformed();
  return {
    session: {
      id: sessionId,
      providerId: boundedString(session.providerId),
      workspacePath: normalizedAbsolutePath(session.workspacePath),
      allowedAdditionalDirectoriesByteLength: nonNegativeInteger(session.allowedAdditionalDirectoriesByteLength),
      allowedAdditionalDirectoriesState: enumValue(session.allowedAdditionalDirectoriesState, ["inline", "chunked"]),
      defaultCharacterId: boundedString(session.defaultCharacterId),
      maxConcurrentChildRuns: childRunLimit(session.maxConcurrentChildRuns),
      lifecycleStatus,
      createdAt: nonNegativeInteger(session.createdAt),
      updatedAt: nonNegativeInteger(session.updatedAt),
      lastActivityAt: nonNegativeInteger(session.lastActivityAt),
    },
    execution,
  };
}

function projectExecution(value: unknown): Readonly<Record<string, string>> {
  const execution = record(value);
  const state = executionStateValue(execution.state);
  const activeRunId = optionalBoundedString(execution.activeRunId);
  const latestRunId = optionalBoundedString(execution.latestRunId);
  validateExecution(state, activeRunId, latestRunId);
  return {
    state,
    ...(activeRunId === undefined ? {} : { activeRunId }),
    ...(latestRunId === undefined ? {} : { latestRunId }),
  };
}

function projectDirectoriesChunkValue(
  value: unknown,
  expectedSessionId: string,
  expectedOffset: number,
  requestedMaxBytes: number,
): unknown {
  const chunk = record(value);
  const sessionId = boundedString(chunk.sessionId);
  const offset = nonNegativeInteger(chunk.offset);
  const totalBytes = nonNegativeInteger(chunk.totalBytes);
  if (typeof chunk.eof !== "boolean" || !(chunk.bytes instanceof ArrayBuffer)) malformed();
  const byteLength = chunk.bytes.byteLength;
  const endOffset = offset + byteLength;
  if (
    sessionId !== expectedSessionId ||
    offset !== expectedOffset ||
    byteLength > requestedMaxBytes ||
    !Number.isSafeInteger(endOffset) ||
    (offset >= totalBytes
      ? byteLength !== 0 || !chunk.eof
      : byteLength === 0 || endOffset > totalBytes || chunk.eof !== (endOffset === totalBytes))
  ) {
    malformed();
  }
  return {
    sessionId,
    offset,
    totalBytes,
    eof: chunk.eof,
    chunk: {
      encoding: "base64",
      byteLength,
      data: Buffer.from(chunk.bytes).toString("base64"),
    },
  };
}

function projectTransitionValue(
  value: unknown,
  expectedSessionId: string,
  expectedLifecycleStatus: "active" | "archived" | "closed",
): unknown {
  const transition = record(value);
  const sessionId = boundedString(transition.sessionId);
  if (transition.lifecycleStatus !== expectedLifecycleStatus || sessionId !== expectedSessionId) malformed();
  return {
    sessionId,
    lifecycleStatus: expectedLifecycleStatus,
    updatedAt: nonNegativeInteger(transition.updatedAt),
  };
}

function projectPersistenceStatus(value: unknown): CliPersistenceStatus {
  const persistence = record(value);
  switch (persistence.status) {
    case "not_attempted":
    case "read":
    case "rejected":
      if (persistence.effect !== "none") malformed();
      return { status: persistence.status, effect: "none" };
    case "committed":
      if (persistence.effect !== "none" || typeof persistence.replayed !== "boolean") malformed();
      return { status: "committed", effect: "none", replayed: persistence.replayed };
    case "failed":
      if (persistence.effect === "none") return { status: "failed", effect: "none" };
      if (persistence.effect === "unknown" && persistence.reconciliation === "exact_request_required") {
        return { status: "failed", effect: "unknown", reconciliation: "exact_request_required" };
      }
      malformed();
  }
  malformed();
}

function projectApplicationError(value: unknown): CliApplicationError {
  const error = record(value);
  const message = boundedString(error.message, 8_192);
  if (typeof error.retryable !== "boolean") malformed();
  switch (error.kind) {
    case "request":
      if (error.code !== "request_invalid" || error.retryable) malformed();
      return { kind: "request", code: "request_invalid", message, retryable: false };
    case "access": {
      const code = enumValue(error.code, [
        "workspace_invalid",
        "workspace_unavailable",
        "authorization_invalid",
        "forbidden",
      ] as const);
      return { kind: "access", code, message, retryable: error.retryable };
    }
    case "operation":
      if (error.code === "operation_timeout" && error.retryable) {
        return { kind: "operation", code: error.code, message, retryable: true };
      }
      if (error.code === "operation_canceled" && !error.retryable) {
        return { kind: "operation", code: error.code, message, retryable: false };
      }
      malformed();
    case "domain":
      return projectDomainError(error, message);
    case "persistence":
      return projectPersistenceError(error, message);
    case "application":
      if (error.code !== "internal_error" || error.retryable) malformed();
      return { kind: "application", code: "internal_error", message, retryable: false };
    default:
      malformed();
  }
}

function projectDomainError(error: Readonly<Record<string, unknown>>, message: string): CliApplicationError {
  if (error.code === "capacity_exceeded") {
    if (!error.retryable) malformed();
    return {
      kind: "domain",
      code: error.code,
      message,
      retryable: true,
      details: projectCapacityDetails(error.details),
    };
  }
  const code = enumValue(error.code, [
    "request_invalid",
    "cursor_invalid",
    "not_found",
    "reference_invalid",
    "lifecycle_conflict",
    "session_busy",
    "idempotency_conflict",
    "idempotency_in_progress",
    "idempotency_expired",
  ] as const);
  return { kind: "domain", code, message, retryable: error.retryable as boolean };
}

function projectCapacityDetails(
  value: unknown,
): Extract<CliApplicationError, Readonly<{ code: "capacity_exceeded" }>>["details"] {
  const details = record(value);
  const current = nonNegativeInteger(details.current);
  const limit = nonNegativeInteger(details.limit);
  if (details.scope === "root") {
    return { scope: "root", rootSessionId: boundedString(details.rootSessionId), current, limit };
  }
  if (details.scope === "provider") {
    return { scope: "provider", providerId: boundedString(details.providerId), current, limit };
  }
  if (details.scope === "application") return { scope: "application", current, limit };
  malformed();
}

function projectPersistenceError(
  error: Readonly<Record<string, unknown>>,
  message: string,
): CliPersistenceError<"none"> | CliPersistenceError<"unknown"> {
  const code = enumValue(error.code, [
    "persistence_unavailable",
    "persistence_busy",
    "persistence_timeout",
    "persistence_canceled",
    "persistence_configuration_invalid",
    "persistence_integrity_failed",
    "persistence_response_too_large",
    "persistence_operation_failed",
  ] as const);
  if (typeof error.retryable !== "boolean" || (error.effect !== "none" && error.effect !== "unknown")) {
    malformed();
  }
  return { kind: "persistence", code, message, retryable: error.retryable, effect: error.effect };
}

function projectIssues(value: unknown): readonly CliApplicationIssue[] {
  return snapshotDenseArray(value, CLI_SESSION_LIMITS.listMaxItems).map((candidate) => {
    const issue = record(candidate);
    if (issue.kind === "omission") {
      if (issue.code !== "response_size_limit") malformed();
      const message = boundedString(issue.message, 8_192);
      const ordinal = issue.ordinal === undefined ? undefined : nonNegativeInteger(issue.ordinal);
      return ordinal === undefined
        ? { kind: "omission", code: "response_size_limit", message }
        : { kind: "omission", code: "response_size_limit", message, ordinal };
    }
    if (issue.kind !== "persistence") malformed();
    return projectPersistenceError(issue, boundedString(issue.message, 8_192));
  });
}

function snapshotDenseArray(value: unknown, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value)) malformed();
  const length = value.length;
  if (length > maxLength) malformed();
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (value.length !== length || !Object.hasOwn(value, index)) malformed();
    const item = value[index];
    if (value.length !== length) malformed();
    snapshot.push(item);
  }
  return snapshot;
}

function failureCombinationIsValid(
  mode: OperationMode,
  error: CliApplicationError,
  persistence: CliPersistenceStatus,
): boolean {
  switch (error.kind) {
    case "request":
    case "access":
    case "operation":
      return persistence.status === "not_attempted";
    case "domain":
      return persistence.status === "rejected";
    case "persistence":
      return (
        persistence.status === "failed" &&
        persistence.effect === error.effect &&
        (mode === "write" || error.effect === "none")
      );
    case "application":
      return (
        persistence.status === "not_attempted" ||
        (mode === "read" && persistence.status === "failed" && persistence.effect === "none") ||
        (mode === "write" && persistence.status === "failed" && persistence.effect === "unknown")
      );
  }
}

function exitCodeForApplicationResponse(response: CliApplicationResponse<unknown, OperationMode>): CliExitCode {
  if (response.overallStatus === "success") return CLI_EXIT_CODES.success;
  if (response.overallStatus === "partial_success") return CLI_EXIT_CODES.partialSuccess;
  switch (response.error.kind) {
    case "request":
      return CLI_EXIT_CODES.usageInvalid;
    case "access":
      return CLI_EXIT_CODES.accessRejected;
    case "domain":
      return CLI_EXIT_CODES.domainRejected;
    case "operation":
      return response.error.code === "operation_timeout" ? CLI_EXIT_CODES.timeout : CLI_EXIT_CODES.canceled;
    case "persistence":
      if (response.error.code === "persistence_timeout") return CLI_EXIT_CODES.timeout;
      if (response.error.code === "persistence_canceled") return CLI_EXIT_CODES.canceled;
      return response.error.effect === "none"
        ? CLI_EXIT_CODES.persistenceFailedNoEffect
        : CLI_EXIT_CODES.persistenceFailedUnknownEffect;
    case "application":
      return CLI_EXIT_CODES.runtimeFailure;
  }
}

function runtimeProjectionFailure(command: CliCommandIdentity): CliRuntimeFailureOutput {
  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    kind: "runtime_failure",
    command: { namespace: "session", operation: command.operation },
    error: {
      kind: "runtime",
      code: "malformed_application_response",
      stage: "operation",
      message: "Application operation returned an invalid response.",
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed();
  return value as Readonly<Record<string, unknown>>;
}

function boundedString(value: unknown, maxLength: number = CLI_SESSION_LIMITS.maxIdentifierLength): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) malformed();
  return value;
}

function optionalBoundedString(
  value: unknown,
  maxLength: number = CLI_SESSION_LIMITS.maxIdentifierLength,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, maxLength);
}

function normalizedAbsolutePath(value: unknown): string {
  if (typeof value !== "string") malformed();
  const normalized = normalizeHostAbsolutePath(value);
  if (normalized === undefined || normalized.path !== value || normalized.path.length > WORKSPACE_PATH_MAX_LENGTH) {
    malformed();
  }
  return normalized.path;
}

function sameHostPathIdentity(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const leftPath = normalizeHostAbsolutePath(left);
  const rightPath = normalizeHostAbsolutePath(right);
  return leftPath !== undefined && rightPath !== undefined && leftPath.comparisonKey === rightPath.comparisonKey;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) malformed();
  return value as number;
}

function childRunLimit(value: unknown): number {
  const integer = nonNegativeInteger(value);
  if (integer > CLI_SESSION_LIMITS.maxConcurrentChildRuns) malformed();
  return integer;
}

function lifecycle(value: unknown): "active" | "archived" | "closed" {
  return enumValue(value, ["active", "archived", "closed"] as const);
}

function executionStateValue(
  value: unknown,
): "not_started" | "running" | "completed" | "failed" | "canceled" | "interrupted" {
  return enumValue(value, ["not_started", "running", "completed", "failed", "canceled", "interrupted"] as const);
}

function validateExecution(state: string, activeRunId: string | undefined, latestRunId: string | undefined): void {
  if (state === "not_started") {
    if (activeRunId !== undefined || latestRunId !== undefined) malformed();
    return;
  }
  if (state === "running") {
    if (activeRunId === undefined || latestRunId === undefined || activeRunId !== latestRunId) malformed();
    return;
  }
  if (activeRunId !== undefined || latestRunId === undefined) malformed();
}

function enumValue<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) malformed();
  return value as TValue;
}

function isCommandFor<TOperation extends CliSessionOperation>(
  command: CliValidatedCommand,
  operation: TOperation,
): command is CommandFor<TOperation> {
  return command.identity.operation === operation;
}

function malformed(): never {
  throw new TypeError("Malformed Application response.");
}
