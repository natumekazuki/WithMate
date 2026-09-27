import assert from "node:assert/strict";
import test from "node:test";

import type { LiveApprovalRequest, LiveElicitationRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import {
  applyOptimisticSessionRunUpdate,
  applyResolvedSessionRunUpdate,
  createOwnedPendingLiveSessionRunState,
  clearOwnedLiveSessionRunState,
  replaceLiveRunAfterResolvedRequest,
  rollbackOptimisticSessionRunUpdate,
  resolveSessionRunErrorMessage,
  type OwnedLiveSessionRunState,
} from "../../src/chat/runtime/session-live-run-state.js";
import type { Message } from "../../src-shared/session/session-state.js";
import { createOptimisticRunningSessionState } from "../../src-shared/session/session-run-transition.js";

function makeLiveRunState(
  sessionId: string,
  options: {
    approvalRequest?: LiveApprovalRequest | null;
    elicitationRequest?: LiveElicitationRequest | null;
  } = {},
): LiveSessionRunState {
  return {
    sessionId,
    threadId: `${sessionId}-thread`,
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: options.approvalRequest ?? null,
    elicitationRequest: options.elicitationRequest ?? null,
  };
}

function makeApprovalRequest(requestId: string): LiveApprovalRequest {
  return {
    requestId,
    provider: "codex",
    kind: "command",
    title: "Run command",
    summary: "npm test",
    decisionMode: "direct-decision",
  };
}

function makeElicitationRequest(requestId: string): LiveElicitationRequest {
  return {
    requestId,
    provider: "codex",
    mode: "form",
    message: "Need input",
    fields: [],
  };
}

type TestSession = {
  id: string;
  threadId: string;
  status?: string;
  runState: string;
  updatedAt: string;
  messages: Message[];
};

test("resolveSessionRunErrorMessage は Error message を優先する", () => {
  assert.equal(resolveSessionRunErrorMessage(new Error("provider failed"), "fallback"), "provider failed");
});

test("resolveSessionRunErrorMessage は非 Error なら fallback を返す", () => {
  assert.equal(resolveSessionRunErrorMessage("provider failed", "fallback"), "fallback");
});

test("resolveSessionRunErrorMessage は message 付き object でも非 Error なら fallback を返す", () => {
  assert.equal(resolveSessionRunErrorMessage({ message: "provider failed" }, "fallback"), "fallback");
});

// @test-value v2
// kind = "contract"
// claim = "optimistic session updateはrunning sessionとowner付きpending live runを整合して生成する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
// fault = "user message、running state、background taskが不整合なownerへ反映される"
// observable = "running session and pending live run snapshots"
// observation_boundary = "public-boundary"
// scope = "optimistic-session-run-update"
// lifecycle = "permanent"
// @end-test-value
test("共通のrunning生成とPending生成は送信本文と同じownerのbackground taskを保持する", () => {
  const session: TestSession = {
    id: "session-1",
    threadId: "thread-1",
    status: "idle",
    runState: "idle",
    updatedAt: "before",
    messages: [{ role: "assistant", text: "hello" }],
  };
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: {
      ...makeLiveRunState("session-1"),
      backgroundTasks: [{ id: "task-1", kind: "shell", title: "Install", status: "running", updatedAt: "before" }],
    },
  };

  const runningSession = createOptimisticRunningSessionState(session, "next", "after", { status: "running" });

  assert.deepEqual(runningSession, {
    ...session,
    status: "running",
    runState: "running",
    updatedAt: "after",
    messages: [
      { role: "assistant", text: "hello" },
      { role: "user", text: "next" },
    ],
  });
  assert.deepEqual(createOwnedPendingLiveSessionRunState(runningSession, current), {
    ownerSessionId: "session-1",
    state: {
      sessionId: "session-1",
      threadId: "thread-1",
      assistantText: "",
      reasoningText: "",
      steps: [],
      backgroundTasks: [{ id: "task-1", kind: "shell", title: "Install", status: "running", updatedAt: "before" }],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    },
  });

  assert.deepEqual(createOwnedPendingLiveSessionRunState(runningSession, {
    ownerSessionId: "session-other",
    state: {
      ...makeLiveRunState("session-other"),
      backgroundTasks: [{ id: "stale-task", kind: "shell", title: "Stale", status: "running", updatedAt: "before" }],
    },
  }), {
    ownerSessionId: "session-1",
    state: {
      sessionId: "session-1",
      threadId: "thread-1",
      assistantText: "",
      reasoningText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    },
  });
});

// @test-value v2
// kind = "contract"
// claim = "共通の送信反映は送信本文を含むSessionをownerへ渡してから同じ会話のPendingを開始する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
// fault = "Session適用を省略するかPendingを先行させ、送信本文がない実行中表示を通知する"
// observable = "Pending通知時点の適用済Session、Sessionとlive runのownerおよび本文"
// observation_boundary = "public-boundary"
// scope = "optimistic-session-application"
// lifecycle = "permanent"
// distinction = "owner接続の統合testとは別に、共通適用関数の同期通知境界を小さい入力で検証する"
// @end-test-value
test("applyOptimisticSessionRunUpdate は送信本文を適用してからPendingを開始する", () => {
  const session: TestSession = {
    id: "session-1",
    threadId: "thread-1",
    runState: "idle",
    updatedAt: "before",
    messages: [],
  };
  const calls: string[] = [];
  let nextLiveRunState: OwnedLiveSessionRunState | null = null;
  let nextSession: TestSession | null = null;

  const returnedSession = applyOptimisticSessionRunUpdate({
    runningSession: createOptimisticRunningSessionState(session, "hello", "after", { status: "running" }),
    updateLiveRunState: (update) => {
      assert.deepEqual(nextSession?.messages, [{ role: "user", text: "hello" }]);
      calls.push("live-run");
      nextLiveRunState = update({ ownerSessionId: null, state: null });
    },
    applyRunningSession: (runningSession) => {
      calls.push("session");
      nextSession = runningSession;
    },
  });

  assert.deepEqual(calls, ["session", "live-run"]);
  assert.equal(nextSession, returnedSession);
  assert.deepEqual(nextSession, {
    ...session,
    status: "running",
    runState: "running",
    updatedAt: "after",
    messages: [{ role: "user", text: "hello" }],
  });
  assert.deepEqual(nextLiveRunState, {
    ownerSessionId: "session-1",
    state: {
      sessionId: "session-1",
      threadId: "thread-1",
      assistantText: "",
      reasoningText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    },
  });
});

test("rollbackOptimisticSessionRunUpdate は live run clear 後に session restore を呼ぶ", () => {
  const calls: string[] = [];
  let nextLiveRunState: OwnedLiveSessionRunState | null = null;
  let restored = false;

  rollbackOptimisticSessionRunUpdate({
    sessionId: "session-1",
    updateLiveRunState: (update) => {
      calls.push("live-run");
      nextLiveRunState = update({
        ownerSessionId: "session-1",
        state: makeLiveRunState("session-1"),
      });
    },
    restoreSession: () => {
      calls.push("session");
      restored = true;
    },
  });

  assert.deepEqual(calls, ["live-run", "session"]);
  assert.equal(restored, true);
  assert.deepEqual(nextLiveRunState, {
    ownerSessionId: "session-1",
    state: null,
  });
});

test("rollbackOptimisticSessionRunUpdate は別 owner の live run を維持して session restore を呼ぶ", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-2",
    state: makeLiveRunState("session-2"),
  };
  let nextLiveRunState: OwnedLiveSessionRunState | null = null;
  let restored = false;

  rollbackOptimisticSessionRunUpdate({
    sessionId: "session-1",
    updateLiveRunState: (update) => {
      nextLiveRunState = update(current);
    },
    restoreSession: () => {
      restored = true;
    },
  });

  assert.equal(nextLiveRunState, current);
  assert.equal(restored, true);
});

test("applyResolvedSessionRunUpdate は saved session を反映して返す", () => {
  const savedSession: TestSession = {
    id: "session-1",
    threadId: "thread-1",
    runState: "idle",
    updatedAt: "after",
    messages: [{ role: "assistant", text: "done" }],
  };
  let appliedSession: TestSession | null = null;

  const returnedSession = applyResolvedSessionRunUpdate({
    savedSession,
    applySavedSession: (nextSession) => {
      appliedSession = nextSession;
    },
  });

  assert.equal(returnedSession, savedSession);
  assert.equal(appliedSession, savedSession);
});

test("clearOwnedLiveSessionRunState は owner が一致した live run だけ空にする", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: makeLiveRunState("session-1"),
  };

  assert.deepEqual(
    clearOwnedLiveSessionRunState(current, "session-1"),
    { ownerSessionId: "session-1", state: null },
  );
});

test("clearOwnedLiveSessionRunState は別 owner の live run を維持する", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-2",
    state: makeLiveRunState("session-2"),
  };

  assert.equal(clearOwnedLiveSessionRunState(current, "session-1"), current);
});

test("replaceLiveRunAfterResolvedRequest は approval request が一致した live run だけ差し替える", () => {
  const latestLiveRun = makeLiveRunState("session-1");
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: makeLiveRunState("session-1", { approvalRequest: makeApprovalRequest("approval-1") }),
  };

  assert.deepEqual(
    replaceLiveRunAfterResolvedRequest(current, {
      sessionId: "session-1",
      requestId: "approval-1",
      requestKind: "approval",
      latestLiveRun,
    }),
    { ownerSessionId: "session-1", state: latestLiveRun },
  );
});

test("replaceLiveRunAfterResolvedRequest は elicitation request が一致した live run だけ差し替える", () => {
  const latestLiveRun = makeLiveRunState("session-1");
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: makeLiveRunState("session-1", { elicitationRequest: makeElicitationRequest("elicitation-1") }),
  };

  assert.deepEqual(
    replaceLiveRunAfterResolvedRequest(current, {
      sessionId: "session-1",
      requestId: "elicitation-1",
      requestKind: "elicitation",
      latestLiveRun,
    }),
    { ownerSessionId: "session-1", state: latestLiveRun },
  );
});

test("replaceLiveRunAfterResolvedRequest は別 session の stale response を無視する", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-2",
    state: makeLiveRunState("session-2", { approvalRequest: makeApprovalRequest("approval-1") }),
  };

  assert.equal(
    replaceLiveRunAfterResolvedRequest(current, {
      sessionId: "session-1",
      requestId: "approval-1",
      requestKind: "approval",
      latestLiveRun: makeLiveRunState("session-1"),
    }),
    current,
  );
});

test("replaceLiveRunAfterResolvedRequest は別 request の stale response を無視する", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: makeLiveRunState("session-1", { elicitationRequest: makeElicitationRequest("elicitation-2") }),
  };

  assert.equal(
    replaceLiveRunAfterResolvedRequest(current, {
      sessionId: "session-1",
      requestId: "elicitation-1",
      requestKind: "elicitation",
      latestLiveRun: makeLiveRunState("session-1"),
    }),
    current,
  );
});

test("replaceLiveRunAfterResolvedRequest は一致した request の解決後 live run が空でも反映する", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: makeLiveRunState("session-1", { approvalRequest: makeApprovalRequest("approval-1") }),
  };

  assert.deepEqual(
    replaceLiveRunAfterResolvedRequest(current, {
      sessionId: "session-1",
      requestId: "approval-1",
      requestKind: "approval",
      latestLiveRun: null,
    }),
    { ownerSessionId: "session-1", state: null },
  );
});

test("replaceLiveRunAfterResolvedRequest は current state が空なら stale response として無視する", () => {
  const current: OwnedLiveSessionRunState = {
    ownerSessionId: "session-1",
    state: null,
  };

  assert.equal(
    replaceLiveRunAfterResolvedRequest(current, {
      sessionId: "session-1",
      requestId: "approval-1",
      requestKind: "approval",
      latestLiveRun: makeLiveRunState("session-1"),
    }),
    current,
  );
});
