import { currentTimestampLabel as defaultCurrentTimestampLabel } from "../../src-shared/time-state.js";
import type { ComposerPreview, LiveApprovalDecision, LiveApprovalRequest, LiveElicitationRequest, LiveElicitationResponse, LiveSessionRunState, ProviderQuotaTelemetry, RunSessionTurnRequest, SessionContextTelemetry, SteerSessionTurnRequest, SteerSessionTurnResult } from "../../src-shared/session/runtime-state.js";
import type { MessageArtifact } from "../../src-shared/session/session-state.js";
import type { ProjectMemoryEntry, SessionMemory } from "../../src-shared/memory/session-memory-state.js";
import { normalizeSessionTurnCorrelation } from "../../src-shared/session/runtime-state.js";
import { validateSessionExecutionOptions, type SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { type CharacterProfile } from "../../src-shared/character/character-state.js";
import { buildLiveRunMessageOperations } from "../../src-shared/session/live-run-message-operations.js";
import type { SessionTurnInput, SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { toProviderTextPreview } from "./provider-payload-limits.js";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { isReadOnlySession, type Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type RunSessionTurnResult,
} from "../providers/provider-runtime.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { SessionTurnTerminalNotification } from "./session-turn-notification-service.js";
import type { ProviderAgentRuntimeBindingProjection } from "../providers/agent-runtime-binding.js";
import type { ConversationTimingContext } from "./conversation-timing.js";
import type { CharacterContextResponse } from "../../src-shared/character-context/character-context-contract.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "./session-run-timeouts.js";


const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";
const DEFAULT_APPRAISAL_READY_RETRY_MS = 1_000;

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
  upsertSession(
    session: Session,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session>;
  persistRunningTurnStart?(session: Session, expectedMessageCount: number): Awaitable<Session>;
  clearCharacterAuthoringRuntimeState?(session: Session): Awaitable<Session>;
  upsertTerminalSession?(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Awaitable<Session>;
  resolveRuntimeSessionForTurn?: (session: Session) => Awaitable<Session>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  resolveProviderSession?: (session: Session) => Awaitable<Session>;
  resolveSessionFolderPath?: (sessionId: string) => Awaitable<string>;
  resolveSessionCharacter?: (session: Session) => Promise<CharacterProfile | null>;
  getAppSettings: () => Awaitable<AppSettings>;
  resolveProviderCatalog(providerId: string | null | undefined, revision?: number | null): Awaitable<{
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  }>;
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
  getSessionMemory(session: Session): Awaitable<SessionMemory>;
  resolveProjectMemoryEntriesForPrompt(
    session: Session,
    userMessage: string,
    sessionMemory: SessionMemory,
  ): Awaitable<ProjectMemoryEntry[]>;
  resolveConversationTimingContext?: (
    session: Session,
    observedAt: Date,
  ) => Awaitable<ConversationTimingContext | null>;
  resolveCharacterContext?: (
    session: Session,
    query: string,
  ) => Awaitable<CharacterContextResponse | null>;
  queueCompletedTurnAppraisal?: (input: {
    session: Session;
    correlationId: string;
    userMessage: string;
    assistantMessage: string;
    assistantMessageIndex: number;
    occurredAt: string;
  }) => Awaitable<void>;
  markCompletedTurnAppraisalReady?: (
    correlationId: string,
  ) => Awaitable<"ready" | "absent" | void>;
  requireDurableCompletedTurnAppraisal?: boolean;
  appraiseCompletedTurn?: () => Awaitable<void>;
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
    provider: ModelCatalogProvider;
    binding: ProviderAgentRuntimeBindingProjection | null;
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
  currentTimestampLabel?: () => string;
  currentDate?: () => Date;
  providerCancelGraceMs?: number;
  appraisalReadyRetryMs?: number;
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

function appraiseCompletedTurnBestEffort(
  appraise: SessionRuntimeServiceDeps["appraiseCompletedTurn"],
): void {
  if (!appraise) {
    return;
  }

  try {
    void Promise.resolve(appraise())
      .catch((error) => console.warn(
        "Character affect turn appraisal failed",
        error instanceof Error ? error.name : "UnknownError",
      ));
  } catch (error) {
    console.warn(
      "Character affect turn appraisal failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

async function markCompletedTurnAppraisalReadyWithRetry(
  markReady: NonNullable<SessionRuntimeServiceDeps["markCompletedTurnAppraisalReady"]>,
  correlationId: string,
  retryMs: number,
): Promise<boolean> {
  while (true) {
    try {
      const result = await markReady(correlationId);
      return result !== "absent";
    } catch (error) {
      console.warn(
        "Character affect turn appraisal readiness update failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

function completeCompletedTurnAppraisalBestEffort(
  markReady: SessionRuntimeServiceDeps["markCompletedTurnAppraisalReady"],
  appraise: SessionRuntimeServiceDeps["appraiseCompletedTurn"],
  correlationId: string,
  retryMs: number,
): void {
  setTimeout(() => {
    void Promise.resolve().then(async () => {
      if (markReady) {
        const ready = await markCompletedTurnAppraisalReadyWithRetry(
          markReady,
          correlationId,
          retryMs,
        );
        if (!ready) {
          return;
        }
      }
      appraiseCompletedTurnBestEffort(appraise);
    })
    .catch((error) => console.warn(
      "Character affect turn background completion failed",
      error instanceof Error ? error.name : "UnknownError",
    ));
  }, 0);
}

function buildCanceledPartialResult(
  liveState: LiveSessionRunState | null,
): RunSessionTurnResult {
  return {
    threadId: liveState?.threadId || null,
    assistantText: liveState?.assistantText ?? "",
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

function throwIfRunCanceled(signal: AbortSignal): void {
  if (signal.aborted) {
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

function formatProviderFailureNotice(params: {
  providerId: Session["provider"];
  reason: ProviderTurnError["reason"] | null;
  message: string;
  canceled: boolean;
}): string {
  if (params.canceled) {
    return "Run canceled.";
  }

  if (params.reason === "usage_limit") {
    return formatProviderUsageLimitMessage(params.providerId, params.message);
  }

  return `The run failed.\n${params.message}`;
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
  session: Pick<Session, "provider" | "threadId" | "messages">;
  executionOptions: SessionExecutionOptions;
}): SessionTurnInput {
  return {
    sessionId: params.sessionId, createdAt: params.createdAt, phase: "running",
    provider: params.session.provider, model: params.executionOptions.model,
    reasoningEffort: params.executionOptions.reasoningEffort,
    approvalMode: params.executionOptions.approvalMode,
    sandboxMode: params.executionOptions.codexSandboxMode,
    userMessageSeq: Math.max(0, params.session.messages.length - 1),
    threadId: params.session.threadId, errorMessage: "",
  };
}

export class SessionRuntimeService {
  private readonly inFlightSessionRuns = new Set<string>();
  private readonly startingSessionRuns = new Set<string>();
  private readonly terminatingSessionRuns = new Map<string, Set<Promise<unknown>>>();
  private readonly waitingSessionRunAdmissions = new Set<string>();
  private readonly pendingSessionRunCancels = new Set<string>();
  private readonly sessionRunControllers = new Map<string, AbortController>();
  private readonly pendingSessionInputs = new Map<string, Promise<SteerSessionTurnResult>>();
  private readonly dispatchedSessionInputs = new Set<string>();
  private readonly finishingSessionTurns = new Set<string>();
  private readonly appendSessionInput = new Map<string, (text: string) => Promise<void>>();

  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  private async upsertTerminalSession(
    session: Session,
    terminalCommit: SessionTurnTerminalCommit,
    runningTurn: SessionTurnRecord,
    options?: { confirmedFinalAssistantText?: string | null },
  ): Promise<Session> {
    if (this.deps.upsertTerminalSession) {
      return this.deps.upsertTerminalSession(session, terminalCommit, options);
    }
    const stored = await this.deps.upsertSession(session, options);
    const { id: _id, ...input } = runningTurn;
    const { turnId, ...terminalInput } = terminalCommit;
    await this.deps.updateSessionTurn(turnId, { ...input, ...terminalInput });
    return stored;
  }

  hasInFlightRuns(): boolean {
    return this.inFlightSessionRuns.size > 0
      || this.startingSessionRuns.size > 0
      || this.terminatingSessionRuns.size > 0;
  }

  isRunInFlight(sessionId: string): boolean {
    return this.inFlightSessionRuns.has(sessionId)
      || this.startingSessionRuns.has(sessionId)
      || this.terminatingSessionRuns.has(sessionId);
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
    const liveState = this.deps.getLiveSessionRun(sessionId);
    if (!liveState?.cancellationState) {
      return;
    }
    const { cancellationState: _cancellationState, ...rest } = liveState;
    this.deps.setLiveSessionRun(sessionId, rest.backgroundTasks.length > 0 || (rest.reasoningText ?? "").trim().length > 0 ? rest : null);
    this.deps.broadcastLiveSessionRun(sessionId);
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
    if (!request || typeof request.expectedTurnId !== "string" || !request.expectedTurnId.trim()
      || typeof request.userMessage !== "string" || !request.userMessage.trim()) {
      return Promise.reject(new Error("The active turn and a message are required."));
    }
    if (this.pendingSessionInputs.has(sessionId)) return Promise.reject(new Error("Session input is already being sent."));
    const runController = this.sessionRunControllers.get(sessionId);
    const appendInput = this.appendSessionInput.get(sessionId);
    const assertActiveTurn = () => {
      const live = this.deps.getLiveSessionRun(sessionId);
      if (!this.inFlightSessionRuns.has(sessionId) || !appendInput || this.appendSessionInput.get(sessionId) !== appendInput
        || !runController || this.sessionRunControllers.get(sessionId) !== runController
        || this.sessionRunControllers.get(sessionId)?.signal.aborted || this.terminatingSessionRuns.has(sessionId) || this.finishingSessionTurns.has(sessionId)
        || live?.cancellationState || live?.turnId !== request.expectedTurnId || live.inputAvailable !== true) {
        throw new Error("The selected turn no longer accepts input. Your draft is preserved.");
      }
    };
    const operation = (async () => {
      assertActiveTurn();
      const session = await this.deps.getSession(sessionId);
      if (!session || session.provider !== "codex" || isReadOnlySession(session)) throw new Error("This session cannot accept input.");
      const adapter = this.deps.getProviderCodingAdapter(session.provider);
      if (!adapter.steerSessionTurn) throw new Error("This provider cannot accept input during a turn.");
      const providerSession = await (this.deps.resolveProviderSession?.(session) ?? session);
      const preview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
      if (preview.errors.length) throw new Error(preview.errors[0]);
      assertActiveTurn();
      this.dispatchedSessionInputs.add(sessionId);
      try {
        const result = await adapter.steerSessionTurn({ sessionId, expectedTurnId: request.expectedTurnId, userMessage: request.userMessage.trim(), attachments: preview.attachments });
        if (result.turnId !== request.expectedTurnId) throw new Error("The provider did not confirm input for the selected turn.");
        if (!appendInput || this.appendSessionInput.get(sessionId) !== appendInput) throw new Error("The selected turn ended before input could be saved.");
        await appendInput(request.userMessage.trim());
        return result;
      } finally {
        this.dispatchedSessionInputs.delete(sessionId);
      }
    })();
    this.pendingSessionInputs.set(sessionId, operation);
    const release = () => { if (this.pendingSessionInputs.get(sessionId) === operation) this.pendingSessionInputs.delete(sessionId); };
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

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
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
        throwIfRunCanceled(runAbortController.signal);
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
    const setupPromise = this.runSessionTurnInternal(sessionId, request, runAbortController);
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
  ): Promise<Session> {
    const { clientRequestId, submitSource } = normalizeSessionTurnCorrelation(request);
    const observedAt = (this.deps.currentDate ?? (() => new Date()))();
    const investigationStartedAt = Date.now();
    const storedSession = await this.deps.getSession(sessionId);
    throwIfRunCanceled(runAbortController.signal);
    if (!storedSession) {
      throw new Error("The session could not be found.");
    }
    const resolvedSession = await Promise.resolve(
      this.deps.resolveRuntimeSessionForTurn?.(storedSession) ?? storedSession,
    );
    const shouldResetCharacterAuthoringThread = storedSession.sessionKind === "character-authoring"
      && storedSession.characterRuntimeSnapshot !== null
      && resolvedSession.characterRuntimeSnapshot === null;
    let session = shouldResetCharacterAuthoringThread
      ? { ...resolvedSession, threadId: "" }
      : resolvedSession;
    if (shouldResetCharacterAuthoringThread) {
      if (!this.deps.clearCharacterAuthoringRuntimeState) {
        throw new Error("Character authoring runtime storage is unavailable.");
      }
      session = await this.deps.clearCharacterAuthoringRuntimeState(session);
      await this.deps.invalidateProviderSessionThread(storedSession.provider, storedSession.id);
    }
    throwIfRunCanceled(runAbortController.signal);
    logSessionRunStuckInvestigation("runtime.start", {
      sessionId,
      clientRequestId,
      provider: session.provider,
      runState: session.runState,
      status: session.status,
      messageCount: session.messages.length,
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
      throw new Error("Read-only sessions cannot send messages. Create a new session.");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("Enter a message before sending.");
    }

    const providerSession = await (this.deps.resolveProviderSession?.(session) ?? session);
    const composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    throwIfRunCanceled(runAbortController.signal);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "Failed to resolve attachment.");
    }

    const appSettings = await this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new Error("This provider is disabled in Settings.");
    }

    const { snapshot, provider } = await this.deps.resolveProviderCatalog(session.provider, request.executionOptions?.catalogRevision);
    if (provider.id !== session.provider) {
      throw new Error("The selected provider does not match this session.");
    }
    const executionOptions = validateSessionExecutionOptions(request.executionOptions, provider, snapshot.revision);
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    let agentRuntimeBinding = await Promise.resolve(
      this.deps.getProviderAgentRuntimeBinding?.({ session, provider }) ?? null,
    );
    const sessionMemory = await this.deps.getSessionMemory(session);
    const projectMemoryEntries = await this.deps.resolveProjectMemoryEntriesForPrompt(session, nextMessage, sessionMemory);
    const sessionCharacter = await this.deps.resolveSessionCharacter?.(session) ?? null;
    const conversationTimingContext = appSettings.conversationTimingEnabled
      ? await Promise.resolve(
        this.deps.resolveConversationTimingContext?.(session, observedAt) ?? null,
      )
      : null;
    const characterContext = appSettings.characterAffectContextEnabled
      ? await Promise.resolve(
        this.deps.resolveCharacterContext?.(session, nextMessage) ?? null,
      )
      : null;
    throwIfRunCanceled(runAbortController.signal);
    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;

    let runningSession: Session;
    let initialLiveState: LiveSessionRunState;
    let runningTurn: SessionTurnRecord;
    let setupLiveRun = false;
    let setupRunningSessionSaved = false;
    try {
      runningSession = {
        ...session,
        updatedAt: currentTimestampLabel(),
        status: "running",
        runState: "running",
        messages: [...session.messages, { role: "user", text: nextMessage }],
      };

      const runningUpsertStartedAt = Date.now();
      runningSession = await (
        this.deps.persistRunningTurnStart?.(runningSession, session.messages.length)
        ?? this.deps.upsertSession(runningSession)
      );
      setupRunningSessionSaved = true;
      logSessionRunStuckInvestigation("runtime.running-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - runningUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: runningSession.messages.length,
      });
      throwIfRunCanceled(runAbortController.signal);
      this.inFlightSessionRuns.add(sessionId);
      initialLiveState = {
        ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
        backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
        reasoningText: "",
      };
      this.setRuntimeLiveState(sessionId, initialLiveState);
      setupLiveRun = true;

      const runningTurnCreateStartedAt = Date.now();
      runningTurn = await this.deps.createSessionTurn(buildRunningTurn({
        sessionId, createdAt: new Date().toISOString(), session: runningSession, executionOptions,
      }));
      logSessionRunStuckInvestigation("runtime.running-turn-create.done", {
        sessionId, turnId: runningTurn.id,
        durationMs: Date.now() - runningTurnCreateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
      });
      this.startingSessionRuns.delete(sessionId);
    } catch (error) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      if (setupLiveRun) {
        this.setRuntimeLiveState(sessionId, null);
      }
      if (setupRunningSessionSaved) {
        await Promise.resolve(this.deps.upsertSession({
          ...runningSession!,
          updatedAt: currentTimestampLabel(),
          status: "idle",
          runState: "error",
        })).catch((cleanupError) => {
          console.warn("Session setup failure cleanup failed", cleanupError);
        });
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      throw error;
    }
    let terminalSettled = false;
    let terminalPersistenceStarted = false;
    let liveProgressGeneration = 0;
    let activeRunningSession = runningSession;
    if (runningSession.provider === "codex") this.appendSessionInput.set(sessionId, async (text) => {
      activeRunningSession = { ...activeRunningSession, updatedAt: currentTimestampLabel(), messages: [...activeRunningSession.messages, { role: "user", text }] };
      activeRunningSession = await this.deps.upsertSession(activeRunningSession);
      this.deps.broadcastLiveSessionRun(sessionId);
    });
    const runProviderTurn = async (turnSession: Session) => {
      const progressGeneration = ++liveProgressGeneration;
      const effectiveTurnSession = await (this.deps.resolveProviderSession?.(turnSession) ?? turnSession);
      const providerPromise = providerAdapter.runSessionTurn({
        session: effectiveTurnSession,
        executionOptions,
        sessionFolderPath: await this.deps.resolveSessionFolderPath?.(effectiveTurnSession.id),
        sessionMemory,
        projectMemoryEntries,
        providerCatalog: provider,
        userMessage: nextMessage,
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
          const decision = this.deps.waitForApprovalDecision(sessionId, approvalRequest, signal);
          return decision;
        },
        onElicitationRequest: (elicitationRequest, requestSignal) => {
          if (terminalSettled || progressGeneration !== liveProgressGeneration) return { action: "cancel" };
          const signal = requestSignal ? AbortSignal.any([runAbortController.signal, requestSignal]) : runAbortController.signal;
          const response = this.deps.waitForElicitationResponse(sessionId, elicitationRequest, signal);
          return response;
        },
        onProviderQuotaTelemetry: (telemetry) => {
          this.deps.setProviderQuotaTelemetry(telemetry);
        },
        onSessionContextTelemetry: (telemetry) => {
          this.deps.setSessionContextTelemetry(telemetry);
        },
      }, (state) => {
        if (terminalSettled || progressGeneration !== liveProgressGeneration) {
          return;
        }

        const currentLiveState = this.deps.getLiveSessionRun(sessionId);
        const nextLiveState: LiveSessionRunState = {
          ...state,
          reasoningText: state.reasoningText ?? currentLiveState?.reasoningText ?? "",
          approvalRequest: currentLiveState?.approvalRequest ?? null,
          elicitationRequest: currentLiveState?.elicitationRequest ?? null,
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
        else if (pendingInput) this.pendingSessionInputs.delete(sessionId);
      }
    };

    let providerAgentRuntimeTurnHandle: unknown;
    try {
      const providerAgentRuntimeTurn = await Promise.resolve(
        this.deps.beginProviderAgentRuntimeTurn?.({
          session: activeRunningSession,
          provider,
          binding: agentRuntimeBinding,
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
            activeRunningSession.provider !== "codex" &&
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
            activeRunningSession = await this.deps.upsertSession({
              ...activeRunningSession,
              threadId: "",
              updatedAt: currentTimestampLabel(),
            });
          }
          this.setRuntimeLiveState(sessionId, {
            ...buildEmptyLiveSessionRunState(sessionId, ""),
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
        messages: [
          ...activeRunningSession.messages,
          {
            role: "assistant",
            text: result.assistantText,
            artifact: result.artifact,
          },
        ],
      };
      const affectTurnCorrelationId = `turn:${sessionId}:turn:${runningTurn.id}`;
      const assistantMessageIndex = completedSession.messages.length - 1;
      const requiresDurableAppraisal = this.deps.requireDurableCompletedTurnAppraisal === true
        && completedSession.sessionKind === "default"
        && Boolean(completedSession.characterId);
      if (
        requiresDurableAppraisal
        && (!this.deps.queueCompletedTurnAppraisal || !this.deps.markCompletedTurnAppraisalReady)
      ) {
        throw new Error("Default Character Session requires durable affect turn settlement before completion.");
      }
      if (this.deps.queueCompletedTurnAppraisal) {
        await this.deps.queueCompletedTurnAppraisal({
          session: completedSession,
          correlationId: affectTurnCorrelationId,
          userMessage: nextMessage,
          assistantMessage: result.assistantText,
          assistantMessageIndex,
          occurredAt: completedAt,
        });
      }

      const completedSessionUpsertStartedAt = Date.now();
      const completedThreadId = pickPreferredThreadId(result.threadId, completedSession.threadId);
      terminalPersistenceStarted = true;
      const storedCompletedSession = await this.upsertTerminalSession(completedSession, {
        turnId: runningTurn.id,
        sessionId,
        phase: "completed",
        assistantMessageSeq: assistantMessageIndex,
        threadId: completedThreadId,
        errorMessage: "",
        completedAt,
      }, runningTurn, {
        confirmedFinalAssistantText: result.lastNonEmptyAssistantMessageText,
      });
      logSessionRunStuckInvestigation("runtime.completed-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - completedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: completedSession.messages.length,
        storedRunState: storedCompletedSession.runState,
        storedStatus: storedCompletedSession.status,
      });
      activeRunningSession = storedCompletedSession;
      if (!runAbortController.signal.aborted) {
        notifySessionTurnTerminalBestEffort(this.deps.notifySessionTurnTerminal, {
          outcome: "completed",
          session: storedCompletedSession,
          lastNonEmptyAssistantMessageText: result.lastNonEmptyAssistantMessageText ?? "",
        });
      }
      completeCompletedTurnAppraisalBestEffort(
        requiresDurableAppraisal ? this.deps.markCompletedTurnAppraisalReady : undefined,
        this.deps.appraiseCompletedTurn,
        affectTurnCorrelationId,
        this.deps.appraisalReadyRetryMs ?? DEFAULT_APPRAISAL_READY_RETRY_MS,
      );

      return storedCompletedSession;
    } catch (error: unknown) {
      if (terminalPersistenceStarted) {
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
      const shouldResetFailedThread = activeRunningSession.provider !== "codex" && shouldResetFailedSessionThread(
        error,
        activeRunningSession.threadId,
        partialResult,
        canceled,
      );
      const nextSessionThreadId = activeRunningSession.provider === "codex" && activeRunningSession.threadId
        ? activeRunningSession.threadId
        : shouldResetFailedThread ? "" : failedTurnThreadId;
      const completedAt = new Date().toISOString();
      terminalSettled = true;
      const fallbackNotice = formatProviderFailureNotice({
        providerId: activeRunningSession.provider,
        reason: providerErrorReason,
        message,
        canceled,
      });
      const assistantText = partialResult?.assistantText.trim()
        ? `${partialResult.assistantText}\n\n${fallbackNotice}`
        : fallbackNotice;
      const failedSession: Session = {
        ...activeRunningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: canceled ? "idle" : "error",
        threadId: nextSessionThreadId,
        messages: [
          ...activeRunningSession.messages,
          {
            role: "assistant",
            text: assistantText,
            artifact: partialResult?.artifact,
            accent: true,
          },
        ],
      };

      const failedSessionUpsertStartedAt = Date.now();
      const storedFailedSession = await this.upsertTerminalSession(failedSession, {
        turnId: runningTurn.id,
        sessionId,
        phase: canceled ? "canceled" : "failed",
        assistantMessageSeq: failedSession.messages.length - 1,
        threadId: failedTurnThreadId,
        errorMessage: failureMessage,
        completedAt,
      }, runningTurn);
      logSessionRunStuckInvestigation("runtime.terminal-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - failedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: failedSession.messages.length,
        storedRunState: storedFailedSession.runState,
        storedStatus: storedFailedSession.status,
      });
      activeRunningSession = storedFailedSession;
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
      if (providerAgentRuntimeTurnHandle !== undefined) {
        this.deps.endProviderAgentRuntimeTurn?.(providerAgentRuntimeTurnHandle);
      }
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
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

}
