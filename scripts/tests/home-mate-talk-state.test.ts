import assert from "node:assert/strict";
import test from "node:test";

import { HomeMateTalkTurnController } from "../../src/home-mate-talk-state.js";

test("HomeMateTalkTurnController は beginTurn で turnId と messageSequence を増やす", () => {
  const controller = new HomeMateTalkTurnController();
  const first = controller.beginTurn();
  const second = controller.beginTurn();

  assert.equal(first.turnId, 1);
  assert.equal(first.messageSequence, 1);
  assert.equal(second.turnId, 2);
  assert.equal(second.messageSequence, 2);
});

test("HomeMateTalkTurnController は invalidateTurns 後に前の turnId が stale になる", () => {
  const controller = new HomeMateTalkTurnController();
  const firstTurn = controller.beginTurn();

  controller.invalidateTurns();

  const secondTurn = controller.beginTurn();
  assert.equal(controller.isLatestTurn(firstTurn.turnId), false);
  assert.equal(controller.isLatestTurn(secondTurn.turnId), true);
});

test("HomeMateTalkTurnController は invalidateTurns で messageSequence を進めない", () => {
  const controller = new HomeMateTalkTurnController();
  const firstTurn = controller.beginTurn();

  controller.invalidateTurns();

  const secondTurn = controller.beginTurn();
  assert.equal(firstTurn.messageSequence, 1);
  assert.equal(secondTurn.messageSequence, 2);
});

test("HomeMateTalkTurnController は新規 turn が旧 turn を stale として扱う", () => {
  const controller = new HomeMateTalkTurnController();
  const firstTurn = controller.beginTurn();
  const secondTurn = controller.beginTurn();

  assert.equal(controller.isLatestTurn(firstTurn.turnId), false);
  assert.equal(controller.isLatestTurn(secondTurn.turnId), true);
});
