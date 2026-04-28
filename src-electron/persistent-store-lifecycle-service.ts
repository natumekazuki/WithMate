import { basename } from "node:path";
import { rm } from "node:fs/promises";

import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import { APP_DATABASE_V2_FILENAME } from "./database-schema-v2.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { AuditLogStorageV2Read } from "./audit-log-storage-v2-read.js";
import { CharacterMemoryStorage } from "./character-memory-storage.js";
import {
  CharacterMemoryStorageV2Read,
  ProjectMemoryStorageV2Read,
  SessionMemoryStorageV2Read,
} from "./memory-storage-v2-read.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { ProjectMemoryStorage } from "./project-memory-storage.js";
import { SessionMemoryStorage } from "./session-memory-storage.js";
import { SessionStorage } from "./session-storage.js";
import { SessionStorageV2Read } from "./session-storage-v2-read.js";
import { truncateAppDatabaseWal } from "./sqlite-connection.js";

type ClosableStore = {
  close(): void;
};

export type SessionStorageRead = Pick<
  SessionStorage,
  "listSessions" | "listSessionSummaries" | "getSession" | "close"
>;
export type SessionStorageWrite = Pick<
  SessionStorage,
  "upsertSession" | "replaceSessions" | "deleteSession" | "clearSessions"
> & SessionStorageRead;

export type AuditLogStorageRead = Pick<
  AuditLogStorage,
  "listSessionAuditLogs" | "listSessionAuditLogSummaries" | "getSessionAuditLogDetail" | "close"
>;
export type AuditLogStorageWrite = Pick<
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
  onBeforeClose(): void;
  truncateWal(dbPath: string): void;
  removeFile(filePath: string): Promise<void>;
};

export class PersistentStoreLifecycleService {
  constructor(private readonly deps: PersistentStoreLifecycleDeps) {}

  async initialize(dbPath: string, bundledModelCatalogPath: string): Promise<PersistentStoreBundle> {
    const modelCatalogStorage = this.deps.createModelCatalogStorage(dbPath, bundledModelCatalogPath);
    const activeModelCatalog = modelCatalogStorage.ensureSeeded();
    const isV2Database = this.isV2DatabasePath(dbPath);
    const sessionStorage = isV2Database
      ? new SessionStorageV2Read(dbPath)
      : this.deps.createSessionStorage(dbPath);
    const sessionMemoryStorage = isV2Database
      ? new SessionMemoryStorageV2Read()
      : this.deps.createSessionMemoryStorage(dbPath);
    const projectMemoryStorage = isV2Database
      ? new ProjectMemoryStorageV2Read()
      : this.deps.createProjectMemoryStorage(dbPath);
    const characterMemoryStorage = isV2Database
      ? new CharacterMemoryStorageV2Read()
      : this.deps.createCharacterMemoryStorage(dbPath);
    const auditLogStorage = isV2Database
      ? new AuditLogStorageV2Read(dbPath)
      : this.deps.createAuditLogStorage(dbPath);
    const appSettingsStorage = this.deps.createAppSettingsStorage(dbPath);
    const loadedSessions = sessionStorage.listSessions();
    const sessions = loadedSessions.length === 0 ? [] : loadedSessions;

    return {
      modelCatalogStorage,
      sessionStorage,
      sessionMemoryStorage,
      projectMemoryStorage,
      characterMemoryStorage,
      auditLogStorage,
      appSettingsStorage,
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
  ): Promise<PersistentStoreBundle> {
    this.close(bundle, dbPath);

    await Promise.all([
      this.deps.removeFile(`${dbPath}-wal`),
      this.deps.removeFile(`${dbPath}-shm`),
      this.deps.removeFile(dbPath),
    ]);

    return this.initialize(dbPath, bundledModelCatalogPath);
  }

  private isV2DatabasePath(dbPath: string): boolean {
    return basename(dbPath) === APP_DATABASE_V2_FILENAME;
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
    onBeforeClose: () => {},
    truncateWal: truncateAppDatabaseWal,
    removeFile: async (filePath) => {
      await rm(filePath, { force: true });
    },
  });
}
