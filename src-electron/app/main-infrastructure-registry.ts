type MainInfrastructureRegistryDeps<TPersistentStoreLifecycleService, TMainBootstrapService> = {
  createPersistentStoreLifecycleService(): TPersistentStoreLifecycleService;
  createMainBootstrapService(): TMainBootstrapService;
};

export class MainInfrastructureRegistry<
  TPersistentStoreLifecycleService,
  TMainBootstrapService,
> {
  private persistentStoreLifecycleService: TPersistentStoreLifecycleService | null = null;
  private mainBootstrapService: TMainBootstrapService | null = null;

  constructor(
    private readonly deps: MainInfrastructureRegistryDeps<
      TPersistentStoreLifecycleService,
      TMainBootstrapService
    >,
  ) {}

  getPersistentStoreLifecycleService(): TPersistentStoreLifecycleService {
    if (!this.persistentStoreLifecycleService) {
      this.persistentStoreLifecycleService = this.deps.createPersistentStoreLifecycleService();
    }
    return this.persistentStoreLifecycleService;
  }

  getMainBootstrapService(): TMainBootstrapService {
    if (!this.mainBootstrapService) {
      this.mainBootstrapService = this.deps.createMainBootstrapService();
    }
    return this.mainBootstrapService;
  }

  reset(): void {
    this.persistentStoreLifecycleService = null;
    this.mainBootstrapService = null;
  }
}
