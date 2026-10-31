import type { ModelCatalogRequest, ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

export type ModelCatalogSubscriptionApi = {
  getModelCatalog: (request?: ModelCatalogRequest) => Promise<ModelCatalogSnapshot | null>;
  subscribeModelCatalog?: (listener: (catalog: ModelCatalogSnapshot) => void) => () => void;
};

export function isSameModelCatalogWorkspace(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return left === right;
  const key = (workspacePath: string) => {
    const windowsPath = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(workspacePath);
    const normalized = (windowsPath ? workspacePath.replace(/\\/g, "/") : workspacePath).replace(/\/+$/, "");
    return windowsPath ? normalized.toLowerCase() : normalized;
  };
  return key(left) === key(right);
}

export function startModelCatalogSubscription(input: {
  api: ModelCatalogSubscriptionApi | null;
  enabled: boolean;
  subscribe: boolean;
  workspacePath?: string;
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

  void input.api.getModelCatalog(input.workspacePath ? { workspacePath: input.workspacePath } : undefined).then((snapshot) => {
    if (snapshot && input.workspacePath && !isSameModelCatalogWorkspace(snapshot.workspacePath, input.workspacePath)) return;
    if (active && !receivedNotification) input.applyModelCatalog(snapshot);
  }).catch((error: unknown) => {
    if (active && !receivedNotification) {
      input.onInitialLoadError?.(error);
    }
  });

  const unsubscribe = input.subscribe && input.api.subscribeModelCatalog
    ? input.api.subscribeModelCatalog((snapshot) => {
      if (!active) return;
      if (input.workspacePath && !isSameModelCatalogWorkspace(snapshot.workspacePath, input.workspacePath)) return;
      receivedNotification = true;
      input.applyModelCatalog(snapshot);
    })
    : null;

  return () => {
    active = false;
    unsubscribe?.();
  };
}
