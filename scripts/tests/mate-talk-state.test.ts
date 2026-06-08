import assert from "node:assert/strict";
import test from "node:test";

import {
  beginMateTalkTurnSubmission,
  buildMateTalkAssistantMessage,
  buildMateTalkErrorMessage,
  buildMateTalkTurnInput,
  buildMateTalkUserMessage,
  MateTalkTurnController,
  resolveMateTalkActionDockExpandedAfterSubmit,
  resolveMateTalkAssistantTurnUpdate,
  resolveMateTalkErrorTurnUpdate,
  resolveMateTalkSubmitPreflight,
  shouldApplyMateTalkTurnUpdate,
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

test("shouldApplyMateTalkTurnUpdate は最新 turn だけ true を返す", () => {
  const controller = new MateTalkTurnController();
  const firstTurn = controller.beginTurn();
  const secondTurn = controller.beginTurn();

  assert.equal(
    shouldApplyMateTalkTurnUpdate({
      controller,
      turnId: firstTurn.turnId,
    }),
    false,
  );
  assert.equal(
    shouldApplyMateTalkTurnUpdate({
      controller,
      turnId: secondTurn.turnId,
    }),
    true,
  );
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
      isRunning: false,
    }),
    {
      status: "blocked",
      reason: "empty",
      feedback: "入力してから送信してね。",
    },
  );
});

test("resolveMateTalkSubmitPreflight は running 中なら blocked にする", () => {
  assert.deepEqual(
    resolveMateTalkSubmitPreflight({
      draft: " hello ",
      isRunning: true,
    }),
    {
      status: "blocked",
      reason: "running",
    },
  );
});

test("resolveMateTalkSubmitPreflight は送信可能な本文を trim して返す", () => {
  assert.deepEqual(
    resolveMateTalkSubmitPreflight({
      draft: " hello ",
      isRunning: false,
    }),
    {
      status: "ready",
      message: "hello",
    },
  );
});

test("buildMateTalkTurnInput は MateTalk turn payload を組み立てる", () => {
  assert.deepEqual(
    buildMateTalkTurnInput({
      message: "hello",
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      attachments: [{ path: "src/App.tsx", kind: "file" }],
      additionalDirectories: ["docs"],
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
    }),
    {
      message: "hello",
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      attachments: [{ path: "src/App.tsx", kind: "file" }],
      additionalDirectories: ["docs"],
      approvalMode: "on-request",
      codexSandboxMode: "workspace-write",
    },
  );
});

test("buildMateTalkTurnInput は sandbox mode がない場合 payload から省く", () => {
  assert.deepEqual(
    buildMateTalkTurnInput({
      message: "hello",
      provider: "local",
      model: "text",
      reasoningEffort: "low",
      attachments: [],
      additionalDirectories: [],
      approvalMode: "never",
      codexSandboxMode: undefined,
    }),
    {
      message: "hello",
      provider: "local",
      model: "text",
      reasoningEffort: "low",
      attachments: [],
      additionalDirectories: [],
      approvalMode: "never",
    },
  );
});

test("buildMateTalkUserMessage は user message id と本文を組み立てる", () => {
  assert.deepEqual(
    buildMateTalkUserMessage({
      messageSequence: 3,
      text: "hello",
    }),
    {
      id: "user-3",
      role: "user",
      text: "hello",
    },
  );
});

test("beginMateTalkTurnSubmission は turn state と user message を組み立てる", () => {
  const controller = new MateTalkTurnController();

  assert.deepEqual(
    beginMateTalkTurnSubmission({
      controller,
      message: "hello",
    }),
    {
      turnId: 1,
      messageSequence: 1,
      userMessage: {
        id: "user-1",
        role: "user",
        text: "hello",
      },
    },
  );
});

test("buildMateTalkAssistantMessage は mate message id と本文を組み立てる", () => {
  assert.deepEqual(
    buildMateTalkAssistantMessage({
      messageSequence: 3,
      text: "hi",
    }),
    {
      id: "mate-3",
      role: "mate",
      text: "hi",
    },
  );
});

test("buildMateTalkErrorMessage は Error message を優先する", () => {
  assert.deepEqual(
    buildMateTalkErrorMessage({
      messageSequence: 3,
      error: new Error("failed"),
    }),
    {
      id: "mate-error-3",
      role: "mate",
      text: "failed",
    },
  );
});

test("buildMateTalkErrorMessage は Error 以外なら fallback を返す", () => {
  assert.deepEqual(
    buildMateTalkErrorMessage({
      messageSequence: 3,
      error: "failed",
    }),
    {
      id: "mate-error-3",
      role: "mate",
      text: "返信に失敗したよ。",
    },
  );
});

test("resolveMateTalkAssistantTurnUpdate は最新 turn の assistant message を返す", () => {
  const controller = new MateTalkTurnController();
  const turn = controller.beginTurn();

  assert.deepEqual(
    resolveMateTalkAssistantTurnUpdate({
      controller,
      turnId: turn.turnId,
      messageSequence: turn.messageSequence,
      text: "hi",
    }),
    {
      status: "ready",
      message: {
        id: "mate-1",
        role: "mate",
        text: "hi",
      },
    },
  );
});

test("resolveMateTalkAssistantTurnUpdate は stale turn なら stale を返す", () => {
  const controller = new MateTalkTurnController();
  const turn = controller.beginTurn();
  controller.beginTurn();

  assert.deepEqual(
    resolveMateTalkAssistantTurnUpdate({
      controller,
      turnId: turn.turnId,
      messageSequence: turn.messageSequence,
      text: "hi",
    }),
    { status: "stale" },
  );
});

test("resolveMateTalkErrorTurnUpdate は最新 turn の error message を返す", () => {
  const controller = new MateTalkTurnController();
  const turn = controller.beginTurn();

  assert.deepEqual(
    resolveMateTalkErrorTurnUpdate({
      controller,
      turnId: turn.turnId,
      messageSequence: turn.messageSequence,
      error: new Error("failed"),
    }),
    {
      status: "ready",
      message: {
        id: "mate-error-1",
        role: "mate",
        text: "failed",
      },
    },
  );
});

test("resolveMateTalkErrorTurnUpdate は stale turn なら stale を返す", () => {
  const controller = new MateTalkTurnController();
  const turn = controller.beginTurn();
  controller.beginTurn();

  assert.deepEqual(
    resolveMateTalkErrorTurnUpdate({
      controller,
      turnId: turn.turnId,
      messageSequence: turn.messageSequence,
      error: new Error("failed"),
    }),
    { status: "stale" },
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
