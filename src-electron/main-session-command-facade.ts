import { createHash } from "node:crypto";

import type { ProviderQuotaTelemetry, RunSessionTurnRequest } from "../src/runtime-state.js";
import type {
  CancelSessionExecutionRequest,
  CancelSessionExecutionResult,
  EnqueueSessionTurnResult,
  SessionGuiTurnExecution,
  SessionTurnAdmissionError,
} from "../src/session-gui-execution.js";
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
  resumeSessionExecutionQueue?(sessionId: string): Promise<void> | void;
  validateWorkspaceDirectory(targetPath: unknown): Promise<WorkspaceDirectoryValidationResult>;
};

type MainOwnedCreateSessionInput = Omit<CreateSessionInput, "id">;

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

    return this.persistCreatedSession({
      ...sessionInput,
      id: sessionId,
      workspaceLabel: "SessionFolder",
      workspacePath,
      branch: "",
    });
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
      source: "gui" as const,
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
        execution: projectGuiTurnExecutions(
          this.deps.getSessionExecutionService().listRecords(sessionId),
        ).find((candidate) => candidate.executionId === execution.id) ?? null,
      };
    } catch (error) {
      const mapped = mapGuiExecutionError(error);
      if (mapped) return { ok: false, error: mapped };
      throw error;
    }
  }

  listGuiSessionTurnExecutions(sessionId: string): SessionGuiTurnExecution[] {
    return projectGuiTurnExecutions(this.deps.getSessionExecutionService().listRecords(sessionId));
  }

  async cancelSessionExecution(
    sessionId: string,
    request: CancelSessionExecutionRequest,
  ): Promise<CancelSessionExecutionResult> {
    try {
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

function projectGuiTurnExecutions(
  executions: ReturnType<SessionExecutionService["listRecords"]>,
): SessionGuiTurnExecution[] {
  let queuePosition = 0;
  const projected: SessionGuiTurnExecution[] = [];
  for (const execution of executions) {
    if (execution.state !== "running" && execution.state !== "queued") continue;
    const position = execution.state === "queued" ? ++queuePosition : null;
    const request = parseSessionExecutionTurnRequest(execution.request);
    if (request.source !== "gui") continue;
    const base = {
      executionId: execution.id,
      sessionId: execution.sessionId,
      clientRequestId: request.turn.clientRequestId?.trim() || null,
      userMessage: request.turn.userMessage,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
    };
    projected.push(execution.state === "queued"
      ? { ...base, state: "queued", queuePosition: position!, canCancel: true }
      : { ...base, state: "running", queuePosition: null, canCancel: false });
  }
  return projected;
}

function fingerprintGuiTurn(sessionId: string, request: RunSessionTurnRequest): string {
  const { clientRequestId: _clientRequestId, submitSource: _submitSource, ...effectInput } = request;
  return fingerprint({ sessionId, turn: effectInput });
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
    return { code: error.code, message: error.message, retryable: false };
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
