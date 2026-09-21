import assert from "node:assert/strict";
import { it } from "node:test";

import { SessionGlossaryWindowSubscriptionCoordinator } from "../../src-electron/session-glossary-window-subscription.js";
import type { SessionGlossaryProjection } from "../../src/glossary-contract.js";

class TestWindow {
  readonly id: number;
  #destroyed = false;
  #closedListeners: Array<() => void> = [];

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  once(_event: "closed", listener: () => void): void {
    this.#closedListeners.push(listener);
  }

  close(): void {
    this.#destroyed = true;
    for (const listener of this.#closedListeners.splice(0)) {
      listener();
    }
  }
}

// @test-value v2
// kind = "invariant"
// claim = "glossary window subscriptionはstarting中のwindow交代後もcurrent windowだけへwatchを確立する"
// oracle = { type = "contract", ref = "glossary window subscription ownership" }
// fault = "旧windowへ購読を残すか新windowへの購読確立を失う"
// observable = "subscription/disposal counts across window replacement"
// observation_boundary = "public-boundary"
// scope = "glossary-window-subscription-ownership"
// lifecycle = "permanent"
// @end-test-value
it("Session Windowをstarting中に開き直してもcurrent windowへwatchを確立する", async () => {
  const windowA = new TestWindow(1);
  const windowB = new TestWindow(2);
  let currentWindow: TestWindow | null = windowA;
  const control: { resolveFirstSubscription: ((dispose: () => void) => void) | null } = { resolveFirstSubscription: null };
  const firstSubscription = new Promise<() => void>((resolve) => {
    control.resolveFirstSubscription = resolve;
  });
  let subscribeCount = 0;
  let disposeA = 0;
  let disposeB = 0;
  const coordinator = new SessionGlossaryWindowSubscriptionCoordinator<TestWindow>({
    getWindow: () => currentWindow,
    subscribe: async () => {
      subscribeCount += 1;
      if (subscribeCount === 1) {
        return firstSubscription;
      }
      return () => {
        disposeB += 1;
      };
    },
    deliver: (_window, _projection: SessionGlossaryProjection) => undefined,
  });

  const ensureA = coordinator.ensure("session-1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  windowA.close();
  currentWindow = windowB;
  const ensureB = coordinator.ensure("session-1");
  if (control.resolveFirstSubscription) control.resolveFirstSubscription(() => {
    disposeA += 1;
  });
  await Promise.all([ensureA, ensureB]);

  assert.equal(subscribeCount, 2);
  assert.equal(disposeA, 1);
  assert.equal(disposeB, 0);
  await coordinator.ensure("session-1");
  assert.equal(subscribeCount, 2);

  windowB.close();
  currentWindow = null;
  assert.equal(disposeB, 1);
});
