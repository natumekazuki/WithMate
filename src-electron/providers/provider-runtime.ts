import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ProviderLogicalPrompt, ProviderDiagnosticMetadata, ProviderUsage, ComposerAttachment, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type { MessageArtifact, Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ProviderOutput } from "../../src-shared/session/provider-output.js";
import type { SessionTurnQueueOrigin } from "../../src-shared/session/session-turn-queue.js";

export type ProviderPromptComposition = {
  systemBodyText: string;
  inputBodyText: string;
  logicalPrompt: ProviderLogicalPrompt;
  imagePaths: string[];
  additionalDirectories: string[];
};

export type RunSessionTurnInput = {
  session: Session;
  runtimeOwner?: { kind: "main" | "auxiliary"; id: string; incarnationId: string };
  executionOptions: SessionExecutionOptions;
  executionWorkspacePath?: string;
  sessionFolderPath?: string;
  crewFolderPath?: string;
  character?: CharacterProfile;
  providerCatalog: ModelCatalogProvider;
  userMessage: string;
  replyTo?: import("../../src-shared/session/session-reply.js").SessionReply;
  messageIdentity?: { sessionId: string; incarnationId: string; seq?: number; finalAnswerTurnId?: string };
  /** この入力を Main に表示するためのスレッド。履歴の厳密な所有者は Message Identity で識別する。 */
  mainConversationFrame?: import("../../src-shared/session/session-target.js").MainSessionTarget | null;
  inputProvenance?: { origin: SessionTurnQueueOrigin | import("../../src-shared/session/session-turn-queue.js").SessionSteerOrigin | null; originalChanged: boolean | null; retrySource?: import("../../src-shared/session/session-turn-queue.js").SessionTurnQueueCapturedInput["retrySource"]; coordinationOperation?: string; coordination?: import("../../src-shared/coordination/coordination-delivery.js").CoordinationNotification };
  appSettings: AppSettings;
  attachments: ComposerAttachment[];
  currentDateTime?: string;
  /** この Turn の開始時に一度だけ取得した、保存済みの本文そのもの。 */
  readonly sessionInstructions?: string;
  agentRuntimeBinding?: ProviderAgentRuntimeBindingProjection | null;
  signal?: AbortSignal;
  /** Turn の成否とは独立に、管理下のプロセスの後片付けを確認してから、渡す Promise が解決する。 */
  onCleanupPending?: (completion: Promise<void>) => void;
  onApprovalRequest?: RunSessionTurnApprovalRequestHandler;
  onElicitationRequest?: RunSessionTurnElicitationRequestHandler;
  onElicitationDelivered?: (requestId: string) => void;
  onProviderQuotaTelemetry?: RunSessionTurnProviderQuotaTelemetryHandler;
  onSessionContextTelemetry?: RunSessionTurnSessionContextTelemetryHandler;
};

export function resolveRunWorkspacePath(input: Pick<RunSessionTurnInput, "session" | "executionWorkspacePath">): string {
  const normalized = input.executionWorkspacePath?.trim() ?? "";
  return normalized || input.session.workspacePath;
}

export type RunSessionTurnProgressChanges = {
  /** state 内のコレクションが空で、更新内容を changes で伝える場合は false。 */
  snapshot?: false;
  steps: { upserts: LiveSessionRunState["steps"]; removes: string[] };
  backgroundTasks: { upserts: LiveSessionRunState["backgroundTasks"]; removes: string[] };
};

export type RunSessionTurnProgressHandler = (
  state: LiveSessionRunState,
  changes: RunSessionTurnProgressChanges,
) => void | Promise<void>;

export type ApprovalDecisionSource = "manual" | "reviewer" | "blocked";
export type ApprovalDecisionSourceObserver = (source: ApprovalDecisionSource) => void;

/** 判定元の通知は承認結果を変えてはならない。 */
export function reportApprovalDecisionSource(observer: ApprovalDecisionSourceObserver | undefined, source: ApprovalDecisionSource): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(source)).catch(() => undefined);
  } catch {
    // 監視側はその判定を承認したり覆したりできない。
  }
}

export type RunSessionTurnApprovalRequestHandler = (
  request: LiveApprovalRequest,
  signal?: AbortSignal,
  /** 秘匿化済みのネイティブ操作全体と、ネイティブ側で操作が引き続き有効かを確認する処理。表示用プレビューは使わない。 */
  review?: { operation: unknown; isCurrent?: () => boolean },
  /** 戻り値が利用される前に、この判定の出所を引数として一度だけ呼ばれる。 */
  onDecisionSource?: ApprovalDecisionSourceObserver,
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
  output?: ProviderOutput;
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
