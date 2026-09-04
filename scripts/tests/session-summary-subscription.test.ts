import assert from "node:assert/strict";
import test from "node:test";

import {
  startSessionSummaryInvalidationSubscription,
  type SessionSummaryInvalidationSubscriptionApi,
} from "../../src/session-summary-subscription.js";
import type { SessionSummaryInvalidation } from "../../src/session-state.js";

// @test-value v1
// kind = "compatibility"
// claim = "summary invalidation APIがない旧bridgeでは登録せず安全なno-op cleanupを返す"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "旧bridgeでsubscription初期化がthrowしSession Windowを起動できない"
// scope = "session-summary-subscription-optional-api"
// lifecycle = "permanent"
// @end-test-value
test("startSessionSummaryInvalidationSubscription は api がない場合 no-op cleanup を返す", () => {
  const received: SessionSummaryInvalidation[] = [];

  const cleanup = startSessionSummaryInvalidationSubscription({
    api: null,
    onInvalidation: (payload) => received.push(payload),
  });
  cleanup();

  assert.deepEqual(received, []);
});

// @test-value v1
// kind = "invariant"
// claim = "summary subscriptionはidsとall invalidation payloadを変更せずconsumerへ渡す"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "対象IDが欠落する、またはall更新が部分更新へ誤変換されstale表示が残る"
// scope = "session-summary-subscription-payload"
// lifecycle = "permanent"
// @end-test-value
test("startSessionSummaryInvalidationSubscription は ids / all をそのまま反映する", () => {
  const received: SessionSummaryInvalidation[] = [];
  let listener: ((payload: SessionSummaryInvalidation) => void) | null = null;
  let unsubscribeCount = 0;
  const api: SessionSummaryInvalidationSubscriptionApi = {
    subscribeSessionInvalidation: (nextListener) => {
      listener = nextListener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startSessionSummaryInvalidationSubscription({
    api,
    onInvalidation: (payload) => received.push(payload),
  });
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
