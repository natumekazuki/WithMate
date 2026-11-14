import { currentTimestampLabel as defaultCurrentTimestampLabel } from "../../src-shared/time-state.js";
import { isDeepStrictEqual } from "node:util";
import { readCoordinationNotification } from "../../src-shared/coordination/coordination-delivery.js";
import type { ComposerAttachment, ComposerPreview, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, RunSessionTurnRequest, SessionContextTelemetry, SteerSessionTurnRequest, SteerSessionTurnResult } from "../../src-shared/session/runtime-state.js";
import type { MessageArtifact, TurnInputDeliveryState } from "../../src-shared/session/session-state.js";
import { normalizeSessionTurnCorrelation } from "../../src-shared/session/runtime-state.js";
import { placeElicitationRecords } from "../../src-shared/session/question-placement.js";
import { validateSessionExecutionOptions, type SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import { type CharacterProfile } from "../../src-shared/character/character-state.js";
import { buildLiveRunMessageOperations } from "../../src-shared/session/live-run-message-operations.js";
import type { SessionTurnInput, SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { toProviderTextPreview } from "./provider-payload-limits.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { getSessionIncarnationId, isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import { captureSessionTurnQueueDisplay, type SessionSteerOrigin, type SessionSteerResult, type SessionTurnQueueOwner, type SessionTurnQueueReceipt, type SessionTurnQueueCapturedInput } from "../../src-shared/session/session-turn-queue.js";
import { QueuedInputPreDispatchError, QueuedInputRuntimeRecoveryError, type SessionTurnQueueDispatchResult } from "./session-turn-queue-service.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type RunSessionTurnResult,
  type RunSessionTurnInput,
} from "../providers/provider-runtime.js";
import { composeProviderInput } from "../providers/provider-prompt.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionTurnTerminalNotification } from "./session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import type { ConversationTimingContext } from "./conversation-timing.js";
import type { CharacterAffectContext } from "../../src-shared/character-context/character-context-contract.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "./session-run-timeouts.js";
import { applyProviderProgressChanges } from "../providers/provider-progress.js";
import type { SessionBackgroundEvent } from "./session-background-events.js";


const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

export type SessionRuntimeServiceDeps = {
  runSessionAdmissionExclusive?<T>(
    sessionId: string,
    operation: () => T | Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  getSession(sessionId: string): Awaitable<Session | null>;
  persistRunningTurnStart(session: Session, expectedMessageCount: number): Awaitable<Session>;
  persistQueuedTurnStart?(session: Session, expectedMessageCount: number, queueId: string, turn: SessionTurnInput): Awaitable<{ session: Session; turn: SessionTurnRecord }>;
  assertCapturedComposerAttachmentsAvailable?(session: Session, attachments: ComposerAttachment[]): Promise<void>;
  onSessionRunReleased?(sessionId: string): void;
  getQueuedInputReceipt?(receipt: SessionTurnQueueReceipt): Awaitable<SessionTurnQueueReceipt | null>;
  appendRunningInput(session: Session, text: string, turnId: number, queuedInput?: { queueId: string; inputTurnId: string }): Awaitable<Session>;
  beginRunningInput?(session: Session, text: string, turnId: number, nativeTurnId: string, attachments: ComposerAttachment[], origin?: SessionSteerOrigin): Awaitable<Session>;
  settleRunningInput?(session: Session, messageSeq: number, turnId: number, state: Exclude<TurnInputDeliveryState, "pending">): Awaitable<Session>;
  checkpointRuntimeMetadata(session: Session, expected: Session): Awaitable<Session>;
  appendTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session>;
  clearCharacterAuthoringRuntimeState?(session: Session): Awaitable<Session>;
  resolveRuntimeSessionForTurn?: (session: Session) => Awaitable<Session>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  resolveProviderSession?: (session: Session) => Awaitable<Session>;
  resolveSessionFolderPath?: (sessionId: string) => Awaitable<string>;
  resolveCrewFolderPath?: (sessionId: string) => Awaitable<string>;
  resolveSessionCharacter?: (session: Session) => Promise<CharacterProfile | null>;
  getAppSettings: () => Awaitable<AppSettings>;
  resolveProviderCatalog(providerId: string | null | undefined, workspacePath?: string): Awaitable<{
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  }>;
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
  resolveConversationTimingContext?: (
    session: Session,
    observedAt: Date,
  ) => Awaitable<ConversationTimingContext | null>;
  resolveCharacterContext?: (
    session: Session,
  ) => Awaitable<CharacterAffectContext | null>;
  createSessionTurn(input: SessionTurnInput): Awaitable<SessionTurnRecord>;
  updateSessionTurn(id: number, input: SessionTurnInput): Awaitable<void | SessionTurnRecord>;
  setLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void;
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  waitForApprovalDecision(
    sessionId: string,
    request: LiveApprovalRequest,
    signal: AbortSignal,
  ): Promise<LiveApprovalDecision> | LiveApprovalDecision;
  waitForElicitationResponse(
    sessionId: string,
    request: LiveElicitationRequest,
    signal: AbortSignal,
  ): Promise<LiveElicitationResponse> | LiveElicitationResponse;
  setProviderQuotaTelemetry(telemetry: ProviderQuotaTelemetry): void;
  setSessionContextTelemetry(telemetry: SessionContextTelemetry): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  resetProviderSessionThread?(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  /** Persisted Auxiliary threads must not be replaced silently after resume failure. */
  isAuxiliarySession?(sessionId: string): Awaitable<boolean>;
  getProviderAgentRuntimeBinding?(input: {
    session: Session;
    provider: ModelCatalogProvider;
  }): Awaitable<ProviderAgentRuntimeBindingProjection | null>;
  beginProviderAgentRuntimeTurn?(input: {
    session: Session;
    executionOptions: SessionExecutionOptions;
    provider: ModelCatalogProvider;
    binding: ProviderAgentRuntimeBindingProjection | null;
    signal: AbortSignal;
  }): Awaitable<{
    handle: unknown;
    binding: ProviderAgentRuntimeBindingProjection | null;
  } | undefined>;
  endProviderAgentRuntimeTurn?(handle: unknown): void;
  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void;
  broadcastLiveSessionRun(sessionId: string): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
  resolvePendingElicitationRequest(sessionId: string, response: LiveElicitationResponse): void;
  getMateState?: () => MateStorageState;
  notifySessionTurnTerminal?: (notification: SessionTurnTerminalNotification) => Awaitable<void>;
  onBackgroundEvent?: (event: SessionBackgroundEvent) => Awaitable<void>;
  currentTimestampLabel?: () => string;
  currentDate?: () => Date;
  providerCancelGraceMs?: number;
};

function notifySessionTurnTerminalBestEffort(
  notify: SessionRuntimeServiceDeps["notifySessionTurnTerminal"],
  notification: SessionTurnTerminalNotification,
): void {
  if (!notify) {
    return;
  }

  try {
    void Promise.resolve(notify(notification))
      .catch((error) => console.warn("Session turn terminal notification failed", error));
  } catch (error) {
    console.warn("Session turn terminal notification failed", error);
  }
}

function invalidateProviderSessionThreadBestEffort(
  invalidate: SessionRuntimeServiceDeps["invalidateProviderSessionThread"],
  providerId: string | null | undefined,
  sessionId: string,
): void {
  try {
    void Promise.resolve(invalidate(providerId, sessionId))
      .catch((error) => console.warn("Detached provider session invalidation failed", error));
  } catch (error) {
    console.warn("Detached provider session invalidation failed", error);
  }
}

function buildCanceledPartialResult(
  liveState: LiveSessionRunState | null,
): RunSessionTurnResult {
  return {
    threadId: liveState?.threadId || null,
    assistantText: liveState?.assistantText ?? "",
    assistantQuestionRanges: liveState?.assistantQuestionRanges,
    artifact: liveState ? {
      title: "", changedFiles: [], activitySummary: [], runChecks: [],
      operationTimeline: buildLiveRunMessageOperations(liveState),
    } : undefined,
    usage: liveState?.usage ?? null,
    providerQuotaTelemetry: null,
  };
}

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
    const onAbort = () => {
      timeout = setTimeout(() => {
        onCancelDeadline(providerPromise);
        settle(() => reject(new ProviderTurnError(
          "Provider did not stop within the cancellation grace period",
          buildPartialResult(),
          true,
          "canceled",
        )));
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

function createCanceledRunError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfRunCanceled(signal: AbortSignal, queued?: QueuedTurnContext): void {
  if (signal.aborted) {
    if (queued && !queued.startIssued) throw new QueuedTurnPreStartCanceledError("Session setup was canceled");
    throw createCanceledRunError("Session setup was canceled");
  }
}

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
    const onAbort = () => {
      timeout = setTimeout(() => {
        if (!isSetupPending()) {
          return;
        }
        onCancelDeadline(setupPromise);
        settle(() => reject(createCanceledRunError("Session setup did not stop within the cancellation grace period")));
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

function hasMeaningfulArtifact(artifact: MessageArtifact | undefined): boolean {
  if (!artifact) {
    return false;
  }

  return artifact.changedFiles.length > 0 ||
    artifact.activitySummary.some((summary) => summary.trim().length > 0) ||
    (artifact.operationTimeline?.length ?? 0) > 0 ||
    artifact.runChecks.length > 0;
}

export function hasMeaningfulPartialRunResult(partialResult: RunSessionTurnResult | null | undefined): boolean {
  if (!partialResult) {
    return false;
  }

  return partialResult.assistantText.trim().length > 0 ||
    hasMeaningfulArtifact(partialResult.artifact);
}

function normalizeProviderErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.trim().toLowerCase() : "";
}

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
    /\b(thread|session)\b.*\bmodel\b.*\bincompatible\b/.test(normalizedMessage) ||
    /\bmodel\b.*\b(thread|session)\b.*\bincompatible\b/.test(normalizedMessage)
  );
}

function isRetryableCodexThreadBootstrapError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.trim().toLowerCase();
  if (!normalizedMessage) {
    return false;
  }

  return /codex exec exited with code 1:\s*reading prompt from stdin\.\.\./.test(normalizedMessage);
}

function shouldRetryUnusableThreadRun(
  error: unknown,
  partialResult: RunSessionTurnResult | null | undefined,
): boolean {
  if (hasMeaningfulPartialRunResult(partialResult)) {
    return false;
  }

  return isRetryableStaleThreadSessionError(error) || isRetryableCodexThreadBootstrapError(error);
}

function shouldResetFailedSessionThread(
  error: unknown,
  currentThreadId: string,
  partialResult: RunSessionTurnResult | null | undefined,
  canceled: boolean,
): boolean {
  if (canceled || !shouldRetryUnusableThreadRun(error, partialResult)) {
    return false;
  }

  const candidateThreadId = pickPreferredThreadId(partialResult?.threadId, currentThreadId);
  return candidateThreadId.length > 0;
}

function extractProviderUsageLimitRetryAt(message: string): string | null {
  const match = /\btry again at\s+(.+?)(?:\.|$)/i.exec(message);
  return match?.[1]?.trim() || null;
}

function formatProviderUsageLimitMessage(providerId: Session["provider"], message: string): string {
  const providerLabel = providerId === "codex" ? "Codex" : "Provider";
  const retryAt = extractProviderUsageLimitRetryAt(message);
  if (retryAt) {
    return `${providerLabel} usage limit reached.\nTry again at: ${retryAt}`;
  }

  const preview = toProviderTextPreview(message) ?? message;
  return `${providerLabel} usage limit reached.\nDetails: ${preview}`;
}

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

function pickPreferredThreadId(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const normalized = candidate?.trim() ?? "";
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return "";
}

function buildEmptyLiveSessionRunState(sessionId: string, threadId: string): LiveSessionRunState {
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

function buildRunningTurn(params: {
  sessionId: string;
  createdAt: string;
  session: Pick<Session, "provider" | "threadId" | "messages" | "messageCount">;
  executionOptions: SessionExecutionOptions;
}): SessionTurnInput {
  return {
    sessionId: params.sessionId, createdAt: params.createdAt, phase: "running",
    provider: params.session.provider, model: params.executionOptions.model,
    reasoningEffort: params.executionOptions.reasoningEffort,
    approvalMode: params.executionOptions.approvalMode,
    sandboxMode: params.executionOptions.codexSandboxMode,
    userMessageSeq: Math.max(0, (params.session.messageCount ?? params.session.messages.length) - 1),
    threadId: params.session.threadId, errorMessage: "",
  };
}

type QueuedTurnContext = {
  receipt: SessionTurnQueueReceipt;
  input: SessionTurnQueueCapturedInput;
  onStarted: (input: { turnId: string; userMessageSeq: number }) => Promise<void>;
  startIssued?: boolean;
  outcome?: SessionTurnQueueDispatchResult;
};

function queuedInputProvenance(receipt: SessionTurnQueueReceipt, input: SessionTurnQueueCapturedInput): NonNullable<RunSessionTurnInput["inputProvenance"]> {
  return { origin: input.origin ?? null,
    originalChanged: receipt.accepted ? !isDeepStrictEqual(
      { text: receipt.accepted.request.userMessage, attachments: receipt.accepted.attachments },
      { text: input.request.userMessage, attachments: input.attachments }) : null,
    ...(input.coordination ? { coordinationOperation: input.coordination.operation, coordination: readCoordinationNotification(input) ?? undefined } : {}) };
}

class QueuedTurnPreflightError extends Error {}

class QueuedTurnPreStartCanceledError extends Error {
  override name = "AbortError";
}

type ParentSessionInput = {
  origin: SessionSteerOrigin;
  turnId: string;
  assertCurrent(): void;
  dispatched: boolean;
  messageSeq: number | null;
};

export class SessionRuntimeService {
  private readonly inFlightSessionRuns = new Set<string>();
  private readonly startingSessionRuns = new Set<string>();
  private readonly terminatingSessionRuns = new Map<string, Set<Promise<unknown>>>();
  private readonly unreleasedTurnIds = new Map<string, string>();
  private readonly waitingSessionRunAdmissions = new Set<string>();
  private readonly pendingSessionRunCancels = new Set<string>();
  private readonly sessionRunControllers = new Map<string, AbortController>();
  private readonly pendingSessionInputs = new Map<string, Promise<SteerSessionTurnResult>>();
  private readonly dispatchedSessionInputs = new Set<string>();
  private readonly finishingSessionTurns = new Set<string>();
  private readonly appendSessionInput = new Map<string, (text: string, queued?: SessionTurnQueueReceipt, inputTurnId?: string) => Promise<void>>();
  private readonly directSessionInput = new Map<string, { begin(text: string, nativeTurnId: string, attachments: ComposerAttachment[], origin?: SessionSteerOrigin): Promise<number>; settle(messageSeq: number, state: Exclude<TurnInputDeliveryState, "pending">): Promise<void> }>();
  private readonly pendingRuns = new Set<Promise<Session>>();

  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  getUnreleasedTurnIds(): string[] {
    return [...this.unreleasedTurnIds.values()];
  }

  hasInFlightRuns(): boolean {
    return this.inFlightSessionRuns.size > 0
      || this.startingSessionRuns.size > 0
      || this.terminatingSessionRuns.size > 0
      || this.waitingSessionRunAdmissions.size > 0
      || this.pendingSessionInputs.size > 0
      || this.finishingSessionTurns.size > 0;
  }

  isRunInFlight(sessionId: string): boolean {
    return this.inFlightSessionRuns.has(sessionId)
      || this.startingSessionRuns.has(sessionId)
      || this.terminatingSessionRuns.has(sessionId)
      || this.waitingSessionRunAdmissions.has(sessionId)
      || this.pendingSessionInputs.has(sessionId)
      || this.finishingSessionTurns.has(sessionId);
  }

  private cancellationState(sessionId: string): LiveSessionRunState["cancellationState"] {
    if (this.terminatingSessionRuns.has(sessionId)) {
      return "terminating";
    }
    return this.sessionRunControllers.get(sessionId)?.signal.aborted || this.pendingSessionRunCancels.has(sessionId)
      ? "requested"
      : undefined;
  }

  private setRuntimeLiveState(sessionId: string, state: LiveSessionRunState | null): void {
    const cancellationState = this.cancellationState(sessionId);
    const nextState = state ? {
      ...state,
      runState: state.runState ?? (this.inFlightSessionRuns.has(sessionId) ? "running" : "idle"),
      ...(this.finishingSessionTurns.has(sessionId) ? { inputAvailable: false } : {}),
    } : null;
    this.deps.setLiveSessionRun(sessionId, cancellationState
      ? { ...(nextState ?? buildEmptyLiveSessionRunState(sessionId, this.deps.getLiveSessionRun(sessionId)?.threadId ?? "")), inputAvailable: false, cancellationState }
      : nextState);
  }

  private releaseCancellationState(sessionId: string): void {
    if (this.isRunInFlight(sessionId) || this.waitingSessionRunAdmissions.has(sessionId)) {
      return;
    }
    this.unreleasedTurnIds.delete(sessionId);
    const liveState = this.deps.getLiveSessionRun(sessionId);
    if (liveState?.cancellationState) {
      const { cancellationState: _cancellationState, ...rest } = liveState;
      this.deps.setLiveSessionRun(sessionId, rest.backgroundTasks.length > 0 || (rest.reasoningText ?? "").trim().length > 0 ? rest : null);
      this.deps.broadcastLiveSessionRun(sessionId);
    }
    try { this.deps.onSessionRunReleased?.(sessionId); } catch { /* Release observers do not own execution or persistence. */ }
  }

  private trackTerminatingSessionRun(sessionId: string, promise: Promise<unknown>): void {
    const trackedPromises = this.terminatingSessionRuns.get(sessionId) ?? new Set<Promise<unknown>>();
    if (trackedPromises.has(promise)) {
      return;
    }
    trackedPromises.add(promise);
    this.terminatingSessionRuns.set(sessionId, trackedPromises);
    this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
    this.deps.broadcastLiveSessionRun(sessionId);
    const release = () => {
      trackedPromises.delete(promise);
      if (trackedPromises.size === 0) {
        this.terminatingSessionRuns.delete(sessionId);
      }
      if (!this.startingSessionRuns.has(sessionId) && !this.inFlightSessionRuns.has(sessionId) && !this.terminatingSessionRuns.has(sessionId)) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
      }
      this.releaseCancellationState(sessionId);
    };
    promise.then(release, release);
  }

  reset(): void {
    for (const sessionId of new Set([...this.startingSessionRuns, ...this.inFlightSessionRuns])) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
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

  cancelRun(sessionId: string): void {
    const controller = this.sessionRunControllers.get(sessionId);
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
        this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      return;
    }

    this.pendingSessionRunCancels.add(sessionId);
    controller.abort();
    this.setRuntimeLiveState(sessionId, this.deps.getLiveSessionRun(sessionId));
    this.deps.broadcastLiveSessionRun(sessionId);
  }

  async stopSessionTurn(sessionId: string, incarnationId: string, expectedTurnId: string, assertAuthorized?: () => void | Promise<void>): Promise<{ outcome: "applied" | "not-applied"; turnId: string }> {
    const session = await this.deps.getSession(sessionId);
    await assertAuthorized?.();
    const live = this.deps.getLiveSessionRun(sessionId);
    if (!expectedTurnId?.trim() || !incarnationId?.trim() || !session || getSessionIncarnationId(session) !== incarnationId
      || live?.sessionTurnId !== expectedTurnId || !this.inFlightSessionRuns.has(sessionId)
      || this.finishingSessionTurns.has(sessionId)) return { outcome: "not-applied", turnId: expectedTurnId };
    this.cancelRun(sessionId);
    return { outcome: "applied", turnId: expectedTurnId };
  }

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

  steerSessionTurn(sessionId: string, request: SteerSessionTurnRequest): Promise<SteerSessionTurnResult> {
    return this.sendSessionInput(sessionId, request);
  }

  async steerChildSessionTurn(target: SessionTurnQueueOwner, turnId: string, message: string,
    source: SessionTurnQueueOwner & { turnId: string }, assertCurrent: () => void): Promise<SessionSteerResult> {
    let parent: ParentSessionInput | undefined;
    try {
      // Capture one native target. Never resolve a later Turn after asynchronous preparation.
      const live = this.deps.getLiveSessionRun(target.sessionId);
      if (live?.sessionTurnId !== turnId || !live.turnId) throw new Error("The selected WithMate Turn is not running.");
      const nativeTurnId = live.turnId;
      const [sender, session] = await Promise.all([this.deps.getSession(source.sessionId), this.deps.getSession(target.sessionId)]);
      assertCurrent();
      if (!sender || getSessionIncarnationId(sender) !== source.incarnationId || !session || getSessionIncarnationId(session) !== target.incarnationId
        || session.parentSessionId !== sender.id || session.rootSessionId !== sender.rootSessionId) throw new Error("The saved parent or child identity changed.");
      parent = { turnId, assertCurrent, dispatched: false, messageSeq: null, origin: {
        kind: "session", operation: "steer", actorKind: "main", actorSessionId: sender.id, actorIncarnationId: source.incarnationId,
        actorTurnId: source.turnId, actorSnapshot: captureSessionTurnQueueDisplay(sender),
        targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId, targetSnapshot: captureSessionTurnQueueDisplay(session),
      } };
      await this.sendSessionInput(target.sessionId, { expectedTurnId: nativeTurnId, userMessage: message }, undefined, undefined, parent);
      return { outcome: "applied", turnId, messageSeq: parent.messageSeq };
    } catch (error) {
      return { outcome: parent?.dispatched ? "unknown" : "not-applied", turnId, messageSeq: parent?.messageSeq ?? null,
        reason: error instanceof Error ? error.message : "The Steer result could not be confirmed." };
    }
  }

  answerSessionQuestion(sessionId: string, turnId: string, message: string, answer: string): Promise<SteerSessionTurnResult> {
    return this.sendSessionInput(sessionId, { expectedTurnId: turnId, userMessage: answer }, undefined, message);
  }

  steerQueuedSessionTurn(receipt: SessionTurnQueueReceipt, expectedTurnId: string): Promise<SteerSessionTurnResult> {
    if (!receipt.dispatched) return Promise.reject(new Error("The queued input does not have a fixed dispatch snapshot."));
    return this.sendSessionInput(receipt.sessionId, { expectedTurnId, userMessage: receipt.dispatched.request.userMessage }, receipt);
  }

  private sendSessionInput(sessionId: string, request: SteerSessionTurnRequest, queued?: SessionTurnQueueReceipt, providerMessage?: string, parent?: ParentSessionInput): Promise<SteerSessionTurnResult> {
    const preflightError = (message: string) => queued ? new QueuedInputPreDispatchError(message) : new Error(message);
    if (!request || typeof request.expectedTurnId !== "string" || !request.expectedTurnId.trim()
      || typeof request.userMessage !== "string" || !request.userMessage.trim()) {
      return Promise.reject(preflightError("The active turn and a message are required."));
    }
    if (this.pendingSessionInputs.has(sessionId)) return Promise.reject(preflightError("Session input is already being sent."));
    const runController = this.sessionRunControllers.get(sessionId);
    const appendInput = this.appendSessionInput.get(sessionId);
    const assertActiveTurn = () => {
      parent?.assertCurrent();
      const live = this.deps.getLiveSessionRun(sessionId);
      if (!this.inFlightSessionRuns.has(sessionId) || !appendInput || this.appendSessionInput.get(sessionId) !== appendInput
        || !runController || this.sessionRunControllers.get(sessionId) !== runController
        || this.sessionRunControllers.get(sessionId)?.signal.aborted || this.terminatingSessionRuns.has(sessionId) || this.finishingSessionTurns.has(sessionId)
        || live?.cancellationState || live?.turnId !== request.expectedTurnId || live.inputAvailable !== true
        || (parent && live.sessionTurnId !== parent.turnId)) {
        throw preflightError("The selected turn no longer accepts input. Your draft is preserved.");
      }
    };
    let dispatched = false;
    // Register the input before preparation starts, including synchronous deps.
    const operation = Promise.resolve().then(async () => {
      assertActiveTurn();
      const session = await this.deps.getSession(sessionId);
      if (!session || session.provider !== "codex" || isReadOnlySession(session)) throw new Error("This session cannot accept input.");
      if (parent && (getSessionIncarnationId(session) !== parent.origin.targetIncarnationId || session.parentSessionId !== parent.origin.actorSessionId)) {
        throw new Error("The child Session identity or parent changed.");
      }
      if (queued && (getSessionIncarnationId(session) !== queued.incarnationId || session.provider !== queued.dispatched!.provider
        || session.workspacePath !== queued.dispatched!.workspacePath || queued.inputTurnId !== request.expectedTurnId
        || queued.turnId !== this.deps.getLiveSessionRun(sessionId)?.sessionTurnId)) {
        throw new Error("The queued Session owner or execution target changed.");
      }
      const adapter = this.deps.getProviderCodingAdapter(session.provider);
      if (!adapter.steerSessionTurn) throw new Error("This provider cannot accept input during a turn.");
      const providerSession = await (this.deps.resolveProviderSession?.(session) ?? session);
      let preview: ComposerPreview;
      if (queued) {
        if (!this.deps.assertCapturedComposerAttachmentsAvailable) throw new Error("Captured attachment validation is unavailable.");
        await this.deps.assertCapturedComposerAttachmentsAvailable(providerSession, queued.dispatched!.attachments);
        preview = { attachments: queued.dispatched!.attachments, errors: [] };
      } else {
        preview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
      }
      if (preview.errors.length) throw new Error(preview.errors[0]);
      if (queued && !getProviderAppSettings(await this.deps.getAppSettings(), session.provider).enabled) {
        throw new Error("This provider is disabled in Settings.");
      }
      assertActiveTurn();
      const direct = queued ? undefined : this.directSessionInput.get(sessionId);
      if (!queued && !direct) throw new Error("Durable Session input storage is unavailable.");
      this.dispatchedSessionInputs.add(sessionId);
      let inputSeq: number | undefined;
      try {
        if (direct) inputSeq = await direct.begin(request.userMessage.trim(), request.expectedTurnId, preview.attachments, parent?.origin);
        if (parent) parent.messageSeq = inputSeq ?? null;
        assertActiveTurn();
        dispatched = true;
        if (parent) parent.dispatched = true;
        const inputText = providerMessage ?? request.userMessage.trim();
        const result = await adapter.steerSessionTurn({ sessionId, expectedTurnId: request.expectedTurnId,
          userMessage: queued ? composeProviderInput(inputText, queuedInputProvenance(queued, queued.dispatched!))
            : parent ? composeProviderInput(inputText, { origin: parent.origin, originalChanged: false }) : inputText, attachments: preview.attachments });
        if (result.turnId !== request.expectedTurnId) throw new Error("The provider did not confirm input for the selected turn.");
        if (!appendInput || this.appendSessionInput.get(sessionId) !== appendInput) throw new Error("The selected turn ended before input could be saved.");
        if (direct && inputSeq !== undefined) await direct.settle(inputSeq, "confirmed");
        else await appendInput(request.userMessage.trim(), queued, request.expectedTurnId);
        return result;
      } catch (error) {
        if (direct && inputSeq !== undefined) await direct.settle(inputSeq, dispatched ? "unknown" : "not-sent");
        throw error;
      } finally {
        this.dispatchedSessionInputs.delete(sessionId);
      }
    }).catch((error: unknown) => {
      if (queued && !dispatched && !(error instanceof QueuedInputPreDispatchError)) {
        throw new QueuedInputPreDispatchError(error instanceof Error ? error.message : "Session input preparation failed.");
      }
      throw error;
    });
    this.pendingSessionInputs.set(sessionId, operation);
    const release = () => {
      if (this.pendingSessionInputs.get(sessionId) === operation) this.pendingSessionInputs.delete(sessionId);
      this.releaseCancellationState(sessionId);
    };
    void operation.then(release, release);
    return operation;
  }

  canAcceptSessionInput(sessionId: string, expectedTurnId?: string): boolean {
    const live = this.deps.getLiveSessionRun(sessionId);
    return this.inFlightSessionRuns.has(sessionId) && this.appendSessionInput.has(sessionId)
      && !this.sessionRunControllers.get(sessionId)?.signal.aborted && !this.terminatingSessionRuns.has(sessionId)
      && !this.finishingSessionTurns.has(sessionId)
      && !live?.cancellationState && live?.inputAvailable === true && Boolean(live.turnId)
      && (expectedTurnId === undefined || live.turnId === expectedTurnId);
  }

  runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
    return this.trackRun(this.executeSessionTurn(sessionId, request));
  }

  async runQueuedSessionTurn(receipt: SessionTurnQueueReceipt, onStarted: QueuedTurnContext["onStarted"]): Promise<SessionTurnQueueDispatchResult> {
    if (!receipt.dispatched) throw new Error("The queued turn does not have a fixed dispatch snapshot.");
    const queued: QueuedTurnContext = { receipt, input: receipt.dispatched, onStarted };
    try {
      await this.trackRun(this.executeSessionTurn(receipt.sessionId, queued.input.request, queued));
    } catch (error) {
      if (queued.outcome) return queued.outcome;
      if (error instanceof QueuedTurnPreStartCanceledError && !this.isRunInFlight(receipt.sessionId)) {
        return { state: "canceled", reason: error.message };
      }
      if (error instanceof QueuedTurnPreflightError) return { state: "failed", reason: error.message };
      throw error;
    }
    if (!queued.outcome) throw new Error("The queued turn terminal commit was not confirmed.");
    return queued.outcome;
  }

  async waitForPendingRuns(): Promise<void> {
    while (this.pendingRuns.size || this.terminatingSessionRuns.size || this.pendingSessionInputs.size) {
      await Promise.allSettled([...this.pendingRuns, ...[...this.terminatingSessionRuns.values()].flatMap((values) => [...values]), ...this.pendingSessionInputs.values()]);
    }
  }

  private trackRun(run: Promise<Session>): Promise<Session> {
    this.pendingRuns.add(run);
    void run.then(() => this.pendingRuns.delete(run), () => this.pendingRuns.delete(run));
    return run;
  }

  private async executeSessionTurn(sessionId: string, request: RunSessionTurnRequest, queued?: QueuedTurnContext): Promise<Session> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const runAbortController = new AbortController();
    if (this.isRunInFlight(sessionId) || this.waitingSessionRunAdmissions.has(sessionId)) {
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
          await this.deps.runSessionAdmissionExclusive(sessionId, admit, runAbortController.signal);
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
          if (this.sessionRunControllers.get(sessionId) === runAbortController && !this.terminatingSessionRuns.has(sessionId)) {
            this.sessionRunControllers.delete(sessionId);
          }
          this.pendingSessionRunCancels.delete(sessionId);
        }
        if (this.sessionRunControllers.get(sessionId) === runAbortController && !this.terminatingSessionRuns.has(sessionId)) {
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
        () => this.waitingSessionRunAdmissions.has(sessionId) || this.startingSessionRuns.has(sessionId),
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
    const setupPromise = this.runSessionTurnInternal(sessionId, request, runAbortController, queued);
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
      if (!this.inFlightSessionRuns.has(sessionId) && !this.terminatingSessionRuns.has(sessionId)) {
        this.sessionRunControllers.delete(sessionId);
        this.pendingSessionRunCancels.delete(sessionId);
      }
      this.releaseCancellationState(sessionId);
    }
  }

  private async runSessionTurnInternal(
    sessionId: string,
    request: RunSessionTurnRequest,
    runAbortController: AbortController,
    queued?: QueuedTurnContext,
  ): Promise<Session> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const observedAt = (this.deps.currentDate ?? (() => new Date()))();
    const investigationStartedAt = Date.now();
    const storedSession = await this.deps.getSession(sessionId);
    throwIfRunCanceled(runAbortController.signal, queued);
    if (!storedSession) {
      if (queued) throw new QueuedTurnPreflightError("The session could not be found.");
      throw new Error("The session could not be found.");
    }
    const assertCapturedOwner = (current: Session) => {
      if (queued && (getSessionIncarnationId(current) !== queued.receipt.incarnationId
        || current.provider !== queued.input.provider || current.workspacePath !== queued.input.workspacePath)) {
        throw new QueuedTurnPreflightError("The queued Session owner or execution target changed.");
      }
    };
    assertCapturedOwner(storedSession);
    const resolvedSession = await Promise.resolve(
      this.deps.resolveRuntimeSessionForTurn?.(storedSession) ?? storedSession,
    );
    const shouldResetCharacterAuthoringThread = storedSession.sessionKind === "character-authoring"
      && storedSession.characterRuntimeSnapshot !== null
      && resolvedSession.characterRuntimeSnapshot === null;
    let session = shouldResetCharacterAuthoringThread
      ? { ...resolvedSession, threadId: "" }
      : resolvedSession;
    assertCapturedOwner(session);
    if (shouldResetCharacterAuthoringThread) {
      if (!this.deps.clearCharacterAuthoringRuntimeState) {
        throw new Error("Character authoring runtime storage is unavailable.");
      }
      session = await this.deps.clearCharacterAuthoringRuntimeState(session);
      await this.deps.invalidateProviderSessionThread(storedSession.provider, storedSession.id);
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
      if (queued) throw new QueuedTurnPreflightError("Read-only sessions cannot send messages. Create a new session.");
      throw new Error("Read-only sessions cannot send messages. Create a new session.");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("Enter a message before sending.");
    }

    const providerSession = await (this.deps.resolveProviderSession?.(session) ?? session);
    const capturedAdditionalDirectories = [...providerSession.allowedAdditionalDirectories];
    const capturedCrewFolderPath = await this.deps.resolveCrewFolderPath?.(session.id);
    let composerPreview: ComposerPreview;
    if (queued) {
      if (!this.deps.persistQueuedTurnStart || !this.deps.assertCapturedComposerAttachmentsAvailable) {
        throw new Error("Queued turn persistence or attachment validation is unavailable.");
      }
      try {
        await this.deps.assertCapturedComposerAttachmentsAvailable(providerSession, queued.input.attachments);
      } catch (error) {
        throw new QueuedTurnPreflightError(error instanceof Error ? error.message : "The captured attachment is unavailable.");
      }
      composerPreview = { attachments: queued.input.attachments, errors: [] };
    } else {
      composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    }
    throwIfRunCanceled(runAbortController.signal, queued);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "Failed to resolve attachment.");
    }

    const appSettings = await this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      if (queued) throw new QueuedTurnPreflightError("This provider is disabled in Settings.");
      throw new Error("This provider is disabled in Settings.");
    }

    const { provider } = await this.deps.resolveProviderCatalog(session.provider, session.workspacePath);
    if (provider.id !== session.provider) {
      throw new Error("The selected provider does not match this session.");
    }
    let executionOptions: SessionExecutionOptions;
    try {
      executionOptions = validateSessionExecutionOptions(request.executionOptions, provider);
    } catch (error) {
      if (queued) throw new QueuedTurnPreflightError(error instanceof Error ? error.message : "The captured execution options are unavailable.");
      throw error;
    }
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    let agentRuntimeBinding = await Promise.resolve(
      this.deps.getProviderAgentRuntimeBinding?.({ session, provider }) ?? null,
    );
    const sessionCharacter = await this.deps.resolveSessionCharacter?.(session) ?? null;
    const conversationTimingContext = appSettings.conversationTimingEnabled
      ? await Promise.resolve(
        this.deps.resolveConversationTimingContext?.(session, observedAt) ?? null,
      )
      : null;
    const characterContext = appSettings.characterAffectContextEnabled
      ? await Promise.resolve(
        this.deps.resolveCharacterContext?.(session) ?? null,
      )
      : null;
    throwIfRunCanceled(runAbortController.signal, queued);
    try {
      assertModelEnabled((await this.deps.getAppSettings()).modelAvailability, provider.id, executionOptions.model);
    } catch (error) {
      if (queued) throw new QueuedTurnPreflightError(error instanceof Error ? error.message : "The captured model is unavailable.");
      throw error;
    }
    throwIfRunCanceled(runAbortController.signal, queued);
    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;

    let runningSession: Session;
    let initialLiveState: LiveSessionRunState;
    let runningTurn!: SessionTurnRecord;
    let setupLiveRun = false;
    let setupRunningSessionSaved = false;
    try {
      runningSession = {
        ...session,
        updatedAt: currentTimestampLabel(),
        status: "running",
        runState: "running",
        messages: [...session.messages, { role: "user", text: nextMessage }],
        ...(session.messageCount !== undefined ? { messageCount: session.messageCount + 1 } : {}),
      };

      const runningUpsertStartedAt = Date.now();
      if (queued) {
        queued.startIssued = true;
        const started = await this.deps.persistQueuedTurnStart!(runningSession, session.messageCount ?? session.messages.length, queued.receipt.id,
          buildRunningTurn({ sessionId, createdAt: new Date().toISOString(), session: runningSession, executionOptions }));
        runningSession = started.session;
        runningTurn = started.turn;
        this.unreleasedTurnIds.set(sessionId, String(runningTurn.id));
        if (typeof runningTurn.userMessageSeq !== "number") throw new Error("The queued turn message identity was not persisted.");
        await queued.onStarted({ turnId: String(runningTurn.id), userMessageSeq: runningTurn.userMessageSeq });
      } else {
        runningSession = await this.deps.persistRunningTurnStart(runningSession, session.messageCount ?? session.messages.length);
      }
      setupRunningSessionSaved = true;
      logSessionRunStuckInvestigation("runtime.running-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - runningUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: runningSession.messageCount ?? runningSession.messages.length,
      });
      throwIfRunCanceled(runAbortController.signal);
      this.inFlightSessionRuns.add(sessionId);
      initialLiveState = {
        ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
        ...(queued ? { sessionTurnId: String(runningTurn.id) } : {}),
        backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
        reasoningText: "",
      };
      this.setRuntimeLiveState(sessionId, initialLiveState);
      setupLiveRun = true;

      const runningTurnCreateStartedAt = Date.now();
      if (!queued) {
        runningTurn = await this.deps.createSessionTurn(buildRunningTurn({
          sessionId, createdAt: new Date().toISOString(), session: runningSession, executionOptions,
        }));
        this.unreleasedTurnIds.set(sessionId, String(runningTurn.id));
        initialLiveState = { ...initialLiveState, sessionTurnId: String(runningTurn.id) };
        this.setRuntimeLiveState(sessionId, initialLiveState);
      }
      logSessionRunStuckInvestigation("runtime.running-turn-create.done", {
        sessionId, turnId: runningTurn!.id,
        durationMs: Date.now() - runningTurnCreateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
      });
      this.startingSessionRuns.delete(sessionId);
      this.publishBackgroundEvent({ kind: "run_state", session: runningSession, running: true });
    } catch (error) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
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
        await Promise.resolve(this.deps.checkpointRuntimeMetadata(failedSetup, runningSession!)).catch((cleanupError) => {
          console.warn("Session setup failure cleanup failed", cleanupError);
        });
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      throw error;
    }
    let terminalSettled = false;
    let terminalPersistenceStarted = false;
    let runtimePersistenceFailed = false;
    let liveProgressGeneration = 0;
    let activeRunningSession = runningSession;
    let queuedInputRecoveryError: QueuedInputRuntimeRecoveryError | null = null;
    if (runningSession.provider === "codex" && this.deps.beginRunningInput && this.deps.settleRunningInput) {
      this.directSessionInput.set(sessionId, {
        begin: async (text, nativeTurnId, attachments, origin) => {
          const messageSeq = activeRunningSession.messageCount ?? activeRunningSession.messages.length;
          try {
            activeRunningSession = await this.deps.beginRunningInput!({ ...activeRunningSession, updatedAt: currentTimestampLabel() }, text, runningTurn.id, nativeTurnId, attachments, origin);
          } catch (error) {
            // A lost append reply must not lead to Provider dispatch or a second append.
            const canonical = await this.deps.getSession(sessionId);
            if (canonical && getSessionIncarnationId(canonical) === getSessionIncarnationId(activeRunningSession)
              && canonical.messageCount === messageSeq + 1) {
              activeRunningSession = { ...canonical, messages: [...activeRunningSession.messages, { role: "user", text,
                turnInput: { turnId: String(runningTurn.id), nativeTurnId, attachments, state: "pending", ...(origin ? { origin } : {}) } }] };
              activeRunningSession = await this.deps.settleRunningInput!(activeRunningSession, messageSeq, runningTurn.id, "not-sent");
            } else if (!canonical || canonical.messageCount !== messageSeq) {
              queuedInputRecoveryError = new QueuedInputRuntimeRecoveryError("The direct input append outcome could not be confirmed.");
              throw queuedInputRecoveryError;
            }
            throw error;
          }
          this.deps.broadcastLiveSessionRun(sessionId);
          return messageSeq;
        },
        settle: async (messageSeq, state) => {
          activeRunningSession = await this.deps.settleRunningInput!({ ...activeRunningSession, updatedAt: currentTimestampLabel() }, messageSeq, runningTurn.id, state);
          this.deps.broadcastLiveSessionRun(sessionId);
        },
      });
    }
    if (runningSession.provider === "codex") this.appendSessionInput.set(sessionId, async (text, queuedInput, inputTurnId) => {
      try {
        activeRunningSession = await this.deps.appendRunningInput({ ...activeRunningSession, updatedAt: currentTimestampLabel() }, text, runningTurn.id,
          queuedInput && inputTurnId ? { queueId: queuedInput.id, inputTurnId } : undefined);
      } catch (error) {
        if (!queuedInput || !inputTurnId) throw error;
        try {
          if (!this.deps.getQueuedInputReceipt) throw error;
          const receipt = await this.deps.getQueuedInputReceipt(queuedInput);
          if (receipt?.state !== "completed" || receipt.inputTurnId !== inputTurnId) throw error;
          const canonical = await this.deps.getSession(sessionId);
          if (!canonical || getSessionIncarnationId(canonical) !== queuedInput.incarnationId
            || canonical.messageCount !== (activeRunningSession.messageCount ?? activeRunningSession.messages.length) + 1) throw error;
          activeRunningSession = { ...canonical, messages: [...activeRunningSession.messages, { role: "user", text }] };
        } catch (recoveryError) {
          queuedInputRecoveryError = new QueuedInputRuntimeRecoveryError(recoveryError instanceof Error ? recoveryError.message : "Queued input runtime persistence could not be confirmed.");
          throw queuedInputRecoveryError;
        }
      }
      this.deps.broadcastLiveSessionRun(sessionId);
    });
    const runProviderTurn = async (turnSession: Session) => {
      const progressGeneration = ++liveProgressGeneration;
      const elicitationResponses: Promise<LiveElicitationResponse>[] = [];
      const effectiveTurnSession = { ...await (this.deps.resolveProviderSession?.(turnSession) ?? turnSession),
        allowedAdditionalDirectories: [...capturedAdditionalDirectories] };
      const providerPromise = providerAdapter.runSessionTurn({
        session: effectiveTurnSession,
        runtimeOwner: {
          kind: await this.deps.isAuxiliarySession?.(sessionId) ? "auxiliary" : "main",
          id: sessionId,
          incarnationId: getSessionIncarnationId(turnSession),
        },
        executionOptions,
        sessionFolderPath: await this.deps.resolveSessionFolderPath?.(effectiveTurnSession.id),
        crewFolderPath: capturedCrewFolderPath,
        providerCatalog: provider,
        userMessage: nextMessage,
        ...(queued ? { inputProvenance: queuedInputProvenance(queued.receipt, queued.input) } : {}),
        appSettings,
        attachments: composerPreview.attachments,
        conversationTimingContext: conversationTimingContext ?? undefined,
        characterContext: characterContext ?? undefined,
        agentRuntimeBinding,
        signal: runAbortController.signal,
        onCleanupPending: (completion) => this.trackTerminatingSessionRun(sessionId, completion),
        onApprovalRequest: (approvalRequest, requestSignal) => {
          if (terminalSettled || progressGeneration !== liveProgressGeneration) return "deny";
          const signal = requestSignal ? AbortSignal.any([runAbortController.signal, requestSignal]) : runAbortController.signal;
          const decision = this.deps.waitForApprovalDecision(sessionId, {
            ...approvalRequest,
            textPosition: this.deps.getLiveSessionRun(sessionId)?.assistantText.length ?? 0,
          }, signal);
          return decision;
        },
        onElicitationRequest: (elicitationRequest, requestSignal) => {
          if (terminalSettled || progressGeneration !== liveProgressGeneration) return { action: "cancel" };
          const signal = requestSignal ? AbortSignal.any([runAbortController.signal, requestSignal]) : runAbortController.signal;
          const response = this.deps.waitForElicitationResponse(sessionId, elicitationRequest, signal);
          if (elicitationRequest.delivery === "user-message") elicitationResponses.push(Promise.resolve(response));
          return response;
        },
        onProviderQuotaTelemetry: (telemetry) => {
          this.deps.setProviderQuotaTelemetry(telemetry);
        },
        onSessionContextTelemetry: (telemetry) => {
          this.deps.setSessionContextTelemetry(telemetry);
        },
      }, (state, changes) => {
        if (terminalSettled || progressGeneration !== liveProgressGeneration) {
          return;
        }

        const currentLiveState = this.deps.getLiveSessionRun(sessionId);
        const nextLiveState: LiveSessionRunState = {
          ...state,
          sessionTurnId: String(runningTurn.id),
          steps: changes.snapshot === false
            ? applyProviderProgressChanges(currentLiveState?.steps ?? [], changes.steps) : state.steps,
          backgroundTasks: changes.snapshot === false
            ? applyProviderProgressChanges(currentLiveState?.backgroundTasks ?? [], changes.backgroundTasks) : state.backgroundTasks,
          reasoningText: state.reasoningText ?? currentLiveState?.reasoningText ?? "",
          approvalRequest: currentLiveState?.approvalRequest ?? null,
          elicitationRequest: currentLiveState?.elicitationRequest ?? null,
          elicitationRequests: currentLiveState?.elicitationRequests,
          elicitationRecords: placeElicitationRecords(currentLiveState?.elicitationRecords, state.assistantQuestionRanges),
        };
        this.setRuntimeLiveState(sessionId, nextLiveState);
      });
      try {
        return await waitForProviderTurnWithCancelDeadline(
        providerPromise,
        runAbortController.signal,
        this.deps.providerCancelGraceMs ?? DEFAULT_PROVIDER_CANCEL_GRACE_MS,
        () => buildCanceledPartialResult(this.deps.getLiveSessionRun(sessionId)),
        (promise) => this.trackTerminatingSessionRun(sessionId, promise),
        );
      } finally {
        this.finishingSessionTurns.add(sessionId);
        const live = this.deps.getLiveSessionRun(sessionId);
        if (live?.inputAvailable) {
          this.setRuntimeLiveState(sessionId, { ...live, inputAvailable: false });
          this.deps.broadcastLiveSessionRun(sessionId);
        }
        const pendingInput = this.pendingSessionInputs.get(sessionId);
        if (pendingInput && this.dispatchedSessionInputs.has(sessionId)) await pendingInput.catch(() => undefined);
        this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
        await Promise.all(elicitationResponses);
        if (queuedInputRecoveryError) throw queuedInputRecoveryError;
      }
    };

    let providerAgentRuntimeTurnHandle: unknown;
    try {
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
      let result: RunSessionTurnResult | null = null;
      let didInternalRetry = false;
      while (true) {
        try {
          result = await runProviderTurn(activeRunningSession);
          logSessionRunStuckInvestigation("runtime.provider-turn.done", {
            sessionId,
            clientRequestId,
            elapsedMs: Date.now() - investigationStartedAt,
            assistantChars: result.assistantText.length,
            operationCount: result.artifact?.operationTimeline?.length ?? 0,
            hasThreadId: (result.threadId ?? "").trim().length > 0,
          });
          break;
        } catch (error) {
          const providerTurnError = error instanceof ProviderTurnError ? error : null;
          const shouldRetry =
            activeRunningSession.provider !== "codex" && activeRunningSession.provider !== "opencode" &&
            !didInternalRetry &&
            !isCanceledRunError(error) &&
            !(await this.deps.isAuxiliarySession?.(sessionId)) &&
            shouldRetryUnusableThreadRun(error, providerTurnError?.partialResult);

          if (!shouldRetry) {
            throw error;
          }

          didInternalRetry = true;
          liveProgressGeneration += 1;
          if (this.deps.resetProviderSessionThread) {
            await Promise.resolve(this.deps.resetProviderSessionThread(activeRunningSession.provider, sessionId));
          } else {
            await Promise.resolve(this.deps.invalidateProviderSessionThread(activeRunningSession.provider, sessionId));
          }
          if (activeRunningSession.threadId) {
            const resetSession: Session = {
              ...activeRunningSession,
              threadId: "",
              updatedAt: currentTimestampLabel(),
            };
            try {
              activeRunningSession = await this.deps.checkpointRuntimeMetadata(resetSession, activeRunningSession);
            } catch (error) {
              runtimePersistenceFailed = true;
              throw error;
            }
          }
          this.setRuntimeLiveState(sessionId, {
            ...buildEmptyLiveSessionRunState(sessionId, ""),
            sessionTurnId: String(runningTurn.id),
            backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
          });
        }
      }
      if (!result) {
        throw new Error("The provider did not return a completed turn.");
      }
      const completedAt = new Date().toISOString();

      terminalSettled = true;
      const completedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: "idle",
        threadId: result.threadId ?? activeRunningSession.threadId,
        ...(activeRunningSession.messageCount !== undefined ? { messageCount: activeRunningSession.messageCount + 1 } : {}),
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
      const assistantMessageIndex = (completedSession.messageCount ?? completedSession.messages.length) - 1;

      const completedSessionUpsertStartedAt = Date.now();
      const completedThreadId = pickPreferredThreadId(result.threadId, completedSession.threadId);
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
      const storedCompletedSession = await this.deps.appendTerminalSession(completedSession, terminal, {
        confirmedFinalAssistantText: result.lastNonEmptyAssistantMessageText,
      });
      if (queued) queued.outcome = { state: "completed" };
      logSessionRunStuckInvestigation("runtime.completed-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - completedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: completedSession.messageCount ?? completedSession.messages.length,
        storedRunState: storedCompletedSession.runState,
        storedStatus: storedCompletedSession.status,
      });
      activeRunningSession = storedCompletedSession;
      this.publishBackgroundEvent({ kind: "terminal_saved", session: storedCompletedSession, terminal });
      if (!runAbortController.signal.aborted) {
        notifySessionTurnTerminalBestEffort(this.deps.notifySessionTurnTerminal, {
          outcome: "completed",
          session: storedCompletedSession,
          lastNonEmptyAssistantMessageText: result.lastNonEmptyAssistantMessageText ?? "",
        });
      }

      return storedCompletedSession;
    } catch (error: unknown) {
      if (queuedInputRecoveryError || terminalPersistenceStarted || (queued && (terminalSettled || runtimePersistenceFailed))) {
        throw error;
      }
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
      const effectiveError = error;
      const message = effectiveError instanceof Error ? effectiveError.message : String(effectiveError);
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
      const shouldResetFailedThread = activeRunningSession.provider !== "codex" && activeRunningSession.provider !== "opencode" && shouldResetFailedSessionThread(
        error,
        activeRunningSession.threadId,
        partialResult,
        canceled,
      );
      const nextSessionThreadId = (activeRunningSession.provider === "codex" || activeRunningSession.provider === "opencode") && activeRunningSession.threadId
        ? activeRunningSession.threadId
        : shouldResetFailedThread ? "" : failedTurnThreadId;
      const completedAt = new Date().toISOString();
      terminalSettled = true;
      const assistantText = canceled
        ? partialResult?.assistantText.trim() ? `${partialResult.assistantText}\n\nRun canceled.` : "Run canceled."
        : partialResult?.assistantText ?? "";
      const failedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: canceled ? "idle" : "error",
        threadId: nextSessionThreadId,
        ...(activeRunningSession.messageCount !== undefined ? { messageCount: activeRunningSession.messageCount + 1 } : {}),
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
        assistantMessageSeq: (failedSession.messageCount ?? failedSession.messages.length) - 1,
        threadId: failedTurnThreadId,
        errorMessage: failureMessage,
        completedAt,
      };
      const storedFailedSession = await this.deps.appendTerminalSession(failedSession, terminal);
      if (queued) queued.outcome = { state: canceled ? "canceled" : "failed", reason: failureMessage };
      logSessionRunStuckInvestigation("runtime.terminal-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - failedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: failedSession.messageCount ?? failedSession.messages.length,
        storedRunState: storedFailedSession.runState,
        storedStatus: storedFailedSession.status,
      });
      activeRunningSession = storedFailedSession;
      this.publishBackgroundEvent({ kind: "terminal_saved", session: storedFailedSession, terminal });
      if (!canceled && !this.pendingSessionRunCancels.has(sessionId)
        && !runAbortController.signal.aborted) {
        notifySessionTurnTerminalBestEffort(this.deps.notifySessionTurnTerminal, {
          outcome: "failed",
          session: storedFailedSession,
        });
      }
      invalidateProviderSessionThreadBestEffort(
        this.deps.invalidateProviderSessionThread,
        storedFailedSession.provider,
        sessionId,
      );
      return storedFailedSession;
    } finally {
      this.appendSessionInput.delete(sessionId);
      this.directSessionInput.delete(sessionId);
      if (providerAgentRuntimeTurnHandle !== undefined) {
        this.deps.endProviderAgentRuntimeTurn?.(providerAgentRuntimeTurnHandle);
      }
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      } else if (runningSession.provider === "codex" || runningSession.provider === "claude" || runningSession.provider === "opencode") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [3000]);
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      const currentLiveState = this.deps.getLiveSessionRun(sessionId);
      this.finishingSessionTurns.delete(sessionId);
      const preservedBackgroundTasks = currentLiveState?.backgroundTasks ?? [];
      const preservedReasoningText = currentLiveState?.reasoningText ?? "";
      if (preservedBackgroundTasks.length > 0 || preservedReasoningText.trim().length > 0) {
        this.setRuntimeLiveState(sessionId, {
          ...buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId),
          runState: activeRunningSession.runState,
          backgroundTasks: preservedBackgroundTasks,
          reasoningText: preservedReasoningText,
        });
      } else {
        this.setRuntimeLiveState(sessionId, null);
      }
      this.deps.broadcastLiveSessionRun(sessionId);
      this.publishBackgroundEvent({ kind: "run_state", session: activeRunningSession, running: false });
      logSessionRunStuckInvestigation("runtime.finally.done", {
        sessionId,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        activeRunState: activeRunningSession.runState,
        activeStatus: activeRunningSession.status,
        preservedBackgroundTaskCount: preservedBackgroundTasks.length,
        preservedReasoningChars: preservedReasoningText.length,
        liveRunAfterFinally: this.deps.getLiveSessionRun(sessionId) ? "present" : "null",
      });
    }
  }

  private publishBackgroundEvent(event: SessionBackgroundEvent): void {
    const notify = this.deps.onBackgroundEvent;
    if (!notify) return;
    try {
      void Promise.resolve(notify(event)).catch((error) => console.warn("Background lifecycle callback failed", error));
    } catch (error) {
      console.warn("Background lifecycle callback failed", error);
    }
  }

  private terminalElicitationRecords(sessionId: string, result?: RunSessionTurnResult | null): Pick<Session["messages"][number], "elicitationRecords"> {
    const records = placeElicitationRecords(this.deps.getLiveSessionRun(sessionId)?.elicitationRecords, result?.assistantQuestionRanges);
    return records?.length ? {
      elicitationRecords: records.map((record) => ({
        ...record,
        status: record.status === "pending" ? "expired" : record.status,
      })),
    } : {};
  }
}
