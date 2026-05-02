import { getProviderAppSettings, type AppSettings } from "../src/provider-settings-state.js";
import {
  buildNewSession,
  cloneSessions,
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

export type SessionPersistenceServiceDeps = {
  getSessions(): Session[];
  setSessions(nextSessions: Session[]): void;
  getSession(sessionId: string): Session | null;
  getStoredSession?(sessionId: string): Awaitable<Session | null>;
  isSessionRunInFlight(sessionId: string): boolean;
  upsertStoredSession(session: Session): Awaitable<Session>;
  replaceStoredSessions(sessions: Session[]): Awaitable<void>;
  listStoredSessions(): Awaitable<Session[]>;
  deleteStoredSession(sessionId: string): Awaitable<void>;
  getAppSettings: () => AppSettings;
  getModelCatalogSnapshot(): ModelCatalogSnapshot;
  syncSessionDependencies(session: Session): void;
  clearSessionContextTelemetry(sessionId: string): void;
  clearSessionBackgroundActivities(sessionId: string): void;
  clearCharacterReflectionCheckpoint(sessionId: string): void;
  clearInFlightCharacterReflection(sessionId: string): void;
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

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.deps.getSession(sessionId);
    if (!session) {
      return;
    }

    if (this.deps.isSessionRunInFlight(sessionId) || isRunningSession(session)) {
      throw new Error("実行中のセッションは削除できないよ。");
    }

    await this.deps.deleteStoredSession(sessionId);
    this.deps.setSessions(this.deps.getSessions().filter((entry) => entry.id !== sessionId));
    this.deps.clearSessionContextTelemetry(sessionId);
    this.deps.clearSessionBackgroundActivities(sessionId);
    this.deps.clearCharacterReflectionCheckpoint(sessionId);
    this.deps.clearInFlightCharacterReflection(sessionId);
    this.deps.closeSessionWindow(sessionId);
    this.deps.broadcastSessions([sessionId]);
  }

  async upsertSession(nextSession: Session): Promise<Session> {
    const sessionToStore = await this.mergeStoredMessagesForSummaryOnlySession(nextSession);
    const stored = await this.deps.upsertStoredSession({
      ...sessionToStore,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        sessionToStore.workspacePath,
        sessionToStore.allowedAdditionalDirectories,
      ),
    });
    this.syncStoredSession(stored);
    this.deps.setSessions(upsertSessionInList(this.deps.getSessions(), stored));
    this.deps.broadcastSessions([stored.id]);
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
    this.deps.setSessions(normalizedSessions);
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
        this.deps.clearCharacterReflectionCheckpoint(previousSession.id);
        this.deps.clearInFlightCharacterReflection(previousSession.id);
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
