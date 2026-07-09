import assert from "node:assert/strict";
import test from "node:test";

import {
  startOpenCompanionReviewWindowIdsSubscription,
  type OpenCompanionReviewWindowIdsSubscriptionApi,
} from "../../src/open-companion-review-window-subscription.js";

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("startOpenCompanionReviewWindowIdsSubscription は api がない場合 no-op cleanup を返す", () => {
  const appliedSessionIds: string[][] = [];

  const cleanup = startOpenCompanionReviewWindowIdsSubscription({
    api: null,
    applyOpenWindowIds: (sessionIds) => appliedSessionIds.push(sessionIds),
  });
  cleanup();

  assert.deepEqual(appliedSessionIds, []);
});

test("startOpenCompanionReviewWindowIdsSubscription は初回 list 結果を反映する", async () => {
  const appliedSessionIds: string[][] = [];
  let unsubscribeCount = 0;
  const api: OpenCompanionReviewWindowIdsSubscriptionApi = {
    listOpenCompanionReviewWindowIds: async () => ["companion-1"],
    subscribeOpenCompanionReviewWindowIds: () => {
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startOpenCompanionReviewWindowIdsSubscription({
    api,
    applyOpenWindowIds: (sessionIds) => appliedSessionIds.push(sessionIds),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedSessionIds, [["companion-1"]]);
  assert.equal(unsubscribeCount, 1);
});

test("startOpenCompanionReviewWindowIdsSubscription は購読更新後の初回 list 結果で上書きしない", async () => {
  const appliedSessionIds: string[][] = [];
  let subscribedListener: ((sessionIds: string[]) => void) | null = null;
  let resolveList: (sessionIds: string[]) => void = () => undefined;
  const api: OpenCompanionReviewWindowIdsSubscriptionApi = {
    listOpenCompanionReviewWindowIds: () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    subscribeOpenCompanionReviewWindowIds: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startOpenCompanionReviewWindowIdsSubscription({
    api,
    applyOpenWindowIds: (sessionIds) => appliedSessionIds.push(sessionIds),
  });
  subscribedListener?.(["companion-subscription"]);
  resolveList(["companion-initial"]);
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedSessionIds, [["companion-subscription"]]);
});

test("startOpenCompanionReviewWindowIdsSubscription は登録時の即時購読更新も初回 list で上書きしない", async () => {
  const appliedSessionIds: string[][] = [];
  const api: OpenCompanionReviewWindowIdsSubscriptionApi = {
    listOpenCompanionReviewWindowIds: async () => ["companion-initial"],
    subscribeOpenCompanionReviewWindowIds: (listener) => {
      listener(["companion-current"]);
      return () => undefined;
    },
  };

  const cleanup = startOpenCompanionReviewWindowIdsSubscription({
    api,
    applyOpenWindowIds: (sessionIds) => appliedSessionIds.push(sessionIds),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedSessionIds, [["companion-current"]]);
});

test("startOpenCompanionReviewWindowIdsSubscription は cleanup 後の list / 購読更新を反映しない", async () => {
  const appliedSessionIds: string[][] = [];
  let subscribedListener: ((sessionIds: string[]) => void) | null = null;
  let resolveList: (sessionIds: string[]) => void = () => undefined;
  let unsubscribeCount = 0;
  const api: OpenCompanionReviewWindowIdsSubscriptionApi = {
    listOpenCompanionReviewWindowIds: () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    subscribeOpenCompanionReviewWindowIds: (listener) => {
      subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startOpenCompanionReviewWindowIdsSubscription({
    api,
    applyOpenWindowIds: (sessionIds) => appliedSessionIds.push(sessionIds),
  });
  cleanup();
  subscribedListener?.(["companion-stale-subscription"]);
  resolveList(["companion-stale-initial"]);
  await flushPromises();

  assert.deepEqual(appliedSessionIds, []);
  assert.equal(unsubscribeCount, 1);
});
