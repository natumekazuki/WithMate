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

export type SessionPersistenceServiceDeps = {
  getSessions(): Session[];
  setSessions(nextSessions: Session[]): void;
  getSession(sessionId: string): Session | null;
  isSessionRunInFlight(sessionId: string): boolean;
  upsertStoredSession(session: Session): Session;
  replaceStoredSessions(sessions: Session[]): void;
  listStoredSessions(): Session[];
  deleteStoredSession(sessionId: string): void;
  getAppSettings: () => AppSettings;
  getModelCatalogSnapshot(): ModelCatalogSnapshot;
  syncSessionDependencies(session: Session): void;
  clearSessionContextTelemetry(sessionId: string): void;
  clearSessionBackgroundActivities(sessionId: string): void;
  clearCharacterReflectionCheckpoint(sessionId: string): void;
  clearInFlightCharacterReflection(sessionId: string): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void;
  closeSessionWindow(sessionId: string): void;
  broadcastSessions(): void;
};

function isRunningSession(session: Session): boolean {
  return session.status === "running" || session.runState === "running";
}

export class SessionPersistenceService {
  constructor(private readonly deps: SessionPersistenceServiceDeps) {}

  createSession(input: CreateSessionInput): Session {
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

  updateSession(nextSession: Session): Session {
    const currentSession = this.deps.getSession(nextSession.id);
    if (!currentSession) {
      throw new Error("対象セッションが見つからないよ。");
    }

    if (this.deps.isSessionRunInFlight(nextSession.id) || isRunningSession(currentSession)) {
      throw new Error("実行中のセッションは更新できないよ。");
    }

    const updatedSession = this.upsertSession({
      ...nextSession,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        nextSession.workspacePath,
        nextSession.allowedAdditionalDirectories,
      ),
    });

    if (currentSession.provider !== updatedSession.provider) {
      this.deps.clearSessionContextTelemetry(updatedSession.id);
    }

    return updatedSession;
  }

  deleteSession(sessionId: string): void {
    const session = this.deps.getSession(sessionId);
    if (!session) {
      return;
    }

    if (this.deps.isSessionRunInFlight(sessionId) || isRunningSession(session)) {
      throw new Error("実行中のセッションは削除できないよ。");
    }

    this.deps.deleteStoredSession(sessionId);
    this.deps.setSessions(this.deps.listStoredSessions());
    this.deps.clearSessionContextTelemetry(sessionId);
    this.deps.clearSessionBackgroundActivities(sessionId);
    this.deps.clearCharacterReflectionCheckpoint(sessionId);
    this.deps.clearInFlightCharacterReflection(sessionId);
    this.deps.closeSessionWindow(sessionId);
    this.deps.broadcastSessions();
  }

  upsertSession(nextSession: Session): Session {
    const stored = this.deps.upsertStoredSession({
      ...nextSession,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        nextSession.workspacePath,
        nextSession.allowedAdditionalDirectories,
      ),
    });
    this.syncStoredSession(stored);
    this.deps.setSessions(this.deps.listStoredSessions());
    this.deps.broadcastSessions();
    return cloneSessions([stored])[0];
  }

  replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Session[] {
    const previousSessions = cloneSessions(this.deps.getSessions());
    const normalizedSessions = nextSessions.map((session) => ({
      ...session,
      allowedAdditionalDirectories: normalizeAllowedAdditionalDirectories(
        session.workspacePath,
        session.allowedAdditionalDirectories,
      ),
    }));

    this.deps.replaceStoredSessions(normalizedSessions);
    this.deps.setSessions(this.deps.listStoredSessions());
    const storedSessions = this.deps.getSessions();
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
      this.deps.broadcastSessions();
    }

    return cloneSessions(storedSessions);
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
