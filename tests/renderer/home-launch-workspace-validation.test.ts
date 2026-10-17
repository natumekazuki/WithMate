import assert from "node:assert/strict";
import { it } from "node:test";

import { createDirectoryPathValidationController } from "../../src/launch/directory-path-validation.js";
import {
  applyLaunchWorkspacePathValidation,
  beginLaunchWorkspacePathValidation,
  createClosedLaunchDraft,
  markLaunchWorkspacePathValidationPending,
  setLaunchWorkspaceToSessionFolder,
} from "../../src/home/home-launch-state.js";
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

// @test-value v2
// kind = "contract"
// claim = "Session Folderへ切り替えた後の遅いパス検証は選択と入力を上書きしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session Workspace選択" }
// fault = "古いdirectoryの検証完了がSession Folder選択を元に戻す"
// observable = "検証Promiseを遅延させ切替後に解決したHome launch draftのworkspaceと入力・検証状態"
// observation_boundary = "consumer"
// scope = "HomeのWorkspace選択と共有検証controllerの接続"
// lifecycle = "permanent"
// distinction = "controller単体では検出しないHomeの選択stateへの遅延結果反映を少数の状態操作で確認する"
// @end-test-value
it("SessionFolder への切替後は in-flight validation が workspace draft を上書きしない", async () => {
  const validation = deferred<WorkspaceDirectoryValidationResult>();
  let draft = createClosedLaunchDraft();
  const controller = createDirectoryPathValidationController({
    delayMs: 0,
    validate: () => validation.promise,
    onScheduled: (targetPath) => {
      draft = beginLaunchWorkspacePathValidation(draft, targetPath);
    },
    onValidationStart: (targetPath) => {
      draft = markLaunchWorkspacePathValidationPending(draft, targetPath);
    },
    onResult: (targetPath, result) => {
      draft = applyLaunchWorkspacePathValidation(draft, targetPath, result);
    },
  });

  controller.schedule("C:\\old-workspace");
  await flush();
  assert.equal(draft.workspaceValidation, "pending");

  controller.cancel();
  draft = setLaunchWorkspaceToSessionFolder(draft);
  validation.resolve({ valid: true });
  await flush();

  assert.deepEqual(draft.workspace, { kind: "session-folder" });
  assert.equal(draft.workspaceValidation, "idle");
  assert.equal(draft.workspacePathInput, "");
});
