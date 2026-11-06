import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { realpath } from "node:fs/promises";
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
  type DeleteSessionsLastActiveBeforeCutoff,
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
import { assertChildSessionRole, normalizeSessionRelationship } from "../../src-shared/session/session-role.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import type { CreateChildSessionRequest } from "../../src-shared/session/session-child-creation.js";
import type { CharacterCatalogEntry, CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { captureSessionLifecycleResource, cleanupSessionLifecycleResource, prepareSessionLifecycleFiles } from "../session/session-lifecycle-files.js";
import type { SessionLifecycleOperation, SessionLifecycleResource } from "../session/session-lifecycle-operation.js";
import { ChildSessionCreationRejectedError } from "../session/session-storage-errors.js";

type MainSessionCommandFacadeDeps = {
  getSession(sessionId: string): Session | null;
  getSessions(): readonly Session[];
  getStoredSessionSummaries(): Promise<readonly SessionSummary[]> | readonly SessionSummary[];
  getSessionStorageIdentity(): object;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  resolveSessionLaunchSelection(providerId?: string | null, workspacePath?: string, capturedDefaults?: SessionLaunchSelection): Promise<SessionLaunchSelection>;
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
  listActiveCharacters?(): Promise<readonly CharacterCatalogEntry[]>;
  createCharacterRuntimeSnapshot?(characterId: string): Promise<CharacterRuntimeSnapshot | null>;
  randomCharacter?(): number;
  resolveSessionFilesDirectory?(sessionId: string): string;
  resolveCrewFilesDirectory?(rootSessionId: string): string;
  prepareSessionLifecycleFiles?(input: Parameters<typeof prepareSessionLifecycleFiles>[0], sessionId: string): Promise<string>;
  openCreatedChildSession?(session: Session): Promise<void> | void;
};

type MainOwnedCreateSessionInput = Omit<CreateSessionInput, "id">;

export class MainSessionCommandFacade {
  constructor(private readonly deps: MainSessionCommandFacadeDeps) {}

  async createChildSession(actor: { id: string; incarnationId: string }, input: CreateChildSessionRequest, assertCurrent: () => void): Promise<Session> {
    if (!input.requestId.trim()) throw new ChildSessionCreationRejectedError("A stable child creation request ID is required.");
    const prepared = await this.deps.runProviderRuntimeOperationExclusive(async () => {
      assertCurrent();
      const persistence = this.deps.getSessionPersistenceService();
      const parent = await persistence.readSessionForLifecycle(actor.id);
      if (!parent || getSessionIncarnationId(parent) !== actor.incarnationId || parent.sessionKind !== "default") throw new ChildSessionCreationRejectedError("The child creation parent no longer exists or is not a normal Session.");
      const relationship = normalizeSessionRelationship(parent);
      try { assertChildSessionRole(relationship.sessionRole, input.role); }
      catch (error) { throw new ChildSessionCreationRejectedError(error instanceof Error ? error.message : String(error)); }
      const operationId = JSON.stringify(["create", "agent", actor.id, actor.incarnationId, input.requestId]);
      let operation = await persistence.getSessionLifecycleOperation(operationId);
      let inputValidated = false;
      if (!operation) {
        const validation = await this.deps.validateWorkspaceDirectory(input.workspacePath);
        if (!validation.valid) throw new ChildSessionCreationRejectedError(`Workspace is unavailable. ${resolveWorkspaceDirectoryValidationMessage(validation)}`);
        try { await persistence.validateChildSessionCreation(input); }
        catch (error) { throw new ChildSessionCreationRejectedError(error instanceof Error ? error.message : String(error)); }
        inputValidated = true;
        assertCurrent();
        operation = await persistence.beginSessionLifecycleOperation({ operationId, kind: "create", input,
          targets: [{ id: this.issueSessionId(), rootSessionId: relationship.rootSessionId, parentSessionId: parent.id, parentIncarnationId: actor.incarnationId }] });
      } else {
        operation = await persistence.beginSessionLifecycleOperation({ operationId, kind: "create", input, targets: operation.targets });
      }
      const target = operation.targets[0];
      let session = await persistence.readSessionForLifecycle(target.id);
      if (session && target.incarnationId && getSessionIncarnationId(session) !== target.incarnationId) throw new Error("The created Session ID now belongs to another incarnation.");
      if (operation.phase === "complete") {
        if (!session) throw new Error("The successfully created Session no longer exists.");
        return { session, operationId, complete: true };
      }
      if (!session) {
        if (!inputValidated) {
          const validation = await this.deps.validateWorkspaceDirectory(input.workspacePath);
          if (!validation.valid) throw new Error(`Workspace is unavailable. ${resolveWorkspaceDirectoryValidationMessage(validation)}`);
          await persistence.validateChildSessionCreation(input);
        }
        if (!operation.preparedSession) {
          if (!this.deps.listActiveCharacters || !this.deps.createCharacterRuntimeSnapshot) throw new Error("Child Character selection is unavailable.");
          const candidates = await this.deps.listActiveCharacters();
          if (candidates.length === 0) throw new Error("No active Character is available for the child Session.");
          const pending = await persistence.listPendingSessionLifecycleOperations();
          const pendingSessions = (await Promise.all(pending.filter((item) => item.kind === "create").flatMap((item) => item.targets).map((item) => persistence.readSessionForLifecycle(item.id))))
            .filter((item): item is Session => item !== null);
          const crew = Array.from(new Map([...(await this.deps.getStoredSessionSummaries()), ...pendingSessions].map((member) => [member.id, member])).values())
            .filter((member) => normalizeSessionRelationship(member).rootSessionId === relationship.rootSessionId && member.sessionKind === "default");
          const counts = new Map(candidates.map((candidate) => [candidate.id, crew.filter((member) => member.characterId === candidate.id).length]));
          const minimum = Math.min(...counts.values());
          const leastUsed = candidates.filter((candidate) => counts.get(candidate.id) === minimum);
          const character = leastUsed[Math.min(leastUsed.length - 1, Math.floor((this.deps.randomCharacter?.() ?? Math.random()) * leastUsed.length))];
          const snapshot = await this.deps.createCharacterRuntimeSnapshot(character.id);
          if (!snapshot) throw new Error("The child Character snapshot could not be created.");
          operation = await persistence.prepareSessionLifecycleCreation(operationId, { id: target.id, taskTitle: input.title?.trim() || "New task", description: input.description ?? "",
            sessionRole: input.role, rootSessionId: relationship.rootSessionId, parentSessionId: parent.id, createdBySessionId: parent.id,
            provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort, approvalMode: input.approvalMode, codexSandboxMode: input.codexSandboxMode,
            workspacePath: input.workspacePath, workspaceLabel: input.workspacePath, branch: "", characterId: character.id,
            character: snapshot.name, characterIconPath: snapshot.iconFilePath ?? "", characterThemeColors: snapshot.theme, characterRuntimeSnapshot: snapshot });
        }
        await this.prepareCreationFiles(operation);
        session = await persistence.createSession(operation.preparedSession!, true);
        await persistence.advanceSessionLifecycleOperation(operationId, "applied");
      }
      return { session, operationId, complete: false };
    });
    if (prepared.complete) return prepared.session;
    await this.deps.initializeCreatedSession(prepared.session);
    const persistence = this.deps.getSessionPersistenceService();
    const completion = await persistence.advanceSessionLifecycleOperation(prepared.operationId, "complete");
    const session = await persistence.publishCreatedSession(prepared.session.id);
    if (completion.transitioned) await this.deps.openCreatedChildSession?.(session);
    return session;
  }

  async createSession(input: MainOwnedCreateSessionInput): Promise<Session> {
    return this.createSessionWithFilesDirectory(
      input.provider,
      (sessionId) => ({ ...input, id: sessionId }),
      input.workspacePath,
    );
  }

  async createSessionFromRequest(input: CreateSessionRequest, recoveringOperation?: SessionLifecycleOperation): Promise<Session> {
    const parsed = parseCreateSessionRequest(input);
    const { workspace, sessionInput } = parsed;
    if (workspace.kind === "directory" && (!workspace.label.trim() || !workspace.path.trim())) {
      throw new Error("Workspace information is incomplete.");
    }
    const persistence = this.deps.getSessionPersistenceService();
    const reservedId = this.issueSessionId();
    if (input.clientRequestId !== undefined && (typeof input.clientRequestId !== "string" || !input.clientRequestId.trim())) throw new Error("The creation request ID is invalid.");
    const operationId = recoveringOperation?.operationId ?? JSON.stringify(["create", "gui", input.clientRequestId?.trim() || reservedId]);
    const operation = await persistence.beginSessionLifecycleOperation({ operationId, kind: "create", input,
      targets: recoveringOperation?.targets ?? [{ id: reservedId, rootSessionId: reservedId, parentSessionId: null }] });
    const existing = await persistence.readSessionForLifecycle(operation.targets[0].id);
    if (existing && operation.targets[0].incarnationId && getSessionIncarnationId(existing) !== operation.targets[0].incarnationId) throw new Error("The created Session ID now belongs to another incarnation.");
    if (operation.phase === "complete") {
      if (!existing) throw new Error("The successfully created Session no longer exists.");
      return existing;
    }
    const session = existing ?? await this.createSessionWithFilesDirectory(
      sessionInput.provider,
      (sessionId, sessionFilesPath, launchSelection) => ({
        ...sessionInput,
        ...launchSelection,
        id: sessionId,
        workspaceLabel: workspace.kind === "session-folder" ? "SessionFolder" : workspace.label,
        workspacePath: workspace.kind === "session-folder" ? sessionFilesPath : workspace.path,
        branch: workspace.kind === "session-folder" ? "" : workspace.branch,
      }),
      workspace.kind === "directory" ? workspace.path : undefined,
      operation,
    );
    try {
      await this.deps.initializeCreatedSession(session);
      await persistence.advanceSessionLifecycleOperation(operationId, "complete");
      return persistence.publishCreatedSession(session.id);
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
    workspacePath?: string,
    lifecycle?: SessionLifecycleOperation,
  ): Promise<Session> {
    const storageIdentity = this.deps.getSessionStorageIdentity();
    const sessionId = lifecycle?.targets[0].id ?? this.issueSessionId();
    const sessionFilesPath = lifecycle ? await this.prepareCreationFiles(lifecycle) : await this.deps.createSessionFilesDirectory(sessionId);
    if (!sessionFilesPath.trim()) {
      throw new Error("The SessionFolder could not be created.");
    }

    let persistenceStarted = false;
    try {
      const discoveryWorkspacePath = workspacePath ?? sessionFilesPath;
      const initialSelection = await this.deps.resolveSessionLaunchSelection(providerId, discoveryWorkspacePath);
      return await this.deps.runProviderRuntimeOperationExclusive(async () => {
        if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
          throw new Error("Session storage changed during creation. Try creating the session again.");
        }
        const latestSelection = await this.deps.resolveSessionLaunchSelection(providerId, discoveryWorkspacePath, initialSelection);
        if (!isDeepStrictEqual(latestSelection, initialSelection)) {
          throw new Error("Startup settings changed during creation. Try creating the session again.");
        }
        if (this.deps.getSessionStorageIdentity() !== storageIdentity) {
          throw new Error("Session storage changed during creation. Try creating the session again.");
        }
        const input = buildInput(sessionId, sessionFilesPath, latestSelection);
        persistenceStarted = true;
        const session = await this.persistCreatedSession(input, !!lifecycle);
        if (lifecycle) await this.deps.getSessionPersistenceService().advanceSessionLifecycleOperation(lifecycle.operationId, "applied");
        return session;
      });
    } catch (error) {
      if (!persistenceStarted && !lifecycle) {
        try {
          await this.deps.cleanupSessionFilesDirectory?.(sessionId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "SessionFolder cleanup failed.", { cause: error });
        }
      }
      throw error;
    }
  }

  private async persistCreatedSession(input: CreateSessionInput & { id: string }, deferPublication = false): Promise<Session> {
    return this.deps.getSessionPersistenceService().createSession(input, deferPublication);
  }

  private async prepareCreationFiles(operation: SessionLifecycleOperation): Promise<string> {
    const sessionId = operation.targets[0].id;
    if (!this.deps.resolveSessionFilesDirectory && !this.deps.prepareSessionLifecycleFiles) throw new Error("The managed SessionFolder path is unavailable.");
    return (this.deps.prepareSessionLifecycleFiles ?? prepareSessionLifecycleFiles)({
      finalPath: this.deps.resolveSessionFilesDirectory?.(sessionId) ?? "",
      resource: operation.resources[0],
      persistResource: async (resource) => { await this.deps.getSessionPersistenceService().advanceSessionLifecycleOperation(operation.operationId, "preparing", [resource]); },
    }, sessionId);
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

  async promoteSessionToOverallCoordinator(sessionId: string, incarnationId: string, assertCurrent?: () => void): Promise<SessionSummary> {
    return this.deps.getSessionPersistenceService().promoteSessionToOverallCoordinator(sessionId, incarnationId, assertCurrent);
  }

  async setSessionPinned(request: SetSessionPinnedRequest): Promise<SessionSummary> {
    const normalized = parseSetSessionPinnedRequest(request);
    return this.deps.getSessionPersistenceService().setSessionPinned(normalized.sessionId, normalized.isPinned);
  }

  async getCrewDeletionStatus(sessionId: string, incarnationId: string): Promise<import("../../src-shared/session/session-crew-deletion.js").CrewDeletionStatus> {
    return this.deps.getSessionPersistenceService().getCrewDeletionStatus(sessionId, incarnationId);
  }

  async deleteSession(sessionId: string, onDeleted?: (result: DeleteSessionsResult) => void, cutoff?: DeleteSessionsLastActiveBeforeCutoff): Promise<void> {
    if (this.deps.resolveSessionFilesDirectory) {
      const persistence = this.deps.getSessionPersistenceService();
      let operation = (await persistence.listPendingSessionLifecycleOperations()).find((item) => item.kind === "delete" && item.targets[0]?.id === sessionId
        && (item.phase === "applied" || (item.input as { cutoffIso?: string }).cutoffIso === cutoff?.cutoffIso));
      if (!operation) {
        const saved = await this.deps.getStoredSessionSummaries();
        const root = saved.find((item) => item.id === sessionId);
        if (!root) return;
        if (root.parentSessionId) throw new Error("Only an entire Crew can be deleted from its root Session.");
        const crew = saved.filter((item) => normalizeSessionRelationship(item).rootSessionId === root.id);
        const candidatePaths = crew.map((member) => this.deps.resolveSessionFilesDirectory!(member.id));
        if (this.deps.resolveCrewFilesDirectory) candidatePaths.push(this.deps.resolveCrewFilesDirectory(root.id));
        const protection = await this.readLifecycleResourceProtection();
        const resources = await this.captureDeletionResources(candidatePaths, protection.workspacePaths);
        operation = await persistence.beginSessionLifecycleOperation({ operationId: JSON.stringify(["delete", root.id, getSessionIncarnationId(root), cutoff?.cutoffIso ?? null]), kind: "delete",
          input: { sessionId: root.id, incarnationId: getSessionIncarnationId(root), ...(cutoff ? { cutoffIso: cutoff.cutoffIso } : {}) },
          targets: [root, ...crew.filter((member) => member.id !== root.id)].map((member) => ({ id: member.id, incarnationId: getSessionIncarnationId(member), rootSessionId: root.id, parentSessionId: member.parentSessionId ?? null })), resources });
      }
      if (operation.phase === "preparing") {
        const result = await persistence.deleteSession(sessionId, operation.operationId);
        for (const id of [...result.deletedSessionIds, ...(result.deletedAuxiliarySessionIds ?? [])]) this.deps.dismissSessionTurnNotification(id);
        onDeleted?.(result);
        operation = (await persistence.getSessionLifecycleOperation(operation.operationId))!;
      }
      await this.finishLifecycleResourceCleanup(operation);
      return;
    }
    const sessionsById = new Map(this.deps.getSessions().map((session) => [session.id, session] as const));
    await this.cleanupDeletedSessions(
      await this.deps.getSessionPersistenceService().deleteSession(sessionId),
      sessionsById,
    );
  }

  private async finishLifecycleResourceCleanup(operation: SessionLifecycleOperation): Promise<void> {
    const persistence = this.deps.getSessionPersistenceService();
    const existing = (await this.readLifecycleResourceProtection()).sessions;
    if (operation.targets.some((target) => existing.some((session) => session.id === target.id && getSessionIncarnationId(session) !== target.incarnationId))) {
      throw new Error("Owned Files cleanup is pending because a target Session ID now belongs to another incarnation.");
    }
    let resources = operation.resources;
    for (let index = 0; index < resources.length; index += 1) {
      if (resources[index].cleaned) continue;
      const currentWorkspaces = (await this.readLifecycleResourceProtection()).workspacePaths;
      try {
        await captureSessionLifecycleResource(resources[index].path);
        if ((await this.captureDeletionResources([resources[index].path], currentWorkspaces)).length === 0) throw new Error("Owned Files cleanup is pending because the folder overlaps a current Workspace.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      resources = resources.map((resource, position) => position === index ? { ...resource } : resource);
      resources[index] = await cleanupSessionLifecycleResource(resources[index]);
      await persistence.advanceSessionLifecycleOperation(operation.operationId, "applied", resources);
    }
    await persistence.advanceSessionLifecycleOperation(operation.operationId, "complete", resources);
  }

  private async readLifecycleResourceProtection(): Promise<{ sessions: SessionSummary[]; workspacePaths: string[] }> {
    const persistence = this.deps.getSessionPersistenceService();
    const pending = (await persistence.listPendingSessionLifecycleOperations()).filter((operation) => operation.kind === "create");
    const pendingSessions = await Promise.all(pending.flatMap((operation) => operation.targets)
      .map((target) => persistence.readSessionSummaryForLifecycle(target.id)));
    const sessions = Array.from(new Map([...(await this.deps.getStoredSessionSummaries()), ...pendingSessions.filter((session): session is SessionSummary => session !== null)]
      .map((session) => [session.id, session])).values());
    const reservedWorkspaces = pending.flatMap((operation) => {
      const request = operation.input as { workspacePath?: unknown; workspace?: { kind?: unknown; path?: unknown } };
      return [operation.preparedSession?.workspacePath,
        typeof request?.workspacePath === "string" ? request.workspacePath : undefined,
        request?.workspace?.kind === "directory" && typeof request.workspace.path === "string" ? request.workspace.path : undefined,
        ...(request?.workspace?.kind === "session-folder" ? operation.resources.map((resource) => resource.path) : []),
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    });
    return { sessions, workspacePaths: [...sessions.map((session) => session.workspacePath), ...reservedWorkspaces] };
  }

  private async captureDeletionResources(candidatePaths: string[], workspacePaths: string[]): Promise<SessionLifecycleResource[]> {
    const resolvePath = async (value: string): Promise<string> => {
      const absolute = path.resolve(value);
      try { return await realpath(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return absolute;
      }
    };
    const workspaces = await Promise.all(workspacePaths.filter((value) => value.trim()).map(resolvePath));
    const contains = (parent: string, child: string): boolean => {
      const relative = path.relative(parent, child);
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    };
    const resources: SessionLifecycleResource[] = [];
    for (const candidate of candidatePaths) {
      const normalized = await resolvePath(candidate);
      if (workspaces.some((workspace) => contains(workspace, normalized) || contains(normalized, workspace))) continue;
      try { resources.push(await captureSessionLifecycleResource(candidate)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return resources;
  }

  async recoverPendingSessionLifecycleOperations(): Promise<void> {
    const persistence = this.deps.getSessionPersistenceService();
    const pending = await persistence.listPendingSessionLifecycleOperations();
    const failures: unknown[] = [];
    for (const operation of pending) {
      try {
        if (operation.kind === "delete" && operation.phase === "applied") await this.finishLifecycleResourceCleanup(operation);
        else if (operation.kind === "create") {
          const session = await persistence.readSessionForLifecycle(operation.targets[0].id);
          if (session && operation.targets[0].incarnationId && getSessionIncarnationId(session) !== operation.targets[0].incarnationId) throw new Error("The pending creation target identity changed.");
          if (!session) {
            const target = operation.targets[0];
            if (target.parentSessionId && target.parentIncarnationId) {
              await this.createChildSession({ id: target.parentSessionId, incarnationId: target.parentIncarnationId }, operation.input as CreateChildSessionRequest, () => {});
            } else if (!target.parentSessionId) {
              await this.createSessionFromRequest(operation.input as CreateSessionRequest, operation);
            } else throw new Error("The pending child creation has no saved parent incarnation.");
            continue;
          }
          await this.deps.initializeCreatedSession(session);
          const completion = await persistence.advanceSessionLifecycleOperation(operation.operationId, "complete");
          await persistence.publishCreatedSession(session.id);
          if (operation.targets[0].parentSessionId && completion.transitioned) await this.deps.openCreatedChildSession?.(session);
        }
      } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Some Session lifecycle operations still require recovery.");
  }

  async deleteSessionsLastActiveBefore(
    request: DeleteSessionsLastActiveBeforeRequest | null | undefined,
  ): Promise<DeleteSessionsResult> {
    const cutoff = resolveDeleteSessionsLastActiveBeforeCutoff(request);
    if (this.deps.resolveSessionFilesDirectory) {
      const persistence = this.deps.getSessionPersistenceService();
      const roots = await persistence.listCrewRootsLastActiveBefore(cutoff);
      const result: DeleteSessionsResult = { cutoffDate: cutoff.cutoffDate, cutoffTimestampMs: cutoff.cutoffTimestampMs, deletedSessionIds: [], deletedAuxiliarySessionIds: [], skippedRunningSessionIds: [] };
      const saved = await this.deps.getStoredSessionSummaries();
      const failures: unknown[] = [];
      for (const rootId of roots) {
        try {
          await this.deleteSession(rootId, (deleted) => {
            result.deletedSessionIds.push(...deleted.deletedSessionIds);
            result.deletedAuxiliarySessionIds!.push(...(deleted.deletedAuxiliarySessionIds ?? []));
          }, cutoff);
        } catch (error) {
          if (error instanceof Error && error.name === "SessionCrewDeletionBlockedError") {
            result.skippedRunningSessionIds.push(...saved.filter((member) => normalizeSessionRelationship(member).rootSessionId === rootId).map((member) => member.id));
          } else failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Some Crew deletions or owned Files cleanup did not complete.");
      return result;
    }
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
