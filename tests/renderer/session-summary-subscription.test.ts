import assert from "node:assert/strict";
import test from "node:test";

import {
  startSessionSummaryInvalidationSubscription,
  type SessionSummaryInvalidationSubscriptionApi,
} from "../../src/chat/runtime/session-summary-subscription.js";
import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";

/** 無効化通知 API を渡せない場合でも解除処理を呼べ、通知が生成されないことを確認する。 */
test("startSessionSummaryInvalidationSubscription は api がない場合 no-op cleanup を返す", () => {
  const received: SessionSummaryInvalidation[] = [];

  const cleanup = startSessionSummaryInvalidationSubscription({
    api: null,
    /** 無効化コールバックが呼ばれた場合、受信内容を検査用の配列に記録する。 */
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
/** 個別 ID の無効化と全件無効化をそのまま転送し、解除が一度だけ行われて遅着した通知を遮断することを確認する。 */
test("startSessionSummaryInvalidationSubscription は ids / all をそのまま反映する", () => {
  const received: SessionSummaryInvalidation[] = [];
  const control: {
    listener: ((payload: SessionSummaryInvalidation) => void) | null;
  } = { listener: null };
  let unsubscribeCount = 0;
  const api: SessionSummaryInvalidationSubscriptionApi = {
    /** 通知リスナーを保持してテストから直接呼び出せるようにし、購読解除の回数を数える。 */
    subscribeSessionInvalidation: (nextListener) => {
      control.listener = nextListener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startSessionSummaryInvalidationSubscription({
    api,
    /** 購読境界を通過した通知を、到着順に検査用の配列へ記録する。 */
    onInvalidation: (payload) => received.push(payload),
  });
  if (control.listener)
    control.listener({ scope: "ids", sessionIds: ["session-1"] });
  if (control.listener) control.listener({ scope: "all" });
  cleanup();
  if (control.listener)
    control.listener({ scope: "ids", sessionIds: ["stale"] });

  assert.deepEqual(received, [
    { scope: "ids", sessionIds: ["session-1"] },
    { scope: "all" },
  ]);
  assert.equal(unsubscribeCount, 1);
});
