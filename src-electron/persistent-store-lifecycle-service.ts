import { basename, dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type {
  Session,
  SessionCharacterUsage,
  SessionSummary,
  SessionSummaryPageRequest,
  HomeSessionSummaryPageResult,
} from "../src/session-state.js";
import type { AuxiliarySession, AuxiliarySessionSummary } from "../src/auxiliary-session-state.js";
import type {
  CharacterCatalogEntry,
  CharacterDetail,
  CharacterRuntimeSnapshot,
  CreateCharacterInput,
  ResolveLaunchCharacterInput,
  UpdateCharacterDefinitionInput,
  UpdateCharacterMetadataInput,
} from "../src/character/character-catalog.js";
import { APP_DATABASE_V2_FILENAME, CREATE_V2_SCHEMA_SQL, isValidV2Database } from "./database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, CREATE_V3_SCHEMA_SQL, isValidV3Database } from "./database-schema-v3.js";
import { APP_DATABASE_V4_FILENAME } from "./database-schema-v4.js";
import { APP_DATABASE_V6_FILENAME, ensureV6Schema } from "./database-schema-v6.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogStorageV2 } from "./audit-log-storage-v2.js";
import { AuditLogStorageV3 } from "./audit-log-storage-v3.js";
import { AuditLogStorageV6 } from "./audit-log-storage-v6.js";
import { AuxiliarySessionStorage } from "./auxiliary-session-storage.js";
import { CharacterStorage } from "./character-storage.js";
import { MateStorage, type MateProfileFileMismatch } from "./mate-storage.js";
import {
  ProjectMemoryStorageV2Read,
  SessionMemoryStorageV2Read,
} from "./memory-storage-v2-read.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { ProjectMemoryStorage } from "./project-memory-storage.js";
import { SessionMemoryStorage } from "./session-memory-storage.js";
import { SessionStorage } from "./session-storage.js";
import { SessionStorageV2 } from "./session-storage-v2.js";
import { SessionStorageV3 } from "./session-storage-v3.js";
import { SessionStorageV6 } from "./session-storage-v6.js";
import { sessionSummariesToSessions } from "./session-summary-adapter.js";
import { openAppDatabase, truncateAppDatabaseWal } from "./sqlite-connection.js";
import { createV6StorageWorkerBundle, type V6StorageWorkerBundle } from "./storage-worker-bundle.js";
import type { ConversationTimingStorageSnapshot } from "./conversation-timing.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";
import type {
  SessionCharacterAuthoringRuntimeClearInput,
  SessionCharacterAuthoringRuntimeClearResult,
  SessionRunningTurnStartInput,
  SessionRunningTurnStartResult,
} from "./session-running-turn-start.js";

type ClosableStore = {
  close(): void;
};

export type Awaitable<T> = T | Promise<T>;

type AwaitableStorageMethods<TStorage, TKeys extends keyof TStorage> = {
  [TKey in TKeys]: TStorage[TKey] extends (...args: infer TArgs) => infer TReturn
    ? (...args: TArgs) => Awaitable<Awaited<TReturn>>
    : never;
};

export type SessionStorageRead = AwaitableStorageMethods<
  SessionStorage,
  | "listSessions"
  | "listSessionSummaries"
  | "getLatestSessionSummaryForProvider"
  | "getSession"
  | "getSessionMessageArtifact"
  | "listSessionIdsLastActiveBefore"
> & Pick<SessionStorage, "close"> & {
  listSessionSummaryPage?(request?: SessionSummaryPageRequest | null): Awaitable<HomeSessionSummaryPageResult>;
  listSessionCharacterUsage?(): Awaitable<SessionCharacterUsage[]>;
};
export type SessionStorageWrite = AwaitableStorageMethods<
  SessionStorage,
  "insertSession" | "upsertSession" | "replaceSessions" | "deleteSession" | "deleteSessions" | "clearSessions"
> & SessionStorageRead & {
  updateSession?(session: Session): Awaitable<Session>;
  updateSessionThreadIfMatches?(input: import("./session-storage-v6.js").SessionThreadPatchInput): Awaitable<Session | null>;
  updateSessionRuntimeMetadataIfMatches?(input: import("./session-storage-v6.js").SessionRuntimeMetadataPatchInput): Awaitable<Session | null>;
  updateTerminalSession?(session: Session, terminalCommit: SessionTurnTerminalCommit): Awaitable<Session>;
  upsertTerminalSession?(session: Session, terminalCommit: SessionTurnTerminalCommit): Awaitable<Session>;
  appendRunningTurnStart?(input: SessionRunningTurnStartInput): Awaitable<SessionRunningTurnStartResult>;
  clearCharacterAuthoringRuntimeState?(
    input: SessionCharacterAuthoringRuntimeClearInput,
  ): Awaitable<SessionCharacterAuthoringRuntimeClearResult>;
};
export type SessionPinStorage = {
  setSessionPinned(sessionId: string, isPinned: boolean): Awaitable<SessionSummary>;
};

/**
 * Public storage boundaries intentionally describe awaitable methods rather than
 * the current synchronous SQLite implementations. This lets the lifecycle
 * bundle be backed by a Worker without making callers depend on a concrete
 * database class.
 */
export type AuxiliarySessionStorageAsyncAccess = AwaitableStorageMethods<
  AuxiliarySessionStorage,
  | "listAllAuxiliarySessions"
  | "listAuxiliarySessions"
  | "listAuxiliarySessionSummaries"
  | "listActiveAuxiliarySessionSummaries"
  | "listRunningActiveAuxiliarySessions"
  | "getActiveAuxiliarySession"
  | "getAuxiliarySession"
  | "upsertAuxiliarySession"
  | "updateAuxiliarySessionIfMatches"
  | "deleteAuxiliarySessionsForParent"
  | "deleteAuxiliarySessionsExceptParents"
  | "getAuxiliaryDraft"
  | "saveAuxiliaryDraft"
  | "consumeAuxiliaryDraft"
  | "getAuxiliarySessionStatus"
> & Pick<AuxiliarySessionStorage, "close"> & {
  updateAuxiliarySessionThreadIfMatches?(input: import("./auxiliary-session-storage.js").AuxiliarySessionThreadPatchInput): Awaitable<AuxiliarySession | null>;
  updateAuxiliarySessionRuntimeMetadataIfMatches?(
    input: import("./auxiliary-session-storage.js").AuxiliarySessionRuntimeMetadataPatchInput,
  ): Awaitable<AuxiliarySession | null>;
};
export type CharacterStorageAsyncAccess = AwaitableStorageMethods<
  CharacterStorage,
  Exclude<keyof CharacterStorage, "close">
> & Pick<CharacterStorage, "close">;
export type AppSettingsStorageAsyncAccess = AwaitableStorageMethods<
  AppSettingsStorage,
  Exclude<keyof AppSettingsStorage, "close">
> & Pick<AppSettingsStorage, "close">;
export type ModelCatalogStorageAsyncAccess = AwaitableStorageMethods<
  ModelCatalogStorage,
  Exclude<keyof ModelCatalogStorage, "close">
> & Pick<ModelCatalogStorage, "close">;
export type MateStorageAsyncAccess = AwaitableStorageMethods<
  MateStorage,
  Exclude<keyof MateStorage, "close">
> & Pick<MateStorage, "close">;

export type AuditLogStorageRead = AwaitableStorageMethods<
  AuditLogStorage,
  | "listSessionAuditLogs"
  | "listSessionAuditLogSummaries"
  | "listSessionAuditLogSummaryPage"
  | "getSessionAuditLogDetail"
  | "getSessionAuditLogDetailSection"
  | "getSessionAuditLogOperationDetail"
> & Pick<AuditLogStorage, "close"> & {
  getConversationTimingSnapshot?(sessionId: string, observedAt: string): Awaitable<ConversationTimingStorageSnapshot>;
};
export type AuditLogStorageWrite = AwaitableStorageMethods<
  AuditLogStorage,
  "createAuditLog" | "updateAuditLog" | "clearAuditLogs"
> & AuditLogStorageRead;
export type SessionMemoryStorageAccess = SessionMemoryStorage | SessionMemoryStorageV2Read;
export type ProjectMemoryStorageAccess = ProjectMemoryStorage | ProjectMemoryStorageV2Read;
export type AuxiliarySessionStorageAccess = AuxiliarySessionStorageAsyncAccess;
export type CharacterStorageAccess = CharacterStorageAsyncAccess;

export type PersistentStoreBundle = {
  modelCatalogStorage: ModelCatalogStorageAsyncAccess;
  characterStorage: CharacterStorageAccess;
  sessionStorage: SessionStorageRead;
  sessionMemoryStorage: SessionMemoryStorageAccess;
  projectMemoryStorage: ProjectMemoryStorageAccess;
  auditLogStorage: AuditLogStorageRead;
  auxiliarySessionStorage: AuxiliarySessionStorageAccess;
  appSettingsStorage: AppSettingsStorageAsyncAccess;
  mateStorage: MateStorageAsyncAccess;
  activeModelCatalog: ModelCatalogSnapshot;
  sessions: Session[];
  storageWorker?: V6StorageWorkerBundle;
};

export type PersistentStoreBundleLike = {
  [K in keyof Omit<PersistentStoreBundle, "activeModelCatalog" | "sessions">]?: Omit<
    PersistentStoreBundle,
    "activeModelCatalog" | "sessions"
  >[K] | null;
};

type PersistentStoreLifecycleDeps = {
  createModelCatalogStorage(dbPath: string, bundledModelCatalogPath: string): ModelCatalogStorage;
  createCharacterStorage?(dbPath: string, userDataPath: string): CharacterStorageAccess;
  createSessionStorage(dbPath: string): SessionStorage;
  createSessionMemoryStorage(dbPath: string): SessionMemoryStorage;
  createProjectMemoryStorage(dbPath: string): ProjectMemoryStorage;
  createAuditLogStorage(dbPath: string): AuditLogStorage;
  createAuxiliarySessionStorage?(dbPath: string): AuxiliarySessionStorageAccess;
  createAppSettingsStorage(dbPath: string): AppSettingsStorage;
  createMateStorage(dbPath: string, userDataPath: string): MateStorage;
  ensureV2Schema?(dbPath: string): void;
  ensureV3Schema?(dbPath: string): void;
  ensureV6Schema?(dbPath: string): void;
  onBeforeClose(): void;
  truncateWal(dbPath: string): void;
  removeFile(filePath: string): Promise<void>;
  removeDirectory?(directoryPath: string): Promise<void>;
  createV6StorageWorker?(input: {
    dbPath: string;
    bundledModelCatalogPath: string;
    userDataPath: string;
  }): V6StorageWorkerBundle;
};

export class PersistentStoreLifecycleService {
  constructor(private readonly deps: PersistentStoreLifecycleDeps) {}

  async initialize(dbPath: string, bundledModelCatalogPath: string, userDataPath?: string): Promise<PersistentStoreBundle> {
    // V6 ownership is selected by the established filename. Schema validation
    // and initialization happen inside the storage Worker, so Main does not
    // open a synchronous V6 connection merely to choose its owner.
    const isV6Database = basename(dbPath) === APP_DATABASE_V6_FILENAME;
    const isV3Database = !isV6Database && isValidV3Database(dbPath);
    const isV2Database = !isV6Database && isValidV2Database(dbPath);
    const resolvedUserDataPath = userDataPath ?? dirname(dbPath);
    if (isV3Database) {
      this.deps.ensureV3Schema?.(dbPath);
    } else if (isV2Database) {
      this.deps.ensureV2Schema?.(dbPath);
    }

    const storageWorker = isV6Database
      ? (this.deps.createV6StorageWorker?.({
        dbPath,
        bundledModelCatalogPath,
        userDataPath: resolvedUserDataPath,
      }) ?? createV6StorageWorkerBundle({ dbPath, bundledModelCatalogPath, userDataPath: resolvedUserDataPath }))
      : undefined;
    let workerInitial: { activeModelCatalog: ModelCatalogSnapshot; sessions: Session[] } | null = null;
    if (storageWorker) {
      try {
        workerInitial = await storageWorker.initialize() as { activeModelCatalog: ModelCatalogSnapshot; sessions: Session[] };
        const maintenance = await storageWorker.runAuxiliarySummaryMaintenance();
        if (maintenance.stopped || maintenance.remaining > 0) {
          console.warn("Auxiliary summary maintenance stopped with remaining rows", maintenance);
        }
      } catch (error) {
        await storageWorker.client.close().catch(() => undefined);
        throw error;
      }
    }
    const modelCatalogStorage = storageWorker
      ? storageWorker.stores.catalog
      : this.deps.createModelCatalogStorage(dbPath, bundledModelCatalogPath);
    const activeModelCatalog = workerInitial?.activeModelCatalog ?? await modelCatalogStorage.ensureSeeded();
    const sessionStorage = storageWorker
      ? storageWorker.stores.session
      : isV3Database
      ? new SessionStorageV3(dbPath, this.v3BlobRootPath(dbPath))
      : isV2Database
      ? new SessionStorageV2(dbPath)
      : this.deps.createSessionStorage(dbPath);
    const sessionMemoryStorage = isV6Database || isV3Database || isV2Database
      ? new SessionMemoryStorageV2Read()
      : this.deps.createSessionMemoryStorage(dbPath);
    const projectMemoryStorage = isV6Database || isV3Database || isV2Database
      ? new ProjectMemoryStorageV2Read()
      : this.deps.createProjectMemoryStorage(dbPath);
    const auditLogStorage = storageWorker
      ? storageWorker.stores.audit
      : isV3Database
      ? new AuditLogStorageV3(dbPath, this.v3BlobRootPath(dbPath))
      : isV2Database
      ? new AuditLogStorageV2(dbPath)
      : this.deps.createAuditLogStorage(dbPath);
    const auxiliarySessionStorage = storageWorker
      ? storageWorker.stores.auxiliary
      : new LegacyAuxiliarySessionStorage();
    const characterStorage = storageWorker
      ? storageWorker.stores.character
      : isV3Database || isV2Database || (
        basename(dbPath) !== APP_DATABASE_V4_FILENAME
        && basename(dbPath) !== APP_DATABASE_V6_FILENAME
      )
      ? new LegacyCharacterStorage()
      : this.deps.createCharacterStorage?.(dbPath, resolvedUserDataPath)
        ?? new CharacterStorage(dbPath, resolvedUserDataPath);
    const appSettingsStorage = storageWorker ? storageWorker.stores.settings : this.deps.createAppSettingsStorage(dbPath);
    const mateStorage = storageWorker ? storageWorker.stores.mate : this.deps.createMateStorage(dbPath, resolvedUserDataPath);
    await this.recoverActiveMateProfileProjection(mateStorage);
    const sessions = workerInitial?.sessions
      ?? sessionSummariesToSessions(await sessionStorage.listSessionSummaries());

    return {
      modelCatalogStorage,
      characterStorage,
      sessionStorage,
      sessionMemoryStorage,
      projectMemoryStorage,
      auditLogStorage,
      auxiliarySessionStorage,
      appSettingsStorage,
      mateStorage,
      activeModelCatalog,
      sessions,
      ...(storageWorker ? { storageWorker } : {}),
    };
  }

  async close(bundle: PersistentStoreBundleLike, dbPath?: string | null): Promise<void> {
    this.deps.onBeforeClose();

    const stores: Array<ClosableStore | null | undefined> = [
      bundle.modelCatalogStorage,
      bundle.characterStorage,
      bundle.sessionStorage,
      bundle.sessionMemoryStorage,
      bundle.projectMemoryStorage,
      bundle.auditLogStorage,
      bundle.auxiliarySessionStorage,
      bundle.appSettingsStorage,
      bundle.mateStorage,
    ];

    if (!bundle.storageWorker) {
      for (const store of stores) {
        store?.close();
      }
    }

    if (bundle.storageWorker) {
      try {
        await bundle.storageWorker.truncateWal();
      } catch (error) {
        console.warn("SQLite WAL truncate failed", error);
      }
      await bundle.storageWorker.client.close();
    } else if (dbPath && basename(dbPath) !== APP_DATABASE_V6_FILENAME) {
      try {
        this.deps.truncateWal(dbPath);
      } catch (error) {
        console.warn("SQLite WAL truncate failed", error);
      }
    }
  }

  async recreate(
    dbPath: string,
    bundledModelCatalogPath: string,
    bundle: PersistentStoreBundleLike,
    userDataPath?: string,
  ): Promise<PersistentStoreBundle> {
    await this.close(bundle, dbPath);

    await Promise.all([
      this.deps.removeFile(`${dbPath}-wal`),
      this.deps.removeFile(`${dbPath}-shm`),
      this.deps.removeFile(dbPath),
      this.isBlobBackedDatabasePath(dbPath)
        ? this.removeBlobRoot(dbPath)
        : Promise.resolve(),
      this.isCharacterBackedDatabasePath(dbPath)
        ? this.removeCharacterRoot(userDataPath ?? dirname(dbPath))
        : Promise.resolve(),
    ]);

    if (this.isV3DatabasePath(dbPath)) {
      this.deps.ensureV3Schema?.(dbPath);
    } else if (this.isV2DatabasePath(dbPath)) {
      this.deps.ensureV2Schema?.(dbPath);
    }

    return this.initialize(dbPath, bundledModelCatalogPath, userDataPath);
  }

  private isV2DatabasePath(dbPath: string): boolean {
    return basename(dbPath) === APP_DATABASE_V2_FILENAME;
  }

  private isV3DatabasePath(dbPath: string): boolean {
    return basename(dbPath) === APP_DATABASE_V3_FILENAME;
  }

  private isBlobBackedDatabasePath(dbPath: string): boolean {
    const databaseFilename = basename(dbPath);
    return databaseFilename === APP_DATABASE_V3_FILENAME || databaseFilename === APP_DATABASE_V4_FILENAME;
  }

  private isCharacterBackedDatabasePath(dbPath: string): boolean {
    const databaseFilename = basename(dbPath);
    return databaseFilename === APP_DATABASE_V4_FILENAME || databaseFilename === APP_DATABASE_V6_FILENAME;
  }

  private removeBlobRoot(dbPath: string): Promise<void> {
    if (!this.deps.removeDirectory) {
      throw new Error("DB 再生成には blob root 削除 dependency が必要です。");
    }

    return this.deps.removeDirectory(this.v3BlobRootPath(dbPath));
  }

  private removeCharacterRoot(userDataPath: string): Promise<void> {
    if (!this.deps.removeDirectory) {
      throw new Error("DB 再生成には Character root 削除 dependency が必要です。");
    }

    return this.deps.removeDirectory(join(userDataPath, "characters"));
  }

  private v3BlobRootPath(dbPath: string): string {
    return join(dirname(dbPath), "blobs", "v3");
  }

  private async recoverActiveMateProfileProjection(mateStorage: MateStorageAsyncAccess): Promise<void> {
    const recoverFunc = (mateStorage as {
      recoverMateProfileFilesFromActiveRevision?: () => Promise<MateProfileFileMismatch[]>;
    }).recoverMateProfileFilesFromActiveRevision;

    if (typeof recoverFunc !== "function") {
      return;
    }

    try {
      const mismatches = await recoverFunc.call(mateStorage);
      if (mismatches.length > 0) {
        console.warn("Mate profile projection recovery has remaining mismatches", {
          count: mismatches.length,
          mismatches,
        });
      }
    } catch (error) {
      console.warn("Mate profile projection recovery failed during initialization", error);
    }
  }
}

class LegacyAuxiliarySessionStorage implements AuxiliarySessionStorageAccess {
  listAllAuxiliarySessions(): AuxiliarySession[] {
    return [];
  }

  listAuxiliarySessions(): AuxiliarySessionSummary[] {
    return [];
  }

  listAuxiliarySessionSummaries(): AuxiliarySessionSummary[] {
    return [];
  }

  listActiveAuxiliarySessionSummaries(): AuxiliarySessionSummary[] {
    return [];
  }

  listRunningActiveAuxiliarySessions(): AuxiliarySessionSummary[] {
    return [];
  }

  getActiveAuxiliarySession(): AuxiliarySession | null {
    return null;
  }

  getAuxiliarySession(): AuxiliarySession | null {
    return null;
  }

  getAuxiliaryDraft(): null { return null; }

  getAuxiliarySessionStatus(): null { return null; }

  saveAuxiliaryDraft(): never {
    throw new Error("Auxiliary draft は legacy DB では利用できません。");
  }

  consumeAuxiliaryDraft(): never {
    throw new Error("Auxiliary draft は legacy DB では利用できません。");
  }

  upsertAuxiliarySession(): AuxiliarySession {
    throw new Error("Auxiliary Session は legacy DB では利用できません。");
  }

  updateAuxiliarySessionIfMatches(): AuxiliarySession | null {
    return null;
  }

  deleteAuxiliarySessionsForParent(): void {}

  deleteAuxiliarySessionsExceptParents(): void {}

  close(): void {}
}

class LegacyCharacterStorage implements CharacterStorageAccess {
  listCharacters(): CharacterCatalogEntry[] {
    return [];
  }

  getCharacterCatalogEntry(): CharacterCatalogEntry | null {
    return null;
  }

  getCharacter(): CharacterDetail | null {
    return null;
  }

  createCharacter(): CharacterDetail {
    throw new Error("Character catalog は legacy DB では利用できません。");
  }

  updateCharacterMetadata(): CharacterDetail {
    throw new Error("Character catalog は legacy DB では利用できません。");
  }

  updateCharacterDefinition(): CharacterDetail {
    throw new Error("Character catalog は legacy DB では利用できません。");
  }

  archiveCharacter(): CharacterCatalogEntry {
    throw new Error("Character catalog は legacy DB では利用できません。");
  }

  resolveLaunchCharacter(): CharacterDetail | null {
    return null;
  }

  createRuntimeSnapshot(): CharacterRuntimeSnapshot | null {
    return null;
  }

  getCharacterDirectory(): string {
    throw new Error("Character catalog は legacy DB では利用できません。");
  }

  async deleteCharacterRootDirectory(): Promise<void> {}

  close(): void {}
}

export function createPersistentStoreLifecycleService(): PersistentStoreLifecycleService {
  return new PersistentStoreLifecycleService({
    createModelCatalogStorage: (dbPath, bundledModelCatalogPath) =>
      new ModelCatalogStorage(dbPath, bundledModelCatalogPath),
    createCharacterStorage: (dbPath, userDataPath) => new CharacterStorage(dbPath, userDataPath),
    createSessionStorage: (dbPath) => new SessionStorage(dbPath),
    createSessionMemoryStorage: (dbPath) => new SessionMemoryStorage(dbPath),
    createProjectMemoryStorage: (dbPath) => new ProjectMemoryStorage(dbPath),
    createAuditLogStorage: (dbPath) => new AuditLogStorage(dbPath),
    createAuxiliarySessionStorage: (dbPath) => new AuxiliarySessionStorage(dbPath),
    createAppSettingsStorage: (dbPath) => new AppSettingsStorage(dbPath),
    createMateStorage: (dbPath, userDataPath) => new MateStorage(dbPath, userDataPath),
    ensureV2Schema: (dbPath) => {
      const db = openAppDatabase(dbPath);
      try {
        for (const statement of CREATE_V2_SCHEMA_SQL) {
          db.exec(statement);
        }
      } finally {
        db.close();
      }
    },
    ensureV3Schema: (dbPath) => {
      const db = openAppDatabase(dbPath);
      try {
        for (const statement of CREATE_V3_SCHEMA_SQL) {
          db.exec(statement);
        }
      } finally {
        db.close();
      }
    },
    ensureV6Schema: (dbPath) => {
      const db = openAppDatabase(dbPath);
      try {
        ensureV6Schema(db);
      } finally {
        db.close();
      }
    },
    onBeforeClose: () => {},
    truncateWal: truncateAppDatabaseWal,
    removeFile: async (filePath) => {
      await rm(filePath, { force: true });
    },
    removeDirectory: async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true });
    },
  });
}
