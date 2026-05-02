import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { MainBootstrapService } from "../../src-electron/main-bootstrap-service.js";

test("MainBootstrapService は起動シーケンスを順に実行する", async () => {
  const calls: string[] = [];
  const activeModelCatalog = { revision: 1, providers: [] } as ModelCatalogSnapshot;

  const service = new MainBootstrapService({
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
  ]);
});
