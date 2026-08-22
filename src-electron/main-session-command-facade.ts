import { createHash } from "node:crypto";

import type { ProviderQuotaTelemetry, RunSessionTurnRequest } from "../src/runtime-state.js";
import type {
  CancelSessionExecutionRequest,
  CancelSessionExecutionResult,
  EnqueueSessionTurnResult,
  SessionTurnExecutionProjection,
  SessionTurnAdmissionError,
} from "../src/session-turn-execution.js";
import {
  parseSetSessionPinnedRequest,
  type CreateSessionInput,
  type CreateSessionRequest,
  type Session,
  type SessionSummary,
  type SetSessionPinnedRequest,
} from "../src/session-state.js";
import {
  resolveDeleteSessionsLastActiveBeforeCutoff,
  type DeleteSessionsLastActiveBeforeRequest,
  type DeleteSessionsResult,
} from "../src/withmate-window-types.js";
import type { SessionPersistenceService } from "./session-persistence-service.js";
import type { SessionRuntimeService } from "./session-runtime-service.js";
import { parseCreateSessionRequest } from "./create-session-request.js";
import type { SessionLaunchSelection } from "./session-launch-selection-service.js";
import type { RunProviderRuntimeOperationExclusive } from "./provider-runtime-operation-coordinator.js";
import type { WorkspaceDirectoryValidationResult } from "../src/workspace-directory-validation.js";
import { resolveWorkspaceDirectoryValidationMessage } from "../src/workspace-directory-validation.js";
import {
  SessionExecutionNotFoundError,
  SessionExecutionOwnerMismatchError,
  SessionExecutionShuttingDownError,
  type SessionExecutionService,
} from "./session-execution-service.js";
import {
  SessionExecutionIdempotencyConflictError,
  SessionExecutionQueueFullError,
  SessionExecutionStateConflictError,
} from "./session-execution-storage-v6.js";
import { parseSessionExecutionTurnRequest } from "./session-execution-turn-request.js";
import { SessionTurnValidationError } from "./session-turn-validation-error.js";
import type { SessionTerminalFailureNotificationEnqueueResult } from "./session-terminal-failure-notification-service.js";
import type { TurnInitiator } from "../src/session-execution.js";
import type { SessionRuntimeTerminalFailureNotificationProjection } from "../src/session-external-runtime-contract.js";

type MainSessionCommandFacadeDeps = {
  getSession(sessionId: string): Session | null;
  getSessions(): readonly Session[];
  getStoredSessionSummaries(): Promise<readonly SessionSummary[]> | readonly SessionSummary[];
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  resolveSessionLaunchSelection(providerId?: string | null): Promise<SessionLaunchSelection>;
  getSessionPersistenceService(): SessionPersistenceService;
  getSessionRuntimeService(): SessionRuntimeService;
  getSessionExecutionService(): SessionExecutionService;
  cancelSessionRun(sessionId: string): void;
  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null;
  isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean;
  refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  createSessionId(): string;
  createSessionFilesDirectory(sessionId: string): Promise<string> | string;
  isSessionFilesWorkspace(session: Pick<Session, "id" | "workspacePath">): boolean;
  dismissSessionTurnNotification(sessionId: string): void;
  cleanupSessionFilesDirectory?(sessionId: string): Promise<void>;
  cleanupCreatedSessionFilesDirectory?(sessionId: string): Promise<void>;
  resumeSessionExecutionQueue?(sessionId: string): Promise<void> | void;
  validateWorkspaceDirectory(targetPath: unknown): Promise<WorkspaceDirectoryValidationResult>;
  getCurrentModelCatalogRevision?(): number;
  projectTerminalFailureNotification?(
    execution: import("../src/session-execution.js").SessionExecution,
    request: unknown,
  ): SessionRuntimeTerminalFailureNotificationProjection | null;
};

type MainOwnedCreateSessionInput = Omit<CreateSessionInput, "id">;

export class MainSessionFolderCleanupRequiredError extends Error {
  readonly code = "SESSION_FOLDER_CLEANUP_REQUIRED";

  constructor(readonly sessionId: string) {
    super("The uncommitted SessionFolder could not be cleaned up.");
    this.name = "MainSessionFolderCleanupRequiredError";
  }
}

export class MainSessionCommandFacade {
  constructor(private readonly deps: MainSessionCommandFacadeDeps) {}

  async createSession(input: MainOwnedCreateSessionInput): Promise<Session> {
    return this.persistCreatedSession({
      ...input,
      id: this.issueSessionId(),
    });
  }

  async createSessionFromRequest(input: CreateSessionRequest): Promise<Session> {
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.createSessionFromRequestExclusive(input),
    );
  }

  private async createSessionFromRequestExclusive(input: CreateSessionRequest): Promise<Session> {
    const { workspace, sessionInput: requestSessionInput } = parseCreateSessionRequest(input);
    const launchSelection = await this.deps.resolveSessionLaunchSelection(requestSessionInput.provider);
    const sessionInput = {
      ...requestSessionInput,
      ...launchSelection,
    };
    if (workspace?.kind === "directory") {
      if (!workspace.label.trim() || !workspace.path.trim()) {
        throw new Error("workspace の情報が不足しているよ。");
      }
      return this.persistCreatedSession({
        ...sessionInput,
        id: this.issueSessionId(),
        workspaceLabel: workspace.label,
        workspacePath: workspace.path,
        branch: workspace.branch,
      });
    }
    if (workspace?.kind !== "session-folder") {
      throw new Error("workspace の作成方法を解釈できないよ。");
    }

    const sessionId = this.issueSessionId();
    const workspacePath = await this.deps.createSessionFilesDirectory(sessionId);
    if (!workspacePath.trim()) {
      throw new Error("SessionFolder を作成できなかったよ。");
    }

    try {
      return await this.persistCreatedSession({
        ...sessionInput,
        id: sessionId,
        workspaceLabel: "SessionFolder",
        workspacePath,
        branch: "",
      });
    } catch (error) {
      const cleanupCreatedSessionFilesDirectory = this.deps.cleanupCreatedSessionFilesDirectory
        ?? this.deps.cleanupSessionFilesDirectory;
      try {
        if (!cleanupCreatedSessionFilesDirectory) {
          throw new Error("SessionFolder cleanup dependency is unavailable.");
        }
        await cleanupCreatedSessionFilesDirectory(sessionId);
      } catch {
        throw new MainSessionFolderCleanupRequiredError(sessionId);
      }
      throw error;
    }
  }

  private async persistCreatedSession(input: CreateSessionInput & { id: string }): Promise<Session> {
    return this.deps.getSessionPersistenceService().createSession(input);
  }

  private issueSessionId(): string {
    const sessionId = this.deps.createSessionId().trim();
    if (!sessionId) {
      throw new Error("Session ID を発行できなかったよ。");
    }
    return sessionId;
  }

  async updateSession(session: Session): Promise<Session> {
    return this.deps.getSessionPersistenceService().updateSession(session);
  }

  async setSessionPinned(request: SetSessionPinnedRequest): Promise<SessionSummary> {
    const normalized = parseSetSessionPinnedRequest(request);
    return this.deps.getSessionPersistenceService().setSessionPinned(normalized.sessionId, normalized.isPinned);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessionsById = new Map(this.deps.getSessions().map((session) => [session.id, session] as const));
    await this.cleanupDeletedSessions(
      await this.deps.getSessionPersistenceService().deleteSession(sessionId),
      sessionsById,
    );
  }

  async deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
  ): Promise<DeleteSessionsResult> {
    const cutoff = resolveDeleteSessionsLastActiveBeforeCutoff(request);
    const sessionsById = new Map(
      [
        ...await this.deps.getStoredSessionSummaries(),
        ...this.deps.getSessions(),
      ].map((session) => [session.id, session] as const),
    );
    const result = await this.deps.getSessionPersistenceService().deleteSessionsLastActiveBefore(cutoff);
    await this.cleanupDeletedSessions(result, sessionsById);
    return result;
  }

  cancelSessionRun(sessionId: string): void {
    this.deps.cancelSessionRun(sessionId);
  }

  async runSessionTurn(sessionId: string, request: RunSessionTurnRequest): Promise<Session> {
    const session = this.deps.getSession(sessionId);
    if (session) {
      const workspaceValidation = await this.deps.validateWorkspaceDirectory(session.workspacePath);
      if (!workspaceValidation.valid) {
        const detail = resolveWorkspaceDirectoryValidationMessage(workspaceValidation);
        throw new Error(`Workspace is unavailable. ${detail} Restore it and recheck before sending messages.`);
      }
    }
    if (
      session?.provider === "copilot" &&
      this.deps.isProviderQuotaTelemetryStale(this.deps.getProviderQuotaTelemetry(session.provider))
    ) {
      void this.deps.refreshProviderQuotaTelemetry(session.provider).catch(() => undefined);
    }

    try {
      return await this.deps.getSessionRuntimeService().runSessionTurn(sessionId, request);
    } finally {
      void this.deps.resumeSessionExecutionQueue?.(sessionId);
    }
  }

  async enqueueSessionTurn(
    sessionId: string,
    request: RunSessionTurnRequest,
  ): Promise<EnqueueSessionTurnResult> {
    const clientRequestId = request.clientRequestId?.trim() ?? "";
    if (!clientRequestId) {
      return admissionFailure("INVALID_INPUT", "送信要求の識別子が不足しています。", false);
    }

    const session = this.deps.getSession(sessionId);
    if (
      session?.provider === "copilot" &&
      this.deps.isProviderQuotaTelemetryStale(this.deps.getProviderQuotaTelemetry(session.provider))
    ) {
      void this.deps.refreshProviderQuotaTelemetry(session.provider).catch(() => undefined);
    }

    const executionRequest = {
      initiator: { kind: "user" as const },
      turn: { ...request, clientRequestId },
    };
    try {
      const execution = await this.deps.getSessionExecutionService().enqueue({
        sessionId,
        request: executionRequest,
        idempotencyKey: clientRequestId,
        requestFingerprint: fingerprintGuiTurn(sessionId, request),
      });
      return {
        ok: true,
        execution: projectSessionTurnExecutions(
          this.deps.getSessionExecutionService().listRecords(sessionId),
          this.deps.projectTerminalFailureNotification,
        ).find((candidate) => candidate.executionId === execution.id) ?? null,
      };
    } catch (error) {
      const mapped = mapGuiExecutionError(error);
      if (mapped) return { ok: false, error: mapped };
      throw error;
    }
  }

  async enqueueScheduledSessionTurn(
    sessionId: string,
    provider: Session["provider"],
    request: RunSessionTurnRequest,
  ): Promise<EnqueueSessionTurnResult> {
    const clientRequestId = request.clientRequestId?.trim() ?? "";
    if (!clientRequestId) {
      return admissionFailure("INVALID_INPUT", "送信要求の識別子が不足しています。", false);
    }

    const executionRequest = {
      initiator: { kind: "user" as const },
      turn: { ...request, clientRequestId },
    };
    const executionService = this.deps.getSessionExecutionService();
    const replay = executionService.resolveReplay("turn.enqueue", {
      sessionId,
      request: executionRequest,
      idempotencyKey: clientRequestId,
      requestFingerprint: fingerprintGuiTurn(sessionId, request),
    });
    if (replay) {
      return {
        ok: true,
        execution: projectSessionTurnExecutions(executionService.listRecords(sessionId))
          .find((candidate) => candidate.executionId === replay.id) ?? null,
      };
    }

    const catalogRevision = this.deps.getCurrentModelCatalogRevision?.();
    if (typeof catalogRevision !== "number" || !Number.isSafeInteger(catalogRevision)) {
      throw new Error("Current model catalog revision is unavailable.");
    }
    try {
      const runtimeService = this.deps.getSessionRuntimeService();
      await runtimeService.validateSessionTurn(sessionId, request);
      await runtimeService.validateExternalSessionTurn(
        sessionId,
        catalogRevision,
        request,
        provider,
      );
    } catch (error) {
      const mapped = mapGuiExecutionError(error);
      if (mapped) return { ok: false, error: mapped };
      throw error;
    }
    return this.enqueueSessionTurn(sessionId, request);
  }

  async enqueueTerminalFailureNotificationTurn(input: {
    targetSessionId: string;
    initiator: Extract<TurnInitiator, { kind: "session" }>;
    prompt: string;
    idempotencyKey: string;
  }): Promise<SessionTerminalFailureNotificationEnqueueResult> {
    const requestFingerprint = fingerprint({
      kind: "terminal-failure-notification-v1",
      targetSessionId: input.targetSessionId,
      initiator: input.initiator,
      prompt: input.prompt,
    });
    const executionService = this.deps.getSessionExecutionService();
    let replay: ReturnType<SessionExecutionService["resolveReplay"]>;
    try {
      replay = executionService.resolveReplay("turn.enqueue", {
        sessionId: input.targetSessionId,
        request: {},
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
      });
    } catch (error) {
      const mapped = mapGuiExecutionError(error);
      if (mapped) return { ok: false, errorCode: mapped.code, retryable: mapped.retryable };
      throw error;
    }
    if (replay) return { ok: true, executionId: replay.id };

    const session = this.deps.getSession(input.targetSessionId);
    if (!session) return { ok: false, errorCode: "SESSION_NOT_FOUND", retryable: false };
    if (session.sessionKind !== "default") {
      return { ok: false, errorCode: "SESSION_KIND_UNSUPPORTED", retryable: false };
    }
    const catalogRevision = this.deps.getCurrentModelCatalogRevision?.();
    if (typeof catalogRevision !== "number" || !Number.isSafeInteger(catalogRevision)) {
      return { ok: false, errorCode: "RUNTIME_UNAVAILABLE", retryable: true };
    }
    const turn: RunSessionTurnRequest = {
      userMessage: input.prompt,
      clientRequestId: input.idempotencyKey,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      approvalMode: session.approvalMode,
      ...(session.provider === "codex"
        ? { codexSandboxMode: session.codexSandboxMode }
        : { customAgentName: session.customAgentName }),
      attachments: [],
    };
    try {
      const runtimeService = this.deps.getSessionRuntimeService();
      await runtimeService.validateSessionTurn(input.targetSessionId, turn);
      await runtimeService.validateExternalSessionTurn(
        input.targetSessionId,
        catalogRevision,
        turn,
        session.provider,
      );
      const execution = await executionService.enqueue({
        sessionId: input.targetSessionId,
        request: {
          initiator: input.initiator,
          catalogRevision,
          turn: { provider: session.provider, ...turn },
        },
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
      });
      return { ok: true, executionId: execution.id };
    } catch (error) {
      const mapped = mapGuiExecutionError(error);
      if (mapped) return { ok: false, errorCode: mapped.code, retryable: mapped.retryable };
      throw error;
    }
  }

  listSessionTurnExecutions(sessionId: string): SessionTurnExecutionProjection[] {
    const service = this.deps.getSessionExecutionService();
    return [
      ...projectSessionTurnExecutions(
        service.listRecords(sessionId),
        this.deps.projectTerminalFailureNotification,
      ),
      ...projectSessionOutboundExecutions(service.listOutboundRecords?.(sessionId) ?? []),
    ];
  }

  async cancelSessionExecution(
    sessionId: string,
    request: CancelSessionExecutionRequest,
  ): Promise<CancelSessionExecutionResult> {
    try {
      const execution = this.deps.getSessionExecutionService().getRecord(sessionId, request.executionId);
      if (parseSessionExecutionTurnRequest(execution.request).initiator?.kind !== "user") {
        return admissionFailure(
          "EXECUTION_NOT_CANCELLABLE",
          "このTurnはSession画面からキャンセルできません。",
          false,
        );
      }
      await this.deps.getSessionExecutionService().cancel({
        sessionId,
        executionId: request.executionId,
        idempotencyKey: request.clientRequestId,
        requestFingerprint: fingerprintGuiCancel(sessionId, request),
        expectedState: "queued",
      });
      return { ok: true };
    } catch (error) {
      const mapped = mapGuiExecutionError(error);
      if (mapped) return { ok: false, error: mapped };
      throw error;
    }
  }

  private async cleanupDeletedSessions(
    result: DeleteSessionsResult,
    sessionsById: ReadonlyMap<string, Pick<Session, "id" | "workspacePath">>,
  ): Promise<void> {
    for (const sessionId of result.deletedSessionIds) {
      this.deps.dismissSessionTurnNotification(sessionId);
    }

    for (const sessionId of result.deletedSessionIds) {
      const deletedSession = sessionsById.get(sessionId);
      if (deletedSession && this.deps.isSessionFilesWorkspace(deletedSession)) {
        continue;
      }
      await this.deps.cleanupSessionFilesDirectory?.(sessionId);
    }
  }
}

function projectSessionOutboundExecutions(
  executions: ReturnType<SessionExecutionService["listOutboundRecords"]>,
): SessionTurnExecutionProjection[] {
  return executions.map((execution) => ({
    executionId: execution.executionId,
    sessionId: execution.targetSessionId,
    clientRequestId: null,
    userMessage: execution.userMessage,
    initiator: null,
    state: "accepted" as const,
    queuePosition: null,
    canCancel: false,
    createdAt: execution.createdAt,
    updatedAt: execution.createdAt,
    relatedSession: {
      direction: "outbound" as const,
      sessionId: execution.targetSessionId,
      titleSnapshot: execution.targetSessionTitle,
      roleSnapshot: execution.targetSessionRole,
    },
  }));
}

function projectSessionTurnExecutions(
  executions: ReturnType<SessionExecutionService["listRecords"]>,
  projectNotification?: MainSessionCommandFacadeDeps["projectTerminalFailureNotification"],
): SessionTurnExecutionProjection[] {
  let queuePosition = 0;
  const projected: SessionTurnExecutionProjection[] = [];
  for (const execution of executions) {
    const notification = projectNotification?.(execution, execution.request) ?? null;
    if (execution.state !== "running" && execution.state !== "queued" && !notification) continue;
    const position = execution.state === "queued" ? ++queuePosition : null;
    const request = parseSessionExecutionTurnRequest(execution.request);
    const base = {
      executionId: execution.id,
      sessionId: execution.sessionId,
      clientRequestId: request.turn.clientRequestId?.trim() || null,
      userMessage: request.turn.userMessage,
      initiator: request.initiator,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      ...(notification ? { terminalFailureNotification: notification } : {}),
    };
    projected.push(execution.state === "queued"
      ? {
        ...base,
        state: "queued",
        queuePosition: position!,
        canCancel: request.initiator?.kind === "user",
      }
      : execution.state === "running"
        ? { ...base, state: "running", queuePosition: null, canCancel: false }
        : { ...base, state: execution.state, queuePosition: null, canCancel: false });
  }
  return projected;
}

function fingerprintGuiTurn(sessionId: string, request: RunSessionTurnRequest): string {
  const { clientRequestId: _clientRequestId, submitSource: _submitSource, ...effectInput } = request;
  return fingerprint({ initiator: { kind: "user" }, sessionId, turn: effectInput });
}

function fingerprintGuiCancel(sessionId: string, request: CancelSessionExecutionRequest): string {
  return fingerprint({ sessionId, executionId: request.executionId });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function admissionFailure(code: string, message: string, retryable: boolean): EnqueueSessionTurnResult {
  return { ok: false, error: { code, message, retryable } };
}

function mapGuiExecutionError(error: unknown): SessionTurnAdmissionError | null {
  if (error instanceof SessionExecutionQueueFullError) {
    return {
      code: "QUEUE_FULL",
      message: "このSessionは待機中のTurnが10件に達しています。",
      retryable: true,
    };
  }
  if (error instanceof SessionTurnValidationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: isRetryableSessionTurnValidationCode(error.code),
    };
  }
  if (error instanceof SessionExecutionIdempotencyConflictError) {
    return { code: "IDEMPOTENCY_CONFLICT", message: error.message, retryable: false };
  }
  if (error instanceof SessionExecutionNotFoundError) {
    return { code: "EXECUTION_NOT_FOUND", message: error.message, retryable: false };
  }
  if (error instanceof SessionExecutionOwnerMismatchError) {
    return { code: "EXECUTION_OWNER_MISMATCH", message: error.message, retryable: false };
  }
  if (error instanceof SessionExecutionStateConflictError) {
    return { code: "EXECUTION_STATE_CONFLICT", message: error.message, retryable: false };
  }
  if (error instanceof SessionExecutionShuttingDownError) {
    return { code: "RUNTIME_SHUTTING_DOWN", message: error.message, retryable: true };
  }
  return null;
}

function isRetryableSessionTurnValidationCode(code: string): boolean {
  return [
    "PROVIDER_DISABLED",
    "PROVIDER_UNAVAILABLE",
    "CATALOG_REVISION_STALE",
  ].includes(code);
}
