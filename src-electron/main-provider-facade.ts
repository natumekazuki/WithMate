import { DEFAULT_PROVIDER_ID, type ModelCatalogProvider, type ModelCatalogSnapshot } from "../src/model-catalog.js";
import type { ProviderBackgroundAdapter, ProviderCodingAdapter, ProviderTurnAdapter } from "./provider-runtime.js";
import {
  getProviderRuntimeCapabilities,
  resolveProviderBackgroundAdapter,
  resolveProviderCatalogOrThrow,
  resolveProviderCodingAdapter,
  type ProviderRuntimeCapabilities,
} from "./provider-support.js";

type MainProviderFacadeDeps = {
  getModelCatalog(revision?: number | null): ModelCatalogSnapshot | null;
  ensureModelCatalogSeeded(): ModelCatalogSnapshot;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
  revokeProviderExecution?(sessionId: string, providerId: string): void;
  revokeAllProviderExecutions?(): void;
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

  getProviderRuntimeCapabilities(providerId: string | null | undefined): ProviderRuntimeCapabilities {
    const resolvedProviderId = providerId?.trim() || DEFAULT_PROVIDER_ID;
    return getProviderRuntimeCapabilities({
      providerId: resolvedProviderId,
    });
  }

  async resetProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void> {
    await this.getProviderCodingAdapter(providerId).invalidateSessionThread(sessionId);
  }

  async invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void> {
    this.deps.revokeProviderExecution?.(sessionId, providerId?.trim() || DEFAULT_PROVIDER_ID);
    await this.getProviderCodingAdapter(providerId).invalidateSessionThread(sessionId);
  }

  async invalidateAllProviderSessionThreads(): Promise<void> {
    this.deps.revokeAllProviderExecutions?.();
    await Promise.all([
      this.deps.codexAdapter.invalidateAllSessionThreads(),
      this.deps.copilotAdapter.invalidateAllSessionThreads(),
    ]);
  }
}
