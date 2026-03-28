import assert from "node:assert/strict";
import test from "node:test";

import { MainInfrastructureRegistry } from "../../src-electron/main-infrastructure-registry.js";

test("MainInfrastructureRegistry は service を lazy に 1 回だけ生成し reset で再生成する", () => {
  let counter = 0;
  const create = (label: string) => () => `${label}-${++counter}`;
  const registry = new MainInfrastructureRegistry({
    createWindowBroadcastService: create("broadcast"),
    createWindowDialogService: create("dialog"),
    createWindowEntryLoader: create("loader"),
    createAuxWindowService: create("aux"),
    createPersistentStoreLifecycleService: create("store"),
    createAppLifecycleService: create("lifecycle"),
    createMainBootstrapService: create("bootstrap"),
  });

  const firstBroadcast = registry.getWindowBroadcastService();
  const secondBroadcast = registry.getWindowBroadcastService();
  const firstBootstrap = registry.getMainBootstrapService();

  assert.equal(firstBroadcast, secondBroadcast);
  assert.equal(firstBootstrap, "bootstrap-2");

  registry.reset();

  const thirdBroadcast = registry.getWindowBroadcastService();
  assert.notEqual(thirdBroadcast, firstBroadcast);
  assert.equal(thirdBroadcast, "broadcast-3");
});
