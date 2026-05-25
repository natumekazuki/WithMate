import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRetryStopSummary,
  defaultRetryBannerDetailsOpen,
  isRetryActionDisabled,
  resolveRetryBannerKind,
  shouldProtectRetryEditDraft,
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
