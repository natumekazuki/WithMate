import type {
  AppSettings,
  AuditLogicalPrompt,
  AuditLogOperation,
  AuditLogUsage,
  AuditTransportPayload,
  CharacterProfile,
  CharacterMemoryEntry,
  CharacterReflectionOutput,
  ComposerAttachment,
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
  LiveSessionRunState,
  MessageArtifact,
  ProjectMemoryEntry,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
  Session,
  SessionMemory,
  SessionMemoryDelta,
} from "../src/app-state.js";
import type { ModelReasoningEffort, ModelCatalogProvider } from "../src/model-catalog.js";
import { normalizeApprovalMode, type ApprovalMode } from "../src/approval-mode.js";
import { normalizeCodexSandboxMode, type CodexSandboxMode } from "../src/codex-sandbox-mode.js";
import type { CharacterReflectionPrompt, CharacterReflectionTriggerReason } from "./character-reflection.js";
import type { SessionMemoryExtractionPrompt } from "./session-memory-extraction.js";

export type ProviderPromptComposition = {
  systemBodyText: string;
  inputBodyText: string;
  logicalPrompt: AuditLogicalPrompt;
  imagePaths: string[];
  additionalDirectories: string[];
};

export type RunSessionTurnInput = {
  session: Session;
  executionWorkspacePath?: string;
  sessionMemory: SessionMemory;
  projectMemoryEntries: ProjectMemoryEntry[];
  projectContextText?: string | null;
  character?: CharacterProfile;
  providerCatalog: ModelCatalogProvider;
  userMessage: string;
  appSettings: AppSettings;
  attachments: ComposerAttachment[];
  signal?: AbortSignal;
  onApprovalRequest?: RunSessionTurnApprovalRequestHandler;
  onElicitationRequest?: RunSessionTurnElicitationRequestHandler;
  onProviderQuotaTelemetry?: RunSessionTurnProviderQuotaTelemetryHandler;
  onSessionContextTelemetry?: RunSessionTurnSessionContextTelemetryHandler;
};

export function resolveRunWorkspacePath(input: Pick<RunSessionTurnInput, "session" | "executionWorkspacePath">): string {
  const normalized = input.executionWorkspacePath?.trim() ?? "";
  return normalized || input.session.workspacePath;
}

export type RunSessionTurnProgressHandler = (state: LiveSessionRunState) => void | Promise<void>;

export type RunSessionTurnApprovalRequestHandler = (
  request: LiveApprovalRequest,
) => Promise<LiveApprovalDecision> | LiveApprovalDecision;

export type RunSessionTurnElicitationRequestHandler = (
  request: LiveElicitationRequest,
) => Promise<LiveElicitationResponse> | LiveElicitationResponse;

export type RunSessionTurnProviderQuotaTelemetryHandler = (
  telemetry: ProviderQuotaTelemetry,
) => Promise<void> | void;

export type RunSessionTurnSessionContextTelemetryHandler = (
  telemetry: SessionContextTelemetry,
) => Promise<void> | void;

export type GetProviderQuotaTelemetryInput = {
  providerId: string;
  appSettings: AppSettings;
};

export type ExtractSessionMemoryInput = {
  session: Session;
  appSettings: AppSettings;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  timeoutMs: number;
  prompt: SessionMemoryExtractionPrompt;
};

export type ExtractSessionMemoryResult = {
  threadId: string | null;
  rawText: string;
  delta: SessionMemoryDelta | null;
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  providerQuotaTelemetry?: ProviderQuotaTelemetry | null;
};

export type RunCharacterReflectionInput = {
  session: Session;
  sessionMemory: SessionMemory;
  character: CharacterProfile;
  characterMemoryEntries: CharacterMemoryEntry[];
  appSettings: AppSettings;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  timeoutMs: number;
  triggerReason: CharacterReflectionTriggerReason;
  prompt: CharacterReflectionPrompt;
};

export type RunCharacterReflectionResult = {
  threadId: string | null;
  rawText: string;
  output: CharacterReflectionOutput | null;
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  providerQuotaTelemetry?: ProviderQuotaTelemetry | null;
};

export type RunBackgroundStructuredPromptInput = {
  providerId: string;
  workspacePath: string;
  appSettings: AppSettings;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  timeoutMs: number;
  additionalDirectories?: string[];
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  prompt: {
    systemText: string;
    userText: string;
    outputSchema: unknown;
  };
  signal?: AbortSignal;
};

export type RunBackgroundStructuredPromptResult<TOutput = unknown> = {
  threadId: string | null;
  rawText: string;
  output: TOutput | null;
  parsedJson?: unknown;
  structuredOutput?: unknown;
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  providerQuotaTelemetry?: ProviderQuotaTelemetry | null;
};

export type RunSessionTurnResult = {
  threadId: string | null;
  assistantText: string;
  artifact?: MessageArtifact;
  logicalPrompt: AuditLogicalPrompt;
  transportPayload: AuditTransportPayload | null;
  operations: AuditLogOperation[];
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  providerQuotaTelemetry?: ProviderQuotaTelemetry | null;
};

export class ProviderTurnError extends Error {
  readonly partialResult: RunSessionTurnResult;
  readonly canceled: boolean;

  constructor(message: string, partialResult: RunSessionTurnResult, canceled: boolean) {
    super(message);
    this.name = "ProviderTurnError";
    this.partialResult = partialResult;
    this.canceled = canceled;
  }
}

export type ProviderCodingAdapter = {
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
  getProviderQuotaTelemetry(input: GetProviderQuotaTelemetryInput): Promise<ProviderQuotaTelemetry | null>;
  invalidateSessionThread(sessionId: string): void;
  invalidateAllSessionThreads(): void;
  runSessionTurn(
    input: RunSessionTurnInput,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult>;
};

export type ProviderBackgroundAdapter = {
  getBackgroundStructuredPromptPolicy(): ProviderBackgroundStructuredPromptPolicy;
  extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult>;
  runCharacterReflection(input: RunCharacterReflectionInput): Promise<RunCharacterReflectionResult>;
  runBackgroundStructuredPrompt<TOutput = unknown>(
    input: RunBackgroundStructuredPromptInput,
  ): Promise<RunBackgroundStructuredPromptResult<TOutput>>;
};

export type ProviderBackgroundStructuredPromptPolicy = {
  allowsFileWrite: boolean;
  allowsShellWrite: boolean;
  allowsToolPermissionRequests: boolean;
  structuredOutputOnly: boolean;
  structuredOutputMode: "provider_schema" | "schema_submit_tool";
};

export type ProviderBackgroundStructuredPromptIncompatibilityReason =
  | "file_write_allowed"
  | "shell_write_allowed"
  | "tool_permission_requests_allowed"
  | "structured_output_not_guaranteed";

export type ProviderBackgroundStructuredPromptCapability = {
  compatible: boolean;
  policy: ProviderBackgroundStructuredPromptPolicy;
  reasons: readonly ProviderBackgroundStructuredPromptIncompatibilityReason[];
};

export type ProviderBackgroundStructuredPromptEvaluationOptions = {
  operationPermissionMode?: "read-only-required" | "user-selected";
  approvalMode?: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
};

export type ProviderBackgroundStructuredPromptCapabilitySummary = {
  structuredOutputSupported: boolean;
  providerSchemaSupported: boolean;
  schemaSubmitToolSupported: boolean;
  fileWriteDisabled: boolean;
  shellWriteDisabled: boolean;
  toolPermissionRequestDisabled: boolean;
};

export const MATE_TALK_PROVIDER_SCHEMA_BACKGROUND_STRUCTURED_PROMPT_POLICY: ProviderBackgroundStructuredPromptPolicy = {
  allowsFileWrite: false,
  allowsShellWrite: false,
  allowsToolPermissionRequests: false,
  structuredOutputOnly: true,
  structuredOutputMode: "provider_schema",
};

export const MATE_TALK_SCHEMA_SUBMIT_TOOL_BACKGROUND_STRUCTURED_PROMPT_POLICY: ProviderBackgroundStructuredPromptPolicy = {
  allowsFileWrite: false,
  allowsShellWrite: false,
  allowsToolPermissionRequests: false,
  structuredOutputOnly: true,
  structuredOutputMode: "schema_submit_tool",
};

export const MATE_TALK_BACKGROUND_STRUCTURED_PROMPT_POLICY =
  MATE_TALK_PROVIDER_SCHEMA_BACKGROUND_STRUCTURED_PROMPT_POLICY;

function selectedCodexSandboxAllowsWrites(mode: CodexSandboxMode | undefined): boolean {
  if (!mode) {
    return false;
  }

  const normalized = normalizeCodexSandboxMode(mode);
  return normalized === "workspace-write"
    || normalized === "workspace-write-network"
    || normalized === "danger-full-access";
}

function selectedApprovalAllowsToolPermissionRequests(mode: ApprovalMode | undefined): boolean {
  if (!mode) {
    return false;
  }

  return normalizeApprovalMode(mode) !== "never";
}

export function resolveMateTalkBackgroundStructuredPromptPolicy(
  policy: ProviderBackgroundStructuredPromptPolicy,
  options: ProviderBackgroundStructuredPromptEvaluationOptions = {},
): ProviderBackgroundStructuredPromptPolicy {
  if (options.operationPermissionMode !== "user-selected") {
    return policy;
  }

  const allowsCodexWrites = selectedCodexSandboxAllowsWrites(options.codexSandboxMode);
  return {
    ...policy,
    allowsFileWrite: policy.allowsFileWrite || allowsCodexWrites,
    allowsShellWrite: policy.allowsShellWrite || allowsCodexWrites,
    allowsToolPermissionRequests: policy.allowsToolPermissionRequests
      || selectedApprovalAllowsToolPermissionRequests(options.approvalMode),
  };
}

export function evaluateMateTalkBackgroundStructuredPromptPolicy(
  policy: ProviderBackgroundStructuredPromptPolicy,
  options: ProviderBackgroundStructuredPromptEvaluationOptions = {},
): ProviderBackgroundStructuredPromptCapability {
  const effectivePolicy = resolveMateTalkBackgroundStructuredPromptPolicy(policy, options);
  const requireReadOnly = options.operationPermissionMode !== "user-selected";
  const reasons: ProviderBackgroundStructuredPromptIncompatibilityReason[] = [];
  if (requireReadOnly && effectivePolicy.allowsFileWrite) {
    reasons.push("file_write_allowed");
  }
  if (requireReadOnly && effectivePolicy.allowsShellWrite) {
    reasons.push("shell_write_allowed");
  }
  if (requireReadOnly && effectivePolicy.allowsToolPermissionRequests) {
    reasons.push("tool_permission_requests_allowed");
  }
  if (!effectivePolicy.structuredOutputOnly) {
    reasons.push("structured_output_not_guaranteed");
  }
  return {
    compatible: reasons.length === 0,
    policy: effectivePolicy,
    reasons,
  };
}

export function summarizeMateTalkBackgroundStructuredPromptCapability(
  policy: ProviderBackgroundStructuredPromptPolicy,
): ProviderBackgroundStructuredPromptCapabilitySummary {
  return {
    structuredOutputSupported: policy.structuredOutputOnly,
    providerSchemaSupported: policy.structuredOutputOnly && policy.structuredOutputMode === "provider_schema",
    schemaSubmitToolSupported: policy.structuredOutputOnly && policy.structuredOutputMode === "schema_submit_tool",
    fileWriteDisabled: !policy.allowsFileWrite,
    shellWriteDisabled: !policy.allowsShellWrite,
    toolPermissionRequestDisabled: !policy.allowsToolPermissionRequests,
  };
}

export function getMateTalkBackgroundStructuredPromptCapability(
  adapter: ProviderBackgroundAdapter,
  options: ProviderBackgroundStructuredPromptEvaluationOptions = {},
): ProviderBackgroundStructuredPromptCapability {
  return evaluateMateTalkBackgroundStructuredPromptPolicy(adapter.getBackgroundStructuredPromptPolicy(), options);
}

export function isMateTalkBackgroundStructuredPromptPolicyCompatible(
  policy: ProviderBackgroundStructuredPromptPolicy,
  options: ProviderBackgroundStructuredPromptEvaluationOptions = {},
): boolean {
  return evaluateMateTalkBackgroundStructuredPromptPolicy(policy, options).compatible;
}

export function canUseProviderForMateTalkBackgroundPrompt(
  adapter: ProviderBackgroundAdapter,
  options: ProviderBackgroundStructuredPromptEvaluationOptions = {},
): boolean {
  return getMateTalkBackgroundStructuredPromptCapability(adapter, options).compatible;
}

export type ProviderTurnAdapter = ProviderCodingAdapter & ProviderBackgroundAdapter;
