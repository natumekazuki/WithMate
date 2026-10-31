import { DEFAULT_PROVIDER_ID, type ModelCatalogProvider, type ModelCatalogRequest, type ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { ProviderCodingAdapter, ProviderTurnAdapter } from "../providers/provider-runtime.js";
import { getProviderRuntimeCapabilities, resolveProviderCatalogOrThrow, resolveProviderCodingAdapter, type ProviderRuntimeCapabilities } from "../providers/provider-support.js";
import type { Awaitable } from "../storage/persistent-store-lifecycle-service.js";

type MainProviderFacadeDeps = {
  getModelCatalog(request?: ModelCatalogRequest): Awaitable<ModelCatalogSnapshot>;
  codexAdapter: ProviderTurnAdapter;
  copilotAdapter: ProviderTurnAdapter;
  claudeAdapter: ProviderTurnAdapter;
  opencodeAdapter: ProviderTurnAdapter;
  revokeProviderExecution?(sessionId: string, providerId: string): void;
  revokeAllProviderExecutions?(): void;
};

export class MainProviderFacade {
  constructor(private readonly deps: MainProviderFacadeDeps) {}

  async getModelCatalog(request?: ModelCatalogRequest): Promise<ModelCatalogSnapshot> {
    return this.deps.getModelCatalog(request);
  }

  resolveProviderCatalog(
    providerId: string | null | undefined,
    workspacePath?: string,
  ): Promise<{ snapshot: ModelCatalogSnapshot; provider: ModelCatalogProvider }> {
    return resolveProviderCatalogOrThrow({
      providerId,
      getModelCatalog: () => this.deps.getModelCatalog({ ...(providerId ? { providerId } : {}), ...(workspacePath ? { workspacePath } : {}) }),
    });
  }

  getProviderCodingAdapter(providerId: string | null | undefined): ProviderCodingAdapter {
    return resolveProviderCodingAdapter({
      providerId,
      codexAdapter: this.deps.codexAdapter,
      copilotAdapter: this.deps.copilotAdapter,
      claudeAdapter: this.deps.claudeAdapter,
      opencodeAdapter: this.deps.opencodeAdapter,
    });
  }


  getProviderRuntimeCapabilities(providerId: string | null | undefined): ProviderRuntimeCapabilities {
    const resolvedProviderId = providerId ?? DEFAULT_PROVIDER_ID;
    return getProviderRuntimeCapabilities({
      providerId: resolvedProviderId,
    });
  }

  async resetProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void> {
    await this.getProviderCodingAdapter(providerId).invalidateSessionThread(sessionId);
  }

  async invalidateProviderSessionThread(providerId: string | null | undefined, sessionId: string): Promise<void> {
    this.deps.revokeProviderExecution?.(sessionId, providerId ?? DEFAULT_PROVIDER_ID);
    await this.getProviderCodingAdapter(providerId).invalidateSessionThread(sessionId);
  }

  async invalidateAllProviderSessionThreads(): Promise<void> {
    this.deps.revokeAllProviderExecutions?.();
    await Promise.all([
      this.deps.codexAdapter.invalidateAllSessionThreads(),
      this.deps.copilotAdapter.invalidateAllSessionThreads(),
      this.deps.claudeAdapter.invalidateAllSessionThreads(),
      this.deps.opencodeAdapter.invalidateAllSessionThreads(),
    ]);
  }
}
