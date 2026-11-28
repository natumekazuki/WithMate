import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { AppBootStatus } from "../../src-shared/window/app-boot-state.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";

/** アプリ起動時の永続データ初期化、復旧と公開順序を組み立てる操作。 */
type MainBootstrapServiceDeps = {
  /** 保存データを初期化し、公開するモデル一覧の初期値を返す。 */
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  /** 保存データが利用可能になってから、中断した Session の状態を復旧する。 */
  recoverInterruptedSessions(): Promise<void>;
  /** 中断した Session の復旧後に IPC の要求受付を開始する。 */
  registerIpcHandlers(): void;
  /** IPC 登録後にモデル一覧の初期値を通知する。 */
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
  getMateState: () => MateStorageState | Promise<MateStorageState>;
  onBootStatus?: (status: AppBootStatus) => void;
};

/** 永続ストアの準備と Session の復旧を待ってから Main の IPC と初期通知を公開する。 */
export class MainBootstrapService {
  /** 起動処理に使う操作を受け取る。実際の初期化は ready を処理するまで開始しない。 */
  constructor(private readonly deps: MainBootstrapServiceDeps) {}

  /** 成長反映タイマーを作成せず、完了する Promise だけを返す。 */
  async ensureGrowthApplyTimer(): Promise<void> {
    await Promise.resolve();
  }

  /** 現在は成長反映タイマーを保持しないため、解除する状態はない。 */
  clearGrowthApplyTimer(): void {}

  /** 成長反映タイマーを再生成せず、完了する Promise だけを返す。 */
  async restartGrowthApplyTimer(): Promise<void> {
    await Promise.resolve();
  }

  /** 保存データの初期化開始を通知し、ストア準備、Session 復旧、IPC 登録、モデル一覧通知の順に進める。 */
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
    this.deps.broadcastModelCatalog(activeModelCatalog);
  }

  /** テストでも通常のタイマー解除と同じ経路を呼ぶ。 */
  clearGrowthApplyTimerForTest(): void {
    this.clearGrowthApplyTimer();
  }
}
