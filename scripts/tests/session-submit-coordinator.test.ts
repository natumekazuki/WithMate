import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestRequestRevision,
  SessionSubmitCoordinator,
  StateMutationRevision,
  convergeRejectedLiveRunState,
  convergeRejectedSessionSnapshot,
  convergeResolvedSessionProjection,
  fingerprintSessionDraft,
  mergeRefetchedSessionProjection,
  mergeRejectedSessionDraft,
  recoverRejectedSessionSnapshot,
} from "../../src/session-submit-coordinator.js";
import type { LiveSessionRunState } from "../../src/runtime-state.js";
import {
  normalizeSessionTurnClientRequestId,
  normalizeSessionTurnCorrelation,
  normalizeSessionTurnSubmitSource,
} from "../../src/runtime-state.js";
import type { Session } from "../../src/session-state.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    taskTitle: "test",
    status: "idle",
    updatedAt: "2026-08-13T01:00:00.000Z",
    isPinned: false,
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "workspace",
    workspacePath: "C:\\workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "character-1",
    character: "Character",
    characterIconPath: "",
    characterThemeColors: { primary: "#000000", secondary: "#000000", accent: "#000000" },
    characterRuntimeSnapshot: null,
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    model: "model",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    messages: [],
    stream: [],
    ...overrides,
  };
}

function createLiveRun(overrides: Partial<LiveSessionRunState> = {}): LiveSessionRunState {
  return {
    sessionId: "session-1",
    threadId: "",
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
    ...overrides,
  };
}

test("SessionSubmitCoordinator は preview 待機中の同一session rapid submitを一件だけ通す", async () => {
  const coordinator = new SessionSubmitCoordinator();
  let releasePreview: (() => void) | null = null;
  const preview = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let dispatchCount = 0;

  const submit = async () => {
    const lease = coordinator.tryAcquire("session-1");
    if (!lease) {
      return "blocked" as const;
    }
    try {
      await preview;
      dispatchCount += 1;
      return "dispatched" as const;
    } finally {
      lease.release();
    }
  };

  const first = submit();
  const second = await submit();
  assert.equal(second, "blocked");
  assert.equal(dispatchCount, 0);
  assert.equal(coordinator.isClaimed("session-1"), true);
  assert.ok(releasePreview);
  releasePreview();
  assert.equal(await first, "dispatched");
  assert.equal(dispatchCount, 1);
  assert.equal(coordinator.isClaimed("session-1"), false);
});

test("LatestRequestRevision は逆順で完了した古いsession refetchを失効させる", () => {
  const revisions = new LatestRequestRevision();
  const older = revisions.start();
  const newer = revisions.start();

  assert.equal(revisions.isCurrent(newer), true);
  assert.equal(revisions.isCurrent(older), false);
});

test("StateMutationRevision はrefetch待機中の楽観またはsubscription更新を検知する", () => {
  const revisions = new StateMutationRevision();
  const refetchStartedAt = revisions.capture();
  assert.equal(revisions.isCurrent(refetchStartedAt), true);

  revisions.advance();
  assert.equal(revisions.isCurrent(refetchStartedAt), false);
});

test("session refetch は局所的なpin projectionを維持して権威ある本体状態を反映する", () => {
  const current = createSession({
    isPinned: true,
    runState: "running",
    messages: [{ role: "user", text: "optimistic" }],
  });
  const refreshed = createSession({
    isPinned: false,
    runState: "idle",
    messages: [{ role: "user", text: "accepted" }, { role: "assistant", text: "done" }],
  });

  assert.deepEqual(mergeRefetchedSessionProjection(current, refreshed, true), {
    ...refreshed,
    isPinned: true,
  });
  assert.equal(mergeRefetchedSessionProjection(current, refreshed, false), refreshed);
});

test("turn成功応答は実行中に進んだpin projectionを維持して最新本体を反映する", () => {
  const current = createSession({ isPinned: true, runState: "running" });
  const saved = createSession({
    isPinned: false,
    runState: "idle",
    messages: [{ role: "user", text: "accepted" }, { role: "assistant", text: "done" }],
  });

  assert.deepEqual(convergeResolvedSessionProjection(current, saved, true), {
    ...saved,
    isPinned: true,
  });
  assert.equal(convergeResolvedSessionProjection(current, saved, false), saved);
});

test("mergeRejectedSessionDraft は拒否された入力と送信後の追加入力を両方保持する", () => {
  assert.equal(mergeRejectedSessionDraft("送信した内容", ""), "送信した内容");
  assert.equal(
    mergeRejectedSessionDraft("送信した内容", "あとから入力した内容"),
    "送信した内容\n\nあとから入力した内容",
  );
  assert.equal(mergeRejectedSessionDraft("送信した内容", "送信した内容"), "送信した内容");
});

test("fingerprintSessionDraft は本文を含めず同じdraftを安定して識別する", () => {
  const first = fingerprintSessionDraft("secret prompt");
  assert.equal(first, fingerprintSessionDraft("secret prompt"));
  assert.notEqual(first, fingerprintSessionDraft("different prompt"));
  assert.doesNotMatch(first, /secret|prompt/);
});

test("normalizeSessionTurnClientRequestId はログへ安全に渡せる相関IDだけを受理する", () => {
  assert.equal(
    normalizeSessionTurnClientRequestId("7c26d875-9117-4ad5-97b5-e9af775b94bc"),
    "7c26d875-9117-4ad5-97b5-e9af775b94bc",
  );
  assert.equal(normalizeSessionTurnClientRequestId("session-turn-mewz2-k4j8n"), null);
  assert.equal(normalizeSessionTurnClientRequestId("turn-123:abc"), null);
  assert.equal(normalizeSessionTurnClientRequestId(""), null);
  assert.equal(normalizeSessionTurnClientRequestId("本文 を含む"), null);
  assert.equal(normalizeSessionTurnClientRequestId("x".repeat(129)), null);
  assert.equal(normalizeSessionTurnSubmitSource("composer"), "composer");
  assert.equal(normalizeSessionTurnSubmitSource("本文"), null);
  assert.deepEqual(normalizeSessionTurnCorrelation({
    userMessage: "secretprompt",
    clientRequestId: "session-turn-secretprompt-abc",
    submitSource: "本文" as "composer",
  }), {
    clientRequestId: null,
    submitSource: null,
  });
  assert.deepEqual(normalizeSessionTurnCorrelation({
    userMessage: "please use 7c26d875-9117-4ad5-97b5-e9af775b94bc",
    clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc",
    submitSource: "composer",
  }), {
    clientRequestId: null,
    submitSource: "composer",
  });
});

test("convergeRejectedSessionSnapshot は古い楽観snapshotを最新取得結果へ置き換える", () => {
  const before = createSession();
  const optimistic = createSession({
    status: "running",
    runState: "running",
    updatedAt: "2026-08-13T01:00:01.000Z",
    messages: [{ role: "user", text: "rejected" }],
  });
  const refreshed = createSession({
    updatedAt: "2026-08-13T01:00:02.000Z",
    messages: [{ role: "user", text: "accepted earlier" }, { role: "assistant", text: "done" }],
  });

  assert.equal(convergeRejectedSessionSnapshot(optimistic, optimistic, refreshed, true, false), refreshed);
  assert.equal(convergeRejectedSessionSnapshot(before, optimistic, refreshed, false, false), before);
  const pinnedProjection = { ...optimistic, isPinned: true };
  assert.deepEqual(convergeRejectedSessionSnapshot(pinnedProjection, optimistic, refreshed, true, true), {
    ...refreshed,
    isPinned: true,
  });
  const newerSubscription = createSession({
    updatedAt: optimistic.updatedAt,
    messages: [{ role: "user", text: "newer subscription" }],
  });
  assert.equal(convergeRejectedSessionSnapshot(newerSubscription, optimistic, refreshed, false, false), newerSubscription);
});

test("recoverRejectedSessionSnapshot はpin projectionを保持して楽観bodyだけをerrorへ収束する", () => {
  const optimistic = createSession({ status: "running", runState: "running" });
  assert.deepEqual(recoverRejectedSessionSnapshot(optimistic, optimistic, true), {
    ...optimistic,
    status: "idle",
    runState: "error",
  });
  const pinnedProjection = { ...optimistic, isPinned: true };
  assert.deepEqual(recoverRejectedSessionSnapshot(pinnedProjection, optimistic, true), {
    ...optimistic,
    isPinned: true,
    status: "idle",
    runState: "error",
  });

  const newer = createSession({ runState: "idle" });
  assert.equal(recoverRejectedSessionSnapshot(newer, optimistic, false), newer);
});

test("convergeRejectedLiveRunState は楽観pendingだけを最新取得結果へ収束し、空またはnullの購読更新も巻き戻さない", () => {
  const refreshed = createLiveRun({ threadId: "thread-latest", assistantText: "latest" });
  assert.deepEqual(
    convergeRejectedLiveRunState(
      { ownerSessionId: "session-1", state: createLiveRun() },
      "session-1",
      refreshed,
      3,
      3,
    ),
    { ownerSessionId: "session-1", state: refreshed },
  );

  const subscriptionProgress = createLiveRun({ assistantText: "newer subscription" });
  const current = { ownerSessionId: "session-1", state: subscriptionProgress };
  assert.equal(convergeRejectedLiveRunState(current, "session-1", refreshed, 3, 4), current);
  const completed = { ownerSessionId: "session-1", state: null };
  assert.equal(convergeRejectedLiveRunState(completed, "session-1", refreshed, 3, 4), completed);
  const emptySubscription = { ownerSessionId: "session-1", state: createLiveRun() };
  assert.equal(convergeRejectedLiveRunState(emptySubscription, "session-1", refreshed, 3, 4), emptySubscription);
});
