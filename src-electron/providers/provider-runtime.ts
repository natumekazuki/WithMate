import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ProviderLogicalPrompt, ProviderDiagnosticMetadata, ProviderUsage, ComposerAttachment, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type { MessageArtifact, Session } from "../../src-shared/session/session-state.js";
import type { ProjectMemoryEntry, SessionMemory } from "../../src-shared/memory/session-memory-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { ConversationTimingContext } from "../session/conversation-timing.js";
import type { CharacterContextResponse } from "../../src-shared/character-context/character-context-contract.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";

export type ProviderPromptComposition = {
  systemBodyText: string;
  inputBodyText: string;
  logicalPrompt: ProviderLogicalPrompt;
  imagePaths: string[];
  additionalDirectories: string[];
};

export type RunSessionTurnInput = {
  session: Session;
  runtimeOwner?: {
    kind: "main" | "auxiliary";
    id: string;
    incarnationId: string;
  };
  executionOptions: SessionExecutionOptions;
  executionWorkspacePath?: string;
  sessionFolderPath?: string;
  sessionMemory: SessionMemory;
  projectMemoryEntries: ProjectMemoryEntry[];
  character?: CharacterProfile;
  providerCatalog: ModelCatalogProvider;
  userMessage: string;
  appSettings: AppSettings;
  attachments: ComposerAttachment[];
  conversationTimingContext?: ConversationTimingContext;
  characterContext?: CharacterContextResponse;
  agentRuntimeBinding?: ProviderAgentRuntimeBindingProjection | null;
  signal?: AbortSignal;
  /** Resolves only after owned process cleanup is confirmed, independently of turn outcome. */
  onCleanupPending?: (completion: Promise<void>) => void;
  onApprovalRequest?: RunSessionTurnApprovalRequestHandler;
  onElicitationRequest?: RunSessionTurnElicitationRequestHandler;
  onProviderQuotaTelemetry?: RunSessionTurnProviderQuotaTelemetryHandler;
  onSessionContextTelemetry?: RunSessionTurnSessionContextTelemetryHandler;
};

export function resolveRunWorkspacePath(input: Pick<RunSessionTurnInput, "session" | "executionWorkspacePath">): string {
  const normalized = input.executionWorkspacePath?.trim() ?? "";
  return normalized || input.session.workspacePath;
}

export type RunSessionTurnProgressChanges = {
  /** False when state collections are empty and changes carry the collection update. */
  snapshot?: false;
  steps: { upserts: LiveSessionRunState["steps"]; removes: string[] };
  backgroundTasks: { upserts: LiveSessionRunState["backgroundTasks"]; removes: string[] };
};

export type RunSessionTurnProgressHandler = (
  state: LiveSessionRunState,
  changes: RunSessionTurnProgressChanges,
) => void | Promise<void>;

export type RunSessionTurnApprovalRequestHandler = (
  request: LiveApprovalRequest,
  signal?: AbortSignal,
) => Promise<LiveApprovalDecision> | LiveApprovalDecision;

export type RunSessionTurnElicitationRequestHandler = (
  request: LiveElicitationRequest,
  signal?: AbortSignal,
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
  signal?: AbortSignal;
};

export type ListProviderModelsInput = {
  appSettings: AppSettings;
  workspacePath: string;
  signal?: AbortSignal;
};

export type RunSessionTurnResult = {
  threadId: string | null;
  assistantText: string;
  assistantQuestionRanges?: LiveSessionRunState["assistantQuestionRanges"];
  lastNonEmptyAssistantMessageText?: string;
  artifact?: MessageArtifact;
  providerMetadata?: ProviderDiagnosticMetadata[];
  usage: ProviderUsage | null;
  providerQuotaTelemetry?: ProviderQuotaTelemetry | null;
};

export type ProviderErrorReason =
  | "usage_limit"
  | "auth"
  | "network"
  | "provider_unavailable"
  | "canceled"
  | "unknown";

export class ProviderTurnError extends Error {
  readonly partialResult: RunSessionTurnResult;
  readonly canceled: boolean;
  readonly reason: ProviderErrorReason;

  constructor(
    message: string,
    partialResult: RunSessionTurnResult,
    canceled: boolean,
    reason: ProviderErrorReason = canceled ? "canceled" : "unknown",
  ) {
    super(message);
    this.name = "ProviderTurnError";
    this.partialResult = partialResult;
    this.canceled = canceled;
    this.reason = reason;
  }
}

export type ProviderCodingAdapter = {
  listModels?(input: ListProviderModelsInput): Promise<ModelCatalogProvider>;
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
  getProviderQuotaTelemetry(input: GetProviderQuotaTelemetryInput): Promise<ProviderQuotaTelemetry | null>;
  invalidateSessionThread(sessionId: string): Promise<void>;
  invalidateAllSessionThreads(): Promise<void>;
  steerSessionTurn?(input: {
    sessionId: string;
    expectedTurnId: string;
    userMessage: string;
    attachments: ComposerAttachment[];
  }): Promise<{ turnId: string }>;
  runSessionTurn(
    input: RunSessionTurnInput,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult>;
};

export type ProviderTurnAdapter = ProviderCodingAdapter;
