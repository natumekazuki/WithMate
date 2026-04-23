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
import { type Session } from "../src/session-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../src/model-catalog.js";
import { ProviderTurnError, type ProviderCodingAdapter, type RunSessionTurnResult } from "./provider-runtime.js";
import { appendQuotaTelemetryToTransportPayload } from "./audit-log-quota.js";
import { appendTransportPayloadFields, calculateAuditDurationMs } from "./audit-log-metadata.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

type SessionMemoryExtractionTriggerOptions = {
  triggerReason: "outputTokensThreshold" | "manual" | "compact-before";
  force?: boolean;
};

type CharacterReflectionTriggerOptions = {
  triggerReason: "session-start" | "context-growth";
};

export type SessionRuntimeServiceDeps = {
  getSession(sessionId: string): Session | null;
  upsertSession(session: Session): Session;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  resolveSessionCharacter(session: Session): Promise<CharacterProfile | null>;
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
  createAuditLog(input: CreateAuditLogInput): AuditLogEntry;
  updateAuditLog(id: number, entry: CreateAuditLogInput): void;
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
  runSessionMemoryExtraction(session: Session, usage: AuditLogEntry["usage"], options: SessionMemoryExtractionTriggerOptions): void;
  runCharacterReflection(session: Session, options: CharacterReflectionTriggerOptions): void;
  clearWorkspaceFileIndex(workspacePath: string): void;
  broadcastLiveSessionRun(sessionId: string): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
  resolvePendingElicitationRequest(sessionId: string, response: LiveElicitationResponse): void;
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
    /\b(thread|session)\b.*\bnot found\b/.test(normalizedMessage) ||
    /\bnot found\b.*\b(thread|session)\b/.test(normalizedMessage) ||
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
    const session = this.deps.getSession(sessionId);
    if (!session) {
      throw new Error("対象セッションが見つからないよ。");
    }

    if (session.runState === "running") {
      throw new Error("このセッションはまだ実行中だよ。");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("送信するメッセージが空だよ。");
    }

    const composerPreview = await this.deps.resolveComposerPreview(session, request.userMessage);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "添付の解決に失敗したよ。");
    }

    const character = await this.deps.resolveSessionCharacter(session);
    if (!character) {
      throw new Error("キャラクター定義が見つからないよ。");
    }

    const appSettings = this.deps.getAppSettings();
    if (!getProviderAppSettings(appSettings, session.provider).enabled) {
      throw new Error("この provider は Settings で無効になっているよ。");
    }

    const { provider } = this.deps.resolveProviderCatalog(session.provider, session.catalogRevision);
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    const sessionMemory = this.deps.getSessionMemory(session);
    const projectMemoryEntries = this.deps.resolveProjectMemoryEntriesForPrompt(session, nextMessage, sessionMemory);
    const promptForAudit = providerAdapter.composePrompt({
      session,
      sessionMemory,
      projectMemoryEntries,
      character,
      providerCatalog: provider,
      userMessage: nextMessage,
      appSettings,
      attachments: composerPreview.attachments,
    });

    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;
    const runningSession: Session = {
      ...session,
      updatedAt: currentTimestampLabel(),
      status: "running",
      runState: "running",
      messages: [...session.messages, { role: "user", text: nextMessage }],
    };

    this.deps.upsertSession(runningSession);
    this.inFlightSessionRuns.add(sessionId);
    const runAbortController = new AbortController();
    this.sessionRunControllers.set(sessionId, runAbortController);
    this.deps.setLiveSessionRun(sessionId, {
      ...buildEmptyLiveSessionRunState(sessionId, runningSession.threadId),
      backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
    });

    let runningAuditEntry: CreateAuditLogInput = buildRunningAuditEntry({
      sessionId,
      createdAt: new Date().toISOString(),
      session: runningSession,
      logicalPrompt: promptForAudit.logicalPrompt,
    });
    const runningAuditLog = this.deps.createAuditLog(runningAuditEntry);
    let runningAuditProgressSignature = buildRunningAuditProgressSignature(runningAuditEntry);
    let terminalAuditSettled = false;
    let liveProgressGeneration = 0;

    let activeRunningSession = runningSession;
    const syncRunningAuditFromLiveState = (nextLiveState: LiveSessionRunState) => {
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
        assistantText: nextLiveState.assistantText.trim() ? nextLiveState.assistantText : runningAuditEntry.assistantText,
        operations: (() => {
          const operations = buildLiveRunAuditOperations(nextLiveState);
          return operations.length > 0 ? operations : runningAuditEntry.operations;
        })(),
        usage: nextLiveState.usage ?? runningAuditEntry.usage,
        errorMessage: nextLiveState.errorMessage.trim() ? nextLiveState.errorMessage : runningAuditEntry.errorMessage,
      };
      const nextSignature = buildRunningAuditProgressSignature(nextRunningAuditEntry);
      if (nextSignature === runningAuditProgressSignature) {
        return;
      }

      this.deps.updateAuditLog(runningAuditLog.id, nextRunningAuditEntry);
      runningAuditEntry = nextRunningAuditEntry;
      runningAuditProgressSignature = nextSignature;
    };
    const runProviderTurn = (turnSession: Session) => {
      const progressGeneration = ++liveProgressGeneration;
      return providerAdapter.runSessionTurn({
        session: turnSession,
        sessionMemory,
        projectMemoryEntries,
        character,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        signal: runAbortController.signal,
        onApprovalRequest: (approvalRequest) => {
          const decision = this.deps.waitForApprovalDecision(sessionId, approvalRequest, runAbortController.signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          syncRunningAuditFromLiveState({
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId)),
            approvalRequest,
            elicitationRequest: currentLiveState?.elicitationRequest ?? null,
          });
          return decision;
        },
        onElicitationRequest: (elicitationRequest) => {
          const response = this.deps.waitForElicitationResponse(sessionId, elicitationRequest, runAbortController.signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          syncRunningAuditFromLiveState({
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId)),
            approvalRequest: currentLiveState?.approvalRequest ?? null,
            elicitationRequest,
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

        const nextLiveState: LiveSessionRunState = {
          ...state,
          approvalRequest: this.deps.getLiveSessionRun(sessionId)?.approvalRequest ?? null,
          elicitationRequest: this.deps.getLiveSessionRun(sessionId)?.elicitationRequest ?? null,
        };
        syncRunningAuditFromLiveState(nextLiveState);
      });
    };

    try {
      let result: RunSessionTurnResult | null = null;
      let didInternalRetry = false;
      while (true) {
        try {
          result = await runProviderTurn(activeRunningSession);
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
          if (activeRunningSession.threadId) {
            activeRunningSession = this.deps.upsertSession({
              ...activeRunningSession,
              threadId: "",
              updatedAt: currentTimestampLabel(),
            });
          }
          this.deps.setLiveSessionRun(sessionId, {
            ...buildEmptyLiveSessionRunState(sessionId, ""),
            backgroundTasks: this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [],
          });
          runningAuditEntry = buildRunningAuditEntry({
            sessionId,
            createdAt: runningAuditLog.createdAt,
            session: activeRunningSession,
            logicalPrompt: promptForAudit.logicalPrompt,
            threadId: "",
          });
          runningAuditProgressSignature = buildRunningAuditProgressSignature(runningAuditEntry);
          this.deps.updateAuditLog(runningAuditLog.id, runningAuditEntry);
        }
      }
      if (!result) {
        throw new Error("provider turn result を確定できなかったよ。");
      }

      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);

      terminalAuditSettled = true;
      const completedAuditEntry: CreateAuditLogInput = {
        sessionId,
        createdAt: runningAuditLog.createdAt,
        phase: "completed",
        provider: activeRunningSession.provider,
        model: activeRunningSession.model,
        reasoningEffort: activeRunningSession.reasoningEffort,
        approvalMode: activeRunningSession.approvalMode,
        threadId: result.threadId ?? activeRunningSession.threadId,
        logicalPrompt: result.logicalPrompt,
        transportPayload: appendTransportPayloadFields(
          appendQuotaTelemetryToTransportPayload(
            result.transportPayload,
            result.providerQuotaTelemetry,
          ),
          [
            { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
            { label: "projectMemoryHits", value: String(projectMemoryEntries.length) },
            { label: "attachmentCount", value: String(composerPreview.attachments.length) },
          ],
        ),
        assistantText: result.assistantText,
        operations: result.operations,
        rawItemsJson: result.rawItemsJson,
        usage: result.usage,
        errorMessage: "",
      };
      this.deps.updateAuditLog(runningAuditLog.id, completedAuditEntry);
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

      const storedCompletedSession = this.deps.upsertSession(completedSession);
      activeRunningSession = storedCompletedSession;
      this.deps.runSessionMemoryExtraction(storedCompletedSession, result.usage, { triggerReason: "outputTokensThreshold" });
      this.deps.runCharacterReflection(storedCompletedSession, { triggerReason: "context-growth" });
      return storedCompletedSession;
    } catch (error: unknown) {
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
      const message = error instanceof Error ? error.message : String(error);
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
      if (canceled || shouldResetFailedThread) {
        this.deps.invalidateProviderSessionThread(activeRunningSession.provider, sessionId);
      }

      terminalAuditSettled = true;
      const failedAuditEntry: CreateAuditLogInput = {
        sessionId,
        createdAt: runningAuditLog.createdAt,
        phase: canceled ? "canceled" : "failed",
        provider: activeRunningSession.provider,
        model: activeRunningSession.model,
        reasoningEffort: activeRunningSession.reasoningEffort,
        approvalMode: activeRunningSession.approvalMode,
        threadId: failedAuditThreadId,
        logicalPrompt: partialResult?.logicalPrompt ?? promptForAudit.logicalPrompt,
        transportPayload: appendTransportPayloadFields(
          appendQuotaTelemetryToTransportPayload(
            partialResult?.transportPayload ?? null,
            partialResult?.providerQuotaTelemetry,
          ),
          [
            { label: "durationMs", value: durationMs === null ? null : String(durationMs) },
            { label: "projectMemoryHits", value: String(projectMemoryEntries.length) },
            { label: "attachmentCount", value: String(composerPreview.attachments.length) },
          ],
        ),
        assistantText: partialResult?.assistantText ?? "",
        operations: partialResult?.operations ?? [],
        rawItemsJson: partialResult?.rawItemsJson ?? "[]",
        usage: partialResult?.usage ?? null,
        errorMessage: canceled ? "ユーザーがキャンセルしたよ。" : message,
      };
      this.deps.updateAuditLog(runningAuditLog.id, failedAuditEntry);
      runningAuditEntry = failedAuditEntry;

      const fallbackNotice = canceled ? "実行をキャンセルしたよ。" : `実行に失敗したよ。\n${message}`;
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

      const storedFailedSession = this.deps.upsertSession(failedSession);
      activeRunningSession = storedFailedSession;
      this.deps.runSessionMemoryExtraction(storedFailedSession, partialResult?.usage ?? null, {
        triggerReason: "outputTokensThreshold",
      });
      return storedFailedSession;
    } finally {
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightSessionRuns.delete(sessionId);
      this.sessionRunControllers.delete(sessionId);
      const preservedBackgroundTasks = this.deps.getLiveSessionRun(sessionId)?.backgroundTasks ?? [];
      if (preservedBackgroundTasks.length > 0) {
        this.deps.setLiveSessionRun(sessionId, {
          ...buildEmptyLiveSessionRunState(sessionId, activeRunningSession.threadId),
          backgroundTasks: preservedBackgroundTasks,
        });
      } else {
        this.deps.setLiveSessionRun(sessionId, null);
      }
      this.deps.clearWorkspaceFileIndex(session.workspacePath);
      this.deps.broadcastLiveSessionRun(sessionId);
    }
  }
}
