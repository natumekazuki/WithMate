import type {
  AppSettings,
  AuditLogOperation,
  AuditLogUsage,
  CharacterProfile,
  ComposerAttachment,
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveSessionRunState,
  MessageArtifact,
  Session,
} from "../src/app-state.js";
import type { ModelCatalogProvider } from "../src/model-catalog.js";

export type ProviderPromptComposition = {
  systemPromptText: string;
  inputPromptText: string;
  composedPromptText: string;
  imagePaths: string[];
  additionalDirectories: string[];
};

export type RunSessionTurnInput = {
  session: Session;
  character: CharacterProfile;
  providerCatalog: ModelCatalogProvider;
  userMessage: string;
  appSettings: AppSettings;
  attachments: ComposerAttachment[];
  signal?: AbortSignal;
  onApprovalRequest?: RunSessionTurnApprovalRequestHandler;
};

export type RunSessionTurnProgressHandler = (state: LiveSessionRunState) => void | Promise<void>;

export type RunSessionTurnApprovalRequestHandler = (
  request: LiveApprovalRequest,
) => Promise<LiveApprovalDecision> | LiveApprovalDecision;

export type RunSessionTurnResult = {
  threadId: string | null;
  assistantText: string;
  artifact?: MessageArtifact;
  systemPromptText: string;
  inputPromptText: string;
  composedPromptText: string;
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

export type ProviderTurnAdapter = {
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
  invalidateSessionThread(sessionId: string): void;
  invalidateAllSessionThreads(): void;
  runSessionTurn(
    input: RunSessionTurnInput,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult>;
};
