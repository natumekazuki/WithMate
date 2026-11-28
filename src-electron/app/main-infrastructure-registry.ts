/** Main のインフラサービスを最初の要求時に作るためのファクトリー。 */
type MainInfrastructureRegistryDeps<
  TPersistentStoreLifecycleService,
  TMainBootstrapService,
> = {
  /** 永続ストアのライフサイクルを管理するサービスを作る。 */
  createPersistentStoreLifecycleService(): TPersistentStoreLifecycleService;
  /** アプリの起動順序を管理するサービスを作る。 */
  createMainBootstrapService(): TMainBootstrapService;
};

/** Main の起動サービスと永続ストアのライフサイクルサービスを遅延生成し、個別に再利用する。 */
export class MainInfrastructureRegistry<
  TPersistentStoreLifecycleService,
  TMainBootstrapService,
> {
  private persistentStoreLifecycleService: TPersistentStoreLifecycleService | null =
    null;
  private mainBootstrapService: TMainBootstrapService | null = null;

  /** 生成方法だけを保持し、この時点ではどちらのサービスも作らない。 */
  constructor(
    private readonly deps: MainInfrastructureRegistryDeps<
      TPersistentStoreLifecycleService,
      TMainBootstrapService
    >,
  ) {}

  /** 永続ストアのライフサイクルサービスを初回に作り、次のリセットまで同じものを返す。 */
  getPersistentStoreLifecycleService(): TPersistentStoreLifecycleService {
    if (!this.persistentStoreLifecycleService) {
      this.persistentStoreLifecycleService =
        this.deps.createPersistentStoreLifecycleService();
    }
    return this.persistentStoreLifecycleService;
  }

  /** 起動サービスを初回に作り、次のリセットまで同じものを返す。 */
  getMainBootstrapService(): TMainBootstrapService {
    if (!this.mainBootstrapService) {
      this.mainBootstrapService = this.deps.createMainBootstrapService();
    }
    return this.mainBootstrapService;
  }

  /** 保持した参照だけを捨てる。既存サービスの停止や新しいサービスの生成は行わない。 */
  reset(): void {
    this.persistentStoreLifecycleService = null;
    this.mainBootstrapService = null;
  }
}
