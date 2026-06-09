import type { ModelCatalogSnapshot } from "./model-catalog.js";

export type ModelCatalogSubscriptionApi = {
  getModelCatalog: (revision?: number | null) => Promise<ModelCatalogSnapshot | null>;
  subscribeModelCatalog?: (listener: (catalog: ModelCatalogSnapshot) => void) => () => void;
};

export function startModelCatalogSubscription(input: {
  api: ModelCatalogSubscriptionApi | null;
  enabled: boolean;
  subscribe: boolean;
  applyModelCatalog: (snapshot: ModelCatalogSnapshot | null) => void;
  onInitialLoadError?: (error: unknown) => void;
}): () => void {
  let active = true;
  let latestAppliedRevision: number | null = null;

  if (!input.api || !input.enabled) {
    return () => {
      active = false;
    };
  }

  const applyFreshSnapshot = (snapshot: ModelCatalogSnapshot | null): void => {
    if (!active) {
      return;
    }

    if (snapshot === null) {
      if (latestAppliedRevision !== null) {
        return;
      }
      input.applyModelCatalog(null);
      return;
    }

    if (latestAppliedRevision !== null && snapshot.revision < latestAppliedRevision) {
      return;
    }

    latestAppliedRevision = snapshot.revision;
    input.applyModelCatalog(snapshot);
  };

  void input.api.getModelCatalog(null).then((snapshot) => {
    applyFreshSnapshot(snapshot);
  }).catch((error: unknown) => {
    if (active && latestAppliedRevision === null) {
      input.onInitialLoadError?.(error);
    }
  });

  const unsubscribe = input.subscribe && input.api.subscribeModelCatalog
    ? input.api.subscribeModelCatalog((snapshot) => {
      applyFreshSnapshot(snapshot);
    })
    : null;

  return () => {
    active = false;
    unsubscribe?.();
  };
}
