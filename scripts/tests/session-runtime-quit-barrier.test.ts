import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionRuntimeQuitBarrier } from "../../src-electron/session-runtime-quit-barrier.js";

test("Session runtime quit barrier prevents quit until runtime cleanup completes", async () => {
  let releaseCleanup: (() => void) | undefined;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const calls: string[] = [];
  const barrier = new SessionRuntimeQuitBarrier({
    async stopRuntime() {
      calls.push("stopRuntime");
      await cleanup;
      calls.push("runtimeStopped");
    },
    quitApp() {
      calls.push("quitApp");
    },
  });
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };

  barrier.handleWillQuit(event);
  barrier.handleWillQuit(event);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, 2);
  assert.deepEqual(calls, ["stopRuntime"]);

  releaseCleanup?.();
  await cleanup;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["stopRuntime", "runtimeStopped", "quitApp"]);
  barrier.handleWillQuit(event);
  assert.equal(prevented, 2);
});

test("Session runtime quit barrier permits final quit after cleanup failure", async () => {
  const calls: string[] = [];
  const barrier = new SessionRuntimeQuitBarrier({
    async stopRuntime() {
      calls.push("stopRuntime");
      throw new Error("cleanup failed");
    },
    quitApp() {
      calls.push("quitApp");
    },
  });
  let prevented = false;

  barrier.handleWillQuit({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.deepEqual(calls, ["stopRuntime", "quitApp"]);
});
