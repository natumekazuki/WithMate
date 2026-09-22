import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CharacterWorkspaceOperationCoordinator } from "../../src-electron/character/character-workspace-operation-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("CharacterWorkspaceOperationCoordinator", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "同じ Character key のworkspace operationを直列化し、別keyは並行受付する"
  // oracle = { type = "contract", ref = "src-electron/character-workspace-operation-coordinator.ts#runExclusive" }
  // fault = "同一keyのoperationが重なり、別keyのoperationまで不要に待機する"
  // observable = "同一 key の後続 operation が先行 operation の解放まで実行されないこと"
  // observation_boundary = "public-boundary"
  // scope = "character-workspace-admission"
  // lifecycle = "permanent"
  // impact = "Character単位のworkspace operation順序を保つ"
  // distinction = "同一 key は待機し、別 key は待機しないため、全体 provider lock ではなく Character 単位の admission を確認する"
  // @end-test-value
  it("同じ Character key は直列化し、別 key は並行できる", async () => {
    const coordinator = new CharacterWorkspaceOperationCoordinator();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = coordinator.runExclusive("char-1", async () => {
      events.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first-exit");
    });
    await firstEntered.promise;

    const sameKey = coordinator.runExclusive("char-1", async () => {
      events.push("same-key");
    });
    const otherKey = coordinator.runExclusive("char-2", async () => {
      events.push("other-key");
    });

    await otherKey;
    assert.deepEqual(events, ["first-enter", "other-key"]);
    releaseFirst.resolve();
    await Promise.all([first, sameKey]);
    assert.deepEqual(events, ["first-enter", "other-key", "first-exit", "same-key"]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "maintenance は新規workspace operationを拒否し、既存operationのdrain後に実行する"
  // oracle = { type = "contract", ref = "src-electron/character-workspace-operation-coordinator.ts#runMaintenance" }
  // fault = "reset が workspace write と並行して実行されるか、maintenance 後の新規 authoring write が silently queue される"
  // observable = "maintenance 中の新規受付拒否、既存 operation の完了後の maintenance 実行、完了後の再受付"
  // observation_boundary = "public-boundary"
  // scope = "character-workspace-maintenance"
  // lifecycle = "permanent"
  // impact = "maintenanceとworkspace operationの順序を保証する"
  // distinction = "maintenance 開始後に呼んだ write は待機せず拒否され、完了後だけ再び受け付ける"
  // @end-test-value
  it("maintenance は既存 write を drain してから実行し、完了後に再受付する", async () => {
    const coordinator = new CharacterWorkspaceOperationCoordinator();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const write = coordinator.runExclusive("char-1", async () => {
      events.push("write-enter");
      entered.resolve();
      await release.promise;
      events.push("write-exit");
    });
    await entered.promise;

    const maintenance = coordinator.runMaintenance(async () => {
      events.push("maintenance");
    });
    await assert.rejects(
      () => coordinator.runExclusive("char-2", () => undefined),
      /maintenance.*実行中/,
    );
    await Promise.resolve();
    assert.deepEqual(events, ["write-enter"]);
    release.resolve();
    await Promise.all([write, maintenance]);
    assert.deepEqual(events, ["write-enter", "write-exit", "maintenance"]);
    await coordinator.runExclusive("char-2", () => {
      events.push("after-maintenance");
    });
    assert.equal(events.at(-1), "after-maintenance");
  });
});
