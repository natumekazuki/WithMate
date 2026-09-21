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

// @test-value v2
// kind = "contract"
// claim = "model catalog subscriptionは初回snapshotと購読更新を順序通り反映する"
// oracle = { type = "contract", ref = "model catalog subscription" }
// fault = "初回取得または購読更新が欠落し古いcatalogを表示する"
// observable = "applied catalog snapshots and unsubscribe count"
// observation_boundary = "public-boundary"
// scope = "model-catalog-initial-and-update"
// lifecycle = "permanent"
// @end-test-value
test("startModelCatalogSubscription は初回取得と購読更新を反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  const control: { subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null } = { subscribedListener: null };
  let unsubscribeCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: async () => modelCatalogSnapshot,
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
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
  if (control.subscribedListener) control.subscribedListener(nextModelCatalogSnapshot);
  cleanup();
  if (control.subscribedListener) control.subscribedListener({ revision: 3, providers: [] });

  assert.deepEqual(updates, [
    modelCatalogSnapshot,
    nextModelCatalogSnapshot,
  ]);
  assert.equal(unsubscribeCount, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回取得は新しいcatalog revisionを巻き戻さない"
// oracle = { type = "contract", ref = "model catalog subscription ordering" }
// fault = "遅い初回取得が新しい購読snapshotを上書きする"
// observable = "applied snapshot sequence"
// observation_boundary = "public-boundary"
// scope = "model-catalog-stale-initial"
// lifecycle = "permanent"
// @end-test-value
test("startModelCatalogSubscription は購読更新後に遅い初回取得で古い revision へ戻さない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let resolveInitialSnapshot: (snapshot: ModelCatalogSnapshot | null) => void = () => undefined;
  const control: { subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null } = { subscribedListener: null };
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    }),
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  if (control.subscribedListener) control.subscribedListener(nextModelCatalogSnapshot);
  resolveInitialSnapshot(modelCatalogSnapshot);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    nextModelCatalogSnapshot,
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回nullは有効なcatalogを消去しない"
// oracle = { type = "contract", ref = "model catalog subscription ordering" }
// fault = "初回nullが購読済みcatalogを空状態へ戻す"
// observable = "applied catalog state after null initial result"
// observation_boundary = "public-boundary"
// scope = "model-catalog-null-initial"
// lifecycle = "permanent"
// @end-test-value
test("startModelCatalogSubscription は購読更新後に遅い初回 null で catalog を消さない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let resolveInitialSnapshot: (snapshot: ModelCatalogSnapshot | null) => void = () => undefined;
  const control: { subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null } = { subscribedListener: null };
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    }),
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  if (control.subscribedListener) control.subscribedListener(nextModelCatalogSnapshot);
  resolveInitialSnapshot(null);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    nextModelCatalogSnapshot,
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回取得失敗は新しいcatalogをfallbackへ戻さない"
// oracle = { type = "contract", ref = "model catalog subscription ordering" }
// fault = "初回取得失敗が購読済みsnapshotをfallbackで上書きする"
// observable = "applied catalog and fallback invocation count"
// observation_boundary = "public-boundary"
// scope = "model-catalog-failed-initial"
// lifecycle = "permanent"
// @end-test-value
test("startModelCatalogSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  let rejectInitialSnapshot: (error: Error) => void = () => undefined;
  const control: { subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null } = { subscribedListener: null };
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: () => new Promise((_, reject) => {
      rejectInitialSnapshot = reject;
    }),
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
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
  if (control.subscribedListener) control.subscribedListener(nextModelCatalogSnapshot);
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

test("Home は model catalog 初期取得と購読更新を helper に通す", async () => {
  const homeSource = await readFile(new URL("../../src/HomeApp.tsx", import.meta.url), "utf8");
  const homeSubscriptionIndex = homeSource.indexOf("startModelCatalogSubscription({");
  const subscriptionSnippet = homeSource.slice(homeSubscriptionIndex, homeSubscriptionIndex + 520);

  assert.notEqual(homeSubscriptionIndex, -1);
  assert.match(subscriptionSnippet, /subscribe: true/);
  assert.match(subscriptionSnippet, /setModelCatalogLoadSettled\(true\)/);
  assert.match(subscriptionSnippet, /setSettingsFeedback/);
  assert.doesNotMatch(homeSource, /withmateApi\.getModelCatalog\(null\),/);
});
