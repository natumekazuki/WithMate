import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { AuxiliaryDraftPersistenceOwner } from "../../src/chat/auxiliary-draft-persistence-owner.js";

describe("ComposerControllerRegistry", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Composer state is isolated by owner and no-op mutations do not advance revision"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "Main/Auxiliary drafts overwrite one another or identical input notifies subscribers"
  // observable = "owner-scoped draft/revision snapshots and listener notifications"
  // observation_boundary = "component-behavior"
  // scope = "composer-owner-controller"
  // lifecycle = "permanent"
  // @end-test-value
  it("keeps owner state separate and suppresses no-op notifications", () => {
    const registry = new ComposerControllerRegistry();
    const main = { kind: "main" as const, id: "main-1" };
    const auxiliary = { kind: "auxiliary" as const, id: "aux-1" };
    let notifications = 0;
    registry.subscribe(main, () => { notifications += 1; });

    assert.equal(registry.setDraft(main, "hello", { start: 5, end: 5 }), 1);
    assert.equal(registry.setDraft(main, "hello", { start: 5, end: 5 }), 1);
    assert.equal(notifications, 1);
    registry.setDraft(auxiliary, "auxiliary", { start: 9, end: 9 });

    assert.equal(registry.capture(main).draft, "hello");
    assert.equal(registry.capture(auxiliary).draft, "auxiliary");
    assert.equal(registry.capture(main).revision, 1);
    assert.equal(registry.capture(auxiliary).revision, 1);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Shutdown freeze is observable and blocks draft mutations until release"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "Close can acknowledge while a composer still accepts input"
  // observable = "freeze state, owner snapshot, and release notification"
  // observation_boundary = "component-behavior"
  // scope = "composer-owner-controller"
  // lifecycle = "permanent"
  // @end-test-value
  it("freezes owner mutations and releases them with a notification", () => {
    const registry = new ComposerControllerRegistry();
    const owner = { kind: "auxiliary" as const, id: "aux-1" };
    registry.setDraft(owner, "draft");
    let notifications = 0;
    registry.subscribe(owner, () => { notifications += 1; });
    registry.freeze();
    assert.equal(registry.isFrozen, true);
    assert.equal(registry.setDraft(owner, "blocked"), 1);
    assert.equal(registry.capture(owner).draft, "draft");
    registry.unfreeze();
    assert.equal(registry.isFrozen, false);
    assert.equal(registry.setDraft(owner, "released"), 2);
    assert.equal(registry.capture(owner).draft, "released");
    assert.equal(notifications, 3);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary draft persistence keeps one in-flight save and only the latest pending text"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "Older queued text overwrites a newer edit or flush returns before the newest save"
  // observable = "save inputs and flush completion"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-draft-persistence-owner"
  // lifecycle = "permanent"
  // @end-test-value
  it("keeps only the latest pending text and waits for flush", { timeout: 1000 }, async () => {
    let now = 0;
    const saves: string[] = [];
    let releaseFirstSave: (() => void) | null = null;
    let releaseSecondSave: (() => void) | null = null;
    let secondSaveStarted!: () => void;
    const secondSave = new Promise<void>((resolve) => { secondSaveStarted = resolve; });
    const owner = new AuxiliaryDraftPersistenceOwner({
      load: async () => ({ auxiliarySessionId: "a", parentSessionId: "p", incarnation: "i", durableRevision: 0, text: "", updatedAt: "" }),
      now: () => `t-${++now}`,
      debounceMs: 0,
      save: async (input) => {
        saves.push(input.text);
        await new Promise<void>((resolve) => {
          if (input.text === "A") releaseFirstSave = resolve;
          else {
            releaseSecondSave = resolve;
            secondSaveStarted();
          }
        });
        return { outcome: "saved" as const, record: { ...input, durableRevision: input.durableRevision + 1 } };
      },
    });
    const first = owner.enqueue("A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    owner.enqueue("AB");
    owner.enqueue("ABC");
    assert.deepEqual(saves, ["A"]);
    releaseFirstSave?.();
    await secondSave;
    assert.deepEqual(saves, ["A", "ABC"]);
    let flushCompleted = false;
    const flush = owner.flush().then(() => { flushCompleted = true; });
    await Promise.resolve();
    assert.equal(flushCompleted, false);
    releaseSecondSave?.();
    await flush;
    await first;
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Send clear and failure restore are revision guarded against ABA and follow-up input"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "An old send clears or restores a later edit with the same text"
  // observable = "owner draft and revision after guarded clear/restore"
  // observation_boundary = "public-boundary"
  // scope = "composer-send-lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  it("does not clear or restore after a newer revision", () => {
    const registry = new ComposerControllerRegistry();
    const owner = { kind: "main" as const, id: "main" };
    registry.setDraft(owner, "same");
    const capture = registry.capture(owner);
    registry.setDraft(owner, "intermediate");
    registry.setDraft(owner, "same");
    assert.equal(registry.clearIfRevision(owner, capture.revision), null);
    assert.equal(registry.capture(owner).draft, "same");
    const currentRevision = registry.capture(owner).revision;
    const cleared = registry.clearIfRevision(owner, currentRevision);
    assert.equal(cleared, currentRevision + 1);
    registry.setDraft(owner, "same");
    assert.equal(registry.restoreIfRevision(owner, cleared!, () => "old restore"), null);
    assert.equal(registry.capture(owner).draft, "same");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "A failed draft save retains the local latest value and permits explicit retry"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "A failed save is reported as success or silently discards the latest local draft"
  // observable = "save outcomes, retained pending text, and retry save input"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-draft-persistence-owner"
  // lifecycle = "permanent"
  // @end-test-value
  it("surfaces save failure and retries the latest value", async () => {
    let attempts = 0;
    let loads = 0;
    const saved: string[] = [];
    const owner = new AuxiliaryDraftPersistenceOwner({
      load: async () => {
        loads += 1;
        return { auxiliarySessionId: "a", parentSessionId: "p", incarnation: "i", durableRevision: 0, text: "", updatedAt: "" };
      },
      now: () => "now",
      debounceMs: 0,
      save: async (input) => {
        attempts += 1;
        if (attempts === 1) return { outcome: "stale" as const };
        if (attempts === 2) throw new Error("save outcome unknown");
        saved.push(input.text);
        return { outcome: "saved" as const, record: { ...input, durableRevision: input.durableRevision + 1 } };
      },
    });
    await assert.rejects(owner.enqueue("latest draft"));
    assert.equal(owner.hasPending, true);
    await assert.rejects(owner.flush(), /save outcome unknown/);
    assert.equal(owner.hasPending, true);
    await owner.flush();
    assert.deepEqual(saved, ["latest draft"]);
    assert.equal(loads, 3);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "失敗送信の復元はconsumeした版だけへ保存し、復元済値を受理しつつ後続の永続編集と別incarnationを保護する"
  // oracle = { type = "contract", ref = "docs/design/auxiliary-session.md#persistence" }
  // fault = "復元をflushから漏らす、保存障害でpendingを捨てる、または再取得した新しいdraftを古い送信値で上書きする"
  // observable = "flush成功/失敗、hasPending、永続recordと保存要求"
  // observation_boundary = "public-boundary"
  // scope = "auxiliary-failed-send-recovery"
  // lifecycle = "permanent"
  // distinction = "通常enqueueの集約testと異なり、Mainによるconsume/復元が保存owner外でrevisionを進めた後の限定復元を検証する"
  // @end-test-value
  it("recovers a consumed draft without overwriting a later durable edit", async () => {
    const captured = { auxiliarySessionId: "a", parentSessionId: "p", incarnation: "i", durableRevision: 4, text: "restore me", updatedAt: "before" };
    let durable = { ...captured, durableRevision: 5, text: "" };
    let failSave = true;
    const saves: number[] = [];
    const owner = new AuxiliaryDraftPersistenceOwner({
      load: async () => ({ ...durable }),
      now: () => "now",
      debounceMs: 0,
      save: async (record) => {
        saves.push(record.durableRevision);
        if (failSave) throw new Error("disk unavailable");
        assert.equal(record.durableRevision, durable.durableRevision);
        durable = { ...record, durableRevision: record.durableRevision + 1 };
        return { outcome: "saved", record: { ...durable } };
      },
    });
    const recovery = owner.enqueue(captured.text, captured);
    assert.equal(owner.hasPending, true);
    await assert.rejects(recovery, /disk unavailable/);
    assert.equal(owner.hasPending, true);
    failSave = false;
    await owner.flush();
    assert.equal(durable.text, captured.text);
    assert.equal(owner.hasPending, false);
    assert.deepEqual(saves, [5, 5]);

    await owner.enqueue(captured.text, captured);
    assert.equal(durable.durableRevision, 6, "a Main-restored value needs no additional write");
    durable = { ...durable, durableRevision: 7, text: "newer durable draft" };
    await assert.rejects(owner.enqueue(captured.text, captured), /changed after the failed send/);
    await assert.rejects(owner.flush(), /changed after the failed send/);
    assert.equal(durable.text, "newer durable draft");
    durable = { ...captured, incarnation: "replacement", durableRevision: 5, text: "" };
    await assert.rejects(owner.flush(), /changed after the failed send/);
    assert.equal(durable.incarnation, "replacement");
    assert.equal(durable.text, "");
    assert.deepEqual(saves, [5, 5]);
  });
});
