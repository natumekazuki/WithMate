import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppBootStatus } from "../../src-shared/window/app-boot-state.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";

type MainBootstrapServiceDeps = {
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  recoverInterruptedSessions(): Promise<void>;
  registerIpcHandlers(): void;
  createHomeWindow(): Promise<void>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  getMateState: () => MateStorageState | Promise<MateStorageState>;
  onBootStatus?: (status: AppBootStatus) => void;
};

export class MainBootstrapService {
  constructor(private readonly deps: MainBootstrapServiceDeps) {}

  async ensureGrowthApplyTimer(): Promise<void> {
    await Promise.resolve();
  }

  clearGrowthApplyTimer(): void {
  }

  async restartGrowthApplyTimer(): Promise<void> {
    await Promise.resolve();
  }

  async handleReady(): Promise<void> {
    this.deps.onBootStatus?.({
      kind: "running",
      stage: "stores",
      title: "Initializing saved data",
      detail: "Loading sessions, settings, and saved data.",
    });
    const activeModelCatalog = await this.deps.initializePersistentStores();
    await this.deps.recoverInterruptedSessions();
    this.deps.registerIpcHandlers();
    this.deps.onBootStatus?.({
      kind: "running",
      stage: "home",
      title: "Preparing Home",
      detail: "Home will open when startup is complete.",
    });
    await this.deps.createHomeWindow();
    this.deps.broadcastModelCatalog(activeModelCatalog);
  }

  clearGrowthApplyTimerForTest(): void {
    this.clearGrowthApplyTimer();
  }
}
