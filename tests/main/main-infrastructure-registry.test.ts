import assert from "node:assert/strict";
import test from "node:test";

import { MainInfrastructureRegistry } from "../../src-electron/app/main-infrastructure-registry.js";

// @test-value v2
// kind = "invariant"
// claim = "DB世代のstore・bootstrap serviceは同じregistry内では共有され、reset後は再生成される"
// oracle = { type = "contract", ref = "src-electron/app/main-infrastructure-registry.ts: MainInfrastructureRegistry lazy initialization and reset" }
// fault = "getterのたびにserviceを作る、別serviceを先に作る、またはreset後も旧serviceを返す"
// observable = "factory呼出順を含む生成値、同一getterの返却identity、reset前後のidentity"
// observation_boundary = "public-boundary"
// scope = "MainInfrastructureRegistry"
// lifecycle = "permanent"
// @end-test-value
/** サービスを初回取得まで作らず、同じ登録を再利用し、reset 後に両サービスを作り直すことを確認する。 */
test("MainInfrastructureRegistry は service を lazy に 1 回だけ生成し reset で再生成する", () => {
  let counter = 0;
  /** 生成のたびに別ラベルを返して、サービスの再利用と生成順を区別できるようにする。 */
  const create = (label: string) => () => `${label}-${++counter}`;
  const registry = new MainInfrastructureRegistry({
    createPersistentStoreLifecycleService: create("store"),
    createMainBootstrapService: create("bootstrap"),
  });

  const firstStore = registry.getPersistentStoreLifecycleService();
  const secondStore = registry.getPersistentStoreLifecycleService();
  const firstBootstrap = registry.getMainBootstrapService();

  assert.equal(firstStore, secondStore);
  assert.equal(firstBootstrap, "bootstrap-2");
  assert.equal(registry.getMainBootstrapService(), firstBootstrap);

  registry.reset();

  const thirdStore = registry.getPersistentStoreLifecycleService();
  assert.notEqual(thirdStore, firstStore);
  assert.equal(thirdStore, "store-3");
  assert.equal(registry.getMainBootstrapService(), "bootstrap-4");
});
