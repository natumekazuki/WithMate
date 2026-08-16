import assert from "node:assert/strict";
import test from "node:test";

import { createAppLifecycleDeps } from "../../src-electron/app-lifecycle-deps.js";

test("createAppLifecycleDeps は引数をそのまま AppLifecycleService 依存へ詰める", async () => {
  const calls: string[] = [];
  const deps = createAppLifecycleDeps({
    hasInFlightSessionRuns: () => true,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns(value) {
      calls.push(`set:${value}`);
    },
    async createHomeWindow() {
      calls.push("home");
    },
    quitApp() {
      calls.push("quit");
    },
    shouldQuitWhenAllWindowsClosed: () => false,
    confirmQuitWhileRunning: () => true,
    async shutdownSessionRuntime() {
      calls.push("shutdown");
    },
    closePersistentStores() {
      calls.push("close");
    },
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidate");
    },
    revokeAllAgentRuntimeBindings() {
      calls.push("revoke");
    },
  });

  assert.equal(deps.hasInFlightSessionRuns(), true);
  assert.equal(deps.getAllowQuitWithInFlightRuns(), false);
  deps.setAllowQuitWithInFlightRuns(true);
  await deps.createHomeWindow();
  deps.quitApp();
  assert.equal(deps.shouldQuitWhenAllWindowsClosed(), false);
  assert.equal(deps.confirmQuitWhileRunning(), true);
  await deps.shutdownSessionRuntime?.();
  await deps.invalidateAllProviderSessionThreads?.();
  deps.revokeAllAgentRuntimeBindings?.();
  deps.closePersistentStores();
  assert.deepEqual(calls, ["set:true", "home", "quit", "shutdown", "invalidate", "revoke", "close"]);
});
