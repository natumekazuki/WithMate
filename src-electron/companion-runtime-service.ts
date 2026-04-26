import {
  currentTimestampLabel as defaultCurrentTimestampLabel,
  type ComposerPreview,
  type LiveApprovalDecision,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type SessionContextTelemetry,
  type SessionMemory,
  type RunSessionTurnRequest,
} from "../src/app-state.js";
import type { CharacterProfile } from "../src/character-state.js";
import type { CompanionSession } from "../src/companion-state.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import { ProviderTurnError, type ProviderCodingAdapter, type RunSessionTurnResult } from "./provider-runtime.js";
import { isCanceledRunError } from "./session-runtime-service.js";

export type CompanionRuntimeServiceDeps = {
  getCompanionSession(sessionId: string): CompanionSession | null;
  updateCompanionSession(session: CompanionSession): CompanionSession;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  getAppSettings: () => AppSettings;
  resolveProviderCatalog(providerId: string | null | undefined, revision?: number | null): {
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  };
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
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
  broadcastCompanionSessions(): void;
  resolvePendingApprovalRequest(sessionId: string, decision: LiveApprovalDecision): void;
  resolvePendingElicitationRequest(sessionId: string, response: LiveElicitationResponse): void;
  currentTimestampLabel?: () => string;
};

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

function buildProviderSession(session: CompanionSession): Session {
  return {
    id: session.id,
    taskTitle: session.taskTitle,
    taskSummary: `${session.taskTitle} を Companion shadow worktree で進める。`,
    status: session.runState === "running" ? "running" : "idle",
    updatedAt: session.updatedAt,
    provider: session.provider,
    catalogRevision: session.catalogRevision,
    workspaceLabel: session.focusPath || session.repoRoot,
    workspacePath: session.repoRoot,
    branch: session.targetBranch,
    sessionKind: "default",
    characterId: session.characterId,
    character: session.character,
    characterIconPath: session.characterIconPath,
    characterThemeColors: session.characterThemeColors,
    runState: session.runState,
    approvalMode: session.approvalMode,
    codexSandboxMode: session.codexSandboxMode,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    customAgentName: session.customAgentName,
    allowedAdditionalDirectories: [],
    threadId: session.threadId,
    messages: session.messages,
    stream: [],
  };
}

function buildCompanionCharacter(session: CompanionSession): CharacterProfile {
  return {
    id: session.characterId,
    name: session.character,
    iconPath: session.characterIconPath,
    roleMarkdown: session.characterRoleMarkdown || session.character,
    description: "",
    notesMarkdown: "",
    themeColors: session.characterThemeColors,
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
    updatedAt: session.updatedAt,
  };
}

function buildSessionMemory(session: CompanionSession): SessionMemory {
  return {
    sessionId: session.id,
    workspacePath: session.repoRoot,
    threadId: session.threadId,
    schemaVersion: 1,
    goal: session.taskTitle,
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [`Companion shadow worktree: ${session.worktreePath}`],
    updatedAt: session.updatedAt,
  };
}

function pickPreferredThreadId(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const normalized = candidate?.trim() ?? "";
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export class CompanionRuntimeService {
  private readonly inFlightRuns = new Set<string>();
  private readonly runControllers = new Map<string, AbortController>();

  constructor(private readonly deps: CompanionRuntimeServiceDeps) {}

  hasInFlightRuns(): boolean {
    return this.inFlightRuns.size > 0;
  }

  isRunInFlight(sessionId: string): boolean {
    return this.inFlightRuns.has(sessionId);
  }

  cancelRun(sessionId: string): void {
    this.deps.resolvePendingApprovalRequest(sessionId, "deny");
    this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
    this.runControllers.get(sessionId)?.abort();
  }

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<CompanionSession> {
    const session = this.deps.getCompanionSession(sessionId);
    if (!session) {
      throw new Error("対象 CompanionSession が見つからないよ。");
    }
    if (session.status !== "active") {
      throw new Error("終了済みの CompanionSession は実行できないよ。");
    }
    if (session.runState === "running" || this.inFlightRuns.has(sessionId)) {
      throw new Error("この CompanionSession はまだ実行中だよ。");
    }

    const nextMessage = request.userMessage.trim();
    if (!nextMessage) {
      throw new Error("送信するメッセージが空だよ。");
    }

    const providerSession = buildProviderSession(session);
    const composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "添付の解決に失敗したよ。");
    }

    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;
    const appSettings = this.deps.getAppSettings();
    const { provider } = this.deps.resolveProviderCatalog(session.provider, session.catalogRevision);
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    const character = buildCompanionCharacter(session);
    const sessionMemory = buildSessionMemory(session);
    const runningSession = this.deps.updateCompanionSession({
      ...session,
      runState: "running",
      updatedAt: currentTimestampLabel(),
      messages: [...session.messages, { role: "user", text: nextMessage }],
    });

    this.inFlightRuns.add(sessionId);
    const controller = new AbortController();
    this.runControllers.set(sessionId, controller);
    this.deps.setLiveSessionRun(sessionId, buildEmptyLiveSessionRunState(sessionId, runningSession.threadId));

    const runProviderTurn = (turnSession: CompanionSession) => {
      const turnProviderSession = buildProviderSession(turnSession);
      return providerAdapter.runSessionTurn({
        session: turnProviderSession,
        executionWorkspacePath: turnSession.worktreePath,
        sessionMemory,
        projectMemoryEntries: [],
        character,
        providerCatalog: provider,
        userMessage: nextMessage,
        appSettings,
        attachments: composerPreview.attachments,
        signal: controller.signal,
        onApprovalRequest: (approvalRequest) => {
          const decision = this.deps.waitForApprovalDecision(sessionId, approvalRequest, controller.signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          this.deps.setLiveSessionRun(sessionId, {
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, turnSession.threadId)),
            approvalRequest,
            elicitationRequest: currentLiveState?.elicitationRequest ?? null,
          });
          return decision;
        },
        onElicitationRequest: (elicitationRequest) => {
          const response = this.deps.waitForElicitationResponse(sessionId, elicitationRequest, controller.signal);
          const currentLiveState = this.deps.getLiveSessionRun(sessionId);
          this.deps.setLiveSessionRun(sessionId, {
            ...(currentLiveState ?? buildEmptyLiveSessionRunState(sessionId, turnSession.threadId)),
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
        const currentLiveState = this.deps.getLiveSessionRun(sessionId);
        this.deps.setLiveSessionRun(sessionId, {
          ...state,
          approvalRequest: currentLiveState?.approvalRequest ?? null,
          elicitationRequest: currentLiveState?.elicitationRequest ?? null,
        });
      });
    };

    let activeSession = runningSession;
    try {
      const result = await runProviderTurn(activeSession);
      const completed = this.storeCompletedSession(activeSession, result, currentTimestampLabel());
      activeSession = completed;
      return completed;
    } catch (error) {
      const failed = this.storeFailedSession(activeSession, error, currentTimestampLabel());
      activeSession = failed;
      return failed;
    } finally {
      if (runningSession.provider === "copilot") {
        this.deps.scheduleProviderQuotaTelemetryRefresh(runningSession.provider, [0, 3000, 10000]);
      }
      this.deps.resolvePendingApprovalRequest(sessionId, "deny");
      this.deps.resolvePendingElicitationRequest(sessionId, { action: "cancel" });
      this.inFlightRuns.delete(sessionId);
      this.runControllers.delete(sessionId);
      this.deps.setLiveSessionRun(sessionId, null);
      this.deps.clearWorkspaceFileIndex(activeSession.worktreePath);
      this.deps.broadcastCompanionSessions();
    }
  }

  private storeCompletedSession(
    session: CompanionSession,
    result: RunSessionTurnResult,
    updatedAt: string,
  ): CompanionSession {
    return this.deps.updateCompanionSession({
      ...session,
      runState: "idle",
      threadId: pickPreferredThreadId(result.threadId, session.threadId),
      updatedAt,
      messages: [
        ...session.messages,
        {
          role: "assistant",
          text: result.assistantText,
          artifact: result.artifact,
        },
      ],
    });
  }

  private storeFailedSession(session: CompanionSession, error: unknown, updatedAt: string): CompanionSession {
    const providerTurnError = error instanceof ProviderTurnError ? error : null;
    const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
    const partialResult = providerTurnError?.partialResult;
    const message = error instanceof Error ? error.message : String(error);
    if (canceled) {
      this.deps.invalidateProviderSessionThread(session.provider, session.id);
    }
    const fallbackNotice = canceled ? "実行をキャンセルしたよ。" : `実行に失敗したよ。\n${message}`;
    const assistantText = partialResult?.assistantText.trim()
      ? `${partialResult.assistantText}\n\n${fallbackNotice}`
      : fallbackNotice;
    return this.deps.updateCompanionSession({
      ...session,
      runState: canceled ? "idle" : "error",
      threadId: pickPreferredThreadId(partialResult?.threadId, session.threadId),
      updatedAt,
      messages: [
        ...session.messages,
        {
          role: "assistant",
          text: assistantText,
          artifact: partialResult?.artifact,
          accent: true,
        },
      ],
    });
  }
}
