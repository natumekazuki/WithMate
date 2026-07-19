import { normalizeHostAbsolutePath, WORKSPACE_PATH_MAX_LENGTH } from "../shared/workspace-path.js";
import {
  isCanonicalSessionTitle,
  isLocalRepositoryKey,
  isRepositoryName,
  sessionSearchKey,
  snapshotLocalRepositoryMetadata,
} from "../shared/session-metadata.js";
import { MAX_SESSION_TREE_SIZE } from "../shared/session-limits.js";
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
  type CliRunOutputExportCleanupIssue,
  type CliRunOutputExportResponse,
  type CliRunOutputExportValue,
  type CliRunOutputPublication,
  type CliSessionCleanupIssue,
  type CliSessionDeleteResponse,
  type CliSessionOperation,
  type CliStructuredOutput,
  type CliValidatedCommand,
  type CliValidatedSessionCommand,
} from "./contract.js";

export type CliOperationProjectionResult =
  | Readonly<{ ok: true; output: CliOperationOutput; exitCode: CliExitCode }>
  | Readonly<{ ok: false; output: CliRuntimeFailureOutput; exitCode: typeof CLI_EXIT_CODES.runtimeFailure }>;

type OperationMode = "read" | "write";
type ProjectedApplicationResponse = CliApplicationResponse<unknown, OperationMode> | CliSessionDeleteResponse;
type CommandFor<TOperation extends CliSessionOperation> = Extract<
  CliValidatedSessionCommand,
  Readonly<{ identity: CliCommandIdentity<TOperation> }>
>;

const operationModes: Readonly<Record<CliSessionOperation, OperationMode>> = {
  create: "write",
  rename: "write",
  list: "read",
  repositories: "read",
  read: "read",
  "directories-chunk": "read",
  archive: "write",
  unarchive: "write",
  close: "write",
  delete: "write",
};

const BASE_DOMAIN_CODES = [
  "capacity_exceeded",
  "request_invalid",
  "cursor_invalid",
  "not_found",
  "reference_invalid",
  "lifecycle_conflict",
  "session_busy",
  "insufficient_disk_space",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "identity_exhausted",
] as const;

const RUN_OUTPUT_EXPORT_DOMAIN_CODES = [
  "request_invalid",
  "cursor_invalid",
  "not_found",
  "payload_unavailable",
  "destination_exists",
  "destination_invalid",
  "payload_integrity_mismatch",
] as const;

export function projectCliOperationOutput(
  command: CliValidatedCommand,
  applicationResponse: unknown,
): CliOperationProjectionResult {
  try {
    if (command.identity.namespace !== "session") throw new TypeError("Expected a Session command.");
    const sessionCommand = command as CliValidatedSessionCommand;
    const projected = projectApplicationResponse(
      sessionCommand,
      operationModes[sessionCommand.identity.operation],
      applicationResponse,
    );
    const output = {
      schemaVersion: CLI_SCHEMA_VERSION,
      kind: "operation",
      command: { namespace: "session", operation: sessionCommand.identity.operation },
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

export function projectCliReadApplicationResponse<TValue>(
  value: unknown,
  projectValue: (value: unknown) => TValue,
  maxIssues: number,
): CliApplicationResponse<TValue, "read"> {
  return projectCliScopedReadApplicationResponse(value, projectValue, maxIssues, BASE_DOMAIN_CODES);
}

export function projectCliRunOutputReadApplicationResponse<TValue>(
  value: unknown,
  projectValue: (value: unknown) => TValue,
  maxIssues: number,
  allowedDomainCodes: readonly string[],
): CliApplicationResponse<TValue, "read"> {
  return projectCliScopedReadApplicationResponse(value, projectValue, maxIssues, allowedDomainCodes);
}

function projectCliScopedReadApplicationResponse<TValue>(
  value: unknown,
  projectValue: (value: unknown) => TValue,
  maxIssues: number,
  allowedDomainCodes: readonly string[],
): CliApplicationResponse<TValue, "read"> {
  const response = record(value);
  if (response.overallStatus === "success") {
    const persistence = projectPersistenceStatus(response.persistence);
    if (persistence.status !== "read") malformed();
    return { overallStatus: "success", value: projectValue(response.value), persistence };
  }
  if (response.overallStatus === "partial_success") {
    const persistence = projectPersistenceStatus(response.persistence);
    const issues = projectIssuesWithLimit(response.issues, maxIssues);
    if (persistence.status !== "read" || issues.length === 0 || issues.some((issue) => issue.kind !== "omission")) {
      malformed();
    }
    return {
      overallStatus: "partial_success",
      value: projectValue(response.value),
      issues,
      persistence,
    } as CliApplicationResponse<TValue, "read">;
  }
  if (response.overallStatus !== "failure") malformed();
  const error = projectApplicationError(response.error, allowedDomainCodes);
  const persistence = projectPersistenceStatus(response.persistence);
  if (!failureCombinationIsValid("read", false, error, persistence)) malformed();
  return { overallStatus: "failure", error, persistence } as CliApplicationResponse<TValue, "read">;
}

export function projectCliRunOutputExportApplicationResponse(
  value: unknown,
  projectValue: (value: unknown) => CliRunOutputExportValue,
): CliRunOutputExportResponse {
  const response = record(value);
  const publication = projectRunOutputPublication(response.publication);
  if (response.overallStatus === "success") {
    const persistence = projectPersistenceStatus(response.persistence);
    if (persistence.status !== "read" || publication.status !== "published") malformed();
    return { overallStatus: "success", value: projectValue(response.value), publication, persistence };
  }
  if (response.overallStatus === "partial_success") {
    const persistence = projectPersistenceStatus(response.persistence);
    const issues = projectIssuesWithLimit(response.issues, 1);
    if (
      persistence.status !== "read" ||
      publication.status !== "published" ||
      issues.length !== 1 ||
      issues[0]?.kind !== "cleanup" ||
      issues[0].code !== "export_temporary_cleanup_pending"
    ) {
      malformed();
    }
    return {
      overallStatus: "partial_success",
      value: projectValue(response.value),
      issues: issues as readonly [CliRunOutputExportCleanupIssue],
      publication,
      persistence,
    };
  }
  if (response.overallStatus !== "failure") malformed();
  const error = projectApplicationError(response.error, RUN_OUTPUT_EXPORT_DOMAIN_CODES);
  const persistence = projectPersistenceStatus(response.persistence);
  if (!runOutputExportFailureCombinationIsValid(error, persistence, publication)) malformed();
  return { overallStatus: "failure", error, publication, persistence } as CliRunOutputExportResponse;
}

function runOutputExportFailureCombinationIsValid(
  error: CliApplicationError,
  persistence: CliPersistenceStatus,
  publication: CliRunOutputPublication,
): boolean {
  if (publication.status === "published") return false;
  const definitelyUnpublished = publication.status === "not_published" && publication.temporaryCleanup === "complete";
  if (persistence.status === "not_attempted") {
    return definitelyUnpublished && failureCombinationIsValid("read", false, error, persistence);
  }
  if (persistence.status === "rejected") {
    if (error.kind !== "domain") return false;
    if (error.code === "payload_unavailable") {
      return definitelyUnpublished && error.retryable === (error.details.reason === "pending");
    }
    return (
      ["request_invalid", "cursor_invalid", "not_found"].includes(error.code) &&
      failureCombinationIsValid("read", false, error, persistence)
    );
  }
  if (persistence.status === "failed") {
    return failureCombinationIsValid("read", false, error, persistence);
  }
  if (persistence.status !== "read") return false;
  if (error.kind === "operation" || error.kind === "application") return true;
  return (
    error.kind === "domain" &&
    ["destination_exists", "destination_invalid", "payload_integrity_mismatch"].includes(error.code) &&
    !error.retryable &&
    publication.status === "not_published"
  );
}

export function exitCodeForCliApplicationResponse(response: CliApplicationResponse<unknown, "read">): CliExitCode {
  return exitCodeForApplicationResponse(response);
}

export function exitCodeForCliRunOutputExportResponse(response: CliRunOutputExportResponse): CliExitCode {
  return exitCodeForApplicationResponse(response as ProjectedApplicationResponse);
}

function projectApplicationResponse(
  command: CliValidatedSessionCommand,
  mode: OperationMode,
  value: unknown,
): ProjectedApplicationResponse {
  const response = record(value);
  const overallStatus = response.overallStatus;
  if (overallStatus === "success") {
    const persistence = projectPersistenceStatus(response.persistence);
    if (mode === "read" ? persistence.status !== "read" : persistence.status !== "committed") malformed();
    const projectedValue = projectOperationValue(command, response.value);
    if (isCommandFor(command, "delete") && record(projectedValue).cleanupStatus !== "completed") malformed();
    return {
      overallStatus,
      value: projectedValue,
      persistence,
    } as ProjectedApplicationResponse;
  }
  if (overallStatus === "partial_success") {
    const persistence = projectPersistenceStatus(response.persistence);
    const issues = projectIssues(response.issues);
    const projectedValue = projectOperationValue(command, response.value);
    if (issues.length === 0) malformed();
    if (isCommandFor(command, "delete")) {
      const deletion = record(projectedValue);
      if (
        persistence.status !== "committed" ||
        deletion.cleanupStatus !== "pending" ||
        issues.length !== 1 ||
        issues[0]?.kind !== "cleanup" ||
        issues[0].code !== "session_files_cleanup_pending" ||
        issues[0].cleanupToken !== deletion.cleanupToken
      ) {
        malformed();
      }
    } else if (mode === "read") {
      if (persistence.status !== "read" || issues.some((issue) => issue.kind !== "omission")) malformed();
      if (isCommandFor(command, "list") || isCommandFor(command, "repositories")) {
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
    } as ProjectedApplicationResponse;
  }
  if (overallStatus !== "failure") malformed();
  const error = projectApplicationError(response.error);
  const persistence = projectPersistenceStatus(response.persistence);
  if (!failureCombinationIsValid(mode, isCommandFor(command, "delete"), error, persistence)) malformed();
  return { overallStatus, error, persistence } as ProjectedApplicationResponse;
}

function projectOperationValue(command: CliValidatedSessionCommand, value: unknown): unknown {
  if (isCommandFor(command, "create")) return projectCreateValue(value, command.title, command.workspacePath);
  if (isCommandFor(command, "rename")) return projectRenameValue(value, command.sessionId, command.title);
  if (isCommandFor(command, "list")) return projectListValue(value, command);
  if (isCommandFor(command, "repositories")) return projectRepositoriesValue(value, command.limit);
  if (isCommandFor(command, "read")) return projectReadValue(value, command.sessionId);
  if (isCommandFor(command, "directories-chunk")) {
    return projectDirectoriesChunkValue(value, command.sessionId, command.offset, command.maxBytes);
  }
  if (isCommandFor(command, "archive")) return projectTransitionValue(value, command.sessionId, "archived");
  if (isCommandFor(command, "unarchive")) return projectTransitionValue(value, command.sessionId, "active");
  if (isCommandFor(command, "close")) return projectTransitionValue(value, command.sessionId, "closed");
  if (isCommandFor(command, "delete")) {
    return projectDeleteValue(value, command.sessionId, command.idempotencyKey);
  }
  malformed();
}

function projectDeleteValue(value: unknown, expectedSessionId: string, expectedCleanupToken: string): unknown {
  const deletion = record(value);
  const sessionId = boundedString(deletion.sessionId);
  const cleanupToken = boundedString(deletion.cleanupToken);
  const deletedSessionCount = positiveInteger(deletion.deletedSessionCount);
  const cleanupStatus = enumValue(deletion.cleanupStatus, ["completed", "pending"] as const);
  if (
    sessionId !== expectedSessionId ||
    cleanupToken !== expectedCleanupToken ||
    deletedSessionCount > MAX_SESSION_TREE_SIZE ||
    deletion.localOnly !== true
  )
    malformed();
  return { sessionId, cleanupToken, deletedSessionCount, localOnly: true, cleanupStatus };
}

function projectRenameValue(value: unknown, expectedSessionId: string, expectedTitle: string): unknown {
  const item = record(value);
  const sessionId = boundedString(item.sessionId);
  const title = sessionTitle(item.title);
  const updatedAt = nonNegativeInteger(item.updatedAt);
  if (sessionId !== expectedSessionId || title !== expectedTitle) malformed();
  return { sessionId, title, updatedAt };
}

function projectCreateValue(value: unknown, expectedTitle: string, expectedWorkspacePath: string): unknown {
  const item = record(value);
  const sessionId = boundedString(item.sessionId);
  const title = sessionTitle(item.title);
  const workspacePath = normalizedAbsolutePath(item.workspacePath);
  const repositoryMetadata = localRepositoryMetadata(item);
  const createdAt = nonNegativeInteger(item.createdAt);
  if (
    item.lifecycleStatus !== "active" ||
    title !== expectedTitle ||
    !sameHostPathIdentity(workspacePath, expectedWorkspacePath)
  ) {
    malformed();
  }
  return { sessionId, title, workspacePath, ...repositoryMetadata, lifecycleStatus: "active", createdAt };
}

function projectListValue(value: unknown, command: CommandFor<"list">): unknown {
  const page = record(value);
  const items = snapshotDenseArray(page.items, command.limit).map(projectListItem);
  const expectedWorkspacePath = command.workspacePath;
  if (
    (expectedWorkspacePath !== undefined &&
      items.some((item) => !sameHostPathIdentity(item.workspacePath, expectedWorkspacePath))) ||
    (command.lifecycleStatus !== undefined && items.some((item) => item.lifecycleStatus !== command.lifecycleStatus)) ||
    (command.localRepositoryKeys !== undefined &&
      items.some(
        (item) =>
          item.localRepositoryKey === null || !command.localRepositoryKeys!.includes(item.localRepositoryKey as string),
      )) ||
    (command.query !== undefined &&
      items.some(
        (item) =>
          !sessionSearchKey(item.title as string).includes(sessionSearchKey(command.query!)) &&
          (item.repositoryName === null ||
            !sessionSearchKey(item.repositoryName as string).includes(sessionSearchKey(command.query!))),
      ))
  ) {
    malformed();
  }
  const nextCursor = optionalBoundedString(page.nextCursor, CLI_SESSION_LIMITS.maxCursorLength);
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

function projectRepositoriesValue(value: unknown, limit: number): unknown {
  const page = record(value);
  const items = snapshotDenseArray(page.items, limit).map((value) => {
    const item = record(value);
    if (!isLocalRepositoryKey(item.localRepositoryKey)) malformed();
    const repositoryNames = snapshotDenseArray(item.repositoryNames, 100);
    if (
      repositoryNames.length === 0 ||
      repositoryNames.some((name) => !isRepositoryName(name)) ||
      new Set(repositoryNames).size !== repositoryNames.length
    ) {
      malformed();
    }
    const repositoryNameCount = nonNegativeInteger(item.repositoryNameCount);
    const sessionCount = nonNegativeInteger(item.sessionCount);
    const lastActivityAt = nonNegativeInteger(item.lastActivityAt);
    if (repositoryNameCount < repositoryNames.length || repositoryNameCount > sessionCount || sessionCount < 1) {
      malformed();
    }
    return {
      localRepositoryKey: item.localRepositoryKey,
      repositoryNames,
      repositoryNameCount,
      sessionCount,
      lastActivityAt,
    };
  });
  if (new Set(items.map(({ localRepositoryKey }) => localRepositoryKey)).size !== items.length) malformed();
  const nextCursor = optionalBoundedString(page.nextCursor, CLI_SESSION_LIMITS.maxCursorLength);
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

function projectListItem(value: unknown): Readonly<Record<string, string | number | null>> {
  const item = record(value);
  const id = boundedString(item.id);
  const title = sessionTitle(item.title);
  const workspacePath = normalizedAbsolutePath(item.workspacePath);
  const repositoryMetadata = localRepositoryMetadata(item);
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
    title,
    workspacePath,
    ...repositoryMetadata,
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
      title: sessionTitle(session.title),
      providerId: boundedString(session.providerId),
      workspacePath: normalizedAbsolutePath(session.workspacePath),
      ...localRepositoryMetadata(session),
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

function projectApplicationError(
  value: unknown,
  allowedDomainCodes: readonly string[] = BASE_DOMAIN_CODES,
): CliApplicationError {
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
      return projectDomainError(error, message, allowedDomainCodes);
    case "persistence":
      return projectPersistenceError(error, message);
    case "application":
      if (error.code !== "internal_error" || error.retryable) malformed();
      return { kind: "application", code: "internal_error", message, retryable: false };
    default:
      malformed();
  }
}

function projectDomainError(
  error: Readonly<Record<string, unknown>>,
  message: string,
  allowedDomainCodes: readonly string[],
): CliApplicationError {
  if (typeof error.code !== "string" || !allowedDomainCodes.includes(error.code)) malformed();
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
  if (error.code === "payload_unavailable") {
    const details = record(error.details);
    const reason = enumValue(details.reason, [
      "no_payload",
      "pending",
      "size_limit",
      "redaction",
      "persistence_failure",
    ] as const);
    if (reason === "pending") {
      if (!error.retryable) malformed();
      return {
        kind: "domain",
        code: error.code,
        message,
        retryable: true,
        details: { reason: "pending" },
      };
    }
    if (error.retryable) malformed();
    return {
      kind: "domain",
      code: error.code,
      message,
      retryable: false,
      details: { reason },
    };
  }
  if (error.code === "payload_format_unsupported") {
    const details = record(error.details);
    if (error.retryable || details.format !== "binary" || details.supportedAction !== "export") malformed();
    return {
      kind: "domain",
      code: error.code,
      message,
      retryable: false,
      details: { format: "binary", supportedAction: "export" },
    };
  }
  const code = enumValue(error.code, [
    "request_invalid",
    "cursor_invalid",
    "not_found",
    "reference_invalid",
    "lifecycle_conflict",
    "session_busy",
    "insufficient_disk_space",
    "idempotency_conflict",
    "idempotency_in_progress",
    "idempotency_expired",
    "identity_exhausted",
    "destination_exists",
    "destination_invalid",
    "payload_integrity_mismatch",
  ] as const);
  return { kind: "domain", code, message, retryable: error.retryable as boolean };
}

function projectCapacityDetails(
  value: unknown,
): Extract<CliApplicationError, Readonly<{ code: "capacity_exceeded" }>>["details"] {
  const details = record(value);
  const current = nonNegativeInteger(details.current);
  const limit = nonNegativeInteger(details.limit);
  if (details.scope === "root" || details.scope === "session_tree") {
    return { scope: details.scope, rootSessionId: boundedString(details.rootSessionId), current, limit };
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
  return projectIssuesWithLimit(value, CLI_SESSION_LIMITS.listMaxItems);
}

function projectIssuesWithLimit(value: unknown, maxIssues: number): readonly CliApplicationIssue[] {
  return snapshotDenseArray(value, maxIssues).map((candidate) => {
    const issue = record(candidate);
    if (issue.kind === "omission") {
      if (issue.code !== "response_size_limit") malformed();
      const message = boundedString(issue.message, 8_192);
      const ordinal = issue.ordinal === undefined ? undefined : nonNegativeInteger(issue.ordinal);
      return ordinal === undefined
        ? { kind: "omission", code: "response_size_limit", message }
        : { kind: "omission", code: "response_size_limit", message, ordinal };
    }
    if (issue.kind === "cleanup") return projectCleanupIssue(issue);
    if (issue.kind !== "persistence") malformed();
    return projectPersistenceError(issue, boundedString(issue.message, 8_192));
  });
}

function projectCleanupIssue(
  issue: Readonly<Record<string, unknown>>,
): CliSessionCleanupIssue | CliRunOutputExportCleanupIssue {
  if (issue.code === "export_temporary_cleanup_pending") {
    if (issue.retryable !== true) malformed();
    return {
      kind: "cleanup",
      code: issue.code,
      message: boundedString(issue.message, 8_192),
      retryable: true,
    };
  }
  if (
    issue.code !== "session_files_cleanup_pending" ||
    issue.retryable !== true ||
    issue.reconciliation !== "exact_request_required"
  ) {
    malformed();
  }
  return {
    kind: "cleanup",
    code: "session_files_cleanup_pending",
    message: boundedString(issue.message, 8_192),
    cleanupToken: boundedString(issue.cleanupToken),
    retryable: true,
    reconciliation: "exact_request_required",
  };
}

function projectRunOutputPublication(value: unknown): CliRunOutputPublication {
  const publication = record(value);
  if (publication.status === "published") return { status: "published" };
  if (
    publication.status === "not_published" &&
    (publication.temporaryCleanup === "complete" || publication.temporaryCleanup === "pending")
  ) {
    return { status: "not_published", temporaryCleanup: publication.temporaryCleanup };
  }
  if (publication.status === "unknown" && publication.reconciliation === "inspect_destination_before_retry") {
    return { status: "unknown", reconciliation: "inspect_destination_before_retry" };
  }
  malformed();
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
  deletion: boolean,
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
        (deletion && persistence.status === "failed" && persistence.effect === "none") ||
        (mode === "write" && persistence.status === "failed" && persistence.effect === "unknown")
      );
  }
}

function exitCodeForApplicationResponse(response: ProjectedApplicationResponse): CliExitCode {
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
    command,
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

function sessionTitle(value: unknown): string {
  if (!isCanonicalSessionTitle(value)) malformed();
  return value;
}

function localRepositoryMetadata(value: Readonly<Record<string, unknown>>) {
  const metadata = snapshotLocalRepositoryMetadata(value.localRepositoryKey, value.repositoryName);
  if (metadata === undefined) malformed();
  return metadata;
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

function positiveInteger(value: unknown): number {
  const integer = nonNegativeInteger(value);
  if (integer === 0) malformed();
  return integer;
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
  command: CliValidatedSessionCommand,
  operation: TOperation,
): command is CommandFor<TOperation> {
  return command.identity.operation === operation;
}

function malformed(): never {
  throw new TypeError("Malformed Application response.");
}
