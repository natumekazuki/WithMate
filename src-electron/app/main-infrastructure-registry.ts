type MainInfrastructureRegistryDeps<TPersistentStoreLifecycleService, TAppLifecycleService, TMainBootstrapService> = {
  createPersistentStoreLifecycleService(): TPersistentStoreLifecycleService;
  createAppLifecycleService(): TAppLifecycleService;
  createMainBootstrapService(): TMainBootstrapService;
};

export class MainInfrastructureRegistry<
  TPersistentStoreLifecycleService,
  TAppLifecycleService,
  TMainBootstrapService,
> {
  private persistentStoreLifecycleService: TPersistentStoreLifecycleService | null = null;
  private appLifecycleService: TAppLifecycleService | null = null;
  private mainBootstrapService: TMainBootstrapService | null = null;

  constructor(
    private readonly deps: MainInfrastructureRegistryDeps<
      TPersistentStoreLifecycleService,
      TAppLifecycleService,
      TMainBootstrapService
    >,
  ) {}

  getPersistentStoreLifecycleService(): TPersistentStoreLifecycleService {
    if (!this.persistentStoreLifecycleService) {
      this.persistentStoreLifecycleService = this.deps.createPersistentStoreLifecycleService();
    }
    return this.persistentStoreLifecycleService;
  }

  getAppLifecycleService(): TAppLifecycleService {
    if (!this.appLifecycleService) {
      this.appLifecycleService = this.deps.createAppLifecycleService();
    }
    return this.appLifecycleService;
  }

  getMainBootstrapService(): TMainBootstrapService {
    if (!this.mainBootstrapService) {
      this.mainBootstrapService = this.deps.createMainBootstrapService();
    }
    return this.mainBootstrapService;
  }

  reset(): void {
    this.persistentStoreLifecycleService = null;
    this.appLifecycleService = null;
    this.mainBootstrapService = null;
  }
}
