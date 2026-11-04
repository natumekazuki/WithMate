import type { BackgroundPurpose } from "../../src-shared/agent-runtime/background-execution-scope.js";
import type { BackgroundSourceRef } from "../../src-shared/session/background-source-snapshot.js";
import { resolveBackgroundExecutionOptions, type BackgroundExecutionSelection } from "../../src-shared/settings/background-settings.js";
import { getApprovalReviewerOptionsForProvider, getSandboxOptionsForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import { ProviderTurnError } from "./provider-runtime.js";

export type BackgroundFailureStage = "prepare" | "capture" | "materials" | "setup" | "admission" | "agent" | "registration" | "history" | "read";
export type BackgroundFailure = Readonly<{ code: string; reason: string; stage: BackgroundFailureStage }>;
export type BackgroundFailureEvent = BackgroundFailure & Readonly<{
  timestamp: string; purpose: BackgroundPurpose; sourceKind: BackgroundSourceRef["kind"]; sourceSessionId: string;
  providerId?: string; modelId?: string;
  permissions?: Readonly<{ approvalMode: string; codexReviewer?: string; codexSandboxMode?: string }>;
}>;
export type BackgroundFailureInput = Readonly<{
  purpose: BackgroundPurpose; source: BackgroundSourceRef; stage: BackgroundFailureStage;
  error: unknown; selection?: BackgroundExecutionSelection;
}>;

// Only app-owned codes and curated causes cross the diagnostic boundary. Native messages,
// schema diagnostics, tool payloads and Error stacks are never diagnostic input.
const causes: Record<string, string> = {
  BACKGROUND_SETTINGS_UNAVAILABLE: "Background settings could not be retrieved.",
  BACKGROUND_PROVIDER_DISABLED: "The selected background provider is disabled.",
  BACKGROUND_MODEL_DISABLED: "The selected background model or service is disabled.",
  BACKGROUND_SOURCE_UNSUPPORTED: "The source conversation kind is unsupported.",
  BACKGROUND_CATALOG_UNAVAILABLE: "Background models could not be retrieved.",
  BACKGROUND_PROVIDER_UNSUPPORTED: "The selected background provider is unsupported.",
  BACKGROUND_MODEL_UNAVAILABLE: "The selected background model is unavailable.",
  BACKGROUND_SOURCE_INVALID: "The saved source conversation is no longer eligible.",
  BACKGROUND_BINDING_INVALID: "The independent background binding could not be connected.",
  BACKGROUND_AUTHORITY_UNAVAILABLE: "The source Character authority is unavailable.",
  BACKGROUND_EXECUTION_OPTIONS_INVALID: "The background execution settings are invalid for the provider.",
  BACKGROUND_APPROVAL_REQUIRED: "The background provider requested human approval.",
  BACKGROUND_ELICITATION_REQUIRED: "The background provider requested a human answer.",
  BACKGROUND_PROVIDER_FAILED: "The background provider failed.",
  BACKGROUND_PROVIDER_USAGE_LIMIT: "The background provider usage limit was reached.",
  BACKGROUND_PROVIDER_AUTH: "The background provider authentication failed.",
  BACKGROUND_PROVIDER_NETWORK: "The background provider connection failed.",
  BACKGROUND_PROVIDER_UNAVAILABLE: "The background provider is unavailable.",
  BACKGROUND_AGENT_FAILED: "The background agent failed.",
  BACKGROUND_SETUP_FAILED: "The background execution could not be set up.",
  BACKGROUND_PREPARE_FAILED: "The background call could not be prepared.",
  BACKGROUND_CAPTURE_FAILED: "The saved source conversation could not be captured.",
  BACKGROUND_MATERIALS_FAILED: "Background materials could not be read.",
  BACKGROUND_ADMISSION_CALLBACK_FAILED: "The background admission callback failed.",
  BACKGROUND_OPERATION_FAILED: "A bound WithMate operation failed.",
  PROVIDER_FAILED: "The background provider failed.",
  BACKGROUND_MCP_INVALID_REQUEST: "A bound MCP tool call was rejected as invalid.",
};
for (const [prefix, codes, reason] of [
  ["MEMORY_", "INVALID_REQUEST INVALID_FIELD FORBIDDEN UNAUTHORIZED PRINCIPAL_REQUIRED ENTRY_NOT_FOUND FILE_NOT_FOUND TARGET_NOT_FOUND STORAGE_UNAVAILABLE INTERNAL_ERROR REQUEST_TOO_LARGE CONFLICT FILE_APPEND_UNIMPLEMENTED FILE_CLEANUP_FAILED FILE_EXPORT_FAILED FILE_EXPORT_UNIMPLEMENTED FILE_IMPORT_FAILED FILE_QUOTA_EXCEEDED IDEMPOTENCY_CONFLICT", "The bound Memory operation failed."],
  ["HISTORY_", "INVALID_REQUEST OUT_OF_RANGE NOT_SAVED SOURCE_DELETED SOURCE_REPLACED RANGE_UNAVAILABLE EXECUTION_INACTIVE READ_FAILED", "The saved history operation failed."],
  ["SESSION_BINDING_", "REQUIRED INVALID FORBIDDEN", "The bound operation was not authorized."],
  ["", "invalid_input unknown_character unknown_scope authority_denied version_conflict idempotent_replay storage_unavailable migration_required partial_failure internal_error", "The bound Character operation failed."],
] as const) {
  for (const code of codes.split(" ")) causes[prefix + code] = reason;
}

export function backgroundOperationFailure(value: unknown, stage: BackgroundFailureStage): BackgroundFailure | undefined {
  if (!value || typeof value !== "object") return;
  if ("error" in value && value.error && typeof value.error === "object") {
    return classifyBackgroundFailure(value.error, stage, "BACKGROUND_OPERATION_FAILED");
  }
  if ("ok" in value && value.ok === false) return classifyBackgroundFailure(value, stage, "BACKGROUND_OPERATION_FAILED");
  if ("rejected" in value && Array.isArray(value.rejected) && value.rejected.length > 0) {
    return classifyBackgroundFailure(value.rejected[0], stage, "BACKGROUND_OPERATION_FAILED");
  }
  return;
}

export function classifyBackgroundFailure(error: unknown, stage: BackgroundFailureStage, fallback = "BACKGROUND_AGENT_FAILED"): BackgroundFailure {
  if (error instanceof ProviderTurnError) {
    const providerCodes = { usage_limit: "BACKGROUND_PROVIDER_USAGE_LIMIT", auth: "BACKGROUND_PROVIDER_AUTH", network: "BACKGROUND_PROVIDER_NETWORK",
      provider_unavailable: "BACKGROUND_PROVIDER_UNAVAILABLE", canceled: "BACKGROUND_AGENT_FAILED", unknown: "BACKGROUND_AGENT_FAILED" } as const;
    const code = providerCodes[error.reason];
    return { stage, code, reason: causes[code]! };
  }
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof candidate === "string" && Object.hasOwn(causes, candidate) ? candidate : fallback;
  return { stage, code, reason: causes[code] ?? causes.BACKGROUND_AGENT_FAILED! };
}

export function projectBackgroundFailure(input: BackgroundFailureInput): BackgroundFailureEvent {
  const fallback = input.stage === "agent" ? "BACKGROUND_AGENT_FAILED" : input.stage === "admission" ? "BACKGROUND_ADMISSION_CALLBACK_FAILED"
    : input.stage === "capture" ? "BACKGROUND_CAPTURE_FAILED" : input.stage === "materials" ? "BACKGROUND_MATERIALS_FAILED"
    : input.stage === "prepare" ? "BACKGROUND_PREPARE_FAILED" : "BACKGROUND_SETUP_FAILED";
  const event: BackgroundFailureEvent = { timestamp: new Date().toISOString(), purpose: input.purpose,
    sourceKind: input.source.kind, sourceSessionId: input.source.sessionId,
    ...classifyBackgroundFailure(input.error, input.stage, fallback),
    ...(input.selection ? { providerId: input.selection.providerId, modelId: input.selection.modelId } : {}),
  };
  if (!input.selection) return event;
  try {
    const options = resolveBackgroundExecutionOptions(input.selection);
    return { ...event, permissions: { approvalMode: options.approvalMode,
      ...(getApprovalReviewerOptionsForProvider(input.selection.providerId, options.approvalMode).length ? { codexReviewer: options.codexReviewer } : {}),
      ...(getSandboxOptionsForProvider(input.selection.providerId).length ? { codexSandboxMode: options.codexSandboxMode } : {}) } };
  } catch { return event; }
}
