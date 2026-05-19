import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppBootStatus } from "../src/app-boot-state.js";
import type { MateGrowthApplyResult } from "../src/mate/mate-growth-apply-result.js";
import type { MateStorageState } from "../src/mate/mate-state.js";

type MainBootstrapServiceDeps = {
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  recoverInterruptedSessions(): Promise<void>;
  registerIpcHandlers(): void;
  createHomeWindow(): Promise<void>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  getMateState: () => MateStorageState | Promise<MateStorageState>;
  applyPendingGrowth(): Promise<MateGrowthApplyResult>;
  cleanupStaleGrowthApplyRuns?: () => Promise<number>;
  growthApplyIntervalMs?: number;
  getGrowthApplyIntervalMs?: () => number | Promise<number>;
  createGrowthApplyTimer?: (handler: () => void, intervalMs: number) => unknown;
  clearGrowthApplyTimer?: (timer: unknown) => void;
  shouldRunGrowthApplyTimer?: () => boolean | Promise<boolean>;
  onBootStatus?: (status: AppBootStatus) => void;
};

const DEFAULT_GROWTH_APPLY_INTERVAL_MS = 60 * 60 * 1000;
type GrowthApplyTimerHandle = unknown;

export class MainBootstrapService {
  private readonly growthApplyIntervalMs: number;
  private readonly getGrowthApplyIntervalMs?: () => number | Promise<number>;
  private readonly shouldRunGrowthApplyTimer?: () => boolean | Promise<boolean>;
  private readonly createGrowthApplyTimer: (handler: () => void, intervalMs: number) => unknown;
  private readonly clearGrowthApplyTimerHandle: (timer: unknown) => void;
  private growthApplyInFlight: ReturnType<MainBootstrapServiceDeps["applyPendingGrowth"]> | null = null;
  private growthApplyTimer: GrowthApplyTimerHandle | null = null;

  constructor(private readonly deps: MainBootstrapServiceDeps) {
    this.growthApplyIntervalMs = deps.growthApplyIntervalMs ?? DEFAULT_GROWTH_APPLY_INTERVAL_MS;
    this.getGrowthApplyIntervalMs = deps.getGrowthApplyIntervalMs;
    this.shouldRunGrowthApplyTimer = deps.shouldRunGrowthApplyTimer;
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

    const shouldRun = this.shouldRunGrowthApplyTimer
      ? await this.shouldRunGrowthApplyTimer()
      : true;
    if (!shouldRun) {
      return;
    }

    const intervalMs = await this.resolveGrowthApplyIntervalMs();
    this.growthApplyTimer = this.createGrowthApplyTimer(() => {
      void this.runGrowthApplyOnce().catch((error) => {
        console.warn("Failed to apply pending growth", error);
      });
    }, intervalMs);
  }

  async runGrowthApplyOnce(): ReturnType<MainBootstrapServiceDeps["applyPendingGrowth"]> {
    if (this.growthApplyInFlight) {
      return this.growthApplyInFlight;
    }

    const pendingApply = this.deps.applyPendingGrowth();
    this.growthApplyInFlight = pendingApply;
    try {
      return await pendingApply;
    } finally {
      if (this.growthApplyInFlight === pendingApply) {
        this.growthApplyInFlight = null;
      }
    }
  }

  clearGrowthApplyTimer(): void {
    if (this.growthApplyTimer === null) {
      return;
    }

    this.clearGrowthApplyTimerHandle(this.growthApplyTimer);
    this.growthApplyTimer = null;
  }

  async restartGrowthApplyTimer(): Promise<void> {
    this.clearGrowthApplyTimer();
    await this.ensureGrowthApplyTimer();
  }

  async handleReady(): Promise<void> {
    this.deps.onBootStatus?.({
      kind: "running",
      stage: "stores",
      title: "保存領域を初期化しています",
      detail: "セッション、設定、Mate 関連データを読み込んでいます。",
    });
    const activeModelCatalog = await this.deps.initializePersistentStores();
    if (this.deps.cleanupStaleGrowthApplyRuns) {
      try {
        await this.deps.cleanupStaleGrowthApplyRuns();
      } catch (error) {
        console.warn("Failed to cleanup stale growth apply runs", error);
      }
      }
      await this.deps.recoverInterruptedSessions();
      this.deps.registerIpcHandlers();
    this.deps.onBootStatus?.({
      kind: "running",
      stage: "home",
      title: "Home を準備しています",
      detail: "起動処理が完了したら Home を表示します。",
    });
    await this.deps.createHomeWindow();
    this.deps.broadcastModelCatalog(activeModelCatalog);
    await this.ensureGrowthApplyTimer();
  }

  clearGrowthApplyTimerForTest(): void {
    this.clearGrowthApplyTimer();
  }

  private async resolveGrowthApplyIntervalMs(): Promise<number> {
    const intervalMs = this.getGrowthApplyIntervalMs
      ? await this.getGrowthApplyIntervalMs()
      : this.growthApplyIntervalMs;
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      return Math.floor(intervalMs);
    }
    return DEFAULT_GROWTH_APPLY_INTERVAL_MS;
  }
}
