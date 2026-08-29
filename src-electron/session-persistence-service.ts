import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import {
  buildNewSession,
  cloneSessions,
  isReadOnlySession,
  projectSessionSummary,
  type CreateSessionInput,
  type Session,
  type SessionSummary,
} from "../src/session-state.js";
import {
  DEFAULT_PROVIDER_ID,
  getProviderCatalog,
  resolveModelSelection,
  type ModelCatalogProvider,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import { normalizeAllowedAdditionalDirectories } from "./additional-directories.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import { sessionSummaryToSession } from "./session-summary-adapter.js";
import type { CharacterRuntimeSnapshot } from "../src/character/character-catalog.js";
import { hasSameCharacterRuntimeIdentity } from "../src/character/character-runtime-snapshot.js";
import type {
  DeleteSessionsLastActiveBeforeCutoff,
  DeleteSessionsResult,
} from "../src/withmate-window-types.js";
import { SessionIdCollisionError } from "./session-storage-errors.js";
import type { RunCharacterAffectTurnOwnershipExclusive } from "./character-affect-turn-ownership-coordinator.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "./session-running-turn-start.js";

const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

export type SessionPersistenceServiceDeps = {
  getSessions(): Session[];
  setSessions(nextSessions: Session[]): void;
  getSession(sessionId: string): Session | null;
  getStoredSession?(sessionId: string): Awaitable<Session | null>;
  isSessionRunInFlight(sessionId: string): boolean;
  listRunningActiveAuxiliaryParentIds?(sessionIds: readonly string[]): Awaitable<ReadonlySet<string>>;
  listAuxiliarySessionRuntimeIdentities?(
    parentSessionIds: readonly string[],
  ): Awaitable<readonly { id: string; parentSessionId: string; provider: string }[]>;
  upsertStoredSession(session: Session, operation: "create" | "upsert"): Awaitable<Session>;
  upsertStoredTerminalSession?(session: Session, terminalCommit: SessionTurnTerminalCommit): Awaitable<Session>;
  appendStoredRunningTurnStart?(input: SessionRunningTurnStartInput): Awaitable<SessionRunningTurnStartResult>;
  clearStoredCharacterAuthoringRuntimeState?(
    input: SessionCharacterAuthoringRuntimeClearInput,
  ): Awaitable<SessionCharacterAuthoringRuntimeClearResult>;
  replaceStoredSessions(sessions: Session[]): Awaitable<void>;
  setStoredSessionPinned?(sessionId: string, isPinned: boolean): Awaitable<SessionSummary>;
  listStoredSessions(): Awaitable<Session[]>;
  listStoredSessionIdsLastActiveBefore?(cutoff: DeleteSessionsLastActiveBeforeCutoff): Awaitable<string[]>;
  deleteStoredSession?(sessionId: string): Awaitable<void>;
  deleteStoredSessions?(sessionIds: readonly string[]): Awaitable<void>;
  getAppSettings: () => AppSettings;
  getModelCatalogSnapshot(): ModelCatalogSnapshot;
  createCharacterRuntimeSnapshot?(characterId: string): CharacterRuntimeSnapshot | null;
  syncSessionDependencies(session: Session): void;
  clearSessionContextTelemetry(sessionId: string): void;
  clearSessionBackgroundActivities(sessionId: string): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  revokeSessionAgentRuntimeBindings?(sessionId: string): void;
  closeSessionWindow(sessionId: string): void;
  broadcastSessions(sessionIds?: Iterable<string>): void;
  runCharacterAffectTurnOwnershipExclusive?: RunCharacterAffectTurnOwnershipExclusive;
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
    throw new Error("閲覧専用セッションは更新できないよ。新しいセッションを作成してください。");
  }
}

export class SessionPersistenceService {
  private sessionMutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionPersistenceServiceDeps) {}

  private enqueueSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sessionMutationQueue.then(operation);
    this.sessionMutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  resolveCharacterAuthoringProvider(providerId: string): string {
    return this.resolveEnabledProviderCatalog(
      this.deps.getModelCatalogSnapshot(),
      this.deps.getAppSettings(),
      providerId,
      true,
    ).id;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
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

    const appSettings = this.deps.getAppSettings();
    const snapshot = this.deps.getModelCatalogSnapshot();
    const provider = this.resolveEnabledProviderCatalog(
      snapshot,
      appSettings,
      input.provider,
      input.sessionKind === "character-authoring",
    );
    const requestedModel = input.provider && input.provider !== provider.id
      ? provider.defaultModelId
      : input.model ?? provider.defaultModelId;
    const requestedReasoningEffort = input.provider && input.provider !== provider.id
      ? provider.defaultReasoningEffort
      : input.reasoningEffort ?? provider.defaultReasoningEffort;
    const selection = resolveModelSelection(
      provider,
      requestedModel,
      requestedReasoningEffort,
    );
    const created = buildNewSession({
      ...input,
      provider: provider.id,
      catalogRevision: snapshot.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      characterRuntimeSnapshot:
        input.characterRuntimeSnapshot ?? this.deps.createCharacterRuntimeSnapshot?.(input.characterId) ?? null,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        input.workspacePath,
        input.allowedAdditionalDirectories ?? [],
      ),
    });
    return this.upsertSession(created, "create");
  }

  async updateSession(nextSession: Session): Promise<Session> {
    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      throw new Error("対象セッションが見つからないよ。");
    }

    assertSessionWritable(currentSession);

    const storedCurrentSession = await this.deps.getStoredSession?.(nextSession.id) ?? currentSession;
    if (!hasSameCharacterRuntimeIdentity(storedCurrentSession, nextSession)) {
      throw new Error("Session の Character owner / runtime snapshot は更新できないよ。");
    }

    if (this.deps.isSessionRunInFlight(nextSession.id) || isRunningSession(currentSession)) {
      throw new Error("実行中のセッションは更新できないよ。");
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

  async setSessionPinned(sessionId: string, isPinned: boolean): Promise<SessionSummary> {
    return this.enqueueSessionMutation(() => this.setSessionPinnedNow(sessionId, isPinned));
  }

  private async setSessionPinnedNow(sessionId: string, isPinned: boolean): Promise<SessionSummary> {
    if (!this.deps.setStoredSessionPinned) {
      throw new Error("このセッション保存形式ではピン止めを利用できないよ。");
    }
    const stored = await this.deps.setStoredSessionPinned(sessionId, isPinned);
    this.deps.setSessions(this.deps.getSessions().map((session) => (
      session.id === stored.id ? { ...session, isPinned: stored.isPinned } : session
    )));
    this.deps.broadcastSessions([stored.id]);
    return projectSessionSummary(stored);
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionsResult> {
    return this.runCharacterAffectTurnOwnershipExclusive(
      () => this.deleteSessionsByIds([sessionId], { runningPolicy: "throw", allowUncachedDeletion: false }),
    );
  }

  async deleteSessionsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): Promise<DeleteSessionsResult> {
    return this.runCharacterAffectTurnOwnershipExclusive(async () => {
      const sessionIds = this.deps.listStoredSessionIdsLastActiveBefore
        ? await this.deps.listStoredSessionIdsLastActiveBefore(cutoff)
        : (await this.deps.listStoredSessions())
            .filter((session) => Date.parse(session.updatedAt) < cutoff.cutoffTimestampMs)
            .map((session) => session.id);
      return this.deleteSessionsByIds(sessionIds, { runningPolicy: "skip", cutoff, allowUncachedDeletion: true });
    });
  }

  private runCharacterAffectTurnOwnershipExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.deps.runCharacterAffectTurnOwnershipExclusive?.(operation) ?? operation();
  }

  private async deleteSessionsByIds(
    sessionIds: readonly string[],
    options: {
      runningPolicy: "throw" | "skip";
      cutoff?: DeleteSessionsLastActiveBeforeCutoff;
      allowUncachedDeletion: boolean;
    },
  ): Promise<DeleteSessionsResult> {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    const skippedRunningSessionIds: string[] = [];
    const deletableSessionIds: string[] = [];
    const currentSessionsById = new Map(this.deps.getSessions().map((session) => [session.id, session] as const));
    const runningActiveAuxiliaryParentIds =
      await this.deps.listRunningActiveAuxiliaryParentIds?.(uniqueSessionIds) ?? new Set<string>();
    const auxiliaryRuntimeIdentities =
      await this.deps.listAuxiliarySessionRuntimeIdentities?.(uniqueSessionIds) ?? [];

    for (const sessionId of uniqueSessionIds) {
      const session = currentSessionsById.get(sessionId);
      if (
        this.deps.isSessionRunInFlight(sessionId) ||
        runningActiveAuxiliaryParentIds.has(sessionId) ||
        (session ? isRunningSession(session) : false)
      ) {
        if (options.runningPolicy === "throw") {
          throw new Error("実行中のセッションは削除できないよ。");
        }
        skippedRunningSessionIds.push(sessionId);
        continue;
      }

      if (!session && !options.allowUncachedDeletion) {
        continue;
      }

      deletableSessionIds.push(sessionId);
    }

    if (deletableSessionIds.length === 0) {
      return {
        cutoffDate: options.cutoff?.cutoffDate,
        cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
        deletedSessionIds: [],
        skippedRunningSessionIds,
      };
    }

    if (this.deps.deleteStoredSessions) {
      await this.deps.deleteStoredSessions(deletableSessionIds);
    } else if (this.deps.deleteStoredSession) {
      for (const sessionId of deletableSessionIds) {
        await this.deps.deleteStoredSession(sessionId);
      }
    } else {
      throw new Error("session delete storage dependency is not configured.");
    }
    const deletableSessionIdSet = new Set(deletableSessionIds);
    this.deps.setSessions(this.deps.getSessions().filter((entry) => !deletableSessionIdSet.has(entry.id)));

    for (const sessionId of deletableSessionIds) {
      const deletedSession = currentSessionsById.get(sessionId);
      this.deps.revokeSessionAgentRuntimeBindings?.(sessionId);
      await this.deps.invalidateProviderSessionThread(deletedSession?.provider ?? null, sessionId);
      this.deps.clearSessionContextTelemetry(sessionId);
      this.deps.clearSessionBackgroundActivities(sessionId);
      this.deps.closeSessionWindow(sessionId);
    }
    const deletableParentIds = new Set(deletableSessionIds);
    for (const auxiliary of auxiliaryRuntimeIdentities) {
      if (!deletableParentIds.has(auxiliary.parentSessionId)) {
        continue;
      }
      this.deps.revokeSessionAgentRuntimeBindings?.(auxiliary.id);
      await this.deps.invalidateProviderSessionThread(auxiliary.provider, auxiliary.id);
      this.deps.clearSessionContextTelemetry(auxiliary.id);
      this.deps.clearSessionBackgroundActivities(auxiliary.id);
      this.deps.closeSessionWindow(auxiliary.id);
    }

    this.deps.broadcastSessions(deletableSessionIds);

    return {
      cutoffDate: options.cutoff?.cutoffDate,
      cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
      deletedSessionIds: deletableSessionIds,
      skippedRunningSessionIds,
    };
  }

  async upsertSession(
    nextSession: Session,
    operation: "create" | "upsert" = "upsert",
  ): Promise<Session> {
    return this.enqueueSessionMutation(() => this.upsertSessionNow(nextSession, operation));
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
    return this.enqueueSessionMutation(async () => {
      const currentSession = this.deps.getSession(nextSession.id);
      if (currentSession) {
        assertSessionWritable(currentSession);
      }
      const userMessage = nextSession.messages[expectedMessageCount];
      if (
        nextSession.status !== "running"
        || nextSession.runState !== "running"
        || nextSession.messages.length !== expectedMessageCount + 1
        || !userMessage
        || userMessage.role !== "user"
      ) {
        throw new Error("running turn 開始のSession形式が不正だよ。");
      }
      if (!this.deps.appendStoredRunningTurnStart) {
        throw new Error("running turn 開始のincremental storageが利用できないよ。");
      }

      const storedResult = await this.deps.appendStoredRunningTurnStart({
        sessionId: nextSession.id,
        expectedMessageCount,
        userMessage,
        updatedAt: nextSession.updatedAt,
        characterRuntimeSnapshot: nextSession.sessionKind === "character-authoring"
          ? nextSession.characterRuntimeSnapshot
          : undefined,
      });
      const stored = cloneSessions([{
        ...nextSession,
        ...storedResult.summary,
        characterRuntimeSnapshot: storedResult.characterRuntimeSnapshot,
      }])[0];
      this.runCommittedProjectionBestEffort("running turn", "cache update", () => {
        this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
      });
      this.runCommittedProjectionBestEffort("running turn", "broadcast", () => {
        this.deps.broadcastSessions([stored.id]);
      });
      return stored;
    });
  }

  async clearCharacterAuthoringRuntimeState(nextSession: Session): Promise<Session> {
    return this.enqueueSessionMutation(async () => {
      const currentSession = this.deps.getSession(nextSession.id);
      if (currentSession) {
        assertSessionWritable(currentSession);
      }
      if (nextSession.sessionKind !== "character-authoring") {
        throw new Error("Character authoring runtime clearのownerが一致しないよ。");
      }
      if (!this.deps.clearStoredCharacterAuthoringRuntimeState) {
        throw new Error("Character authoring runtime clearのstorageが利用できないよ。");
      }

      const storedResult = await this.deps.clearStoredCharacterAuthoringRuntimeState({
        sessionId: nextSession.id,
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
    }, "upsert", terminalCommit);
  }

  private async upsertSessionNow(
    nextSession: Session,
    operation: "create" | "upsert",
    terminalCommit?: SessionTurnTerminalCommit,
  ): Promise<Session> {
    const startedAt = Date.now();
    const currentSession = this.deps.getSession(nextSession.id);
    if (currentSession) {
      assertSessionWritable(currentSession);
    }

    const sessionToStore = await this.mergeStoredMessagesForSummaryOnlySession(nextSession);
    const storeStartedAt = Date.now();
    const normalizedSession = {
      ...sessionToStore,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        sessionToStore.workspacePath,
        sessionToStore.allowedAdditionalDirectories,
      ),
    };
    const stored = terminalCommit
      ? await this.deps.upsertStoredTerminalSession?.(normalizedSession, terminalCommit)
      : await this.deps.upsertStoredSession(normalizedSession, operation);
    if (!stored) {
      throw new Error("terminal Session の atomic commit storage が利用できないよ。");
    }
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
      () => this.runCharacterAffectTurnOwnershipExclusive(() => this.replaceAllSessionsNow(nextSessions, options)),
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
    appSettings = this.deps.getAppSettings(),
    requestedProviderId?: string | null,
    requireRequestedProvider = false,
  ): ModelCatalogProvider {
    const normalizedRequestedProviderId = requestedProviderId?.trim() ?? "";
    const requestedProvider = requireRequestedProvider
      ? snapshot.providers.find((provider) => provider.id === normalizedRequestedProviderId) ?? null
      : requestedProviderId
        ? getProviderCatalog(snapshot.providers, requestedProviderId)
        : null;
    if (requestedProvider && getProviderAppSettings(appSettings, requestedProvider.id).enabled) {
      return requestedProvider;
    }
    if (requireRequestedProvider) {
      if (!normalizedRequestedProviderId) {
        throw new Error("Character authoring の provider を選択してください。");
      }
      if (!requestedProvider) {
        throw new Error("選択した Character authoring provider が model catalog に見つからないよ。");
      }
      throw new Error("選択した Character authoring provider は Settings で無効になっているよ。");
    }

    const defaultProvider = snapshot.providers.find((provider) => provider.id === DEFAULT_PROVIDER_ID) ?? null;
    if (defaultProvider && getProviderAppSettings(appSettings, defaultProvider.id).enabled) {
      return defaultProvider;
    }

    const firstEnabledProvider = snapshot.providers.find((provider) =>
      getProviderAppSettings(appSettings, provider.id).enabled
    );
    if (firstEnabledProvider) {
      return firstEnabledProvider;
    }

    throw new Error("有効な provider が Settings に見つからないよ。");
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
