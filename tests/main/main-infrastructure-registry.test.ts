import assert from "node:assert/strict";
import test from "node:test";

import { MainInfrastructureRegistry } from "../../src-electron/app/main-infrastructure-registry.js";

// @test-value v2
// kind = "invariant"
// claim = "Main infrastructureのstore・lifecycle・bootstrap serviceは同じregistry世代では共有され、reset後は再生成される"
// oracle = { type = "contract", ref = "src-electron/app/main-infrastructure-registry.ts: MainInfrastructureRegistry lazy initialization and reset" }
// fault = "getterのたびにserviceを作る、別serviceを先に作る、またはreset後も旧serviceを返す"
// observable = "factory呼出順を含む生成値、同一getterの返却identity、reset前後のidentity"
// observation_boundary = "public-boundary"
// scope = "MainInfrastructureRegistry"
// lifecycle = "permanent"
// @end-test-value
test("MainInfrastructureRegistry は service を lazy に 1 回だけ生成し reset で再生成する", () => {
  let counter = 0;
  const create = (label: string) => () => `${label}-${++counter}`;
  const registry = new MainInfrastructureRegistry({
    createPersistentStoreLifecycleService: create("store"),
    createAppLifecycleService: create("lifecycle"),
    createMainBootstrapService: create("bootstrap"),
  });

  const firstStore = registry.getPersistentStoreLifecycleService();
  const secondStore = registry.getPersistentStoreLifecycleService();
  const firstBootstrap = registry.getMainBootstrapService();

  assert.equal(firstStore, secondStore);
  assert.equal(firstBootstrap, "bootstrap-2");
  assert.equal(registry.getMainBootstrapService(), firstBootstrap);
  const firstLifecycle = registry.getAppLifecycleService();
  assert.equal(firstLifecycle, "lifecycle-3");
  assert.equal(registry.getAppLifecycleService(), firstLifecycle);

  registry.reset();

  const thirdStore = registry.getPersistentStoreLifecycleService();
  assert.notEqual(thirdStore, firstStore);
  assert.equal(thirdStore, "store-4");
  assert.equal(registry.getMainBootstrapService(), "bootstrap-5");
  assert.equal(registry.getAppLifecycleService(), "lifecycle-6");
});
