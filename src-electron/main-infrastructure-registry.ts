type MainInfrastructureRegistryDeps<TWindowBroadcastService, TWindowDialogService, TWindowEntryLoader, TAuxWindowService, TPersistentStoreLifecycleService, TAppLifecycleService, TMainBootstrapService> = {
  createWindowBroadcastService(): TWindowBroadcastService;
  createWindowDialogService(): TWindowDialogService;
  createWindowEntryLoader(): TWindowEntryLoader;
  createAuxWindowService(): TAuxWindowService;
  createPersistentStoreLifecycleService(): TPersistentStoreLifecycleService;
  createAppLifecycleService(): TAppLifecycleService;
  createMainBootstrapService(): TMainBootstrapService;
};

export class MainInfrastructureRegistry<
  TWindowBroadcastService,
  TWindowDialogService,
  TWindowEntryLoader,
  TAuxWindowService,
  TPersistentStoreLifecycleService,
  TAppLifecycleService,
  TMainBootstrapService,
> {
  private windowBroadcastService: TWindowBroadcastService | null = null;
  private windowDialogService: TWindowDialogService | null = null;
  private windowEntryLoader: TWindowEntryLoader | null = null;
  private auxWindowService: TAuxWindowService | null = null;
  private persistentStoreLifecycleService: TPersistentStoreLifecycleService | null = null;
  private appLifecycleService: TAppLifecycleService | null = null;
  private mainBootstrapService: TMainBootstrapService | null = null;

  constructor(
    private readonly deps: MainInfrastructureRegistryDeps<
      TWindowBroadcastService,
      TWindowDialogService,
      TWindowEntryLoader,
      TAuxWindowService,
      TPersistentStoreLifecycleService,
      TAppLifecycleService,
      TMainBootstrapService
    >,
  ) {}

  getWindowBroadcastService(): TWindowBroadcastService {
    if (!this.windowBroadcastService) {
      this.windowBroadcastService = this.deps.createWindowBroadcastService();
    }
    return this.windowBroadcastService;
  }

  getWindowDialogService(): TWindowDialogService {
    if (!this.windowDialogService) {
      this.windowDialogService = this.deps.createWindowDialogService();
    }
    return this.windowDialogService;
  }

  getWindowEntryLoader(): TWindowEntryLoader {
    if (!this.windowEntryLoader) {
      this.windowEntryLoader = this.deps.createWindowEntryLoader();
    }
    return this.windowEntryLoader;
  }

  getAuxWindowService(): TAuxWindowService {
    if (!this.auxWindowService) {
      this.auxWindowService = this.deps.createAuxWindowService();
    }
    return this.auxWindowService;
  }

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
    this.windowBroadcastService = null;
    this.windowDialogService = null;
    this.windowEntryLoader = null;
    this.auxWindowService = null;
    this.persistentStoreLifecycleService = null;
    this.appLifecycleService = null;
    this.mainBootstrapService = null;
  }
}
