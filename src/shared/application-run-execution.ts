import { APPLICATION_RUN_LIMITS } from "./application-run-model.js";
import { snapshotMessageContentBlocks, type TextContentBlock } from "./message-content.js";
import type { RepositoryJsonValue, RunExecutionSnapshot } from "./repository-write-model.js";

export type ApplicationRunProviderRequest = Readonly<{ [key: string]: RepositoryJsonValue }> &
  Readonly<{
    contentBlocks: readonly TextContentBlock[];
    model: string;
    reasoningEffort: string;
    approvalPolicy: "never";
    sandboxPolicy:
      | Readonly<{ mode: "read-only"; networkAccess: boolean }>
      | Readonly<{ mode: "danger-full-access" }>
      | Readonly<{
          mode: "workspace-write";
          networkAccess: boolean;
          writableRoots: readonly string[];
        }>;
    workspacePath: string;
  }>;

export function buildApplicationRunProviderRequest(
  contentBlocks: readonly TextContentBlock[],
  executionSnapshot: RunExecutionSnapshot,
): ApplicationRunProviderRequest {
  const content = snapshotMessageContentBlocks(contentBlocks);
  if (content === undefined) throw new TypeError("Message content is invalid.");
  const reasoning = exactRecord(executionSnapshot.reasoning, ["effort"]);
  const approval = exactRecord(executionSnapshot.approval, ["policy"]);
  const workspace = exactRecord(executionSnapshot.workspace, ["key", "path", "allowedAdditionalDirectories"]);
  const sandbox = exactRecord(
    executionSnapshot.sandbox,
    executionSnapshot.sandbox !== null &&
      typeof executionSnapshot.sandbox === "object" &&
      !Array.isArray(executionSnapshot.sandbox) &&
      (executionSnapshot.sandbox as Readonly<Record<string, unknown>>).mode === "danger-full-access"
      ? ["mode"]
      : ["mode", "networkAccess"],
  );
  const model = executionSetting(executionSnapshot.model);
  const reasoningEffort = executionSetting(reasoning.effort);
  const workspacePath = boundedString(workspace.path, 32_768);
  const allowedAdditionalDirectories = stringArray(workspace.allowedAdditionalDirectories, 128, 32_768);
  if (approval.policy !== "never") throw new TypeError("Execution approval policy is invalid.");

  let sandboxPolicy: ApplicationRunProviderRequest["sandboxPolicy"];
  if (sandbox.mode === "danger-full-access") {
    sandboxPolicy = Object.freeze({ mode: "danger-full-access" });
  } else if (
    (sandbox.mode === "read-only" || sandbox.mode === "workspace-write") &&
    typeof sandbox.networkAccess === "boolean"
  ) {
    sandboxPolicy =
      sandbox.mode === "workspace-write"
        ? Object.freeze({
            mode: sandbox.mode,
            networkAccess: sandbox.networkAccess,
            writableRoots: Object.freeze([workspacePath, ...allowedAdditionalDirectories]),
          })
        : Object.freeze({ mode: sandbox.mode, networkAccess: sandbox.networkAccess });
  } else {
    throw new TypeError("Execution sandbox policy is invalid.");
  }

  return Object.freeze({
    contentBlocks: content,
    model,
    reasoningEffort,
    approvalPolicy: "never",
    sandboxPolicy,
    workspacePath,
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Execution record is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    throw new TypeError("Execution record keys are invalid.");
  }
  return record;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError("Execution string is invalid.");
  }
  return value;
}

function executionSetting(value: unknown): string {
  return boundedString(value, APPLICATION_RUN_LIMITS.maxExecutionSettingLength);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError("Execution string array is invalid.");
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError("Execution string array is invalid.");
    result.push(boundedString(value[index], maxLength));
  }
  return Object.freeze(result);
}
