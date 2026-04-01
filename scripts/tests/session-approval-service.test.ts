import assert from "node:assert/strict";
import test from "node:test";

import { SessionApprovalService } from "../../src-electron/session-approval-service.js";
import type { LiveSessionRunState } from "../../src/app-state.js";

function createLiveRunState(): LiveSessionRunState {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    assistantText: "",
    steps: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

test("SessionApprovalService は承認待ちを live run に反映し、resolve 後に片付ける", async () => {
  let state = createLiveRunState();
  const service = new SessionApprovalService({
    updateLiveSessionRun: (_sessionId, recipe) => {
      state = recipe(state);
      return state;
    },
  });

  const waitPromise = service.waitForLiveApprovalDecision(
    "session-1",
    {
      requestId: "req-1",
      provider: "copilot",
      kind: "tool",
      title: "approval",
      summary: "need approval",
      decisionMode: "direct-decision",
    },
    new AbortController().signal,
  );

  assert.equal(state.approvalRequest?.requestId, "req-1");
  service.resolveLiveApproval("session-1", "req-1", "approve");
  assert.equal(await waitPromise, "approve");
  assert.equal(state.approvalRequest, null);
});

test("SessionApprovalService は abort 時に deny を返す", async () => {
  let state = createLiveRunState();
  const controller = new AbortController();
  const service = new SessionApprovalService({
    updateLiveSessionRun: (_sessionId, recipe) => {
      state = recipe(state);
      return state;
    },
  });

  const waitPromise = service.waitForLiveApprovalDecision(
    "session-1",
    {
      requestId: "req-2",
      provider: "copilot",
      kind: "tool",
      title: "approval",
      summary: "need approval",
      decisionMode: "direct-decision",
    },
    controller.signal,
  );

  controller.abort();
  assert.equal(await waitPromise, "deny");
  assert.equal(state.approvalRequest, null);
});
