import { currentTimestampLabel as defaultCurrentTimestampLabel } from "../../src-shared/time-state.js";
import { isDeepStrictEqual } from "node:util";
import { readCoordinationNotification } from "../../src-shared/coordination/coordination-delivery.js";
import type {
  ComposerAttachment,
  ComposerPreview,
  LiveApprovalDecision,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  RunSessionTurnRequest,
  SessionContextTelemetry,
  SteerSessionTurnRequest,
  SteerSessionTurnResult,
} from "../../src-shared/session/runtime-state.js";
import type {
  MessageArtifact,
  TurnInputDeliveryState,
} from "../../src-shared/session/session-state.js";
import { normalizeSessionTurnCorrelation } from "../../src-shared/session/runtime-state.js";
import { placeElicitationRecords } from "../../src-shared/session/question-placement.js";
import {
  validateSessionExecutionOptions,
  type SessionExecutionOptions,
} from "../../src-shared/session/session-execution-options.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import { type CharacterProfile } from "../../src-shared/character/character-state.js";
import { buildLiveRunMessageOperations } from "../../src-shared/session/live-run-message-operations.js";
import type {
  SessionTurnInput,
  SessionTurnRecord,
} from "../../src-shared/session/session-turn-state.js";
import { toProviderTextPreview } from "./provider-payload-limits.js";
import {
  getProviderAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  getSessionIncarnationId,
  isReadOnlySession,
  type Session,
} from "../../src-shared/session/session-state.js";
import {
  captureSessionTurnQueueDisplay,
  type SessionSteerOrigin,
  type SessionSteerResult,
  type SessionTurnQueueOwner,
  type SessionTurnQueueReceipt,
  type SessionTurnQueueCapturedInput,
} from "../../src-shared/session/session-turn-queue.js";
import {
  QueuedInputPreDispatchError,
  QueuedInputRuntimeRecoveryError,
  type SessionTurnQueueDispatchControl,
  type SessionTurnQueueDispatchResult,
} from "./session-turn-queue-service.js";
import type { CancelSessionRunRequest } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnQueueService } from "./session-turn-queue-service.js";
import type {
  ModelCatalogProvider,
  ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import {
  ProviderTurnError,
  reportApprovalDecisionSource,
  type ApprovalDecisionSourceObserver,
  type ProviderCodingAdapter,
  type RunSessionTurnResult,
  type RunSessionTurnInput,
} from "../providers/provider-runtime.js";
import { composeProviderInput } from "../providers/provider-prompt.js";
import {
  sessionReplySchema,
  type SessionReply,
} from "../../src-shared/session/session-reply.js";
import type { MainSessionTarget } from "../../src-shared/session/session-target.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionTurnTerminalNotification } from "./session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import { formatCurrentDateTime } from "./current-date.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "./session-run-timeouts.js";
import { applyProviderProgressChanges } from "../providers/provider-progress.js";
import { questionAnswerHistory } from "./question-answer-history.js";
import { supportsWithMateAutoReview } from "../../src-shared/settings/withmate-auto-review.js";
import type {
  PendingApprovalReview,
  StartWithMateApprovalReview,
  WithMateApprovalReviewTurn,
} from "./withmate-approval-review.js";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

/** 実行の解放が滞る箇所を追跡するため、段階名とその時点の状態を共通識別子で記録する。 */
function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

/** Turn の実行管理を、永続化・Provider・承認・ライブ投影の各境界に接続する依存先。 */
export type SessionRuntimeServiceDeps = {
  /** 同一 Session の開始判定を直列化し、待機中の取消を受け付ける。 */
  runSessionAdmissionExclusive?<T>(
    sessionId: string,
    operation: () => T | Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  /** 保存済み Session を取得する。存在しない ID には null を返す。 */
  getSession(sessionId: string): Awaitable<Session | null>;
  /** 新しい Turn ごとに、特定した所有者の指示を一度だけ読み込む。Steer では使わない。 */
  readSessionInstructions?(session: Session): Awaitable<string>;
  /** 更新前のメッセージ件数を照合して、入力と実行中の Session を保存する。 */
  persistRunningTurnStart(
    session: Session,
    expectedMessageCount: number,
  ): Awaitable<Session>;
  /** キューの入力・実行中 Session・Turn レコードを一体で確定する。 */
  persistQueuedTurnStart?(
    session: Session,
    expectedMessageCount: number,
    queueId: string,
    turn: SessionTurnInput,
  ): Awaitable<{ session: Session; turn: SessionTurnRecord }>;
  /** キューに捕捉した添付を送信前に検証し、利用不能なら開始を拒否する。 */
  assertCapturedComposerAttachmentsAvailable?(
    session: Session,
    attachments: ComposerAttachment[],
  ): Promise<void>;
  /** Session の実行枠が解放され、後続の入力を処理できることを通知する。 */
  onSessionRunReleased?(sessionId: string): void;
  /** 手元の受付記録を基に、保存済みの最新の受付記録を引き直す。 */
  getQueuedInputReceipt?(
    receipt: SessionTurnQueueReceipt,
  ): Awaitable<SessionTurnQueueReceipt | null>;
  /** Steer の受理済み入力を実行中の Turn に追記し、必要ならキューの来歴も結ぶ。 */
  appendRunningInput(
    session: Session,
    text: string,
    turnId: number,
    queuedInput?: { queueId: string; inputTurnId: string },
    replyTo?: SessionReply,
  ): Awaitable<Session>;
  /** Provider に直接送る入力を、対象の native Turn と結び付けて送達待ちで保存する。 */
  beginRunningInput?(
    session: Session,
    text: string,
    turnId: number,
    nativeTurnId: string,
    attachments: ComposerAttachment[],
    origin?: SessionSteerOrigin,
    questionRequestId?: string,
    replyTo?: SessionReply,
  ): Awaitable<Session>;
  /** 保存済みメッセージを指す返信参照が、まだ利用できることを確認する。 */
  assertSavedReplyTo?(reference: SessionReply): Promise<void>;
  /** Main の保存済みメッセージが属する会話を、メッセージ番号から調べる。 */
  readMainMessageThread?(
    target: MainSessionTarget,
    seq: number,
  ): Promise<MainSessionTarget | null | undefined>;
  /** 直接送信の記録を、送達待ちから判明した結果へ更新する。 */
  settleRunningInput?(
    session: Session,
    messageSeq: number,
    turnId: number,
    state: Exclude<TurnInputDeliveryState, "pending">,
  ): Awaitable<Session>;
  /** 想定した保存状態と照合しながら、Turn 開始前のランタイム情報を確定する。 */
  checkpointRuntimeMetadata(
    session: Session,
    expected: Session,
  ): Awaitable<Session>;
  /** Turn の終端結果を保存し、確認済みの最終応答が渡された場合は保存処理へ伝える。 */
  appendTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session>;
  /** 入力元を表示するためのインメモリスコープを開く。返す同期の解放処理は、ストレージに書き込まず、この Turn のスコープだけを解放する。 */
  beginSourceDisplayTurn?(session: Session, turnId: string): () => void;
  /** Character 作成用の実行状態が無効になった Session から、その保存情報を除去する。 */
  clearCharacterAuthoringRuntimeState?(session: Session): Awaitable<Session>;
  resolveRuntimeSessionForTurn?: (session: Session) => Awaitable<Session>;
  /** キューで捕捉していない通常入力について、本文と添付のプレビューを解決する。 */
  resolveComposerPreview(
    session: Session,
    userMessage: string,
  ): Promise<ComposerPreview>;
  resolveProviderSession?: (session: Session) => Awaitable<Session>;
  resolveSessionFolderPath?: (sessionId: string) => Awaitable<string>;
  resolveCrewFolderPath?: (sessionId: string) => Awaitable<string>;
  resolveSessionCharacter?: (
    session: Session,
  ) => Promise<CharacterProfile | null>;
  getAppSettings: () => Awaitable<AppSettings>;
  /** Provider と作業場所を基に、現在のモデル一覧と Provider の設定を解決する。 */
  resolveProviderCatalog(
    providerId: string | null | undefined,
    workspacePath?: string,
  ): Awaitable<{
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  }>;
  /** Turn の実行や実行中入力を委ねる、選択済み Provider のアダプターを取得する。 */
  getProviderCodingAdapter(
    providerId: string | null | undefined,
  ): ProviderCodingAdapter;
  /** 直接送信で、保存済みの開始入力に対応する Turn レコードを作成する。 */
  createSessionTurn(input: SessionTurnInput): Awaitable<SessionTurnRecord>;
  /** 保存済み Turn を ID で指定して、実行パラメーターと状態を更新する。 */
  updateSessionTurn(
    id: number,
    input: SessionTurnInput,
  ): Awaitable<void | SessionTurnRecord>;
  /** Session のライブ投影を格納し、null なら既存の投影を除去する。 */
  setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void;
  /** 途中応答・承認などを含む、Session の最新ライブ投影を取得する。 */
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  /** Provider の承認要求に対し、取消や仲介レビューを含む経路で判断を待つ。 */
  waitForApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
    review?: PendingApprovalReview | null,
    onDecisionSource?: ApprovalDecisionSourceObserver,
  ): Promise<LiveApprovalDecision> | LiveApprovalDecision;
  startWithMateApprovalReview?: StartWithMateApprovalReview;
  /** Provider が求めた追加入力への回答を、要求の取消シグナルとともに待つ。 */
  waitForElicitationResponse(
    sessionId: string,
    request: LiveElicitationRequest,
    signal: AbortSignal,
  ): Promise<LiveElicitationResponse> | LiveElicitationResponse;
  /** Provider から報告された利用枠の計測値を反映する。 */
  setProviderQuotaTelemetry(telemetry: ProviderQuotaTelemetry): void;
  /** Provider から報告された Session のコンテキスト使用状況を反映する。 */
  setSessionContextTelemetry(telemetry: SessionContextTelemetry): void;
  /** Session に紐づく Provider 側の実行スレッドを無効化する。 */
  invalidateProviderSessionThread(
    providerId: string | null | undefined,
    sessionId: string,
  ): Awaitable<void>;
  /** Session に対応する Provider スレッドをリセットするための依存先。 */
  resetProviderSessionThread?(
    providerId: string | null | undefined,
    sessionId: string,
  ): Awaitable<void>;
  /** 再開に失敗しても、保存済み Auxiliary のスレッドを黙って置き換えない。 */
  isAuxiliarySession?(sessionId: string): Awaitable<boolean>;
  /** この Session と Provider に対応するエージェント実行環境の既存バインディングを取得する。 */
  getProviderAgentRuntimeBinding?(input: {
    session: Session;
    provider: ModelCatalogProvider;
  }): Awaitable<ProviderAgentRuntimeBindingProjection | null>;
  /** 実行条件に合わせて Turn 用の実行環境を開き、解放用ハンドルと有効なバインディングを返す。 */
  beginProviderAgentRuntimeTurn?(input: {
    session: Session;
    executionOptions: SessionExecutionOptions;
    provider: ModelCatalogProvider;
    binding: ProviderAgentRuntimeBindingProjection | null;
    signal: AbortSignal;
  }): Awaitable<
    | {
        handle: unknown;
        binding: ProviderAgentRuntimeBindingProjection | null;
      }
    | undefined
  >;
  /** 開始時に発行したハンドルを用いて、Turn 専用の実行環境を解放する。 */
  endProviderAgentRuntimeTurn?(handle: unknown): void;
  /** Turn 後に利用枠を取り直すよう、Provider と遅延時間を指定して予約する。 */
  scheduleProviderQuotaTelemetryRefresh(
    providerId: string,
    delaysMs: number[],
  ): void;
  /** Session のライブ投影が変わったことを購読側に通知する。 */
  broadcastLiveSessionRun(sessionId: string): void;
  /** 保存済み送信入力の変化を、送信元の表示を管理する側へ通知する。 */
  onSentInputChanged?(origin: SessionSteerOrigin): void;
  /** 待機中の承認要求に対する判断を反映し、Provider の待機を解除する。 */
  resolvePendingApprovalRequest(
    sessionId: string,
    decision: LiveApprovalDecision,
  ): void;
  /** 待機中の追加入力要求に回答を渡し、Provider の待機を解除する。 */
  resolvePendingElicitationRequest(
    sessionId: string,
    response: LiveElicitationResponse,
  ): void;
  getMateState?: () => MateStorageState;
  notifySessionTurnTerminal?: (
    notification: SessionTurnTerminalNotification,
  ) => Awaitable<void>;
  currentTimestampLabel?: () => string;
  currentDate?: () => Date;
  providerCancelGraceMs?: number;
};

/** 終端保存後の通知は待機せず、通知側の同期・非同期の失敗を警告に留める。 */
function notifySessionTurnTerminalBestEffort(
  notify: SessionRuntimeServiceDeps["notifySessionTurnTerminal"],
  notification: SessionTurnTerminalNotification,
): void {
  if (!notify) {
    return;
  }

  try {
    void Promise.resolve(notify(notification)).catch((error) =>
      console.warn("Session turn terminal notification failed", error),
    );
  } catch (error) {
    console.warn("Session turn terminal notification failed", error);
  }
}

/** 切り離した実行のスレッド無効化を待機せず、失敗しても取消処理へ伝播させない。 */
function invalidateProviderSessionThreadBestEffort(
  invalidate: SessionRuntimeServiceDeps["invalidateProviderSessionThread"],
  providerId: string | null | undefined,
  sessionId: string,
): void {
  try {
    void Promise.resolve(invalidate(providerId, sessionId)).catch((error) =>
      console.warn("Detached provider session invalidation failed", error),
    );
  } catch (error) {
    console.warn("Detached provider session invalidation failed", error);
  }
}

/** 取消期限までに取得できた応答・操作履歴・使用量を、保存可能な部分結果にする。 */
function buildCanceledPartialResult(
  liveState: LiveSessionRunState | null,
): RunSessionTurnResult {
  return {
    threadId: liveState?.threadId || null,
    assistantText: liveState?.assistantText ?? "",
    assistantQuestionRanges: liveState?.assistantQuestionRanges,
    artifact: liveState
      ? {
          title: "",
          changedFiles: [],
          activitySummary: [],
          runChecks: [],
          operationTimeline: buildLiveRunMessageOperations(liveState),
        }
      : undefined,
    usage: liveState?.usage ?? null,
    providerQuotaTelemetry: null,
  };
}

/** 取消後の猶予を超えたら、Provider の実終了を別途追跡しつつ部分結果付きの取消を返す。 */
function waitForProviderTurnWithCancelDeadline(
  providerPromise: Promise<RunSessionTurnResult>,
  signal: AbortSignal,
  graceMs: number,
  buildPartialResult: () => RunSessionTurnResult,
  onCancelDeadline: (providerPromise: Promise<RunSessionTurnResult>) => void,
): Promise<RunSessionTurnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    /** Provider 完了と取消期限の先着だけを採用し、タイマーと abort リスナーを解除する。 */
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    /** Provider に停止猶予を与え、期限後も未終了なら部分結果を採取して待機を打ち切る。 */
    const onAbort = () => {
      timeout = setTimeout(() => {
        onCancelDeadline(providerPromise);
        settle(() =>
          reject(
            new ProviderTurnError(
              "Provider did not stop within the cancellation grace period",
              buildPartialResult(),
              true,
              "canceled",
            ),
          ),
        );
      }, graceMs);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    providerPromise.then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** 通常の失敗と区別できるよう、実行の取消を AbortError 名で表す。 */
function createCanceledRunError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** 取消済みなら処理を中止し、開始を発行していないキューの取消は専用エラーで区別する。 */
function throwIfRunCanceled(
  signal: AbortSignal,
  queued?: QueuedTurnContext,
): void {
  if (signal.aborted) {
    if (queued && !queued.startIssued)
      throw new QueuedTurnPreStartCanceledError("Session setup was canceled");
    throw createCanceledRunError("Session setup was canceled");
  }
}

/** 準備依存先が取消猶予を過ぎても停止しなければ、依存先を追跡に渡して待機を打ち切る。 */
function waitForSetupWithCancelDeadline<T>(
  setupPromise: Promise<T>,
  signal: AbortSignal,
  graceMs: number,
  isSetupPending: () => boolean,
  onCancelDeadline: (setupPromise: Promise<T>) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    /** 準備処理の結果と取消による打ち切りを一度だけ確定し、待機用の登録を解除する。 */
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    /** 期限の時点でも準備段階に留まる場合だけ打ち切り、移行後の処理とは競合させない。 */
    const onAbort = () => {
      timeout = setTimeout(() => {
        if (!isSetupPending()) {
          return;
        }
        onCancelDeadline(setupPromise);
        settle(() =>
          reject(
            createCanceledRunError(
              "Session setup did not stop within the cancellation grace period",
            ),
          ),
        );
      }, graceMs);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    setupPromise.then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** AbortError 名・ABORT_ERR コードを確認し、ない場合はメッセージの取消表現を調べる。 */
export function isCanceledRunError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown };
    if (candidate.name === "AbortError" || candidate.code === "ABORT_ERR") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /abort|aborted|cancel|canceled|cancelled/i.test(message);
}

/** 見出しだけでなく、変更ファイル・説明・操作履歴・確認結果のいずれかがあるかを判定する。 */
function hasMeaningfulArtifact(artifact: MessageArtifact | undefined): boolean {
  if (!artifact) {
    return false;
  }

  return (
    artifact.changedFiles.length > 0 ||
    artifact.activitySummary.some((summary) => summary.trim().length > 0) ||
    (artifact.operationTimeline?.length ?? 0) > 0 ||
    artifact.runChecks.length > 0
  );
}

/** 途中結果に空白以外の応答か実質的な成果物があるかを返す。使用量やスレッド ID だけでは該当しない。 */
export function hasMeaningfulPartialRunResult(
  partialResult: RunSessionTurnResult | null | undefined,
): boolean {
  if (!partialResult) {
    return false;
  }

  return (
    partialResult.assistantText.trim().length > 0 ||
    hasMeaningfulArtifact(partialResult.artifact)
  );
}

/** Provider エラーに文字列コードがあれば表記を揃え、それ以外は空文字列にする。 */
function normalizeProviderErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim().toLowerCase() : "";
}

/** スレッドや Session の失効・不存在・非互換を示すエラーに絞って分類する。実際の再実行は指示しない。 */
export function isRetryableStaleThreadSessionError(error: unknown): boolean {
  const code = normalizeProviderErrorCode(error);
  if (
    code === "thread_not_found" ||
    code === "session_not_found" ||
    code === "thread_expired" ||
    code === "session_expired" ||
    code === "invalid_thread" ||
    code === "invalid_session" ||
    code === "invalid-thread" ||
    code === "invalid-session"
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.trim().toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  return (
    /\bsessionnotfound\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\bnot found\b/.test(normalizedMessage) ||
    /\bnot found\b.*\b(thread|session)\b/.test(normalizedMessage) ||
    /\b(thread|session)[-_]not[-_]found\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\bexpired\b/.test(normalizedMessage) ||
    /\bexpired\b.*\b(thread|session)\b/.test(normalizedMessage) ||
    /\binvalid[-\s]+(thread|session)\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\binvalid\b/.test(normalizedMessage) ||
    /\binvalid[-\s]*thread\b/.test(normalizedMessage) ||
    /\b(thread|session)\b.*\bmodel\b.*\bincompatible\b/.test(
      normalizedMessage,
    ) ||
    /\bmodel\b.*\b(thread|session)\b.*\bincompatible\b/.test(normalizedMessage)
  );
}

/** 取消でも実質的な途中出力がある失敗でもなく、失効と対象 ID を確認できた場合だけリセット候補にする。 */
function shouldResetFailedSessionThread(
  error: unknown,
  currentThreadId: string,
  partialResult: RunSessionTurnResult | null | undefined,
  canceled: boolean,
): boolean {
  if (
    canceled ||
    hasMeaningfulPartialRunResult(partialResult) ||
    !isRetryableStaleThreadSessionError(error)
  ) {
    return false;
  }

  const candidateThreadId = pickPreferredThreadId(
    partialResult?.threadId,
    currentThreadId,
  );
  return candidateThreadId.length > 0;
}

/** 利用枠エラーの再試行可能時刻を、Provider の案内文から文字列のまま抜き出す。 */
function extractProviderUsageLimitRetryAt(message: string): string | null {
  const match = /\btry again at\s+(.+?)(?:\.|$)/i.exec(message);
  return match?.[1]?.trim() || null;
}

/** 利用枠超過の表示には再試行可能時刻を優先し、なければエラーの詳細を添える。 */
function formatProviderUsageLimitMessage(
  providerId: Session["provider"],
  message: string,
): string {
  const providerLabel = providerId === "codex" ? "Codex" : "Provider";
  const retryAt = extractProviderUsageLimitRetryAt(message);
  if (retryAt) {
    return `${providerLabel} usage limit reached.\nTry again at: ${retryAt}`;
  }

  const preview = toProviderTextPreview(message) ?? message;
  return `${providerLabel} usage limit reached.\nDetails: ${preview}`;
}

/** 終端表示は取消を最優先とし、利用枠超過だけを整形して他の失敗理由をそのまま残す。 */
function formatProviderFailureMessage(params: {
  providerId: Session["provider"];
  reason: ProviderTurnError["reason"] | null;
  message: string;
  canceled: boolean;
}): string {
  if (params.canceled) {
    return "Canceled by the user.";
  }

  if (params.reason === "usage_limit") {
    return formatProviderUsageLimitMessage(params.providerId, params.message);
  }

  return params.message;
}

/** 優先順位どおりに候補を調べ、空白だけではない最初のスレッド ID を採用する。 */
function pickPreferredThreadId(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const normalized = candidate?.trim() ?? "";
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return "";
}

/** Session とスレッドの識別情報だけを引き継ぎ、新しい Turn 用に応答と要求を初期化する。 */
function buildEmptyLiveSessionRunState(
  sessionId: string,
  threadId: string,
): LiveSessionRunState {
  return {
    sessionId,
    threadId,
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

/** 追加済みのユーザー入力位置と、その Turn に固定する実行設定から開始レコードを組み立てる。 */
function buildRunningTurn(params: {
  sessionId: string;
  createdAt: string;
  session: Pick<Session, "provider" | "threadId" | "messages" | "messageCount">;
  executionOptions: SessionExecutionOptions;
}): SessionTurnInput {
  return {
    sessionId: params.sessionId,
    createdAt: params.createdAt,
    phase: "running",
    provider: params.session.provider,
    model: params.executionOptions.model,
    reasoningEffort: params.executionOptions.reasoningEffort,
    approvalMode: params.executionOptions.approvalMode,
    sandboxMode: params.executionOptions.codexSandboxMode,
    userMessageSeq: Math.max(
      0,
      (params.session.messageCount ?? params.session.messages.length) - 1,
    ),
    threadId: params.session.threadId,
    errorMessage: "",
  };
}

/** キューから捕捉した入力と、開始確定の通知・呼出元へ返す処理結果を Turn 内で共有する。 */
type QueuedTurnContext = {
  receipt: SessionTurnQueueReceipt;
  input: SessionTurnQueueCapturedInput;
  onStarted: (input: {
    turnId: string;
    userMessageSeq: number;
  }) => Promise<void>;
  startIssued?: boolean;
  outcome?: SessionTurnQueueDispatchResult;
};

/** 受付時からの本文・添付の変更有無と、再実行や連携の来歴を Provider 用の入力情報にまとめる。 */
function queuedInputProvenance(
  receipt: SessionTurnQueueReceipt,
  input: SessionTurnQueueCapturedInput,
): NonNullable<RunSessionTurnInput["inputProvenance"]> {
  return {
    origin: input.origin ?? null,
    originalChanged: receipt.accepted
      ? !isDeepStrictEqual(
          {
            text: receipt.accepted.request.userMessage,
            attachments: receipt.accepted.attachments,
          },
          { text: input.request.userMessage, attachments: input.attachments },
        )
      : null,
    ...(input.retrySource ? { retrySource: input.retrySource } : {}),
    ...(input.coordination
      ? {
          coordinationOperation: input.coordination.operation,
          coordination: readCoordinationNotification(input) ?? undefined,
        }
      : {}),
  };
}

/** キュー入力を永続的に開始する前に確定できた前提条件違反。 */
class QueuedTurnPreflightError extends Error {}

/** 開始処理を発行する前に確定し、実行結果が不明な取消と区別できるキューの取消。 */
class QueuedTurnPreStartCanceledError extends Error {
  override name = "AbortError";
}

/** 親からの Steer で、送信元・対象 Turn・送信境界を越えたかどうかを保持する。 */
type ParentSessionInput = {
  origin: SessionSteerOrigin;
  turnId: string;
  /** 対象が現在も同じ子 Session と Turn であることを送信直前にも照合する。 */
  assertCurrent(): void;
  dispatched: boolean;
  messageSeq: number | null;
};

/** ウィンドウの停止要求を、対象としたキューの受付記録または実行中の Turn に振り分ける。 */
export async function stopWindowSessionRun(
  request: CancelSessionRunRequest,
  runtime: Pick<SessionRuntimeService, "stopSessionTurn">,
  queue: Pick<SessionTurnQueueService, "stopClaim">,
  assertAuthorized: () => void,
  onApply: () => void,
): Promise<void> {
  const { sessionId, incarnationId, execution } = request;
  if (execution.kind === "receipt") {
    assertAuthorized();
    await queue.stopClaim({ sessionId, incarnationId }, execution.id, onApply);
  } else {
    await runtime.stopSessionTurn(
      sessionId,
      incarnationId,
      execution.id,
      assertAuthorized,
      onApply,
    );
  }
}

/** Session ごとに Turn の受付・Provider 実行・途中入力・終端保存を管理し、実終了まで次の開始を保護する。 */
export class SessionRuntimeService {
  private readonly inFlightSessionRuns = new Set<string>();
  private readonly startingSessionRuns = new Set<string>();
  private readonly terminatingSessionRuns = new Map<
    string,
    Set<Promise<unknown>>
  >();
  private readonly unreleasedTurnIds = new Map<string, string>();
  private readonly waitingSessionRunAdmissions = new Set<string>();
  private readonly pendingSessionRunCancels = new Set<string>();
  private readonly sessionRunControllers = new Map<string, AbortController>();
  private readonly pendingSessionInputs = new Map<
    string,
    Promise<SteerSessionTurnResult>
  >();
  private readonly dispatchedSessionInputs = new Set<string>();
  private readonly finishingSessionTurns = new Set<string>();
  private readonly appendSessionInput = new Map<
    string,
    (
      text: string,
      queued?: SessionTurnQueueReceipt,
      inputTurnId?: string,
      replyTo?: SessionReply,
    ) => Promise<void>
  >();
  private readonly directSessionInput = new Map<
    string,
    {
      /** 直接入力を送達待ちで保存し、確定時に使うメッセージ番号を返す。 */
      begin(
        text: string,
        nativeTurnId: string,
        attachments: ComposerAttachment[],
        origin?: SessionSteerOrigin,
        questionRequestId?: string,
        replyTo?: SessionReply,
      ): Promise<number>;
      /** 同じ入力レコードの送達結果を確定する。 */
      settle(
        messageSeq: number,
        state: Exclude<TurnInputDeliveryState, "pending">,
      ): Promise<void>;
    }
  >();
  private readonly pendingRuns = new Set<Promise<Session>>();

  /** 永続化や Provider の処理を注入し、Session ごとの実行追跡を空の状態で始める。 */
  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  /** 実行枠をまだ解放していない保存済み Turn の ID を返す。 */
  getUnreleasedTurnIds(): string[] {
    return [...this.unreleasedTurnIds.values()];
  }

  /** いずれかの Session に開始待ち・途中入力・終端処理・後片付けを含む処理が残っていれば true を返す。 */
  hasInFlightRuns(): boolean {
    return (
      this.inFlightSessionRuns.size > 0 ||
      this.startingSessionRuns.size > 0 ||
      this.terminatingSessionRuns.size > 0 ||
      this.waitingSessionRunAdmissions.size > 0 ||
      this.pendingSessionInputs.size > 0 ||
      this.finishingSessionTurns.size > 0
    );
  }

  /** 指定 Session に開始待ち・途中入力・終端処理・後片付けを含む未解放の処理があるかを返す。 */
  isRunInFlight(sessionId: string): boolean {
    return (
      this.inFlightSessionRuns.has(sessionId) ||
      this.startingSessionRuns.has(sessionId) ||
      this.terminatingSessionRuns.has(sessionId) ||
      this.waitingSessionRunAdmissions.has(sessionId) ||
      this.pendingSessionInputs.has(sessionId) ||
      this.finishingSessionTurns.has(sessionId)
    );
  }

  /** 閉じる操作が後続実行へ作用しないよう、現在処理中の実行を識別するオブジェクトを返す。 */
  getCloseRunIdentity(sessionId: string): object | null {
    if (!this.isRunInFlight(sessionId)) return null;
    const identity =
      this.sessionRunControllers.get(sessionId) ??
      this.terminatingSessionRuns.get(sessionId) ??
      this.pendingSessionInputs.get(sessionId);
    if (!identity) throw new Error("Session run identity is unavailable.");
    return identity;
  }

  /** 単なる取消要求と、待機を打ち切った後も終了処理が残る状態を区別する。 */
  private cancellationState(
    sessionId: string,
  ): LiveSessionRunState["cancellationState"] {
    if (this.terminatingSessionRuns.has(sessionId)) {
      return "terminating";
    }
    return this.sessionRunControllers.get(sessionId)?.signal.aborted ||
      this.pendingSessionRunCancels.has(sessionId)
      ? "requested"
      : undefined;
  }

  /** Provider の投影にランタイムの実行状態を重ね、取消や終端処理の間は追加入力を閉じる。 */
  private setRuntimeLiveState(
    sessionId: string,
    state: LiveSessionRunState | null,
  ): void {
    const cancellationState = this.cancellationState(sessionId);
    const nextState = state
      ? {
          ...state,
          runState:
            state.runState ??
            (this.inFlightSessionRuns.has(sessionId) ? "running" : "idle"),
          ...(this.finishingSessionTurns.has(sessionId)
            ? { inputAvailable: false }
            : {}),
        }
      : null;
    this.deps.setLiveSessionRun(
      sessionId,
      cancellationState
        ? {
            ...(nextState ??
              buildEmptyLiveSessionRunState(
                sessionId,
                this.deps.getLiveSessionRun(sessionId)?.threadId ?? "",
              )),
            inputAvailable: false,
            cancellationState,
          }
        : nextState,
    );
  }

  /** 関連処理がなくなった時点で Turn ID と取消表示を解放し、残すべきライブ情報だけを保持する。 */
  private releaseCancellationState(sessionId: string): void {
    if (
      this.isRunInFlight(sessionId) ||
      this.waitingSessionRunAdmissions.has(sessionId)
    ) {
      return;
    }
    this.unreleasedTurnIds.delete(sessionId);
    const liveState = this.deps.getLiveSessionRun(sessionId);
    if (liveState?.cancellationState) {
      const { cancellationState: _cancellationState, ...rest } = liveState;
      this.deps.setLiveSessionRun(
        sessionId,
        rest.backgroundTasks.length > 0 ||
          (rest.reasoningText ?? "").trim().length > 0
          ? rest
          : null,
      );
      this.deps.broadcastLiveSessionRun(sessionId);
    }
    try {
      this.deps.onSessionRunReleased?.(sessionId);
    } catch {
      /* 解放の監視側は、実行や永続化を制御しない。 */
    }
  }

  /** 呼出元への応答とは別に未終了の処理を追跡し、実際に完了するまで同じ Session の再送を防ぐ。 */
  private trackTerminatingSessionRun(
    sessionId: string,
    promise: Promise<unknown>,
  ): void {
    const trackedPromises =
      this.terminatingSessionRuns.get(sessionId) ?? new Set<Promise<unknown>>();
    if (trackedPromises.has(promise)) {
      return;
    }
    trackedPromises.add(promise);
    this.terminatingSessionRuns.set(sessionId, trackedPromises);
    this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
    this.deps.broadcastLiveSessionRun(sessionId);
    /** 成否を問わず完了した処理だけを除去し、他の追跡対象がなければ取消表示の解放を試みる。 */
    const release = () => {
      trackedPromises.delete(promise);
      if (trackedPromises.size === 0) {
        this.terminatingSessionRuns.delete(sessionId);
      }
      if (
        !this.startingSessionRuns.has(sessionId) &&
        !this.inFlightSessionRuns.has(sessionId) &&
        !this.terminatingSessionRuns.has(sessionId)
      ) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
      }
      this.releaseCancellationState(sessionId);
    };
    promise.then(release, release);
  }

  /** 進行中の要求を拒否・取消にして実行を中断し、現在の開始・実行・受付待ち登録を取り下げる。 */
  reset(): void {
    for (const sessionId of new Set([
      ...this.startingSessionRuns,
      ...this.inFlightSessionRuns,
    ])) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, {
        action: "cancel",
      });
      this.sessionRunControllers.get(sessionId)?.abort();
      this.pendingSessionRunCancels.add(sessionId);
    }
    this.startingSessionRuns.clear();
    this.inFlightSessionRuns.clear();
    for (const sessionId of this.waitingSessionRunAdmissions) {
      this.pendingSessionRunCancels.add(sessionId);
    }
    this.waitingSessionRunAdmissions.clear();
    this.sessionRunControllers.clear();
  }

  /** Session の現在の実行、または受付待ちの開始に対して取消を要求する。 */
  cancelRun(sessionId: string): void {
    this.requestRunCancel(sessionId, this.sessionRunControllers.get(sessionId));
  }

  /** 取消の重複を避けながら承認と質問の待機を解除し、停止シグナルか受付待ちの取消を記録する。 */
  private requestRunCancel(
    sessionId: string,
    controller: AbortController | undefined,
  ): void {
    if (this.pendingSessionRunCancels.has(sessionId)) {
      return;
    }
    if (controller?.signal.aborted) {
      this.pendingSessionRunCancels.add(sessionId);
      return;
    }
    this.deps.resolvePendingApprovalRequest(sessionId, "deny");
    this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
    if (!controller) {
      if (this.waitingSessionRunAdmissions.has(sessionId)) {
        this.pendingSessionRunCancels.add(sessionId);
        this.setRuntimeLiveState(
          sessionId,
          this.deps.getLiveSessionRun(sessionId),
        );
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      return;
    }

    this.pendingSessionRunCancels.add(sessionId);
    controller.abort();
    this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
    this.deps.broadcastLiveSessionRun(sessionId);
  }

  /** 照合済みのコントローラーが現在も有効で終端処理前の場合だけ、新たな停止を発行できる。 */
  private stopRunController(
    sessionId: string,
    controller: AbortController,
    onApply?: () => void,
  ): boolean {
    if (
      this.sessionRunControllers.get(sessionId) !== controller ||
      this.finishingSessionTurns.has(sessionId)
    )
      return false;
    if (!controller.signal.aborted) {
      onApply?.();
      this.requestRunCancel(sessionId, controller);
    }
    return true;
  }

  /** 認可後に Session の世代と保存済み Turn ID を照合し、捕捉した実行だけを停止対象にする。 */
  async stopSessionTurn(
    sessionId: string,
    incarnationId: string,
    expectedTurnId: string,
    assertAuthorized?: () => void | Promise<void>,
    onApply?: () => void,
  ): Promise<{ outcome: "applied" | "not-applied"; turnId: string }> {
    const controller = this.sessionRunControllers.get(sessionId);
    const session = await this.deps.getSession(sessionId);
    await assertAuthorized?.();
    const live = this.deps.getLiveSessionRun(sessionId);
    if (
      !expectedTurnId?.trim() ||
      !incarnationId?.trim() ||
      !session ||
      getSessionIncarnationId(session) !== incarnationId ||
      live?.sessionTurnId !== expectedTurnId ||
      !this.inFlightSessionRuns.has(sessionId) ||
      !controller ||
      !this.stopRunController(sessionId, controller, onApply)
    )
      return { outcome: "not-applied", turnId: expectedTurnId };
    return { outcome: "applied", turnId: expectedTurnId };
  }

  /** 実行中だけでなく、準備中・受付待ちの Session にも一度ずつ取消を要求する。 */
  cancelAllRuns(): void {
    const sessionIds = new Set([
      ...this.inFlightSessionRuns,
      ...this.startingSessionRuns,
      ...this.waitingSessionRunAdmissions,
    ]);
    for (const sessionId of sessionIds) {
      this.cancelRun(sessionId);
    }
  }

  /** 指定した native Turn の実行中に、通常の直接入力を送る。 */
  steerSessionTurn(
    sessionId: string,
    request: SteerSessionTurnRequest,
  ): Promise<SteerSessionTurnResult> {
    return this.sendSessionInput(sessionId, request);
  }

  /** 保存済みの親子関係と子 Turn を照合して入力を送り、送出後の失敗は結果不明として返す。 */
  async steerChildSessionTurn(
    target: SessionTurnQueueOwner,
    turnId: string,
    message: string,
    source: SessionTurnQueueOwner & { turnId: string },
    assertCurrent: () => void,
  ): Promise<SessionSteerResult> {
    let parent: ParentSessionInput | undefined;
    try {
      // ネイティブの対象をここで一度だけ取得する。非同期の準備後に、後続の Turn を取り直さない。
      const live = this.deps.getLiveSessionRun(target.sessionId);
      if (live?.sessionTurnId !== turnId || !live.turnId)
        throw new Error("The selected WithMate Turn is not running.");
      const nativeTurnId = live.turnId;
      const [sender, session] = await Promise.all([
        this.deps.getSession(source.sessionId),
        this.deps.getSession(target.sessionId),
      ]);
      assertCurrent();
      if (
        !sender ||
        getSessionIncarnationId(sender) !== source.incarnationId ||
        !session ||
        getSessionIncarnationId(session) !== target.incarnationId ||
        session.parentSessionId !== sender.id ||
        session.rootSessionId !== sender.rootSessionId
      )
        throw new Error("The saved parent or child identity changed.");
      parent = {
        turnId,
        assertCurrent,
        dispatched: false,
        messageSeq: null,
        origin: {
          kind: "session",
          operation: "steer",
          actorKind: "main",
          actorSessionId: sender.id,
          actorIncarnationId: source.incarnationId,
          actorTurnId: source.turnId,
          actorSnapshot: captureSessionTurnQueueDisplay(sender),
          targetSessionId: target.sessionId,
          targetIncarnationId: target.incarnationId,
          targetSnapshot: captureSessionTurnQueueDisplay(session),
        },
      };
      await this.sendSessionInput(
        target.sessionId,
        { expectedTurnId: nativeTurnId, userMessage: message },
        undefined,
        undefined,
        parent,
      );
      return { outcome: "applied", turnId, messageSeq: parent.messageSeq };
    } catch (error) {
      return {
        outcome: parent?.dispatched ? "unknown" : "not-applied",
        turnId,
        messageSeq: parent?.messageSeq ?? null,
        reason:
          error instanceof Error
            ? error.message
            : "The Steer result could not be confirmed.",
      };
    } finally {
      // ストレージの応答が失われても、pending または not-sent の入力がコミットされていることがある。
      // 操作を受付済みとして扱わず、該当する送信元の表示を無効化する。
      if (parent) {
        try {
          this.deps.onSentInputChanged?.(parent.origin);
        } catch {
          /* 通知によって入力の結果は変わらない。 */
        }
      }
    }
  }

  /** 実行中の質問への回答を直接入力として送り、履歴用の回答と Provider に送る本文を分ける。 */
  answerSessionQuestion(
    sessionId: string,
    turnId: string,
    message: string,
    answer: string,
    requestId?: string,
  ): Promise<SteerSessionTurnResult> {
    return this.sendSessionInput(
      sessionId,
      { expectedTurnId: turnId, userMessage: answer },
      undefined,
      message,
      undefined,
      requestId,
    );
  }

  /** 送出時点の入力スナップショットを確定済みのキューだけを、指定の native Turn へ渡す。 */
  steerQueuedSessionTurn(
    receipt: SessionTurnQueueReceipt,
    expectedTurnId: string,
  ): Promise<SteerSessionTurnResult> {
    if (!receipt.dispatched)
      return Promise.reject(
        new Error("The queued input does not have a fixed dispatch snapshot."),
      );
    return this.sendSessionInput(
      receipt.sessionId,
      { expectedTurnId, userMessage: receipt.dispatched.request.userMessage },
      receipt,
    );
  }

  /** 連携入力の宛先が同じ世代・種別の Codex Session で、追加入力を受付中なら native Turn ID を返す。 */
  async getCoordinationInputTurnId(
    receipt: SessionTurnQueueReceipt,
  ): Promise<string | null> {
    const live = this.deps.getLiveSessionRun(receipt.sessionId);
    const session = await this.deps.getSession(receipt.sessionId);
    const kind = (await this.deps.isAuxiliarySession?.(receipt.sessionId))
      ? "auxiliary"
      : "main";
    if (
      !session ||
      getSessionIncarnationId(session) !== receipt.incarnationId ||
      session.provider !== "codex" ||
      receipt.captured.coordination?.targetKind !== kind ||
      !live?.turnId ||
      !this.canAcceptSessionInput(receipt.sessionId, live.turnId)
    )
      return null;
    return live.turnId;
  }

  /** Steer を Session ごとに一件ずつ送り、直接入力は送信前に保存してから送達結果を確定する。 */
  private sendSessionInput(
    sessionId: string,
    request: SteerSessionTurnRequest,
    queued?: SessionTurnQueueReceipt,
    providerMessage?: string,
    parent?: ParentSessionInput,
    questionRequestId?: string,
  ): Promise<SteerSessionTurnResult> {
    /** キューでは Provider へ送出していない前提条件エラーを、結果不明の失敗と区別する。 */
    const preflightError = (message: string) =>
      queued ? new QueuedInputPreDispatchError(message) : new Error(message);
    if (
      !request ||
      typeof request.expectedTurnId !== "string" ||
      !request.expectedTurnId.trim() ||
      typeof request.userMessage !== "string" ||
      !request.userMessage.trim()
    ) {
      return Promise.reject(
        preflightError("The active turn and a message are required."),
      );
    }
    if (this.pendingSessionInputs.has(sessionId))
      return Promise.reject(
        preflightError("Session input is already being sent."),
      );
    const runController = this.sessionRunControllers.get(sessionId);
    const appendInput = this.appendSessionInput.get(sessionId);
    /** 非同期の準備を挟んでも、捕捉した実行が入れ替わらず、取消前かつ入力受付中であることを確認する。 */
    const assertActiveTurn = () => {
      parent?.assertCurrent();
      const live = this.deps.getLiveSessionRun(sessionId);
      if (
        !this.inFlightSessionRuns.has(sessionId) ||
        !appendInput ||
        this.appendSessionInput.get(sessionId) !== appendInput ||
        !runController ||
        this.sessionRunControllers.get(sessionId) !== runController ||
        this.sessionRunControllers.get(sessionId)?.signal.aborted ||
        this.terminatingSessionRuns.has(sessionId) ||
        this.finishingSessionTurns.has(sessionId) ||
        live?.cancellationState ||
        live?.turnId !== request.expectedTurnId ||
        live.inputAvailable !== true ||
        (parent && live.sessionTurnId !== parent.turnId)
      ) {
        throw preflightError(
          "The selected turn no longer accepts input. Your draft is preserved.",
        );
      }
    };
    let dispatched = false;
    // 同期的に動く依存処理も含め、準備を始める前に入力を登録する。
    const operation = Promise.resolve()
      .then(async () => {
        const reference = queued
          ? queued.dispatched?.request.replyTo
          : request.replyTo;
        const replyTo =
          reference === undefined
            ? undefined
            : sessionReplySchema.parse(reference);
        const isAuxiliary =
          replyTo && (await this.deps.isAuxiliarySession?.(sessionId));
        if (replyTo && !queued) await this.deps.assertSavedReplyTo?.(replyTo);
        assertActiveTurn();
        const session = await this.deps.getSession(sessionId);
        if (
          !session ||
          session.provider !== "codex" ||
          isReadOnlySession(session)
        )
          throw new Error("This session cannot accept input.");
        if (
          parent &&
          (getSessionIncarnationId(session) !==
            parent.origin.targetIncarnationId ||
            session.parentSessionId !== parent.origin.actorSessionId)
        ) {
          throw new Error("The child Session identity or parent changed.");
        }
        if (
          queued &&
          (getSessionIncarnationId(session) !== queued.incarnationId ||
            session.provider !== queued.dispatched!.provider ||
            session.workspacePath !== queued.dispatched!.workspacePath ||
            queued.inputTurnId !== request.expectedTurnId ||
            queued.turnId !==
              this.deps.getLiveSessionRun(sessionId)?.sessionTurnId)
        ) {
          throw new Error(
            "The queued Session owner or execution target changed.",
          );
        }
        const adapter = this.deps.getProviderCodingAdapter(session.provider);
        if (!adapter.steerSessionTurn)
          throw new Error("This provider cannot accept input during a turn.");
        const providerSession = await (this.deps.resolveProviderSession?.(
          session,
        ) ?? session);
        let preview: ComposerPreview;
        if (queued) {
          if (!this.deps.assertCapturedComposerAttachmentsAvailable)
            throw new Error("Captured attachment validation is unavailable.");
          await this.deps.assertCapturedComposerAttachmentsAvailable(
            providerSession,
            queued.dispatched!.attachments,
          );
          preview = { attachments: queued.dispatched!.attachments, errors: [] };
        } else {
          preview = await this.deps.resolveComposerPreview(
            providerSession,
            request.userMessage,
          );
        }
        if (preview.errors.length) throw new Error(preview.errors[0]);
        if (
          queued &&
          !getProviderAppSettings(
            await this.deps.getAppSettings(),
            session.provider,
          ).enabled
        ) {
          throw new Error("This provider is disabled in Settings.");
        }
        assertActiveTurn();
        const direct = queued
          ? undefined
          : this.directSessionInput.get(sessionId);
        if (!queued && !direct)
          throw new Error("Durable Session input storage is unavailable.");
        this.dispatchedSessionInputs.add(sessionId);
        let inputSeq: number | undefined;
        try {
          if (direct)
            inputSeq = await direct.begin(
              request.userMessage.trim(),
              request.expectedTurnId,
              preview.attachments,
              parent?.origin,
              questionRequestId,
              replyTo,
            );
          if (parent) parent.messageSeq = inputSeq ?? null;
          if (parent) {
            try {
              this.deps.onSentInputChanged?.(parent.origin);
            } catch {
              /* 通知がプロバイダーへの送出を妨げてはならない。 */
            }
          }
          assertActiveTurn();
          dispatched = true;
          if (parent) parent.dispatched = true;
          const inputText =
            providerMessage ??
            (queued ? request.userMessage : request.userMessage.trim());
          const provenance = queued
            ? queuedInputProvenance(queued, queued.dispatched!)
            : parent
              ? { origin: parent.origin, originalChanged: false }
              : undefined;
          const messageIdentity =
            replyTo && inputSeq !== undefined && !isAuxiliary
              ? {
                  sessionId,
                  incarnationId: getSessionIncarnationId(session),
                  seq: inputSeq,
                }
              : undefined;
          // Coordination は実行中の同じ Turn に配信する。キューの受付時にはその Turn のスレッドを記録するが、
          // 新しい保存済みメッセージの識別情報はまだない。
          const mainConversationFrame =
            queued?.dispatched?.coordination?.operation === "answer"
              ? queued.dispatched.request.mainConversationFrame
              : undefined;
          const result = await adapter.steerSessionTurn({
            sessionId,
            expectedTurnId: request.expectedTurnId,
            userMessage:
              provenance || replyTo
                ? composeProviderInput(inputText, provenance, !!queued, {
                    replyTo,
                    messageIdentity,
                    mainConversationFrame,
                  })
                : inputText,
            attachments: preview.attachments,
          });
          if (result.turnId !== request.expectedTurnId)
            throw new Error(
              "The provider did not confirm input for the selected turn.",
            );
          if (
            !appendInput ||
            this.appendSessionInput.get(sessionId) !== appendInput
          )
            throw new Error(
              "The selected turn ended before input could be saved.",
            );
          if (direct && inputSeq !== undefined)
            await direct.settle(inputSeq, "confirmed");
          else
            await appendInput(
              queued ? request.userMessage : request.userMessage.trim(),
              queued,
              request.expectedTurnId,
              replyTo,
            );
          return result;
        } catch (error) {
          if (direct && inputSeq !== undefined)
            await direct.settle(inputSeq, dispatched ? "unknown" : "not-sent");
          throw error;
        } finally {
          this.dispatchedSessionInputs.delete(sessionId);
        }
      })
      .catch((error: unknown) => {
        if (
          queued &&
          !dispatched &&
          !(error instanceof QueuedInputPreDispatchError)
        ) {
          throw new QueuedInputPreDispatchError(
            error instanceof Error
              ? error.message
              : "Session input preparation failed.",
          );
        }
        throw error;
      });
    this.pendingSessionInputs.set(sessionId, operation);
    /** この送信の待機登録だけを取り除き、取消状態が残っていれば解放できるか確認する。 */
    const release = () => {
      if (this.pendingSessionInputs.get(sessionId) === operation)
        this.pendingSessionInputs.delete(sessionId);
      this.releaseCancellationState(sessionId);
    };
    void operation.then(release, release);
    return operation;
  }

  /** ライブ状態と入力の保存経路を確認し、指定があれば native Turn ID が一致する場合だけ受付可能とする。 */
  canAcceptSessionInput(sessionId: string, expectedTurnId?: string): boolean {
    const live = this.deps.getLiveSessionRun(sessionId);
    return (
      this.inFlightSessionRuns.has(sessionId) &&
      this.appendSessionInput.has(sessionId) &&
      !this.sessionRunControllers.get(sessionId)?.signal.aborted &&
      !this.terminatingSessionRuns.has(sessionId) &&
      !this.finishingSessionTurns.has(sessionId) &&
      !live?.cancellationState &&
      live?.inputAvailable === true &&
      Boolean(live.turnId) &&
      (expectedTurnId === undefined || live.turnId === expectedTurnId)
    );
  }

  /** 直接送信の新規 Turn を開始し、終端までの処理を終了待機の対象として登録する。 */
  runSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest,
  ): Promise<Session> {
    return this.trackRun(this.executeSessionTurn(sessionId, request));
  }

  /** キューの固定入力で実行し、開始前に確定した取消・拒否と、永続化済みの終端結果を返す。結果不明は例外で伝える。 */
  async runQueuedSessionTurn(
    receipt: SessionTurnQueueReceipt,
    onStarted: QueuedTurnContext["onStarted"],
    control?: SessionTurnQueueDispatchControl,
  ): Promise<SessionTurnQueueDispatchResult> {
    if (!receipt.dispatched)
      throw new Error(
        "The queued turn does not have a fixed dispatch snapshot.",
      );
    const queued: QueuedTurnContext = {
      receipt,
      input: receipt.dispatched,
      onStarted,
    };
    const controller = new AbortController();
    if (
      control &&
      !control.bindCancel((onApply) =>
        this.stopRunController(receipt.sessionId, controller, onApply),
      )
    ) {
      return { state: "canceled", reason: "Session setup was canceled" };
    }
    try {
      await this.trackRun(
        this.executeSessionTurn(
          receipt.sessionId,
          queued.input.request,
          queued,
          controller,
        ),
      );
    } catch (error) {
      if (queued.outcome) return queued.outcome;
      if (
        error instanceof QueuedTurnPreStartCanceledError &&
        !this.isRunInFlight(receipt.sessionId)
      ) {
        return { state: "canceled", reason: error.message };
      }
      if (error instanceof QueuedTurnPreflightError)
        return { state: "failed", reason: error.message };
      throw error;
    }
    if (!queued.outcome)
      throw new Error("The queued turn terminal commit was not confirmed.");
    return queued.outcome;
  }

  /** Turn・途中入力・切り離した後片付けを、失敗も含めて追跡対象が空になるまで待つ。 */
  async waitForPendingRuns(): Promise<void> {
    while (
      this.pendingRuns.size ||
      this.terminatingSessionRuns.size ||
      this.pendingSessionInputs.size
    ) {
      await Promise.allSettled([
        ...this.pendingRuns,
        ...[...this.terminatingSessionRuns.values()].flatMap((values) => [
          ...values,
        ]),
        ...this.pendingSessionInputs.values(),
      ]);
    }
  }

  /** 終了を待つ対象に Turn を加え、成否が確定したら登録を外す。呼出元には元の Promise を返す。 */
  private trackRun(run: Promise<Session>): Promise<Session> {
    this.pendingRuns.add(run);
    void run.then(
      () => this.pendingRuns.delete(run),
      () => this.pendingRuns.delete(run),
    );
    return run;
  }

  /** 実行枠を排他的に確保し、受付と準備の取消期限を管理して Turn 本体を起動する。 */
  private async executeSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest,
    queued?: QueuedTurnContext,
    runAbortController = new AbortController(),
  ): Promise<Session> {
    const { clientRequestId, submitSource } =
      normalizeSessionTurnCorrelation(request);
    if (
      this.isRunInFlight(sessionId) ||
      this.waitingSessionRunAdmissions.has(sessionId)
    ) {
      logSessionRunStuckInvestigation("runtime.admission.rejected", {
        sessionId,
        clientRequestId,
        guard: "runtime-in-flight",
        starting: this.startingSessionRuns.has(sessionId),
        running: this.inFlightSessionRuns.has(sessionId),
        terminating: this.terminatingSessionRuns.has(sessionId),
        waitingAdmission: this.waitingSessionRunAdmissions.has(sessionId),
        cancellationState: this.cancellationState(sessionId),
      });
      throw new Error("This session is already running.");
    }
    let admitted = false;
    this.waitingSessionRunAdmissions.add(sessionId);
    this.sessionRunControllers.set(sessionId, runAbortController);
    /** 排他区間で競合を再確認し、受付待ちを準備中へ移す。待機中に届いた取消はここで引き継ぐ。 */
    const admit = () => {
      this.waitingSessionRunAdmissions.delete(sessionId);
      if (this.isRunInFlight(sessionId)) {
        logSessionRunStuckInvestigation("runtime.admission.rejected", {
          sessionId,
          clientRequestId,
          guard: "admission-recheck",
        });
        throw new Error("This session is already running.");
      }
      this.startingSessionRuns.add(sessionId);
      this.finishingSessionTurns.delete(sessionId);
      this.sessionRunControllers.set(sessionId, runAbortController);
      admitted = true;
      if (this.pendingSessionRunCancels.delete(sessionId)) {
        runAbortController.abort();
      }
    };
    const admissionPromise = (async () => {
      try {
        if (this.deps.runSessionAdmissionExclusive) {
          await this.deps.runSessionAdmissionExclusive(
            sessionId,
            admit,
            runAbortController.signal,
          );
        } else {
          admit();
        }
        throwIfRunCanceled(runAbortController.signal, queued);
      } catch (error) {
        this.waitingSessionRunAdmissions.delete(sessionId);
        if (!admitted) {
          this.pendingSessionRunCancels.delete(sessionId);
        }
        if (admitted) {
          this.startingSessionRuns.delete(sessionId);
          if (
            this.sessionRunControllers.get(sessionId) === runAbortController &&
            !this.terminatingSessionRuns.has(sessionId)
          ) {
            this.sessionRunControllers.delete(sessionId);
          }
          this.pendingSessionRunCancels.delete(sessionId);
        }
        if (
          this.sessionRunControllers.get(sessionId) === runAbortController &&
          !this.terminatingSessionRuns.has(sessionId)
        ) {
          this.sessionRunControllers.delete(sessionId);
        }
        this.releaseCancellationState(sessionId);
        throw error;
      }
    })();
    try {
      await waitForSetupWithCancelDeadline(
        admissionPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () =>
          this.waitingSessionRunAdmissions.has(sessionId) ||
          this.startingSessionRuns.has(sessionId),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
      );
    } catch (error) {
      this.releaseCancellationState(sessionId);
      throw error;
    }
    logSessionRunStuckInvestigation("runtime.requested", {
      sessionId,
      clientRequestId,
      submitSource,
      isRunInFlight: false,
    });
    const setupPromise = this.runSessionTurnInternal(
      sessionId,
      request,
      runAbortController,
      queued,
    );
    try {
      return await waitForSetupWithCancelDeadline(
        setupPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () => this.startingSessionRuns.has(sessionId),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
      );
    } finally {
      this.startingSessionRuns.delete(sessionId);
      if (
        !this.inFlightSessionRuns.has(sessionId) &&
        !this.terminatingSessionRuns.has(sessionId)
      ) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
      }
      this.releaseCancellationState(sessionId);
    }
  }

  /** 送信時の条件を確定して開始を保存し、Provider の応答または失敗を一度だけ終端として保存する。 */
  private async runSessionTurnInternal(
    sessionId: string,
    request: RunSessionTurnRequest,
    runAbortController: AbortController,
    queued?: QueuedTurnContext,
  ): Promise<Session> {
    const { clientRequestId, submitSource } =
      normalizeSessionTurnCorrelation(request);
    const observedAt = (this.deps.currentDate ?? (() => new Date()))();
    const investigationStartedAt = Date.now();
    const storedSession = await this.deps.getSession(sessionId);
    throwIfRunCanceled(runAbortController.signal, queued);
    if (!storedSession) {
      if (queued)
        throw new QueuedTurnPreflightError("The session could not be found.");
      throw new Error("The session could not be found.");
    }
    /** キューに捕捉した Session の世代・Provider・作業場所が、現在も一致することを確認する。 */
    const assertCapturedOwner = (current: Session) => {
      if (
        queued &&
        (getSessionIncarnationId(current) !== queued.receipt.incarnationId ||
          current.provider !== queued.input.provider ||
          current.workspacePath !== queued.input.workspacePath)
      ) {
        throw new QueuedTurnPreflightError(
          "The queued Session owner or execution target changed.",
        );
      }
    };
    assertCapturedOwner(storedSession);
    // 非同期のプロバイダー準備や Turn 中の編集より前に、指示を一度だけ取得する。
    const sessionInstructions =
      (await this.deps.readSessionInstructions?.(storedSession)) ?? "";
    const resolvedSession = await Promise.resolve(
      this.deps.resolveRuntimeSessionForTurn?.(storedSession) ?? storedSession,
    );
    const shouldResetCharacterAuthoringThread =
      storedSession.sessionKind === "character-authoring" &&
      storedSession.characterRuntimeSnapshot !== null &&
      resolvedSession.characterRuntimeSnapshot === null;
    let session = shouldResetCharacterAuthoringThread
      ? { ...resolvedSession, threadId: "" }
      : resolvedSession;
    assertCapturedOwner(session);
    if (shouldResetCharacterAuthoringThread) {
      if (!this.deps.clearCharacterAuthoringRuntimeState) {
        throw new Error("Character authoring runtime storage is unavailable.");
      }
      session = await this.deps.clearCharacterAuthoringRuntimeState(session);
      await this.deps.invalidateProviderSessionThread(
        storedSession.provider,
        storedSession.id,
      );
    }
    throwIfRunCanceled(runAbortController.signal, queued);
    logSessionRunStuckInvestigation("runtime.start", {
      sessionId,
      clientRequestId,
      provider: session.provider,
      runState: session.runState,
      status: session.status,
      messageCount: session.messageCount ?? session.messages.length,
      hasThreadId: session.threadId.trim().length > 0,
    });

    if (session.runState === "running") {
      logSessionRunStuckInvestigation("runtime.admission.rejected", {
        sessionId,
        clientRequestId,
        guard: "stored-run-state",
      });
      throw new Error("This session is already running.");
    }

    if (isReadOnlySession(session)) {
      if (queued)
        throw new QueuedTurnPreflightError(
          "Read-only sessions cannot send messages. Create a new session.",
        );
      throw new Error(
        "Read-only sessions cannot send messages. Create a new session.",
      );
    }

    const nextMessage = request.userMessage.trim();
    const replyTo =
      request.replyTo === undefined
        ? undefined
        : sessionReplySchema.parse(request.replyTo);
    if (!queued && replyTo) await this.deps.assertSavedReplyTo?.(replyTo);
    if (!nextMessage) {
      throw new Error("Enter a message before sending.");
    }

    const providerSession = await (this.deps.resolveProviderSession?.(
      session,
    ) ?? session);
    const capturedAdditionalDirectories = [
      ...providerSession.allowedAdditionalDirectories,
    ];
    const capturedCrewFolderPath = await this.deps.resolveCrewFolderPath?.(
      session.id,
    );
    let composerPreview: ComposerPreview;
    if (queued) {
      if (
        !this.deps.persistQueuedTurnStart ||
        !this.deps.assertCapturedComposerAttachmentsAvailable
      ) {
        throw new Error(
          "Queued turn persistence or attachment validation is unavailable.",
        );
      }
      try {
        await this.deps.assertCapturedComposerAttachmentsAvailable(
          providerSession,
          queued.input.attachments,
        );
      } catch (error) {
        throw new QueuedTurnPreflightError(
          error instanceof Error
            ? error.message
            : "The captured attachment is unavailable.",
        );
      }
      composerPreview = { attachments: queued.input.attachments, errors: [] };
    } else {
      composerPreview = await this.deps.resolveComposerPreview(
        providerSession,
        request.userMessage,
      );
    }
    throwIfRunCanceled(runAbortController.signal, queued);
    if (composerPreview.errors.length > 0) {
      throw new Error(
        composerPreview.errors[0] ?? "Failed to resolve attachment.",
      );
    }

    const appSettings = await this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      if (queued)
        throw new QueuedTurnPreflightError(
          "This provider is disabled in Settings.",
        );
      throw new Error("This provider is disabled in Settings.");
    }

    const { provider } = await this.deps.resolveProviderCatalog(
      session.provider,
      session.workspacePath,
    );
    if (provider.id !== session.provider) {
      throw new Error("The selected provider does not match this session.");
    }
    let executionOptions: SessionExecutionOptions;
    try {
      executionOptions = validateSessionExecutionOptions(
        request.executionOptions,
        provider,
      );
    } catch (error) {
      if (queued)
        throw new QueuedTurnPreflightError(
          error instanceof Error
            ? error.message
            : "The captured execution options are unavailable.",
        );
      throw error;
    }
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    let agentRuntimeBinding = await Promise.resolve(
      this.deps.getProviderAgentRuntimeBinding?.({ session, provider }) ?? null,
    );
    const sessionCharacter =
      (await this.deps.resolveSessionCharacter?.(session)) ?? null;
    throwIfRunCanceled(runAbortController.signal, queued);
    try {
      assertModelEnabled(
        (await this.deps.getAppSettings()).modelAvailability,
        provider.id,
        executionOptions.model,
      );
    } catch (error) {
      if (queued)
        throw new QueuedTurnPreflightError(
          error instanceof Error
            ? error.message
            : "The captured model is unavailable.",
        );
      throw error;
    }
    throwIfRunCanceled(runAbortController.signal, queued);
    const currentTimestampLabel =
      this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;

    let runningSession: Session;
    let initialLiveState: LiveSessionRunState;
    let runningTurn!: SessionTurnRecord;
    let queueReceipt: LiveSessionRunState["queueReceipt"];
    let setupLiveRun = false;
    let setupRunningSessionSaved = false;
    try {
      runningSession = {
        ...session,
        updatedAt: currentTimestampLabel(),
        status: "running",
        runState: "running",
        messages: [
          ...session.messages,
          { role: "user", text: nextMessage, ...(replyTo ? { replyTo } : {}) },
        ],
        ...(session.messageCount !== undefined
          ? { messageCount: session.messageCount + 1 }
          : {}),
      };

      const runningUpsertStartedAt = Date.now();
      if (queued) {
        queued.startIssued = true;
        const started = await this.deps.persistQueuedTurnStart!(
          runningSession,
          session.messageCount ?? session.messages.length,
          queued.receipt.id,
          buildRunningTurn({
            sessionId,
            createdAt: new Date().toISOString(),
            session: runningSession,
            executionOptions,
          }),
        );
        runningSession = started.session;
        runningTurn = started.turn;
        this.unreleasedTurnIds.set(sessionId, String(runningTurn.id));
        if (typeof runningTurn.userMessageSeq !== "number")
          throw new Error(
            "The queued turn message identity was not persisted.",
          );
        await queued.onStarted({
          turnId: String(runningTurn.id),
          userMessageSeq: runningTurn.userMessageSeq,
        });
        queueReceipt = {
          id: queued.receipt.id,
          incarnationId: queued.receipt.incarnationId,
          userMessageSeq: runningTurn.userMessageSeq,
        };
      } else {
        runningSession = await this.deps.persistRunningTurnStart(
          runningSession,
          session.messageCount ?? session.messages.length,
        );
      }
      setupRunningSessionSaved = true;
      logSessionRunStuckInvestigation("runtime.running-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - runningUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount:
          runningSession.messageCount ?? runningSession.messages.length,
      });
      // キュー経由の開始が確定すると、保存済み Turn に対してキャンセルによる終了を記録する必要がある。
      // 開始の書き込み中に Stop が届いた場合も同じ。
      if (!queued) throwIfRunCanceled(runAbortController.signal);
      this.inFlightSessionRuns.add(sessionId);
      initialLiveState = {
        ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
        ...(queued
          ? { sessionTurnId: String(runningTurn.id), queueReceipt }
          : {}),
        backgroundTasks:
          this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
        reasoningText: "",
      };
      this.setRuntimeLiveState(sessionId, initialLiveState);
      setupLiveRun = true;

      const runningTurnCreateStartedAt = Date.now();
      if (!queued) {
        runningTurn = await this.deps.createSessionTurn(
          buildRunningTurn({
            sessionId,
            createdAt: new Date().toISOString(),
            session: runningSession,
            executionOptions,
          }),
        );
        this.unreleasedTurnIds.set(sessionId, String(runningTurn.id));
        initialLiveState = {
          ...initialLiveState,
          sessionTurnId: String(runningTurn.id),
        };
        this.setRuntimeLiveState(sessionId, initialLiveState);
      }
      logSessionRunStuckInvestigation("runtime.running-turn-create.done", {
        sessionId,
        turnId: runningTurn!.id,
        durationMs: Date.now() - runningTurnCreateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
      });
      this.startingSessionRuns.delete(sessionId);
    } catch (error) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, {
        action: "cancel",
      });
      this.inFlightSessionRuns.delete(sessionId);
      if (setupLiveRun) {
        this.setRuntimeLiveState(sessionId, null);
      }
      if (setupRunningSessionSaved && !queued) {
        const failedSetup: Session = {
          ...runningSession!,
          updatedAt: currentTimestampLabel(),
          status: "idle",
          runState: "error",
        };
        await Promise.resolve(
          this.deps.checkpointRuntimeMetadata(failedSetup, runningSession!),
        ).catch((cleanupError) => {
          console.warn("Session setup failure cleanup failed", cleanupError);
        });
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      throw error;
    }
    let terminalSettled = false;
    let approvalReview: WithMateApprovalReviewTurn | undefined;
    let providerAgentRuntimeTurnHandle: unknown;
    let releaseSourceDisplays: (() => void) | undefined;
    let terminalPersistenceStarted = false;
    let activeRunningSession = runningSession;
    let queuedInputRecoveryError: QueuedInputRuntimeRecoveryError | null = null;
    if (
      runningSession.provider === "codex" &&
      this.deps.beginRunningInput &&
      this.deps.settleRunningInput
    ) {
      this.directSessionInput.set(sessionId, {
        /** 送信前に入力を追記し、保存応答が失われても再追記せず、確認できた記録だけを未送信で確定する。 */
        begin: async (
          text,
          nativeTurnId,
          attachments,
          origin,
          questionRequestId,
          replyTo,
        ) => {
          const messageSeq =
            activeRunningSession.messageCount ??
            activeRunningSession.messages.length;
          try {
            activeRunningSession = await this.deps.beginRunningInput!(
              { ...activeRunningSession, updatedAt: currentTimestampLabel() },
              text,
              runningTurn.id,
              nativeTurnId,
              attachments,
              origin,
              questionRequestId,
              replyTo,
            );
          } catch (error) {
            // 追記の応答が失われても、プロバイダーに送出したり、追記をやり直したりしない。
            const canonical = await this.deps.getSession(sessionId);
            if (
              canonical &&
              getSessionIncarnationId(canonical) ===
                getSessionIncarnationId(activeRunningSession) &&
              canonical.messageCount === messageSeq + 1
            ) {
              activeRunningSession = {
                ...canonical,
                messages: [
                  ...activeRunningSession.messages,
                  {
                    role: "user",
                    text,
                    ...(replyTo ? { replyTo } : {}),
                    turnInput: {
                      turnId: String(runningTurn.id),
                      nativeTurnId,
                      attachments,
                      state: "pending",
                      ...(origin ? { origin } : {}),
                      ...(questionRequestId ? { questionRequestId } : {}),
                    },
                  },
                ],
              };
              activeRunningSession = await this.deps.settleRunningInput!(
                activeRunningSession,
                messageSeq,
                runningTurn.id,
                "not-sent",
              );
            } else if (!canonical || canonical.messageCount !== messageSeq) {
              queuedInputRecoveryError = new QueuedInputRuntimeRecoveryError(
                "The direct input append outcome could not be confirmed.",
              );
              throw queuedInputRecoveryError;
            }
            throw error;
          }
          this.deps.broadcastLiveSessionRun(sessionId);
          return messageSeq;
        },
        /** 直接入力の送達結果を保存してから、ライブ表示の更新を通知する。 */
        settle: async (messageSeq, state) => {
          activeRunningSession = await this.deps.settleRunningInput!(
            { ...activeRunningSession, updatedAt: currentTimestampLabel() },
            messageSeq,
            runningTurn.id,
            state,
          );
          this.deps.broadcastLiveSessionRun(sessionId);
        },
      });
    }
    if (runningSession.provider === "codex")
      this.appendSessionInput.set(
        sessionId,
        async (text, queuedInput, inputTurnId, replyTo) => {
          try {
            activeRunningSession = await this.deps.appendRunningInput(
              { ...activeRunningSession, updatedAt: currentTimestampLabel() },
              text,
              runningTurn.id,
              queuedInput && inputTurnId
                ? { queueId: queuedInput.id, inputTurnId }
                : undefined,
              replyTo,
            );
          } catch (error) {
            if (!queuedInput || !inputTurnId) throw error;
            try {
              if (!this.deps.getQueuedInputReceipt) throw error;
              const receipt =
                await this.deps.getQueuedInputReceipt(queuedInput);
              if (
                receipt?.state !== "completed" ||
                receipt.inputTurnId !== inputTurnId
              )
                throw error;
              const canonical = await this.deps.getSession(sessionId);
              if (
                !canonical ||
                getSessionIncarnationId(canonical) !==
                  queuedInput.incarnationId ||
                canonical.messageCount !==
                  (activeRunningSession.messageCount ??
                    activeRunningSession.messages.length) +
                    1
              )
                throw error;
              activeRunningSession = {
                ...canonical,
                messages: [
                  ...activeRunningSession.messages,
                  { role: "user", text, ...(replyTo ? { replyTo } : {}) },
                ],
              };
            } catch (recoveryError) {
              queuedInputRecoveryError = new QueuedInputRuntimeRecoveryError(
                recoveryError instanceof Error
                  ? recoveryError.message
                  : "Queued input runtime persistence could not be confirmed.",
              );
              throw queuedInputRecoveryError;
            }
          }
          this.deps.broadcastLiveSessionRun(sessionId);
        },
      );
    /** 固定した実行条件を Provider に渡し、終端へ進む前に送出済みの入力と対象の回答を回収する。 */
    const runProviderTurn = async (turnSession: Session) => {
      throwIfRunCanceled(runAbortController.signal);
      const elicitationResponses: Promise<LiveElicitationResponse>[] = [];
      const pendingQuestionAnswers = new Map<
        string,
        { request: LiveElicitationRequest; response: LiveElicitationResponse }
      >();
      /** 送達した回答を要求 ID で取り出し、終端前の質問履歴に項目ごとに反映する。 */
      const recordQuestionAnswer = (requestId: string) => {
        const answer = pendingQuestionAnswers.get(requestId);
        pendingQuestionAnswers.delete(requestId);
        if (!answer || terminalSettled) return;
        const fields = questionAnswerHistory(answer.request, answer.response);
        const live = this.deps.getLiveSessionRun(sessionId);
        if (!fields || !live) return;
        this.setRuntimeLiveState(sessionId, {
          ...live,
          elicitationRecords: live.elicitationRecords?.map((record) =>
            record.requestId !== requestId
              ? record
              : {
                  ...record,
                  fields: record.fields.map((field, index) =>
                    fields[index] ? { ...field, answer: fields[index] } : field,
                  ),
                },
          ),
        });
        this.deps.broadcastLiveSessionRun(sessionId);
      };
      const effectiveTurnSession = {
        ...(await (this.deps.resolveProviderSession?.(turnSession) ??
          turnSession)),
        allowedAdditionalDirectories: [...capturedAdditionalDirectories],
      };
      const isAuxiliary = Boolean(
        await this.deps.isAuxiliarySession?.(sessionId),
      );
      const mainIdentity =
        !isAuxiliary &&
        session.sessionKind === "default" &&
        runningTurn.userMessageSeq != null
          ? {
              sessionId,
              incarnationId: getSessionIncarnationId(turnSession),
              seq: runningTurn.userMessageSeq,
              finalAnswerTurnId: String(runningTurn.id),
            }
          : undefined;
      let mainConversationFrame: MainSessionTarget | null | undefined;
      if (mainIdentity) {
        mainConversationFrame = queued?.input.request.mainConversationFrame;
        if (mainConversationFrame === undefined) {
          // 従来の GUI 受付レコードにも保存済みの返信があり得る。エージェントからの通常入力では、
          // 従来どおり送信元に基づく表示上の所属を維持する。
          const needsSavedMembership =
            queued && (queued.input.origin?.kind === "session" || replyTo);
          mainConversationFrame =
            needsSavedMembership && this.deps.readMainMessageThread
              ? await this.deps.readMainMessageThread(
                  {
                    kind: "main",
                    sessionId,
                    incarnationId: mainIdentity.incarnationId,
                  },
                  mainIdentity.seq,
                )
              : null;
        }
      }
      const sessionFolderPath = await this.deps.resolveSessionFolderPath?.(
        effectiveTurnSession.id,
      );
      throwIfRunCanceled(runAbortController.signal);
      const providerPromise = providerAdapter.runSessionTurn(
        {
          session: effectiveTurnSession,
          runtimeOwner: {
            kind: isAuxiliary ? "auxiliary" : "main",
            id: sessionId,
            incarnationId: getSessionIncarnationId(turnSession),
          },
          executionOptions,
          sessionFolderPath,
          crewFolderPath: capturedCrewFolderPath,
          providerCatalog: provider,
          userMessage: nextMessage,
          ...(replyTo ? { replyTo } : {}),
          ...(mainIdentity
            ? { messageIdentity: mainIdentity, mainConversationFrame }
            : {}),
          ...(queued
            ? {
                inputProvenance: queuedInputProvenance(
                  queued.receipt,
                  queued.input,
                ),
              }
            : {}),
          appSettings,
          attachments: composerPreview.attachments,
          currentDateTime:
            appSettings.currentDateEnabled && session.sessionKind === "default"
              ? formatCurrentDateTime(observedAt)
              : undefined,
          sessionInstructions,
          agentRuntimeBinding,
          signal: runAbortController.signal,
          /** Provider の応答後も後片付けが続く場合は、実行枠をその完了まで保持する。 */
          onCleanupPending: (completion) =>
            this.trackTerminatingSessionRun(sessionId, completion),
          /** 承認位置を固定し、拒否・通常待機・仲介レビューを実行時の承認設定に基づいて振り分ける。 */
          onApprovalRequest: (
            approvalRequest,
            requestSignal,
            nativeReview,
            onDecisionSource,
          ) => {
            if (
              executionOptions.approvalMode === "safety-focused" ||
              terminalSettled
            ) {
              reportApprovalDecisionSource(onDecisionSource, "blocked");
              return "deny";
            }
            const signal = requestSignal
              ? AbortSignal.any([runAbortController.signal, requestSignal])
              : runAbortController.signal;
            const request = {
              ...approvalRequest,
              textPosition:
                this.deps.getLiveSessionRun(sessionId)?.assistantText.length ??
                0,
            };
            const selection = appSettings.withMateAutoReview;
            const useReview =
              executionOptions.approvalMode === "on-request" &&
              supportsWithMateAutoReview(effectiveTurnSession.provider) &&
              (executionOptions.withMateReviewerExplicit
                ? executionOptions.codexReviewer === "auto-review"
                : !!selection);
            if (!useReview)
              return this.deps.waitForApprovalDecision(
                sessionId,
                request,
                signal,
                undefined,
                onDecisionSource,
              );

            let review: PendingApprovalReview | null = null;
            if (
              !signal.aborted &&
              selection &&
              approvalRequest.provider === effectiveTurnSession.provider &&
              approvalRequest.decisionMode === "direct-decision" &&
              nativeReview
            ) {
              try {
                approvalReview ??= this.deps.startWithMateApprovalReview?.({
                  selection,
                  turnId: String(runningTurn.id),
                  workspacePath: effectiveTurnSession.workspacePath,
                  binding: agentRuntimeBinding,
                  signal: runAbortController.signal,
                });
                review = approvalReview?.pending(request, nativeReview) ?? null;
              } catch {
                // レビュー経路を構築できなくても、手動経路としては扱わない。
              }
            }
            return this.deps.waitForApprovalDecision(
              sessionId,
              request,
              signal,
              review,
              onDecisionSource,
            );
          },
          /** 追加入力を待ち、受理した回答を送達確認まで保留する。ユーザーメッセージ経由の回答はこの場で反映する。 */
          onElicitationRequest: (elicitationRequest, requestSignal) => {
            if (terminalSettled) return { action: "cancel" };
            const signal = requestSignal
              ? AbortSignal.any([runAbortController.signal, requestSignal])
              : runAbortController.signal;
            const response = Promise.resolve(
              this.deps.waitForElicitationResponse(
                sessionId,
                elicitationRequest,
                signal,
              ),
            ).then((value) => {
              if (value.action === "accept") {
                pendingQuestionAnswers.set(elicitationRequest.requestId, {
                  request: elicitationRequest,
                  response: value,
                });
                if (elicitationRequest.delivery === "user-message")
                  recordQuestionAnswer(elicitationRequest.requestId);
              }
              return value;
            });
            if (elicitationRequest.delivery === "user-message")
              elicitationResponses.push(Promise.resolve(response));
            return response;
          },
          onElicitationDelivered: recordQuestionAnswer,
          /** この実行から届いた Provider の利用枠データを、共通のテレメトリ管理側へ渡す。 */
          onProviderQuotaTelemetry: (telemetry) => {
            this.deps.setProviderQuotaTelemetry(telemetry);
          },
          /** 実行中に報告された Session のコンテキスト使用状況を反映する。 */
          onSessionContextTelemetry: (telemetry) => {
            this.deps.setSessionContextTelemetry(telemetry);
          },
        },
        (state, changes) => {
          if (terminalSettled) {
            return;
          }

          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          const nextLiveState: LiveSessionRunState = {
            ...state,
            sessionTurnId: String(runningTurn.id),
            queueReceipt,
            steps:
              changes.snapshot === false
                ? applyProviderProgressChanges(
                    currentLiveState?.steps ?? [],
                    changes.steps,
                  )
                : state.steps,
            backgroundTasks:
              changes.snapshot === false
                ? applyProviderProgressChanges(
                    currentLiveState?.backgroundTasks ?? [],
                    changes.backgroundTasks,
                  )
                : state.backgroundTasks,
            reasoningText:
              state.reasoningText ?? currentLiveState?.reasoningText ?? "",
            approvalRequest: currentLiveState?.approvalRequest ?? null,
            elicitationRequest: currentLiveState?.elicitationRequest ?? null,
            elicitationRequests: currentLiveState?.elicitationRequests,
            elicitationRecords: placeElicitationRecords(
              currentLiveState?.elicitationRecords,
              state.assistantQuestionRanges,
            ),
          };
          this.setRuntimeLiveState(sessionId, nextLiveState);
        },
      );
      try {
        return await waitForProviderTurnWithCancelDeadline(
          providerPromise,
          runAbortController.signal,
          this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
          () =>
            buildCanceledPartialResult(this.deps.getLiveSessionRun(sessionId)),
          (promise) => this.trackTerminatingSessionRun(sessionId, promise),
        );
      } finally {
        approvalReview?.close();
        this.finishingSessionTurns.add(sessionId);
        const live = this.deps.getLiveSessionRun(sessionId);
        if (live?.inputAvailable) {
          this.setRuntimeLiveState(sessionId, {
            ...live,
            inputAvailable: false,
          });
          this.deps.broadcastLiveSessionRun(sessionId);
        }
        const pendingInput = this.pendingSessionInputs.get(sessionId);
        if (pendingInput && this.dispatchedSessionInputs.has(sessionId))
          await pendingInput.catch(() => undefined);
        this.deps.resolvePendingElicitationRequest(sessionId, {
          action: "cancel",
        });
        await Promise.all(elicitationResponses);
        if (queuedInputRecoveryError) throw queuedInputRecoveryError;
      }
    };

    try {
      releaseSourceDisplays = this.deps.beginSourceDisplayTurn?.(
        runningSession,
        String(runningTurn.id),
      );
      const providerAgentRuntimeTurn = await Promise.resolve(
        this.deps.beginProviderAgentRuntimeTurn?.({
          session: activeRunningSession,
          executionOptions,
          provider,
          binding: agentRuntimeBinding,
          signal: runAbortController.signal,
        }),
      );
      providerAgentRuntimeTurnHandle = providerAgentRuntimeTurn?.handle;
      if (providerAgentRuntimeTurn) {
        agentRuntimeBinding = providerAgentRuntimeTurn.binding;
      }
      // アダプターの呼び出しがランタイムにおける送出の境界。入力の送信前、準備中に失敗したと
      // 証明できるのはアダプターだけ。
      const result = await runProviderTurn(activeRunningSession);
      if (!result) {
        throw new Error("The provider did not return a completed turn.");
      }
      logSessionRunStuckInvestigation("runtime.provider-turn.done", {
        sessionId,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        assistantChars: result.assistantText.length,
        operationCount: result.artifact?.operationTimeline?.length ?? 0,
        hasThreadId: (result.threadId ?? "").trim().length > 0,
      });
      const completedAt = new Date().toISOString();

      terminalSettled = true;
      const completedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: "idle",
        threadId: result.threadId ?? activeRunningSession.threadId,
        ...(activeRunningSession.messageCount !== undefined
          ? { messageCount: activeRunningSession.messageCount + 1 }
          : {}),
        messages: [
          ...activeRunningSession.messages,
          {
            role: "assistant",
            text: result.assistantText,
            artifact: result.artifact,
            output: result.output,
            ...this.terminalElicitationRecords(sessionId, result),
          },
        ],
      };
      const assistantMessageIndex =
        (completedSession.messageCount ?? completedSession.messages.length) - 1;

      const completedSessionUpsertStartedAt = Date.now();
      const completedThreadId = pickPreferredThreadId(
        result.threadId,
        completedSession.threadId,
      );
      terminalPersistenceStarted = true;
      const terminal: SessionTurnTerminalCommit = {
        turnId: runningTurn.id,
        sessionId,
        phase: "completed",
        assistantMessageSeq: assistantMessageIndex,
        threadId: completedThreadId,
        errorMessage: "",
        completedAt,
      };
      const storedCompletedSession = await this.deps.appendTerminalSession(
        completedSession,
        terminal,
        {
          confirmedFinalAssistantText: result.lastNonEmptyAssistantMessageText,
        },
      );
      if (queued) queued.outcome = { state: "completed" };
      logSessionRunStuckInvestigation("runtime.completed-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - completedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount:
          completedSession.messageCount ?? completedSession.messages.length,
        storedRunState: storedCompletedSession.runState,
        storedStatus: storedCompletedSession.status,
      });
      activeRunningSession = storedCompletedSession;
      if (!runAbortController.signal.aborted) {
        notifySessionTurnTerminalBestEffort(
          this.deps.notifySessionTurnTerminal,
          {
            outcome: "completed",
            session: storedCompletedSession,
            lastNonEmptyAssistantMessageText:
              result.lastNonEmptyAssistantMessageText ?? "",
          },
        );
      }

      return storedCompletedSession;
    } catch (error: unknown) {
      if (
        queuedInputRecoveryError ||
        terminalPersistenceStarted ||
        (queued && terminalSettled)
      ) {
        throw error;
      }
      const providerTurnError =
        error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError
        ? providerTurnError.canceled
        : isCanceledRunError(error);
      const effectiveError = error;
      const message =
        effectiveError instanceof Error
          ? effectiveError.message
          : String(effectiveError);
      const providerErrorReason = providerTurnError?.reason ?? null;
      const failureMessage = formatProviderFailureMessage({
        providerId: activeRunningSession.provider,
        reason: providerErrorReason,
        message,
        canceled,
      });
      const partialResult = providerTurnError?.partialResult;
      const failedTurnThreadId = pickPreferredThreadId(
        partialResult?.threadId,
        this.deps.getLiveSessionRun(sessionId)?.threadId,
        activeRunningSession.threadId,
      );
      const shouldResetFailedThread =
        activeRunningSession.provider !== "codex" &&
        activeRunningSession.provider !== "opencode" &&
        shouldResetFailedSessionThread(
          error,
          activeRunningSession.threadId,
          partialResult,
          canceled,
        );
      const nextSessionThreadId =
        (activeRunningSession.provider === "codex" ||
          activeRunningSession.provider === "opencode") &&
        activeRunningSession.threadId
          ? activeRunningSession.threadId
          : shouldResetFailedThread
            ? ""
            : failedTurnThreadId;
      const completedAt = new Date().toISOString();
      terminalSettled = true;
      const assistantText = canceled
        ? partialResult?.assistantText.trim()
          ? `${partialResult.assistantText}\n\nRun canceled.`
          : "Run canceled."
        : (partialResult?.assistantText ?? "");
      const failedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: canceled ? "idle" : "error",
        threadId: nextSessionThreadId,
        ...(activeRunningSession.messageCount !== undefined
          ? { messageCount: activeRunningSession.messageCount + 1 }
          : {}),
        messages: [
          ...activeRunningSession.messages,
          {
            role: "assistant",
            text: assistantText,
            ...(!canceled ? { runFailure: failureMessage } : {}),
            artifact: partialResult?.artifact,
            output: partialResult?.output,
            ...this.terminalElicitationRecords(sessionId, partialResult),
            accent: true,
          },
        ],
      };

      const failedSessionUpsertStartedAt = Date.now();
      const terminal: SessionTurnTerminalCommit = {
        turnId: runningTurn.id,
        sessionId,
        phase: canceled ? "canceled" : "failed",
        assistantMessageSeq:
          (failedSession.messageCount ?? failedSession.messages.length) - 1,
        threadId: failedTurnThreadId,
        errorMessage: failureMessage,
        completedAt,
      };
      const storedFailedSession = await this.deps.appendTerminalSession(
        failedSession,
        terminal,
      );
      if (queued)
        queued.outcome = {
          state: canceled ? "canceled" : "failed",
          reason: failureMessage,
        };
      logSessionRunStuckInvestigation("runtime.terminal-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - failedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount:
          failedSession.messageCount ?? failedSession.messages.length,
        storedRunState: storedFailedSession.runState,
        storedStatus: storedFailedSession.status,
      });
      activeRunningSession = storedFailedSession;
      if (
        !canceled &&
        !this.pendingSessionRunCancels.has(sessionId) &&
        !runAbortController.signal.aborted
      ) {
        notifySessionTurnTerminalBestEffort(
          this.deps.notifySessionTurnTerminal,
          {
            outcome: "failed",
            session: storedFailedSession,
          },
        );
      }
      invalidateProviderSessionThreadBestEffort(
        this.deps.invalidateProviderSessionThread,
        storedFailedSession.provider,
        sessionId,
      );
      return storedFailedSession;
    } finally {
      releaseSourceDisplays?.();
      approvalReview?.close();
      this.appendSessionInput.delete(sessionId);
      this.directSessionInput.delete(sessionId);
      if (providerAgentRuntimeTurnHandle !== undefined) {
        this.deps.endProviderAgentRuntimeTurn?.(providerAgentRuntimeTurnHandle);
      }
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(
          runningSession.provider,
          [0, 3000, 10000],
        );
      } else if (
        runningSession.provider === "codex" ||
        runningSession.provider === "claude" ||
        runningSession.provider === "opencode"
      ) {
        this.deps.scheduleProviderQuotaTelemetryRefresh(
          runningSession.provider,
          [3000],
        );
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, {
        action: "cancel",
      });
      this.inFlightSessionRuns.delete(sessionId);
      const currentLiveState = this.deps.getLiveSessionRun(sessionId);
      this.finishingSessionTurns.delete(sessionId);
      const preservedBackgroundTasks = currentLiveState?.backgroundTasks ?? [];
      const preservedReasoningText = currentLiveState?.reasoningText ?? "";
      if (
        preservedBackgroundTasks.length > 0 ||
        preservedReasoningText.trim().length > 0
      ) {
        this.setRuntimeLiveState(sessionId, {
          ...buildEmptyLiveSessionRunState(
            sessionId,
            activeRunningSession.threadId,
          ),
          runState: activeRunningSession.runState,
          backgroundTasks: preservedBackgroundTasks,
          reasoningText: preservedReasoningText,
        });
      } else {
        this.setRuntimeLiveState(sessionId, null);
      }
      this.deps.broadcastLiveSessionRun(sessionId);
      logSessionRunStuckInvestigation("runtime.finally.done", {
        sessionId,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        activeRunState: activeRunningSession.runState,
        activeStatus: activeRunningSession.status,
        preservedBackgroundTaskCount: preservedBackgroundTasks.length,
        preservedReasoningChars: preservedReasoningText.length,
        liveRunAfterFinally: this.deps.getLiveSessionRun(sessionId)
          ? "present"
          : "null",
      });
    }
  }

  /** 終端応答上の質問位置を反映し、未回答の要求を期限切れとして履歴に残す。 */
  private terminalElicitationRecords(
    sessionId: string,
    result?: RunSessionTurnResult | null,
  ): Pick<Session["messages"][number], "elicitationRecords"> {
    const records = placeElicitationRecords(
      this.deps.getLiveSessionRun(sessionId)?.elicitationRecords,
      result?.assistantQuestionRanges,
    );
    return records?.length
      ? {
          elicitationRecords: records.map((record) => ({
            ...record,
            status: record.status === "pending" ? "expired" : record.status,
          })),
        }
      : {};
  }
}
