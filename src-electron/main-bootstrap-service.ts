import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { MateStorageState } from "../src/mate-state.js";

type MainBootstrapServiceDeps = {
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  recoverInterruptedSessions(): Promise<void>;
  refreshCharactersFromStorage(): Promise<void>;
  registerIpcHandlers(): void;
  createHomeWindow(): Promise<void>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  getMateState: () => MateStorageState | Promise<MateStorageState>;
  applyPendingGrowth(): Promise<unknown>;
  growthApplyIntervalMs?: number;
  createGrowthApplyTimer?: (handler: () => void, intervalMs: number) => unknown;
  clearGrowthApplyTimer?: (timer: unknown) => void;
};

const DEFAULT_GROWTH_APPLY_INTERVAL_MS = 60 * 60 * 1000;
type GrowthApplyTimerHandle = unknown;

export class MainBootstrapService {
  private readonly growthApplyIntervalMs: number;
  private readonly createGrowthApplyTimer: (handler: () => void, intervalMs: number) => unknown;
  private readonly clearGrowthApplyTimerHandle: (timer: unknown) => void;
  private growthApplyTimer: GrowthApplyTimerHandle | null = null;

  constructor(private readonly deps: MainBootstrapServiceDeps) {
    this.growthApplyIntervalMs = deps.growthApplyIntervalMs ?? DEFAULT_GROWTH_APPLY_INTERVAL_MS;
    this.createGrowthApplyTimer = deps.createGrowthApplyTimer ?? ((handler, intervalMs) => {
      return setInterval(handler, intervalMs);
    });
    this.clearGrowthApplyTimerHandle = deps.clearGrowthApplyTimer ?? ((timer) => {
      clearInterval(timer as ReturnType<typeof setInterval>);
    });
  }

  async ensureGrowthApplyTimer(): Promise<void> {
    if (this.growthApplyTimer !== null) {
      return;
    }

    const mateState = await this.deps.getMateState();
    if (mateState === "not_created") {
      return;
    }

    this.growthApplyTimer = this.createGrowthApplyTimer(() => {
      void this.deps.applyPendingGrowth().catch((error) => {
        console.warn("Failed to apply pending growth", error);
      });
    }, this.growthApplyIntervalMs);
  }

  clearGrowthApplyTimer(): void {
    if (this.growthApplyTimer === null) {
      return;
    }

    this.clearGrowthApplyTimerHandle(this.growthApplyTimer);
    this.growthApplyTimer = null;
  }

  async handleReady(): Promise<void> {
    const activeModelCatalog = await this.deps.initializePersistentStores();
    await this.deps.recoverInterruptedSessions();
    await this.deps.refreshCharactersFromStorage();
    this.deps.registerIpcHandlers();
    await this.deps.createHomeWindow();
    this.deps.broadcastModelCatalog(activeModelCatalog);
    await this.ensureGrowthApplyTimer();
  }

  clearGrowthApplyTimerForTest(): void {
    this.clearGrowthApplyTimer();
  }
}
