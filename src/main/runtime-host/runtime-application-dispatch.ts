import type { RuntimeApplication } from "../runtime-application.js";
import type {
  ApplicationRunExecutionOverrides,
  ApplicationRunExecutionSettings,
  ApplicationRunSandboxSetting,
} from "../../shared/application-run-model.js";
import type { TextContentBlock } from "../../shared/message-content.js";
import type { RuntimeIpcOperation, RuntimeIpcOperationPayload } from "./runtime-ipc-contract.js";

export async function dispatchRuntimeApplicationOperation(
  application: RuntimeApplication,
  operation: RuntimeIpcOperation,
  payload: RuntimeIpcOperationPayload,
  signal: AbortSignal,
): Promise<unknown> {
  const context = { authorization: application.authorization };
  const options = { signal };
  switch (operation) {
    case "session.create":
      return await application.operations.create(
        {
          context,
          title: stringField(payload, "title"),
          workspacePath: stringField(payload, "workspacePath"),
          idempotencyKey: stringField(payload, "idempotencyKey"),
          providerId: stringField(payload, "providerId"),
          allowedAdditionalDirectories: stringArrayField(payload, "allowedAdditionalDirectories"),
          defaultCharacterId: stringField(payload, "defaultCharacterId"),
          maxConcurrentChildRuns: numberField(payload, "maxConcurrentChildRuns"),
        },
        options,
      );
    case "session.update_title":
      return await application.operations.updateTitle(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          idempotencyKey: stringField(payload, "idempotencyKey"),
          title: stringField(payload, "title"),
        },
        options,
      );
    case "session.list":
      return await application.operations.list(
        {
          context,
          ...optionalString(payload, "workspacePath"),
          ...optionalString(payload, "lifecycleStatus"),
          ...optionalStringArray(payload, "localRepositoryKeys"),
          ...optionalString(payload, "query"),
          ...optionalString(payload, "cursor"),
          ...optionalNumber(payload, "limit"),
        },
        options,
      );
    case "session.list_local_repositories":
      return await application.operations.listLocalRepositories(
        { context, ...optionalString(payload, "cursor"), ...optionalNumber(payload, "limit") },
        options,
      );
    case "session.read":
      return await application.operations.read({ context, sessionId: stringField(payload, "sessionId") }, options);
    case "session.read_directories_chunk":
      return await application.operations.readDirectoriesChunk(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          offset: numberField(payload, "offset"),
          maxBytes: numberField(payload, "maxBytes"),
        },
        options,
      );
    case "session.archive":
    case "session.unarchive":
    case "session.delete": {
      const request = {
        context,
        sessionId: stringField(payload, "sessionId"),
        idempotencyKey: stringField(payload, "idempotencyKey"),
      };
      if (operation === "session.archive") return await application.operations.archive(request, options);
      if (operation === "session.unarchive") return await application.operations.unarchive(request, options);
      return await application.operations.delete(request, options);
    }
    case "session.close":
      return await application.operations.close(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          idempotencyKey: stringField(payload, "idempotencyKey"),
          expectedLifecycleStatus: enumerationField(payload, "expectedLifecycleStatus", [
            "active",
            "archived",
          ] as const),
        },
        options,
      );
    case "session.messages":
      return await application.messageOperations.messages(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          ...optionalString(payload, "cursor"),
          ...optionalNumber(payload, "limit"),
        },
        options,
      );
    case "session.message_content_chunk":
      return await application.messageOperations.messageContentChunk(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          messageId: stringField(payload, "messageId"),
          offset: numberField(payload, "offset"),
          maxBytes: numberField(payload, "maxBytes"),
        },
        options,
      );
    case "session.runs":
      return await application.sessionRunOperations.runs(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          ...optionalString(payload, "cursor"),
          ...optionalNumber(payload, "limit"),
        },
        options,
      );
    case "run.start":
      return await application.runOperations.start(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          idempotencyKey: stringField(payload, "idempotencyKey"),
          contentBlocks: textContentBlocksField(payload, "contentBlocks"),
          execution: executionSettingsField(payload, "execution"),
        },
        options,
      );
    case "run.retry":
      return await application.runOperations.retry(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          retryOfRunId: stringField(payload, "retryOfRunId"),
          idempotencyKey: stringField(payload, "idempotencyKey"),
          ...(Object.hasOwn(payload, "executionOverrides")
            ? { executionOverrides: executionOverridesField(payload, "executionOverrides") }
            : {}),
        },
        options,
      );
    case "run.status":
    case "run.output_counts": {
      const request = {
        context,
        sessionId: stringField(payload, "sessionId"),
        runId: stringField(payload, "runId"),
      };
      return operation === "run.status"
        ? await application.runOperations.status(request, options)
        : await application.runOutputOperations.outputCounts(request, options);
    }
    case "run.events":
      return await application.runOperations.events(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          runId: stringField(payload, "runId"),
          ...optionalString(payload, "cursor"),
          ...optionalNumber(payload, "limit"),
        },
        options,
      );
    case "run.follow":
      return await application.runOperations.follow(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          runId: stringField(payload, "runId"),
          ...optionalString(payload, "cursor"),
          ...optionalNumber(payload, "limit"),
          ...optionalNumber(payload, "waitMs"),
          ...optionalNumber(payload, "pollMs"),
        },
        options,
      );
    case "run.outputs":
      return await application.runOutputOperations.outputs(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          runId: stringField(payload, "runId"),
          ...optionalString(payload, "category"),
          ...optionalString(payload, "cursor"),
          ...optionalNumber(payload, "limit"),
        },
        options,
      );
    case "run.output_preview":
      return await application.runOutputOperations.outputPreview(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          runId: stringField(payload, "runId"),
          outputItemId: stringField(payload, "outputItemId"),
          ...optionalNumber(payload, "maxBytes"),
        },
        options,
      );
    case "run.output_chunk":
      return await application.runOutputOperations.outputChunk(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          runId: stringField(payload, "runId"),
          outputItemId: stringField(payload, "outputItemId"),
          offset: numberField(payload, "offset"),
          ...optionalNumber(payload, "maxBytes"),
        },
        options,
      );
    case "run.output_export":
      return await application.runOutputOperations.outputExport(
        {
          context,
          sessionId: stringField(payload, "sessionId"),
          runId: stringField(payload, "runId"),
          outputItemId: stringField(payload, "outputItemId"),
          destinationGrant: {
            kind: "explicit_absolute_path",
            authority: "cli_user_selection",
            absolutePath: stringField(payload, "destination"),
          },
        },
        options,
      );
  }
}

function stringField(payload: RuntimeIpcOperationPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new TypeError(`Runtime payload field ${key} is invalid.`);
  return value;
}

function numberField(payload: RuntimeIpcOperationPayload, key: string): number {
  const value = payload[key];
  if (typeof value !== "number") throw new TypeError(`Runtime payload field ${key} is invalid.`);
  return value;
}

function stringArrayField(payload: RuntimeIpcOperationPayload, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Runtime payload field ${key} is invalid.`);
  }
  return value;
}

function textContentBlocksField(payload: RuntimeIpcOperationPayload, key: string): readonly TextContentBlock[] {
  const value = payload[key];
  if (
    !Array.isArray(value) ||
    value.some(
      (block) =>
        typeof block !== "object" ||
        block === null ||
        Array.isArray(block) ||
        (block as Readonly<Record<string, unknown>>).type !== "text" ||
        typeof (block as Readonly<Record<string, unknown>>).text !== "string",
    )
  ) {
    throw new TypeError(`Runtime payload field ${key} is invalid.`);
  }
  return value as readonly TextContentBlock[];
}

function executionSettingsField(payload: RuntimeIpcOperationPayload, key: string): ApplicationRunExecutionSettings {
  const value = recordField(payload, key);
  return {
    model: stringField(value, "model"),
    reasoningEffort: stringField(value, "reasoningEffort"),
    sandbox: sandboxField(value, "sandbox"),
  };
}

function executionOverridesField(payload: RuntimeIpcOperationPayload, key: string): ApplicationRunExecutionOverrides {
  const value = recordField(payload, key);
  return {
    ...optionalString(value, "model"),
    ...optionalString(value, "reasoningEffort"),
    ...(Object.hasOwn(value, "sandbox") ? { sandbox: sandboxField(value, "sandbox") } : {}),
  };
}

function sandboxField(payload: RuntimeIpcOperationPayload, key: string): ApplicationRunSandboxSetting {
  const value = recordField(payload, key);
  const mode = stringField(value, "mode");
  if (mode === "danger-full-access") return { mode };
  if (mode === "read-only" || mode === "workspace-write") {
    const networkAccess = value.networkAccess;
    if (typeof networkAccess !== "boolean") throw new TypeError(`Runtime payload field ${key} is invalid.`);
    return { mode, networkAccess };
  }
  throw new TypeError(`Runtime payload field ${key} is invalid.`);
}

function recordField(payload: RuntimeIpcOperationPayload, key: string): RuntimeIpcOperationPayload {
  const value = payload[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Runtime payload field ${key} is invalid.`);
  }
  return value as RuntimeIpcOperationPayload;
}

function optionalString(payload: RuntimeIpcOperationPayload, key: string): Record<string, string> {
  return Object.hasOwn(payload, key) ? { [key]: stringField(payload, key) } : {};
}

function optionalNumber(payload: RuntimeIpcOperationPayload, key: string): Record<string, number> {
  return Object.hasOwn(payload, key) ? { [key]: numberField(payload, key) } : {};
}

function optionalStringArray(payload: RuntimeIpcOperationPayload, key: string): Record<string, readonly string[]> {
  return Object.hasOwn(payload, key) ? { [key]: stringArrayField(payload, key) } : {};
}

function enumerationField<TValue extends string>(
  payload: RuntimeIpcOperationPayload,
  key: string,
  allowed: readonly TValue[],
): TValue {
  const value = stringField(payload, key);
  if (!allowed.includes(value as TValue)) throw new TypeError(`Runtime payload field ${key} is invalid.`);
  return value as TValue;
}
