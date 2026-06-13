import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { MainBootstrapService } from "../../src-electron/main-bootstrap-service.js";

test("MainBootstrapService は runtime side effect なしで起動シーケンスを順に実行する", async () => {
  const calls: string[] = [];
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;

  const service = new MainBootstrapService({
    getMateState() {
      calls.push("getMateState");
      return "active";
    },
    async initializePersistentStores() {
      calls.push("initializePersistentStores");
      return activeModelCatalog;
    },
    async recoverInterruptedSessions() {
      calls.push("recoverInterruptedSessions:start");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      calls.push("recoverInterruptedSessions:end");
    },
    registerIpcHandlers() {
      calls.push("registerIpcHandlers");
    },
    async createHomeWindow() {
      calls.push("createHomeWindow");
    },
    broadcastModelCatalog(snapshot) {
      calls.push(`broadcastModelCatalog:${snapshot.revision}`);
    },
  });

  await service.handleReady();

  assert.deepEqual(calls, [
    "initializePersistentStores",
    "recoverInterruptedSessions:start",
    "recoverInterruptedSessions:end",
    "registerIpcHandlers",
    "createHomeWindow",
    "broadcastModelCatalog:1",
  ]);
});

test("Growth timer 互換 API は timer を作らない no-op として残る", async () => {
  const service = new MainBootstrapService({
    getMateState() {
      throw new Error("Growth timer should not read Mate state.");
    },
    async initializePersistentStores() {
      return { revision: 1, providers: [] } as ModelCatalogSnapshot;
    },
    async recoverInterruptedSessions() {},
    registerIpcHandlers() {},
    async createHomeWindow() {},
    broadcastModelCatalog() {},
  });

  await service.ensureGrowthApplyTimer();
  await service.restartGrowthApplyTimer();
  service.clearGrowthApplyTimer();
  service.clearGrowthApplyTimerForTest();
});
