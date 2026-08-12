import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeSessionRuntimeAdmission,
  SessionRuntimeQuitBarrier,
} from "../../src-electron/session-runtime-quit-barrier.js";

test("Session runtime admission closure reaches execution service without a lazy application service", () => {
  const calls: string[] = [];

  closeSessionRuntimeAdmission({
    executionService: {
      beginShutdown() {
        calls.push("execution");
      },
    },
    applicationService: null,
  });

  assert.deepEqual(calls, ["execution"]);
});

test("Session runtime quit barrier prevents quit until runtime cleanup completes", async () => {
  let releaseCleanup: (() => void) | undefined;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let releaseDispatch: (() => void) | undefined;
  const dispatch = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const calls: string[] = [];
  const barrier = new SessionRuntimeQuitBarrier({
    async stopRuntime() {
      calls.push("stopRuntime");
      await cleanup;
      calls.push("runtimeStopped");
    },
    async drainExecutions() {
      calls.push("drainExecutions");
      await dispatch;
      calls.push("executionsDrained");
    },
    closePersistentStores() {
      calls.push("closePersistentStores");
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

  assert.deepEqual(calls, ["stopRuntime", "runtimeStopped", "drainExecutions"]);
  releaseDispatch?.();
  await dispatch;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    "stopRuntime",
    "runtimeStopped",
    "drainExecutions",
    "executionsDrained",
    "closePersistentStores",
    "quitApp",
  ]);
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
    async drainExecutions() {
      calls.push("drainExecutions");
    },
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
    quitApp() {
      calls.push("quitApp");
    },
  });
  let prevented = false;

  barrier.handleWillQuit({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.deepEqual(calls, ["stopRuntime", "drainExecutions", "closePersistentStores", "quitApp"]);
});
