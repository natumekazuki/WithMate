import assert from "node:assert/strict";
import { it } from "node:test";

import { createDirectoryPathValidationController } from "../../src/launch/directory-path-validation.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

/** 検証応答をテストの任意の時点で返せるPromiseを用意する。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** 遅延ゼロで予約された検証を実行できるよう、タイマーの巡回を待つ。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// @test-value v2
// kind = "contract"
// claim = "パス検証は入力が続く間にfilesystem境界を呼ばず、停止後に最新のpathだけを検証する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: パス入力の事前検証" }
// fault = "keystrokeごとに検証する、または古いpathを検証する"
// observable = "schedule直後と待機後のvalidate callbackの呼出path配列"
// observation_boundary = "consumer"
// scope = "共有パス検証controllerのdebounce"
// lifecycle = "permanent"
// distinction = "型検査とcomponent描画では識別できない非同期呼出の集約を小さいtimerで検出する"
// @end-test-value
/** 連続したパス入力は逐次予約を通知するが、ファイルシステム境界へは落ち着いた後に最新値だけを渡す。 */
it("workspace validation は debounce 中の keystroke ごとに filesystem 境界を呼ばない", async () => {
  const calls: string[] = [];
  const scheduled: string[] = [];
  const started: string[] = [];
  const controller = createDirectoryPathValidationController({
    delayMs: 15,
    /** 実ファイルに触れず、検証境界へ届いたパスを控える。 */
    validate: async (targetPath) => {
      calls.push(targetPath);
      return { valid: true };
    },
    /** 入力のたびに予約されたパスを控える。 */
    onScheduled: (targetPath) => scheduled.push(targetPath),
    /** 実際に検証を開始したパスを控える。 */
    onValidationStart: (targetPath) => started.push(targetPath),
    /** この試験は開始までを観測するため、結果通知は使わない。 */
    onResult: () => {},
  });

  controller.schedule("C:\\w");
  controller.schedule("C:\\wo");
  controller.schedule("C:\\work");
  assert.deepEqual(calls, []);
  assert.deepEqual(scheduled, ["C:\\w", "C:\\wo", "C:\\work"]);
  assert.deepEqual(started, []);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, ["C:\\work"]);
  assert.deepEqual(started, ["C:\\work"]);
});

// @test-value v2
// kind = "contract"
// claim = "パス変更前やcancel前の遅い検証結果は現在の状態へ通知されない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: パス入力の事前検証" }
// fault = "古い無効結果が新しいpathの追加やSession開始を妨げる"
// observable = "順序を逆転・cancelしたPromise解決後のonResult通知path配列"
// observation_boundary = "consumer"
// scope = "共有パス検証controllerの世代と取消"
// lifecycle = "permanent"
// distinction = "通常成功のみの描画確認では観測できない応答の逆転と取消を制御したPromiseで確認する"
// @end-test-value
/** 最新の検証を先に完了させても、古い入力や取り消した入力の結果が通知されないことを確かめる。 */
it("workspace validation は古い response と cancel 後の response を反映しない", async () => {
  const first = deferred<WorkspaceDirectoryValidationResult>();
  const second = deferred<WorkspaceDirectoryValidationResult>();
  const cancelled = deferred<WorkspaceDirectoryValidationResult>();
  const results: string[] = [];
  const controller = createDirectoryPathValidationController({
    delayMs: 0,
    /** パスごとに保留中の応答を分け、テストから応答順を逆転させる。 */
    validate: (targetPath) =>
      targetPath.endsWith("first")
        ? first.promise
        : targetPath.endsWith("cancelled")
          ? cancelled.promise
          : second.promise,
    /** 予約時点の通知はこの競合試験の観測対象外とする。 */
    onScheduled: () => {},
    /** 検証の開始通知は観測せず、結果の通知だけを追う。 */
    onValidationStart: () => {},
    /** 有効性の結果を通知できたパスを記録する。 */
    onResult: (targetPath) => results.push(targetPath),
  });

  controller.schedule("C:\\first");
  await flush();
  controller.schedule("C:\\second");
  await flush();
  second.resolve({ valid: true });
  first.resolve({ valid: false, reason: "missing" });
  await flush();
  assert.deepEqual(results, ["C:\\second"]);

  controller.schedule("C:\\cancelled");
  await flush();
  controller.cancel();
  cancelled.resolve({ valid: true });
  await flush();
  assert.deepEqual(results, ["C:\\second"]);
});
