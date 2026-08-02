import { APPLICATION_RUN_LIMITS, type ApplicationRunInteraction } from "../../../shared/application-run-model.js";
import type { ProviderSettingsJsonValue } from "../../../shared/provider-settings.js";
import type {
  CompiledCodexProviderExecution,
  ProviderDefinition,
  ProviderExecutionScope,
  ProviderModelSelection,
  ProviderInteractionUiDefinition,
  ProviderSettingsUiDefinition,
} from "../provider-definition.js";
import { snapshotProviderRecord } from "../provider-record.js";
import { CODEX_ADAPTER_PERMISSION_CATEGORIES } from "./codex-adapter-contract.js";
import {
  canonicalizeCodexInteractionResponse,
  canonicalizeCodexInteractionResponseShape,
} from "./codex-interaction-definition.js";
import { CODEX_PROVIDER_DEFINITION_VERSION, CODEX_PROVIDER_ID } from "./codex-provider-contract.js";
import {
  canonicalizeCodexInteractionRequest,
  canonicalizeCodexInteractionSnapshot as canonicalizeCodexInteractionSnapshotShape,
} from "./codex-interaction-codec.js";

export { CODEX_PROVIDER_DEFINITION_VERSION, CODEX_PROVIDER_ID } from "./codex-provider-contract.js";

export type CodexProviderApprovalPolicy = "never" | "untrusted" | "on-request";

export type CodexProviderSandboxSetting =
  | Readonly<{ mode: "read-only"; networkAccess: boolean }>
  | Readonly<{ mode: "workspace-write"; networkAccess: boolean }>
  | Readonly<{ mode: "danger-full-access" }>;

export type CodexProviderSettings = Readonly<{
  model: string;
  reasoningEffort: string;
  approvalPolicy: CodexProviderApprovalPolicy;
  sandbox: CodexProviderSandboxSetting;
}>;

export const CODEX_PROVIDER_SETTINGS_UI = Object.freeze({
  providerId: CODEX_PROVIDER_ID,
  definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
  fields: Object.freeze([
    Object.freeze({
      key: "model",
      control: "text",
      label: "Model",
      required: true,
      maxLength: APPLICATION_RUN_LIMITS.maxExecutionSettingLength,
    }),
    Object.freeze({
      key: "reasoningEffort",
      control: "text",
      label: "Reasoning effort",
      required: true,
      maxLength: APPLICATION_RUN_LIMITS.maxExecutionSettingLength,
    }),
    Object.freeze({
      key: "approvalPolicy",
      control: "select",
      label: "Approval policy",
      required: true,
      options: Object.freeze([
        Object.freeze({ value: "never", label: "Never" }),
        Object.freeze({ value: "untrusted", label: "Untrusted" }),
        Object.freeze({ value: "on-request", label: "On request" }),
      ]),
    }),
    Object.freeze({
      key: "sandbox",
      control: "sandbox",
      label: "Sandbox",
      required: true,
      modes: Object.freeze([
        Object.freeze({ value: "read-only", label: "Read only", networkAccess: "required" }),
        Object.freeze({ value: "workspace-write", label: "Workspace write", networkAccess: "required" }),
        Object.freeze({ value: "danger-full-access", label: "Danger full access", networkAccess: "forbidden" }),
      ]),
    }),
  ]),
}) satisfies ProviderSettingsUiDefinition;

export const CODEX_PROVIDER_INTERACTION_UI = Object.freeze({
  providerId: CODEX_PROVIDER_ID,
  definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
  kinds: Object.freeze([
    Object.freeze({
      kind: "codex.command_approval",
      label: "Command approval",
      presentation: "decision",
      activity: "waiting_approval",
    }),
    Object.freeze({
      kind: "codex.file_change_approval",
      label: "File change approval",
      presentation: "decision",
      activity: "waiting_approval",
    }),
    Object.freeze({
      kind: "codex.permission_approval",
      label: "Permission approval",
      presentation: "decision",
      activity: "waiting_approval",
    }),
    Object.freeze({
      kind: "codex.user_input",
      label: "Questions",
      presentation: "questions",
      activity: "waiting_input",
    }),
    Object.freeze({
      kind: "codex.mcp_tool_approval",
      label: "MCP tool approval",
      presentation: "decision",
      activity: "waiting_approval",
    }),
    Object.freeze({
      kind: "codex.mcp_server_form",
      label: "MCP server form",
      presentation: "form",
      activity: "waiting_input",
    }),
  ]),
}) satisfies ProviderInteractionUiDefinition;

export const codexProviderDefinition: ProviderDefinition = Object.freeze({
  providerId: CODEX_PROVIDER_ID,
  definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
  settingsUi: CODEX_PROVIDER_SETTINGS_UI,
  interactionUi: CODEX_PROVIDER_INTERACTION_UI,
  canonicalizeSettings: canonicalizeCodexProviderSettings,
  canonicalizeInteractionRequest: canonicalizeCodexInteractionRequest,
  canonicalizeInteractionSnapshot: canonicalizeCodexProviderInteractionSnapshot,
  canonicalizeInteractionResponseShape: canonicalizeCodexInteractionResponseShape,
  canonicalizeInteractionResponse: canonicalizeCodexInteractionResponse,
  compile(
    settings: unknown,
    scope: ProviderExecutionScope,
    modelSelection: ProviderModelSelection,
  ): CompiledCodexProviderExecution {
    const canonical = canonicalizeCodexProviderSettings(settings) as CodexProviderSettings;
    const sandboxMode = canonical.sandbox.mode;
    const sandboxPolicy =
      canonical.sandbox.mode === "danger-full-access"
        ? Object.freeze({ mode: canonical.sandbox.mode })
        : canonical.sandbox.mode === "read-only"
          ? Object.freeze({ mode: canonical.sandbox.mode, networkAccess: canonical.sandbox.networkAccess })
          : Object.freeze({
              mode: canonical.sandbox.mode,
              networkAccess: canonical.sandbox.networkAccess,
              writableRoots: Object.freeze([scope.workspacePath, ...scope.allowedAdditionalDirectories]),
            });
    return Object.freeze({
      kind: "codex",
      providerId: CODEX_PROVIDER_ID,
      definitionVersion: CODEX_PROVIDER_DEFINITION_VERSION,
      startThread: Object.freeze({
        model: canonical.model,
        modelSelection,
        reasoningEffort: canonical.reasoningEffort,
        workspacePath: scope.workspacePath,
        approvalPolicy: canonical.approvalPolicy,
        sandboxMode,
        persistence: "persistent",
      }),
      resumeThread: Object.freeze({
        model: canonical.model,
        modelSelection,
        reasoningEffort: canonical.reasoningEffort,
        workspacePath: scope.workspacePath,
        approvalPolicy: canonical.approvalPolicy,
        sandboxMode,
      }),
      startTurn: Object.freeze({
        workspacePath: scope.workspacePath,
        approvalPolicy: canonical.approvalPolicy,
        sandboxPolicy,
        model: canonical.model,
        modelSelection,
        reasoningEffort: canonical.reasoningEffort,
      }),
    });
  },
});

function canonicalizeCodexProviderInteractionSnapshot(value: unknown): ApplicationRunInteraction {
  const canonical = canonicalizeCodexInteractionSnapshotShape(value);
  if (canonical.kind !== "codex.permission_approval" || !canonical.answerable) return canonical;
  const display = canonical.display as Readonly<{ summary: string; permissions: readonly string[] }>;
  const selected = new Set(display.permissions);
  return Object.freeze({
    ...canonical,
    display: Object.freeze({
      summary: display.summary,
      permissions: Object.freeze(CODEX_ADAPTER_PERMISSION_CATEGORIES.filter((permission) => selected.has(permission))),
    }),
  });
}

export function canonicalizeCodexProviderSettings(
  value: unknown,
): Readonly<{ [key: string]: ProviderSettingsJsonValue }> {
  const settings = exactRecord(value, ["model", "reasoningEffort", "approvalPolicy", "sandbox"]);
  const approvalPolicy = settings.approvalPolicy;
  if (approvalPolicy !== "never" && approvalPolicy !== "untrusted" && approvalPolicy !== "on-request") {
    throw new TypeError("Codex approval policy is invalid.");
  }
  return Object.freeze({
    model: boundedString(settings.model),
    reasoningEffort: boundedString(settings.reasoningEffort),
    approvalPolicy,
    sandbox: canonicalizeSandbox(settings.sandbox),
  });
}

function canonicalizeSandbox(value: unknown): CodexProviderSandboxSetting {
  const sandbox = optionalRecord(value, ["mode", "networkAccess"]);
  if (sandbox.mode === "danger-full-access") {
    requireExactKeys(sandbox, ["mode"]);
    return Object.freeze({ mode: sandbox.mode });
  }
  if (sandbox.mode === "read-only" || sandbox.mode === "workspace-write") {
    requireExactKeys(sandbox, ["mode", "networkAccess"]);
    if (typeof sandbox.networkAccess !== "boolean") throw new TypeError("Codex sandbox is invalid.");
    return Object.freeze({ mode: sandbox.mode, networkAccess: sandbox.networkAccess });
  }
  throw new TypeError("Codex sandbox is invalid.");
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  return snapshotProviderRecord(value, keys);
}

function optionalRecord(value: unknown, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  return snapshotProviderRecord(value, [], allowedKeys);
}

function requireExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Codex settings record keys are invalid.");
  }
}

function boundedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > APPLICATION_RUN_LIMITS.maxExecutionSettingLength ||
    value.includes("\0")
  ) {
    throw new TypeError("Codex settings string is invalid.");
  }
  return value;
}
