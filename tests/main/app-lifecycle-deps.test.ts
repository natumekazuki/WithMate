import assert from "node:assert/strict";
import test from "node:test";

import { createAppLifecycleDeps } from "../../src-electron/app/app-lifecycle-deps.js";

// @test-value v2
// kind = "contract"
// claim = "main compositionから渡したruntime stop callbackと通常終了依存をlifecycleから呼び出せる"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// fault = "compositionがruntime stopまたは通常終了callbackを欠落させる"
// observable = "返却依存を呼んだ際のcallback記録とgetter戻り値"
// observation_boundary = "component-behavior"
// scope = "application-lifecycle-composition"
// lifecycle = "permanent"
// @end-test-value
test("createAppLifecycleDeps はruntime stopを含む引数をAppLifecycleService依存へ詰める", async () => {
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
    async stopAgentRuntime() {
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
  await deps.stopAgentRuntime?.();
  deps.closePersistentStores();
  assert.deepEqual(calls, ["set:true", "home", "quit", "stop-runtime", "close"]);
});
