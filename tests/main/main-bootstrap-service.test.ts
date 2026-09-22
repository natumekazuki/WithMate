import assert from "node:assert/strict";
import test from "node:test";

import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { MainBootstrapService } from "../../src-electron/app/main-bootstrap-service.js";

// @test-value v2
// kind = "contract"
// claim = "MainBootstrapServiceは保存データの初期化と中断回収の完了後にIPCを登録し、catalogを配信する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md: MainBootstrapService" }
// fault = "中断回収が完了する前にIPCを登録するか、catalogを配信する"
// observable = "bootstrap依存先の非同期呼び出し順"
// observation_boundary = "public-boundary"
// scope = "MainBootstrapService startup sequence"
// lifecycle = "permanent"
// impact = "未準備データがWindowから参照される"
// distinction = "型検査では検出できない中断回収の完了とIPC登録の順序を確認する"
// @end-test-value
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
    "broadcastModelCatalog:1",
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Growth timer互換APIは起動依存先を呼ばないno-opとして残る"
// oracle = { type = "contract", ref = "src-electron/app/main-bootstrap-service.ts: Growth timer compatibility API" }
// fault = "互換API呼び出しでMate stateなどの起動依存先を参照する"
// observable = "依存先の例外なしに互換API呼び出しが完了すること"
// observation_boundary = "public-boundary"
// scope = "MainBootstrapService Growth timer API"
// lifecycle = "permanent"
// @end-test-value
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
    broadcastModelCatalog() {},
  });

  await service.ensureGrowthApplyTimer();
  await service.restartGrowthApplyTimer();
  service.clearGrowthApplyTimer();
  service.clearGrowthApplyTimerForTest();
});
