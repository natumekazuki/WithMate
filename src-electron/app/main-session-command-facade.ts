import { isDeepStrictEqual } from "node:util";
import type { ProviderQuotaTelemetry, RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import {
  parseSetSessionPinnedRequest,
  type CreateSessionInput,
  type CreateSessionRequest,
  type Session,
  type SessionSummary,
  type SetSessionPinnedRequest,
} from "../../src-shared/session/session-state.js";
import {
  resolveDeleteSessionsLastActiveBeforeCutoff,
  type DeleteSessionsLastActiveBeforeRequest,
  type DeleteSessionsResult,
} from "../../src-shared/window/withmate-window-types.js";
import type { SessionPersistenceService } from "../session/session-persistence-service.js";
import type { SessionRuntimeService } from "../session/session-runtime-service.js";
import { parseCreateSessionRequest } from "../session/create-session-request.js";
import type { SessionLaunchSelection } from "../session/session-launch-selection-service.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";
import { resolveWorkspaceDirectoryValidationMessage } from "../../src-shared/window/workspace-directory-validation.js";

type MainSessionCommandFacadeDeps = {
  getSession(sessionId: string): Session | null;
  getSessions(): readonly Session[];
  getStoredSessionSummaries(): Promise<readonly SessionSummary[]> | readonly SessionSummary[];
  getSessionStorageIdentity(): object;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  resolveSessionLaunchSelection(providerId?: string | null): Promise<SessionLaunchSelection>;
  getSessionPersistenceService(): SessionPersistenceService;
  getSessionRuntimeService(): SessionRuntimeService;
  getProviderQuotaTelemetry(providerId: string): ProviderQuotaTelemetry | null;
  isProviderQuotaTelemetryStale(telemetry: ProviderQuotaTelemetry | null): boolean;
  refreshProviderQuotaTelemetry(providerId: string): Promise<ProviderQuotaTelemetry | null>;
  initializeCreatedSession(session: Session): Promise<void>;
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
    return this.createSessionWithFilesDirectory(
      input.provider,
      (sessionId) => ({ ...input, id: sessionId }),
    );
  }

  async createSessionFromRequest(input: CreateSessionRequest): Promise<Session> {
    const parsed = parseCreateSessionRequest(input);
    const { workspace, sessionInput } = parsed;
    if (workspace.kind === "directory" && (!workspace.label.trim() || !workspace.path.trim())) {
      throw new Error("Workspace information is incomplete.");
    }
    const session = await this.createSessionWithFilesDirectory(
      sessionInput.provider,
      (sessionId, sessionFilesPath, launchSelection) => ({
        ...sessionInput,
        ...launchSelection,
        id: sessionId,
        workspaceLabel: workspace.kind === "session-folder" ? "SessionFolder" : workspace.label,
        workspacePath: workspace.kind === "session-folder" ? sessionFilesPath : workspace.path,
        branch: workspace.kind === "session-folder" ? "" : workspace.branch,
      }),
    );
    try {
      await this.deps.initializeCreatedSession(session);
      return session;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Main Session initialization failed after saving. Saved Session ID: ${session.id}. ${reason}`,
        { cause },
      );
    }
  }

  private async createSessionWithFilesDirectory(
    providerId: string | undefined,
    buildInput: (sessionId: string, sessionFilesPath: string, launchSelection: SessionLaunchSelection) => CreateSessionInput & { id: string },
  ): Promise<Session> {
    const storageIdentity = this.deps.getSessionStorageIdentity();
    const initialSelection = await this.deps.resolveSessionLaunchSelection(providerId);
    const sessionId = this.issueSessionId();
    const sessionFilesPath = await this.deps.createSessionFilesDirectory(sessionId);
    if (!sessionFilesPath.trim()) {
      throw new Error("The SessionFolder could not be created.");
    }

    let persistenceStarted = false;
    try {
      return await this.deps.runProviderRuntimeOperationExclusive(async () => {
        if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
          throw new Error("Session storage changed during creation. Try creating the session again.");
        }
        const latestSelection = await this.deps.resolveSessionLaunchSelection(providerId);
        if (!isDeepStrictEqual(latestSelection, initialSelection)) {
          throw new Error("Startup settings changed during creation. Try creating the session again.");
        }
        if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
          throw new Error("Session storage changed during creation. Try creating the session again.");
        }
        const input = buildInput(sessionId, sessionFilesPath, latestSelection);
        persistenceStarted = true;
        return this.persistCreatedSession(input);
      });
    } catch (error) {
      if (!persistenceStarted) {
        try {
          await this.deps.cleanupSessionFilesDirectory?.(sessionId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "SessionFolder cleanup failed.", { cause: error });
        }
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
      throw new Error("Could not issue a Session ID.");
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

  async steerSessionTurn(sessionId: string, request: import("../../src-shared/session/runtime-state.js").SteerSessionTurnRequest): Promise<import("../../src-shared/session/runtime-state.js").SteerSessionTurnResult> {
    const session = this.deps.getSession(sessionId);
    if (!session) throw new Error("The Session could not be found.");
    const validation = await this.deps.validateWorkspaceDirectory(session.workspacePath);
    if (!validation.valid) throw new Error(`Workspace is unavailable. ${resolveWorkspaceDirectoryValidationMessage(validation)}`);
    return this.deps.getSessionRuntimeService().steerSessionTurn(sessionId, request);
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
    for (const notificationTargetId of [
      ...result.deletedSessionIds,
      ...(result.deletedAuxiliarySessionIds ?? []),
    ]) {
      this.deps.dismissSessionTurnNotification(notificationTargetId);
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
