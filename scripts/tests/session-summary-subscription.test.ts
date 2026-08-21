import assert from "node:assert/strict";
import test from "node:test";

import {
  startSessionSummaryInvalidationSubscription,
  type SessionSummaryInvalidationSubscriptionApi,
} from "../../src/session-summary-subscription.js";
import type { SessionSummaryInvalidation } from "../../src/session-state.js";

test("startSessionSummaryInvalidationSubscription は api がない場合 no-op cleanup を返す", () => {
  const received: SessionSummaryInvalidation[] = [];
  const cleanup = startSessionSummaryInvalidationSubscription({
    api: null,
    onInvalidation: (payload) => received.push(payload),
  });
  cleanup();
  assert.deepEqual(received, []);
});

test("startSessionSummaryInvalidationSubscription は ids / all をそのまま反映する", () => {
  const received: SessionSummaryInvalidation[] = [];
  let listener: ((payload: SessionSummaryInvalidation) => void) | null = null;
  let unsubscribeCount = 0;
  const api: SessionSummaryInvalidationSubscriptionApi = {
    subscribeSessionInvalidation: (nextListener) => {
      listener = nextListener;
      return () => { unsubscribeCount += 1; };
    },
  };
  const cleanup = startSessionSummaryInvalidationSubscription({ api, onInvalidation: (payload) => received.push(payload) });
  listener?.({ scope: "ids", sessionIds: ["session-1"] });
  listener?.({ scope: "all" });
  cleanup();
  listener?.({ scope: "ids", sessionIds: ["stale"] });
  assert.deepEqual(received, [
    { scope: "ids", sessionIds: ["session-1"] },
    { scope: "all" },
  ]);
  assert.equal(unsubscribeCount, 1);
});
