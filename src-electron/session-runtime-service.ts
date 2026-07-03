import {
  currentTimestampLabel as defaultCurrentTimestampLabel,
  type AuditLogEntry,
  type ComposerPreview,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
  type LiveSessionRunState,
  type MessageArtifact,
  type ProviderQuotaTelemetry,
  type ProjectMemoryEntry,
  type RunSessionTurnRequest,
  type SessionContextTelemetry,
  type SessionMemory,
} from "../src/app-state.js";
import { type CharacterProfile } from "../src/character-state.js";
import { buildLiveRunAuditOperations } from "../src/live-run-audit-operations.js";
import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import { isReadOnlySession, type Session } from "../src/session-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { MateStorageState } from "../src/mate/mate-state.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type ProviderPromptComposition,
  type RunSessionTurnResult,
} from "./provider-runtime.js";
import type { ProviderMemoryBindingRuntimeProjection } from "./provider-memory-binding.js";
import { appendQuotaTelemetryToTransportPayload } from "./audit-log-quota.js";
import { appendTransportPayloadFields, calculateAuditDurationMs } from "./audit-log-metadata.js";
import { estimateLogicalPromptTokens } from "./prompt-token-estimate.js";
import { toAuditTextPreview } from "./audit-payload-limits.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

export type SessionRuntimeServiceDeps = {
  getSession(sessionId: string): Awaitable<Session | null>;
  upsertSession(session: Session): Awaitable<Session>;
  resolveRuntimeSessionForTurn?: (session: Session) => Awaitable<Session>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  resolveProviderSession?: (session: Session) => Session;
  resolveSessionCharacter?: (session: Session) => Promise<CharacterProfile | null>;
  getAppSettings: () => AppSettings;
  resolveProviderCatalog(providerId: string | null | undefined, revision?: number | null): {
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  };
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
  getSessionMemory(session: Session): SessionMemory;
  resolveProjectMemoryEntriesForPrompt(
    session: Session,
    userMessage: string,
    sessionMemory: SessionMemory,
  ): ProjectMemoryEntry[];
  createAuditLog(input: CreateAuditLogInput): Awaitable<AuditLogEntry>;
  updateAuditLog(id: number, entry: CreateAuditLogInput): Awaitable<void | AuditLogEntry>;
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
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void;
  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void;
  clearWorkspaceFileIndex(workspacePath: string): void;
  createProviderMemoryBinding?(input: {
    session: Session;
    provider: ModelCatalogProvider;
    character: CharacterProfile | null;
  }): Awaitable<ProviderMemoryBindingRuntimeProjection | null>;
  revokeProviderMemoryBinding?(binding: ProviderMemoryBindingRuntimeProjection): Awaitable<void>;
  broadcastLiveSessionRun(sessionId: string): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
  resolvePendingElicitationRequest(sessionId: string, response: LiveElicitationResponse): void;
  getMateState?: () => MateStorageState;
  currentTimestampLabel?: () => string;
};

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
    partialResult.operations.length > 0 ||
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
    return `${providerLabel}の使用上限に達しました。\n再実行可能時刻: ${retryAt}`;
  }

  const preview = toAuditTextPreview(message) ?? message;
  return `${providerLabel}の使用上限に達しました。\n詳細: ${preview}`;
}

function formatProviderFailureMessage(params: {
  providerId: Session["provider"];
  reason: ProviderTurnError["reason"] | null;
  message: string;
  canceled: boolean;
}): string {
  if (params.canceled) {
    return "ユーザーがキャンセルしたよ。";
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
    return "実行をキャンセルしたよ。";
  }

  if (params.reason === "usage_limit") {
    return formatProviderUsageLimitMessage(params.providerId, params.message);
  }

  return `実行に失敗したよ。\n${params.message}`;
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

function hasMeaningfulLiveRunAuditState(state: LiveSessionRunState): boolean {
  return state.threadId.trim().length > 0
    || state.assistantText.trim().length > 0
    || state.steps.length > 0
    || state.backgroundTasks.length > 0
    || state.usage !== null
    || state.errorMessage.trim().length > 0
    || state.approvalRequest !== null
    || state.elicitationRequest !== null;
}

function buildRunningAuditProgressSignature(entry: CreateAuditLogInput): string {
  return JSON.stringify({
    threadId: entry.threadId,
    assistantText: entry.assistantText,
    operations: entry.operations,
    usage: entry.usage,
    errorMessage: entry.errorMessage,
  });
}

function buildRunningAuditEntry(params: {
  sessionId: string;
  createdAt: string;
  session: Pick<Session, "provider" | "model" | "reasoningEffort" | "approvalMode" | "threadId">;
  logicalPrompt: CreateAuditLogInput["logicalPrompt"];
  threadId?: string;
}): CreateAuditLogInput {
  return {
    sessionId: params.sessionId,
    createdAt: params.createdAt,
    phase: "running",
    provider: params.session.provider,
    model: params.session.model,
    reasoningEffort: params.session.reasoningEffort,
    approvalMode: params.session.approvalMode,
    threadId: params.threadId ?? params.session.threadId,
    logicalPrompt: params.logicalPrompt,
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
  };
}

function hasNonEmptyAssistantText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyRawItemsJson(value: string | null | undefined): value is string {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized !== "[]";
}

function buildAuditOperationMergeKey(operation: CreateAuditLogInput["operations"][number]): string {
  return `${operation.type}\u0000${operation.summary}`;
}

function ensureAuditTransportPayload(
  payload: CreateAuditLogInput["transportPayload"],
): NonNullable<CreateAuditLogInput["transportPayload"]> {
  return payload ?? { summary: "prompt estimate", fields: [] };
}

function mergeTerminalAuditOperations(
  baseOperations: CreateAuditLogInput["operations"],
  terminalOperations: CreateAuditLogInput["operations"] | null | undefined,
): CreateAuditLogInput["operations"] {
  if (!terminalOperations || terminalOperations.length === 0) {
    return baseOperations;
  }

  const absorbedOperationCounts = new Map<string, number>();
  for (const operation of terminalOperations) {
    const key = buildAuditOperationMergeKey(operation);
    absorbedOperationCounts.set(key, (absorbedOperationCounts.get(key) ?? 0) + 1);
  }

  return [
    ...terminalOperations,
    ...baseOperations.filter((operation) => {
      const key = buildAuditOperationMergeKey(operation);
      const absorbedCount = absorbedOperationCounts.get(key) ?? 0;
      if (absorbedCount <= 0) {
        return true;
      }

      absorbedOperationCounts.set(key, absorbedCount - 1);
      return false;
    }),
  ];
}

function buildTerminalAuditEntry(params: {
  baseEntry: CreateAuditLogInput;
  phase: CreateAuditLogInput["phase"];
  session: Pick<Session, "provider" | "model" | "reasoningEffort" | "approvalMode">;
  threadId?: string | null;
  logicalPrompt?: CreateAuditLogInput["logicalPrompt"];
  transportPayload?: CreateAuditLogInput["transportPayload"];
  assistantText?: string | null;
  operations?: CreateAuditLogInput["operations"] | null;
  rawItemsJson?: string | null;
  usage?: CreateAuditLogInput["usage"];
  errorMessage: string;
}): CreateAuditLogInput {
  const { baseEntry } = params;
  return {
    ...baseEntry,
    phase: params.phase,
    provider: params.session.provider,
    model: params.session.model,
    reasoningEffort: params.session.reasoningEffort,
    approvalMode: params.session.approvalMode,
    threadId: pickPreferredThreadId(params.threadId, baseEntry.threadId),
    logicalPrompt: params.logicalPrompt ?? baseEntry.logicalPrompt,
    transportPayload: params.transportPayload ?? baseEntry.transportPayload,
    assistantText: hasNonEmptyAssistantText(params.assistantText) ? params.assistantText : baseEntry.assistantText,
    operations: mergeTerminalAuditOperations(baseEntry.operations, params.operations),
    rawItemsJson: hasNonEmptyRawItemsJson(params.rawItemsJson) ? params.rawItemsJson : baseEntry.rawItemsJson,
    usage: params.usage ?? baseEntry.usage,
    errorMessage: params.errorMessage,
  };
}

export class SessionRuntimeService {
  private readonly inFlightSessionRuns = new Set<string>();
  private readonly sessionRunControllers = new Map<string, AbortController>();

  constructor(private readonly deps: SessionRuntimeServiceDeps) {}

  hasInFlightRuns(): boolean {
    return this.inFlightSessionRuns.size > 0;
  }

  isRunInFlight(sessionId: string): boolean {
    return this.inFlightSessionRuns.has(sessionId);
  }

  reset(): void {
    for (const sessionId of this.inFlightSessionRuns) {
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.sessionRunControllers.get(sessionId)?.abort();
    }
    this.inFlightSessionRuns.clear();
    this.sessionRunControllers.clear();
  }

  cancelRun(sessionId: string): void {
    this.deps.resolvePendingApprovalRequest(sessionId, "deny");
    this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
    const controller = this.sessionRunControllers.get(sessionId);
    if (!controller) {
      return;
    }

    controller.abort();
  }

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
    const investigationStartedAt = Date.now();
    const storedSession = await this.deps.getSession(sessionId);
    if (!storedSession) {
      throw new Error("対象セッションが見つからないよ。");
    }
    const session = await Promise.resolve(this.deps.resolveRuntimeSessionForTurn?.(storedSession) ?? storedSession);
    logSessionRunStuckInvestigation("runtime.start", {
      sessionId,
      provider: session.provider,
      runState: session.runState,
      status: session.status,
      messageCount: session.messages.length,
      hasThreadId: session.threadId.trim().length > 0,
    });

    if (session.runState === "running") {
      throw new Error("このセッションはまだ実行中だよ。");
    }

    if (isReadOnlySession(session)) {
      throw new Error("閲覧専用セッションには送信できないよ。新しいセッションを作成してください。");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("送信するメッセージが空だよ。");
    }

    const providerSession = this.deps.resolveProviderSession?.(session) ?? session;
    const composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "添付の解決に失敗したよ。");
    }

    const appSettings = this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new Error("この provider は Settings で無効になっているよ。");
    }

    const { provider } = this.deps.resolveProviderCatalog(session.provider, session.catalogRevision);
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    const sessionMemory = this.deps.getSessionMemory(session);
    const projectMemoryEntries = this.deps.resolveProjectMemoryEntriesForPrompt(session, nextMessage, sessionMemory);
    const sessionCharacter = await this.deps.resolveSessionCharacter?.(session) ?? null;
    let memoryBinding = await this.createProviderMemoryBindingForSession(session, provider, sessionCharacter);
    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;
    let memoryBindingRevoked = false;
    const revokeMemoryBinding = async () => {
      if (!memoryBinding || memoryBinding.transport === "unsupported" || memoryBindingRevoked) {
        return;
      }
      const bindingToRevoke = memoryBinding;
      memoryBindingRevoked = true;
      await Promise.resolve()
        .then(() => this.deps.revokeProviderMemoryBinding?.(bindingToRevoke))
        .catch((error) => {
          console.warn("Provider memory binding revoke failed", error);
        });
    };
    const resetMemoryBindingAfterProviderInvalidation = async (nextSession: Session) => {
      await revokeMemoryBinding();
      memoryBinding = await this.createProviderMemoryBindingForSession(nextSession, provider, sessionCharacter);
      memoryBindingRevoked = false;
    };
    const refreshMemoryBindingForProviderRetry = async () => {
      this.deps.invalidateProviderSessionThread(activeRunningSession.provider, sessionId);
      await resetMemoryBindingAfterProviderInvalidation(activeRunningSession);
      return memoryBinding;
    };

    let promptForAudit: ProviderPromptComposition;
    let runningSession: Session;
    let runAbortController: AbortController;
    let initialLiveState: LiveSessionRunState;
    let runningAuditEntry: CreateAuditLogInput;
    let runningAuditLog: AuditLogEntry;
    let setupLiveRun = false;
    let setupRunningSessionSaved = false;
    try {
      promptForAudit = providerAdapter.composePrompt({
        session: providerSession,
        sessionMemory,
        projectMemoryEntries,
        character: sessionCharacter ?? undefined,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        memoryBinding,
      });

      runningSession = {
        ...session,
        updatedAt: currentTimestampLabel(),
        status: "running",
        runState: "running",
        messages: [...session.messages, { role: "user", text: nextMessage }],
      };

      const runningUpsertStartedAt = Date.now();
      await this.deps.upsertSession(runningSession);
      logSessionRunStuckInvestigation("runtime.running-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - runningUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: runningSession.messages.length,
      });
      setupRunningSessionSaved = true;
      this.inFlightSessionRuns.add(sessionId);
      runAbortController = new AbortController();
      this.sessionRunControllers.set(sessionId, runAbortController);
      initialLiveState = {
        ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
        backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
        reasoningText: "",
      };
      this.deps.setLiveSessionRun(sessionId, initialLiveState);
      setupLiveRun = true;

      runningAuditEntry = buildRunningAuditEntry({
        sessionId,
        createdAt: new Date().toISOString(),
        session: runningSession,
        logicalPrompt: promptForAudit.logicalPrompt,
      });
      const runningAuditCreateStartedAt = Date.now();
      runningAuditLog = await this.deps.createAuditLog(runningAuditEntry);
      logSessionRunStuckInvestigation("runtime.running-audit-create.done", {
        sessionId,
        auditLogId: runningAuditLog.id,
        durationMs: Date.now() - runningAuditCreateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
      });
    } catch (error) {
      await revokeMemoryBinding();
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      this.sessionRunControllers.delete(sessionId);
      if (setupLiveRun) {
        this.deps.setLiveSessionRun(sessionId, null);
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
        this.deps.clearWorkspaceFileIndex(session.workspacePath);
        this.deps.broadcastLiveSessionRun(sessionId);
      }
      throw error;
    }
    let runningAuditProgressSignature = buildRunningAuditProgressSignature(runningAuditEntry);
    let terminalAuditSettled = false;
    let liveProgressGeneration = 0;
    let auditWriteQueue: Promise<void> = Promise.resolve();
    let auditWriteError: unknown = null;

    let activeRunningSession = runningSession;
    const enqueueAuditWrite = (
      nextRunningAuditEntry: CreateAuditLogInput,
      nextSignature: string,
    ): Promise<void> => {
      auditWriteQueue = auditWriteQueue
        .then(async () => {
          await this.deps.updateAuditLog(runningAuditLog.id, nextRunningAuditEntry);
          runningAuditEntry = nextRunningAuditEntry;
          runningAuditProgressSignature = nextSignature;
        })
        .catch((error) => {
          auditWriteError = auditWriteError ?? error;
        });
      return auditWriteQueue;
    };
    const flushAuditWrites = async () => {
      let observedQueue: Promise<void>;
      do {
        observedQueue = auditWriteQueue;
        await observedQueue;
      } while (observedQueue !== auditWriteQueue);
      if (auditWriteError) {
        throw auditWriteError;
      }
    };
    const syncRunningAuditFromLiveState = async (nextLiveState: LiveSessionRunState) => {
      if (terminalAuditSettled) {
        return;
      }
      this.deps.setLiveSessionRun(sessionId, nextLiveState);
      if (!hasMeaningfulLiveRunAuditState(nextLiveState)) {
        return;
      }

      const nextRunningAuditEntry: CreateAuditLogInput = {
        ...runningAuditEntry,
        phase: "running",
        provider: activeRunningSession.provider,
        model: activeRunningSession.model,
        reasoningEffort: activeRunningSession.reasoningEffort,
        approvalMode: activeRunningSession.approvalMode,
        threadId: pickPreferredThreadId(nextLiveState.threadId, runningAuditEntry.threadId, activeRunningSession.threadId),
        assistantText: nextLiveState.assistantText.trim()
          ? toAuditTextPreview(nextLiveState.assistantText) ?? ""
          : runningAuditEntry.assistantText,
        operations: (() => {
          const operations = buildLiveRunAuditOperations(nextLiveState);
          return operations.length > 0 ? operations : runningAuditEntry.operations;
        })(),
        usage: nextLiveState.usage ?? runningAuditEntry.usage,
        errorMessage: nextLiveState.errorMessage.trim()
          ? toAuditTextPreview(nextLiveState.errorMessage) ?? ""
          : runningAuditEntry.errorMessage,
      };
      const nextSignature = buildRunningAuditProgressSignature(nextRunningAuditEntry);
      if (nextSignature === runningAuditProgressSignature) {
        return;
      }

      await enqueueAuditWrite(nextRunningAuditEntry, nextSignature);
    };
    await syncRunningAuditFromLiveState(initialLiveState);
    const runProviderTurn = (turnSession: Session) => {
      const progressGeneration = ++liveProgressGeneration;
      const effectiveTurnSession = this.deps.resolveProviderSession?.(turnSession) ?? turnSession;
      return providerAdapter.runSessionTurn({
        session: effectiveTurnSession,
        sessionMemory,
        projectMemoryEntries,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        memoryBinding,
        refreshMemoryBindingForRetry: refreshMemoryBindingForProviderRetry,
        signal: runAbortController.signal,
        onApprovalRequest: (approvalRequest) => {
          const decision = this.deps.waitForApprovalDecision(sessionId, approvalRequest, runAbortController.signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          void syncRunningAuditFromLiveState({
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId)),
            approvalRequest,
            elicitationRequest: currentLiveState?.elicitationRequest ?? null,
          }).catch((error) => {
            console.warn("Audit progress update failed", error);
          });
          return decision;
        },
        onElicitationRequest: (elicitationRequest) => {
          const response = this.deps.waitForElicitationResponse(sessionId, elicitationRequest, runAbortController.signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          void syncRunningAuditFromLiveState({
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId)),
            approvalRequest: currentLiveState?.approvalRequest ?? null,
            elicitationRequest,
          }).catch((error) => {
            console.warn("Audit progress update failed", error);
          });
          return response;
        },
        onProviderQuotaTelemetry: (telemetry) => {
          this.deps.setProviderQuotaTelemetry(telemetry);
        },
        onSessionContextTelemetry: (telemetry) => {
          this.deps.setSessionContextTelemetry(telemetry);
        },
      }, (state) => {
        if (terminalAuditSettled || progressGeneration !== liveProgressGeneration) {
          return;
        }

        const currentLiveState = this.deps.getLiveSessionRun(sessionId);
        const nextLiveState: LiveSessionRunState = {
          ...state,
          reasoningText: state.reasoningText ?? currentLiveState?.reasoningText ?? "",
          approvalRequest: currentLiveState?.approvalRequest ?? null,
          elicitationRequest: currentLiveState?.elicitationRequest ?? null,
        };
        void syncRunningAuditFromLiveState(nextLiveState).catch((error) => {
          console.warn("Audit progress update failed", error);
        });
      });
    };

    try {
      let result: RunSessionTurnResult | null = null;
      let didInternalRetry = false;
      while (true) {
        try {
          result = await runProviderTurn(activeRunningSession);
          logSessionRunStuckInvestigation("runtime.provider-turn.done", {
            sessionId,
            elapsedMs: Date.now() - investigationStartedAt,
            assistantChars: result.assistantText.length,
            operationCount: result.operations.length,
            rawItemsChars: result.rawItemsJson.length,
            hasThreadId: (result.threadId ?? "").trim().length > 0,
          });
          break;
        } catch (error) {
          const providerTurnError = error instanceof ProviderTurnError ? error : null;
          const shouldRetry =
            !didInternalRetry &&
            !isCanceledRunError(error) &&
            shouldRetryUnusableThreadRun(error, providerTurnError?.partialResult);

          if (!shouldRetry) {
            throw error;
          }

          didInternalRetry = true;
          liveProgressGeneration += 1;
          this.deps.invalidateProviderSessionThread(activeRunningSession.provider, sessionId);
          await resetMemoryBindingAfterProviderInvalidation(activeRunningSession);
          if (activeRunningSession.threadId) {
            activeRunningSession = await this.deps.upsertSession({
              ...activeRunningSession,
              threadId: "",
              updatedAt: currentTimestampLabel(),
            });
          }
          this.deps.setLiveSessionRun(sessionId, {
            ...buildEmptyLiveSessionRunState(sessionId, ""),
            backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
          });
          const resetAuditEntry = buildRunningAuditEntry({
            sessionId,
            createdAt: runningAuditLog.createdAt,
            session: activeRunningSession,
            logicalPrompt: promptForAudit.logicalPrompt,
            threadId: "",
          });
          const resetAuditSignature = buildRunningAuditProgressSignature(resetAuditEntry);
          await flushAuditWrites();
          runningAuditEntry = resetAuditEntry;
          runningAuditProgressSignature = resetAuditSignature;
          await this.deps.updateAuditLog(runningAuditLog.id, runningAuditEntry);
        }
      }
      if (!result) {
        throw new Error("provider turn result を確定できなかったよ。");
      }

      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
      const logicalPromptEstimate = estimateLogicalPromptTokens(result.logicalPrompt);

      const flushAuditStartedAt = Date.now();
      await flushAuditWrites();
      logSessionRunStuckInvestigation("runtime.audit-flush.done", {
        sessionId,
        durationMs: Date.now() - flushAuditStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
      });
      terminalAuditSettled = true;
      const completedAuditEntry = buildTerminalAuditEntry({
        baseEntry: runningAuditEntry,
        phase: "completed",
        session: activeRunningSession,
        threadId: pickPreferredThreadId(result.threadId, activeRunningSession.threadId),
        logicalPrompt: result.logicalPrompt,
        transportPayload: appendTransportPayloadFields(
          appendQuotaTelemetryToTransportPayload(
            ensureAuditTransportPayload(result.transportPayload),
            result.providerQuotaTelemetry,
          ),
          [
            { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
            { label: "promptEstimatedChars", value: String(logicalPromptEstimate.composed.charCount) },
            { label: "promptEstimatedTokens", value: String(logicalPromptEstimate.composed.estimatedTokens) },
            { label: "promptSystemEstimatedChars", value: String(logicalPromptEstimate.system.charCount) },
            { label: "promptSystemEstimatedTokens", value: String(logicalPromptEstimate.system.estimatedTokens) },
            { label: "promptInputEstimatedChars", value: String(logicalPromptEstimate.input.charCount) },
            { label: "promptInputEstimatedTokens", value: String(logicalPromptEstimate.input.estimatedTokens) },
            { label: "projectMemoryHits", value: String(projectMemoryEntries.length) },
            { label: "attachmentCount", value: String(composerPreview.attachments.length) },
          ],
        ),
        assistantText: result.assistantText,
        operations: result.operations,
        rawItemsJson: result.rawItemsJson,
        usage: result.usage,
        errorMessage: "",
      });
      const completedAuditUpdateStartedAt = Date.now();
      await this.deps.updateAuditLog(runningAuditLog.id, completedAuditEntry);
      logSessionRunStuckInvestigation("runtime.completed-audit-update.done", {
        sessionId,
        auditLogId: runningAuditLog.id,
        durationMs: Date.now() - completedAuditUpdateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        operationCount: completedAuditEntry.operations.length,
      });
      runningAuditEntry = completedAuditEntry;

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

      const completedSessionUpsertStartedAt = Date.now();
      const storedCompletedSession = await this.deps.upsertSession(completedSession);
      logSessionRunStuckInvestigation("runtime.completed-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - completedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: completedSession.messages.length,
        storedRunState: storedCompletedSession.runState,
        storedStatus: storedCompletedSession.status,
      });
      activeRunningSession = storedCompletedSession;
      return storedCompletedSession;
    } catch (error: unknown) {
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
      const message = error instanceof Error ? error.message : String(error);
      const providerErrorReason = providerTurnError?.reason ?? null;
      const failureMessage = formatProviderFailureMessage({
        providerId: activeRunningSession.provider,
        reason: providerErrorReason,
        message,
        canceled,
      });
      const partialResult = providerTurnError?.partialResult;
      const failedAuditThreadId = pickPreferredThreadId(
        partialResult?.threadId,
        runningAuditEntry.threadId,
        this.deps.getLiveSessionRun(sessionId)?.threadId,
        activeRunningSession.threadId,
      );
      const shouldResetFailedThread = shouldResetFailedSessionThread(
        error,
        activeRunningSession.threadId,
        partialResult,
        canceled,
      );
      const nextSessionThreadId = shouldResetFailedThread ? "" : failedAuditThreadId;
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
      const failedLogicalPrompt = partialResult?.logicalPrompt ?? promptForAudit.logicalPrompt;
      const failedLogicalPromptEstimate = estimateLogicalPromptTokens(failedLogicalPrompt);
      if (canceled || shouldResetFailedThread) {
        this.deps.invalidateProviderSessionThread(activeRunningSession.provider, sessionId);
        await revokeMemoryBinding();
      }

      const failedFlushAuditStartedAt = Date.now();
      await flushAuditWrites();
      logSessionRunStuckInvestigation("runtime.audit-flush.done", {
        sessionId,
        durationMs: Date.now() - failedFlushAuditStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        terminalPhase: canceled ? "canceled" : "failed",
      });
      terminalAuditSettled = true;
      const failedAuditEntry = buildTerminalAuditEntry({
        baseEntry: runningAuditEntry,
        phase: canceled ? "canceled" : "failed",
        session: activeRunningSession,
        threadId: failedAuditThreadId,
        logicalPrompt: partialResult?.logicalPrompt ?? promptForAudit.logicalPrompt,
        transportPayload: appendTransportPayloadFields(
          appendQuotaTelemetryToTransportPayload(
            ensureAuditTransportPayload(partialResult?.transportPayload ?? null),
            partialResult?.providerQuotaTelemetry,
          ),
          [
            { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
            { label: "promptEstimatedChars", value: String(failedLogicalPromptEstimate.composed.charCount) },
            { label: "promptEstimatedTokens", value: String(failedLogicalPromptEstimate.composed.estimatedTokens) },
            { label: "promptSystemEstimatedChars", value: String(failedLogicalPromptEstimate.system.charCount) },
            { label: "promptSystemEstimatedTokens", value: String(failedLogicalPromptEstimate.system.estimatedTokens) },
            { label: "promptInputEstimatedChars", value: String(failedLogicalPromptEstimate.input.charCount) },
            { label: "promptInputEstimatedTokens", value: String(failedLogicalPromptEstimate.input.estimatedTokens) },
            { label: "projectMemoryHits", value: String(projectMemoryEntries.length) },
            { label: "attachmentCount", value: String(composerPreview.attachments.length) },
          ],
        ),
        assistantText: partialResult?.assistantText ?? "",
        operations: partialResult?.operations ?? [],
        rawItemsJson: partialResult?.rawItemsJson ?? "[]",
        usage: partialResult?.usage ?? null,
        errorMessage: failureMessage,
      });
      const failedAuditUpdateStartedAt = Date.now();
      await this.deps.updateAuditLog(runningAuditLog.id, failedAuditEntry);
      logSessionRunStuckInvestigation("runtime.terminal-audit-update.done", {
        sessionId,
        auditLogId: runningAuditLog.id,
        durationMs: Date.now() - failedAuditUpdateStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        phase: failedAuditEntry.phase,
        operationCount: failedAuditEntry.operations.length,
      });
      runningAuditEntry = failedAuditEntry;

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
      const storedFailedSession = await this.deps.upsertSession(failedSession);
      logSessionRunStuckInvestigation("runtime.terminal-session-upsert.done", {
        sessionId,
        durationMs: Date.now() - failedSessionUpsertStartedAt,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: failedSession.messages.length,
        storedRunState: storedFailedSession.runState,
        storedStatus: storedFailedSession.status,
      });
      activeRunningSession = storedFailedSession;
      return storedFailedSession;
    } finally {
      await revokeMemoryBinding();
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      this.sessionRunControllers.delete(sessionId);
      const currentLiveState = this.deps.getLiveSessionRun(sessionId);
      const preservedBackgroundTasks = currentLiveState?.backgroundTasks ?? [];
      const preservedReasoningText = currentLiveState?.reasoningText ?? "";
      if (preservedBackgroundTasks.length > 0 || preservedReasoningText.trim().length > 0) {
        this.deps.setLiveSessionRun(sessionId, {
          ...buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId),
          backgroundTasks: preservedBackgroundTasks,
          reasoningText: preservedReasoningText,
        });
      } else {
        this.deps.setLiveSessionRun(sessionId, null);
      }
      this.deps.clearWorkspaceFileIndex(session.workspacePath);
      this.deps.broadcastLiveSessionRun(sessionId);
      logSessionRunStuckInvestigation("runtime.finally.done", {
        sessionId,
        elapsedMs: Date.now() - investigationStartedAt,
        activeRunState: activeRunningSession.runState,
        activeStatus: activeRunningSession.status,
        preservedBackgroundTaskCount: preservedBackgroundTasks.length,
        preservedReasoningChars: preservedReasoningText.length,
        liveRunAfterFinally: this.deps.getLiveSessionRun(sessionId) ? "present" : "null",
      });
    }
  }

  private async createProviderMemoryBindingForSession(
    session: Session,
    provider: ModelCatalogProvider,
    character: CharacterProfile | null,
  ): Promise<ProviderMemoryBindingRuntimeProjection | null> {
    return Promise.resolve(this.deps.createProviderMemoryBinding?.({
      session,
      provider,
      character,
    }) ?? null);
  }
}
