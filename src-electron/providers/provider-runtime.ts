import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type {
  ProviderLogicalPrompt,
  ProviderDiagnosticMetadata,
  ProviderUsage,
  ComposerAttachment,
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "../../src-shared/session/runtime-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type {
  MessageArtifact,
  Session,
} from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider } from "../../src-shared/settings/model-catalog.js";
import type { ProviderAgentRuntimeBindingProjection } from "./agent-runtime-binding.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { ProviderOutput } from "../../src-shared/session/provider-output.js";
import type { SessionTurnQueueOrigin } from "../../src-shared/session/session-turn-queue.js";

/** システム指示と Turn 入力を分け、プロバイダー別の送信に使う結合版・画像・追加作業パスも保持する。 */
export type ProviderPromptComposition = {
  systemBodyText: string;
  inputBodyText: string;
  logicalPrompt: ProviderLogicalPrompt;
  imagePaths: string[];
  additionalDirectories: string[];
};

/** Turn 開始時の Session と実行条件、入力の履歴情報、実行中の承認・質問・診断の接続先をまとめる。 */
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
  crewFolderPath?: string;
  character?: CharacterProfile;
  providerCatalog: ModelCatalogProvider;
  userMessage: string;
  replyTo?: import("../../src-shared/session/session-reply.js").SessionReply;
  messageIdentity?: {
    sessionId: string;
    incarnationId: string;
    seq?: number;
    finalAnswerTurnId?: string;
  };
  /** この入力を Main に表示するためのスレッド。履歴の厳密な所有者は Message Identity で識別する。 */
  mainConversationFrame?:
    | import("../../src-shared/session/session-target.js").MainSessionTarget
    | null;
  inputProvenance?: {
    origin:
      | SessionTurnQueueOrigin
      | import("../../src-shared/session/session-turn-queue.js").SessionSteerOrigin
      | null;
    originalChanged: boolean | null;
    retrySource?: import("../../src-shared/session/session-turn-queue.js").SessionTurnQueueCapturedInput["retrySource"];
    coordinationOperation?: string;
    coordination?: import("../../src-shared/coordination/coordination-delivery.js").CoordinationNotification;
  };
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

/** 明示された実行先の前後空白を除いて優先し、空または未指定なら Session の保存済みパスを使う。 */
export function resolveRunWorkspacePath(
  input: Pick<RunSessionTurnInput, "session" | "executionWorkspacePath">,
): string {
  const normalized = input.executionWorkspacePath?.trim() ?? "";
  return normalized || input.session.workspacePath;
}

/** ライブ進捗のステップとバックグラウンドタスクを、項目の追加更新と ID による削除で伝える。 */
export type RunSessionTurnProgressChanges = {
  /** state 内のコレクションが空で、更新内容を changes で伝える場合は false。 */
  snapshot?: false;
  steps: { upserts: LiveSessionRunState["steps"]; removes: string[] };
  backgroundTasks: {
    upserts: LiveSessionRunState["backgroundTasks"];
    removes: string[];
  };
};

/** 進捗の現在状態とコレクション差分を一緒に受け取り、配信完了を同期または非同期に知らせる。 */
export type RunSessionTurnProgressHandler = (
  state: LiveSessionRunState,
  changes: RunSessionTurnProgressChanges,
) => void | Promise<void>;

/** 承認が利用者の判断、委任レビュー、または実行を許可しない制約のどれに由来するかを表す。 */
export type ApprovalDecisionSource = "manual" | "reviewer" | "blocked";
/** 承認結果と別に、その判定元を表示や記録へ通知する受け手。 */
export type ApprovalDecisionSourceObserver = (
  source: ApprovalDecisionSource,
) => void;

/** 判定元の通知は承認結果を変えてはならない。 */
export function reportApprovalDecisionSource(
  observer: ApprovalDecisionSourceObserver | undefined,
  source: ApprovalDecisionSource,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(source)).catch(() => undefined);
  } catch {
    // 監視側はその判定を承認したり覆したりできない。
  }
}

/** 実行中の操作について承認結果を返す。レビューに必要な根拠と判定元の通知先を追加で渡せる。 */
export type RunSessionTurnApprovalRequestHandler = (
  request: LiveApprovalRequest,
  signal?: AbortSignal,
  /** 秘匿化済みのネイティブ操作全体と、ネイティブ側で操作が引き続き有効かを確認する処理。表示用プレビューは使わない。 */
  review?: { operation: unknown; isCurrent?: () => boolean },
  /** 戻り値が利用される前に、この判定の出所を引数として一度だけ呼ばれる。 */
  onDecisionSource?: ApprovalDecisionSourceObserver,
) => Promise<LiveApprovalDecision> | LiveApprovalDecision;

/** プロバイダーの入力要求を受け、利用者から得た回答または取消の結果を返す。 */
export type RunSessionTurnElicitationRequestHandler = (
  request: LiveElicitationRequest,
  signal?: AbortSignal,
) => Promise<LiveElicitationResponse> | LiveElicitationResponse;

/** プロバイダー全体の利用枠の観測結果を受け取る。 */
export type RunSessionTurnProviderQuotaTelemetryHandler = (
  telemetry: ProviderQuotaTelemetry,
) => Promise<void> | void;

/** 対象 Session のコンテキスト使用量の観測結果を受け取る。 */
export type RunSessionTurnSessionContextTelemetryHandler = (
  telemetry: SessionContextTelemetry,
) => Promise<void> | void;

/** 利用枠の取得先と、その照会に使う設定・任意の中断条件を指定する。 */
export type GetProviderQuotaTelemetryInput = {
  providerId: string;
  appSettings: AppSettings;
  signal?: AbortSignal;
};

/** 指定の作業場所におけるモデル候補を、現在のアプリ設定で照会するための入力。 */
export type ListProviderModelsInput = {
  appSettings: AppSettings;
  workspacePath: string;
  signal?: AbortSignal;
};

/** 終了時の応答・スレッド・使用量を返す。プロバイダーが観測できた場合は操作記録や診断も含む。 */
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

/** Turn の失敗を利用上の制限、認証、接続、提供元の利用可否、中断などに分ける共通分類。 */
export type ProviderErrorReason =
  | "usage_limit"
  | "auth"
  | "network"
  | "provider_unavailable"
  | "canceled"
  | "unknown";

/** 途中までに受け取った Turn 結果を失わず、失敗理由とキャンセルの有無を呼び出し側へ伝える。 */
export class ProviderTurnError extends Error {
  readonly partialResult: RunSessionTurnResult;
  readonly canceled: boolean;
  readonly reason: ProviderErrorReason;

  /** 部分結果を保持し、理由が省略された場合はキャンセルの有無から分類を補う。 */
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

/** 実行ランタイムからプロバイダー固有のモデル探索、実行、後片付けを呼び出す共通境界。 */
export type ProviderCodingAdapter = {
  /** 実行先の設定で利用可能なモデル一覧を取得する。機能を持たない実装では省略できる。 */
  listModels?(input: ListProviderModelsInput): Promise<ModelCatalogProvider>;
  /** プロバイダーへ渡すプロンプトの構成を、Turn を開始せず組み立てる。 */
  composePrompt(input: RunSessionTurnInput): ProviderPromptComposition;
  /** 指定プロバイダーの利用枠を取得する。利用できる結果がなければ null を返す。 */
  getProviderQuotaTelemetry(
    input: GetProviderQuotaTelemetryInput,
  ): Promise<ProviderQuotaTelemetry | null>;
  /** 指定 Session のキャッシュされたプロバイダー側スレッドを無効にする。 */
  invalidateSessionThread(sessionId: string): Promise<void>;
  /** 管理している全 Session のプロバイダー側スレッドを無効にする。 */
  invalidateAllSessionThreads(): Promise<void>;
  /** 実行中の想定ネイティブ Turn にだけ追加入力を送り、受け付けた Turn の ID を返す。 */
  steerSessionTurn?(input: {
    sessionId: string;
    expectedTurnId: string;
    userMessage: string;
    attachments: ComposerAttachment[];
  }): Promise<{ turnId: string }>;
  /** Turn を起動し、利用可能なら途中経過を送りながら結果を返す。失敗時は部分結果を伴う場合がある。 */
  runSessionTurn(
    input: RunSessionTurnInput,
    onProgress?: RunSessionTurnProgressHandler,
  ): Promise<RunSessionTurnResult>;
};

/** Turn の起動・終了を管理する側が利用する、共通のプロバイダーアダプター契約。 */
export type ProviderTurnAdapter = ProviderCodingAdapter;
