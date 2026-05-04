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
  character: CharacterProfile;
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
  allowsToolPermissionRequests: boolean;
  structuredOutputOnly: boolean;
};

export const MATE_TALK_BACKGROUND_STRUCTURED_PROMPT_POLICY: ProviderBackgroundStructuredPromptPolicy = {
  allowsFileWrite: false,
  allowsToolPermissionRequests: false,
  structuredOutputOnly: true,
};

export function isMateTalkBackgroundStructuredPromptPolicyCompatible(
  policy: ProviderBackgroundStructuredPromptPolicy,
): boolean {
  return !policy.allowsFileWrite
    && !policy.allowsToolPermissionRequests
    && policy.structuredOutputOnly;
}

export function canUseProviderForMateTalkBackgroundPrompt(adapter: ProviderBackgroundAdapter): boolean {
  return isMateTalkBackgroundStructuredPromptPolicyCompatible(adapter.getBackgroundStructuredPromptPolicy());
}

export type ProviderTurnAdapter = ProviderCodingAdapter & ProviderBackgroundAdapter;
