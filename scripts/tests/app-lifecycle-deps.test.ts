import assert from "node:assert/strict";
import test from "node:test";

import { createAppLifecycleDeps } from "../../src-electron/app-lifecycle-deps.js";

// @test-value v1
// kind = "contract"
// claim = "main compositionから渡したMemory runtime stop callbackがquit lifecycle依存へ欠落せず投影される"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// failure_mode = "composition境界でruntime stopが欠落し、will-quitの非同期best-effort cleanupへ退行する"
// scope = "application-lifecycle-composition"
// lifecycle = "permanent"
// @end-test-value
test("createAppLifecycleDeps はMemory runtime stopを含む引数をAppLifecycleService依存へ詰める", async () => {
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
    closePersistentStores() {
      calls.push("close");
    },
    async stopMemoryRuntime() {
      calls.push("stop-runtime");
    },
  });

  assert.equal(deps.hasInFlightSessionRuns(), true);
  assert.equal(deps.getAllowQuitWithInFlightRuns(), false);
  deps.setAllowQuitWithInFlightRuns(true);
  await deps.createHomeWindow();
  deps.quitApp();
  assert.equal(deps.shouldQuitWhenAllWindowsClosed(), false);
  assert.equal(deps.confirmQuitWhileRunning(), true);
  await deps.stopMemoryRuntime?.();
  deps.closePersistentStores();
  assert.deepEqual(calls, ["set:true", "home", "quit", "stop-runtime", "close"]);
});
