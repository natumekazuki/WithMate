import assert from "node:assert/strict";
import test from "node:test";

import {
  MateTalkTurnController,
  resolveMateTalkActionDockExpandedAfterSubmit,
  resolveMateTalkSubmitPreflight,
  shouldSubmitMateTalkInputByKey,
} from "../../src/chat/mate-talk-state.js";

test("MateTalkTurnController は beginTurn で turnId と messageSequence を増やす", () => {
  const controller = new MateTalkTurnController();
  const first = controller.beginTurn();
  const second = controller.beginTurn();

  assert.equal(first.turnId, 1);
  assert.equal(first.messageSequence, 1);
  assert.equal(second.turnId, 2);
  assert.equal(second.messageSequence, 2);
});

test("MateTalkTurnController は invalidateTurns 後に前の turnId が stale になる", () => {
  const controller = new MateTalkTurnController();
  const firstTurn = controller.beginTurn();

  controller.invalidateTurns();

  const secondTurn = controller.beginTurn();
  assert.equal(controller.isLatestTurn(firstTurn.turnId), false);
  assert.equal(controller.isLatestTurn(secondTurn.turnId), true);
});

test("MateTalkTurnController は invalidateTurns で messageSequence を進めない", () => {
  const controller = new MateTalkTurnController();
  const firstTurn = controller.beginTurn();

  controller.invalidateTurns();

  const secondTurn = controller.beginTurn();
  assert.equal(firstTurn.messageSequence, 1);
  assert.equal(secondTurn.messageSequence, 2);
});

test("MateTalkTurnController は新規 turn が旧 turn を stale として扱う", () => {
  const controller = new MateTalkTurnController();
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

test("resolveMateTalkSubmitPreflight は空入力を feedback 付き blocked にする", () => {
  assert.deepEqual(
    resolveMateTalkSubmitPreflight({
      draft: "  \n ",
      sending: false,
    }),
    {
      status: "blocked",
      reason: "empty",
      feedback: "入力してから送信してね。",
    },
  );
});

test("resolveMateTalkSubmitPreflight は送信中なら blocked にする", () => {
  assert.deepEqual(
    resolveMateTalkSubmitPreflight({
      draft: " hello ",
      sending: true,
    }),
    {
      status: "blocked",
      reason: "sending",
    },
  );
});

test("resolveMateTalkSubmitPreflight は送信可能な本文を trim して返す", () => {
  assert.deepEqual(
    resolveMateTalkSubmitPreflight({
      draft: " hello ",
      sending: false,
    }),
    {
      status: "ready",
      message: "hello",
    },
  );
});

test("resolveMateTalkActionDockExpandedAfterSubmit は自動格納設定が有効なら送信時に閉じる", () => {
  assert.equal(
    resolveMateTalkActionDockExpandedAfterSubmit({
      isActionDockExpanded: true,
      appSettings: { autoCollapseActionDockOnSend: true },
    }),
    false,
  );
});

test("resolveMateTalkActionDockExpandedAfterSubmit は自動格納設定が無効なら現在の状態を保つ", () => {
  assert.equal(
    resolveMateTalkActionDockExpandedAfterSubmit({
      isActionDockExpanded: true,
      appSettings: { autoCollapseActionDockOnSend: false },
    }),
    true,
  );
  assert.equal(
    resolveMateTalkActionDockExpandedAfterSubmit({
      isActionDockExpanded: false,
      appSettings: { autoCollapseActionDockOnSend: false },
    }),
    false,
  );
});
