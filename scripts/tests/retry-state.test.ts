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
  resolveRetryBannerSource,
  resolveRetryBannerTerminalFailureNotification,
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

test("resolveRetryBannerSource は最後の未完了依頼と同じ session / message seq の terminal event だけを使う", () => {
  const canceled = {
    id: 10,
    sessionId: "session-1",
    createdAt: "2026-08-12T10:00:00.000Z",
    phase: "canceled" as const,
    provider: "codex",
    model: "gpt-5.6",
    reasoningEffort: "medium" as const,
    approvalMode: "never" as const,
    userMessageSeq: 0,
    assistantMessageSeq: 1,
    threadId: "thread-1",
    assistantTextPreview: "キャンセル",
    operations: [],
    usage: null,
    errorMessage: "canceled",
    detailAvailable: true,
  };
  const completed = {
    ...canceled,
    id: 11,
    phase: "completed" as const,
    userMessageSeq: 2,
    assistantMessageSeq: 3,
    assistantTextPreview: "完了",
    errorMessage: "",
  };
  const nextMessages = [
    { role: "user" as const, text: "古い依頼" },
    { role: "assistant" as const, text: "キャンセルしたよ" },
    { role: "user" as const, text: "新しい依頼" },
  ];

  assert.deepEqual(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: nextMessages.slice(0, 2),
    auditLogs: [canceled],
    runState: "idle",
  }), {
    kind: "canceled",
    lastRequestText: "古い依頼",
    terminalAuditLog: canceled,
    sessionId: "session-1",
  });

  assert.equal(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: nextMessages,
    auditLogs: [canceled],
    runState: "running",
  }), null);

  assert.equal(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: [...nextMessages, { role: "assistant", text: "完了したよ" }],
    auditLogs: [completed, canceled],
    runState: "idle",
  }), null);

  assert.equal(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: [...nextMessages, { role: "assistant", text: "完了したよ" }],
    auditLogs: [completed, { ...canceled, phase: "failed" }],
    runState: "idle",
  }), null);

  assert.equal(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: [...nextMessages, { role: "assistant", text: "完了したよ" }],
    auditLogs: [canceled],
    runState: "idle",
  }), null);

  assert.equal(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: nextMessages,
    auditLogs: [{ ...canceled, sessionId: "auxiliary-1", userMessageSeq: 2 }],
    runState: "idle",
  }), null);

  assert.deepEqual(resolveRetryBannerSource({
    sessionId: "session-1",
    messages: nextMessages,
    auditLogs: [],
    runState: "error",
  }), {
    kind: "failed",
    lastRequestText: "新しい依頼",
    terminalAuditLog: null,
    sessionId: "session-1",
  });
});

test("resolveRetryBannerTerminalFailureNotification は retry source と同じ execution の通知だけを返す", () => {
  const olderNotification = {
    state: "enqueued" as const,
    targetSessionId: "target-session",
    notificationExecutionId: "notification-execution",
    updatedAt: "2026-08-18T10:00:00.000Z",
  };
  const source = {
    kind: "failed" as const,
    lastRequestText: "新しい依頼",
    terminalAuditLog: {
      id: 12,
      sessionId: "session-1",
      executionId: "execution-2",
      createdAt: "2026-08-18T10:01:00.000Z",
      phase: "failed" as const,
      provider: "codex",
      model: "gpt-5.6",
      reasoningEffort: "medium" as const,
      approvalMode: "never" as const,
      userMessageSeq: 2,
      assistantMessageSeq: null,
      threadId: "thread-1",
      assistantTextPreview: "",
      operations: [],
      usage: null,
      errorMessage: "failed",
      detailAvailable: true,
    },
  };
  const executions = [
    {
      executionId: "execution-1",
      sessionId: "session-1",
      clientRequestId: "request-1",
      userMessage: "古い依頼",
      initiator: { kind: "user" as const },
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:00.000Z",
      state: "failed" as const,
      queuePosition: null,
      canCancel: false as const,
      terminalFailureNotification: olderNotification,
    },
    {
      executionId: "execution-2",
      sessionId: "session-1",
      clientRequestId: "request-2",
      userMessage: "新しい依頼",
      initiator: { kind: "user" as const },
      createdAt: "2026-08-18T10:01:00.000Z",
      updatedAt: "2026-08-18T10:01:00.000Z",
      state: "failed" as const,
      queuePosition: null,
      canCancel: false as const,
    },
  ];

  assert.equal(resolveRetryBannerTerminalFailureNotification({ source, executions }), null);
  assert.equal(resolveRetryBannerTerminalFailureNotification({
    source: {
      ...source,
      terminalAuditLog: { ...source.terminalAuditLog, executionId: "execution-1" },
    },
    executions,
  }), olderNotification);
  assert.equal(resolveRetryBannerTerminalFailureNotification({
    source: { ...source, terminalAuditLog: null },
    executions,
  }), null);
});

test("TN-PROJ-13: audit相関がなくても最新terminal executionから通知状態を解決する", () => {
  const notification = {
    state: "pending" as const,
    targetSessionId: "target-session",
    updatedAt: "2026-08-18T10:01:00.000Z",
  };
  const source = {
    kind: "failed" as const,
    lastRequestText: "audit作成前に失敗した依頼",
    terminalAuditLog: null,
    sessionId: "session-1",
  };
  const executions = [{
    executionId: "execution-2",
    sessionId: "session-1",
    clientRequestId: "request-2",
    userMessage: source.lastRequestText,
    initiator: { kind: "session" as const, sessionId: "source-session" },
    createdAt: "2026-08-18T10:01:00.000Z",
    updatedAt: "2026-08-18T10:01:00.000Z",
    state: "failed" as const,
    queuePosition: null,
    canCancel: false as const,
    terminalFailureNotification: notification,
  }];

  assert.equal(
    resolveRetryBannerTerminalFailureNotification({ source, executions }),
    notification,
  );
  assert.equal(resolveRetryBannerTerminalFailureNotification({
    source: { ...source, lastRequestText: "別の依頼" },
    executions,
  }), null);
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
