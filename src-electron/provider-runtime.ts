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
  sessionMemory: SessionMemory;
  projectMemoryEntries: ProjectMemoryEntry[];
  character: CharacterProfile;
  providerCatalog: ModelCatalogProvider;
  userMessage: string;
  appSettings: AppSettings;
  attachments: ComposerAttachment[];
  signal?: AbortSignal;
  onApprovalRequest?: RunSessionTurnApprovalRequestHandler;
  onProviderQuotaTelemetry?: RunSessionTurnProviderQuotaTelemetryHandler;
  onSessionContextTelemetry?: RunSessionTurnSessionContextTelemetryHandler;
};

export type RunSessionTurnProgressHandler = (state: LiveSessionRunState) => void | Promise<void>;

export type RunSessionTurnApprovalRequestHandler = (
  request: LiveApprovalRequest,
) => Promise<LiveApprovalDecision> | LiveApprovalDecision;

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
  prompt: SessionMemoryExtractionPrompt;
};

export type ExtractSessionMemoryResult = {
  threadId: string | null;
  rawText: string;
  delta: SessionMemoryDelta | null;
  usage: AuditLogUsage | null;
};

export type RunCharacterReflectionInput = {
  session: Session;
  sessionMemory: SessionMemory;
  character: CharacterProfile;
  characterMemoryEntries: CharacterMemoryEntry[];
  appSettings: AppSettings;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  triggerReason: CharacterReflectionTriggerReason;
  prompt: CharacterReflectionPrompt;
};

export type RunCharacterReflectionResult = {
  threadId: string | null;
  rawText: string;
  output: CharacterReflectionOutput | null;
  usage: AuditLogUsage | null;
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
  extractSessionMemoryDelta(input: ExtractSessionMemoryInput): Promise<ExtractSessionMemoryResult>;
  runCharacterReflection(input: RunCharacterReflectionInput): Promise<RunCharacterReflectionResult>;
};

export type ProviderTurnAdapter = ProviderCodingAdapter & ProviderBackgroundAdapter;
