import assert from "node:assert/strict";
import test from "node:test";

import { createAppLifecycleDeps } from "../../src-electron/app/app-lifecycle-deps.js";

// @test-value v2
// kind = "contract"
// claim = "main compositionから渡したruntime stop callbackと通常終了依存をlifecycleから呼び出せる"
// oracle = { type = "adr", ref = "ADR-023 multi-instance-runtime-discovery" }
// fault = "compositionがruntime stopまたは通常終了callbackを欠落させる"
// observable = "返却依存を呼んだ際のcallback記録とgetter戻り値"
// observation_boundary = "component-behavior"
// scope = "application-lifecycle-composition"
// lifecycle = "permanent"
// @end-test-value
/** 終了依存を組み立てた後も、実行中判定や終了可否を取得でき、ランタイム停止と永続ストア終了まで元の操作に届くことを確認する。 */
test("createAppLifecycleDeps はruntime stopを含む引数をAppLifecycleService依存へ詰める", async () => {
  const calls: string[] = [];
  const deps = createAppLifecycleDeps({
    /** 実行中のセッションがある状態を返す。 */
    hasInFlightSessionRuns: () => true,
    /** 実行中の終了を既定で許可しない状態を返す。 */
    getAllowQuitWithInFlightRuns: () => false,
    /** 終了を許可する設定が渡されたことを値付きで記録する。 */
    setAllowQuitWithInFlightRuns(value) {
      calls.push(`set:${value}`);
    },
    /** ホーム画面の作成要求を記録する。 */
    async createHomeWindow() {
      calls.push("home");
    },
    /** アプリの終了要求を記録する。 */
    quitApp() {
      calls.push("quit");
    },
    /** 全ウィンドウが閉じてもアプリを残す設定を返す。 */
    shouldQuitWhenAllWindowsClosed: () => false,
    /** 実行中の終了を確認画面で承認したものとして扱う。 */
    confirmQuitWhileRunning: () => true,
    /** 永続ストアの終了要求を記録する。 */
    closePersistentStores() {
      calls.push("close");
    },
    /** エージェントランタイムの停止要求を記録する。 */
    async stopAgentRuntime() {
      calls.push("stop-runtime");
    },
  });

  assert.equal(deps.hasInFlightSessionRuns(), true);
  assert.equal(deps.getAllowQuitWithInFlightRuns(), false);
  deps.setAllowQuitWithInFlightRuns(true);
  await deps.createHomeWindow();
  deps.quitApp();
  assert.equal(deps.shouldQuitWhenAllWindowsClosed(), false);
  assert.equal(deps.confirmQuitWhileRunning(), true);
  await deps.stopAgentRuntime?.();
  deps.closePersistentStores();
  assert.deepEqual(calls, [
    "set:true",
    "home",
    "quit",
    "stop-runtime",
    "close",
  ]);
});
