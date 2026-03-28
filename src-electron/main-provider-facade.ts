import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { ProviderTurnAdapter } from "./provider-runtime.js";
import { resolveProviderCatalogOrThrow, resolveProviderTurnAdapter } from "./provider-support.js";

type MainProviderFacadeDeps = {
  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null;
  ensureModelCatalogSeeded(): ModelCatalogSnapshot;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
};

export class MainProviderFacade {
  constructor(private readonly deps: MainProviderFacadeDeps) {}

  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null {
    return this.deps.getModelCatalog(revision);
  }

  resolveProviderCatalog(
    providerId: string | null | undefined,
    revision?: number | null,
  ): { snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider } {
    return resolveProviderCatalogOrThrow({
      providerId,
      revision,
      getModelCatalog: (nextRevision) => this.getModelCatalog(nextRevision),
      ensureSeeded: () => this.deps.ensureModelCatalogSeeded(),
    });
  }

  getProviderAdapter(providerId: string | null | undefined): ProviderTurnAdapter {
    return resolveProviderTurnAdapter({
      providerId,
      codexAdapter: this.deps.codexAdapter,
      copilotAdapter: this.deps.copilotAdapter,
    });
  }

  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void {
    this.getProviderAdapter(providerId).invalidateSessionThread(sessionId);
  }

  invalidateAllProviderSessionThreads(): void {
    this.deps.codexAdapter.invalidateAllSessionThreads();
    this.deps.copilotAdapter.invalidateAllSessionThreads();
  }
}
