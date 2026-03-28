import assert from "node:assert/strict";
import test from "node:test";

import { AppLifecycleService } from "../../src-electron/app-lifecycle-service.js";

test("AppLifecycleService は activate で Home Window を開く", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => false,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {},
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    quitApp() {},
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => false,
    closePersistentStores() {},
  });

  await service.handleActivate();

  assert.deepEqual(calls, ["createHomeWindow"]);
});

test("AppLifecycleService は実行中 session があると window-all-closed で Home Window を再度開く", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => true,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {},
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    quitApp() {
      calls.push("quitApp");
    },
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => false,
    closePersistentStores() {},
  });

  service.handleWindowAllClosed();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ["createHomeWindow"]);
});

test("AppLifecycleService は before-quit で実行中 session があり confirm が false なら終了しない", () => {
  let prevented = false;
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => true,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {
      calls.push("setAllowQuit");
    },
    async createHomeWindow() {},
    quitApp() {
      calls.push("quitApp");
    },
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => false,
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
  });

  service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, []);
});

test("AppLifecycleService は before-quit で confirm が true なら許可状態にして終了する", () => {
  let prevented = false;
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => true,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {
      calls.push("setAllowQuit");
    },
    async createHomeWindow() {},
    quitApp() {
      calls.push("quitApp");
    },
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => true,
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
  });

  service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ["setAllowQuit", "quitApp"]);
});

test("AppLifecycleService は通常の before-quit で persistent stores を閉じる", () => {
  let prevented = false;
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => false,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {
      calls.push("setAllowQuit");
    },
    async createHomeWindow() {},
    quitApp() {
      calls.push("quitApp");
    },
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => true,
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
  });

  service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, false);
  assert.deepEqual(calls, ["closePersistentStores"]);
});
