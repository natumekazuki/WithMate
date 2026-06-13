import type { ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { AppBootStatus } from "../src/app-boot-state.js";
import type { MateStorageState } from "../src/mate/mate-state.js";

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
      title: "保存領域を初期化しています",
      detail: "セッション、設定、Mate 関連データを読み込んでいます。",
    });
    const activeModelCatalog = await this.deps.initializePersistentStores();
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
  }

  clearGrowthApplyTimerForTest(): void {
    this.clearGrowthApplyTimer();
  }
}
