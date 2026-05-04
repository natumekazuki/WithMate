import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { MainBootstrapService } from "../../src-electron/main-bootstrap-service.js";

type GrowthTimerHandle = {
  handler: () => void;
  intervalMs: number;
  cleared: boolean;
};

function createGrowthTimerSpies() {
  const createdTimers: GrowthTimerHandle[] = [];
  const events: string[] = [];

  return {
    createdTimers,
    events,
    createGrowthApplyTimer(handler: () => void, intervalMs: number) {
      events.push("create");
      const timer: GrowthTimerHandle = { handler, intervalMs, cleared: false };
      createdTimers.push(timer);
      return timer;
    },
    clearGrowthApplyTimer(timer: unknown) {
      events.push("clear");
      if (typeof timer === "object" && timer !== null && "cleared" in timer) {
        (timer as GrowthTimerHandle).cleared = true;
      }
    },
  };
}

test("MainBootstrapService は起動シーケンスを順に実行する", async () => {
  const calls: string[] = [];
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;

  const service = new MainBootstrapService({
    getMateState() {
      calls.push("getMateState");
      return "not_created";
    },
    async applyPendingGrowth() {},
    async initializePersistentStores() {
      calls.push("initializePersistentStores");
      return activeModelCatalog;
    },
    async recoverInterruptedSessions() {
      calls.push("recoverInterruptedSessions:start");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      calls.push("recoverInterruptedSessions:end");
    },
    async refreshCharactersFromStorage() {
      calls.push("refreshCharactersFromStorage");
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
    "refreshCharactersFromStorage",
    "registerIpcHandlers",
    "createHomeWindow",
    "broadcastModelCatalog:1",
    "getMateState",
  ]);
});

test("handleReady で Mate が active の場合は Growth timer が作成される", async () => {
  const timerSpies = createGrowthTimerSpies();
  const service = new MainBootstrapService({
    getMateState() {
      return "active";
    },
    async applyPendingGrowth() {},
    async initializePersistentStores() {
      return { revision: 1, providers: [] } as ModelCatalogSnapshot;
    },
    async recoverInterruptedSessions() {},
    async refreshCharactersFromStorage() {},
    registerIpcHandlers() {},
    async createHomeWindow() {},
    broadcastModelCatalog() {},
    growthApplyIntervalMs: 1234,
    createGrowthApplyTimer: timerSpies.createGrowthApplyTimer,
    clearGrowthApplyTimer: timerSpies.clearGrowthApplyTimer,
  });

  await service.handleReady();

  assert.equal(timerSpies.createdTimers.length, 1);
  assert.equal(timerSpies.createdTimers[0]!.intervalMs, 1234);
});

test("handleReady で Mate が not_created の場合は Growth timer が作成されない", async () => {
  const timerSpies = createGrowthTimerSpies();
  const service = new MainBootstrapService({
    getMateState() {
      return "not_created";
    },
    async applyPendingGrowth() {},
    async initializePersistentStores() {
      return { revision: 1, providers: [] } as ModelCatalogSnapshot;
    },
    async recoverInterruptedSessions() {},
    async refreshCharactersFromStorage() {},
    registerIpcHandlers() {},
    async createHomeWindow() {},
    broadcastModelCatalog() {},
    growthApplyIntervalMs: 1234,
    createGrowthApplyTimer: timerSpies.createGrowthApplyTimer,
    clearGrowthApplyTimer: timerSpies.clearGrowthApplyTimer,
  });

  await service.handleReady();

  assert.equal(timerSpies.createdTimers.length, 0);
  assert.equal(timerSpies.events.includes("create"), false);
});

test("ensureGrowthApplyTimer を複数回呼んでも timer は二重作成されない", async () => {
  const timerSpies = createGrowthTimerSpies();
  const service = new MainBootstrapService({
    getMateState() {
      return "active";
    },
    async applyPendingGrowth() {},
    async initializePersistentStores() {
      return { revision: 1, providers: [] } as ModelCatalogSnapshot;
    },
    async recoverInterruptedSessions() {},
    async refreshCharactersFromStorage() {},
    registerIpcHandlers() {},
    async createHomeWindow() {},
    broadcastModelCatalog() {},
    createGrowthApplyTimer: timerSpies.createGrowthApplyTimer,
    clearGrowthApplyTimer: timerSpies.clearGrowthApplyTimer,
  });

  await service.ensureGrowthApplyTimer();
  await service.ensureGrowthApplyTimer();

  assert.equal(timerSpies.createdTimers.length, 1);
  assert.equal(timerSpies.events.filter((event) => event === "create").length, 1);
});

test("Growth timer handler 実行で applyPendingGrowth が呼ばれる", async () => {
  const timerSpies = createGrowthTimerSpies();
  let applied = 0;
  const service = new MainBootstrapService({
    getMateState() {
      return "active";
    },
    async applyPendingGrowth() {
      applied += 1;
    },
    async initializePersistentStores() {
      return { revision: 1, providers: [] } as ModelCatalogSnapshot;
    },
    async recoverInterruptedSessions() {},
    async refreshCharactersFromStorage() {},
    registerIpcHandlers() {},
    async createHomeWindow() {},
    broadcastModelCatalog() {},
    createGrowthApplyTimer: timerSpies.createGrowthApplyTimer,
    clearGrowthApplyTimer: timerSpies.clearGrowthApplyTimer,
  });

  await service.ensureGrowthApplyTimer();
  timerSpies.createdTimers[0]!.handler();

  await Promise.resolve();

  assert.equal(applied, 1);
});

test("clearGrowthApplyTimer で clear が呼ばれ、再度 ensure できる", async () => {
  const timerSpies = createGrowthTimerSpies();
  const service = new MainBootstrapService({
    getMateState() {
      return "active";
    },
    async applyPendingGrowth() {},
    async initializePersistentStores() {
      return { revision: 1, providers: [] } as ModelCatalogSnapshot;
    },
    async recoverInterruptedSessions() {},
    async refreshCharactersFromStorage() {},
    registerIpcHandlers() {},
    async createHomeWindow() {},
    broadcastModelCatalog() {},
    createGrowthApplyTimer: timerSpies.createGrowthApplyTimer,
    clearGrowthApplyTimer: timerSpies.clearGrowthApplyTimer,
  });

  await service.ensureGrowthApplyTimer();
  service.clearGrowthApplyTimer();
  await service.ensureGrowthApplyTimer();

  assert.equal(timerSpies.events.filter((event) => event === "clear").length, 1);
  assert.equal(timerSpies.events.filter((event) => event === "create").length, 2);
  assert.equal(timerSpies.createdTimers[0]!.cleared, true);
  assert.equal(timerSpies.createdTimers[1]!.cleared, false);
});
