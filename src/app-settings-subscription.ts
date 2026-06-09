import type { AppSettings } from "./provider-settings-state.js";

export type AppSettingsSubscriptionApi = {
  getAppSettings?: () => Promise<AppSettings>;
  subscribeAppSettings: (listener: (settings: AppSettings) => void) => () => void;
};

export function startAppSettingsSubscription(input: {
  api: AppSettingsSubscriptionApi | null;
  loadInitial: boolean;
  applyAppSettings: (settings: AppSettings) => void;
  onInitialLoadError?: (error: unknown) => void;
}): () => void {
  let active = true;
  let receivedSubscriptionUpdate = false;

  if (!input.api) {
    return () => {
      active = false;
    };
  }

  if (input.loadInitial && input.api.getAppSettings) {
    void input.api.getAppSettings().then((settings) => {
      if (active && !receivedSubscriptionUpdate) {
        input.applyAppSettings(settings);
      }
    }).catch((error: unknown) => {
      if (active && !receivedSubscriptionUpdate) {
        input.onInitialLoadError?.(error);
      }
    });
  }

  const unsubscribe = input.api.subscribeAppSettings((settings) => {
    receivedSubscriptionUpdate = true;
    if (active) {
      input.applyAppSettings(settings);
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}
