import assert from "node:assert/strict";
import test from "node:test";

import { AppLifecycleService } from "../../src-electron/app/app-lifecycle-service.js";

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
    closePersistentStores() {
      calls.push("closePersistentStores");
    },
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

// @test-value v2
// kind = "invariant"
// claim = "終了時はprovider binding失効後にMemory runtimeを停止し、その後persistent storeを閉じる"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence; ADR-021 binding authority; ADR-023 runtime discovery" }
// fault = "Memory runtimeのunpublishより先にstoreまたはprocessが終了し、別processからstale entryがactiveに見える"
// observable = "provider binding、Memory runtime、persistent storeのcleanup呼出し順"
// observation_boundary = "public-boundary"
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
    "invalidateAllProviderSessionThreads",
    "revokeAllAgentRuntimeBindings",
    "stopMemoryRuntime",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "provider cleanupとMemory runtime cleanupの完了を待ってからpersistent storeを閉じる"
// oracle = { type = "adr", ref = "ADR-021 and ADR-023 shutdown ordering" }
// fault = "非同期cleanupの途中でstoreを閉じ、runtime operationまたはowner cleanupが部分状態になる"
// observable = "provider／Memory cleanup完了通知とpersistent store closeの呼出し順"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-runtime-discovery"
// lifecycle = "permanent"
// distinction = "cleanup順序だけでなく非同期provider cleanupの完了待機を観測する"
// @end-test-value
test("AppLifecycleService はproviderとMemory runtime停止完了後にpersistent storesを閉じて終了する", async () => {
  let prevented = false;
  const calls: string[] = [];
  const providerCleanup = { resolve: undefined as (() => void) | undefined };
  const memoryCleanup = { resolve: undefined as (() => void) | undefined };
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
    async invalidateAllProviderSessionThreads() {
      calls.push("invalidateAllProviderSessionThreads:start");
      await new Promise<void>((resolve) => {
        providerCleanup.resolve = resolve;
      });
      calls.push("invalidateAllProviderSessionThreads:end");
    },
    revokeAllAgentRuntimeBindings() {
      calls.push("revokeAllAgentRuntimeBindings");
    },
    async stopMemoryRuntime() {
      calls.push("stopMemoryRuntime:start");
      await new Promise<void>((resolve) => { memoryCleanup.resolve = resolve; });
      calls.push("stopMemoryRuntime:end");
    },
  });

  const cleanup = service.handleBeforeQuit({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ["invalidateAllProviderSessionThreads:start"]);

  providerCleanup.resolve?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["invalidateAllProviderSessionThreads:start", "invalidateAllProviderSessionThreads:end", "revokeAllAgentRuntimeBindings", "stopMemoryRuntime:start"]);
  assert.equal(calls.includes("closePersistentStores"), false);
  memoryCleanup.resolve?.();
  await cleanup;

  assert.deepEqual(calls, [
    "invalidateAllProviderSessionThreads:start",
    "invalidateAllProviderSessionThreads:end",
    "revokeAllAgentRuntimeBindings",
    "stopMemoryRuntime:start",
    "stopMemoryRuntime:end",
    "closePersistentStores",
    "quitApp",
  ]);
});

// @test-value v2
// kind = "invariant"
// claim = "AppLifecycleServiceはclosePersistentStoresの非同期完了後にだけquitを実行する"
// oracle = { type = "contract", ref = "src-electron/app/app-lifecycle-service.ts#handleBeforeQuit" }
// fault = "closePersistentStoresの完了を待たずにElectron quitを実行する"
// observable = "closePersistentStoresの終了後に記録されたquitApp呼出し順"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-persistent-store"
// lifecycle = "permanent"
// impact = "終了時にStorage Workerや非同期storeが未完了のままprocess終了し、保存結果が不明になることを防ぐ"
// distinction = "provider cleanupではなくAppLifecycleServiceのclosePersistentStores完了とquit順序を直接確認する"
// @end-test-value
test("AppLifecycleService は非同期persistent store closeの完了後にquitする", async () => {
  const calls: string[] = [];
  const closeControl = { resolve: undefined as (() => void) | undefined };
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
      calls.push("closePersistentStores:start");
      return new Promise<void>((resolve) => {
          closeControl.resolve = () => {
          calls.push("closePersistentStores:end");
          resolve();
        };
      });
    },
  });

  const cleanup = service.handleBeforeQuit({ preventDefault() {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["closePersistentStores:start"]);
  closeControl.resolve?.();
  await cleanup;
  assert.deepEqual(calls, ["closePersistentStores:start", "closePersistentStores:end", "quitApp"]);
});

// @test-value v2
// kind = "invariant"
// claim = "binding revoke、runtime stop、store closeが個別に失敗しても終了処理は一度だけsettleする"
// oracle = { type = "adr", ref = "ADR-021 and ADR-023 shutdown failure timing" }
// fault = "cleanup失敗でquit barrierが永久に未完了となるか、後続cleanupが実行されない"
// observable = "cleanup呼出し順とquitApp呼出し回数"
// observation_boundary = "public-boundary"
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

// @test-value v2
// kind = "invariant"
// claim = "全Windowのdraft flushが失敗したquit試行ではcleanupせず、再試行でのみ終了する"
// oracle = { type = "contract", ref = "AppLifecycleService#handleBeforeQuit" }
// fault = "一部Windowのflush失敗を成功扱いし、未保存入力を失ったままcleanupとquitを実行する"
// observable = "flush回数、cleanup呼出し、quit呼出し"
// observation_boundary = "public-boundary"
// scope = "application-shutdown-draft-flush"
// lifecycle = "permanent"
// @end-test-value
test("AppLifecycleService は複数Window flush失敗時にcleanupを保留し再quitで完了する", async () => {
  let flushAttempt = 0;
  const calls: string[] = [];
  let allowQuit = false;
  const service = new AppLifecycleService({
    hasInFlightSessionRuns: () => false,
    getAllowQuitWithInFlightRuns: () => allowQuit,
    setAllowQuitWithInFlightRuns: (value) => { allowQuit = value; },
    async createHomeWindow() {},
    quitApp: () => calls.push("quit"),
    shouldQuitWhenAllWindowsClosed: () => true,
    confirmQuitWhileRunning: () => true,
    flushSessionWindowDrafts: async () => {
      flushAttempt += 1;
      calls.push(`flush-${flushAttempt}-window-a`);
      calls.push(`flush-${flushAttempt}-window-b`);
      return flushAttempt > 1;
    },
    closePersistentStores: () => { calls.push("close"); },
    invalidateAllProviderSessionThreads: async () => { calls.push("provider"); },
    stopMemoryRuntime: async () => { calls.push("memory"); },
  });

  await service.handleBeforeQuit({ preventDefault() {} });
  assert.deepEqual(calls, ["flush-1-window-a", "flush-1-window-b"]);
  await service.handleBeforeQuit({ preventDefault() {} });
  assert.deepEqual(calls, [
    "flush-1-window-a", "flush-1-window-b",
    "flush-2-window-a", "flush-2-window-b", "provider", "memory", "close", "quit",
  ]);
});
