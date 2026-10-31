import assert from "node:assert/strict";
import test from "node:test";

import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
  type OpenSessionWindowIdsSubscriptionApi,
} from "../../src/app/open-session-window-subscription.js";

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("open Session Window 一覧の初回取得成功を loaded として反映する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const api: OpenSessionWindowIdsSubscriptionApi = {
    listOpenSessionWindowIds: async () => ["session-1"],
    subscribeOpenSessionWindowIds: () => () => undefined,
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [{ status: "loaded", sessionIds: ["session-1"] }]);
});

test("open Session Window 一覧の初回取得失敗を error として反映する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const api: OpenSessionWindowIdsSubscriptionApi = {
    listOpenSessionWindowIds: async () => {
      throw new Error("list failed");
    },
    subscribeOpenSessionWindowIds: () => () => undefined,
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [{ status: "error", sessionIds: [] }]);
});

// @test-value v2
// kind = "invariant"
// claim = "購読更新後の遅い初回取得失敗はloaded stateをerrorへ巻き戻さない"
// oracle = { type = "contract", ref = "open session window subscription ordering" }
// fault = "初回取得失敗が購読で受け取ったsession idsを消す"
// observable = "applied open-window states"
// observation_boundary = "public-boundary"
// scope = "open-session-window-stale-error"
// lifecycle = "permanent"
// @end-test-value
test("購読更新後の初回取得失敗は loaded state を error へ戻さない", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const control: { subscribedListener: ((sessionIds: string[]) => void) | null } = { subscribedListener: null };
  let rejectList: (error: Error) => void = () => undefined;
  const api: OpenSessionWindowIdsSubscriptionApi = {
    listOpenSessionWindowIds: () => new Promise((_, reject) => {
      rejectList = reject;
    }),
    subscribeOpenSessionWindowIds: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    applyState: (state) => appliedStates.push(state),
  });
  if (control.subscribedListener) control.subscribedListener(["session-current"]);
  rejectList(new Error("stale list failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [{ status: "loaded", sessionIds: ["session-current"] }]);
});

// @test-value v2
// kind = "contract"
// claim = "初回取得失敗後の購読更新はloaded stateへ復帰させる"
// oracle = { type = "contract", ref = "open session window subscription recovery" }
// fault = "取得失敗後に有効な購読更新を無視しerror表示を維持する"
// observable = "recovered state and session ids"
// observation_boundary = "public-boundary"
// scope = "open-session-window-recovery"
// lifecycle = "permanent"
// @end-test-value
test("初回取得失敗後も購読更新で loaded state へ復帰する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  const control: { subscribedListener: ((sessionIds: string[]) => void) | null } = { subscribedListener: null };
  const api: OpenSessionWindowIdsSubscriptionApi = {
    listOpenSessionWindowIds: async () => {
      throw new Error("list failed");
    },
    subscribeOpenSessionWindowIds: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  if (control.subscribedListener) control.subscribedListener(["session-recovered"]);
  cleanup();

  assert.deepEqual(appliedStates, [
    { status: "error", sessionIds: [] },
    { status: "loaded", sessionIds: ["session-recovered"] },
  ]);
});
