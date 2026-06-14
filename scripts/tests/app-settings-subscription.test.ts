import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  startAppSettingsSubscription,
  type AppSettingsSubscriptionApi,
} from "../../src/app-settings-subscription.js";
import { createDefaultAppSettings, type AppSettings } from "../../src/provider-settings-state.js";

const appSettings: AppSettings = createDefaultAppSettings();
const nextAppSettings: AppSettings = {
  ...createDefaultAppSettings(),
  autoCollapseActionDockOnSend: false,
};

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("startAppSettingsSubscription は api 不在なら no-op cleanup を返す", () => {
  const updates: AppSettings[] = [];

  const cleanup = startAppSettingsSubscription({
    api: null,
    loadInitial: true,
    applyAppSettings: (settings) => updates.push(settings),
  });
  cleanup();

  assert.deepEqual(updates, []);
});

test("startAppSettingsSubscription は初回取得と購読更新を反映する", async () => {
  const updates: AppSettings[] = [];
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  let unsubscribeCount = 0;
  const api: AppSettingsSubscriptionApi = {
    getAppSettings: async () => appSettings,
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    applyAppSettings: (settings) => updates.push(settings),
  });
  await flushPromises();
  subscribedListener?.(nextAppSettings);
  cleanup();
  subscribedListener?.(appSettings);

  assert.deepEqual(updates, [
    appSettings,
    nextAppSettings,
  ]);
  assert.equal(unsubscribeCount, 1);
});

test("startAppSettingsSubscription は購読更新後に遅い初回取得で古い settings へ戻さない", async () => {
  const updates: AppSettings[] = [];
  let resolveInitialSettings: (settings: AppSettings) => void = () => undefined;
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  const api: AppSettingsSubscriptionApi = {
    getAppSettings: () => new Promise((resolve) => {
      resolveInitialSettings = resolve;
    }),
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    applyAppSettings: (settings) => updates.push(settings),
  });
  subscribedListener?.(nextAppSettings);
  resolveInitialSettings(appSettings);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    nextAppSettings,
  ]);
});

test("startAppSettingsSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  let rejectInitialSettings: (error: Error) => void = () => undefined;
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  const api: AppSettingsSubscriptionApi = {
    getAppSettings: () => new Promise((_, reject) => {
      rejectInitialSettings = reject;
    }),
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    applyAppSettings: () => undefined,
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  subscribedListener?.(nextAppSettings);
  rejectInitialSettings(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 0);
});

test("startAppSettingsSubscription は loadInitial 無効なら購読更新だけ反映する", async () => {
  const updates: AppSettings[] = [];
  let getCallCount = 0;
  let subscribedListener: ((settings: AppSettings) => void) | null = null;
  const api: AppSettingsSubscriptionApi = {
    getAppSettings: async () => {
      getCallCount += 1;
      return appSettings;
    },
    subscribeAppSettings: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: false,
    applyAppSettings: (settings) => updates.push(settings),
  });
  await flushPromises();
  subscribedListener?.(nextAppSettings);
  cleanup();

  assert.equal(getCallCount, 0);
  assert.deepEqual(updates, [nextAppSettings]);
});

test("startAppSettingsSubscription は初回取得失敗時に fallback callback を呼ぶ", async () => {
  let errorCount = 0;
  const api: AppSettingsSubscriptionApi = {
    getAppSettings: async () => {
      throw new Error("failed");
    },
    subscribeAppSettings: () => () => undefined,
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    applyAppSettings: () => undefined,
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 1);
});

test("startAppSettingsSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: AppSettings[] = [];
  let resolveSettings: (settings: AppSettings) => void = () => undefined;
  const api: AppSettingsSubscriptionApi = {
    getAppSettings: () => new Promise((resolve) => {
      resolveSettings = resolve;
    }),
    subscribeAppSettings: () => () => undefined,
  };

  const cleanup = startAppSettingsSubscription({
    api,
    loadInitial: true,
    applyAppSettings: (settings) => updates.push(settings),
  });
  cleanup();
  resolveSettings(appSettings);
  await flushPromises();

  assert.deepEqual(updates, []);
});

test("App は app settings の初回取得と購読更新を helper に通す", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startAppSettingsSubscription({");
  const snippet = source.slice(subscriptionIndex, subscriptionIndex + 220);

  assert.notEqual(subscriptionIndex, -1);
  assert.match(snippet, /loadInitial: true/);
});

test("Home は app settings 初期取得と購読更新を helper に通す", async () => {
  const homeSource = await readFile(new URL("../../src/HomeApp.tsx", import.meta.url), "utf8");

  assert.match(
    homeSource.slice(homeSource.indexOf("startAppSettingsSubscription({"), homeSource.indexOf("startAppSettingsSubscription({") + 220),
    /loadInitial: true/,
  );
  assert.doesNotMatch(homeSource, /withmateApi\.getAppSettings\(\),/);
});
