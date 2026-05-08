import assert from "node:assert/strict";
import test from "node:test";

import { HomeMateTalkTurnController, shouldSubmitMateTalkInputByKey } from "../../src/home-mate-talk-state.js";

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

test("shouldSubmitMateTalkInputByKey は Enter 単体では送信しない", () => {
  assert.equal(
    shouldSubmitMateTalkInputByKey({
      key: "Enter",
    }),
    false,
  );
});

test("shouldSubmitMateTalkInputByKey は Shift+Enter では送信しない", () => {
  assert.equal(
    shouldSubmitMateTalkInputByKey({
      key: "Enter",
      shiftKey: true,
    }),
    false,
  );
});

test("shouldSubmitMateTalkInputByKey は Ctrl+Enter で送信する", () => {
  assert.equal(
    shouldSubmitMateTalkInputByKey({
      key: "Enter",
      ctrlKey: true,
    }),
    true,
  );
});

test("shouldSubmitMateTalkInputByKey は Meta+Enter で送信する", () => {
  assert.equal(
    shouldSubmitMateTalkInputByKey({
      key: "Enter",
      metaKey: true,
    }),
    true,
  );
});

test("shouldSubmitMateTalkInputByKey は composing 中は送信しない", () => {
  assert.equal(
    shouldSubmitMateTalkInputByKey({
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    }),
    false,
  );
});
