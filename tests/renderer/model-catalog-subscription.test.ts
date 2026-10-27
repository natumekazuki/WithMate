import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  startModelCatalogSubscription,
  type ModelCatalogSubscriptionApi,
} from "../../src/settings/model-catalog-subscription.js";

const modelCatalogSnapshot: ModelCatalogSnapshot = {
  discovery: { codex: { status: "idle" } },
  providers: [],
};

const nextModelCatalogSnapshot: ModelCatalogSnapshot = {
  discovery: { codex: { status: "ready" } },
  providers: [],
};

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

// @test-value v2
// kind = "contract"
// claim = "Sessionのworkspaceを要求しWindowsのslash・case・末尾区切り差を同一視し、別workspaceの通知は候補を上書きしない"
// oracle = { type = "contract", ref = "Issue #879 workspace-scoped model discovery" }
// fault = "path表記差のある同一workspaceを拒否する、または別workspace通知を反映し初回結果を破棄する"
// observable = "getModelCatalog requestとapplyModelCatalogへ渡されたsnapshot"
// observation_boundary = "public-boundary"
// scope = "workspace-scoped model catalog subscription"
// lifecycle = "permanent"
// impact = "他workspaceの認証・設定に基づくモデル候補がSessionへ混入する"
// distinction = "型検査ではworkspaceの実行時照合と通知・初回結果の競合を検出できない"
// @end-test-value
test("workspace catalog は他workspaceの通知を無視し初回cacheと同workspaceの更新を反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  const requests: unknown[] = [];
  let resolveInitial: (snapshot: ModelCatalogSnapshot) => void = () => undefined;
  const control: { listener?: (snapshot: ModelCatalogSnapshot) => void } = {};
  const cached: ModelCatalogSnapshot = { workspacePath: "c:\\PROJECT\\", providers: [], discovery: { codex: { status: "loading" } } };
  const refreshed: ModelCatalogSnapshot = { ...cached, workspacePath: "C:/Project/", discovery: { codex: { status: "ready" } } };
  const cleanup = startModelCatalogSubscription({
    api: {
      getModelCatalog: (request) => {
        requests.push(request);
        return new Promise((resolve) => { resolveInitial = resolve; });
      },
      subscribeModelCatalog: (listener) => {
        control.listener = listener;
        return () => undefined;
      },
    },
    enabled: true,
    subscribe: true,
    workspacePath: "C:/project",
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  control.listener?.({ ...refreshed, workspacePath: "C:/other" });
  resolveInitial(cached);
  await flushPromises();
  control.listener?.(refreshed);
  cleanup();
  assert.deepEqual(requests, [{ workspacePath: "C:/project" }]);
  assert.deepEqual(updates, [cached, refreshed]);
});

// @test-value v2
// kind = "contract"
// claim = "workspace指定の初回応答もcontextを照合し、別workspaceのsnapshotは反映しない"
// oracle = { type = "contract", ref = "Issue #879 workspace-scoped model discovery" }
// fault = "初回応答だけworkspace照合を省略し別contextの候補を表示する"
// observable = "初回応答と同workspace通知後にapplyModelCatalogへ渡るsnapshot列"
// observation_boundary = "public-boundary"
// scope = "initial model catalog workspace boundary"
// lifecycle = "permanent"
// impact = "別workspaceの認証・設定から得た候補が現在のSessionへ混入する"
// distinction = "通知filterだけでは初回応答のcontext誤りを検出できない"
// @end-test-value
test("別workspaceの初回snapshotを拒否し同workspace通知を受け取る", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  const control: { listener?: (snapshot: ModelCatalogSnapshot) => void } = {};
  const expected: ModelCatalogSnapshot = { workspacePath: "C:/Work/", providers: [] };
  const cleanup = startModelCatalogSubscription({
    api: {
      getModelCatalog: async () => ({ workspacePath: "C:/Other", providers: [] }),
      subscribeModelCatalog: (listener) => {
        control.listener = listener;
        return () => undefined;
      },
    },
    enabled: true, subscribe: true, workspacePath: "c:/work",
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  await flushPromises();
  assert.deepEqual(updates, []);
  control.listener?.(expected);
  cleanup();
  assert.deepEqual(updates, [expected]);
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
// oracle = { type = "contract", ref = "src/settings/model-catalog-subscription.ts" }
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
  if (control.subscribedListener) control.subscribedListener({ discovery: { codex: { status: "loading" } }, providers: [] });

  assert.deepEqual(updates, [
    modelCatalogSnapshot,
    nextModelCatalogSnapshot,
  ]);
  assert.equal(unsubscribeCount, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "購読したsnapshotは状態遷移を反映し、遅い初回取得で上書きしない"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#cacheと更新" }
// fault = "遅い初回取得が購読済snapshotを上書きする"
// observable = "applied snapshot sequence"
// observation_boundary = "public-boundary"
// scope = "model-catalog-stale-initial"
// lifecycle = "permanent"
// @end-test-value
test("startModelCatalogSubscription は購読更新後に遅い初回取得で古い状態へ戻さない", async () => {
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
  if (control.subscribedListener) control.subscribedListener(modelCatalogSnapshot);
  resolveInitialSnapshot({ discovery: { codex: { status: "loading" } }, providers: [] });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    nextModelCatalogSnapshot,
    modelCatalogSnapshot,
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回nullは有効なcatalogを消去しない"
// oracle = { type = "contract", ref = "src/settings/model-catalog-subscription.ts" }
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
// oracle = { type = "contract", ref = "src/settings/model-catalog-subscription.ts" }
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

// @test-value v2
// kind = "contract"
// claim = "model catalogの初回取得失敗はfallback error callbackへ通知する"
// oracle = { type = "contract", ref = "src/settings/model-catalog-subscription.ts" }
// fault = "初回取得失敗を握り潰し、fallback処理へ通知しない"
// observable = "initial load error callback count and error"
// observation_boundary = "public-boundary"
// scope = "model-catalog-initial-load-error"
// lifecycle = "permanent"
// @end-test-value
test("startModelCatalogSubscription は初回取得失敗時に fallback callback を呼ぶ", async () => {
  let errorCount = 0;
  let receivedError: unknown;
  const api: ModelCatalogSubscriptionApi = {
    getModelCatalog: async () => {
      throw new Error("failed");
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    applyModelCatalog: () => undefined,
    onInitialLoadError: (error) => {
      errorCount += 1;
      receivedError = error;
    },
  });
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 1);
  assert.ok(receivedError instanceof Error);
  assert.equal((receivedError as Error).message, "failed");
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

// @test-value v2
// kind = "contract"
// claim = "Session Window Appはmodel catalogの購読を有効化してprovider model更新を受け取る"
// oracle = { type = "contract", ref = "src/app/SessionWindowApp.tsx model catalog subscription" }
// fault = "Appがmodel catalog subscriptionを無効化し、初回snapshot後の更新を反映しない"
// observable = "SessionWindowApp source内のstartModelCatalogSubscription呼び出しとsubscribe設定"
// observation_boundary = "declaration"
// scope = "model-catalog-subscription SessionWindowApp integration"
// lifecycle = "permanent"
// @end-test-value
test("App は model catalog subscription を有効にする", async () => {
  const source = await readFile(new URL("../../src/app/SessionWindowApp.tsx", import.meta.url), "utf8");
  const subscriptionIndex = source.indexOf("startModelCatalogSubscription({");

  assert.notEqual(subscriptionIndex, -1);
  assert.match(
    source.slice(subscriptionIndex, subscriptionIndex + 320),
    /subscribe: true/,
  );
});
