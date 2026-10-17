import assert from "node:assert/strict";
import { it } from "node:test";

import { createDirectoryPathValidationController } from "../../src/launch/directory-path-validation.js";
import type { WorkspaceDirectoryValidationResult } from "../../src-shared/window/workspace-directory-validation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
it("workspace validation は debounce 中の keystroke ごとに filesystem 境界を呼ばない", async () => {
  const calls: string[] = [];
  const scheduled: string[] = [];
  const started: string[] = [];
  const controller = createDirectoryPathValidationController({
    delayMs: 15,
    validate: async (targetPath) => {
      calls.push(targetPath);
      return { valid: true };
    },
    onScheduled: (targetPath) => scheduled.push(targetPath),
    onValidationStart: (targetPath) => started.push(targetPath),
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
it("workspace validation は古い response と cancel 後の response を反映しない", async () => {
  const first = deferred<WorkspaceDirectoryValidationResult>();
  const second = deferred<WorkspaceDirectoryValidationResult>();
  const cancelled = deferred<WorkspaceDirectoryValidationResult>();
  const results: string[] = [];
  const controller = createDirectoryPathValidationController({
    delayMs: 0,
    validate: (targetPath) => targetPath.endsWith("first")
      ? first.promise
      : targetPath.endsWith("cancelled")
        ? cancelled.promise
        : second.promise,
    onScheduled: () => {},
    onValidationStart: () => {},
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
