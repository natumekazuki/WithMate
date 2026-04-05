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

  const candidateThreadId = (partialResult?.threadId ?? currentThreadId).trim();
  return candidateThreadId.length > 0;
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

    const runningAuditLog = this.deps.createAuditLog({
      sessionId,
      createdAt: new Date().toISOString(),
      phase: "running",
      provider: runningSession.provider,
      model: runningSession.model,
      reasoningEffort: runningSession.reasoningEffort,
      approvalMode: runningSession.approvalMode,
      threadId: runningSession.threadId,
      logicalPrompt: promptForAudit.logicalPrompt,
      transportPayload: null,
      assistantText: "",
      operations: [],
      rawItemsJson: "[]",
      usage: null,
      errorMessage: "",
    });

    let activeRunningSession = runningSession;
    const runProviderTurn = (turnSession: Session) =>
      providerAdapter.runSessionTurn({
        session: turnSession,
        sessionMemory,
        projectMemoryEntries,
        character,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        signal: runAbortController.signal,
        onApprovalRequest: (approvalRequest) =>
          this.deps.waitForApprovalDecision(sessionId, approvalRequest, runAbortController.signal),
        onElicitationRequest: (elicitationRequest) =>
          this.deps.waitForElicitationResponse(sessionId, elicitationRequest, runAbortController.signal),
        onProviderQuotaTelemetry: (telemetry) => {
          this.deps.setProviderQuotaTelemetry(telemetry);
        },
        onSessionContextTelemetry: (telemetry) => {
          this.deps.setSessionContextTelemetry(telemetry);
        },
      }, (state) => {
        this.deps.setLiveSessionRun(sessionId, {
          ...state,
          approvalRequest: this.deps.getLiveSessionRun(sessionId)?.approvalRequest ?? null,
          elicitationRequest: this.deps.getLiveSessionRun(sessionId)?.elicitationRequest ?? null,
        });
      });

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
        }
      }
      if (!result) {
        throw new Error("provider turn result を確定できなかったよ。");
      }

      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);

      this.deps.updateAuditLog(runningAuditLog.id, {
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
      });

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
      this.deps.runSessionMemoryExtraction(storedCompletedSession, result.usage, { triggerReason: "outputTokensThreshold" });
      this.deps.runCharacterReflection(storedCompletedSession, { triggerReason: "context-growth" });
      return storedCompletedSession;
    } catch (error: unknown) {
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
      const message = error instanceof Error ? error.message : String(error);
      const partialResult = providerTurnError?.partialResult;
      const failedAuditThreadId = partialResult?.threadId ?? activeRunningSession.threadId;
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

      this.deps.updateAuditLog(runningAuditLog.id, {
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
      });

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
