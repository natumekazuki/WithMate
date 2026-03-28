import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../src/model-catalog.js";
import type {
  ProviderBackgroundAdapter,
  ProviderCodingAdapter,
  ProviderTurnAdapter,
} from "./provider-runtime.js";
import {
  resolveProviderBackgroundAdapter,
  resolveProviderCatalogOrThrow,
  resolveProviderCodingAdapter,
  resolveProviderTurnAdapter,
} from "./provider-support.js";

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

  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter {
    return resolveProviderCodingAdapter({
      providerId,
      codexAdapter: this.deps.codexAdapter,
      copilotAdapter: this.deps.copilotAdapter,
    });
  }

  getProviderBackgroundAdapter(providerId: string | null | undefined): ProviderBackgroundAdapter {
    return resolveProviderBackgroundAdapter({
      providerId,
      codexAdapter: this.deps.codexAdapter,
      copilotAdapter: this.deps.copilotAdapter,
    });
  }

  invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): void {
    this.getProviderCodingAdapter(providerId).invalidateSessionThread(sessionId);
  }

  invalidateAllProviderSessionThreads(): void {
    this.deps.codexAdapter.invalidateAllSessionThreads();
    this.deps.copilotAdapter.invalidateAllSessionThreads();
  }
}
