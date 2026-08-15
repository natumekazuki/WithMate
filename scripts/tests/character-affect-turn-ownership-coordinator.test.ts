import assert from "node:assert/strict";
import test from "node:test";

import { CharacterAffectTurnOwnershipCoordinator } from "../../src-electron/character-affect-turn-ownership-coordinator.js";

test("Session削除は進行中appraisalの完了まで待ち、appraise直前のowner検証後に割り込まない", async () => {
  const coordinator = new CharacterAffectTurnOwnershipCoordinator();
  let releaseAppraisal: (() => void) | null = null;
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
  assert.ok(releaseAppraisal);
  releaseAppraisal();
  await Promise.all([appraisal, deletion]);
  assert.deepEqual(order, ["owner-validated", "appraisal-committed", "session-deleted"]);
});

test("Session削除中は新しいappraisal attemptを開始しない", async () => {
  const coordinator = new CharacterAffectTurnOwnershipCoordinator();
  let releaseDeletion: (() => void) | null = null;
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
  assert.ok(releaseDeletion);
  releaseDeletion();
  await Promise.all([deletion, appraisal]);
  assert.deepEqual(order, ["delete-started", "session-deleted", "appraisal-started"]);
});
