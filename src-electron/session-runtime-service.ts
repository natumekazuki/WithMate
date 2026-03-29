import {
  currentTimestampLabel as defaultCurrentTimestampLabel,
  type AuditLogEntry,
  type ComposerPreview,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveSessionRunState,
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
import { ProviderTurnError, type ProviderCodingAdapter } from "./provider-runtime.js";
import { appendQuotaTelemetryToTransportPayload } from "./audit-log-quota.js";
import { appendTransportPayloadFields, calculateAuditDurationMs } from "./audit-log-metadata.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

type SessionMemoryExtractionTriggerOptions = {
  triggerReason: "outputTokensThreshold" | "session-window-close";
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
  setProviderQuotaTelemetry(telemetry: ProviderQuotaTelemetry): void;
  setSessionContextTelemetry(telemetry: SessionContextTelemetry): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void;
  scheduleProviderQuotaTelemetryRefresh(providerId: string, delaysMs: number[]): void;
  runSessionMemoryExtraction(session: Session, usage: AuditLogEntry["usage"], options: SessionMemoryExtractionTriggerOptions): void;
  runCharacterReflection(session: Session, options: CharacterReflectionTriggerOptions): void;
  clearWorkspaceFileIndex(workspacePath: string): void;
  broadcastLiveSessionRun(sessionId: string): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
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
      this.sessionRunControllers.get(sessionId)?.abort();
    }
    this.inFlightSessionRuns.clear();
    this.sessionRunControllers.clear();
  }

  cancelRun(sessionId: string): void {
    this.deps.resolvePendingApprovalRequest(sessionId, "deny");
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
      sessionId,
      threadId: runningSession.threadId,
      assistantText: "",
      steps: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
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

    try {
      const result = await providerAdapter.runSessionTurn({
        session: runningSession,
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
        });
      });
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);

      this.deps.updateAuditLog(runningAuditLog.id, {
        sessionId,
        createdAt: runningAuditLog.createdAt,
        phase: "completed",
        provider: runningSession.provider,
        model: runningSession.model,
        reasoningEffort: runningSession.reasoningEffort,
        approvalMode: runningSession.approvalMode,
        threadId: result.threadId ?? runningSession.threadId,
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
        ...runningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: "idle",
        threadId: result.threadId ?? runningSession.threadId,
        messages: [
          ...runningSession.messages,
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
      const completedAt = new Date().toISOString();
      const durationMs = calculateAuditDurationMs(runningAuditLog.createdAt, completedAt);
      if (canceled) {
        this.deps.invalidateProviderSessionThread(runningSession.provider, sessionId);
      }

      this.deps.updateAuditLog(runningAuditLog.id, {
        sessionId,
        createdAt: runningAuditLog.createdAt,
        phase: canceled ? "canceled" : "failed",
        provider: runningSession.provider,
        model: runningSession.model,
        reasoningEffort: runningSession.reasoningEffort,
        approvalMode: runningSession.approvalMode,
        threadId: partialResult?.threadId ?? runningSession.threadId,
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
        ...runningSession,
        updatedAt: currentTimestampLabel(),
        status: "idle",
        runState: canceled ? "idle" : "error",
        threadId: partialResult?.threadId ?? runningSession.threadId,
        messages: [
          ...runningSession.messages,
          {
            role: "assistant",
            text: assistantText,
            artifact: partialResult?.artifact,
            accent: true,
          },
        ],
      };

      const storedFailedSession = this.deps.upsertSession(failedSession);
      this.deps.runSessionMemoryExtraction(storedFailedSession, partialResult?.usage ?? null, {
        triggerReason: "outputTokensThreshold",
      });
      return storedFailedSession;
    } finally {
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.inFlightSessionRuns.delete(sessionId);
      this.sessionRunControllers.delete(sessionId);
      this.deps.setLiveSessionRun(sessionId, null);
      this.deps.clearWorkspaceFileIndex(session.workspacePath);
      this.deps.broadcastLiveSessionRun(sessionId);
    }
  }
}
