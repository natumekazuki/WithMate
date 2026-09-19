import {
  currentTimestampLabel,
} from "../src/app-state.js";
import {
  getProviderAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from "../src/provider-settings-state.js";
import { getSessionIncarnationId, type Session } from "../src/session-state.js";
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
import type { AuxiliarySession } from "../src/auxiliary-session-state.js";
import type { CompanionSession } from "../src/companion-state.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";
import type { RunProviderRuntimeOperationExclusive } from "./provider-runtime-operation-coordinator.js";
import type { SessionThreadPatchInput } from "./session-storage-v6.js";
import type { AuxiliarySessionThreadPatchInput } from "./auxiliary-session-storage.js";
import type { AuxiliarySessionRuntimeMetadataPatchInput } from "./auxiliary-session-storage.js";
import type { ProviderRuntimeMetadata, ProviderRuntimeMetadataPatch } from "./provider-runtime-metadata-patch.js";

export type SettingsCatalogServiceDeps = {
  runProviderRuntimeOperationExclusive: RunProviderRuntimeOperationExclusive;
  hasInFlightSessionRuns(): boolean;
  isSessionRunInFlight(sessionId: string): boolean;
  isRunningSession(session: Session): boolean;
  listSessions(): Awaitable<Session[]>;
  listAuxiliarySessions(): Awaitable<AuxiliarySession[]>;
  listCompanionSessions?: () => Awaitable<CompanionSession[]>;
  getAppSettings(): Awaitable<AppSettings>;
  updateAppSettings(settings: AppSettings): Awaitable<AppSettings>;
  getModelCatalog(revision?: number | null): Awaitable<ModelCatalogSnapshot | null>;
  ensureModelCatalogSeeded(): Awaitable<ModelCatalogSnapshot>;
  importModelCatalogDocument(
    document: ModelCatalogDocument,
    source: "bundled" | "imported" | "rollback",
  ): Awaitable<ModelCatalogSnapshot>;
  exportModelCatalogDocument(revision?: number | null): Awaitable<ModelCatalogDocument | null>;
  replaceAllSessions(
    nextSessions: Session[],
    options?: {
      broadcast?: boolean;
      invalidateSessionIds?: Iterable<string>;
    },
  ): Awaitable<Session[]>;
  replaceAuxiliarySessions(nextSessions: AuxiliarySession[]): Awaitable<AuxiliarySession[]>;
  updateSessionRuntimeMetadataIfMatches(input: {
    sessionId: string;
    incarnationId: string;
    expected: ProviderRuntimeMetadata;
    next: ProviderRuntimeMetadata;
  }): Awaitable<Session | null>;
  updateAuxiliarySessionRuntimeMetadataIfMatches(input: AuxiliarySessionRuntimeMetadataPatchInput): Awaitable<AuxiliarySession | null>;
  updateSessionThreadIfMatches(input: SessionThreadPatchInput): Awaitable<Session | null>;
  updateAuxiliarySessionThreadIfMatches(input: AuxiliarySessionThreadPatchInput): Awaitable<AuxiliarySession | null>;
  replaceCompanionSessions?: (nextSessions: CompanionSession[]) => Awaitable<CompanionSession[]>;
  updateCompanionRuntimeMetadataIfMatches?: (
    sessionId: string,
    input: ProviderRuntimeMetadataPatch,
  ) => Awaitable<CompanionSession | null>;
  clearProviderQuotaTelemetry(providerId: string): void;
  clearSessionContextTelemetry(sessionId: string): void;
  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Awaitable<void>;
  clearAuditLogs(): Awaitable<void>;
  resetAppSettings(): Awaitable<AppSettings>;
  resetModelCatalogToBundled(): Awaitable<ModelCatalogSnapshot>;
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

function migrateProviderRuntimeMetadata<T extends ProviderRuntimeMetadata>(session: T, snapshot: ModelCatalogSnapshot): T {
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

function getProviderRuntimeMetadata(session: ProviderRuntimeMetadata): ProviderRuntimeMetadata {
  return {
    provider: session.provider,
    catalogRevision: session.catalogRevision,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    threadId: session.threadId,
    updatedAt: session.updatedAt,
  };
}

function migrateSessionToCatalog(session: Session, snapshot: ModelCatalogSnapshot): Session {
  return migrateProviderRuntimeMetadata(session, snapshot);
}

function migrateAuxiliarySessionToCatalog(session: AuxiliarySession, snapshot: ModelCatalogSnapshot): AuxiliarySession {
  return migrateProviderRuntimeMetadata(session, snapshot);
}

function migrateCompanionSessionToCatalog(session: CompanionSession, snapshot: ModelCatalogSnapshot): CompanionSession {
  return migrateProviderRuntimeMetadata(session, snapshot);
}

type DeferredProviderCleanup<T> = {
  value: T;
  cleanup(): Promise<void>;
  rollback(): Promise<void>;
  affectedProviders: readonly string[];
};

export class SettingsCatalogService {
  private readonly affectedProviders = new Set<string>();

  constructor(private readonly deps: SettingsCatalogServiceDeps) {}

  assertProviderAvailableForTurn(providerId: string): void {
    if (this.affectedProviders.has(providerId)) {
      throw new Error("provider の設定反映中は新しい session を開始できないよ。少し待ってね。");
    }
  }

  async getAppSettings(): Promise<AppSettings> {
    return await this.deps.getAppSettings();
  }

  async getModelCatalog(revision?: number | null): Promise<ModelCatalogSnapshot | null> {
    return await this.deps.getModelCatalog(revision);
  }

  async exportModelCatalogDocument(revision?: number | null): Promise<ModelCatalogDocument | null> {
    return await this.deps.exportModelCatalogDocument(revision);
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
        throw new AggregateError([error, rollbackError], "app settings の cleanup 後 rollback に失敗したよ。");
      }
      throw error;
    } finally {
      for (const providerId of operation.affectedProviders) {
        this.affectedProviders.delete(providerId);
      }
    }
  }

  private async updateAppSettingsExclusive(
    nextSettingsInput: AppSettings,
  ): Promise<DeferredProviderCleanup<AppSettings>> {
    const previousSettings = await this.deps.getAppSettings();
    const nextSettings = normalizeAppSettings(nextSettingsInput);
    const providersWithApiKeyChange = getProvidersWithApiKeyChange(previousSettings, nextSettings);

    if (providersWithApiKeyChange.length > 0) {
      const blockedSessions = (await this.deps.listSessions()).filter(
        (session) =>
          providersWithApiKeyChange.includes(session.provider) &&
          (this.deps.isSessionRunInFlight(session.id) || this.deps.isRunningSession(session)),
      );
      if (blockedSessions.length > 0) {
        throw new Error("Coding Agent credential を変更する provider に実行中の session があるため、完了まで待ってね。");
      }
    }

    const previousSessions = await this.deps.listSessions();
    const previousAuxiliarySessions = await this.deps.listAuxiliarySessions();
    const providersWithApiKeyChangeSet = new Set(providersWithApiKeyChange);
    const sessionThreadResetTargets = previousSessions.filter((session) =>
      providersWithApiKeyChangeSet.has(session.provider) && session.threadId
    );
    const auxiliaryThreadResetTargets = previousAuxiliarySessions.filter((session) =>
      providersWithApiKeyChangeSet.has(session.provider) && session.threadId
    );
    const appliedSessionPatches: Array<{ previous: Session; current: Session }> = [];
    const appliedAuxiliaryPatches: Array<{ previous: AuxiliarySession; current: AuxiliarySession }> = [];
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
          incarnationId: getSessionIncarnationId(previous),
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
      if (appliedSessionPatches.length > 0) {
        this.deps.broadcastSessions(appliedSessionPatches.map(({ current }) => current.id));
      }
      const currentSettings = await this.deps.getAppSettings();
      await this.deps.broadcastAppSettings(currentSettings);
      const cleanupTargets = [
        ...previousSessions.filter((session) => providersWithApiKeyChangeSet.has(session.provider)),
        ...previousAuxiliarySessions.filter((session) => providersWithApiKeyChangeSet.has(session.provider)),
      ];
      const affectedProviders = Array.from(providersWithApiKeyChangeSet);
      for (const providerId of affectedProviders) {
        this.affectedProviders.add(providerId);
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
          const current = await this.deps.getAppSettings();
          if (JSON.stringify(current) !== JSON.stringify(savedSettings)) {
            throw new Error("cleanup 後に app settings が並行変更されたため rollback を中止したよ。");
          }
          await this.deps.updateAppSettings(previousSettings);
          for (const { previous, current: applied } of appliedSessionPatches) {
            await updateSessionThreadIfMatches({
              sessionId: previous.id,
              incarnationId: getSessionIncarnationId(previous),
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
        },
      };
    } catch (error) {
      if (!savedSettings) {
        throw error;
      }

      try {
        await this.deps.updateAppSettings(previousSettings);
        for (const { previous, current } of appliedSessionPatches) {
          await updateSessionThreadIfMatches({
            sessionId: previous.id,
            incarnationId: getSessionIncarnationId(previous),
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
          "app settings の更新を rollback できなかったよ。",
        );
      }

      throw error;
    }
  }

  async importModelCatalogDocument(document: ModelCatalogDocument): Promise<ModelCatalogSnapshot> {
    const operation = await this.deps.runProviderRuntimeOperationExclusive(
      () => this.importModelCatalogDocumentExclusive(document),
    );
    try {
      await operation.cleanup();
      return operation.value;
    } catch (error) {
      try {
        await this.deps.runProviderRuntimeOperationExclusive(() => operation.rollback());
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "model catalog の cleanup 後 rollback に失敗したよ。");
      }
      throw error;
    } finally {
      for (const providerId of operation.affectedProviders) {
        this.affectedProviders.delete(providerId);
      }
    }
  }

  private async importModelCatalogDocumentExclusive(
    document: ModelCatalogDocument,
  ): Promise<DeferredProviderCleanup<ModelCatalogSnapshot>> {
    if (this.deps.hasInFlightSessionRuns()) {
      throw new Error("session 実行中は model catalog を読み込めないよ。");
    }

    const previousSnapshot = await this.deps.getModelCatalog(null) ?? await this.deps.ensureModelCatalogSeeded();
    const previousCatalogDocument = await this.deps.exportModelCatalogDocument(previousSnapshot.revision);
    if (!previousCatalogDocument) {
      throw new Error("rollback 用の model catalog を取得できなかったよ。");
    }

    const previousSessions = await this.deps.listSessions();
    const previousAuxiliarySessions = await this.deps.listAuxiliarySessions();
    const previousCompanionSessions = await this.deps.listCompanionSessions?.() ?? [];
    const normalizedDocument = parseModelCatalogDocument(document);
    for (const session of previousSessions) {
      migrateSessionToCatalog(session, { revision: previousSnapshot.revision, providers: normalizedDocument.providers });
    }
    for (const session of previousAuxiliarySessions) {
      migrateAuxiliarySessionToCatalog(session, { revision: previousSnapshot.revision, providers: normalizedDocument.providers });
    }
    for (const session of previousCompanionSessions) {
      migrateCompanionSessionToCatalog(session, { revision: previousSnapshot.revision, providers: normalizedDocument.providers });
    }

    let importedSnapshot: ModelCatalogSnapshot | null = null;
    const appliedSessions: Array<{ previous: Session; current: Session }> = [];
    const appliedAuxiliarySessions: Array<{ previous: AuxiliarySession; current: AuxiliarySession }> = [];
    const appliedCompanionSessions: Array<{ previous: CompanionSession; current: CompanionSession }> = [];
    try {
      importedSnapshot = await this.deps.importModelCatalogDocument(normalizedDocument, "imported");
      const nextSnapshot = importedSnapshot;
      const migratedSessions = previousSessions.map((session) => migrateSessionToCatalog(session, nextSnapshot));
      const migratedAuxiliarySessions = previousAuxiliarySessions.map((session) =>
        migrateAuxiliarySessionToCatalog(session, nextSnapshot),
      );
      const migratedCompanionSessions = previousCompanionSessions.map((session) =>
        migrateCompanionSessionToCatalog(session, nextSnapshot),
      );
      for (let index = 0; index < previousSessions.length; index += 1) {
        const previous = previousSessions[index];
        const next = migratedSessions[index];
        if (!previous || !next) {
          continue;
        }
        const current = await this.deps.updateSessionRuntimeMetadataIfMatches({
          sessionId: previous.id,
          incarnationId: getSessionIncarnationId(previous),
          expected: getProviderRuntimeMetadata(previous),
          next: getProviderRuntimeMetadata(next),
        });
        if (current) {
          appliedSessions.push({ previous, current });
        }
      }
      for (let index = 0; index < previousAuxiliarySessions.length; index += 1) {
        const previous = previousAuxiliarySessions[index];
        const next = migratedAuxiliarySessions[index];
        if (!previous || !next) {
          continue;
        }
        const current = await this.deps.updateAuxiliarySessionRuntimeMetadataIfMatches({
          auxiliarySessionId: previous.id,
          parentSessionId: previous.parentSessionId,
          createdAt: previous.createdAt,
          expected: getProviderRuntimeMetadata(previous),
          next: getProviderRuntimeMetadata(next),
        });
        if (current) {
          appliedAuxiliarySessions.push({ previous, current });
        }
      }
      if (this.deps.updateCompanionRuntimeMetadataIfMatches) {
        for (let index = 0; index < previousCompanionSessions.length; index += 1) {
          const previous = previousCompanionSessions[index];
          const next = migratedCompanionSessions[index];
          if (!previous || !next) {
            continue;
          }
          const current = await this.deps.updateCompanionRuntimeMetadataIfMatches(
            previous.id,
            { expected: getProviderRuntimeMetadata(previous), next: getProviderRuntimeMetadata(next) },
          );
          if (current) {
            appliedCompanionSessions.push({ previous, current });
          }
        }
      }
      this.deps.broadcastSessions(appliedSessions.map(({ current }) => current.id));
      await this.deps.broadcastModelCatalog(nextSnapshot);
      const cleanupTargets = [
        ...appliedSessions,
        ...appliedAuxiliarySessions,
        ...appliedCompanionSessions,
      ].filter(({ previous, current }) =>
        previous.provider !== current.provider || previous.model !== current.model ||
        previous.reasoningEffort !== current.reasoningEffort || previous.catalogRevision !== current.catalogRevision ||
        previous.threadId !== current.threadId,
      );
      const affectedProviders = Array.from(new Set([
        ...previousSessions.map((session) => session.provider),
        ...previousAuxiliarySessions.map((session) => session.provider),
        ...previousCompanionSessions.map((session) => session.provider),
        ...normalizedDocument.providers.map((provider) => provider.id),
      ]));
      for (const providerId of affectedProviders) {
        this.affectedProviders.add(providerId);
      }
      return {
        value: nextSnapshot,
        affectedProviders,
        cleanup: async () => {
          for (const { previous } of cleanupTargets) {
            await this.deps.invalidateProviderSessionThread(previous.provider, previous.id);
          }
        },
        rollback: async () => {
          const currentSnapshot = await this.deps.getModelCatalog(null);
          if (!currentSnapshot || currentSnapshot.revision !== nextSnapshot.revision) {
            throw new Error("cleanup 後に model catalog が並行変更されたため rollback を中止したよ。");
          }
          await this.deps.importModelCatalogDocument(previousCatalogDocument, "rollback");
          for (const { previous, current } of appliedSessions) {
            await this.deps.updateSessionRuntimeMetadataIfMatches({
              sessionId: previous.id,
              incarnationId: getSessionIncarnationId(previous),
              expected: getProviderRuntimeMetadata(current),
              next: getProviderRuntimeMetadata(previous),
            });
          }
          for (const { previous, current } of appliedAuxiliarySessions) {
            await this.deps.updateAuxiliarySessionRuntimeMetadataIfMatches({
              auxiliarySessionId: previous.id,
              parentSessionId: previous.parentSessionId,
              createdAt: previous.createdAt,
              expected: getProviderRuntimeMetadata(current),
              next: getProviderRuntimeMetadata(previous),
            });
          }
          if (this.deps.updateCompanionRuntimeMetadataIfMatches) {
            for (const { previous, current } of appliedCompanionSessions) {
              await this.deps.updateCompanionRuntimeMetadataIfMatches(
                previous.id,
                { expected: getProviderRuntimeMetadata(current), next: getProviderRuntimeMetadata(previous) },
              );
            }
          }
        },
      };
    } catch (error) {
      if (!importedSnapshot) {
        throw error;
      }

      try {
        await this.deps.importModelCatalogDocument(previousCatalogDocument, "rollback");
        for (const { previous, current } of appliedSessions) {
          await this.deps.updateSessionRuntimeMetadataIfMatches({
            sessionId: previous.id,
            incarnationId: getSessionIncarnationId(previous),
            expected: getProviderRuntimeMetadata(current),
            next: getProviderRuntimeMetadata(previous),
          });
        }
        for (const { previous, current } of appliedAuxiliarySessions) {
          await this.deps.updateAuxiliarySessionRuntimeMetadataIfMatches({
            auxiliarySessionId: previous.id,
            parentSessionId: previous.parentSessionId,
            createdAt: previous.createdAt,
            expected: getProviderRuntimeMetadata(current),
            next: getProviderRuntimeMetadata(previous),
          });
        }
        if (this.deps.updateCompanionRuntimeMetadataIfMatches) {
          for (const { previous, current } of appliedCompanionSessions) {
            await this.deps.updateCompanionRuntimeMetadataIfMatches(
              previous.id,
              { expected: getProviderRuntimeMetadata(current), next: getProviderRuntimeMetadata(previous) },
            );
          }
        }
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
    return this.deps.runProviderRuntimeOperationExclusive(
      () => this.resetAppDatabaseExclusive(request),
    );
  }

  private async resetAppDatabaseExclusive(
    request?: ResetAppDatabaseRequest | null,
  ): Promise<ResetAppDatabaseResult> {
    const sessions = await this.deps.listSessions();
    if (this.deps.hasInFlightSessionRuns() || sessions.some((session) => this.deps.isRunningSession(session))) {
      throw new Error("実行中の session があるため、DB を初期化できないよ。完了またはキャンセル後に試してね。");
    }

    const previousSessionIds = sessions.map((session) => session.id);
    const resetTargets = normalizeResetAppDatabaseTargets(request?.targets);
    if (resetTargets.length === 0) {
      throw new Error("初期化対象が選ばれていないよ。");
    }
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
      this.dismissSessionTurnNotifications(previousSessionNotificationIds);
      this.deps.resetSessionRuntime();
      this.deps.clearAllSessionBackgroundActivities();
      await this.deps.invalidateAllProviderSessionThreads();
      this.deps.clearAllProviderQuotaTelemetry();
      this.deps.clearAllSessionContextTelemetry();
      appSettings = await this.deps.getAppSettings();
    } else {
      const appliedTargets = new Set<ResetAppDatabaseTarget>(resetTargets);

      if (appliedTargets.has("auditLogs")) {
        await this.deps.clearAuditLogs();
      }
      if (appliedTargets.has("sessions")) {
        await this.deps.replaceAllSessions([], { broadcast: false });
        this.dismissSessionTurnNotifications(previousSessionNotificationIds);
        this.deps.resetSessionRuntime();
        this.deps.clearAllSessionBackgroundActivities();
        await this.deps.invalidateAllProviderSessionThreads();
      }
      if (appliedTargets.has("appSettings")) {
        await this.deps.resetAppSettings();
        this.deps.clearAllProviderQuotaTelemetry();
      }
      if (appliedTargets.has("modelCatalog")) {
        const resetSnapshot = await this.deps.resetModelCatalogToBundled();
        if (!appliedTargets.has("sessions")) {
          const previousCatalogSessions = await this.deps.listSessions();
          const previousCatalogAuxiliarySessions = await this.deps.listAuxiliarySessions();
          const previousCatalogCompanionSessions = await this.deps.listCompanionSessions?.() ?? [];
          const migratedSessions = previousCatalogSessions.map((session) => migrateSessionToCatalog(session, resetSnapshot));
          const migratedAuxiliarySessions = previousCatalogAuxiliarySessions.map((session) =>
            migrateAuxiliarySessionToCatalog(session, resetSnapshot),
          );
          const migratedCompanionSessions = previousCatalogCompanionSessions.map((session) =>
            migrateCompanionSessionToCatalog(session, resetSnapshot),
          );
          for (let index = 0; index < previousCatalogSessions.length; index += 1) {
            const previous = previousCatalogSessions[index];
            const next = migratedSessions[index];
            if (!previous || !next) {
              continue;
            }
            const current = await this.deps.updateSessionRuntimeMetadataIfMatches({
              sessionId: previous.id,
              incarnationId: getSessionIncarnationId(previous),
              expected: getProviderRuntimeMetadata(previous),
              next: getProviderRuntimeMetadata(next),
            });
            if (current) {
              if (previous.provider !== current.provider || previous.model !== current.model ||
                  previous.reasoningEffort !== current.reasoningEffort || previous.catalogRevision !== current.catalogRevision ||
                  previous.threadId !== current.threadId) {
                await this.deps.invalidateProviderSessionThread(previous.provider, previous.id);
              }
            }
          }
          for (let index = 0; index < previousCatalogAuxiliarySessions.length; index += 1) {
            const previous = previousCatalogAuxiliarySessions[index];
            const next = migratedAuxiliarySessions[index];
            if (!previous || !next) {
              continue;
            }
            const current = await this.deps.updateAuxiliarySessionRuntimeMetadataIfMatches({
              auxiliarySessionId: previous.id,
              parentSessionId: previous.parentSessionId,
              createdAt: previous.createdAt,
              expected: getProviderRuntimeMetadata(previous),
              next: getProviderRuntimeMetadata(next),
            });
            if (current && (previous.provider !== current.provider || previous.model !== current.model ||
                previous.reasoningEffort !== current.reasoningEffort || previous.catalogRevision !== current.catalogRevision ||
                previous.threadId !== current.threadId)) {
              await this.deps.invalidateProviderSessionThread(previous.provider, previous.id);
            }
          }
          if (this.deps.updateCompanionRuntimeMetadataIfMatches) {
            for (let index = 0; index < previousCatalogCompanionSessions.length; index += 1) {
              const previous = previousCatalogCompanionSessions[index];
              const next = migratedCompanionSessions[index];
              if (!previous || !next) {
                continue;
              }
              const current = await this.deps.updateCompanionRuntimeMetadataIfMatches(
                previous.id,
                { expected: getProviderRuntimeMetadata(previous), next: getProviderRuntimeMetadata(next) },
              );
              if (current && (previous.provider !== current.provider || previous.model !== current.model ||
                  previous.reasoningEffort !== current.reasoningEffort || previous.catalogRevision !== current.catalogRevision ||
                  previous.threadId !== current.threadId)) {
                await this.deps.invalidateProviderSessionThread(previous.provider, previous.id);
              }
            }
          }
        }
      }
      if (appliedTargets.has("projectMemory")) {
        this.deps.clearProjectMemories();
      }
      modelCatalog = await this.deps.getModelCatalog(null) ?? await this.deps.ensureModelCatalogSeeded();
      appSettings = await this.deps.getAppSettings();
    }

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
