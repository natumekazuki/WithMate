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
/** 永続化の初期化と非同期の中断回収が終わるまでIPC登録を待ち、初期化で得たカタログを最後に配信する。 */
test("MainBootstrapService は runtime side effect なしで起動シーケンスを順に実行する", async () => {
  const calls: string[] = [];
  const activeModelCatalog = { providers: [] } satisfies ModelCatalogSnapshot;

  const service = new MainBootstrapService({
    /** Mateが稼働中の状態を返し、起動処理がこの参照を呼んだ場合も記録する。 */
    getMateState() {
      calls.push("getMateState");
      return "active";
    },
    /** 永続ストアの初期化を記録し、後で配信内容と照合するカタログを返す。 */
    async initializePersistentStores() {
      calls.push("initializePersistentStores");
      return activeModelCatalog;
    },
    /** 回収の開始と完了を別々に記録し、未完了のままIPCが登録される回帰を検出できるようにする。 */
    async recoverInterruptedSessions() {
      calls.push("recoverInterruptedSessions:start");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      calls.push("recoverInterruptedSessions:end");
    },
    /** IPC登録が中断回収の完了後かどうかを呼び出し順に残す。 */
    registerIpcHandlers() {
      calls.push("registerIpcHandlers");
    },
    /** 初期化で得たカタログそのものが配信されることを確かめ、配信の位置を記録する。 */
    broadcastModelCatalog(snapshot) {
      assert.equal(snapshot, activeModelCatalog);
      calls.push("broadcastModelCatalog");
    },
  });

  await service.handleReady();

  assert.deepEqual(calls, [
    "initializePersistentStores",
    "recoverInterruptedSessions:start",
    "recoverInterruptedSessions:end",
    "registerIpcHandlers",
    "broadcastModelCatalog",
  ]);
});
