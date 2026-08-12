import assert from "node:assert/strict";
import { it } from "node:test";

import { createHomeLaunchWorkspaceValidationController } from "../../src/home/home-launch-workspace-validation.js";
import {
  applyLaunchWorkspacePathValidation,
  beginLaunchWorkspacePathValidation,
  createClosedLaunchDraft,
  markLaunchWorkspacePathValidationPending,
  setLaunchWorkspaceToSessionFolder,
} from "../../src/home/home-launch-state.js";
import type { WorkspaceDirectoryValidationResult } from "../../src/workspace-directory-validation.js";

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

it("workspace validation は debounce 中の keystroke ごとに filesystem 境界を呼ばない", async () => {
  const calls: string[] = [];
  const scheduled: string[] = [];
  const started: string[] = [];
  const controller = createHomeLaunchWorkspaceValidationController({
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

it("workspace validation は古い response と cancel 後の response を反映しない", async () => {
  const first = deferred<WorkspaceDirectoryValidationResult>();
  const second = deferred<WorkspaceDirectoryValidationResult>();
  const cancelled = deferred<WorkspaceDirectoryValidationResult>();
  const results: string[] = [];
  const controller = createHomeLaunchWorkspaceValidationController({
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

it("SessionFolder への切替後は in-flight validation が workspace draft を上書きしない", async () => {
  const validation = deferred<WorkspaceDirectoryValidationResult>();
  let draft = createClosedLaunchDraft();
  const controller = createHomeLaunchWorkspaceValidationController({
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
