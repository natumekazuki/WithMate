import assert from "node:assert/strict";
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

/** 初回取得のPromiseが通知先へ反映されるようマイクロタスクの巡回を待つ。 */
const flushPromises = () =>
  new Promise<void>((resolve) => {
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
/** Windowsパスの表記差を同じ対象として扱い、別のワークスペースから届いた通知では候補を置き換えない。 */
test("workspace catalog は他workspaceの通知を無視し初回cacheと同workspaceの更新を反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  const requests: unknown[] = [];
  /** 初回取得が登録する完了処理を後で呼べるようにする。 */
  let resolveInitial: (snapshot: ModelCatalogSnapshot) => void = () =>
    undefined;
  const control: { listener?: (snapshot: ModelCatalogSnapshot) => void } = {};
  const cached: ModelCatalogSnapshot = {
    workspacePath: "c:\\PROJECT\\",
    providers: [],
    discovery: { codex: { status: "loading" } },
  };
  const refreshed: ModelCatalogSnapshot = {
    ...cached,
    workspacePath: "C:/Project/",
    discovery: { codex: { status: "ready" } },
  };
  const cleanup = startModelCatalogSubscription({
    api: {
      /** ワークスペース指定を控え、初回キャッシュの完了を保留する。 */
      getModelCatalog: (request) => {
        requests.push(request);
        return new Promise((resolve) => {
          resolveInitial = resolve;
        });
      },
      /** 購読のリスナーを取り出して、対象の異なる通知を手動で送れるようにする。 */
      subscribeModelCatalog: (listener) => {
        control.listener = listener;
        return () => undefined;
      },
    },
    enabled: true,
    subscribe: true,
    workspacePath: "C:/project",
    /** 現在のワークスペースへ反映されたスナップショットを順に記録する。 */
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
/** 初回応答でもワークスペースを照合し、別対象の応答ではなく同じ対象の通知だけを反映する。 */
test("別workspaceの初回snapshotを拒否し同workspace通知を受け取る", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  const control: { listener?: (snapshot: ModelCatalogSnapshot) => void } = {};
  const expected: ModelCatalogSnapshot = {
    workspacePath: "C:/Work/",
    providers: [],
  };
  const cleanup = startModelCatalogSubscription({
    api: {
      /** 要求されたものとは別のワークスペースに属するスナップショットを返す。 */
      getModelCatalog: async () => ({
        workspacePath: "C:/Other",
        providers: [],
      }),
      /** 要求対象と表記だけが異なる後続通知をテストから送れるようにする。 */
      subscribeModelCatalog: (listener) => {
        control.listener = listener;
        return () => undefined;
      },
    },
    enabled: true,
    subscribe: true,
    workspacePath: "c:/work",
    /** 不正な初回応答が反映された場合も検出できるよう記録する。 */
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  await flushPromises();
  assert.deepEqual(updates, []);
  control.listener?.(expected);
  cleanup();
  assert.deepEqual(updates, [expected]);
});

/** カタログAPIが未提供なら何も反映せず、後片付けを安全に呼べる。 */
test("startModelCatalogSubscription は api 不在なら no-op cleanup を返す", () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];

  const cleanup = startModelCatalogSubscription({
    api: null,
    enabled: true,
    subscribe: true,
    /** APIなしにもかかわらず投影が発生した場合に履歴へ残す。 */
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  cleanup();

  assert.deepEqual(updates, []);
});

/** 機能無効時は、取得と購読の両方を抑止する。 */
test("startModelCatalogSubscription は disabled なら fetch / subscribe しない", () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let getCallCount = 0;
  let subscribeCallCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    /** 無効時に初回取得が発生した場合に数える。 */
    getModelCatalog: async () => {
      getCallCount += 1;
      return modelCatalogSnapshot;
    },
    /** 無効時に購読が行われた場合に数える。 */
    subscribeModelCatalog: () => {
      subscribeCallCount += 1;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: false,
    subscribe: true,
    /** 無効時にカタログが適用された場合に記録する。 */
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
/** 初回キャッシュと購読通知を順番に反映し、後片付けで購読を一度解除する。 */
test("startModelCatalogSubscription は初回取得と購読更新を反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  const control: {
    subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null;
  } = { subscribedListener: null };
  let unsubscribeCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    /** 購読より先に適用される既知の初回一覧を返す。 */
    getModelCatalog: async () => modelCatalogSnapshot,
    /** 購読通知を手動で届けられるようにし、解除の回数も記録する。 */
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
    /** 初回一覧と更新後の一覧が適用された順序を保持する。 */
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  await flushPromises();
  if (control.subscribedListener)
    control.subscribedListener(nextModelCatalogSnapshot);
  cleanup();
  if (control.subscribedListener)
    control.subscribedListener({
      discovery: { codex: { status: "loading" } },
      providers: [],
    });

  assert.deepEqual(updates, [modelCatalogSnapshot, nextModelCatalogSnapshot]);
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
/** 購読で状態が進んだ後、遅れて取得した初回キャッシュで状態を古い値に戻さない。 */
test("startModelCatalogSubscription は購読更新後に遅い初回取得で古い状態へ戻さない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  /** 初回取得の解決時点を購読通知より後ろへずらせるようにする。 */
  let resolveInitialSnapshot: (
    snapshot: ModelCatalogSnapshot | null,
  ) => void = () => undefined;
  const control: {
    subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null;
  } = { subscribedListener: null };
  const api: ModelCatalogSubscriptionApi = {
    /** 購読更新が先に届くように初回取得を保留する。 */
    getModelCatalog: () =>
      new Promise((resolve) => {
        resolveInitialSnapshot = resolve;
      }),
    /** 初回取得より先に同じ購読へ複数の更新を配信できるようにする。 */
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    /** 読込中から取得済みへの投影順を記録する。 */
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  if (control.subscribedListener)
    control.subscribedListener(nextModelCatalogSnapshot);
  if (control.subscribedListener)
    control.subscribedListener(modelCatalogSnapshot);
  resolveInitialSnapshot({
    discovery: { codex: { status: "loading" } },
    providers: [],
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [nextModelCatalogSnapshot, modelCatalogSnapshot]);
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
/** 有効な購読通知の後に初回取得がnullを返しても、現在の候補を消去しない。 */
test("startModelCatalogSubscription は購読更新後に遅い初回 null で catalog を消さない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  /** 初回取得の空応答を、新しい一覧の反映後に送れるようにする。 */
  let resolveInitialSnapshot: (
    snapshot: ModelCatalogSnapshot | null,
  ) => void = () => undefined;
  const control: {
    subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null;
  } = { subscribedListener: null };
  const api: ModelCatalogSubscriptionApi = {
    /** nullを返す初回要求をテストの任意の時点まで保留する。 */
    getModelCatalog: () =>
      new Promise((resolve) => {
        resolveInitialSnapshot = resolve;
      }),
    /** 初回の空応答より先に有効なスナップショットを届けられるようにする。 */
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    /** 新しい一覧がnullで消されたかを値の履歴で確認する。 */
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  if (control.subscribedListener)
    control.subscribedListener(nextModelCatalogSnapshot);
  resolveInitialSnapshot(null);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [nextModelCatalogSnapshot]);
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
/** 購読更新後に古い初回取得が失敗しても、エラー時のフォールバックを実行しない。 */
test("startModelCatalogSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  /** 初回Promiseを任意の時点で拒否できるようにする。 */
  let rejectInitialSnapshot: (error: Error) => void = () => undefined;
  const control: {
    subscribedListener: ((snapshot: ModelCatalogSnapshot) => void) | null;
  } = { subscribedListener: null };
  const api: ModelCatalogSubscriptionApi = {
    /** 先に購読を進めるため、初回取得の失敗を保留する。 */
    getModelCatalog: () =>
      new Promise((_, reject) => {
        rejectInitialSnapshot = reject;
      }),
    /** 遅い初回取得とは独立に購読の更新を届ける。 */
    subscribeModelCatalog: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: true,
    /** このケースは一覧の値ではなく、初回エラー通知の発生有無を測る。 */
    applyModelCatalog: () => undefined,
    /** 古い初回取得の失敗でフォールバックが発生した場合に回数を数える。 */
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  if (control.subscribedListener)
    control.subscribedListener(nextModelCatalogSnapshot);
  rejectInitialSnapshot(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 0);
});

/** 購読だけを止めた状態では、初回取得を引き続き反映する。 */
test("startModelCatalogSubscription は subscribe 無効なら初回取得だけ反映する", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  let subscribeCallCount = 0;
  const api: ModelCatalogSubscriptionApi = {
    /** 購読無効時にも受け取れる初回スナップショットを返す。 */
    getModelCatalog: async () => modelCatalogSnapshot,
    /** 購読が誤って登録された場合に回数を数える。 */
    subscribeModelCatalog: () => {
      subscribeCallCount += 1;
      return () => undefined;
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    /** 購読なしで適用された初回一覧を控える。 */
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
/** 購読更新で置き換えられていない初回取得が失敗したら、失敗理由をフォールバックに伝える。 */
test("startModelCatalogSubscription は初回取得失敗時に fallback callback を呼ぶ", async () => {
  let errorCount = 0;
  let receivedError: unknown;
  const api: ModelCatalogSubscriptionApi = {
    /** 初回取得を失敗させ、理由がそのまま渡るか確認できるようにする。 */
    getModelCatalog: async () => {
      throw new Error("failed");
    },
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    /** 正常な一覧を適用する経路とは切り離して、エラーの通知を追う。 */
    applyModelCatalog: () => undefined,
    /** 初回取得のエラー原文と通知回数を記録する。 */
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

/** 後片付けが済んだ呼び出しには、後から完了した初回応答を適用しない。 */
test("startModelCatalogSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: Array<ModelCatalogSnapshot | null> = [];
  /** 初回応答を後片付けより遅く返せるようにする。 */
  let resolveSnapshot: (snapshot: ModelCatalogSnapshot | null) => void = () =>
    undefined;
  const api: ModelCatalogSubscriptionApi = {
    /** テストが後片付けを呼ぶまでスナップショットの取得を保留する。 */
    getModelCatalog: () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
  };

  const cleanup = startModelCatalogSubscription({
    api,
    enabled: true,
    subscribe: false,
    /** 解除済みの投影に遅延応答が適用された場合に履歴へ残す。 */
    applyModelCatalog: (snapshot) => updates.push(snapshot),
  });
  cleanup();
  resolveSnapshot(modelCatalogSnapshot);
  await flushPromises();

  assert.deepEqual(updates, []);
});
