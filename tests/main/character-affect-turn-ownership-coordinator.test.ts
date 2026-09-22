import assert from "node:assert/strict";
import test from "node:test";

import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character/character-affect-turn-ownership-coordinator.js";

// @test-value v2
// kind = "invariant"
// claim = "Session削除は進行中appraisalの完了まで待つ"
// oracle = { type = "contract", ref = "Character Affect ownership coordinator contract" }
// fault = "削除がappraisalへ割り込み、owner-validated後のcommitを中断する"
// observable = "coordinator operation order"
// observation_boundary = "component-behavior"
// scope = "CharacterAffectTurnOwnershipCoordinator exclusive ordering"
// lifecycle = "permanent"
// @end-test-value
test("Session削除は進行中appraisalの完了まで待ち、appraise直前のowner検証後に割り込まない", async () => {
  const coordinator = new CharacterAffectTurnOwnershipCoordinator();
  let releaseAppraisal: () => void = () => { throw new Error("appraisal barrier was not initialized"); };
  const appraisalBarrier = new Promise<void>((resolve) => {
    releaseAppraisal = resolve;
  });
  const order: string[] = [];

  const appraisal = coordinator.runExclusive(async () => {
    order.push("owner-validated");
    await appraisalBarrier;
    order.push("appraisal-committed");
  });
  await Promise.resolve();
  const deletion = coordinator.runExclusive(async () => {
    order.push("session-deleted");
  });
  await Promise.resolve();

  assert.deepEqual(order, ["owner-validated"]);
  releaseAppraisal();
  await Promise.all([appraisal, deletion]);
  assert.deepEqual(order, ["owner-validated", "appraisal-committed", "session-deleted"]);
});

// @test-value v2
// kind = "invariant"
// claim = "Session削除中は新しいappraisal attemptを開始しない"
// oracle = { type = "contract", ref = "Character Affect ownership coordinator contract" }
// fault = "削除中に新しいappraisalを開始し、削除後のownerへ書き込む"
// observable = "coordinator operation order"
// observation_boundary = "component-behavior"
// scope = "CharacterAffectTurnOwnershipCoordinator deletion serialization"
// lifecycle = "permanent"
// @end-test-value
test("Session削除中は新しいappraisal attemptを開始しない", async () => {
  const coordinator = new CharacterAffectTurnOwnershipCoordinator();
  let releaseDeletion: () => void = () => { throw new Error("deletion barrier was not initialized"); };
  const deletionBarrier = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });
  const order: string[] = [];

  const deletion = coordinator.runExclusive(async () => {
    order.push("delete-started");
    await deletionBarrier;
    order.push("session-deleted");
  });
  await Promise.resolve();
  const appraisal = coordinator.runExclusive(async () => {
    order.push("appraisal-started");
  });
  await Promise.resolve();

  assert.deepEqual(order, ["delete-started"]);
  releaseDeletion();
  await Promise.all([deletion, appraisal]);
  assert.deepEqual(order, ["delete-started", "session-deleted", "appraisal-started"]);
});
