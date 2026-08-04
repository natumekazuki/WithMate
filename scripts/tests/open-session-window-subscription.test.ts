import assert from "node:assert/strict";
import test from "node:test";

import {
  startOpenSessionWindowIdsSubscription,
  type OpenSessionWindowIdsState,
  type OpenSessionWindowIdsSubscriptionApi,
} from "../../src/open-session-window-subscription.js";

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

test("購読更新後の初回取得失敗は loaded state を error へ戻さない", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  let subscribedListener: ((sessionIds: string[]) => void) | null = null;
  let rejectList: (error: Error) => void = () => undefined;
  const api: OpenSessionWindowIdsSubscriptionApi = {
    listOpenSessionWindowIds: () => new Promise((_, reject) => {
      rejectList = reject;
    }),
    subscribeOpenSessionWindowIds: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    applyState: (state) => appliedStates.push(state),
  });
  subscribedListener?.(["session-current"]);
  rejectList(new Error("stale list failed"));
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedStates, [{ status: "loaded", sessionIds: ["session-current"] }]);
});

test("初回取得失敗後も購読更新で loaded state へ復帰する", async () => {
  const appliedStates: OpenSessionWindowIdsState[] = [];
  let subscribedListener: ((sessionIds: string[]) => void) | null = null;
  const api: OpenSessionWindowIdsSubscriptionApi = {
    listOpenSessionWindowIds: async () => {
      throw new Error("list failed");
    },
    subscribeOpenSessionWindowIds: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenSessionWindowIdsSubscription({
    api,
    applyState: (state) => appliedStates.push(state),
  });
  await flushPromises();
  subscribedListener?.(["session-recovered"]);
  cleanup();

  assert.deepEqual(appliedStates, [
    { status: "error", sessionIds: [] },
    { status: "loaded", sessionIds: ["session-recovered"] },
  ]);
});
