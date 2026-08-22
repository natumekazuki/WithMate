import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinationEventInvalidationPublisher } from "../../src-electron/coordination-event-invalidation-publisher.js";

describe("CoordinationEventInvalidationPublisher", () => {
  it("一部windowのpublication失敗後も他windowへ通知し、同じinvalidationを再試行して収束する", () => {
    let failingTargetCalls = 0;
    let healthyTargetCalls = 0;
    const received: unknown[] = [];
    let retry: (() => void) | null = null;
    const publisher = new CoordinationEventInvalidationPublisher({
      getTargets: () => [
        {
          isAvailable: () => true,
          publish(invalidation) {
            failingTargetCalls += 1;
            received.push(invalidation);
            if (failingTargetCalls === 1) throw new Error("window closing");
          },
        },
        {
          isAvailable: () => true,
          publish(invalidation) {
            healthyTargetCalls += 1;
            received.push(invalidation);
          },
        },
      ],
      scheduleRetry(callback) {
        retry = callback;
        return "retry-handle";
      },
      cancelRetry() {},
    });

    const invalidation = { eventId: "event-1", revision: 1 };
    assert.throws(() => publisher.publish(invalidation), /window closing/);
    assert.equal(failingTargetCalls, 1);
    assert.equal(healthyTargetCalls, 1);
    assert.ok(retry);

    (retry as () => void)();

    assert.equal(failingTargetCalls, 2);
    assert.equal(healthyTargetCalls, 2);
    assert.deepEqual(received, [invalidation, invalidation, invalidation, invalidation]);
  });

  it("retry中に別Eventの通知が重なった場合は全体invalidationへ畳み込む", () => {
    const received: unknown[] = [];
    let retry: (() => void) | null = null;
    let shouldFail = true;
    const publisher = new CoordinationEventInvalidationPublisher({
      getTargets: () => [{
        isAvailable: () => true,
        publish(invalidation) {
          received.push(invalidation);
          if (shouldFail) throw new Error("window closing");
        },
      }],
      scheduleRetry(callback) {
        retry = callback;
        return "retry-handle";
      },
      cancelRetry() {},
    });

    assert.throws(() => publisher.publish({ eventId: "event-1", revision: 1 }));
    assert.throws(() => publisher.publish({ eventId: "event-2", revision: 1 }));
    shouldFail = false;
    assert.ok(retry);
    (retry as () => void)();

    assert.deepEqual(received.at(-1), { eventId: null, revision: null });
  });

  it("retry中に同じEventの新しいrevisionが届いた場合は新しい方へ畳み込む", () => {
    const received: unknown[] = [];
    let retry: (() => void) | null = null;
    let shouldFail = true;
    const publisher = new CoordinationEventInvalidationPublisher({
      getTargets: () => [{
        isAvailable: () => true,
        publish(invalidation) {
          received.push(invalidation);
          if (shouldFail) throw new Error("window closing");
        },
      }],
      scheduleRetry(callback) {
        retry = callback;
        return "retry-handle";
      },
      cancelRetry() {},
    });

    assert.throws(() => publisher.publish({ eventId: "event-1", revision: 1 }));
    assert.throws(() => publisher.publish({ eventId: "event-1", revision: 2 }));
    shouldFail = false;
    assert.ok(retry);
    (retry as () => void)();

    assert.deepEqual(received.at(-1), { eventId: "event-1", revision: 2 });
  });
});
