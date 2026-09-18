import { isDeepStrictEqual } from "node:util";
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
    return this.persistCreatedSession({
      ...input,
      id: this.issueSessionId(),
    });
  }

  async createSessionFromRequest(input: CreateSessionRequest): Promise<Session> {
    const parsed = parseCreateSessionRequest(input);
    const session = parsed.workspace?.kind === "session-folder"
      ? await this.createSessionFolderSession(parsed.sessionInput)
      : await this.deps.runProviderRuntimeOperationExclusive(
        () => this.createSessionFromRequestExclusive(parsed),
      );
    try {
      await this.deps.initializeCreatedSession(session);
      return session;
    } catch (cause) {
      try {
        await this.deleteSession(session.id);
        if (this.deps.isSessionFilesWorkspace(session)) {
          await this.deps.cleanupSessionFilesDirectory?.(session.id);
        }
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], "Session初期化と作成済みデータの後始末に失敗しました。", { cause });
      }
      throw cause;
    }
  }

  private async createSessionFromRequestExclusive(
    parsed: ReturnType<typeof parseCreateSessionRequest>,
  ): Promise<Session> {
    const { workspace, sessionInput: requestSessionInput } = parsed;
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
    throw new Error("workspace の作成方法を解釈できないよ。");
  }

  private async createSessionFolderSession(
    requestSessionInput: ReturnType<typeof parseCreateSessionRequest>["sessionInput"],
  ): Promise<Session> {
    const storageIdentity = this.deps.getSessionStorageIdentity();
    const initialSelection = await this.deps.resolveSessionLaunchSelection(requestSessionInput.provider);
    const sessionId = this.issueSessionId();
    const workspacePath = await this.deps.createSessionFilesDirectory(sessionId);
    if (!workspacePath.trim()) {
      throw new Error("SessionFolder を作成できなかったよ。");
    }

    let persistenceStarted = false;
    try {
      return await this.deps.runProviderRuntimeOperationExclusive(async () => {
        if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
          throw new Error("Session storage が作成中に切り替わったため、Session 作成を再試行してね。");
        }
        const latestSelection = await this.deps.resolveSessionLaunchSelection(requestSessionInput.provider);
        if (!isDeepStrictEqual(latestSelection, initialSelection)) {
          throw new Error("起動設定が作成中に変わったため、Session 作成を再試行してね。");
        }
        if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
          throw new Error("Session storage が作成中に切り替わったため、Session 作成を再試行してね。");
        }
        persistenceStarted = true;
        return this.persistCreatedSession({
          ...requestSessionInput,
          ...latestSelection,
          id: sessionId,
          workspaceLabel: "SessionFolder",
          workspacePath,
          branch: "",
        });
      });
    } catch (error) {
      if (!persistenceStarted) {
        try {
          await this.deps.cleanupSessionFilesDirectory?.(sessionId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "SessionFolder の後始末に失敗しました。", { cause: error });
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
