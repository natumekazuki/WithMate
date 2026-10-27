import { currentTimestampLabel } from "../../src-shared/time-state.js";
import {
  getProviderAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
} from "../../src-shared/window/withmate-window-types.js";
import type {
  ResetAppDatabaseRequest,
  ResetAppDatabaseResult,
  ResetAppDatabaseTarget,
} from "../../src-shared/window/withmate-window-types.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";
import type { RunProviderRuntimeOperationExclusive } from "../providers/provider-runtime-operation-coordinator.js";
import type { SessionThreadPatchInput } from "../session/session-storage-v6.js";
import type { AuxiliarySessionThreadPatchInput } from "../auxiliary/auxiliary-session-storage.js";
import { isChatLayoutPreferenceUpdate, type ChatLayoutPreference, type ChatLayoutPreferenceUpdate } from "../../src-shared/settings/chat-layout-preference.js";

export type SessionCredentialThreadInfo = {
  id: string;
  incarnationId: string;
  provider: string;
  threadId: string;
  status: string;
  runState: string;
};

export type AuxiliaryCredentialThreadInfo = {
  id: string;
  parentSessionId: string;
  createdAt: string;
  provider: string;
  threadId: string;
  runState: string;
};

export type SettingsCatalogServiceDeps = {
  /** Captures the storage owner/generation used by a deferred operation. */
  captureStorageIdentity?: () => unknown;
  /** Returns false when the storage owner/generation has been replaced. */
  isStorageIdentityCurrent?: (identity: unknown) => boolean;
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  hasInFlightSessionRuns(): boolean;
  isSessionRunInFlight(sessionId: string): boolean;
  isRunningSession(session: Session): boolean;
  listSessions(): Awaitable<Session[]>;
  listAuxiliarySessions(): Awaitable<AuxiliarySession[]>;
  listSessionCredentialThreads(): Awaitable<SessionCredentialThreadInfo[]>;
  listAuxiliaryCredentialThreads(): Awaitable<AuxiliaryCredentialThreadInfo[]>;
  getAppSettings(): Awaitable<AppSettings>;
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): Awaitable<void>;
  onChatLayoutPreferenceSaveError?(update: ChatLayoutPreferenceUpdate, error: unknown): void;
  onProviderTurnAvailable?(providerId: string): void;
  getModelCatalog(): Awaitable<ModelCatalogSnapshot>;
  replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Awaitable<Session[]>;
  updateSessionThreadIfMatches(input: SessionThreadPatchInput): Awaitable<Pick<Session, "id" | "threadId"> | null>;
  updateAuxiliarySessionThreadIfMatches(input: AuxiliarySessionThreadPatchInput): Awaitable<Pick<AuxiliarySession, "id" | "parentSessionId" | "threadId"> | null>;
  clearProviderQuotaTelemetry(providerId: string): void;
  clearSessionContextTelemetry(sessionId: string): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  resetAppSettings(): Awaitable<AppSettings>;
  clearProjectMemories(): void;
  resetSessionRuntime(): void;
  clearAllProviderQuotaTelemetry(): void;
  clearAllSessionContextTelemetry(): void;
  clearAllSessionBackgroundActivities(): void;
  invalidateAllProviderSessionThreads(): Awaitable<void>;
  closeResetTargetWindows(): void;
  dismissSessionTurnNotification(sessionId: string): void;
  recreateDatabaseFile(): Promise<ModelCatalogSnapshot>;
  applyAppSettingsSideEffects?: (settings: AppSettings) => void;
  broadcastSessions(sessionIds?: Iterable<string>): void;
  broadcastAppSettings(settings?: AppSettings): Awaitable<void>;
  broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): Awaitable<void>;
};

function getProvidersWithApiKeyChange(previousSettings: AppSettings, nextSettings: AppSettings): string[] {
  const providerIds = new Set<string>([
    ...Object.keys(previousSettings.codingProviderSettings),
    ...Object.keys(nextSettings.codingProviderSettings),
  ]);

  return Array.from(providerIds).filter(
    (providerId) =>
      getProviderAppSettings(previousSettings, providerId).apiKey.trim() !==
      getProviderAppSettings(nextSettings, providerId).apiKey.trim(),
  );
}

type DeferredProviderCleanup<T> = {
  value: T;
  cleanup(): Promise<void>;
  rollback(): Promise<void>;
  affectedProviders: readonly string[];
};

export class SettingsCatalogService {
  private readonly affectedProviders = new Map<string, number>();
  private chatLayoutCurrent: Partial<ChatLayoutPreference> = {};
  private chatLayoutWriteTail: Promise<void> = Promise.resolve();
  private rollbackEpoch = 0;

  constructor(private readonly deps: SettingsCatalogServiceDeps) {}

  private captureStorageIdentity(): unknown {
    return this.deps.captureStorageIdentity?.();
  }

  private assertStorageIdentityCurrent(identity: unknown): void {
    if (this.deps.isStorageIdentityCurrent && !this.deps.isStorageIdentityCurrent(identity)) {
      throw new Error("Saved data changed, so deferred rollback was canceled.");
    }
  }

  private assertRollbackEpochCurrent(epoch: number): void {
    if (epoch !== this.rollbackEpoch) {
      throw new Error("Rollback was canceled because a reset started.");
    }
  }

  private acquireProvider(providerId: string): void {
    this.affectedProviders.set(providerId, (this.affectedProviders.get(providerId) ?? 0) + 1);
  }

  private releaseProvider(providerId: string): void {
    const count = this.affectedProviders.get(providerId) ?? 0;
    if (count <= 1) {
      this.affectedProviders.delete(providerId);
      try {
        this.deps.onProviderTurnAvailable?.(providerId);
      } catch (error) {
        console.warn("Provider turn availability notification failed", error);
      }
    } else {
      this.affectedProviders.set(providerId, count - 1);
    }
  }

  assertProviderAvailableForTurn(providerId: string): void {
    if (!this.isProviderAvailableForTurn(providerId)) {
        throw new Error("A provider settings update is in progress. Wait for it to finish before starting a new session.");
    }
  }

  isProviderAvailableForTurn(providerId: string): boolean {
    return (this.affectedProviders.get(providerId) ?? 0) === 0;
  }

  async getAppSettings(): Promise<AppSettings> {
    return this.withCurrentChatLayout(await this.deps.getAppSettings());
  }

  private withCurrentChatLayout(settings: AppSettings): AppSettings {
    return {
      ...settings,
      chatLayoutPreference: { ...settings.chatLayoutPreference, ...this.chatLayoutCurrent },
    };
  }

  updateChatLayoutPreference(update: ChatLayoutPreferenceUpdate): void {
    if (!isChatLayoutPreferenceUpdate(update)) {
      throw new TypeError("Invalid chat layout preference update.");
    }
    this.chatLayoutCurrent = { ...this.chatLayoutCurrent, [update.target]: update.value };
    const epoch = this.rollbackEpoch;
    const storageIdentity = this.captureStorageIdentity();
    const write = this.chatLayoutWriteTail.then(() => {
      if (epoch !== this.rollbackEpoch || (this.deps.isStorageIdentityCurrent && !this.deps.isStorageIdentityCurrent(storageIdentity))) return;
      return this.deps.updateChatLayoutPreference(update);
    });
    this.chatLayoutWriteTail = write.then(() => {}, (error: unknown) => {
      try {
        this.deps.onChatLayoutPreferenceSaveError?.(update, error);
      } catch {
        // A diagnostic failure must not break later preference checkpoints.
      }
    });
  }

  async updateAppSettings(nextSettingsInput: AppSettings): Promise<AppSettings> {
    const operation = await this.deps.runProviderRuntimeOperationExclusive(
      () => this.updateAppSettingsExclusive(nextSettingsInput),
    );
    try {
      await operation.cleanup();
      return operation.value;
    } catch (error) {
      try {
        await this.deps.runProviderRuntimeOperationExclusive(() => operation.rollback());
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "App settings cleanup rollback failed.");
      }
      throw error;
    } finally {
      for (const providerId of operation.affectedProviders) {
        this.releaseProvider(providerId);
      }
    }
  }

  private async updateAppSettingsExclusive(
    nextSettingsInput: AppSettings,
  ): Promise<DeferredProviderCleanup<AppSettings>> {
    const previousSettings = await this.deps.getAppSettings();
    const storageIdentity = this.captureStorageIdentity();
    const rollbackEpoch = this.rollbackEpoch;
    const nextSettings = normalizeAppSettings(nextSettingsInput);
    const providersWithApiKeyChange = getProvidersWithApiKeyChange(previousSettings, nextSettings);
    const previousSessions = providersWithApiKeyChange.length > 0
      ? await this.deps.listSessionCredentialThreads()
      : [];
    const previousAuxiliarySessions = providersWithApiKeyChange.length > 0
      ? await this.deps.listAuxiliaryCredentialThreads()
      : [];

    if (providersWithApiKeyChange.length > 0) {
      const hasBlockedSession = previousSessions.some(
        (session) =>
          providersWithApiKeyChange.includes(session.provider) &&
          (this.deps.isSessionRunInFlight(session.id) || session.status === "running" || session.runState === "running"),
      );
      const hasBlockedAuxiliary = previousAuxiliarySessions.some((session) =>
        providersWithApiKeyChange.includes(session.provider) &&
        (this.deps.isSessionRunInFlight(session.id) || session.runState === "running"),
      );
      if (hasBlockedSession || hasBlockedAuxiliary) {
        throw new Error("A session is using the provider whose Coding Agent credentials are changing. Wait for it to finish.");
      }
    }

    const providersWithApiKeyChangeSet = new Set(providersWithApiKeyChange);
    const sessionThreadResetTargets = previousSessions.filter((session) =>
      providersWithApiKeyChangeSet.has(session.provider) && session.threadId
    );
    const auxiliaryThreadResetTargets = previousAuxiliarySessions.filter((session) =>
      providersWithApiKeyChangeSet.has(session.provider) && session.threadId
    );
    const appliedSessionPatches: Array<{ previous: SessionCredentialThreadInfo; current: Pick<Session, "id" | "threadId"> }> = [];
    const appliedAuxiliaryPatches: Array<{ previous: AuxiliaryCredentialThreadInfo; current: Pick<AuxiliarySession, "id" | "parentSessionId" | "threadId"> }> = [];
    const updateSessionThreadIfMatches = this.deps.updateSessionThreadIfMatches;
    const updateAuxiliarySessionThreadIfMatches = this.deps.updateAuxiliarySessionThreadIfMatches;

    let savedSettings: AppSettings | null = null;
    try {
      savedSettings = await this.deps.updateAppSettings(nextSettings);
      for (const providerId of providersWithApiKeyChange) {
        this.deps.clearProviderQuotaTelemetry(providerId);
      }
      for (const session of previousSessions) {
        if (providersWithApiKeyChangeSet.has(session.provider)) {
          this.deps.clearSessionContextTelemetry(session.id);
        }
      }
      for (const session of previousAuxiliarySessions) {
        if (providersWithApiKeyChangeSet.has(session.provider)) {
          this.deps.clearSessionContextTelemetry(session.id);
        }
      }
      for (const previous of sessionThreadResetTargets) {
        const current = await updateSessionThreadIfMatches({
          sessionId: previous.id,
          incarnationId: previous.incarnationId,
          provider: previous.provider,
          expectedThreadId: previous.threadId,
          nextThreadId: "",
          updatedAt: currentTimestampLabel(),
        });
        if (current) {
          appliedSessionPatches.push({ previous, current });
        }
      }
      for (const previous of auxiliaryThreadResetTargets) {
        const current = await updateAuxiliarySessionThreadIfMatches({
          auxiliarySessionId: previous.id,
          parentSessionId: previous.parentSessionId,
          provider: previous.provider,
          expectedThreadId: previous.threadId,
          nextThreadId: "",
          updatedAt: currentTimestampLabel(),
          createdAt: previous.createdAt,
        });
        if (current) {
          appliedAuxiliaryPatches.push({ previous, current });
        }
      }
      if (appliedSessionPatches.length > 0 || appliedAuxiliaryPatches.length > 0) {
        this.deps.broadcastSessions(new Set([
          ...appliedSessionPatches.map(({ current }) => current.id),
          ...appliedAuxiliaryPatches.map(({ current }) => current.parentSessionId),
        ]));
      }
      const currentSettings = await this.getAppSettings();
      await this.deps.broadcastAppSettings(currentSettings);
      const cleanupTargets = [
        ...previousSessions.filter((session) => providersWithApiKeyChangeSet.has(session.provider)),
        ...previousAuxiliarySessions.filter((session) => providersWithApiKeyChangeSet.has(session.provider)),
      ];
      const affectedProviders = Array.from(providersWithApiKeyChangeSet);
      for (const providerId of affectedProviders) {
        this.acquireProvider(providerId);
      }
      return {
        value: currentSettings,
        affectedProviders,
        cleanup: async () => {
          for (const session of cleanupTargets) {
            await this.deps.invalidateProviderSessionThread(session.provider, session.id);
          }
        },
        rollback: async () => {
          this.assertRollbackEpochCurrent(rollbackEpoch);
          this.assertStorageIdentityCurrent(storageIdentity);
          const current = await this.deps.getAppSettings();
          if (JSON.stringify(current) !== JSON.stringify(savedSettings)) {
            throw new Error("App settings changed concurrently after cleanup, so rollback was canceled.");
          }
          await this.deps.updateAppSettings(previousSettings);
          for (const { previous, current: applied } of appliedSessionPatches) {
            await updateSessionThreadIfMatches({
              sessionId: previous.id,
              incarnationId: previous.incarnationId,
              provider: previous.provider,
              expectedThreadId: applied.threadId,
              nextThreadId: previous.threadId,
              updatedAt: currentTimestampLabel(),
            });
          }
          for (const { previous, current: applied } of appliedAuxiliaryPatches) {
            await updateAuxiliarySessionThreadIfMatches({
              auxiliarySessionId: previous.id,
              parentSessionId: previous.parentSessionId,
              provider: previous.provider,
              expectedThreadId: applied.threadId,
              nextThreadId: previous.threadId,
              updatedAt: currentTimestampLabel(),
              createdAt: previous.createdAt,
            });
          }
          this.deps.broadcastSessions(new Set([
            ...appliedSessionPatches.map(({ previous }) => previous.id),
            ...appliedAuxiliaryPatches.map(({ previous }) => previous.parentSessionId),
          ]));
          await this.deps.broadcastAppSettings(this.withCurrentChatLayout(previousSettings));
        },
      };
    } catch (error) {
      if (!savedSettings) {
        throw error;
      }

      try {
        this.assertRollbackEpochCurrent(rollbackEpoch);
        this.assertStorageIdentityCurrent(storageIdentity);
        await this.deps.updateAppSettings(previousSettings);
        for (const { previous, current } of appliedSessionPatches) {
          await updateSessionThreadIfMatches({
            sessionId: previous.id,
            incarnationId: previous.incarnationId,
            provider: previous.provider,
            expectedThreadId: current.threadId,
            nextThreadId: previous.threadId,
            updatedAt: currentTimestampLabel(),
          });
        }
        for (const { previous, current } of appliedAuxiliaryPatches) {
          await updateAuxiliarySessionThreadIfMatches({
            auxiliarySessionId: previous.id,
            parentSessionId: previous.parentSessionId,
            provider: previous.provider,
            expectedThreadId: current.threadId,
            nextThreadId: previous.threadId,
            updatedAt: currentTimestampLabel(),
            createdAt: previous.createdAt,
          });
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "App settings rollback failed.",
        );
      }

      throw error;
    }
  }

  async resetAppDatabase(request?: ResetAppDatabaseRequest | null): Promise<ResetAppDatabaseResult> {
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.resetAppDatabaseExclusive(request),
    );
  }

  private async resetAppDatabaseExclusive(
    request?: ResetAppDatabaseRequest | null,
  ): Promise<ResetAppDatabaseResult> {
    const sessions = await this.deps.listSessions();
    if (this.deps.hasInFlightSessionRuns() || sessions.some((session) => this.deps.isRunningSession(session))) {
      throw new Error("The database cannot be reset while a session is running. Complete or cancel it first.");
    }

    const previousSessionIds = sessions.map((session) => session.id);
    const resetTargets = normalizeResetAppDatabaseTargets(request?.targets);
    if (resetTargets.length === 0) {
      throw new Error("Select at least one reset target.");
    }
    // Invalidate deferred rollbacks only after reset validation and immediately
    // before the first reset mutation. This also covers app-settings-only ABA.
    this.rollbackEpoch += 1;
    const previousAuxiliarySessionIds = resetTargets.includes("sessions")
      ? (await this.deps.listAuxiliarySessions()).map((session) => session.id)
      : [];
    const previousSessionNotificationIds = [
      ...previousSessionIds,
      ...previousAuxiliarySessionIds,
    ];

    if (resetTargets.includes("sessions")) {
      this.deps.closeResetTargetWindows();
    }

    let modelCatalog: ModelCatalogSnapshot;
    let appSettings: AppSettings;

    if (areAllResetAppDatabaseTargetsSelected(resetTargets)) {
      modelCatalog = await this.deps.recreateDatabaseFile();
      this.chatLayoutCurrent = {};
      this.dismissSessionTurnNotifications(previousSessionNotificationIds);
      this.deps.resetSessionRuntime();
      this.deps.clearAllSessionBackgroundActivities();
      await this.deps.invalidateAllProviderSessionThreads();
      this.deps.clearAllProviderQuotaTelemetry();
      this.deps.clearAllSessionContextTelemetry();
      appSettings = await this.deps.getAppSettings();
    } else {
      const appliedTargets = new Set<ResetAppDatabaseTarget>(resetTargets);

      if (appliedTargets.has("sessions")) {
        await this.deps.replaceAllSessions([], { broadcast: false });
        this.dismissSessionTurnNotifications(previousSessionNotificationIds);
        this.deps.resetSessionRuntime();
        this.deps.clearAllSessionBackgroundActivities();
        await this.deps.invalidateAllProviderSessionThreads();
      }
      if (appliedTargets.has("appSettings")) {
        await this.deps.resetAppSettings();
        this.chatLayoutCurrent = {};
        this.deps.clearAllProviderQuotaTelemetry();
      }
      if (appliedTargets.has("projectMemory")) {
        this.deps.clearProjectMemories();
      }
      modelCatalog = await this.deps.getModelCatalog();
      appSettings = await this.deps.getAppSettings();
    }

    appSettings = this.withCurrentChatLayout(appSettings);
    this.deps.applyAppSettingsSideEffects?.(appSettings);
    this.deps.broadcastSessions(previousSessionIds);
    await this.deps.broadcastAppSettings(appSettings);
    await this.deps.broadcastModelCatalog(modelCatalog);

    return {
      resetTargets,
      sessions: await this.deps.listSessions(),
      appSettings,
      modelCatalog,
    };
  }

  private dismissSessionTurnNotifications(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      this.deps.dismissSessionTurnNotification(sessionId);
    }
  }
}
