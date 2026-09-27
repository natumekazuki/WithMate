import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

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
  let receivedNotification = false;

  if (!input.api || !input.enabled) {
    return () => {
      active = false;
    };
  }

  void input.api.getModelCatalog(null).then((snapshot) => {
    if (active && !receivedNotification) input.applyModelCatalog(snapshot);
  }).catch((error: unknown) => {
    if (active && !receivedNotification) {
      input.onInitialLoadError?.(error);
    }
  });

  const unsubscribe = input.subscribe && input.api.subscribeModelCatalog
    ? input.api.subscribeModelCatalog((snapshot) => {
      if (!active) return;
      // Reset can restart revision numbering; notifications supersede the initial read.
      receivedNotification = true;
      input.applyModelCatalog(snapshot);
    })
    : null;

  return () => {
    active = false;
    unsubscribe?.();
  };
}
