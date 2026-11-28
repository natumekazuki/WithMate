import type { AppSettings } from "../../src-shared/settings/provider-settings-state.js";

/** 設定の変更購読と、対応する所有元でのみ使える初回取得。 */
export type AppSettingsSubscriptionApi = {
  getAppSettings?: () => Promise<AppSettings>;
  subscribeAppSettings: (
    listener: (settings: AppSettings) => void,
  ) => () => void;
};

/** 購読通知を優先し、初回取得が有効な場合も通知より遅い値やエラーで上書きしない。 */
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
    void input.api
      .getAppSettings()
      .then((settings) => {
        if (active && !receivedSubscriptionUpdate) {
          input.applyAppSettings(settings);
        }
      })
      .catch((error: unknown) => {
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
