import {
  type AuditLogEntry,
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
import type { CompanionSession, CompanionSessionSummary } from "../src/companion-state.js";
import type { AppSettings } from "../src/provider-settings-state.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import {
  ProviderTurnError,
  type ProviderCodingAdapter,
  type RunSessionTurnInput,
  type RunSessionTurnResult,
} from "./provider-runtime.js";
import { isCanceledRunError } from "./session-runtime-service.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

export type CompanionRuntimeServiceDeps = {
  getCompanionSession(sessionId: string): Awaitable<CompanionSession | null>;
  listCompanionSessionSummaries?: () => Awaitable<CompanionSessionSummary[]>;
  updateCompanionSession(session: CompanionSession): Awaitable<CompanionSession>;
  resolveComposerPreview(session: Session, userMessage: string): Promise<ComposerPreview>;
  getAppSettings: () => AppSettings;
  resolveProviderCatalog(providerId: string | null | undefined, revision?: number | null): {
    snapshot: ModelCatalogSnapshot;
    provider: ModelCatalogProvider;
  };
  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter;
  createAuditLog?: (input: CreateAuditLogInput) => Awaitable<AuditLogEntry>;
  updateAuditLog?: (id: number, entry: CreateAuditLogInput) => Awaitable<void | AuditLogEntry>;
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
    workspacePath: session.worktreePath,
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
    allowedAdditionalDirectories: session.allowedAdditionalDirectories ?? [],
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

function buildRunningCompanionAuditEntry(params: {
  sessionId: string;
  createdAt: string;
  session: Pick<CompanionSession, "provider" | "model" | "reasoningEffort" | "approvalMode" | "threadId">;
  logicalPrompt: CreateAuditLogInput["logicalPrompt"];
}): CreateAuditLogInput {
  return {
    sessionId: params.sessionId,
    createdAt: params.createdAt,
    phase: "running",
    provider: params.session.provider,
    model: params.session.model,
    reasoningEffort: params.session.reasoningEffort,
    approvalMode: params.session.approvalMode,
    threadId: params.session.threadId,
    logicalPrompt: params.logicalPrompt,
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
  };
}

function buildTerminalCompanionAuditEntry(params: {
  baseEntry: CreateAuditLogInput;
  phase: CreateAuditLogInput["phase"];
  session: Pick<CompanionSession, "provider" | "model" | "reasoningEffort" | "approvalMode" | "threadId">;
  result?: RunSessionTurnResult | null;
  errorMessage: string;
}): CreateAuditLogInput {
  const result = params.result;
  return {
    ...params.baseEntry,
    phase: params.phase,
    provider: params.session.provider,
    model: params.session.model,
    reasoningEffort: params.session.reasoningEffort,
    approvalMode: params.session.approvalMode,
    threadId: pickPreferredThreadId(result?.threadId, params.session.threadId, params.baseEntry.threadId),
    logicalPrompt: result?.logicalPrompt ?? params.baseEntry.logicalPrompt,
    transportPayload: result?.transportPayload ?? params.baseEntry.transportPayload,
    assistantText: result?.assistantText ?? params.baseEntry.assistantText,
    operations: result?.operations ?? params.baseEntry.operations,
    rawItemsJson: result?.rawItemsJson ?? params.baseEntry.rawItemsJson,
    usage: result?.usage ?? params.baseEntry.usage,
    errorMessage: params.errorMessage,
  };
}

export class CompanionRuntimeService {
  private readonly inFlightRuns = new Set<string>();
  private readonly runControllers = new Map<string, AbortController>();

  constructor(private readonly deps: CompanionRuntimeServiceDeps) {}

  async previewComposerInput(sessionId: string, userMessage: string): Promise<ComposerPreview> {
    const session = await this.deps.getCompanionSession(sessionId);
    if (!session) {
      throw new Error("対象 CompanionSession が見つからないよ。");
    }

    return this.deps.resolveComposerPreview(buildProviderSession(session), userMessage);
  }

  hasInFlightRuns(): boolean {
    return this.inFlightRuns.size > 0;
  }

  async recoverInterruptedSessions(): Promise<void> {
    const summaries = await this.deps.listCompanionSessionSummaries?.() ?? [];
    const runningSummaries = summaries.filter((session) =>
      session.status === "active" && session.runState === "running"
    );
    if (runningSummaries.length === 0) {
      return;
    }

    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;
    const interruptedMessage = "前回の Companion 実行はアプリ終了で中断された可能性があるよ。必要ならもう一度送ってね。";
    let recovered = false;
    for (const summary of runningSummaries) {
      const session = await this.deps.getCompanionSession(summary.id);
      if (!session || session.status !== "active" || session.runState !== "running") {
        continue;
      }

      const lastMessage = session.messages.at(-1);
      const messages =
        lastMessage?.role === "assistant" && lastMessage.text === interruptedMessage
          ? session.messages
          : [
              ...session.messages,
              {
                role: "assistant" as const,
                text: interruptedMessage,
                accent: true,
              },
            ];

      await this.deps.updateCompanionSession({
        ...session,
        runState: "error",
        updatedAt: currentTimestampLabel(),
        messages,
      });
      this.deps.setLiveSessionRun(session.id, null);
      recovered = true;
    }

    if (recovered) {
      this.deps.broadcastCompanionSessions();
    }
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
    const session = await this.deps.getCompanionSession(sessionId);
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

    const requestedSession = {
      ...session,
      model: request.model?.trim() || session.model,
      reasoningEffort: request.reasoningEffort ?? session.reasoningEffort,
      approvalMode: request.approvalMode ?? session.approvalMode,
      codexSandboxMode: request.codexSandboxMode ?? session.codexSandboxMode,
    };
    const providerSession = buildProviderSession(requestedSession);
    const composerPreview = await this.deps.resolveComposerPreview(providerSession, request.userMessage);
    if (composerPreview.errors.length > 0) {
      throw new Error(composerPreview.errors[0] ?? "添付の解決に失敗したよ。");
    }

    const currentTimestampLabel = this.deps.currentTimestampLabel ?? defaultCurrentTimestampLabel;
    const appSettings = this.deps.getAppSettings();
    const { provider } = this.deps.resolveProviderCatalog(requestedSession.provider, requestedSession.catalogRevision);
    const providerAdapter = this.deps.getProviderCodingAdapter(provider.id);
    const character = buildCompanionCharacter(requestedSession);
    const sessionMemory = buildSessionMemory(requestedSession);
    const runningSession = await this.deps.updateCompanionSession({
      ...requestedSession,
      runState: "running",
      updatedAt: currentTimestampLabel(),
      messages: [...requestedSession.messages, { role: "user", text: nextMessage }],
    });

    this.inFlightRuns.add(sessionId);
    const controller = new AbortController();
    this.runControllers.set(sessionId, controller);
    this.deps.setLiveSessionRun(sessionId, buildEmptyLiveSessionRunState(sessionId, runningSession.threadId));

    const buildProviderInput = (turnSession: CompanionSession): RunSessionTurnInput => {
      const turnProviderSession = buildProviderSession(turnSession);
      return {
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
      };
    };

    const promptForAudit = providerAdapter.composePrompt(buildProviderInput(runningSession));
    let runningAuditEntry = buildRunningCompanionAuditEntry({
      sessionId,
      createdAt: new Date().toISOString(),
      session: runningSession,
      logicalPrompt: promptForAudit.logicalPrompt,
    });
    const runningAuditLog = this.deps.createAuditLog
      ? await this.deps.createAuditLog(runningAuditEntry)
      : null;

    const updateRunningAudit = async (entry: CreateAuditLogInput): Promise<void> => {
      if (!runningAuditLog || !this.deps.updateAuditLog) {
        return;
      }
      await this.deps.updateAuditLog(runningAuditLog.id, entry);
      runningAuditEntry = entry;
    };

    const runProviderTurn = (turnSession: CompanionSession) => {
      return providerAdapter.runSessionTurn(buildProviderInput(turnSession), (state) => {
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
      await updateRunningAudit(buildTerminalCompanionAuditEntry({
        baseEntry: runningAuditEntry,
        phase: "completed",
        session: activeSession,
        result,
        errorMessage: "",
      }));
      const completed = await this.storeCompletedSession(activeSession, result, currentTimestampLabel());
      activeSession = completed;
      return completed;
    } catch (error) {
      const providerTurnError = error instanceof ProviderTurnError ? error : null;
      const canceled = providerTurnError ? providerTurnError.canceled : isCanceledRunError(error);
      const message = error instanceof Error ? error.message : String(error);
      await updateRunningAudit(buildTerminalCompanionAuditEntry({
        baseEntry: runningAuditEntry,
        phase: canceled ? "canceled" : "failed",
        session: activeSession,
        result: providerTurnError?.partialResult ?? null,
        errorMessage: canceled ? "ユーザーがキャンセルしたよ。" : message,
      }));
      const failed = await this.storeFailedSession(activeSession, error, currentTimestampLabel());
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

  private async storeCompletedSession(
    session: CompanionSession,
    result: RunSessionTurnResult,
    updatedAt: string,
  ): Promise<CompanionSession> {
    return await this.deps.updateCompanionSession({
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

  private async storeFailedSession(session: CompanionSession, error: unknown, updatedAt: string): Promise<CompanionSession> {
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
    return await this.deps.updateCompanionSession({
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
