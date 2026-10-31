import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CharacterWorkspaceOperationCoordinator } from "../../src-electron/character/character-workspace-operation-coordinator.js";
import { CharacterStorage } from "../../src-electron/character/character-storage.js";
import { CharacterService } from "../../src-electron/character/character-service.js";
import type { CharacterRuntimeSnapshot } from "../../src-shared/character/character-catalog.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("CharacterWorkspaceOperationCoordinator", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "送信snapshotのrefreshは同一Characterの定義編集とarchiveに対して直列化される"
  // oracle = { type = "contract", ref = "docs/design/character-storage.md#runtime-snapshot" }
  // fault = "serviceがrefreshをworkspace admission外で実行して編集またはarchiveを追い越す"
  // observable = "refresh中と解放後に取得したcanonical本文・catalog stateとrefreshの結果"
  // observation_boundary = "public-boundary"
  // scope = "character-service-refresh-admission"
  // lifecycle = "permanent"
  // impact = "app内編集と送信の競合で定義の選択が不定になることを防ぐ"
  // distinction = "coordinator単体testではCharacterServiceのrefreshと編集の共有admissionを確認できない"
  // @end-test-value
  it("refreshが完了するまで同一Characterの定義編集とarchiveを待機させる", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "withmate-refresh-admission-"));
    const entered = deferred();
    const release = deferred();
    class PausedRefreshStorage extends CharacterStorage {
      override async refreshRuntimeSnapshot(id: string, previous: CharacterRuntimeSnapshot | null): Promise<CharacterRuntimeSnapshot> {
        entered.resolve();
        await release.promise;
        return super.refreshRuntimeSnapshot(id, previous);
      }
    }
    const storage = new PausedRefreshStorage(path.join(temporaryRoot, "withmate-v4.db"), temporaryRoot);
    try {
      const character = await storage.createCharacter({ name: "Mia" });
      const previous = await storage.createRuntimeSnapshot(character.id);
      assert.ok(previous);
      const service = new CharacterService(storage);
      const refresh = service.refreshRuntimeSnapshot(character.id, previous);
      await entered.promise;
      const changed = character.definitionMarkdown + "\n- edited instruction\n";
      const edit = service.updateCharacterDefinition({ characterId: character.id, definitionMarkdown: changed });
      const archive = service.archiveCharacter(character.id);
      await Promise.resolve();
      assert.equal((await storage.getCharacter(character.id))?.definitionMarkdown, character.definitionMarkdown);
      assert.equal(storage.getCharacterCatalogEntry(character.id)?.state, "active");
      release.resolve();
      assert.deepEqual(await refresh, previous);
      await Promise.all([edit, archive]);
      assert.equal((await storage.getCharacter(character.id))?.definitionMarkdown, changed);
      assert.equal(storage.getCharacterCatalogEntry(character.id)?.state, "archived");
    } finally {
      release.resolve();
      storage.close();
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

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
      /Character workspace maintenance is already running\./,
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
