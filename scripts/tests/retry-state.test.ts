import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCancelRetryDraftReplace,
  applyRetryDetailsReset,
  applyRetryDetailsToggle,
  applyRetryDraftRestoreCommand,
  applyRetryDraftReplaceConfirmation,
  applyRetryEditCommand,
  buildRetryDraftRestoreState,
  buildRetryStopSummary,
  defaultRetryBannerDetailsOpen,
  isRetryActionDisabled,
  resolveRetryBannerKind,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
} from "../../src/chat/retry-state.js";
import type { AuditLogSummary, LiveSessionRunState } from "../../src/runtime-state.js";
import type { Message } from "../../src/session-state.js";

function createLiveRun(summary = ""): LiveSessionRunState {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    assistantText: "",
    reasoningText: "",
    steps: summary ? [{ id: "step-1", type: "tool", summary, status: "failed" }] : [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

function createAuditLog(overrides: Partial<AuditLogSummary> = {}): AuditLogSummary {
  return {
    id: 1,
    sessionId: "session-1",
    createdAt: "2026-05-25T00:00:00.000Z",
    phase: "failed",
    provider: "codex",
    model: "gpt-test",
    reasoningEffort: "low",
    approvalMode: "never",
    threadId: "thread-1",
    operations: [],
    usage: null,
    errorMessage: "",
    assistantTextPreview: "",
    detailAvailable: false,
    ...overrides,
  };
}

test("buildRetryDraftRestoreState は retry 編集復元時の composer state を作る", () => {
  const restoreState = buildRetryDraftRestoreState("前回の依頼");

  assert.deepEqual(restoreState, {
    draft: "前回の依頼",
    caret: 5,
    workspacePathMatches: [],
    activeWorkspacePathMatchIndex: -1,
    isRetryDraftReplacePending: false,
    isActionDockPinnedExpanded: true,
  });
});

test("buildRetryDraftRestoreState は workspace path matches を呼び出しごとに新しくする", () => {
  const first = buildRetryDraftRestoreState("a");
  const second = buildRetryDraftRestoreState("a");

  assert.notEqual(first.workspacePathMatches, second.workspacePathMatches);
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
    applyWorkspacePathMatchState: (state) => events.push(`matches:${state.activeWorkspacePathMatchIndex}`),
    setRetryDraftReplacePending: (pending) => events.push(`pending:${pending}`),
    focusComposer: (caret) => events.push(`focus:${caret}`),
  });

  assert.deepEqual(events, [
    "expanded:true",
    "draft:前回の依頼",
    "caret:5",
    "sync:5",
    "matches:-1",
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

test("applyRetryDetailsReset は banner 種別に応じて詳細表示 state を初期化する", () => {
  const values: boolean[] = [];

  applyRetryDetailsReset({
    retryBanner: null,
    setRetryDetailsOpen: (open) => values.push(open),
  });
  applyRetryDetailsReset({
    retryBanner: { kind: "failed" },
    setRetryDetailsOpen: (open) => values.push(open),
  });
  applyRetryDetailsReset({
    retryBanner: { kind: "canceled" },
    setRetryDetailsOpen: (open) => values.push(open),
  });

  assert.deepEqual(values, [false, true, false]);
});

test("applyRetryDetailsToggle は現在の詳細表示 state を反転する", () => {
  let current = false;

  applyRetryDetailsToggle({
    setRetryDetailsOpen: (updater) => {
      current = updater(current);
    },
  });
  assert.equal(current, true);

  applyRetryDetailsToggle({
    setRetryDetailsOpen: (updater) => {
      current = updater(current);
    },
  });
  assert.equal(current, false);
});

test("applyCancelRetryDraftReplace は retry draft replace pending を解除する", () => {
  const values: boolean[] = [];

  applyCancelRetryDraftReplace({
    setRetryDraftReplacePending: (pending) => values.push(pending),
  });

  assert.deepEqual(values, [false]);
});

test("resolveRetryBannerKind は session state と terminal audit log から retry 種別を解決する", () => {
  assert.equal(resolveRetryBannerKind({ runState: "interrupted" }), "interrupted");
  assert.equal(resolveRetryBannerKind({ runState: "error" }), "failed");
  assert.equal(resolveRetryBannerKind({ runState: "idle", latestTerminalAuditLogPhase: "canceled" }), "canceled");
  assert.equal(resolveRetryBannerKind({ runState: "idle", latestTerminalAuditLogPhase: "completed" }), null);
});

test("defaultRetryBannerDetailsOpen は canceled だけ詳細を閉じる", () => {
  assert.equal(defaultRetryBannerDetailsOpen("interrupted"), true);
  assert.equal(defaultRetryBannerDetailsOpen("failed"), true);
  assert.equal(defaultRetryBannerDetailsOpen("canceled"), false);
});

test("buildRetryStopSummary は live run、audit、artifact の順で停止地点を解決する", () => {
  const assistantMessage: Message = {
    role: "assistant",
    text: "done",
    artifact: {
      title: "artifact",
      activitySummary: ["activity summary"],
      operationTimeline: [{ type: "tool", summary: "artifact operation" }],
      changedFiles: [],
      runChecks: [],
    },
  };

  assert.equal(
    buildRetryStopSummary("failed", createLiveRun("live summary"), createAuditLog(), assistantMessage),
    "live summary",
  );
  assert.equal(
    buildRetryStopSummary(
      "failed",
      createLiveRun(),
      createAuditLog({ operations: [{ type: "tool", summary: "audit operation" }] }),
      assistantMessage,
    ),
    "audit operation",
  );
  assert.equal(
    buildRetryStopSummary("failed", createLiveRun(), createAuditLog(), assistantMessage),
    "artifact operation",
  );
});

test("buildRetryStopSummary は fallback 文言を維持する", () => {
  assert.equal(
    buildRetryStopSummary("interrupted", createLiveRun(), null, null),
    "停止地点は復元できませんでした。",
  );
  assert.equal(
    buildRetryStopSummary("failed", createLiveRun(), createAuditLog({ errorMessage: "boom" }), null),
    "boom",
  );
  assert.equal(
    buildRetryStopSummary("failed", createLiveRun(), createAuditLog({ errorMessage: "ユーザーがキャンセルしたよ。" }), null),
    "エラー箇所は復元できませんでした。",
  );
  assert.equal(
    buildRetryStopSummary("canceled", createLiveRun(), createAuditLog({ phase: "canceled" }), null),
    "停止位置は記録されていません。",
  );
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
    stopSummary: "error",
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
