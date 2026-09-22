import type { Session } from "../../src-shared/session/session-state.js";
import type { AppDatabaseDiagnostics } from "../../src-shared/window/app-database-diagnostics-state.js";
import type { MemoryV6Diagnostics } from "../../src-shared/memory/memory-diagnostics-state.js";
import type { CharacterAffectTurnDrainCursor } from "../character/character-affect-turn-drain.js";
import type { CharacterAffectTurnSettlementStorage } from "../character/character-affect-turn-settlement-storage.js";
import type { MateProfileItemStorage } from "../mate/mate-profile-item-storage.js";
import type { PromptTemplateStorage } from "../prompt-templates/prompt-template-storage.js";
import type { V6StorageWorkerBundle } from "../storage/storage-worker-bundle.js";
import type { AuditLogStorageRead, AuxiliarySessionStorageAccess, CharacterStorageAccess, PersistentStoreBundle, PersistentStoreBundleLike, ProjectMemoryStorageAccess, SessionMemoryStorageAccess, SessionStorageRead } from "../storage/persistent-store-lifecycle-service.js";

/** Owns the live persistent-store generation and its lifecycle state. */
export class MainStoreContext {
  private state: {
    sessions: Session[];
    owner: PersistentStoreBundle | null;
    sessionStorage: SessionStorageRead | null;
    sessionMemoryStorage: SessionMemoryStorageAccess | null;
    projectMemoryStorage: ProjectMemoryStorageAccess | null;
    modelCatalogStorage: PersistentStoreBundle["modelCatalogStorage"] | null;
    characterStorage: CharacterStorageAccess | null;
    auditLogStorage: AuditLogStorageRead | null;
    auxiliarySessionStorage: AuxiliarySessionStorageAccess | null;
    appSettingsStorage: PersistentStoreBundle["appSettingsStorage"] | null;
    storageWorker: V6StorageWorkerBundle | null;
    promptTemplateStorage: PromptTemplateStorage | V6StorageWorkerBundle["stores"]["prompt"] | null;
    mateStorage: PersistentStoreBundle["mateStorage"] | null;
    mateProfileItemStorage: MateProfileItemStorage | null;
    dbPath: string;
    diagnostics: AppDatabaseDiagnostics | null;
    memoryStatus: MemoryV6Diagnostics["runtime"]["status"];
    settlement: CharacterAffectTurnSettlementStorage | V6StorageWorkerBundle["stores"]["settlement"] | null;
    drainCursor: CharacterAffectTurnDrainCursor | undefined;
    walTimer: ReturnType<typeof setInterval> | null;
  } = {
    sessions: [], owner: null, sessionStorage: null, sessionMemoryStorage: null,
    projectMemoryStorage: null, modelCatalogStorage: null, characterStorage: null,
    auditLogStorage: null, auxiliarySessionStorage: null, appSettingsStorage: null,
    storageWorker: null, promptTemplateStorage: null, mateStorage: null,
    mateProfileItemStorage: null, dbPath: "", diagnostics: null, memoryStatus: "stopped",
    settlement: null, drainCursor: undefined, walTimer: null,
  };

  public get sessions() { return this.state.sessions; }
  public get activePersistentStoreOwner() { return this.state.owner; }
  public get sessionStorage() { return this.state.sessionStorage; }
  public get sessionMemoryStorage() { return this.state.sessionMemoryStorage; }
  public get projectMemoryStorage() { return this.state.projectMemoryStorage; }
  public get modelCatalogStorage() { return this.state.modelCatalogStorage; }
  public get characterStorage() { return this.state.characterStorage; }
  public get auditLogStorage() { return this.state.auditLogStorage; }
  public get auxiliarySessionStorage() { return this.state.auxiliarySessionStorage; }
  public get appSettingsStorage() { return this.state.appSettingsStorage; }
  public get storageWorker() { return this.state.storageWorker; }
  public get promptTemplateStorage() { return this.state.promptTemplateStorage; }
  public get mateStorage() { return this.state.mateStorage; }
  public get mateProfileItemStorage() { return this.state.mateProfileItemStorage; }
  public get dbPath() { return this.state.dbPath; }
  public get appDatabaseDiagnostics() { return this.state.diagnostics; }
  public get memoryV6RuntimeStatus() { return this.state.memoryStatus; }
  public get characterAffectTurnSettlementStorage() { return this.state.settlement; }
  public get characterAffectTurnDrainCursor() { return this.state.drainCursor; }
  public get walMaintenanceTimer() { return this.state.walTimer; }

  public setDbPath(value: string): void { this.state.dbPath = value; }
  public setDatabaseDiagnostics(value: AppDatabaseDiagnostics | null): void { this.state.diagnostics = value; }
  public setMemoryRuntimeStatus(value: MemoryV6Diagnostics["runtime"]["status"]): void { this.state.memoryStatus = value; }
  public setDrainCursor(value: CharacterAffectTurnDrainCursor | undefined): void { this.state.drainCursor = value; }
  public setSessions(value: Session[]): void { this.state.sessions = value; }
  public setActivePersistentStoreOwner(value: PersistentStoreBundle | null): void { this.state.owner = value; }
  public setWalMaintenanceTimer(value: ReturnType<typeof setInterval> | null): void { this.state.walTimer = value; }
  public startWalMaintenance(truncate: (owner: V6StorageWorkerBundle | null, dbPath: string) => Promise<void>, intervalMs: number): void {
    this.stopWalMaintenance();
    let pending = false;
    this.state.walTimer = setInterval(() => {
      if (!this.state.dbPath || pending) return;
      pending = true;
      void truncate(this.state.storageWorker, this.state.dbPath).catch((error) => {
        console.warn("SQLite WAL maintenance failed", error);
      }).finally(() => { pending = false; });
    }, intervalMs);
    this.state.walTimer.unref?.();
  }
  public stopWalMaintenance(): void {
    if (!this.state.walTimer) return;
    clearInterval(this.state.walTimer);
    this.state.walTimer = null;
  }
  public async close(lifecycleClose: (bundle: PersistentStoreBundleLike, dbPath: string) => Promise<void>): Promise<void> {
    const worker = this.state.storageWorker;
    this.state.owner = null;
    this.stopWalMaintenance();
    if (!worker) {
      await this.state.settlement?.close();
      await this.state.promptTemplateStorage?.close();
      await this.state.mateProfileItemStorage?.close();
    }
    this.state.settlement = null;
    this.state.drainCursor = undefined;
    await lifecycleClose({
      storageWorker: worker,
      modelCatalogStorage: this.state.modelCatalogStorage,
      characterStorage: this.state.characterStorage,
      sessionStorage: this.state.sessionStorage,
      sessionMemoryStorage: this.state.sessionMemoryStorage,
      projectMemoryStorage: this.state.projectMemoryStorage,
      auditLogStorage: this.state.auditLogStorage,
      auxiliarySessionStorage: this.state.auxiliarySessionStorage,
      appSettingsStorage: this.state.appSettingsStorage,
      mateStorage: this.state.mateStorage,
    }, this.state.dbPath);
    this.clearReferences();
  }
  public setPromptTemplateStorage(value: PromptTemplateStorage | V6StorageWorkerBundle["stores"]["prompt"] | null): void { this.state.promptTemplateStorage = value; }
  public setMateProfileItemStorage(value: MateProfileItemStorage | null): void { this.state.mateProfileItemStorage = value; }
  public setSettlementStorage(value: CharacterAffectTurnSettlementStorage | V6StorageWorkerBundle["stores"]["settlement"] | null): void { this.state.settlement = value; }
  public setCharacterStorage(value: CharacterStorageAccess | null): void { this.state.characterStorage = value; }

  public activate(bundle: PersistentStoreBundle): void {
    this.state.owner = bundle;
    this.state.storageWorker = bundle.storageWorker ?? null;
    this.state.promptTemplateStorage = this.state.storageWorker?.stores.prompt ?? null;
    this.state.mateProfileItemStorage = null;
    this.state.settlement = this.state.storageWorker?.stores.settlement ?? null;
    this.state.modelCatalogStorage = bundle.modelCatalogStorage;
    this.state.characterStorage = bundle.characterStorage;
    this.state.sessionStorage = bundle.sessionStorage;
    this.state.sessionMemoryStorage = bundle.sessionMemoryStorage;
    this.state.projectMemoryStorage = bundle.projectMemoryStorage;
    this.state.auditLogStorage = bundle.auditLogStorage;
    this.state.auxiliarySessionStorage = bundle.auxiliarySessionStorage;
    this.state.appSettingsStorage = bundle.appSettingsStorage;
    this.state.mateStorage = bundle.mateStorage;
    this.state.sessions = bundle.sessions;
  }

  public clearReferences(): void {
    this.state = { ...this.state, sessions: [], owner: null, sessionStorage: null, sessionMemoryStorage: null, projectMemoryStorage: null, modelCatalogStorage: null, characterStorage: null, auditLogStorage: null, auxiliarySessionStorage: null, appSettingsStorage: null, storageWorker: null, promptTemplateStorage: null, mateStorage: null, mateProfileItemStorage: null, settlement: null, drainCursor: undefined, walTimer: null };
  }
}
