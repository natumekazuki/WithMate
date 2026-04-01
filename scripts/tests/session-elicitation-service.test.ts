import assert from "node:assert/strict";
import test from "node:test";

import { SessionElicitationService } from "../../src-electron/session-elicitation-service.js";
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

test("SessionElicitationService は入力待ちを live run に反映し、resolve 後に片付ける", async () => {
  let state = createLiveRunState();
  const service = new SessionElicitationService({
    updateLiveSessionRun: (_sessionId, recipe) => {
      state = recipe(state);
      return state;
    },
  });

  const waitPromise = service.waitForLiveElicitationResponse(
    "session-1",
    {
      requestId: "req-1",
      provider: "copilot",
      mode: "form",
      message: "project name を入力してね",
      fields: [
        {
          type: "text",
          name: "projectName",
          title: "Project Name",
          required: true,
        },
      ],
    },
    new AbortController().signal,
  );

  assert.equal(state.elicitationRequest?.requestId, "req-1");
  service.resolveLiveElicitation("session-1", "req-1", {
    action: "accept",
    content: { projectName: "WithMate" },
  });
  assert.deepEqual(await waitPromise, {
    action: "accept",
    content: { projectName: "WithMate" },
  });
  assert.equal(state.elicitationRequest, null);
});

test("SessionElicitationService は abort 時に cancel を返す", async () => {
  let state = createLiveRunState();
  const controller = new AbortController();
  const service = new SessionElicitationService({
    updateLiveSessionRun: (_sessionId, recipe) => {
      state = recipe(state);
      return state;
    },
  });

  const waitPromise = service.waitForLiveElicitationResponse(
    "session-1",
    {
      requestId: "req-2",
      provider: "copilot",
      mode: "form",
      message: "project name を入力してね",
      fields: [],
    },
    controller.signal,
  );

  controller.abort();
  assert.deepEqual(await waitPromise, { action: "cancel" });
  assert.equal(state.elicitationRequest, null);
});
