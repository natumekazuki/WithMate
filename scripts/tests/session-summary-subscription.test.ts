import assert from "node:assert/strict";
import test from "node:test";

import {
  startSessionSummariesSubscription,
  type SessionSummariesSubscriptionApi,
} from "../../src/session-summary-subscription.js";
import type { SessionSummary } from "../../src/session-state.js";

const createSummary = (id: string): SessionSummary => ({
  id,
} as SessionSummary);

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("startSessionSummariesSubscription は api がない場合 no-op cleanup を返す", () => {
  const appliedSummaries: SessionSummary[][] = [];

  const cleanup = startSessionSummariesSubscription({
    api: null,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  cleanup();

  assert.deepEqual(appliedSummaries, []);
});

test("startSessionSummariesSubscription は初回取得と購読更新を反映する", async () => {
  const initialSummaries = [createSummary("session-1")];
  const subscribedSummaries = [createSummary("session-2")];
  const appliedSummaries: SessionSummary[][] = [];
  let subscribedListener: ((summaries: SessionSummary[]) => void) | null = null;
  let unsubscribeCount = 0;
  const api: SessionSummariesSubscriptionApi = {
    listSessionSummaries: async () => initialSummaries,
    subscribeSessionSummaries: (listener) => {
      subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startSessionSummariesSubscription({
    api,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  await flushPromises();
  subscribedListener?.(subscribedSummaries);
  cleanup();
  subscribedListener?.([createSummary("stale")]);

  assert.deepEqual(appliedSummaries, [initialSummaries, subscribedSummaries]);
  assert.equal(unsubscribeCount, 1);
});

test("startSessionSummariesSubscription は購読更新後に遅い初回取得で古い summaries へ戻さない", async () => {
  const initialSummaries = [createSummary("session-1")];
  const subscribedSummaries = [createSummary("session-2")];
  const appliedSummaries: SessionSummary[][] = [];
  let resolveList: (summaries: SessionSummary[]) => void = () => undefined;
  let subscribedListener: ((summaries: SessionSummary[]) => void) | null = null;
  const api: SessionSummariesSubscriptionApi = {
    listSessionSummaries: () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    subscribeSessionSummaries: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startSessionSummariesSubscription({
    api,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  subscribedListener?.(subscribedSummaries);
  resolveList(initialSummaries);
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedSummaries, [subscribedSummaries]);
});

test("startSessionSummariesSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  let rejectList: (error: Error) => void = () => undefined;
  let subscribedListener: ((summaries: SessionSummary[]) => void) | null = null;
  const api: SessionSummariesSubscriptionApi = {
    listSessionSummaries: () => new Promise((_, reject) => {
      rejectList = reject;
    }),
    subscribeSessionSummaries: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startSessionSummariesSubscription({
    api,
    applySummaries: () => undefined,
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  subscribedListener?.([createSummary("session-2")]);
  rejectList(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 0);
});

test("startSessionSummariesSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const initialSummaries = [createSummary("session-1")];
  const appliedSummaries: SessionSummary[][] = [];
  let resolveList: (summaries: SessionSummary[]) => void = () => undefined;
  const api: SessionSummariesSubscriptionApi = {
    listSessionSummaries: () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    subscribeSessionSummaries: () => () => undefined,
  };

  const cleanup = startSessionSummariesSubscription({
    api,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  cleanup();
  resolveList(initialSummaries);
  await flushPromises();

  assert.deepEqual(appliedSummaries, []);
});
