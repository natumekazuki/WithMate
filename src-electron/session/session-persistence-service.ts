import path from "node:path";
import { getProviderAppSettings, type AppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { assertSameSessionRelationship, normalizeSessionRelationship } from "../../src-shared/session/session-role.js";
import { validateSessionMetadataPatch, type SessionMetadataPatch } from "../../src-shared/session/session-metadata.js";
import type { SessionLifecycleOperation } from "./session-lifecycle-operation.js";
import type { CreateChildSessionRequest } from "../../src-shared/session/session-child-creation.js";
import { getSandboxOptionsForProvider } from "../../src-shared/settings/provider-runtime-options.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import type { CrewDeletionStatus } from "../../src-shared/session/session-crew-deletion.js";
import {
  buildNewSession,
  cloneSessions,
  getSessionIncarnationId,
  isReadOnlySession,
  projectSessionSummary,
  type CreateSessionInput,
  type Session,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  getModelCatalogItem,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { normalizeAllowedAdditionalDirectories } from "../files/additional-directories.js";
import { WorkspaceDirectoryValidationService } from "../files/workspace-directory-validation-service.js";
import { addAllowedAdditionalDirectory, removeAllowedAdditionalDirectory } from "../../src-shared/settings/additional-directory-state.js";
import type { ChangeSessionAdditionalDirectoryRequest } from "../../src-shared/session/session-mutation-contract.js";
import { DEFAULT_CODEX_REVIEWER, resolveCodexReviewerUpdate } from "../../src-shared/settings/codex-reviewer.js";
import { resolveExecutionOptionsReviewerUpdate } from "../../src-shared/settings/provider-runtime-options.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import { sessionSummaryToSession } from "./session-summary-adapter.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";
import { hasSameCharacterRuntimeIdentity } from "../../src-shared/character/character-runtime-snapshot.js";
import type {
  DeleteSessionsLastActiveBeforeCutoff,
  DeleteSessionsResult,
} from "../../src-shared/window/withmate-window-types.js";
import { SessionIdCollisionError, SessionNotFoundError, SessionCrewDeletionBlockedError } from "./session-storage-errors.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import { validateSessionExecutionOptions, type SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { assertModelEnabled } from "../../src-shared/settings/model-availability.js";
import type { ConfirmedReviewerChange, SetExecutionOptionsResult, SetSessionTitleResult } from "../../src-shared/session/session-mutation-contract.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "./session-running-turn-start.js";
import type { SessionRuntimeMetadataPatchInput, SessionRuntimeMetadataPatchResult, SessionThreadPatchInput, SessionThreadPatchResult } from "./session-storage-v6.js";
import type { SessionMetadataResult, SessionSteerAppendInput, SessionSteerBeginInput, SessionSteerSettleInput, SessionTerminalAppendInput, SessionRunMetadataCheckpointInput } from "./session-runtime-storage-contract.js";
import type { ComposerAttachment } from "../../src-shared/session/runtime-state.js";
import type { TurnInputDeliveryState } from "../../src-shared/session/session-state.js";
import type { SessionTurnInput, SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

export type SessionPersistenceServiceDeps = {
  runProviderRuntimeOperationExclusive?: RunProviderRuntimeOperationExclusive;
  getSessions(): Session[];
  setSessions(nextSessions: Session[]): void;
  getSession(sessionId: string): Session | null;
  getStoredSession?(sessionId: string): Awaitable<Session | null>;
  getStoredSessionSummary?(sessionId: string): Awaitable<SessionSummary | null>;
  isSessionRunInFlight(sessionId: string, scope?: "self" | "with-auxiliary"): boolean;
  listRunningActiveAuxiliaryParentIds?(sessionIds: readonly string[]): Awaitable<ReadonlySet<string>>;
  listAuxiliarySessionRuntimeIdentities?(
    parentSessionIds: readonly string[],
  ): Awaitable<readonly { id: string; parentSessionId: string; provider: string }[]>;
  upsertStoredSession(session: Session, operation: "create" | "upsert"): Awaitable<Session>;
  setStoredSessionTitle?(sessionId: string, incarnationId: string, title: string): Awaitable<void>;
  patchStoredSessionMetadata?(sessionId: string, incarnationId: string, patch: SessionMetadataPatch): Awaitable<SessionSummary>;
  promoteStoredSessionToOverallCoordinator?(sessionId: string, incarnationId: string): Awaitable<SessionSummary>;
  setStoredSessionMessageBookmark?(sessionId: string, incarnationId: string, messageIndex: number, isBookmarked: boolean): Awaitable<void>;
  setStoredSessionExecutionOptions?(sessionId: string, incarnationId: string, options: SessionExecutionOptions): Awaitable<void>;
  setStoredSessionAdditionalDirectories?(sessionId: string, incarnationId: string, directories: string[]): Awaitable<SessionSummary>;
  overlayCurrentExecutionOptions?(session: Session): Session;
  rememberExecutionOptions?(session: Session, options: SessionExecutionOptions): void;
  updateStoredSessionThreadIfMatches?(input: SessionThreadPatchInput): Awaitable<SessionThreadPatchResult | null>;
  updateStoredSessionRuntimeMetadataIfMatches?(input: SessionRuntimeMetadataPatchInput): Awaitable<SessionRuntimeMetadataPatchResult | null>;
  upsertStoredTerminalSession?(session: Session, terminalCommit: SessionTurnTerminalCommit): Awaitable<Session>;
  appendStoredRunningTurnStart?(input: SessionRunningTurnStartInput): Awaitable<SessionRunningTurnStartResult>;
  appendStoredSessionSteer?(input: SessionSteerAppendInput): Awaitable<SessionMetadataResult>;
  beginStoredSessionSteer?(input: SessionSteerBeginInput): Awaitable<SessionMetadataResult>;
  settleStoredSessionSteer?(input: SessionSteerSettleInput): Awaitable<SessionMetadataResult>;
  appendStoredSessionTerminal?(input: SessionTerminalAppendInput): Awaitable<SessionMetadataResult>;
  checkpointStoredSessionRunMetadata?(input: SessionRunMetadataCheckpointInput): Awaitable<SessionMetadataResult | null>;
  clearStoredCharacterAuthoringRuntimeState?(
    input: SessionCharacterAuthoringRuntimeClearInput,
  ): Awaitable<SessionCharacterAuthoringRuntimeClearResult>;
  replaceStoredSessions(sessions: Session[]): Awaitable<void>;
  setStoredSessionPinned?(sessionId: string, isPinned: boolean): Awaitable<SessionSummary>;
  listStoredSessions(): Awaitable<Session[]>;
  listStoredSessionSummaries?(): Awaitable<SessionSummary[]>;
  getSessionLifecycleOperation?(operationId: string): Awaitable<SessionLifecycleOperation | null>;
  listPendingSessionLifecycleOperations?(): Awaitable<SessionLifecycleOperation[]>;
  beginSessionLifecycleOperation?(input: Parameters<import("./session-storage-v6.js").SessionStorageV6["beginSessionLifecycleOperation"]>[0]): Awaitable<SessionLifecycleOperation>;
  advanceSessionLifecycleOperation?(operationId: string, phase: SessionLifecycleOperation["phase"], resources?: SessionLifecycleOperation["resources"]): Awaitable<SessionLifecycleOperation>;
  deleteSessionCrewForLifecycle?(operationId: string): Awaitable<SessionLifecycleOperation>;
  prepareSessionLifecycleCreation?(operationId: string, input: CreateSessionInput): Awaitable<SessionLifecycleOperation>;
  getStoredCrewDeletionStatus?(sessionId: string, incarnationId: string): Awaitable<CrewDeletionStatus>;
  listStoredSessionIdsLastActiveBefore?(cutoff: DeleteSessionsLastActiveBeforeCutoff): Awaitable<string[]>;
  deleteStoredSession?(sessionId: string): Awaitable<void>;
  deleteStoredSessions?(sessionIds: readonly string[]): Awaitable<void>;
  getAppSettings: () => Awaitable<AppSettings>;
  getModelCatalogSnapshot(workspacePath?: string, providerId?: string): Awaitable<ModelCatalogSnapshot>;
  createCharacterRuntimeSnapshot?(characterId: string): Awaitable<CharacterRuntimeSnapshot | null>;
  syncSessionDependencies(session: Session): void;
  clearSessionContextTelemetry(sessionId: string): void;
  clearSessionBackgroundActivities(sessionId: string): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  revokeSessionAgentRuntimeBindings?(sessionId: string): void;
  closeSessionWindow(sessionId: string): void;
  discardSessionWindow?(sessionId: string): void;
  broadcastSessions(sessionIds?: Iterable<string>, detailChanged?: false): void;
};

function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

function upsertSessionInList(sessions: Session[], stored: Session): Session[] {
  return [stored, ...sessions.filter((session) => session.id !== stored.id)];
}

function toCachedSession(session: Session): Session {
  return sessionSummaryToSession(projectSessionSummary(session));
}

function toCachedSessions(sessions: Session[]): Session[] {
  return sessions.map(toCachedSession);
}

function assertSessionWritable(session: Session): void {
  if (isReadOnlySession(session)) {
    throw new Error("Read-only sessions cannot be updated. Create a new session.");
  }
}

export class AdditionalDirectoryValidationError extends Error {}

type CommittedSessionDeletion = {
  result: DeleteSessionsResult;
  projectionFailures: unknown[];
  providerCleanup: Promise<PromiseSettledResult<void>>[];
};

export class SessionPersistenceService {
  private sessionMutationQueue: Promise<void> = Promise.resolve();
  private readonly selectionRequestRevisions = new Map<string, number>();
  private readonly selectionCheckpoints = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionPersistenceServiceDeps) {}

  private enqueueSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sessionMutationQueue.then(operation);
    this.sessionMutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async resolveCharacterAuthoringProvider(providerId: string): Promise<string> {
    return (await this.resolveEnabledProviderCatalog(
      await this.deps.getModelCatalogSnapshot(),
      await this.deps.getAppSettings(),
      providerId,
      true,
    )).id;
  }

  async createSession(input: CreateSessionInput, deferPublication = false): Promise<Session> {
    const requestedSessionId = input.id?.trim() ?? "";
    if (
      requestedSessionId &&
      (
        this.deps.getSession(requestedSessionId) ||
        await this.deps.getStoredSession?.(requestedSessionId)
      )
    ) {
      throw new SessionIdCollisionError(requestedSessionId);
    }

    const appSettings = await this.deps.getAppSettings();
    const snapshot = await this.deps.getModelCatalogSnapshot(input.workspacePath,
      input.model ? undefined : input.provider ?? DEFAULT_PROVIDER_ID);
    const provider = this.resolveEnabledProviderCatalog(
      snapshot,
      appSettings,
      input.provider,
      input.sessionKind === "character-authoring",
    );
    const requestedModel = input.model ?? provider.defaultModelId;
    if (!requestedModel.trim()) {
      throw new Error(`Provider ${provider.id} has no available model. Complete model discovery before creating a Session.`);
    }
    const requestedReasoningEffort = input.reasoningEffort ?? provider.defaultReasoningEffort;
    assertModelEnabled(appSettings.modelAvailability, provider.id, requestedModel);
    const selection = resolveModelSelection(
      provider,
      requestedModel,
      requestedReasoningEffort,
    );
    const created = buildNewSession({
      ...input,
      provider: provider.id,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      characterRuntimeSnapshot:
        input.characterRuntimeSnapshot ?? await this.deps.createCharacterRuntimeSnapshot?.(input.characterId) ?? null,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        input.workspacePath,
        input.allowedAdditionalDirectories ?? [],
      ),
    });
    return this.upsertSession(created, "create", deferPublication);
  }

  async validateChildSessionCreation(input: CreateChildSessionRequest): Promise<void> {
    const settings = await this.deps.getAppSettings();
    const catalog = await this.deps.getModelCatalogSnapshot(input.workspacePath, input.provider);
    const provider = this.resolveEnabledProviderCatalog(catalog, settings, input.provider, true);
    const model = getModelCatalogItem(provider, input.model);
    if (!model) throw new Error("The selected child model is not in the discovered model list.");
    if (model.reasoningEfforts.length === 0 ? input.reasoningEffort !== "" : !model.reasoningEfforts.includes(input.reasoningEffort)) throw new Error("The selected child depth is not supported by this model.");
    assertModelEnabled(settings.modelAvailability, provider.id, model.id);
    const sandbox = getSandboxOptionsForProvider(provider.id);
    if (sandbox.length === 0 ? input.codexSandboxMode !== undefined : !sandbox.some((option) => option.value === input.codexSandboxMode)) throw new Error("The selected child sandbox option is not supported by this provider.");
    if (input.codexReviewer !== undefined && provider.id !== "codex") throw new Error("Only Codex supports codexReviewer for child creation.");
    validateSessionExecutionOptions({ model: input.model, reasoningEffort: input.reasoningEffort, approvalMode: input.approvalMode,
      codexSandboxMode: input.codexSandboxMode ?? DEFAULT_CODEX_SANDBOX_MODE, codexSpeed: "standard", codexReviewer: input.codexReviewer ?? DEFAULT_CODEX_REVIEWER, customAgentName: "" }, provider);
    validateSessionMetadataPatch({ title: input.title ?? "New task", description: input.description ?? "" });
  }

  async prepareSessionLifecycleCreation(operationId: string, input: CreateSessionInput): Promise<SessionLifecycleOperation> {
    if (!this.deps.prepareSessionLifecycleCreation) throw new Error("Session lifecycle preparation storage is unavailable.");
    return this.deps.prepareSessionLifecycleCreation(operationId, input);
  }

  async getSessionLifecycleOperation(operationId: string): Promise<SessionLifecycleOperation | null> {
    if (!this.deps.getSessionLifecycleOperation) throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.getSessionLifecycleOperation(operationId);
  }

  async listPendingSessionLifecycleOperations(): Promise<SessionLifecycleOperation[]> {
    if (!this.deps.listPendingSessionLifecycleOperations) throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.listPendingSessionLifecycleOperations();
  }

  async beginSessionLifecycleOperation(input: Parameters<NonNullable<SessionPersistenceServiceDeps["beginSessionLifecycleOperation"]>>[0]): Promise<SessionLifecycleOperation> {
    if (!this.deps.beginSessionLifecycleOperation) throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.beginSessionLifecycleOperation(input);
  }

  async advanceSessionLifecycleOperation(operationId: string, phase: SessionLifecycleOperation["phase"], resources?: SessionLifecycleOperation["resources"]): Promise<SessionLifecycleOperation> {
    if (!this.deps.advanceSessionLifecycleOperation) throw new Error("Session lifecycle storage is unavailable.");
    return this.deps.advanceSessionLifecycleOperation(operationId, phase, resources);
  }

  async publishCreatedSession(sessionId: string): Promise<Session> {
    const session = await this.deps.getStoredSession?.(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    this.syncStoredSession(session);
    this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(session)));
    this.deps.broadcastSessions([sessionId]);
    return session;
  }

  async readSessionForLifecycle(sessionId: string): Promise<Session | null> {
    if (!this.deps.getStoredSession) throw new Error("Session lifecycle reads are unavailable.");
    return this.deps.getStoredSession(sessionId);
  }

  async readSessionSummaryForLifecycle(sessionId: string): Promise<SessionSummary | null> {
    if (this.deps.getStoredSessionSummary) return this.deps.getStoredSessionSummary(sessionId);
    const session = await this.readSessionForLifecycle(sessionId);
    return session ? projectSessionSummary(session) : null;
  }

  async updateSession(nextSession: Session): Promise<Session> {
    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      throw new SessionNotFoundError(nextSession.id);
    }

    assertSessionWritable(currentSession);

    const storedCurrentSession = await this.deps.getStoredSession?.(nextSession.id) ?? currentSession;
    assertSameSessionRelationship(storedCurrentSession, nextSession);
    if (getSessionIncarnationId(storedCurrentSession) !== getSessionIncarnationId(nextSession)) {
      throw new SessionNotFoundError(nextSession.id);
    }
    if (nextSession.messageCount !== undefined || nextSession.messages.some((message) => message.historyIndex !== undefined)) {
      const { messageCount: _count, ...metadata } = nextSession;
      nextSession = { ...metadata, messages: storedCurrentSession.messages, stream: storedCurrentSession.stream };
    }
    if (!hasSameCharacterRuntimeIdentity(storedCurrentSession, nextSession)) {
      throw new Error("A session's Character owner and runtime snapshot cannot be updated.");
    }

    if (this.deps.isSessionRunInFlight(nextSession.id) || isRunningSession(currentSession)) {
      if (nextSession.taskTitle !== currentSession.taskTitle || nextSession.provider !== currentSession.provider
        || nextSession.workspacePath !== currentSession.workspacePath || nextSession.threadId !== storedCurrentSession.threadId
        || nextSession.status !== currentSession.status || nextSession.runState !== currentSession.runState) {
        throw new Error("A running session cannot be updated.");
      }
      return this.enqueueSessionMutation(async () => {
        const latest = this.deps.getSession(nextSession.id);
        if (!latest || getSessionIncarnationId(latest) !== getSessionIncarnationId(nextSession)) throw new SessionNotFoundError(nextSession.id);
        assertSessionWritable(latest);
        const stored = await this.deps.getStoredSession?.(nextSession.id) ?? latest;
        if (getSessionIncarnationId(stored) !== getSessionIncarnationId(nextSession)) throw new SessionNotFoundError(nextSession.id);
        return this.upsertSessionNow({
          ...stored,
          allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(stored.workspacePath, nextSession.allowedAdditionalDirectories),
          updatedAt: nextSession.updatedAt,
        }, "upsert");
      });
    }

    const shouldResetThreadId =
      Boolean(currentSession.threadId) &&
      currentSession.provider !== nextSession.provider;

    const updatedSession = await this.upsertSession({
      ...nextSession,
      threadId: shouldResetThreadId ? "" : nextSession.threadId,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        nextSession.workspacePath,
        nextSession.allowedAdditionalDirectories,
      ),
    });

    const providerChanged = currentSession.provider !== updatedSession.provider;
    if (providerChanged) {
      this.deps.clearSessionContextTelemetry(updatedSession.id);
      this.deps.revokeSessionAgentRuntimeBindings?.(updatedSession.id);
      await this.deps.invalidateProviderSessionThread(currentSession.provider, updatedSession.id);
    }

    if (!providerChanged && currentSession.threadId && !updatedSession.threadId) {
      await this.deps.invalidateProviderSessionThread(currentSession.provider, updatedSession.id);
    }

    return updatedSession;
  }

  async changeAdditionalDirectory(request: ChangeSessionAdditionalDirectoryRequest, assertCurrent?: () => void): Promise<SessionSummary> {
    const { sessionId, incarnationId, operation, directoryPath } = request;
    if ((operation !== "add" && operation !== "remove") || typeof directoryPath !== "string"
      || !directoryPath.trim() || directoryPath.length > 32768 || !path.isAbsolute(directoryPath)
      || (process.platform === "win32" && path.parse(directoryPath).root.length === 1)) {
      throw new AdditionalDirectoryValidationError("An absolute additional directory path is required.");
    }
    if (operation === "add") {
      const validation = await new WorkspaceDirectoryValidationService().validate(directoryPath);
      if (!validation.valid) throw new AdditionalDirectoryValidationError(`The additional directory is invalid: ${validation.reason}.`);
    }
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId) throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      const stored = await this.deps.getStoredSessionSummary?.(sessionId) ?? await this.deps.getStoredSession?.(sessionId) ?? current;
      if (getSessionIncarnationId(stored) !== incarnationId) throw new SessionNotFoundError(sessionId);
      const directories = operation === "add"
        ? addAllowedAdditionalDirectory(stored.allowedAdditionalDirectories, directoryPath)
        : removeAllowedAdditionalDirectory(stored.allowedAdditionalDirectories, directoryPath);
      if (!this.deps.setStoredSessionAdditionalDirectories) throw new Error("Session additional directory storage is unavailable.");
      assertCurrent?.();
      const summary = await this.deps.setStoredSessionAdditionalDirectories(sessionId, incarnationId, normalizeAllowedAdditionalDirectories(stored.workspacePath, directories));
      this.runCommittedProjectionBestEffort("additional directory", "cache update", () => this.deps.setSessions(this.deps.getSessions().map((session) =>
        session.id === sessionId && getSessionIncarnationId(session) === incarnationId ? { ...session, allowedAdditionalDirectories: summary.allowedAdditionalDirectories } : session)));
      this.runCommittedProjectionBestEffort("additional directory", "broadcast", () => this.deps.broadcastSessions([sessionId]));
      return summary;
    });
  }

  async promoteSessionToOverallCoordinator(sessionId: string, incarnationId: string, assertCurrent?: () => void): Promise<SessionSummary> {
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId) throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (current.sessionKind !== "default" || (current.sessionRole ?? "standalone") !== "standalone" || this.deps.isSessionRunInFlight(sessionId, "self") || isRunningSession(current)) {
        throw new Error("Only an idle Standalone Session can become an overall coordinator.");
      }
      if (!this.deps.promoteStoredSessionToOverallCoordinator) throw new Error("Session Role storage is unavailable.");
      assertCurrent?.();
      const summary = await this.deps.promoteStoredSessionToOverallCoordinator(sessionId, incarnationId);
      this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), { ...current, ...summary }));
      this.deps.broadcastSessions([sessionId]);
      return summary;
    });
  }

  async patchSessionMetadata(sessionId: string, incarnationId: string, patch: SessionMetadataPatch, assertCurrent?: () => void): Promise<SessionSummary> {
    const value = validateSessionMetadataPatch(patch);
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId) throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (!this.deps.patchStoredSessionMetadata) throw new Error("Session metadata storage is unavailable.");
      assertCurrent?.();
      const summary = await this.deps.patchStoredSessionMetadata(sessionId, incarnationId, value);
      this.runCommittedProjectionBestEffort("metadata", "cache update", () => this.deps.setSessions(this.deps.getSessions().map((session) => session.id === sessionId && getSessionIncarnationId(session) === incarnationId
        ? { ...session, taskTitle: summary.taskTitle, description: summary.description } : session)));
      this.runCommittedProjectionBestEffort("metadata", "broadcast", () => this.deps.broadcastSessions([sessionId], false));
      return summary;
    });
  }

  async setSessionTitle(sessionId: string, incarnationId: string, title: string): Promise<SetSessionTitleResult> {
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId) throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (this.deps.isSessionRunInFlight(sessionId) || isRunningSession(current)) {
        throw new Error("A running session cannot be updated.");
      }
      if (!title.trim()) throw new Error("The Session title cannot be empty.");
      if (!this.deps.setStoredSessionTitle) throw new Error("Session title storage is unavailable.");
      await this.deps.setStoredSessionTitle(sessionId, incarnationId, title);
      let projectionUpdated = true;
      try {
        this.deps.setSessions(this.deps.getSessions().map((session) => session.id === sessionId && getSessionIncarnationId(session) === incarnationId
          ? { ...session, taskTitle: title } : session));
      } catch (error) {
        projectionUpdated = false;
        console.warn("Committed Session title cache projection failed", error);
      }
      try {
        this.deps.broadcastSessions([sessionId], false);
      } catch (error) {
        projectionUpdated = false;
        console.warn("Committed Session title broadcast failed", error);
      }
      return { status: "committed", projectionUpdated };
    });
  }

  async setSessionMessageBookmark(sessionId: string, incarnationId: string, messageIndex: number, isBookmarked: boolean): Promise<void> {
    return this.enqueueSessionMutation(async () => {
      const current = this.deps.getSession(sessionId);
      if (!current || getSessionIncarnationId(current) !== incarnationId) throw new SessionNotFoundError(sessionId);
      assertSessionWritable(current);
      if (!this.deps.setStoredSessionMessageBookmark) throw new Error("Session bookmark storage is unavailable.");
      await this.deps.setStoredSessionMessageBookmark(sessionId, incarnationId, messageIndex, isBookmarked);
    });
  }

  async setSessionExecutionOptions(sessionId: string, incarnationId: string, options: SessionExecutionOptions, confirmedReviewerChange?: ConfirmedReviewerChange): Promise<SetExecutionOptionsResult> {
    const revision = (this.selectionRequestRevisions.get(sessionId) ?? 0) + 1;
    this.selectionRequestRevisions.set(sessionId, revision);
    const catalog = await this.deps.getModelCatalogSnapshot();
    if (this.selectionRequestRevisions.get(sessionId) !== revision) {
      throw new Error("The Session execution option selection was superseded.");
    }
    const current = this.deps.getSession(sessionId);
    if (!current || getSessionIncarnationId(current) !== incarnationId) throw new SessionNotFoundError(sessionId);
    assertSessionWritable(current);
    const fresh = this.deps.overlayCurrentExecutionOptions?.(current) ?? current;
    const provider = catalog.providers.find((entry) => entry.id === fresh.provider);
    if (!provider) throw new Error("The Session provider is not in the model catalog.");
    const validated = { ...validateSessionExecutionOptions(options, provider),
      codexReviewer: resolveExecutionOptionsReviewerUpdate(fresh, options, confirmedReviewerChange) };
    if (validated.codexReviewer !== options.codexReviewer) validateSessionExecutionOptions(validated, provider);
    this.deps.rememberExecutionOptions?.(fresh, validated);
    this.deps.setSessions(this.deps.getSessions().map((session) => session.id === sessionId && getSessionIncarnationId(session) === incarnationId
      ? { ...session, ...validated } : session));
    const previous = this.selectionCheckpoints.get(sessionId) ?? Promise.resolve();
    const checkpoint = previous.catch(() => undefined).then(async () => {
      if (!this.deps.setStoredSessionExecutionOptions) throw new Error("Session execution option storage is unavailable.");
      await this.deps.setStoredSessionExecutionOptions(sessionId, incarnationId, validated);
    });
    this.selectionCheckpoints.set(sessionId, checkpoint);
    try {
      await checkpoint;
      return { status: "accepted", checkpointSaved: true };
    } catch {
      return { status: "accepted", checkpointSaved: false };
    } finally {
      if (this.selectionCheckpoints.get(sessionId) === checkpoint) this.selectionCheckpoints.delete(sessionId);
    }
  }

  async setSessionPinned(sessionId: string, isPinned: boolean): Promise<SessionSummary> {
    return this.enqueueSessionMutation(() => this.setSessionPinnedNow(sessionId, isPinned));
  }

  private async setSessionPinnedNow(sessionId: string, isPinned: boolean): Promise<SessionSummary> {
    if (!this.deps.setStoredSessionPinned) {
      throw new Error("Pinning is not available for this session format.");
    }
    const stored = await this.deps.setStoredSessionPinned(sessionId, isPinned);
    this.deps.setSessions(this.deps.getSessions().map((session) => (
      session.id === stored.id ? { ...session, isPinned: stored.isPinned } : session
    )));
    this.deps.broadcastSessions([stored.id], false);
    return projectSessionSummary(stored);
  }

  async deleteSession(sessionId: string, lifecycleOperationId?: string): Promise<DeleteSessionsResult> {
    const commit = () => this.deleteSessionsByIds([sessionId], { runningPolicy: "throw", allowUncachedDeletion: false, lifecycleOperationId });
    const committed = await (this.deps.runProviderRuntimeOperationExclusive?.(commit) ?? commit());
    return this.finishSessionDeletion(committed);
  }

  async deleteSessionsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): Promise<DeleteSessionsResult> {
    const commit = async () => {
      const sessionIds = this.deps.listStoredSessionIdsLastActiveBefore
        ? await this.deps.listStoredSessionIdsLastActiveBefore(cutoff)
        : (await this.deps.listStoredSessions())
            .filter((session) => Date.parse(session.updatedAt) < cutoff.cutoffTimestampMs)
            .map((session) => session.id);
      return this.deleteSessionsByIds(sessionIds, { runningPolicy: "skip", cutoff, allowUncachedDeletion: true });
    };
    const committed = await (this.deps.runProviderRuntimeOperationExclusive?.(commit) ?? commit());
    return this.finishSessionDeletion(committed);
  }

  async listCrewRootsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): Promise<string[]> {
    if (!this.deps.listStoredSessionIdsLastActiveBefore) throw new Error("Crew cutoff storage is unavailable.");
    return this.deps.listStoredSessionIdsLastActiveBefore(cutoff);
  }

  async getCrewDeletionStatus(rootSessionId: string, incarnationId: string): Promise<CrewDeletionStatus> {
    if (!this.deps.getStoredCrewDeletionStatus) throw new Error("Crew deletion status storage is unavailable.");
    const status = await this.deps.getStoredCrewDeletionStatus(rootSessionId, incarnationId);
    const saved = this.deps.listStoredSessionSummaries ? await this.deps.listStoredSessionSummaries() : await this.deps.listStoredSessions();
    const inFlight = saved.filter((session) => normalizeSessionRelationship(session).rootSessionId === rootSessionId && this.deps.isSessionRunInFlight(session.id));
    const blockers = [...status.blockers, ...inFlight.filter((session) => !status.blockers.some((blocker) => blocker.kind === "running" && blocker.sessionId === session.id))
      .map((session) => ({ kind: "running" as const, id: session.id, sessionId: session.id, message: "A Session execution is still in flight." }))];
    return { allowed: blockers.length === 0, blockers };
  }

  async updateSessionThreadIfMatches(input: SessionThreadPatchInput): Promise<SessionThreadPatchResult | null> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.updateStoredSessionThreadIfMatches) {
        throw new Error("Conditional Session thread update storage is unavailable.");
      }
      const stored = await this.deps.updateStoredSessionThreadIfMatches(input);
      if (!stored) {
        return null;
      }
      const current = this.deps.getSession(input.sessionId);
      if (
        current
        && getSessionIncarnationId(current) === input.incarnationId
        && current.provider === input.provider
        && current.threadId === input.expectedThreadId
      ) {
        this.deps.setSessions(this.deps.getSessions().map((session) => session.id === input.sessionId
          ? { ...session, threadId: input.nextThreadId, updatedAt: stored.updatedAt }
          : session));
      }
      return stored;
    });
  }

  async updateSessionRuntimeMetadataIfMatches(input: SessionRuntimeMetadataPatchInput): Promise<SessionRuntimeMetadataPatchResult | null> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.updateStoredSessionRuntimeMetadataIfMatches) {
        throw new Error("Conditional Session runtime metadata update storage is unavailable.");
      }
      const stored = await this.deps.updateStoredSessionRuntimeMetadataIfMatches(input);
      if (!stored) {
        return null;
      }
      const current = this.deps.getSession(input.sessionId);
      if (
        current &&
        getSessionIncarnationId(current) === input.incarnationId &&
        current.provider === input.expected.provider &&
        current.model === input.expected.model &&
        current.reasoningEffort === input.expected.reasoningEffort &&
        current.threadId === input.expected.threadId
      ) {
        this.deps.setSessions(this.deps.getSessions().map((session) => session.id === input.sessionId
          ? {
              ...session,
              provider: input.next.provider,
              catalogRevision: input.next.catalogRevision,
              model: input.next.model,
              reasoningEffort: input.next.reasoningEffort,
              threadId: input.next.threadId,
              updatedAt: stored.updatedAt,
            }
          : session));
      }
      return stored;
    });
  }

  private async finishSessionDeletion(committed: CommittedSessionDeletion): Promise<DeleteSessionsResult> {
    const results = await Promise.all(committed.providerCleanup);
    const failures = [
      ...committed.projectionFailures,
      ...results.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
    ];
    if (failures.length > 0) {
      throw new AggregateError(failures, "The Session was deleted, but post-deletion projection or provider thread cleanup failed.");
    }
    return committed.result;
  }

  private async deleteSessionsByIds(
    sessionIds: readonly string[],
    options: {
      runningPolicy: "throw" | "skip";
      cutoff?: DeleteSessionsLastActiveBeforeCutoff;
      allowUncachedDeletion: boolean;
      lifecycleOperationId?: string;
    },
  ): Promise<CommittedSessionDeletion> {
    const requestedSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    const savedSessions = this.deps.listStoredSessionSummaries
      ? await this.deps.listStoredSessionSummaries() : await this.deps.listStoredSessions();
    const allSessionsById = new Map([...savedSessions, ...this.deps.getSessions()].map((session) => [session.id, session] as const));
    const crews = requestedSessionIds.map((rootId) => {
      const root = allSessionsById.get(rootId);
      if (root?.parentSessionId) throw new Error("Only an entire Crew can be deleted from its root Session.");
      return Array.from(allSessionsById.values()).filter((member) => normalizeSessionRelationship(member).rootSessionId === rootId).map((member) => member.id);
    });
    const uniqueSessionIds = Array.from(new Set(crews.flat()));
    const skippedRunningSessionIds: string[] = [];
    const deletableSessionIds: string[] = [];
    const currentSessionsById = allSessionsById;
    const runningActiveAuxiliaryParentIds =
      await this.deps.listRunningActiveAuxiliaryParentIds?.(uniqueSessionIds) ?? new Set<string>();
    const auxiliaryRuntimeIdentities =
      await this.deps.listAuxiliarySessionRuntimeIdentities?.(uniqueSessionIds) ?? [];

    for (const crew of crews) {
      if (crew.some((sessionId) => {
        const session = currentSessionsById.get(sessionId);
        return this.deps.isSessionRunInFlight(sessionId) || runningActiveAuxiliaryParentIds.has(sessionId)
          || (session ? session.status === "running" || session.runState === "running" : false);
      })) {
        if (options.runningPolicy === "throw") {
          throw new SessionCrewDeletionBlockedError("A running Crew cannot be deleted.");
        }
        skippedRunningSessionIds.push(...crew);
        continue;
      }
      deletableSessionIds.push(...crew);
    }

    if (deletableSessionIds.length === 0) {
      return {
        result: {
          cutoffDate: options.cutoff?.cutoffDate,
          cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
          deletedSessionIds: [],
          deletedAuxiliarySessionIds: [],
          skippedRunningSessionIds,
        },
        providerCleanup: [],
        projectionFailures: [],
      };
    }

    if (options.lifecycleOperationId) {
      if (!this.deps.deleteSessionCrewForLifecycle) throw new Error("Crew lifecycle deletion storage is unavailable.");
      await this.deps.deleteSessionCrewForLifecycle(options.lifecycleOperationId);
    } else if (this.deps.deleteStoredSessions) {
      await this.deps.deleteStoredSessions(deletableSessionIds);
    } else if (this.deps.deleteStoredSession) {
      for (const sessionId of deletableSessionIds) {
        await this.deps.deleteStoredSession(sessionId);
      }
    } else {
      throw new Error("session delete storage dependency is not configured.");
    }
    const deletableSessionIdSet = new Set(deletableSessionIds);
    const projectionFailures: unknown[] = [];
    const projectDeletion = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        projectionFailures.push(error);
      }
    };
    projectDeletion(() => this.deps.setSessions(this.deps.getSessions().filter((entry) => !deletableSessionIdSet.has(entry.id))));
    const runtimeIdentities: { id: string; provider: string | null }[] = [];

    for (const sessionId of deletableSessionIds) {
      const deletedSession = currentSessionsById.get(sessionId);
      projectDeletion(() => this.deps.revokeSessionAgentRuntimeBindings?.(sessionId));
      runtimeIdentities.push({ id: sessionId, provider: deletedSession?.provider ?? null });
      projectDeletion(() => this.deps.clearSessionContextTelemetry(sessionId));
      projectDeletion(() => this.deps.clearSessionBackgroundActivities(sessionId));
      projectDeletion(() => (this.deps.discardSessionWindow ?? this.deps.closeSessionWindow)(sessionId));
    }
    const deletableParentIds = new Set(deletableSessionIds);
    const deletedAuxiliarySessionIds = auxiliaryRuntimeIdentities
      .filter((auxiliary) => deletableParentIds.has(auxiliary.parentSessionId))
      .map((auxiliary) => auxiliary.id);
    for (const auxiliary of auxiliaryRuntimeIdentities) {
      if (!deletableParentIds.has(auxiliary.parentSessionId)) {
        continue;
      }
      projectDeletion(() => this.deps.revokeSessionAgentRuntimeBindings?.(auxiliary.id));
      runtimeIdentities.push({ id: auxiliary.id, provider: auxiliary.provider });
      projectDeletion(() => this.deps.clearSessionContextTelemetry(auxiliary.id));
      projectDeletion(() => this.deps.clearSessionBackgroundActivities(auxiliary.id));
      projectDeletion(() => (this.deps.discardSessionWindow ?? this.deps.closeSessionWindow)(auxiliary.id));
    }

    projectDeletion(() => this.deps.broadcastSessions(deletableSessionIds));

    // Detach every old runtime synchronously before the ownership boundary opens.
    // Provider adapters capture old resources before their first asynchronous wait.
    const providerCleanup = runtimeIdentities.map((identity): Promise<PromiseSettledResult<void>> => {
      try {
        return Promise.resolve(this.deps.invalidateProviderSessionThread(identity.provider, identity.id)).then(
          () => ({ status: "fulfilled", value: undefined }),
          (reason: unknown) => ({ status: "rejected", reason }),
        );
      } catch (reason) {
        return Promise.resolve({ status: "rejected", reason });
      }
    });

    return {
      result: {
        cutoffDate: options.cutoff?.cutoffDate,
        cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
        deletedSessionIds: deletableSessionIds,
        deletedAuxiliarySessionIds,
        skippedRunningSessionIds,
      },
      providerCleanup,
      projectionFailures,
    };
  }

  async upsertSession(
    nextSession: Session,
    operation: "create" | "upsert" = "upsert",
    deferPublication = false,
  ): Promise<Session> {
    return this.enqueueSessionMutation(() => this.upsertSessionNow(nextSession, operation, undefined, deferPublication));
  }

  async upsertTerminalSession(
    nextSession: Session,
    terminalCommit: SessionTurnTerminalCommit,
  ): Promise<Session> {
    return this.enqueueSessionMutation(() => this.upsertSessionPreservingPinNow(nextSession, terminalCommit));
  }

  async persistRunningTurnStart(
    nextSession: Session,
    expectedMessageCount: number,
  ): Promise<Session> {
    return this.enqueueSessionMutation(async () => (await this.persistRunningTurnStartNow(nextSession, expectedMessageCount)).session);
  }

  async persistQueuedTurnStart(
    nextSession: Session,
    expectedMessageCount: number,
    queueId: string,
    turn: SessionTurnInput,
  ): Promise<{ session: Session; turn: SessionTurnRecord }> {
    return this.enqueueSessionMutation(async () => {
      const result = await this.persistRunningTurnStartNow(nextSession, expectedMessageCount, { queueId, turn });
      if (!result.turn) throw new Error("The queued turn start did not return its committed turn.");
      return { session: result.session, turn: result.turn };
    });
  }

  private async persistRunningTurnStartNow(
    nextSession: Session,
    expectedMessageCount: number,
    queuedTurn?: SessionRunningTurnStartInput["queuedTurn"],
  ): Promise<{ session: Session; turn?: SessionTurnRecord }> {
    const currentSession = this.deps.getSession(nextSession.id);
    if (currentSession) {
      assertSessionWritable(currentSession);
    }
    const userMessage = nextSession.messages.at(-1);
    if (
      nextSession.status !== "running"
      || nextSession.runState !== "running"
      || (nextSession.messageCount ?? nextSession.messages.length) !== expectedMessageCount + 1
      || !userMessage
      || userMessage.role !== "user"
    ) {
      throw new Error("The Session is invalid for starting a running turn.");
    }
    if (!this.deps.appendStoredRunningTurnStart) {
      throw new Error("Incremental storage for starting a running turn is unavailable.");
    }

    const storedResult = await this.deps.appendStoredRunningTurnStart({
      sessionId: nextSession.id,
      incarnationId: nextSession.incarnationId,
      expectedMessageCount,
      userMessage,
      updatedAt: nextSession.updatedAt,
      characterRuntimeSnapshot: nextSession.characterRuntimeSnapshot,
      ...(queuedTurn ? { queuedTurn } : {}),
    });
    if (queuedTurn && !storedResult.queuedTurn) throw new Error("The queued turn start did not return its committed turn.");
    const stored = cloneSessions([{
      ...nextSession,
      ...storedResult.summary,
      characterRuntimeSnapshot: storedResult.characterRuntimeSnapshot,
      ...(nextSession.messageCount !== undefined ? { messageCount: expectedMessageCount + 1 } : {}),
    }])[0];
    this.runCommittedProjectionBestEffort("running turn", "cache update", () => {
      this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
    });
    this.runCommittedProjectionBestEffort("running turn", "broadcast", () => {
      this.deps.broadcastSessions([stored.id]);
    });
    return { session: stored, ...(storedResult.queuedTurn ? { turn: storedResult.queuedTurn } : {}) };
  }

  async appendRunningInput(nextSession: Session, text: string, turnId: number, queuedInput?: SessionSteerAppendInput["queuedInput"]): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.appendStoredSessionSteer) throw new Error("Incremental Session input storage is unavailable.");
      const message = { role: "user" as const, text };
      const result = await this.deps.appendStoredSessionSteer({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount: nextSession.messageCount ?? nextSession.messages.length,
        turnId,
        userMessage: message,
        updatedAt: nextSession.updatedAt,
        ...(queuedInput ? { queuedInput } : {}),
      });
      return this.projectRuntimeAppend(nextSession, result, [...nextSession.messages, message]);
    });
  }

  async beginRunningInput(nextSession: Session, text: string, turnId: number, nativeTurnId: string, attachments: ComposerAttachment[], origin?: import("../../src-shared/session/session-turn-queue.js").SessionSteerOrigin): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.beginStoredSessionSteer) throw new Error("Durable Session input storage is unavailable.");
      const message = { role: "user" as const, text, turnInput: { turnId: String(turnId), nativeTurnId, attachments, state: "pending" as const, ...(origin ? { origin } : {}) } };
      const result = await this.deps.beginStoredSessionSteer({ sessionId: nextSession.id, incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount: nextSession.messageCount ?? nextSession.messages.length, turnId, userMessage: message,
        nativeTurnId, attachments, updatedAt: nextSession.updatedAt });
      return this.projectRuntimeAppend(nextSession, result, [...nextSession.messages, message]);
    });
  }

  async settleRunningInput(nextSession: Session, messageSeq: number, turnId: number, state: Exclude<TurnInputDeliveryState, "pending">): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.settleStoredSessionSteer) throw new Error("Durable Session input storage is unavailable.");
      const count = nextSession.messageCount ?? nextSession.messages.length;
      const result = await this.deps.settleStoredSessionSteer({ sessionId: nextSession.id, incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount: count, turnId, messageSeq, state, updatedAt: nextSession.updatedAt });
      return this.projectRuntimeAppend(nextSession, result, nextSession.messages.map((message, index) =>
        (message.historyIndex ?? count - nextSession.messages.length + index) === messageSeq && message.turnInput
          ? { ...message, turnInput: { ...message.turnInput, state } } : message));
    });
  }

  async checkpointRuntimeMetadata(nextSession: Session, expected: Session): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      if (!this.deps.checkpointStoredSessionRunMetadata) throw new Error("Session runtime checkpoint storage is unavailable.");
      const result = await this.deps.checkpointStoredSessionRunMetadata({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expected: { status: expected.status, runState: expected.runState, threadId: expected.threadId },
        next: { status: nextSession.status, runState: nextSession.runState, threadId: nextSession.threadId, updatedAt: nextSession.updatedAt },
      });
      if (!result) throw new Error("The Session runtime checkpoint no longer matches its owner.");
      return this.projectRuntimeAppend(nextSession, result, nextSession.messages);
    });
  }

  async appendTerminalSession(nextSession: Session, terminalCommit: SessionTurnTerminalCommit): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      const message = nextSession.messages.at(-1);
      if (!message || message.role !== "assistant") throw new Error("Terminal Session requires an assistant message.");
      if (!this.deps.appendStoredSessionTerminal) throw new Error("Incremental terminal Session storage is unavailable.");
      const result = await this.deps.appendStoredSessionTerminal({
        sessionId: nextSession.id,
        incarnationId: getSessionIncarnationId(nextSession),
        expectedMessageCount: (nextSession.messageCount ?? nextSession.messages.length) - 1,
        assistantMessage: message,
        metadata: { status: nextSession.status, runState: nextSession.runState, threadId: nextSession.threadId, updatedAt: nextSession.updatedAt },
        terminalCommit,
      });
      return this.projectRuntimeAppend(nextSession, result, nextSession.messages);
    });
  }

  private projectRuntimeAppend(nextSession: Session, result: SessionMetadataResult, messages: Session["messages"]): Session {
    const projected: Session = {
      ...nextSession,
      ...result.summary,
      characterRuntimeSnapshot: result.characterRuntimeSnapshot,
      messageCount: result.messageCount,
      messages,
    };
    const stored = this.deps.overlayCurrentExecutionOptions?.(projected) ?? projected;
    this.runCommittedProjectionBestEffort("runtime Session", "dependency sync", () => this.syncStoredSession(stored));
    this.runCommittedProjectionBestEffort("runtime Session", "cache update", () => {
      this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
    });
    this.runCommittedProjectionBestEffort("runtime Session", "broadcast", () => this.deps.broadcastSessions([stored.id]));
    return stored;
  }

  async clearCharacterAuthoringRuntimeState(nextSession: Session): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      const currentSession = this.deps.getSession(nextSession.id);
      if (currentSession) {
        assertSessionWritable(currentSession);
      }
      if (nextSession.sessionKind !== "character-authoring") {
        throw new Error("The Character authoring runtime clear owner does not match the Session.");
      }
      if (!this.deps.clearStoredCharacterAuthoringRuntimeState) {
        throw new Error("Storage for clearing Character authoring runtime state is unavailable.");
      }

      const storedResult = await this.deps.clearStoredCharacterAuthoringRuntimeState({
        sessionId: nextSession.id,
        incarnationId: nextSession.incarnationId,
      });
      const stored = cloneSessions([{
        ...nextSession,
        ...storedResult.summary,
        characterRuntimeSnapshot: storedResult.characterRuntimeSnapshot,
      }])[0];
      this.runCommittedProjectionBestEffort("Character authoring runtime clear", "cache update", () => {
        this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
      });
      this.runCommittedProjectionBestEffort("Character authoring runtime clear", "broadcast", () => {
        this.deps.broadcastSessions([stored.id]);
      });
      return stored;
    });
  }

  async upsertSessionPreservingPin(nextSession: Session): Promise<Session> {
    return this.enqueueSessionMutation(() => this.upsertSessionPreservingPinNow(nextSession));
  }

  private upsertSessionPreservingPinNow(
    nextSession: Session,
    terminalCommit?: SessionTurnTerminalCommit,
  ): Promise<Session> {
    const currentSession = this.deps.getSession(nextSession.id);
    return this.upsertSessionNow({
      ...nextSession,
      isPinned: currentSession?.isPinned ?? nextSession.isPinned,
      taskTitle: currentSession?.taskTitle ?? nextSession.taskTitle,
      allowedAdditionalDirectories: currentSession?.allowedAdditionalDirectories ?? nextSession.allowedAdditionalDirectories,
    }, "upsert", terminalCommit);
  }

  private async upsertSessionNow(
    nextSession: Session,
    operation: "create" | "upsert",
    terminalCommit?: SessionTurnTerminalCommit,
    deferPublication = false,
  ): Promise<Session> {
    const startedAt = Date.now();
    const currentSession = this.deps.getSession(nextSession.id);
    if (currentSession) {
      assertSessionWritable(currentSession);
    }

    const sessionToStore = await this.mergeStoredMessagesForSummaryOnlySession(
      operation === "create" ? nextSession : this.deps.overlayCurrentExecutionOptions?.(nextSession) ?? nextSession,
    );
    const storeStartedAt = Date.now();
    const normalizedSession = {
      ...sessionToStore,
      codexReviewer: resolveCodexReviewerUpdate(currentSession, sessionToStore.codexReviewer),
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        sessionToStore.workspacePath,
        sessionToStore.allowedAdditionalDirectories,
      ),
    };
    const stored = terminalCommit
      ? await this.deps.upsertStoredTerminalSession?.(normalizedSession, terminalCommit)
      : await this.deps.upsertStoredSession(normalizedSession, operation);
    if (!stored) {
      throw new Error("Atomic commit storage for the terminal Session is unavailable.");
    }
    if (deferPublication) return cloneSessions([stored])[0];
    const storeDurationMs = Date.now() - storeStartedAt;
    const cacheStartedAt = Date.now();
    if (terminalCommit) {
      this.runCommittedProjectionBestEffort("terminal Session", "dependency sync", () => this.syncStoredSession(stored));
      this.runCommittedProjectionBestEffort("terminal Session", "cache update", () => {
        this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
      });
    } else {
      this.syncStoredSession(stored);
      this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
    }
    const cacheDurationMs = Date.now() - cacheStartedAt;
    const broadcastStartedAt = Date.now();
    if (terminalCommit) {
      this.runCommittedProjectionBestEffort("terminal Session", "broadcast", () => this.deps.broadcastSessions([stored.id]));
    } else {
      this.deps.broadcastSessions([stored.id]);
    }
    logSessionRunStuckInvestigation("persistence.upsert-session.done", {
      sessionId: stored.id,
      durationMs: Date.now() - startedAt,
      storeDurationMs,
      cacheDurationMs,
      broadcastDurationMs: Date.now() - broadcastStartedAt,
      messageCount: stored.messages.length,
      runState: stored.runState,
      status: stored.status,
      cachedRunState: this.deps.getSession(stored.id)?.runState ?? null,
      cachedStatus: this.deps.getSession(stored.id)?.status ?? null,
    });
    return cloneSessions([stored])[0];
  }

  async replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Promise<Session[]> {
    return this.enqueueSessionMutation(
      () => this.replaceAllSessionsNow(nextSessions, options),
    );
  }

  private async replaceAllSessionsNow(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Promise<Session[]> {
    const previousSessions = cloneSessions(this.deps.getSessions());
    const normalizedSessions = nextSessions.map((session) => ({
      ...session,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        session.workspacePath,
        session.allowedAdditionalDirectories,
      ),
    }));

    await this.deps.replaceStoredSessions(normalizedSessions);
    const storedSessions = await this.deps.listStoredSessions();
    this.deps.setSessions(toCachedSessions(storedSessions));
    for (const session of storedSessions) {
      this.syncStoredSession(session);
    }

    const previousSessionsById = new Map(previousSessions.map((session) => [session.id, session] as const));
    const nextSessionsById = new Map(storedSessions.map((session) => [session.id, session] as const));
    for (const previousSession of previousSessions) {
      const nextSession = nextSessionsById.get(previousSession.id);
      if (!nextSession || nextSession.provider !== previousSession.provider) {
        this.deps.clearSessionContextTelemetry(previousSession.id);
        this.deps.revokeSessionAgentRuntimeBindings?.(previousSession.id);
        await this.deps.invalidateProviderSessionThread(previousSession.provider, previousSession.id);
      }
      if (!nextSession) {
        this.deps.clearSessionBackgroundActivities(previousSession.id);
      }
    }

    for (const sessionId of options?.invalidateSessionIds ?? []) {
      this.deps.revokeSessionAgentRuntimeBindings?.(sessionId);
      const sessionProvider =
        nextSessionsById.get(sessionId)?.provider ??
        previousSessionsById.get(sessionId)?.provider ??
        null;
      await this.deps.invalidateProviderSessionThread(sessionProvider, sessionId);
    }

    if (options?.broadcast ?? true) {
      this.deps.broadcastSessions(new Set([
        ...previousSessions.map((session) => session.id),
        ...storedSessions.map((session) => session.id),
      ]));
    }

    return cloneSessions(storedSessions);
  }

  private async mergeStoredMessagesForSummaryOnlySession(nextSession: Session): Promise<Session> {
    if (nextSession.messages.length > 0) {
      return nextSession;
    }

    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      return nextSession;
    }

    const sourceSession =
      currentSession.messages.length > 0
        ? currentSession
        : await this.deps.getStoredSession?.(nextSession.id) ?? null;

    if (!sourceSession || sourceSession.messages.length === 0) {
      return nextSession;
    }

    return {
      ...nextSession,
      messages: sourceSession.messages,
      stream: sourceSession.stream,
    };
  }

  private resolveEnabledProviderCatalog(
    snapshot: ModelCatalogSnapshot,
    appSettings: AppSettings,
    requestedProviderId?: string | null,
    requireRequestedProvider = false,
  ): ModelCatalogProvider {
    const providerId = requestedProviderId?.trim() || (requireRequestedProvider ? "" : DEFAULT_PROVIDER_ID);
    if (!providerId) throw new Error("Select a provider for Character authoring.");
    const provider = getProviderCatalog(snapshot.providers, providerId);
    if (!provider) throw new Error(`Provider ${providerId} model discovery is unavailable.`);
    if (!getProviderAppSettings(appSettings, providerId).enabled) {
      throw new Error(`Provider ${providerId} is disabled in Settings.`);
    }
    return provider;
  }

  private syncStoredSession(stored: Session): void {
    this.deps.syncSessionDependencies(stored);
  }

  private runCommittedProjectionBestEffort(owner: string, label: string, operation: () => void): void {
    try {
      operation();
    } catch (error) {
      console.warn(`Committed ${owner} ${label} failed`, error);
    }
  }
}
