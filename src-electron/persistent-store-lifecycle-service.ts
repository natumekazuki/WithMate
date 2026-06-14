import { basename, dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
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
import { AppSettingsStorage } from "./app-settings-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogStorageV2 } from "./audit-log-storage-v2.js";
import { AuditLogStorageV3 } from "./audit-log-storage-v3.js";
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
import { sessionSummariesToSessions } from "./session-summary-adapter.js";
import { openAppDatabase, truncateAppDatabaseWal } from "./sqlite-connection.js";

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
  "listSessions" | "listSessionSummaries" | "getSession" | "getSessionMessageArtifact"
> & Pick<SessionStorage, "close">;
export type SessionStorageWrite = AwaitableStorageMethods<
  SessionStorage,
  "upsertSession" | "replaceSessions" | "deleteSession" | "clearSessions"
> & SessionStorageRead;

export type AuditLogStorageRead = AwaitableStorageMethods<
  AuditLogStorage,
  | "listSessionAuditLogs"
  | "listSessionAuditLogSummaries"
  | "listSessionAuditLogSummaryPage"
  | "getSessionAuditLogDetail"
  | "getSessionAuditLogDetailSection"
  | "getSessionAuditLogOperationDetail"
> & Pick<AuditLogStorage, "close">;
export type AuditLogStorageWrite = AwaitableStorageMethods<
  AuditLogStorage,
  "createAuditLog" | "updateAuditLog" | "clearAuditLogs"
> & AuditLogStorageRead;
export type SessionMemoryStorageAccess = SessionMemoryStorage | SessionMemoryStorageV2Read;
export type ProjectMemoryStorageAccess = ProjectMemoryStorage | ProjectMemoryStorageV2Read;
export type AuxiliarySessionStorageAccess = {
  listAllAuxiliarySessions(): AuxiliarySession[];
  listAuxiliarySessions(parentSessionId: string): AuxiliarySessionSummary[];
  listRunningActiveAuxiliarySessions(): AuxiliarySessionSummary[];
  getActiveAuxiliarySession(parentSessionId: string): AuxiliarySession | null;
  getAuxiliarySession(auxiliarySessionId: string): AuxiliarySession | null;
  upsertAuxiliarySession(session: AuxiliarySession): AuxiliarySession;
  deleteAuxiliarySessionsForParent(parentSessionId: string): void;
  deleteAuxiliarySessionsExceptParents(parentSessionIds: Iterable<string>): void;
  close(): void;
};
export type CharacterStorageAccess = {
  listCharacters(options?: { includeArchived?: boolean }): CharacterCatalogEntry[];
  getCharacter(characterId: string): CharacterDetail | null;
  createCharacter(input: CreateCharacterInput): CharacterDetail;
  updateCharacterMetadata(input: UpdateCharacterMetadataInput): CharacterDetail;
  updateCharacterDefinition(input: UpdateCharacterDefinitionInput): CharacterDetail;
  archiveCharacter(characterId: string): CharacterCatalogEntry;
  setDefaultCharacter(characterId: string): CharacterCatalogEntry;
  resolveLaunchCharacter(input?: ResolveLaunchCharacterInput): CharacterDetail | null;
  createRuntimeSnapshot(characterId: string): CharacterRuntimeSnapshot | null;
  deleteCharacterRootDirectory(): Promise<void>;
  close(): void;
};

export type PersistentStoreBundle = {
  modelCatalogStorage: ModelCatalogStorage;
  characterStorage: CharacterStorageAccess;
  sessionStorage: SessionStorageRead;
  sessionMemoryStorage: SessionMemoryStorageAccess;
  projectMemoryStorage: ProjectMemoryStorageAccess;
  auditLogStorage: AuditLogStorageRead;
  auxiliarySessionStorage: AuxiliarySessionStorageAccess;
  appSettingsStorage: AppSettingsStorage;
  mateStorage: MateStorage;
  activeModelCatalog: ModelCatalogSnapshot;
  sessions: Session[];
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
  onBeforeClose(): void;
  truncateWal(dbPath: string): void;
  removeFile(filePath: string): Promise<void>;
  removeDirectory?(directoryPath: string): Promise<void>;
};

export class PersistentStoreLifecycleService {
  constructor(private readonly deps: PersistentStoreLifecycleDeps) {}

  async initialize(dbPath: string, bundledModelCatalogPath: string, userDataPath?: string): Promise<PersistentStoreBundle> {
    const isV3Database = isValidV3Database(dbPath);
    const isV2Database = isValidV2Database(dbPath);
    const resolvedUserDataPath = userDataPath ?? dirname(dbPath);
    if (isV3Database) {
      this.deps.ensureV3Schema?.(dbPath);
    } else if (isV2Database) {
      this.deps.ensureV2Schema?.(dbPath);
    }

    const modelCatalogStorage = this.deps.createModelCatalogStorage(dbPath, bundledModelCatalogPath);
    const activeModelCatalog = modelCatalogStorage.ensureSeeded();
    const sessionStorage = isV3Database
      ? new SessionStorageV3(dbPath, this.v3BlobRootPath(dbPath))
      : isV2Database
      ? new SessionStorageV2(dbPath)
      : this.deps.createSessionStorage(dbPath);
    const sessionMemoryStorage = isV3Database || isV2Database
      ? new SessionMemoryStorageV2Read()
      : this.deps.createSessionMemoryStorage(dbPath);
    const projectMemoryStorage = isV3Database || isV2Database
      ? new ProjectMemoryStorageV2Read()
      : this.deps.createProjectMemoryStorage(dbPath);
    const auditLogStorage = isV3Database
      ? new AuditLogStorageV3(dbPath, this.v3BlobRootPath(dbPath))
      : isV2Database
      ? new AuditLogStorageV2(dbPath)
      : this.deps.createAuditLogStorage(dbPath);
    const auxiliarySessionStorage = isV3Database || isV2Database || basename(dbPath) !== APP_DATABASE_V4_FILENAME
      ? new LegacyAuxiliarySessionStorage()
      : this.deps.createAuxiliarySessionStorage?.(dbPath) ?? new AuxiliarySessionStorage(dbPath);
    const characterStorage = isV3Database || isV2Database || basename(dbPath) !== APP_DATABASE_V4_FILENAME
      ? new LegacyCharacterStorage()
      : this.deps.createCharacterStorage?.(dbPath, resolvedUserDataPath)
        ?? new CharacterStorage(dbPath, resolvedUserDataPath);
    const appSettingsStorage = this.deps.createAppSettingsStorage(dbPath);
    const mateStorage = this.deps.createMateStorage(dbPath, resolvedUserDataPath);
    await this.recoverActiveMateProfileProjection(mateStorage);
    const loadedSessionSummaries = await sessionStorage.listSessionSummaries();
    const sessions = loadedSessionSummaries.length === 0 ? [] : sessionSummariesToSessions(loadedSessionSummaries);

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
    };
  }

  close(bundle: PersistentStoreBundleLike, dbPath?: string | null): void {
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

    for (const store of stores) {
      store?.close();
    }

    if (dbPath) {
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
    this.close(bundle, dbPath);

    await Promise.all([
      this.deps.removeFile(`${dbPath}-wal`),
      this.deps.removeFile(`${dbPath}-shm`),
      this.deps.removeFile(dbPath),
      this.isBlobBackedDatabasePath(dbPath)
        ? this.removeBlobRoot(dbPath)
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

  private removeBlobRoot(dbPath: string): Promise<void> {
    if (!this.deps.removeDirectory) {
      throw new Error("DB 再生成には blob root 削除 dependency が必要です。");
    }

    return this.deps.removeDirectory(this.v3BlobRootPath(dbPath));
  }

  private v3BlobRootPath(dbPath: string): string {
    return join(dirname(dbPath), "blobs", "v3");
  }

  private async recoverActiveMateProfileProjection(mateStorage: MateStorage): Promise<void> {
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

  listRunningActiveAuxiliarySessions(): AuxiliarySessionSummary[] {
    return [];
  }

  getActiveAuxiliarySession(): AuxiliarySession | null {
    return null;
  }

  getAuxiliarySession(): AuxiliarySession | null {
    return null;
  }

  upsertAuxiliarySession(): AuxiliarySession {
    throw new Error("Auxiliary Session は legacy DB では利用できません。");
  }

  deleteAuxiliarySessionsForParent(): void {}

  deleteAuxiliarySessionsExceptParents(): void {}

  close(): void {}
}

class LegacyCharacterStorage implements CharacterStorageAccess {
  listCharacters(): CharacterCatalogEntry[] {
    return [];
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

  setDefaultCharacter(): CharacterCatalogEntry {
    throw new Error("Character catalog は legacy DB では利用できません。");
  }

  resolveLaunchCharacter(): CharacterDetail | null {
    return null;
  }

  createRuntimeSnapshot(): CharacterRuntimeSnapshot | null {
    return null;
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
