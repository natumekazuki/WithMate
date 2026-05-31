import assert from "node:assert/strict";
import test from "node:test";

import type { LiveApprovalRequest, LiveElicitationRequest, LiveSessionRunState } from "../../src/runtime-state.js";
import {
  clearOwnedLiveSessionRunState,
  replaceLiveRunAfterResolvedRequest,
  type OwnedLiveSessionRunState,
} from "../../src/session-live-run-state.js";

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
