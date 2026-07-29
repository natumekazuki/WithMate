import type { RuntimeApplication, RuntimeApplicationControl } from "../runtime-application.js";
import type {
  ApplicationFailureEffect,
  ApplicationOperationResponse,
  ApplicationPersistenceErrorCode,
} from "../../shared/application-service-model.js";
import type { ApplicationRunOutputExportResponse } from "../../shared/application-run-output-model.js";
import type { RuntimeIpcOperation, RuntimeIpcOperationPayload } from "./runtime-ipc-contract.js";
import {
  RuntimeIpcClient,
  RuntimeIpcClientError,
  RuntimeIpcRemoteError,
  type RuntimeIpcClientControl,
} from "./runtime-ipc-client.js";

const LOCAL_RUNTIME_AUTHORIZATION = Object.freeze({
  transport: "local_cli",
  principal: "current_os_user",
} as const);

const DURABLE_WRITE_OPERATIONS = new Set<RuntimeIpcOperation>([
  "session.create",
  "session.update_title",
  "session.archive",
  "session.unarchive",
  "session.close",
  "session.delete",
  "run.start",
  "run.retry",
]);

type RuntimeTransportFailure = Readonly<{
  code: ApplicationPersistenceErrorCode;
  execution: "not_started" | "started" | "unknown";
  retryable: boolean;
}>;

export function createRuntimeApplicationClient(client: RuntimeIpcClient): RuntimeApplication {
  const invoke = async <TValue>(
    operation: RuntimeIpcOperation,
    payload: RuntimeIpcOperationPayload,
    control: RuntimeIpcClientControl | undefined,
  ): Promise<TValue> => {
    try {
      return (await client.request(operation, payload, control)) as TValue;
    } catch (error) {
      const failure = runtimeTransportFailure(error);
      if (failure === undefined) throw error;
      return projectRuntimeTransportFailure(operation, failure) as TValue;
    }
  };

  const operations: RuntimeApplication["operations"] = {
    create: (request, control) =>
      invoke(
        "session.create",
        {
          title: request.title,
          workspacePath: request.workspacePath,
          idempotencyKey: request.idempotencyKey,
          providerId: request.providerId,
          allowedAdditionalDirectories: request.allowedAdditionalDirectories,
          defaultCharacterId: request.defaultCharacterId,
          maxConcurrentChildRuns: request.maxConcurrentChildRuns,
        },
        control,
      ),
    updateTitle: (request, control) =>
      invoke(
        "session.update_title",
        {
          sessionId: request.sessionId,
          idempotencyKey: request.idempotencyKey,
          title: request.title,
        },
        control,
      ),
    list: (request, control) =>
      invoke(
        "session.list",
        {
          ...(request.workspacePath === undefined ? {} : { workspacePath: request.workspacePath }),
          ...(request.lifecycleStatus === undefined ? {} : { lifecycleStatus: request.lifecycleStatus }),
          ...(request.localRepositoryKeys === undefined ? {} : { localRepositoryKeys: request.localRepositoryKeys }),
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        control,
      ),
    listLocalRepositories: (request, control) =>
      invoke(
        "session.list_local_repositories",
        {
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        control,
      ),
    read: (request, control) => invoke("session.read", { sessionId: request.sessionId }, control),
    readDirectoriesChunk: (request, control) =>
      invoke(
        "session.read_directories_chunk",
        { sessionId: request.sessionId, offset: request.offset, maxBytes: request.maxBytes },
        control,
      ),
    archive: (request, control) =>
      invoke("session.archive", { sessionId: request.sessionId, idempotencyKey: request.idempotencyKey }, control),
    unarchive: (request, control) =>
      invoke("session.unarchive", { sessionId: request.sessionId, idempotencyKey: request.idempotencyKey }, control),
    close: (request, control) =>
      invoke(
        "session.close",
        {
          sessionId: request.sessionId,
          idempotencyKey: request.idempotencyKey,
          expectedLifecycleStatus: request.expectedLifecycleStatus,
        },
        control,
      ),
    delete: (request, control) =>
      invoke("session.delete", { sessionId: request.sessionId, idempotencyKey: request.idempotencyKey }, control),
  };

  const messageOperations: RuntimeApplication["messageOperations"] = {
    messages: (request, control) =>
      invoke(
        "session.messages",
        {
          sessionId: request.sessionId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        control,
      ),
    messageContentChunk: (request, control) =>
      invoke(
        "session.message_content_chunk",
        {
          sessionId: request.sessionId,
          messageId: request.messageId,
          offset: request.offset,
          maxBytes: request.maxBytes,
        },
        control,
      ),
  };

  const sessionRunOperations: RuntimeApplication["sessionRunOperations"] = {
    runs: (request, control) =>
      invoke(
        "session.runs",
        {
          sessionId: request.sessionId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        control,
      ),
  };

  const runOperations: RuntimeApplication["runOperations"] = {
    start: (request, control) =>
      invoke(
        "run.start",
        {
          sessionId: request.sessionId,
          idempotencyKey: request.idempotencyKey,
          contentBlocks: request.contentBlocks,
          execution: request.execution,
        },
        control,
      ),
    retry: (request, control) =>
      invoke(
        "run.retry",
        {
          sessionId: request.sessionId,
          retryOfRunId: request.retryOfRunId,
          idempotencyKey: request.idempotencyKey,
          ...(request.executionOverrides === undefined ? {} : { executionOverrides: request.executionOverrides }),
        },
        control,
      ),
    status: (request, control) => invoke("run.status", { sessionId: request.sessionId, runId: request.runId }, control),
    events: (request, control) =>
      invoke(
        "run.events",
        {
          sessionId: request.sessionId,
          runId: request.runId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        control,
      ),
    follow: (request, control) =>
      invoke(
        "run.follow",
        {
          sessionId: request.sessionId,
          runId: request.runId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.waitMs === undefined ? {} : { waitMs: request.waitMs }),
          ...(request.pollMs === undefined ? {} : { pollMs: request.pollMs }),
        },
        control,
      ),
  };

  const runOutputOperations: RuntimeApplication["runOutputOperations"] = {
    outputCounts: (request, control) =>
      invoke("run.output_counts", { sessionId: request.sessionId, runId: request.runId }, control),
    outputs: (request, control) =>
      invoke(
        "run.outputs",
        {
          sessionId: request.sessionId,
          runId: request.runId,
          ...(request.category === undefined ? {} : { category: request.category }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        control,
      ),
    outputPreview: (request, control) =>
      invoke(
        "run.output_preview",
        {
          sessionId: request.sessionId,
          runId: request.runId,
          outputItemId: request.outputItemId,
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        },
        control,
      ),
    outputChunk: (request, control) =>
      invoke(
        "run.output_chunk",
        {
          sessionId: request.sessionId,
          runId: request.runId,
          outputItemId: request.outputItemId,
          offset: request.offset,
          ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
        },
        control,
      ),
    outputExport: (request, control) =>
      invoke(
        "run.output_export",
        {
          sessionId: request.sessionId,
          runId: request.runId,
          outputItemId: request.outputItemId,
          destination: request.destinationGrant.absolutePath,
        },
        control,
      ),
  };

  let shutdownPromise: Promise<Readonly<{ checkpoint: "completed" }>> | undefined;
  return {
    operations,
    messageOperations,
    sessionRunOperations,
    runOperations,
    runOutputOperations,
    authorization: LOCAL_RUNTIME_AUTHORIZATION,
    shutdown(_control: RuntimeApplicationControl = {}) {
      shutdownPromise ??= client.close().then(() => ({ checkpoint: "completed" as const }));
      return shutdownPromise;
    },
  };
}

function runtimeTransportFailure(error: unknown): RuntimeTransportFailure | undefined {
  if (error instanceof RuntimeIpcClientError) {
    return {
      code: mapRuntimeClientErrorCode(error.code),
      execution: error.execution,
      retryable: error.retryable,
    };
  }
  if (error instanceof RuntimeIpcRemoteError) {
    return {
      code: mapRuntimeRemoteErrorCode(error.failure.code),
      execution: error.failure.execution,
      retryable: error.failure.retryable,
    };
  }
  return undefined;
}

function projectRuntimeTransportFailure(
  operation: RuntimeIpcOperation,
  failure: RuntimeTransportFailure,
): ApplicationOperationResponse<never> | ApplicationRunOutputExportResponse {
  const effect: ApplicationFailureEffect =
    DURABLE_WRITE_OPERATIONS.has(operation) && failure.execution !== "not_started" ? "unknown" : "none";
  const error = {
    kind: "persistence" as const,
    code: failure.code,
    message: runtimeTransportFailureMessage(failure.code),
    retryable: failure.retryable,
    effect,
  };
  const persistence =
    effect === "unknown"
      ? ({ status: "failed", effect: "unknown", reconciliation: "exact_request_required" } as const)
      : ({ status: "failed", effect: "none" } as const);
  if (operation === "run.output_export") {
    return {
      overallStatus: "failure",
      error: { ...error, effect: "none" },
      publication:
        failure.execution === "not_started"
          ? { status: "not_published", temporaryCleanup: "complete" }
          : { status: "unknown", reconciliation: "inspect_destination_before_retry" },
      persistence: { status: "failed", effect: "none" },
    };
  }
  return {
    overallStatus: "failure",
    error,
    persistence,
  } as ApplicationOperationResponse<never>;
}

function mapRuntimeClientErrorCode(code: RuntimeIpcClientError["code"]): ApplicationPersistenceErrorCode {
  switch (code) {
    case "connection_closed":
    case "handshake_rejected":
      return "persistence_unavailable";
    case "request_timeout":
      return "persistence_timeout";
    case "request_canceled":
      return "persistence_canceled";
    case "resource_exhausted":
      return "persistence_busy";
    case "protocol_failure":
      return "persistence_operation_failed";
  }
}

function mapRuntimeRemoteErrorCode(code: RuntimeIpcRemoteError["failure"]["code"]): ApplicationPersistenceErrorCode {
  switch (code) {
    case "runtime_unavailable":
      return "persistence_unavailable";
    case "resource_exhausted":
      return "persistence_busy";
    case "operation_failed":
    case "protocol_failure":
    case "request_rejected":
      return "persistence_operation_failed";
  }
}

function runtimeTransportFailureMessage(code: ApplicationPersistenceErrorCode): string {
  switch (code) {
    case "persistence_unavailable":
      return "Runtime host became unavailable.";
    case "persistence_busy":
      return "Runtime host resource limit was reached.";
    case "persistence_timeout":
      return "Runtime operation timed out.";
    case "persistence_canceled":
      return "Runtime operation was canceled.";
    case "persistence_operation_failed":
      return "Runtime operation failed.";
    case "persistence_configuration_invalid":
    case "persistence_integrity_failed":
    case "persistence_response_too_large":
      return "Runtime operation failed.";
  }
}
