import type { ProviderQuotaTelemetry, RunSessionTurnRequest } from "../src/runtime-state.js";
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

type MainSessionCommandFacadeDeps = {
  getSession(sessionId: string): Session | null;
  getSessions(): readonly Session[];
  getStoredSessionSummaries(): Promise<readonly SessionSummary[]> | readonly SessionSummary[];
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  resolveSessionLaunchSelection(providerId?: string | null): Promise<SessionLaunchSelection>;
  getSessionPersistenceService(): SessionPersistenceService;
  getSessionRuntimeService(): SessionRuntimeService;
  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null;
  isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean;
  refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  createSessionId(): string;
  createSessionFilesDirectory(sessionId: string): Promise<string> | string;
  isSessionFilesWorkspace(session: Pick<Session, "id" | "workspacePath">): boolean;
  dismissSessionTurnNotification(sessionId: string): void;
  cleanupSessionFilesDirectory?(sessionId: string): Promise<void>;
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
    this.deps.getSessionRuntimeService().cancelRun(sessionId);
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

    return this.deps.getSessionRuntimeService().runSessionTurn(sessionId, request);
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
