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

  // @test-value v1
  // kind = "regression"
  // claim = "Session Windowをstarting中に開き直した場合も置換後のcurrent windowへGlossary watchを確立する"
  // oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
  // failure_mode = "古いwindowへsubscriptionが残り、開き直したwindowがGlossary更新を受信しない"
  // scope = "session-glossary-window-subscription-lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("Session Windowをstarting中に開き直してもcurrent windowへwatchを確立する", async () => {
  const windowA = new TestWindow(1);
  const windowB = new TestWindow(2);
  let currentWindow: TestWindow | null = windowA;
  let resolveFirstSubscription: ((dispose: () => void) => void) | null = null;
  const firstSubscription = new Promise<() => void>((resolve) => {
    resolveFirstSubscription = resolve;
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
  resolveFirstSubscription?.(() => {
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
