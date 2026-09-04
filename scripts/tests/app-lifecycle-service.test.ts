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

test("AppLifecycleService は second-instance で Home Window を開く", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => false,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {},
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    quitApp() {},
    shouldQuitWhenAllWindowsClosed: () => false,
    confirmQuitWhileRunning: () => false,
    closePersistentStores() {},
  });

  await service.handleSecondInstance();

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

test("AppLifecycleService は window-all-closed で終了不要なら app を終了しない", () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => false,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns: () => {},
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    quitApp() {
      calls.push("quitApp");
    },
    shouldQuitWhenAllWindowsClosed: () => false,
    confirmQuitWhileRunning: () => false,
    closePersistentStores() {},
  });

  service.handleWindowAllClosed();

  assert.deepEqual(calls, []);
});

test("AppLifecycleService は before-quit で実行中 session があり confirm が false なら終了しない", async () => {
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
    closePersistentStores() {},
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads");
    },
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
  });

  await service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, []);
});

// @test-value v1
// kind = "invariant"
// claim = "終了時はprovider binding失効後にMemory runtimeを停止し、その後persistent storeを閉じる"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// failure_mode = "Memory runtimeのunpublishより先にstoreまたはprocessが終了し、別processからstale entryがactiveに見える"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// @end-test-value
test("AppLifecycleService は before-quit で runtime cleanup後にpersistent storeを閉じて終了する", async () => {
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
    async prepareSessionWindowSnapshotForQuit() {
      calls.push("prepareSessionWindowSnapshotForQuit");
    },
    async shutdownSessionRuntime() {
      calls.push("shutdownSessionRuntime");
    },
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads");
    },
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
    async stopMemoryRuntime() {
      calls.push("stopMemoryRuntime");
    },
  });

  await service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, [
    "setAllowQuit",
    "prepareSessionWindowSnapshotForQuit",
    "shutdownSessionRuntime",
    "invalidateAllProviderSessionThreads",
    "revokeAllAgentRuntimeBindings",
    "stopMemoryRuntime",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v1
// kind = "invariant"
// claim = "provider cleanupとMemory runtime cleanupの完了を待ってからpersistent storeを閉じる"
// oracle = { type = "adr", ref = "ADR-021 and ADR-023 shutdown ordering" }
// failure_mode = "非同期cleanupの途中でstoreを閉じ、runtime operationまたはowner cleanupが部分状態になる"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// distinction = "cleanup順序だけでなく非同期provider cleanupの完了待機を観測する"
// @end-test-value
test("AppLifecycleService はSession runtime、provider、Memory runtime停止完了後にpersistent storesを閉じて終了する", async () => {
  let prevented = false;
  const calls: string[] = [];
  let resolveProviderCleanup: (() => void) | null = null;
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
    async shutdownSessionRuntime() {
      calls.push("shutdownSessionRuntime");
    },
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads:start");
      await new Promise<void>((resolve) => {
        resolveProviderCleanup = resolve;
      });
      calls.push("invalidateAllProviderSessionThreads:end");
    },
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
    async stopMemoryRuntime() {
      calls.push("stopMemoryRuntime");
    },
  });

  const cleanup = service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["shutdownSessionRuntime", "invalidateAllProviderSessionThreads:start"]);

  resolveProviderCleanup?.();
  await cleanup;

  assert.deepEqual(calls, [
    "shutdownSessionRuntime",
    "invalidateAllProviderSessionThreads:start",
    "invalidateAllProviderSessionThreads:end",
    "revokeAllAgentRuntimeBindings",
    "stopMemoryRuntime",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v1
// kind = "invariant"
// claim = "binding revoke、runtime stop、store closeが個別に失敗しても終了処理は一度だけsettleする"
// oracle = { type = "adr", ref = "ADR-021 and ADR-023 shutdown failure timing" }
// failure_mode = "cleanup失敗でquit barrierが永久に未完了となるか、後続cleanupが実行されない"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// @end-test-value
test("AppLifecycleService はbinding revoke、runtime stop、store closeが失敗しても終了処理をsettleする", async () => {
  const calls: string[] = [];
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => false,
    getAllowQuitWithInFlightRuns: () => false,
    setAllowQuitWithInFlightRuns() {},
    async createHomeWindow() {},
    quitApp() {
      calls.push("quitApp");
    },
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => true,
    closePersistentStores() {
      calls.push("closePersistentStores");
      throw new Error("close failed");
    },
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads");
    },
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
      throw new Error("revoke failed");
    },
    async stopMemoryRuntime() {
      calls.push("stopMemoryRuntime");
      throw new Error("runtime stop failed");
    },
  });

  await service.handleBeforeQuit({ preventDefault() {} });
  await service.handleBeforeQuit({
    preventDefault() {
      assert.fail("settled cleanup must not prevent a subsequent quit request");
    },
  });

  assert.deepEqual(calls, [
    "invalidateAllProviderSessionThreads",
    "revokeAllAgentRuntimeBindings",
    "stopMemoryRuntime",
    "closePersistentStores",
    "quitApp",
  ]);
});
