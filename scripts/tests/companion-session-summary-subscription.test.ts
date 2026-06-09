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
