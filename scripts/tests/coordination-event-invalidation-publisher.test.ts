import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinationEventInvalidationPublisher } from "../../src-electron/coordination-event-invalidation-publisher.js";

describe("CoordinationEventInvalidationPublisher", () => {
  it("一部windowのpublication失敗後も他windowへ通知し、同じinvalidationを再試行して収束する", () => {
    let failingTargetCalls = 0;
    let healthyTargetCalls = 0;
    let retry: (() => void) | null = null;
    const publisher = new CoordinationEventInvalidationPublisher({
      getTargets: () => [
        {
          isAvailable: () => true,
          publish() {
            failingTargetCalls += 1;
            if (failingTargetCalls === 1) throw new Error("window closing");
          },
        },
        {
          isAvailable: () => true,
          publish() { healthyTargetCalls += 1; },
        },
      ],
      scheduleRetry(callback) {
        retry = callback;
        return "retry-handle";
      },
      cancelRetry() {},
    });

    assert.throws(() => publisher.publish(), /window closing/);
    assert.equal(failingTargetCalls, 1);
    assert.equal(healthyTargetCalls, 1);
    assert.ok(retry);

    (retry as () => void)();

    assert.equal(failingTargetCalls, 2);
    assert.equal(healthyTargetCalls, 2);
  });
});
