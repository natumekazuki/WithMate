import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import {
  buildNewSession,
  cloneSessions,
  isReadOnlySession,
  projectSessionSummary,
  type CreateSessionInput,
  type Session,
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
import type {
  DeleteSessionsLastActiveBeforeCutoff,
  DeleteSessionsResult,
} from "../src/withmate-window-types.js";

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
  upsertStoredSession(session: Session): Awaitable<Session>;
  replaceStoredSessions(sessions: Session[]): Awaitable<void>;
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
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void;
  closeSessionWindow(sessionId: string): void;
  broadcastSessions(sessionIds?: Iterable<string>): void;
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
  constructor(private readonly deps: SessionPersistenceServiceDeps) {}

  async createSession(input: CreateSessionInput): Promise<Session> {
    const appSettings = this.deps.getAppSettings();
    const snapshot = this.deps.getModelCatalogSnapshot();
    const provider = this.resolveEnabledProviderCatalog(snapshot, appSettings, input.provider);
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
    return this.upsertSession(created);
  }

  async updateSession(nextSession: Session): Promise<Session> {
    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      throw new Error("対象セッションが見つからないよ。");
    }

    assertSessionWritable(currentSession);

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

    if (currentSession.provider !== updatedSession.provider) {
      this.deps.clearSessionContextTelemetry(updatedSession.id);
    }

    if (currentSession.threadId && !updatedSession.threadId) {
      this.deps.invalidateProviderSessionThread(currentSession.provider, updatedSession.id);
    }

    return updatedSession;
  }

  async deleteSession(sessionId: string): Promise<DeleteSessionsResult> {
    return this.deleteSessionsByIds([sessionId], { runningPolicy: "throw" });
  }

  async deleteSessionsLastActiveBefore(cutoff: DeleteSessionsLastActiveBeforeCutoff): Promise<DeleteSessionsResult> {
    const sessionIds = this.deps.listStoredSessionIdsLastActiveBefore
      ? await this.deps.listStoredSessionIdsLastActiveBefore(cutoff)
      : (await this.deps.listStoredSessions())
          .filter((session) => Date.parse(session.updatedAt) < cutoff.cutoffTimestampMs)
          .map((session) => session.id);
    return this.deleteSessionsByIds(sessionIds, { runningPolicy: "skip", cutoff });
  }

  private async deleteSessionsByIds(
    sessionIds: readonly string[],
    options: {
      runningPolicy: "throw" | "skip";
      cutoff?: DeleteSessionsLastActiveBeforeCutoff;
    },
  ): Promise<DeleteSessionsResult> {
    const uniqueSessionIds = Array.from(new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)));
    const skippedRunningSessionIds: string[] = [];
    const deletableSessionIds: string[] = [];
    const currentSessionsById = new Map(this.deps.getSessions().map((session) => [session.id, session] as const));

    for (const sessionId of uniqueSessionIds) {
      const session = currentSessionsById.get(sessionId);
      if (!session) {
        continue;
      }

      if (this.deps.isSessionRunInFlight(sessionId) || isRunningSession(session)) {
        if (options.runningPolicy === "throw") {
          throw new Error("実行中のセッションは削除できないよ。");
        }
        skippedRunningSessionIds.push(sessionId);
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
      this.deps.clearSessionContextTelemetry(sessionId);
      this.deps.clearSessionBackgroundActivities(sessionId);
      this.deps.closeSessionWindow(sessionId);
    }

    this.deps.broadcastSessions(deletableSessionIds);

    return {
      cutoffDate: options.cutoff?.cutoffDate,
      cutoffTimestampMs: options.cutoff?.cutoffTimestampMs,
      deletedSessionIds: deletableSessionIds,
      skippedRunningSessionIds,
    };
  }

  async upsertSession(nextSession: Session): Promise<Session> {
    const startedAt = Date.now();
    const currentSession = this.deps.getSession(nextSession.id);
    if (currentSession) {
      assertSessionWritable(currentSession);
    }

    const sessionToStore = await this.mergeStoredMessagesForSummaryOnlySession(nextSession);
    const storeStartedAt = Date.now();
    const stored = await this.deps.upsertStoredSession({
      ...sessionToStore,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        sessionToStore.workspacePath,
        sessionToStore.allowedAdditionalDirectories,
      ),
    });
    const storeDurationMs = Date.now() - storeStartedAt;
    const cacheStartedAt = Date.now();
    this.syncStoredSession(stored);
    this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), toCachedSession(stored)));
    const cacheDurationMs = Date.now() - cacheStartedAt;
    const broadcastStartedAt = Date.now();
    this.deps.broadcastSessions([stored.id]);
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
    const previousSessions = cloneSessions(this.deps.getSessions());
    const normalizedSessions = nextSessions.map((session) => ({
      ...session,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        session.workspacePath,
        session.allowedAdditionalDirectories,
      ),
    }));

    await this.deps.replaceStoredSessions(normalizedSessions);
    this.deps.setSessions(toCachedSessions(normalizedSessions));
    const storedSessions = normalizedSessions;
    for (const session of storedSessions) {
      this.syncStoredSession(session);
    }

    const previousSessionsById = new Map(previousSessions.map((session) => [session.id, session] as const));
    const nextSessionsById = new Map(storedSessions.map((session) => [session.id, session] as const));
    for (const previousSession of previousSessions) {
      const nextSession = nextSessionsById.get(previousSession.id);
      if (!nextSession || nextSession.provider !== previousSession.provider) {
        this.deps.clearSessionContextTelemetry(previousSession.id);
      }
      if (!nextSession) {
        this.deps.clearSessionBackgroundActivities(previousSession.id);
      }
    }

    for (const sessionId of options?.invalidateSessionIds ?? []) {
      const sessionProvider =
        nextSessionsById.get(sessionId)?.provider ??
        previousSessionsById.get(sessionId)?.provider ??
        null;
      this.deps.invalidateProviderSessionThread(sessionProvider, sessionId);
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
  ): ModelCatalogProvider {
    const requestedProvider = requestedProviderId ? getProviderCatalog(snapshot.providers, requestedProviderId) : null;
    if (requestedProvider && getProviderAppSettings(appSettings, requestedProvider.id).enabled) {
      return requestedProvider;
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
}
