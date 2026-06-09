import assert from "node:assert/strict";
import test from "node:test";

import {
  startCompanionSessionSummariesSubscription,
  type CompanionSessionSummariesSubscriptionApi,
} from "../../src/companion-session-summary-subscription.js";
import type { CompanionSessionSummary } from "../../src/companion-state.js";

const createSummary = (id: string): CompanionSessionSummary => ({
  id,
} as CompanionSessionSummary);

const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("startCompanionSessionSummariesSubscription は api がない場合 no-op cleanup を返す", () => {
  const appliedSummaries: CompanionSessionSummary[][] = [];

  const cleanup = startCompanionSessionSummariesSubscription({
    api: null,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  cleanup();

  assert.deepEqual(appliedSummaries, []);
});

test("startCompanionSessionSummariesSubscription は初回取得と購読更新を反映する", async () => {
  const initialSummaries = [createSummary("companion-1")];
  const subscribedSummaries = [createSummary("companion-2")];
  const appliedSummaries: CompanionSessionSummary[][] = [];
  let subscribedListener: ((summaries: CompanionSessionSummary[]) => void) | null = null;
  let unsubscribeCount = 0;
  const api: CompanionSessionSummariesSubscriptionApi = {
    listCompanionSessionSummaries: async () => initialSummaries,
    subscribeCompanionSessionSummaries: (listener) => {
      subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startCompanionSessionSummariesSubscription({
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

test("startCompanionSessionSummariesSubscription は購読更新後に遅い初回取得で古い summaries へ戻さない", async () => {
  const initialSummaries = [createSummary("companion-1")];
  const subscribedSummaries = [createSummary("companion-2")];
  const appliedSummaries: CompanionSessionSummary[][] = [];
  let resolveList: (summaries: CompanionSessionSummary[]) => void = () => undefined;
  let subscribedListener: ((summaries: CompanionSessionSummary[]) => void) | null = null;
  const api: CompanionSessionSummariesSubscriptionApi = {
    listCompanionSessionSummaries: () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    subscribeCompanionSessionSummaries: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startCompanionSessionSummariesSubscription({
    api,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  subscribedListener?.(subscribedSummaries);
  resolveList(initialSummaries);
  await flushPromises();
  cleanup();

  assert.deepEqual(appliedSummaries, [subscribedSummaries]);
});

test("startCompanionSessionSummariesSubscription は購読更新後に遅い初回取得失敗 fallback を呼ばない", async () => {
  let errorCount = 0;
  let rejectList: (error: Error) => void = () => undefined;
  let subscribedListener: ((summaries: CompanionSessionSummary[]) => void) | null = null;
  const api: CompanionSessionSummariesSubscriptionApi = {
    listCompanionSessionSummaries: () => new Promise((_, reject) => {
      rejectList = reject;
    }),
    subscribeCompanionSessionSummaries: (listener) => {
      subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startCompanionSessionSummariesSubscription({
    api,
    applySummaries: () => undefined,
    onInitialLoadError: () => {
      errorCount += 1;
    },
  });
  subscribedListener?.([createSummary("companion-2")]);
  rejectList(new Error("failed"));
  await flushPromises();
  cleanup();

  assert.equal(errorCount, 0);
});

test("startCompanionSessionSummariesSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const initialSummaries = [createSummary("companion-1")];
  const appliedSummaries: CompanionSessionSummary[][] = [];
  let resolveList: (summaries: CompanionSessionSummary[]) => void = () => undefined;
  const api: CompanionSessionSummariesSubscriptionApi = {
    listCompanionSessionSummaries: () => new Promise((resolve) => {
      resolveList = resolve;
    }),
    subscribeCompanionSessionSummaries: () => () => undefined,
  };

  const cleanup = startCompanionSessionSummariesSubscription({
    api,
    applySummaries: (summaries) => appliedSummaries.push(summaries),
  });
  cleanup();
  resolveList(initialSummaries);
  await flushPromises();

  assert.deepEqual(appliedSummaries, []);
});
