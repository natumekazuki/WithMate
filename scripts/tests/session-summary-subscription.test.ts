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

// @test-value v2
// kind = "contract"
// claim = "session summary invalidation subscriptionはids/all scopeをそのまま通知しcleanup後は無視する"
// oracle = { type = "contract", ref = "session summary invalidation subscription" }
// fault = "scopeまたはsession idsが変形されるか購読解除後のstale通知が伝播する"
// observable = "received invalidations and unsubscribe count"
// observation_boundary = "public-boundary"
// scope = "session-summary-invalidation"
// lifecycle = "permanent"
// @end-test-value
test("startSessionSummaryInvalidationSubscription は ids / all をそのまま反映する", () => {
  const received: SessionSummaryInvalidation[] = [];
  const control: { listener: ((payload: SessionSummaryInvalidation) => void) | null } = { listener: null };
  let unsubscribeCount = 0;
  const api: SessionSummaryInvalidationSubscriptionApi = {
    subscribeSessionInvalidation: (nextListener) => {
      control.listener = nextListener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startSessionSummaryInvalidationSubscription({
    api,
    onInvalidation: (payload) => received.push(payload),
  });
  if (control.listener) control.listener({ scope: "ids", sessionIds: ["session-1"] });
  if (control.listener) control.listener({ scope: "all" });
  cleanup();
  if (control.listener) control.listener({ scope: "ids", sessionIds: ["stale"] });

  assert.deepEqual(received, [
    { scope: "ids", sessionIds: ["session-1"] },
    { scope: "all" },
  ]);
  assert.equal(unsubscribeCount, 1);
});
