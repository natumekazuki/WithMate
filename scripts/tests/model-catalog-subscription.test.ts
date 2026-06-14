import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import {
  startModelCatalogSubscription,
  type ModelCatalogSubscriptionApi,
} from "../../src/model-catalog-subscription.js";

const modelCatalogSnapshot: ModelCatalogSnapshot = {
  revision: 1,
  providers: [],
};

const nextModelCatalogSnapshot: ModelCatalogSnapshot = {
  revision: 2,
  providers: [],
};

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("startModelCatalogSubscription は api 不在なら no-op cleanup を返す", () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];

  const cleanup = startModelCatalogSubscription({
    api: null,
    enabled: true,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  cleanup();

  assert.deepEqual(updates, []);
});

test("startModelCatalogSubscription は disabled なら fetch / subscribe しない", () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let getCallCount = 0;
  let subscribeCallCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: async () => {
      getCallCount += 1;
      return modelCatalogSnapshot;
    },
    subscribeModelCatalog: () => {
      subscribeCallCount += 1;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: false,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  cleanup();

  assert.equal(getCallCount, 0);
  assert.equal(subscribeCallCount, 0);
  assert.deepEqual(updates, []);
});

test("startModelCatalogSubscription は初回取得と購読更新を反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null = null;
  let unsubscribeCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: async () => modelCatalogSnapshot,
    subscribeModelCatalog: (listener) => {
      subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  await flushPromises();
  subscribedListener?.(nextModelCatalogSnapshot);
  cleanup();
  subscribedListener?.({ revision: 3, providers: [] });

  assert.deepEqual(updates, [
    modelCatalogSnapshot,
    nextModelCatalogSnapshot,
  ]);
  assert.equal(unsubscribeCount, 1);
});

test("startModelCatalogSubscription は購読更新後に遅い初回取得で古い revision へ戻さない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let resolveInitialSnapshot: (snapshot: ModelCatalogSnapshot | null) => void = () => undefined;
  let subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null = null;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    }),
    subscribeModelCatalog: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  subscribedListener?.(nextModelCatalogSnapshot);
  resolveInitialSnapshot(modelCatalogSnapshot);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    nextModelCatalogSnapshot,
  ]);
});

test("startModelCatalogSubscription は購読更新後に遅い初回 null で catalog を消さない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let resolveInitialSnapshot: (snapshot: ModelCatalogSnapshot | null) => void = () => undefined;
  let subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null = null;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    }),
    subscribeModelCatalog: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  subscribedListener?.(nextModelCatalogSnapshot);
  resolveInitialSnapshot(null);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    nextModelCatalogSnapshot,
  ]);
});

test("startModelCatalogSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  let rejectInitialSnapshot: (error: Error) => void = () => undefined;
  let subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null = null;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((_, reject) => {
      rejectInitialSnapshot = reject;
    }),
    subscribeModelCatalog: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    applyModelCatalog: () => undefined,
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  subscribedListener?.(nextModelCatalogSnapshot);
  rejectInitialSnapshot(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 0);
});

test("startModelCatalogSubscription は subscribe 無効なら初回取得だけ反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let subscribeCallCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: async () => modelCatalogSnapshot,
    subscribeModelCatalog: () => {
      subscribeCallCount += 1;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  await flushPromises();
  cleanup();

  assert.equal(subscribeCallCount, 0);
  assert.deepEqual(updates, [modelCatalogSnapshot]);
});

test("startModelCatalogSubscription は初回取得失敗時に fallback callback を呼ぶ", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let errorCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: async () => {
      throw new Error("failed");
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
    onInitialLoadError: () => {
      errorCount += 1;
      updates.push(null);
    },
  });
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 1);
  assert.deepEqual(updates, [null]);
});

test("startModelCatalogSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let resolveSnapshot: (snapshot: ModelCatalogSnapshot | null) => void = () => undefined;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }),
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  cleanup();
  resolveSnapshot(modelCatalogSnapshot);
  await flushPromises();

  assert.deepEqual(updates, []);
});

test("App は model catalog subscription を有効にする", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startModelCatalogSubscription({");

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(subscriptionIndex, subscriptionIndex + 220),
    /subscribe: true/,
  );
});

test("CompanionReview は merge view で model catalog load を無効にし、失敗時は null fallback にする", async () => {
  const source = await readFile(new URL("../../src/CompanionReviewApp.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startModelCatalogSubscription({");
  const snippet = source.slice(subscriptionIndex, subscriptionIndex + 320);

  assert.notEqual(subscriptionIndex, -1);
  assert.match(snippet, /enabled: !isMergeView/);
  assert.match(snippet, /subscribe: false/);
  assert.match(snippet, /onInitialLoadError: \(\) => setModelCatalog\(null\)/);
});

test("Home は model catalog 初期取得と購読更新を helper に通す", async () => {
  const homeSource = await readFile(new URL("../../src/HomeApp.tsx", import.meta.url), "utf8");
  const homeSubscriptionIndex = homeSource.indexOf("startModelCatalogSubscription({");

  assert.notEqual(homeSubscriptionIndex, -1);
  assert.match(
    homeSource.slice(homeSubscriptionIndex, homeSubscriptionIndex + 260),
    /subscribe: true/,
  );
  assert.doesNotMatch(homeSource, /withmateApi\.getModelCatalog\(null\),/);
});
