import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCancelRetryDraftReplace,
  applyRetryDraftRestoreCommand,
  applyRetryDraftReplaceConfirmation,
  applyRetryEditCommand,
  buildRetryDraftRestoreState,
  createCancelRetryDraftReplaceHandler,
  createRetryDraftReplaceConfirmationHandler,
  createRetryEditHandler,
  isRetryActionDisabled,
  resolveRetryBannerKind,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
} from "../../src/chat/retry-state.js";

test("buildRetryDraftRestoreState は retry 編集復元時の composer state を作る", () => {
  const restoreState = buildRetryDraftRestoreState("前回の依頼");

  assert.deepEqual(restoreState, {
    draft: "前回の依頼",
    caret: 5,
    isRetryDraftReplacePending: false,
    isActionDockPinnedExpanded: true,
  });
});

test("runRetryResendCommand は有効な last user message だけ再送する", async () => {
  const sends: string[] = [];

  await runRetryResendCommand({
    isDisabled: true,
    messageText: "前回の依頼",
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });
  await runRetryResendCommand({
    isDisabled: false,
    messageText: null,
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });
  await runRetryResendCommand({
    isDisabled: false,
    messageText: "前回の依頼",
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });
  await runRetryResendCommand({
    isDisabled: false,
    messageText: "",
    resendMessage: async (messageText) => {
      sends.push(messageText);
    },
  });

  assert.deepEqual(sends, ["前回の依頼", ""]);
});

test("applyRetryDraftRestoreCommand は retry draft restore state を UI setter に適用する", () => {
  const events: string[] = [];

  applyRetryDraftRestoreCommand({
    messageText: "前回の依頼",
    setActionDockPinnedExpanded: (expanded) => events.push(`expanded:${expanded}`),
    setDraft: (draft) => events.push(`draft:${draft}`),
    setCaret: (caret) => events.push(`caret:${caret}`),
    syncCaret: (caret) => events.push(`sync:${caret}`),
    setRetryDraftReplacePending: (pending) => events.push(`pending:${pending}`),
    focusComposer: (caret) => events.push(`focus:${caret}`),
  });

  assert.deepEqual(events, [
    "expanded:true",
    "draft:前回の依頼",
    "caret:5",
    "sync:5",
    "pending:false",
    "focus:5",
  ]);
});

test("applyRetryEditCommand は保護確認または draft 復元を選ぶ", () => {
  const events: string[] = [];

  applyRetryEditCommand({
    isDisabled: true,
    messageText: "前回の依頼",
    shouldProtectDraft: false,
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: null,
    shouldProtectDraft: false,
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: "前回の依頼",
    shouldProtectDraft: true,
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: "前回の依頼",
    shouldProtectDraft: false,
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });
  applyRetryEditCommand({
    isDisabled: false,
    messageText: "",
    shouldProtectDraft: false,
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });

  assert.deepEqual(events, ["confirm", "restore:前回の依頼", "restore:"]);
});

test("createRetryEditHandler は retry edit handler を作る", () => {
  const events: string[] = [];
  const editLastMessage = createRetryEditHandler({
    isDisabled: false,
    messageText: "前回の依頼",
    shouldProtectDraft: false,
    requestDraftReplaceConfirmation: () => events.push("confirm"),
    restoreDraft: (messageText) => events.push(`restore:${messageText}`),
  });

  editLastMessage();

  assert.deepEqual(events, ["restore:前回の依頼"]);
});

test("applyRetryDraftReplaceConfirmation は有効な retry edit だけ draft を復元する", () => {
  const events: string[] = [];

  applyRetryDraftReplaceConfirmation({
    isDisabled: true,
    messageText: "前回の依頼",
    restoreDraft: (messageText) => events.push(messageText),
  });
  applyRetryDraftReplaceConfirmation({
    isDisabled: false,
    messageText: undefined,
    restoreDraft: (messageText) => events.push(messageText),
  });
  applyRetryDraftReplaceConfirmation({
    isDisabled: false,
    messageText: "前回の依頼",
    restoreDraft: (messageText) => events.push(messageText),
  });
  applyRetryDraftReplaceConfirmation({
    isDisabled: false,
    messageText: "",
    restoreDraft: (messageText) => events.push(messageText),
  });

  assert.deepEqual(events, ["前回の依頼", ""]);
});

test("createRetryDraftReplaceConfirmationHandler は retry draft replace confirmation handler を作る", () => {
  const events: string[] = [];
  const confirmRetryDraftReplace = createRetryDraftReplaceConfirmationHandler({
    isDisabled: false,
    messageText: "前回の依頼",
    restoreDraft: (messageText) => events.push(messageText),
  });

  confirmRetryDraftReplace();

  assert.deepEqual(events, ["前回の依頼"]);
});

test("applyCancelRetryDraftReplace は retry draft replace pending を解除する", () => {
  const values: boolean[] = [];

  applyCancelRetryDraftReplace({
    setRetryDraftReplacePending: (pending) => values.push(pending),
  });

  assert.deepEqual(values, [false]);
});

test("createCancelRetryDraftReplaceHandler は retry draft replace cancel handler を作る", () => {
  const values: boolean[] = [];
  const cancelRetryDraftReplace = createCancelRetryDraftReplaceHandler({
    setRetryDraftReplacePending: (pending) => values.push(pending),
  });

  cancelRetryDraftReplace();

  assert.deepEqual(values, [false]);
});

test("resolveRetryBannerKind は session state と terminal audit log から retry 種別を解決する", () => {
  assert.equal(resolveRetryBannerKind({ runState: "interrupted" }), "interrupted");
  assert.equal(resolveRetryBannerKind({ runState: "error" }), "failed");
  assert.equal(resolveRetryBannerKind({ runState: "idle", latestTerminalAuditLogPhase: "canceled" }), "canceled");
  assert.equal(resolveRetryBannerKind({ runState: "idle", latestTerminalAuditLogPhase: "completed" }), null);
});

test("shouldProtectRetryEditDraft は既存 draft の暗黙上書きを避ける", () => {
  const retryBanner = { lastRequestText: "前回の依頼" };

  assert.equal(shouldProtectRetryEditDraft({ retryBanner, draft: "" }), false);
  assert.equal(shouldProtectRetryEditDraft({ retryBanner, draft: "前回の依頼" }), false);
  assert.equal(shouldProtectRetryEditDraft({ retryBanner, draft: "今の下書き" }), true);
  assert.equal(shouldProtectRetryEditDraft({ retryBanner: null, draft: "今の下書き" }), false);
});

test("shouldShowRetryBanner は mode-neutral な表示 precondition を評価する", () => {
  assert.equal(shouldShowRetryBanner({
    hasActiveAuxiliarySession: false,
    hasLastUserMessage: true,
    isReadOnly: false,
    runState: "error",
  }), true);
  assert.equal(shouldShowRetryBanner({
    hasActiveAuxiliarySession: true,
    hasLastUserMessage: true,
    isReadOnly: false,
    runState: "error",
  }), false);
  assert.equal(shouldShowRetryBanner({
    hasActiveAuxiliarySession: false,
    hasLastUserMessage: false,
    isReadOnly: false,
    runState: "error",
  }), false);
  assert.equal(shouldShowRetryBanner({
    hasActiveAuxiliarySession: false,
    hasLastUserMessage: true,
    isReadOnly: true,
    runState: "error",
  }), false);
  assert.equal(shouldShowRetryBanner({
    hasActiveAuxiliarySession: false,
    hasLastUserMessage: true,
    isReadOnly: false,
    runState: "running",
  }), false);
});

test("isRetryActionDisabled は shared precondition を評価する", () => {
  const retryBanner = {
    kind: "failed" as const,
    badge: "失敗",
    title: "失敗",
    lastRequestText: "直して",
  };

  assert.equal(isRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: true,
    composerBlocked: false,
    isReadOnly: false,
    runState: "idle",
  }), false);
  assert.equal(isRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: true,
    composerBlocked: true,
    isReadOnly: false,
    runState: "idle",
  }), true);
  assert.equal(isRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: true,
    composerBlocked: false,
    isReadOnly: true,
    runState: "idle",
  }), true);
  assert.equal(isRetryActionDisabled({
    retryBanner: null,
    hasLastUserMessage: true,
    composerBlocked: false,
    isReadOnly: false,
    runState: "idle",
  }), true);
  assert.equal(isRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: false,
    composerBlocked: false,
    isReadOnly: false,
    runState: "idle",
  }), true);
  assert.equal(isRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: true,
    composerBlocked: false,
    isReadOnly: false,
    runState: "running",
  }), true);
});
