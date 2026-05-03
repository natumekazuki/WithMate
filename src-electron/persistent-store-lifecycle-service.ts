import { basename, dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import { APP_DATABASE_V2_FILENAME, CREATE_V2_SCHEMA_SQL, isValidV2Database } from "./database-schema-v2.js";
import { APP_DATABASE_V3_FILENAME, CREATE_V3_SCHEMA_SQL, isValidV3Database } from "./database-schema-v3.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogStorageV2 } from "./audit-log-storage-v2.js";
import { AuditLogStorageV3 } from "./audit-log-storage-v3.js";
import { CharacterMemoryStorage } from "./character-memory-storage.js";
import { MateStorage } from "./mate-storage.js";
import {
  CharacterMemoryStorageV2Read,
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
export type CharacterMemoryStorageAccess = CharacterMemoryStorage | CharacterMemoryStorageV2Read;

export type PersistentStoreBundle = {
  modelCatalogStorage: ModelCatalogStorage;
  sessionStorage: SessionStorageRead;
  sessionMemoryStorage: SessionMemoryStorageAccess;
  projectMemoryStorage: ProjectMemoryStorageAccess;
  characterMemoryStorage: CharacterMemoryStorageAccess;
  auditLogStorage: AuditLogStorageRead;
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
  createSessionStorage(dbPath: string): SessionStorage;
  createSessionMemoryStorage(dbPath: string): SessionMemoryStorage;
  createProjectMemoryStorage(dbPath: string): ProjectMemoryStorage;
  createCharacterMemoryStorage(dbPath: string): CharacterMemoryStorage;
  createAuditLogStorage(dbPath: string): AuditLogStorage;
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
    const characterMemoryStorage = isV3Database || isV2Database
      ? new CharacterMemoryStorageV2Read()
      : this.deps.createCharacterMemoryStorage(dbPath);
    const auditLogStorage = isV3Database
      ? new AuditLogStorageV3(dbPath, this.v3BlobRootPath(dbPath))
      : isV2Database
      ? new AuditLogStorageV2(dbPath)
      : this.deps.createAuditLogStorage(dbPath);
    const appSettingsStorage = this.deps.createAppSettingsStorage(dbPath);
    const mateStorage = this.deps.createMateStorage(dbPath, resolvedUserDataPath);
    const loadedSessionSummaries = await sessionStorage.listSessionSummaries();
    const sessions = loadedSessionSummaries.length === 0 ? [] : sessionSummariesToSessions(loadedSessionSummaries);

    return {
      modelCatalogStorage,
      sessionStorage,
      sessionMemoryStorage,
      projectMemoryStorage,
      characterMemoryStorage,
      auditLogStorage,
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
      bundle.sessionStorage,
      bundle.sessionMemoryStorage,
      bundle.projectMemoryStorage,
      bundle.characterMemoryStorage,
      bundle.auditLogStorage,
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
      this.isV3DatabasePath(dbPath)
        ? this.removeV3BlobRoot(dbPath)
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

  private removeV3BlobRoot(dbPath: string): Promise<void> {
    if (!this.deps.removeDirectory) {
      throw new Error("V3 DB 再生成には blob root 削除 dependency が必要です。");
    }

    return this.deps.removeDirectory(this.v3BlobRootPath(dbPath));
  }

  private v3BlobRootPath(dbPath: string): string {
    return join(dirname(dbPath), "blobs", "v3");
  }
}

export function createPersistentStoreLifecycleService(): PersistentStoreLifecycleService {
  return new PersistentStoreLifecycleService({
    createModelCatalogStorage: (dbPath, bundledModelCatalogPath) =>
      new ModelCatalogStorage(dbPath, bundledModelCatalogPath),
    createSessionStorage: (dbPath) => new SessionStorage(dbPath),
    createSessionMemoryStorage: (dbPath) => new SessionMemoryStorage(dbPath),
    createProjectMemoryStorage: (dbPath) => new ProjectMemoryStorage(dbPath),
    createCharacterMemoryStorage: (dbPath) => new CharacterMemoryStorage(dbPath),
    createAuditLogStorage: (dbPath) => new AuditLogStorage(dbPath),
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
