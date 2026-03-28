import type { ModelCatalogSnapshot } from "../src/model-catalog.js";

type MainBootstrapServiceDeps = {
  initializePersistentStores(): Promise<ModelCatalogSnapshot>;
  recoverInterruptedSessions(): void;
  refreshCharactersFromStorage(): Promise<void>;
  registerIpcHandlers(): void;
  createHomeWindow(): Promise<void>;
  broadcastModelCatalog(snapshot: ModelCatalogSnapshot): void;
};

export class MainBootstrapService {
  constructor(private readonly deps: MainBootstrapServiceDeps) {}

  async handleReady(): Promise<void> {
    const activeModelCatalog = await this.deps.initializePersistentStores();
    this.deps.recoverInterruptedSessions();
    await this.deps.refreshCharactersFromStorage();
    this.deps.registerIpcHandlers();
    await this.deps.createHomeWindow();
    this.deps.broadcastModelCatalog(activeModelCatalog);
  }
}
