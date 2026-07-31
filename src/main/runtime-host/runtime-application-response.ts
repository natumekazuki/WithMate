import {
  APPLICATION_RUN_LIMITS,
  isApplicationRunCancelDomainErrorCode,
  isApplicationRunSendInputDomainErrorCode,
} from "../../shared/application-run-model.js";
import {
  APPLICATION_RUN_OUTPUT_CATEGORIES,
  APPLICATION_RUN_OUTPUT_LIMITS,
} from "../../shared/application-run-output-model.js";
import { APPLICATION_SESSION_MESSAGE_LIMITS } from "../../shared/application-session-message-model.js";
import { APPLICATION_SESSION_RUN_LIMITS } from "../../shared/application-session-run-model.js";
import { isApplicationDomainFailurePersistenceStatus } from "../../shared/application-service-model.js";
import { snapshotMessageContentBlocks } from "../../shared/message-content.js";
import { MAX_SESSION_CONCURRENT_CHILD_RUNS, MAX_SESSION_TREE_SIZE } from "../../shared/session-limits.js";
import {
  isCanonicalSessionTitle,
  isLocalRepositoryKey,
  isRepositoryName,
  snapshotLocalRepositoryMetadata,
} from "../../shared/session-metadata.js";
import {
  normalizeHostAbsolutePath,
  resolveWorkspaceIdentity,
  WORKSPACE_PATH_MAX_LENGTH,
} from "../../shared/workspace-path.js";
import type { RuntimeIpcOperation, RuntimeIpcOperationPayload } from "./runtime-ipc-contract.js";
import { encodeRuntimeWireValue, type RuntimeWireValue } from "./runtime-ipc-value.js";

const WRITE_OPERATIONS = new Set<RuntimeIpcOperation>([
  "session.create",
  "session.update_title",
  "session.archive",
  "session.unarchive",
  "session.close",
  "session.delete",
  "run.start",
  "run.retry",
  "run.send_input",
  "run.cancel",
]);
const IDENTIFIER_MAX_LENGTH = 1_024;
const CURSOR_MAX_LENGTH = 2_048;
const ERROR_MESSAGE_MAX_LENGTH = 8_192;

export function snapshotRuntimeApplicationResponse(
  operation: RuntimeIpcOperation,
  payload: RuntimeIpcOperationPayload,
  value: unknown,
): RuntimeWireValue {
  const response = record(value, ["overallStatus", "value", "issues", "error", "publication", "persistence"]);
  const overallStatus = enumeration(response.overallStatus, ["success", "partial_success", "failure"] as const);
  const exportOperation = operation === "run.output_export";
  if (overallStatus === "failure") {
    requireKeys(response, ["overallStatus", "error", "persistence", ...(exportOperation ? ["publication"] : [])]);
    const error = snapshotError(response.error, operation, payload);
    const publication = exportOperation ? snapshotPublication(response.publication) : undefined;
    const persistence = snapshotPersistence(response.persistence);
    validateFailureCombination(operation, error, persistence, publication);
    const snapshot = {
      overallStatus,
      error,
      ...(publication === undefined ? {} : { publication }),
      persistence,
    };
    return encodeRuntimeWireValue(snapshot);
  }

  requireKeys(response, [
    "overallStatus",
    "value",
    ...(overallStatus === "partial_success" ? ["issues"] : []),
    ...(exportOperation ? ["publication"] : []),
    "persistence",
  ]);
  const persistence = snapshotPersistence(response.persistence);
  const expectedPersistence =
    operation === "session.delete"
      ? "committed"
      : overallStatus === "partial_success" && WRITE_OPERATIONS.has(operation)
        ? "failed"
        : WRITE_OPERATIONS.has(operation)
          ? "committed"
          : "read";
  if (persistence.status !== expectedPersistence) malformed();
  const publication = exportOperation ? snapshotPublication(response.publication) : undefined;
  if (publication !== undefined && publication.status !== "published") malformed();
  const issues = overallStatus === "partial_success" ? snapshotIssues(response.issues) : undefined;
  if (issues !== undefined) validatePartialSuccessCombination(operation, persistence, issues);
  const operationValue = snapshotOperationValue(operation, payload, response.value);
  validateRunAdmissionReplay(operation, operationValue, persistence);
  validateOutcomeCombination(operation, overallStatus, operationValue, issues);
  const snapshot = {
    overallStatus,
    value: operationValue,
    ...(issues === undefined ? {} : { issues }),
    ...(publication === undefined ? {} : { publication }),
    persistence,
  };
  return encodeRuntimeWireValue(snapshot);
}

function snapshotOperationValue(
  operation: RuntimeIpcOperation,
  payload: RuntimeIpcOperationPayload,
  value: unknown,
): unknown {
  switch (operation) {
    case "session.create":
      return snapshotSessionCreate(value, payload);
    case "session.update_title":
      return snapshotSessionUpdateTitle(value, payload);
    case "session.list":
      return snapshotSessionPage(value, payload);
    case "session.list_local_repositories":
      return snapshotLocalRepositoryPage(value, payload);
    case "session.read":
      return snapshotSessionRead(value, payload);
    case "session.read_directories_chunk":
      return snapshotChunk(value, payload, ["sessionId"]);
    case "session.archive":
      return snapshotSessionTransition(value, payload, "archived");
    case "session.unarchive":
      return snapshotSessionTransition(value, payload, "active");
    case "session.close":
      return snapshotSessionTransition(value, payload, "closed");
    case "session.delete":
      return snapshotSessionDelete(value, payload);
    case "session.messages":
      return snapshotMessagePage(value, payload);
    case "session.message_content_chunk":
      return snapshotChunk(value, payload, ["sessionId", "messageId"]);
    case "session.runs":
      return snapshotSessionRunPage(value, payload);
    case "run.start":
    case "run.retry":
      return snapshotRunAdmission(value, payload, operation);
    case "run.send_input":
      return snapshotRunInput(value, payload);
    case "run.cancel":
      return snapshotRunCancel(value, payload);
    case "run.status":
      return snapshotRunStatus(value, payload);
    case "run.events":
      return snapshotRunEventPage(value, payload);
    case "run.follow":
      return snapshotRunFollow(value, payload);
    case "run.output_counts":
      return snapshotOutputCounts(value, payload);
    case "run.outputs":
      return snapshotOutputPage(value, payload);
    case "run.output_preview":
      return snapshotOutputPreview(value, payload);
    case "run.output_chunk":
      return snapshotOutputChunk(value, payload);
    case "run.output_export":
      return snapshotOutputExport(value, payload);
  }
}

function snapshotSessionCreate(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const item = exact(value, [
    "sessionId",
    "title",
    "workspacePath",
    "localRepositoryKey",
    "repositoryName",
    "lifecycleStatus",
    "createdAt",
  ]);
  const itemWorkspace =
    typeof item.workspacePath === "string" ? resolveWorkspaceIdentity(item.workspacePath) : undefined;
  const requestedWorkspace =
    typeof payload.workspacePath === "string" ? resolveWorkspaceIdentity(payload.workspacePath) : undefined;
  if (
    !isBoundedString(item.sessionId) ||
    item.title !== payload.title ||
    !isCanonicalAbsolutePath(item.workspacePath) ||
    itemWorkspace?.workspaceKey !== requestedWorkspace?.workspaceKey ||
    item.lifecycleStatus !== "active" ||
    !validRepositoryMetadata(item.localRepositoryKey, item.repositoryName) ||
    !isNonNegativeInteger(item.createdAt)
  ) {
    malformed();
  }
  return item;
}

function snapshotSessionUpdateTitle(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const item = exact(value, ["sessionId", "title", "updatedAt"]);
  requireScope(item, payload, ["sessionId"]);
  if (item.title !== payload.title || !isNonNegativeInteger(item.updatedAt)) malformed();
  return item;
}

function snapshotSessionPage(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const page = exact(value, ["items"], ["nextCursor"]);
  const items = array(page.items, pageLimit(payload, 25, 100)).map(snapshotSessionListItem);
  validatePageCursor(page, payload);
  return { ...page, items };
}

function snapshotSessionListItem(value: unknown): unknown {
  const item = exact(
    value,
    [
      "id",
      "title",
      "workspacePath",
      "localRepositoryKey",
      "repositoryName",
      "defaultCharacterId",
      "lifecycleStatus",
      "createdAt",
      "updatedAt",
      "lastActivityAt",
      "stateChangedAt",
      "executionState",
    ],
    ["activeRunId", "latestRunId"],
  );
  if (
    !isBoundedString(item.id) ||
    !isCanonicalSessionTitle(item.title) ||
    !isCanonicalAbsolutePath(item.workspacePath) ||
    !validRepositoryMetadata(item.localRepositoryKey, item.repositoryName) ||
    !isBoundedString(item.defaultCharacterId) ||
    !["active", "archived", "closed"].includes(item.lifecycleStatus as string) ||
    !["not_started", "running", "completed", "failed", "canceled", "interrupted"].includes(
      item.executionState as string,
    ) ||
    !validTimestamps(item, ["createdAt", "updatedAt", "lastActivityAt", "stateChangedAt"]) ||
    !optionalBoundedString(item.activeRunId) ||
    !optionalBoundedString(item.latestRunId)
  ) {
    malformed();
  }
  if (item.executionState === "not_started") {
    if (item.activeRunId !== undefined || item.latestRunId !== undefined) malformed();
  } else if (item.executionState === "running") {
    if (
      item.lifecycleStatus !== "active" ||
      typeof item.activeRunId !== "string" ||
      item.latestRunId !== item.activeRunId
    ) {
      malformed();
    }
  } else if (item.activeRunId !== undefined || typeof item.latestRunId !== "string") {
    malformed();
  }
  return item;
}

function snapshotLocalRepositoryPage(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const page = exact(value, ["items"], ["nextCursor"]);
  validatePageCursor(page, payload);
  return {
    ...page,
    items: array(page.items, pageLimit(payload, 25, 100)).map((item) => {
      const repository = exact(item, [
        "localRepositoryKey",
        "repositoryNames",
        "repositoryNameCount",
        "sessionCount",
        "lastActivityAt",
      ]);
      const names = array(repository.repositoryNames);
      if (
        !isLocalRepositoryKey(repository.localRepositoryKey) ||
        names.length === 0 ||
        names.length > 100 ||
        names.some((name) => !isRepositoryName(name)) ||
        new Set(names).size !== names.length ||
        !isNonNegativeInteger(repository.repositoryNameCount) ||
        !isNonNegativeInteger(repository.sessionCount) ||
        !isNonNegativeInteger(repository.lastActivityAt) ||
        (repository.repositoryNameCount as number) < names.length ||
        (repository.repositoryNameCount as number) > (repository.sessionCount as number) ||
        repository.sessionCount === 0
      ) {
        malformed();
      }
      return { ...repository, repositoryNames: names };
    }),
  };
}

function snapshotSessionRead(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const result = exact(value, ["session", "execution"]);
  const session = exact(result.session, [
    "id",
    "title",
    "providerId",
    "workspacePath",
    "localRepositoryKey",
    "repositoryName",
    "allowedAdditionalDirectoriesByteLength",
    "allowedAdditionalDirectoriesState",
    "defaultCharacterId",
    "maxConcurrentChildRuns",
    "lifecycleStatus",
    "createdAt",
    "updatedAt",
    "lastActivityAt",
  ]);
  if (
    session.id !== payload.sessionId ||
    !isCanonicalSessionTitle(session.title) ||
    !isBoundedString(session.providerId) ||
    !isCanonicalAbsolutePath(session.workspacePath) ||
    !["active", "archived", "closed"].includes(session.lifecycleStatus as string) ||
    !validRepositoryMetadata(session.localRepositoryKey, session.repositoryName) ||
    !isNonNegativeInteger(session.allowedAdditionalDirectoriesByteLength) ||
    !["inline", "chunked"].includes(session.allowedAdditionalDirectoriesState as string) ||
    !isBoundedString(session.defaultCharacterId) ||
    !isNonNegativeInteger(session.maxConcurrentChildRuns) ||
    session.maxConcurrentChildRuns > MAX_SESSION_CONCURRENT_CHILD_RUNS ||
    !validTimestamps(session, ["createdAt", "updatedAt", "lastActivityAt"])
  ) {
    malformed();
  }
  const execution = exact(result.execution, ["state"], ["activeRunId", "latestRunId"]);
  if (
    !["not_started", "running", "completed", "failed", "canceled", "interrupted"].includes(execution.state as string) ||
    !optionalBoundedString(execution.activeRunId) ||
    !optionalBoundedString(execution.latestRunId)
  ) {
    malformed();
  }
  if (execution.state === "not_started") {
    if (execution.activeRunId !== undefined || execution.latestRunId !== undefined) malformed();
  } else if (execution.state === "running") {
    if (
      session.lifecycleStatus !== "active" ||
      typeof execution.activeRunId !== "string" ||
      execution.latestRunId !== execution.activeRunId
    ) {
      malformed();
    }
  } else if (execution.activeRunId !== undefined || typeof execution.latestRunId !== "string") {
    malformed();
  }
  return { session, execution };
}

function snapshotChunk(value: unknown, payload: RuntimeIpcOperationPayload, scopeKeys: readonly string[]): unknown {
  const hasNextOffset = scopeKeys.length === 2;
  const chunk = exact(
    value,
    [...scopeKeys, "offset", "totalBytes", ...(hasNextOffset ? ["byteLength"] : []), "eof", "bytes"],
    hasNextOffset ? ["nextOffset"] : [],
  );
  requireScope(chunk, payload, [...scopeKeys, "offset"]);
  if (!(chunk.bytes instanceof ArrayBuffer)) malformed();
  if (
    (hasNextOffset && chunk.byteLength !== chunk.bytes.byteLength) ||
    chunk.bytes.byteLength > (payload.maxBytes as number)
  ) {
    malformed();
  }
  validateChunkPosition(chunk, chunk.bytes.byteLength, hasNextOffset);
  return chunk;
}

function snapshotSessionTransition(
  value: unknown,
  payload: RuntimeIpcOperationPayload,
  lifecycleStatus: "active" | "archived" | "closed",
): unknown {
  const result = exact(value, ["sessionId", "lifecycleStatus", "updatedAt"]);
  requireScope(result, payload, ["sessionId"]);
  if (result.lifecycleStatus !== lifecycleStatus || !isNonNegativeInteger(result.updatedAt)) malformed();
  return result;
}

function snapshotSessionDelete(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const result = exact(value, ["sessionId", "cleanupToken", "deletedSessionCount", "localOnly", "cleanupStatus"]);
  requireScope(result, payload, ["sessionId"]);
  if (
    result.cleanupToken !== payload.idempotencyKey ||
    result.localOnly !== true ||
    !isPositiveInteger(result.deletedSessionCount) ||
    result.deletedSessionCount > MAX_SESSION_TREE_SIZE ||
    !["completed", "pending"].includes(result.cleanupStatus as string)
  ) {
    malformed();
  }
  return result;
}

function snapshotMessagePage(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const page = exact(value, ["sessionId", "items"], ["nextCursor"]);
  requireScope(page, payload, ["sessionId"]);
  validatePageCursor(page, payload);
  let previousOrdinal = 0;
  const items = array(
    page.items,
    pageLimit(
      payload,
      APPLICATION_SESSION_MESSAGE_LIMITS.messagesDefaultItems,
      APPLICATION_SESSION_MESSAGE_LIMITS.messagesMaxItems,
    ),
  ).map((item) => {
    const snapshot = snapshotMessageItem(item) as Readonly<Record<string, unknown>>;
    if ((snapshot.ordinal as number) <= previousOrdinal) malformed();
    previousOrdinal = snapshot.ordinal as number;
    return snapshot;
  });
  return { ...page, items };
}

function snapshotMessageItem(value: unknown): unknown {
  const item = exact(value, ["id", "ordinal", "role", "contentByteLength", "content", "createdAt"]);
  if (
    !isBoundedString(item.id) ||
    !isPositiveInteger(item.ordinal) ||
    (item.role !== "user" && item.role !== "assistant") ||
    !isPositiveInteger(item.contentByteLength) ||
    item.contentByteLength > APPLICATION_SESSION_MESSAGE_LIMITS.maxContentBytes ||
    !isNonNegativeInteger(item.createdAt)
  ) {
    malformed();
  }
  const content = record(item.content, ["state", "blocks"]);
  if (content.state === "inline") {
    requireKeys(content, ["state", "blocks"]);
    const blocks = snapshotMessageContentBlocks(content.blocks);
    if (
      blocks === undefined ||
      item.contentByteLength > APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes ||
      new TextEncoder().encode(JSON.stringify(blocks)).byteLength !== item.contentByteLength
    ) {
      malformed();
    }
    return {
      ...item,
      content: {
        state: "inline",
        blocks,
      },
    };
  }
  if (content.state !== "chunked") malformed();
  requireKeys(content, ["state"]);
  if (item.contentByteLength <= APPLICATION_SESSION_MESSAGE_LIMITS.inlineMaxBytes) malformed();
  return { ...item, content: { state: "chunked" } };
}

function snapshotSessionRunPage(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const page = exact(value, ["sessionId", "items"], ["nextCursor"]);
  requireScope(page, payload, ["sessionId"]);
  validatePageCursor(page, payload);
  let previousOrdinal = 0;
  const items = array(
    page.items,
    pageLimit(payload, APPLICATION_SESSION_RUN_LIMITS.runsDefaultItems, APPLICATION_SESSION_RUN_LIMITS.runsMaxItems),
  ).map((item) => {
    const snapshot = snapshotSessionRunItem(item) as Readonly<Record<string, unknown>>;
    if ((snapshot.ordinal as number) <= previousOrdinal) malformed();
    previousOrdinal = snapshot.ordinal as number;
    return snapshot;
  });
  return { ...page, items };
}

function snapshotSessionRunItem(value: unknown): unknown {
  const baseRequired = ["runId", "ordinal", "initiatingMessageId", "phase", "createdAt", "updatedAt"];
  const baseOptional = [
    "finalAssistantMessageId",
    "retryOfRunId",
    "startedAt",
    "terminalAt",
    "failure",
    "cancellation",
  ];
  const item = exact(value, baseRequired, baseOptional);
  const phase = enumeration(item.phase, [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ] as const);
  const failure = item.failure === undefined ? undefined : snapshotRunFailure(item.failure);
  const cancellation = item.cancellation === undefined ? undefined : snapshotRunCancellation(item.cancellation);
  if (
    !isBoundedString(item.runId) ||
    !isPositiveInteger(item.ordinal) ||
    !isBoundedString(item.initiatingMessageId) ||
    !optionalBoundedString(item.finalAssistantMessageId) ||
    !optionalBoundedString(item.retryOfRunId) ||
    !validTimestamps(item, ["createdAt", "updatedAt"]) ||
    (item.startedAt !== undefined && !isNonNegativeInteger(item.startedAt))
  ) {
    malformed();
  }
  if (["queued", "starting", "active", "finalizing"].includes(phase)) {
    if (
      item.terminalAt !== undefined ||
      failure !== undefined ||
      cancellation !== undefined ||
      item.finalAssistantMessageId !== undefined
    ) {
      malformed();
    }
  } else if (phase === "canceling") {
    if (
      item.terminalAt !== undefined ||
      failure !== undefined ||
      cancellation === undefined ||
      record(cancellation, ["requestedAt", "acknowledgedAt"]).acknowledgedAt !== undefined ||
      item.finalAssistantMessageId !== undefined
    ) {
      malformed();
    }
  } else if (phase === "completed") {
    if (!isNonNegativeInteger(item.terminalAt) || failure !== undefined) {
      malformed();
    }
    validateTerminalCancellation(item.terminalAt, cancellation, false);
  } else if (phase === "failed" || phase === "interrupted") {
    if (!isNonNegativeInteger(item.terminalAt) || failure === undefined || item.finalAssistantMessageId !== undefined) {
      malformed();
    }
    validateTerminalCancellation(item.terminalAt, cancellation, false);
  } else if (
    phase === "canceled" &&
    (!isNonNegativeInteger(item.terminalAt) || failure !== undefined || item.finalAssistantMessageId !== undefined)
  ) {
    malformed();
  } else if (phase === "canceled") {
    validateTerminalCancellation(item.terminalAt, cancellation, true);
  }
  return {
    ...item,
    ...(failure === undefined ? {} : { failure }),
    ...(cancellation === undefined ? {} : { cancellation }),
  };
}

function snapshotRunStatus(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const status = exact(
    value,
    ["sessionId", "runId", "phase", "liveActivity", "createdAt", "updatedAt"],
    ["retryOfRunId", "startedAt", "terminalAt", "failure", "cancellation"],
  );
  requireScope(status, payload, ["sessionId", "runId"]);
  const phase = enumeration(status.phase, [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ] as const);
  const failure = status.failure === undefined ? undefined : snapshotRunFailure(status.failure);
  const cancellation = status.cancellation === undefined ? undefined : snapshotRunCancellation(status.cancellation);
  if (
    !optionalBoundedString(status.retryOfRunId) ||
    !validTimestamps(status, ["createdAt", "updatedAt"]) ||
    (status.startedAt !== undefined && !isNonNegativeInteger(status.startedAt))
  ) {
    malformed();
  }
  if (["queued", "starting", "finalizing"].includes(phase)) {
    if (
      status.liveActivity !== null ||
      status.terminalAt !== undefined ||
      failure !== undefined ||
      cancellation !== undefined
    ) {
      malformed();
    }
  } else if (phase === "active") {
    if (
      status.terminalAt !== undefined ||
      failure !== undefined ||
      cancellation !== undefined ||
      (status.liveActivity !== null &&
        !["running", "waiting_approval", "waiting_input", "waiting_child"].includes(status.liveActivity as string))
    ) {
      malformed();
    }
  } else if (phase === "canceling") {
    if (
      status.liveActivity !== null ||
      status.terminalAt !== undefined ||
      failure !== undefined ||
      cancellation === undefined ||
      record(cancellation, ["requestedAt", "acknowledgedAt"]).acknowledgedAt !== undefined
    ) {
      malformed();
    }
  } else if (phase === "completed") {
    if (status.liveActivity !== null || !isNonNegativeInteger(status.terminalAt) || failure !== undefined) {
      malformed();
    }
    validateTerminalCancellation(status.terminalAt, cancellation, false);
  } else if (phase === "failed" || phase === "interrupted") {
    if (status.liveActivity !== null || !isNonNegativeInteger(status.terminalAt) || failure === undefined) {
      malformed();
    }
    validateTerminalCancellation(status.terminalAt, cancellation, false);
  } else if (
    phase === "canceled" &&
    (status.liveActivity !== null || !isNonNegativeInteger(status.terminalAt) || failure !== undefined)
  ) {
    malformed();
  } else if (phase === "canceled") {
    validateTerminalCancellation(status.terminalAt, cancellation, true);
  }
  return {
    ...status,
    ...(failure === undefined ? {} : { failure }),
    ...(cancellation === undefined ? {} : { cancellation }),
  };
}

function snapshotRunCancel(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const status = snapshotRunStatus(value, payload) as Readonly<Record<string, unknown>>;
  if (
    status.phase !== "canceling" &&
    status.phase !== "completed" &&
    status.phase !== "failed" &&
    status.phase !== "canceled" &&
    status.phase !== "interrupted"
  ) {
    malformed();
  }
  return status;
}

function snapshotRunAdmission(
  value: unknown,
  payload: RuntimeIpcOperationPayload,
  operation: "run.start" | "run.retry",
): unknown {
  const admission =
    operation === "run.retry"
      ? exact(value, ["sessionId", "runId", "retryOfRunId", "phase"])
      : exact(value, ["sessionId", "runId", "phase"]);
  requireScope(admission, payload, ["sessionId"]);
  enumeration(admission.phase, [
    "queued",
    "starting",
    "active",
    "canceling",
    "finalizing",
    "completed",
    "failed",
    "canceled",
    "interrupted",
  ]);
  if (
    !isBoundedString(admission.runId) ||
    (operation === "run.retry" && admission.retryOfRunId !== payload.retryOfRunId)
  ) {
    malformed();
  }
  return admission;
}

function snapshotRunInput(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const input = exact(value, ["sessionId", "runId", "messageId", "deliveryState"], ["resolutionCode"]);
  requireScope(input, payload, ["sessionId", "runId"]);
  if (!isBoundedString(input.messageId)) malformed();
  const deliveryState = enumeration(input.deliveryState, [
    "pending",
    "accepted",
    "rejected",
    "ambiguous",
    "aborted",
  ] as const);
  if (deliveryState === "pending" || deliveryState === "accepted") {
    if (input.resolutionCode !== undefined) malformed();
  } else if (deliveryState === "rejected") {
    enumeration(input.resolutionCode, ["provider_rejected", "delivery_not_sent"] as const);
  } else if (deliveryState === "ambiguous") {
    enumeration(input.resolutionCode, ["transport_unknown", "process_unknown"] as const);
  } else if (input.resolutionCode !== "run_terminal_not_sent") {
    malformed();
  }
  return input;
}

function snapshotRunFailure(value: unknown): unknown {
  const failure = exact(value, ["origin"], ["summary"]);
  if (
    !["provider", "transport", "process", "application", "persistence", "unknown"].includes(failure.origin as string) ||
    (failure.summary !== undefined &&
      !isBoundedString(failure.summary, APPLICATION_SESSION_RUN_LIMITS.maxSummaryLength))
  ) {
    malformed();
  }
  return failure;
}

function snapshotRunCancellation(value: unknown): unknown {
  const cancellation = exact(value, ["requestedAt"], ["acknowledgedAt"]);
  if (
    !isNonNegativeInteger(cancellation.requestedAt) ||
    (cancellation.acknowledgedAt !== undefined &&
      (!isNonNegativeInteger(cancellation.acknowledgedAt) || cancellation.acknowledgedAt < cancellation.requestedAt))
  ) {
    malformed();
  }
  return cancellation;
}

function validateTerminalCancellation(terminalAt: unknown, cancellation: unknown, acknowledged: boolean): void {
  if (cancellation === undefined) return;
  const cancellationRecord = record(cancellation, ["requestedAt", "acknowledgedAt"]);
  if ((cancellationRecord.requestedAt as number) > (terminalAt as number)) malformed();
  if (
    acknowledged
      ? cancellationRecord.acknowledgedAt === undefined ||
        (cancellationRecord.acknowledgedAt as number) > (terminalAt as number)
      : cancellationRecord.acknowledgedAt !== undefined
  ) {
    malformed();
  }
}

function snapshotRunEventPage(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const page = exact(value, ["sessionId", "runId", "items", "nextCursor"]);
  requireScope(page, payload, ["sessionId", "runId"]);
  if (!isBoundedString(page.nextCursor, CURSOR_MAX_LENGTH)) malformed();
  let previousOrdinal = 0;
  return {
    ...page,
    items: array(
      page.items,
      pageLimit(payload, APPLICATION_RUN_LIMITS.eventsDefaultItems, APPLICATION_RUN_LIMITS.eventsMaxItems),
    ).map((item) => {
      const event = exact(item, ["ordinal", "kind", "createdAt"], ["summary"]);
      if (
        !isPositiveInteger(event.ordinal) ||
        event.ordinal <= previousOrdinal ||
        !["run_terminal", "child_result_collected", "unknown"].includes(event.kind as string) ||
        !isNonNegativeInteger(event.createdAt) ||
        (event.summary !== undefined && !isBoundedString(event.summary, APPLICATION_RUN_LIMITS.maxSummaryLength))
      ) {
        malformed();
      }
      previousOrdinal = event.ordinal;
      return event;
    }),
  };
}

function snapshotRunFollow(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const follow = exact(value, ["reason", "status", "events"]);
  const reason = enumeration(follow.reason, ["events", "terminal", "deadline"] as const);
  const status = snapshotRunStatus(follow.status, payload) as Readonly<Record<string, unknown>>;
  const events = snapshotRunEventPage(follow.events, payload) as Readonly<Record<string, unknown>>;
  const eventItems = events.items as readonly Readonly<Record<string, unknown>>[];
  const terminal = ["completed", "failed", "canceled", "interrupted"].includes(status.phase as string);
  const containsTerminalEvent = eventItems.some((event) => event.kind === "run_terminal");
  if (
    (reason === "terminal" && !terminal) ||
    (reason === "deadline" && (terminal || eventItems.length !== 0)) ||
    (reason !== "terminal" && containsTerminalEvent)
  ) {
    malformed();
  }
  return { reason, status, events };
}

function snapshotOutputCounts(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const counts = exact(value, ["sessionId", "runId", "totalCount", "partialCount", "byCategory"]);
  requireScope(counts, payload, ["sessionId", "runId"]);
  const byCategory = exact(counts.byCategory, [...APPLICATION_RUN_OUTPUT_CATEGORIES]);
  if (
    !isNonNegativeInteger(counts.totalCount) ||
    !isNonNegativeInteger(counts.partialCount) ||
    counts.partialCount > counts.totalCount ||
    Object.values(byCategory).some((count) => !isNonNegativeInteger(count)) ||
    Object.values(byCategory).reduce<number>((sum, count) => sum + (count as number), 0) !== counts.totalCount
  ) {
    malformed();
  }
  return { ...counts, byCategory };
}

function snapshotOutputPage(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const page = exact(value, ["sessionId", "runId", "items"], ["nextCursor"]);
  requireScope(page, payload, ["sessionId", "runId"]);
  validatePageCursor(page, payload);
  let previousOrdinal = 0;
  return {
    ...page,
    items: array(
      page.items,
      pageLimit(
        payload,
        APPLICATION_RUN_OUTPUT_LIMITS.outputsDefaultItems,
        APPLICATION_RUN_OUTPUT_LIMITS.outputsMaxItems,
      ),
    ).map((item) => {
      const output = snapshotOutputItem(item) as Readonly<Record<string, unknown>>;
      if (
        !isPositiveInteger(output.ordinal) ||
        output.ordinal <= previousOrdinal ||
        (payload.category !== undefined && output.category !== payload.category)
      ) {
        malformed();
      }
      previousOrdinal = output.ordinal;
      return output;
    }),
  };
}

function snapshotOutputItem(value: unknown): unknown {
  const item = exact(value, [
    "id",
    "ordinal",
    "category",
    "kind",
    "summary",
    "completionState",
    "availability",
    "createdAt",
  ]);
  if (
    !isBoundedString(item.id) ||
    !APPLICATION_RUN_OUTPUT_CATEGORIES.includes(item.category as never) ||
    (item.completionState !== "complete" && item.completionState !== "partial") ||
    !isBoundedString(item.kind, APPLICATION_RUN_OUTPUT_LIMITS.maxKindLength) ||
    !isBoundedUtf8String(item.summary, APPLICATION_RUN_OUTPUT_LIMITS.maxSummaryBytes) ||
    !isNonNegativeInteger(item.createdAt)
  ) {
    malformed();
  }
  return { ...item, availability: snapshotOutputAvailability(item.availability) };
}

function snapshotOutputAvailability(value: unknown): unknown {
  const availability = record(value, ["kind", "reason", "originalByteLength", "redaction"]);
  if (availability.kind === "none") {
    requireKeys(availability, ["kind", "redaction"]);
    if (availability.redaction !== "not_required") malformed();
    return { kind: availability.kind, redaction: availability.redaction };
  }
  if (availability.kind === "pending" || availability.kind === "stored") {
    requireKeys(availability, ["kind", "originalByteLength", "redaction"]);
    if (
      !isNonNegativeInteger(availability.originalByteLength) ||
      !["not_required", "applied"].includes(availability.redaction as string)
    ) {
      malformed();
    }
    return {
      kind: availability.kind,
      originalByteLength: availability.originalByteLength,
      redaction: availability.redaction,
    };
  }
  if (availability.kind !== "omitted") malformed();
  requireKeys(availability, ["kind", "reason", "originalByteLength", "redaction"]);
  if (
    !isNonNegativeInteger(availability.originalByteLength) ||
    !["size_limit", "redaction", "persistence_failure"].includes(availability.reason as string) ||
    (availability.reason === "redaction"
      ? availability.redaction !== "undetermined"
      : availability.redaction !== "not_required" && availability.redaction !== "applied")
  ) {
    malformed();
  }
  return {
    kind: availability.kind,
    reason: availability.reason,
    originalByteLength: availability.originalByteLength,
    redaction: availability.redaction,
  };
}

function snapshotOutputPreview(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const preview = exact(
    value,
    ["sessionId", "runId", "outputItemId", "storedByteLength", "contentSha256", "format"],
    ["mediaType", "preview", "previewByteLength", "truncated"],
  );
  requireScope(preview, payload, ["sessionId", "runId", "outputItemId"]);
  validateStoredOutputMetadata(preview);
  if (preview.format === "binary") {
    if (preview.preview !== undefined || preview.previewByteLength !== undefined || preview.truncated !== undefined) {
      malformed();
    }
  } else if (
    (preview.format !== "text" && preview.format !== "json") ||
    typeof preview.preview !== "string" ||
    !isNonNegativeInteger(preview.previewByteLength) ||
    preview.previewByteLength !== Buffer.byteLength(preview.preview) ||
    preview.previewByteLength > (payload.maxBytes as number) ||
    preview.truncated !== preview.previewByteLength < (preview.storedByteLength as number)
  ) {
    malformed();
  }
  return preview;
}

function snapshotOutputChunk(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const chunk = exact(
    value,
    ["sessionId", "runId", "outputItemId", "format", "offset", "totalBytes", "byteLength", "bytes", "eof"],
    ["nextOffset"],
  );
  requireScope(chunk, payload, ["sessionId", "runId", "outputItemId", "offset"]);
  if (
    !(chunk.bytes instanceof ArrayBuffer) ||
    chunk.byteLength !== chunk.bytes.byteLength ||
    chunk.bytes.byteLength > (payload.maxBytes as number)
  ) {
    malformed();
  }
  if (chunk.format !== "text" && chunk.format !== "json") malformed();
  validateChunkPosition(chunk, chunk.bytes.byteLength, true);
  return chunk;
}

function snapshotOutputExport(value: unknown, payload: RuntimeIpcOperationPayload): unknown {
  const result = exact(value, ["sessionId", "runId", "outputItemId", "format", "storedByteLength", "contentSha256"]);
  requireScope(result, payload, ["sessionId", "runId", "outputItemId"]);
  validateStoredOutputMetadata(result);
  if (!["text", "json", "binary"].includes(result.format as string)) malformed();
  return result;
}

function snapshotPersistence(value: unknown): Readonly<Record<string, unknown>> {
  const persistence = record(value, ["status", "effect", "replayed", "reconciliation"]);
  switch (persistence.status) {
    case "not_attempted":
    case "read":
    case "rejected":
      requireKeys(persistence, ["status", "effect"]);
      if (persistence.effect !== "none") malformed();
      break;
    case "committed":
      requireKeys(persistence, ["status", "effect", "replayed"]);
      if (persistence.effect !== "none" || typeof persistence.replayed !== "boolean") malformed();
      break;
    case "failed":
      requireKeys(
        persistence,
        persistence.effect === "unknown" ? ["status", "effect", "reconciliation"] : ["status", "effect"],
      );
      if (
        (persistence.effect !== "none" && persistence.effect !== "unknown") ||
        (persistence.effect === "unknown" && persistence.reconciliation !== "exact_request_required")
      ) {
        malformed();
      }
      break;
    default:
      malformed();
  }
  return persistence;
}

function validateRunAdmissionReplay(
  operation: RuntimeIpcOperation,
  value: unknown,
  persistence: Readonly<Record<string, unknown>>,
): void {
  if (
    (operation === "run.start" || operation === "run.retry") &&
    persistence.replayed === false &&
    record(value, ["sessionId", "runId", "retryOfRunId", "phase"]).phase !== "queued"
  ) {
    malformed();
  }
}

function snapshotIssues(value: unknown): readonly unknown[] {
  const issues = array(value);
  if (issues.length === 0) malformed();
  return issues.map((issue) => {
    const candidate = record(issue, [
      "kind",
      "code",
      "message",
      "ordinal",
      "cleanupToken",
      "retryable",
      "reconciliation",
      "effect",
    ]);
    if (candidate.kind === "omission") {
      const omission = exact(candidate, ["kind", "code", "message"], ["ordinal"]);
      if (
        omission.code !== "response_size_limit" ||
        !isBoundedString(omission.message, ERROR_MESSAGE_MAX_LENGTH) ||
        (omission.ordinal !== undefined && !isPositiveInteger(omission.ordinal))
      ) {
        malformed();
      }
      return omission;
    }
    if (candidate.kind === "cleanup") {
      const cleanup =
        candidate.code === "session_files_cleanup_pending"
          ? exact(candidate, ["kind", "code", "message", "cleanupToken", "retryable", "reconciliation"])
          : exact(candidate, ["kind", "code", "message", "retryable"]);
      if (
        !isBoundedString(cleanup.message, ERROR_MESSAGE_MAX_LENGTH) ||
        cleanup.retryable !== true ||
        (cleanup.code === "session_files_cleanup_pending"
          ? !isBoundedString(cleanup.cleanupToken) || cleanup.reconciliation !== "exact_request_required"
          : cleanup.code !== "export_temporary_cleanup_pending")
      ) {
        malformed();
      }
      return cleanup;
    }
    if (candidate.kind === "persistence") return snapshotError(candidate);
    malformed();
  });
}

function snapshotError(
  value: unknown,
  operation?: RuntimeIpcOperation,
  payload?: RuntimeIpcOperationPayload,
): Readonly<Record<string, unknown>> {
  const error = record(value, ["kind", "code", "message", "retryable", "effect", "details"]);
  if (!isBoundedString(error.message, ERROR_MESSAGE_MAX_LENGTH) || typeof error.retryable !== "boolean") {
    malformed();
  }
  if (error.kind === "persistence") {
    const persistence = exact(error, ["kind", "code", "message", "retryable", "effect"]);
    if (
      ![
        "persistence_unavailable",
        "persistence_busy",
        "persistence_timeout",
        "persistence_canceled",
        "persistence_configuration_invalid",
        "persistence_integrity_failed",
        "persistence_response_too_large",
        "persistence_operation_failed",
      ].includes(persistence.code as string) ||
      (persistence.effect !== "none" && persistence.effect !== "unknown")
    ) {
      malformed();
    }
    return persistence;
  }
  if (error.kind === "domain" && error.details !== undefined) {
    const domain: Readonly<Record<string, unknown>> = {
      ...exact(error, ["kind", "code", "message", "retryable", "details"]),
      details: snapshotErrorDetails(error.details, operation, payload),
    };
    if (
      (domain.code === "capacity_exceeded" && domain.retryable === true) ||
      (domain.code === "payload_unavailable" &&
        domain.retryable === (record(domain.details, ["reason"]).reason === "pending")) ||
      (domain.code === "payload_format_unsupported" && domain.retryable === false)
    ) {
      return domain;
    }
    malformed();
  }
  const simple = exact(error, ["kind", "code", "message", "retryable"]);
  if (
    (simple.kind === "request" && simple.code === "request_invalid" && simple.retryable === false) ||
    (simple.kind === "access" &&
      ["workspace_invalid", "workspace_unavailable", "authorization_invalid", "forbidden"].includes(
        simple.code as string,
      )) ||
    (simple.kind === "operation" &&
      ((simple.code === "operation_timeout" && simple.retryable === true) ||
        (simple.code === "operation_canceled" && simple.retryable === false))) ||
    (simple.kind === "domain" && isSimpleDomainCode(simple.code)) ||
    (simple.kind === "application" && simple.code === "internal_error" && simple.retryable === false)
  ) {
    return simple;
  }
  malformed();
}

function snapshotErrorDetails(
  value: unknown,
  operation?: RuntimeIpcOperation,
  payload?: RuntimeIpcOperationPayload,
): unknown {
  const details = record(value, [
    "scope",
    "rootSessionId",
    "runId",
    "current",
    "limit",
    "providerId",
    "reason",
    "format",
    "supportedAction",
  ]);
  if (details.reason !== undefined) {
    const reason = exact(details, ["reason"]);
    if (
      !["no_payload", "pending", "size_limit", "redaction", "persistence_failure"].includes(reason.reason as string)
    ) {
      malformed();
    }
    return reason;
  }
  if (details.format !== undefined) {
    const format = exact(details, ["format", "supportedAction"]);
    if (format.format !== "binary" || format.supportedAction !== "export") malformed();
    return format;
  }
  if (details.scope === "root" || details.scope === "session_tree") {
    const capacity = exact(details, ["scope", "rootSessionId", "current", "limit"]);
    validateCapacityDetails(capacity, "rootSessionId");
    validateCapacityOperation(operation, payload, capacity);
    return capacity;
  }
  if (details.scope === "run") {
    const capacity = exact(details, ["scope", "runId", "current", "limit"]);
    validateCapacityDetails(capacity, "runId");
    validateCapacityOperation(operation, payload, capacity);
    return capacity;
  }
  if (details.scope === "provider") {
    const capacity = exact(details, ["scope", "current", "limit"]);
    validateCapacityDetails(capacity);
    validateCapacityOperation(operation, payload, capacity);
    return capacity;
  }
  if (details.scope === "application") {
    const capacity = exact(details, ["scope", "current", "limit"]);
    validateCapacityDetails(capacity);
    validateCapacityOperation(operation, payload, capacity);
    return capacity;
  }
  malformed();
}

function validateCapacityOperation(
  operation: RuntimeIpcOperation | undefined,
  payload: RuntimeIpcOperationPayload | undefined,
  details: Readonly<Record<string, unknown>>,
): void {
  if (operation === undefined) return;
  if (details.scope === "run") {
    if (operation !== "run.send_input" || payload === undefined || details.runId !== payload.runId) {
      malformed();
    }
    return;
  }
  if (operation === "run.start" || operation === "run.retry") {
    if (details.scope !== "application" && details.scope !== "provider") malformed();
    return;
  }
  if (operation === "run.send_input" && details.scope !== "application") malformed();
}

function snapshotPublication(value: unknown): Readonly<Record<string, unknown>> {
  const publication = record(value, ["status", "temporaryCleanup", "reconciliation"]);
  if (publication.status === "published") return exact(publication, ["status"]);
  if (publication.status === "not_published") {
    const notPublished = exact(publication, ["status", "temporaryCleanup"]);
    if (notPublished.temporaryCleanup !== "complete" && notPublished.temporaryCleanup !== "pending") malformed();
    return notPublished;
  }
  if (publication.status === "unknown") {
    const unknown = exact(publication, ["status", "reconciliation"]);
    if (unknown.reconciliation !== "inspect_destination_before_retry") malformed();
    return unknown;
  }
  malformed();
}

function validateOutcomeCombination(
  operation: RuntimeIpcOperation,
  overallStatus: "success" | "partial_success",
  value: unknown,
  issues: readonly unknown[] | undefined,
): void {
  if (
    overallStatus === "partial_success" &&
    (operation === "run.start" ||
      operation === "run.retry" ||
      operation === "run.send_input" ||
      operation === "run.cancel")
  ) {
    malformed();
  }
  if (operation === "session.delete") {
    const deletion = record(value, ["sessionId", "cleanupToken", "deletedSessionCount", "localOnly", "cleanupStatus"]);
    if (
      (overallStatus === "success" && deletion.cleanupStatus !== "completed") ||
      (overallStatus === "partial_success" &&
        (deletion.cleanupStatus !== "pending" ||
          record(issues?.[0], ["kind", "code", "message", "cleanupToken", "retryable", "reconciliation"])
            .cleanupToken !== deletion.cleanupToken))
    ) {
      malformed();
    }
  }
  if (
    overallStatus === "partial_success" &&
    [
      "session.read",
      "session.read_directories_chunk",
      "session.message_content_chunk",
      "run.status",
      "run.output_counts",
      "run.output_preview",
      "run.output_chunk",
    ].includes(operation)
  ) {
    malformed();
  }
}

function validateChunkPosition(
  chunk: Readonly<Record<string, unknown>>,
  byteLength: number,
  hasNextOffset: boolean,
): void {
  if (
    !isNonNegativeInteger(chunk.offset) ||
    !isNonNegativeInteger(chunk.totalBytes) ||
    typeof chunk.eof !== "boolean"
  ) {
    malformed();
  }
  const end = chunk.offset + byteLength;
  if (!Number.isSafeInteger(end)) malformed();
  if (chunk.offset < chunk.totalBytes) {
    if (byteLength === 0 || end > chunk.totalBytes || chunk.eof !== (end === chunk.totalBytes)) {
      malformed();
    }
  } else if (byteLength !== 0 || chunk.eof !== true) {
    malformed();
  }
  if (hasNextOffset) {
    if (chunk.eof) {
      if (chunk.nextOffset !== undefined) malformed();
    } else if (chunk.nextOffset !== end) {
      malformed();
    }
  }
}

function validateCapacityDetails(value: Readonly<Record<string, unknown>>, idKey?: string): void {
  if (
    !isNonNegativeInteger(value.current) ||
    !isNonNegativeInteger(value.limit) ||
    (idKey !== undefined && (typeof value[idKey] !== "string" || value[idKey].length === 0))
  ) {
    malformed();
  }
}

function validateStoredOutputMetadata(value: Readonly<Record<string, unknown>>): void {
  if (
    !isNonNegativeInteger(value.storedByteLength) ||
    typeof value.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.contentSha256) ||
    (value.mediaType !== undefined &&
      !isBoundedString(value.mediaType, APPLICATION_RUN_OUTPUT_LIMITS.maxMediaTypeLength))
  ) {
    malformed();
  }
}

function validRepositoryMetadata(localRepositoryKey: unknown, repositoryName: unknown): boolean {
  return snapshotLocalRepositoryMetadata(localRepositoryKey, repositoryName) !== undefined;
}

function validatePartialSuccessCombination(
  operation: RuntimeIpcOperation,
  persistence: Readonly<Record<string, unknown>>,
  issues: readonly unknown[],
): void {
  const issueRecords = issues.map((issue) =>
    record(issue, ["kind", "code", "message", "ordinal", "cleanupToken", "retryable", "reconciliation", "effect"]),
  );
  if (operation === "session.delete") {
    if (
      issueRecords.length !== 1 ||
      issueRecords[0]?.kind !== "cleanup" ||
      issueRecords[0]?.code !== "session_files_cleanup_pending"
    ) {
      malformed();
    }
    return;
  }
  if (operation === "run.output_export") {
    if (
      issueRecords.length !== 1 ||
      issueRecords[0]?.kind !== "cleanup" ||
      issueRecords[0]?.code !== "export_temporary_cleanup_pending"
    ) {
      malformed();
    }
    return;
  }
  if (!WRITE_OPERATIONS.has(operation)) {
    if (issueRecords.some((issue) => issue.kind !== "omission")) malformed();
    return;
  }
  if (
    persistence.status !== "failed" ||
    issueRecords.some((issue) => issue.kind !== "persistence" || issue.effect !== persistence.effect)
  ) {
    malformed();
  }
}

function validateFailureCombination(
  operation: RuntimeIpcOperation,
  error: Readonly<Record<string, unknown>>,
  persistence: Readonly<Record<string, unknown>>,
  publication: Readonly<Record<string, unknown>> | undefined,
): void {
  if (operation === "run.output_export") {
    if (publication === undefined || publication.status === "published") malformed();
    if (persistence.status === "not_attempted" && error.kind === "domain") malformed();
    if (persistence.status === "read") {
      if (
        error.kind === "operation" ||
        error.kind === "application" ||
        (error.kind === "domain" &&
          ["destination_exists", "destination_invalid", "payload_integrity_mismatch"].includes(error.code as string) &&
          error.retryable === false &&
          publication.status === "not_published")
      ) {
        return;
      }
      malformed();
    }
  } else if (publication !== undefined) {
    malformed();
  }
  if (
    operation === "run.send_input" &&
    error.kind === "domain" &&
    !isApplicationRunSendInputDomainErrorCode(error.code)
  ) {
    malformed();
  }
  if (operation === "run.cancel" && error.kind === "domain" && !isApplicationRunCancelDomainErrorCode(error.code)) {
    malformed();
  }

  switch (persistence.status) {
    case "not_attempted":
      if (
        (!["request", "access", "operation", "application"].includes(error.kind as string) &&
          !(error.kind === "domain" && isApplicationDomainFailurePersistenceStatus(persistence.status))) ||
        (publication !== undefined &&
          (publication.status !== "not_published" || publication.temporaryCleanup !== "complete"))
      ) {
        malformed();
      }
      return;
    case "rejected":
      if (error.kind !== "domain" || !isApplicationDomainFailurePersistenceStatus(persistence.status)) malformed();
      if (publication !== undefined) {
        if (error.code === "payload_unavailable") {
          if (publication.status !== "not_published" || publication.temporaryCleanup !== "complete") malformed();
        } else if (!["request_invalid", "cursor_invalid", "not_found"].includes(error.code as string)) {
          malformed();
        }
      }
      return;
    case "failed":
      if (
        (error.kind !== "persistence" && error.kind !== "application") ||
        (error.kind === "persistence" && error.effect !== persistence.effect) ||
        (!WRITE_OPERATIONS.has(operation) && persistence.effect !== "none") ||
        (error.kind === "application" && persistence.effect !== (WRITE_OPERATIONS.has(operation) ? "unknown" : "none"))
      ) {
        malformed();
      }
      return;
    default:
      malformed();
  }
}

function isSimpleDomainCode(value: unknown): boolean {
  return (
    typeof value === "string" &&
    [
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
    ].includes(value)
  );
}

function exact(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const candidate = record(value, [...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !Object.hasOwn(candidate, key))) malformed();
  return candidate;
}

function record(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) malformed();
  const keys = Object.keys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length > allowedKeys.length ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    Reflect.ownKeys(value).length !== keys.length
  ) {
    malformed();
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) malformed();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requireKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) malformed();
}

function array(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): readonly unknown[] {
  if (!Array.isArray(value)) malformed();
  const length = value.length;
  if (length > maxLength) malformed();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key, index) => key !== (index === length ? "length" : String(index)))) {
    malformed();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length }, (_unused, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) malformed();
    return descriptor.value;
  });
}

function requireScope(
  value: Readonly<Record<string, unknown>>,
  payload: RuntimeIpcOperationPayload,
  keys: readonly string[],
): void {
  if (keys.some((key) => value[key] !== payload[key])) malformed();
}

function validatePageCursor(value: Readonly<Record<string, unknown>>, payload: RuntimeIpcOperationPayload): void {
  if (!optionalBoundedString(value.nextCursor, CURSOR_MAX_LENGTH)) malformed();
  if (value.nextCursor !== undefined && value.nextCursor === payload.cursor) malformed();
}

function pageLimit(payload: RuntimeIpcOperationPayload, defaultValue: number, maxValue: number): number {
  const value = payload.limit ?? defaultValue;
  if (!isPositiveInteger(value) || value > maxValue) malformed();
  return value;
}

function enumeration<TValue extends string>(value: unknown, allowed: readonly TValue[]): TValue {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) malformed();
  return value as TValue;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isBoundedString(value: unknown, maxLength = IDENTIFIER_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function isBoundedUtf8String(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= maxBytes && !value.includes("\0");
}

function optionalBoundedString(value: unknown, maxLength = IDENTIFIER_MAX_LENGTH): boolean {
  return value === undefined || isBoundedString(value, maxLength);
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > WORKSPACE_PATH_MAX_LENGTH) return false;
  const normalized = normalizeHostAbsolutePath(value);
  return normalized !== undefined && normalized.path === value;
}

function validTimestamps(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => isNonNegativeInteger(value[key]));
}

function malformed(): never {
  throw new TypeError("Runtime Application response is invalid.");
}
