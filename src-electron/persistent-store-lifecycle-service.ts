import { rm } from "node:fs/promises";

import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { Session } from "../src/session-state.js";
import { AppSettingsStorage } from "./app-settings-storage.js";
import { AuditLogStorage } from "./audit-log-storage.js";
import { CharacterMemoryStorage } from "./character-memory-storage.js";
import { ModelCatalogStorage } from "./model-catalog-storage.js";
import { ProjectMemoryStorage } from "./project-memory-storage.js";
import { SessionMemoryStorage } from "./session-memory-storage.js";
import { SessionStorage } from "./session-storage.js";

type ClosableStore = {
  close(): void;
};

export type PersistentStoreBundle = {
  modelCatalogStorage: ModelCatalogStorage;
  sessionStorage: SessionStorage;
  sessionMemoryStorage: SessionMemoryStorage;
  projectMemoryStorage: ProjectMemoryStorage;
  characterMemoryStorage: CharacterMemoryStorage;
  auditLogStorage: AuditLogStorage;
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
  syncSessionDependencies(session: Session): void;
  onBeforeClose(): void;
  removeFile(filePath: string): Promise<void>;
};

export class PersistentStoreLifecycleService {
  constructor(private readonly deps: PersistentStoreLifecycleDeps) {}

  async initialize(dbPath: string, bundledModelCatalogPath: string): Promise<PersistentStoreBundle> {
    const modelCatalogStorage = this.deps.createModelCatalogStorage(dbPath, bundledModelCatalogPath);
    const activeModelCatalog = modelCatalogStorage.ensureSeeded();
    const sessionStorage = this.deps.createSessionStorage(dbPath);
    const sessionMemoryStorage = this.deps.createSessionMemoryStorage(dbPath);
    const projectMemoryStorage = this.deps.createProjectMemoryStorage(dbPath);
    const characterMemoryStorage = this.deps.createCharacterMemoryStorage(dbPath);
    const auditLogStorage = this.deps.createAuditLogStorage(dbPath);
    const appSettingsStorage = this.deps.createAppSettingsStorage(dbPath);
    const sessions = sessionStorage.listSessions();

    for (const session of sessions) {
      this.deps.syncSessionDependencies(session);
    }

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

  close(bundle: PersistentStoreBundleLike): void {
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
  }

  async recreate(
    dbPath: string,
    bundledModelCatalogPath: string,
    bundle: PersistentStoreBundleLike,
  ): Promise<PersistentStoreBundle> {
    this.close(bundle);

    await Promise.all([
      this.deps.removeFile(`${dbPath}-wal`),
      this.deps.removeFile(`${dbPath}-shm`),
      this.deps.removeFile(dbPath),
    ]);

    return this.initialize(dbPath, bundledModelCatalogPath);
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
    syncSessionDependencies: () => {},
    onBeforeClose: () => {},
    removeFile: async (filePath) => {
      await rm(filePath, { force: true });
    },
  });
}
