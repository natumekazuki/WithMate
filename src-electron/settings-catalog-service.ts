import {
  currentTimestampLabel,
} from "../src/app-state.js";
import {
  getProviderAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from "../src/provider-settings-state.js";
import { type Session } from "../src/session-state.js";
import {
  coerceModelSelection,
  getProviderCatalog,
  parseModelCatalogDocument,
  type ModelCatalogDocument,
  type ModelCatalogSnapshot,
} from "../src/model-catalog.js";
import {
  areAllResetAppDatabaseTargetsSelected,
  normalizeResetAppDatabaseTargets,
} from "../src/withmate-window-types.js";
import type {
  ResetAppDatabaseRequest,
  ResetAppDatabaseResult,
  ResetAppDatabaseTarget,
} from "../src/withmate-window-types.js";

export type SettingsCatalogServiceDeps = {
  hasInFlightSessionRuns(): boolean;
  isSessionRunInFlight(sessionId: string): boolean;
  isRunningSession(session: Session): boolean;
  listSessions(): Session[];
  getAppSettings(): AppSettings;
  updateAppSettings(settings: AppSettings): AppSettings;
  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null;
  ensureModelCatalogSeeded(): ModelCatalogSnapshot;
  importModelCatalogDocument(
    document: ModelCatalogDocument,
    source: "bundled" | "imported" | "rollback",
  ): ModelCatalogSnapshot;
  exportModelCatalogDocument(revision?: number | null): ModelCatalogDocument | null;
  replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Session[];
  clearProviderQuotaTelemetry(providerId: string): void;
  clearSessionContextTelemetry(sessionId: string): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void;
  clearAuditLogs(): void;
  resetAppSettings(): AppSettings;
  resetModelCatalogToBundled(): ModelCatalogSnapshot;
  clearProjectMemories(): void;
  clearCharacterMemories(): void;
  resetSessionRuntime(): void;
  resetMemoryOrchestration(): void;
  clearAllProviderQuotaTelemetry(): void;
  clearAllSessionContextTelemetry(): void;
  clearAllSessionBackgroundActivities(): void;
  invalidateAllProviderSessionThreads(): void;
  closeResetTargetWindows(): void;
  recreateDatabaseFile(): Promise<ModelCatalogSnapshot>;
  broadcastSessions(sessionIds?: Iterable<string>): void;
  broadcastAppSettings(settings?: AppSettings): void;
  broadcastModelCatalog(snapshot?: ModelCatalogSnapshot | null): void;
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

function migrateSessionToCatalog(session: Session, snapshot: ModelCatalogSnapshot): Session {
  const provider = getProviderCatalog(snapshot.providers, session.provider);
  if (!provider) {
    throw new Error("利用できる model catalog provider が見つからないよ。");
  }

  const selection = coerceModelSelection(provider, session.model, session.reasoningEffort);
  const shouldResetThread =
    session.provider !== provider.id ||
    session.model !== selection.resolvedModel ||
    session.reasoningEffort !== selection.resolvedReasoningEffort;

  return {
    ...session,
    provider: provider.id,
    catalogRevision: snapshot.revision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    threadId: shouldResetThread ? "" : session.threadId,
    updatedAt: shouldResetThread || session.catalogRevision !== snapshot.revision ? currentTimestampLabel() : session.updatedAt,
  };
}

export class SettingsCatalogService {
  constructor(private readonly deps: SettingsCatalogServiceDeps) {}

  getAppSettings(): AppSettings {
    return this.deps.getAppSettings();
  }

  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null {
    return this.deps.getModelCatalog(revision);
  }

  exportModelCatalogDocument(revision?: number | null): ModelCatalogDocument | null {
    return this.deps.exportModelCatalogDocument(revision);
  }

  updateAppSettings(nextSettingsInput: AppSettings): AppSettings {
    const previousSettings = this.deps.getAppSettings();
    const nextSettings = normalizeAppSettings(nextSettingsInput);
    const providersWithApiKeyChange = getProvidersWithApiKeyChange(previousSettings, nextSettings);

    if (providersWithApiKeyChange.length > 0) {
      const blockedSessions = this.deps.listSessions().filter(
        (session) =>
          providersWithApiKeyChange.includes(session.provider) &&
          (this.deps.isSessionRunInFlight(session.id) || this.deps.isRunningSession(session)),
      );
      if (blockedSessions.length > 0) {
        throw new Error("Coding Agent credential を変更する provider に実行中の session があるため、完了まで待ってね。");
      }
    }

    const previousSessions = this.deps.listSessions();
    const providersWithApiKeyChangeSet = new Set(providersWithApiKeyChange);
    const nextSessions = previousSessions.map((session) => {
      if (!providersWithApiKeyChangeSet.has(session.provider) || !session.threadId) {
        return session;
      }

      return {
        ...session,
        threadId: "",
        updatedAt: currentTimestampLabel(),
      };
    });
    const providerInvalidatedSessionIds = previousSessions
      .filter((session) => providersWithApiKeyChangeSet.has(session.provider))
      .map((session) => session.id);
    const threadResetSessionIds = nextSessions
      .filter((session, index) => session.threadId !== previousSessions[index]?.threadId)
      .map((session) => session.id);
    const hasSessionThreadReset = threadResetSessionIds.length > 0;

    let savedSettings: AppSettings | null = null;
    try {
      savedSettings = this.deps.updateAppSettings(nextSettings);
      for (const providerId of providersWithApiKeyChange) {
        this.deps.clearProviderQuotaTelemetry(providerId);
      }
      for (const session of previousSessions) {
        if (providersWithApiKeyChangeSet.has(session.provider)) {
          this.deps.clearSessionContextTelemetry(session.id);
        }
      }
      if (hasSessionThreadReset) {
        this.deps.replaceAllSessions(nextSessions, {
          broadcast: false,
          invalidateSessionIds: providerInvalidatedSessionIds,
        });
        this.deps.broadcastSessions(threadResetSessionIds);
      } else {
        for (const sessionId of providerInvalidatedSessionIds) {
          const sessionProvider = previousSessions.find((session) => session.id === sessionId)?.provider ?? null;
          this.deps.invalidateProviderSessionThread(sessionProvider, sessionId);
        }
      }
      this.deps.broadcastAppSettings(savedSettings);
      return savedSettings;
    } catch (error) {
      if (!savedSettings) {
        throw error;
      }

      try {
        this.deps.updateAppSettings(previousSettings);
        this.deps.replaceAllSessions(previousSessions, { broadcast: false });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "app settings の更新を rollback できなかったよ。",
        );
      }

      throw error;
    }
  }

  importModelCatalogDocument(document: ModelCatalogDocument): ModelCatalogSnapshot {
    if (this.deps.hasInFlightSessionRuns()) {
      throw new Error("session 実行中は model catalog を読み込めないよ。");
    }

    const previousSnapshot = this.deps.getModelCatalog(null) ?? this.deps.ensureModelCatalogSeeded();
    const previousCatalogDocument = this.deps.exportModelCatalogDocument(previousSnapshot.revision);
    if (!previousCatalogDocument) {
      throw new Error("rollback 用の model catalog を取得できなかったよ。");
    }

    const previousSessions = this.deps.listSessions();
    const normalizedDocument = parseModelCatalogDocument(document);
    for (const session of previousSessions) {
      migrateSessionToCatalog(session, { revision: previousSnapshot.revision, providers: normalizedDocument.providers });
    }

    let importedSnapshot: ModelCatalogSnapshot | null = null;
    try {
      importedSnapshot = this.deps.importModelCatalogDocument(normalizedDocument, "imported");
      const nextSnapshot = importedSnapshot;
      const migratedSessions = previousSessions.map((session) => migrateSessionToCatalog(session, nextSnapshot));
      const invalidatedSessionIds = migratedSessions
        .filter((session) => !session.threadId)
        .map((session) => session.id);
      this.deps.replaceAllSessions(migratedSessions, {
        broadcast: false,
        invalidateSessionIds: invalidatedSessionIds,
      });
      this.deps.broadcastSessions(migratedSessions.map((session) => session.id));
      this.deps.broadcastModelCatalog(nextSnapshot);
      return nextSnapshot;
    } catch (error) {
      if (!importedSnapshot) {
        throw error;
      }

      try {
        this.deps.importModelCatalogDocument(previousCatalogDocument, "rollback");
        this.deps.replaceAllSessions(previousSessions, { broadcast: false });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "model catalog の import を rollback できなかったよ。",
        );
      }

      throw error;
    }
  }

  async resetAppDatabase(request?: ResetAppDatabaseRequest | null): Promise<ResetAppDatabaseResult> {
    if (this.deps.hasInFlightSessionRuns() || this.deps.listSessions().some((session) => this.deps.isRunningSession(session))) {
      throw new Error("実行中の session があるため、DB を初期化できないよ。完了またはキャンセル後に試してね。");
    }

    const previousSessionIds = this.deps.listSessions().map((session) => session.id);
    const resetTargets = normalizeResetAppDatabaseTargets(request?.targets);
    if (resetTargets.length === 0) {
      throw new Error("初期化対象が選ばれていないよ。");
    }

    if (resetTargets.includes("sessions")) {
      this.deps.closeResetTargetWindows();
    }

    let modelCatalog: ModelCatalogSnapshot;
    let appSettings: AppSettings;

    if (areAllResetAppDatabaseTargetsSelected(resetTargets)) {
      modelCatalog = await this.deps.recreateDatabaseFile();
      this.deps.clearAllProviderQuotaTelemetry();
      this.deps.clearAllSessionContextTelemetry();
      appSettings = this.deps.getAppSettings();
    } else {
      const appliedTargets = new Set<ResetAppDatabaseTarget>(resetTargets);

      if (appliedTargets.has("auditLogs")) {
        this.deps.clearAuditLogs();
      }
      if (appliedTargets.has("sessions")) {
        this.deps.replaceAllSessions([], { broadcast: false });
        this.deps.resetMemoryOrchestration();
        this.deps.resetSessionRuntime();
        this.deps.clearAllSessionBackgroundActivities();
        this.deps.invalidateAllProviderSessionThreads();
      }
      if (appliedTargets.has("appSettings")) {
        this.deps.resetAppSettings();
        this.deps.clearAllProviderQuotaTelemetry();
      }
      if (appliedTargets.has("modelCatalog")) {
        this.deps.resetModelCatalogToBundled();
      }
      if (appliedTargets.has("projectMemory")) {
        this.deps.clearProjectMemories();
      }
      if (appliedTargets.has("characterMemory")) {
        this.deps.clearCharacterMemories();
      }

      modelCatalog = this.deps.getModelCatalog(null) ?? this.deps.ensureModelCatalogSeeded();
      appSettings = this.deps.getAppSettings();
    }

    this.deps.broadcastSessions(previousSessionIds);
    this.deps.broadcastAppSettings(appSettings);
    this.deps.broadcastModelCatalog(modelCatalog);

    return {
      resetTargets,
      sessions: this.deps.listSessions(),
      appSettings,
      modelCatalog,
    };
  }
}
