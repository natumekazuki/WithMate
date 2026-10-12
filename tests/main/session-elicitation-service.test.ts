import assert from "node:assert/strict";
import test from "node:test";

import { SessionElicitationService } from "../../src-electron/session/session-elicitation-service.js";
import type { LiveElicitationRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

function createLiveRunState(): LiveSessionRunState {
  return {
    sessionId: "session-1",
    threadId: "thread-1",
    assistantText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

// @test-value v2
// kind = "contract"
// claim = "表示中のnative Codex質問だけを通知し、回答・取消・resetで通知の待機期間を終了する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#windows-session-notifications" }
// fault = "MCPや他providerを誤通知するか、入力解決後も通知signalが有効なまま残る"
// observable = "通知callback時のlive request、callback回数、signal.abortedと待機の応答"
// observation_boundary = "consumer"
// scope = "SessionElicitationService question notification lifecycle"
// lifecycle = "permanent"
// impact = "回答済みの古い質問通知が表示され、利用者が誤った会話へ戻る"
// distinction = "通知設定の非同期読込みと入力の解決をつなぐsignalの寿命は型検査や通知単体testでは検証できない"
// @end-test-value
test("Codex質問の表示から解決までを通知signalの有効期間とする", async () => {
  for (const settlement of ["answer", "abort", "reset"] as const) {
    let state = createLiveRunState();
    const notifications: AbortSignal[] = [];
    const service = new SessionElicitationService({
      updateLiveSessionRun: (_id, recipe) => { state = recipe(state); return state; },
      notifyQuestion: (id, signal) => {
        assert.equal(id, "session-1");
        assert.equal(state.elicitationRequest?.requestId, "native");
        notifications.push(signal);
      },
    });
    const base: LiveElicitationRequest = { requestId: "mcp", provider: "codex", mode: "form", message: "Input", fields: [] };
    for (const request of [base, { ...base, requestId: "copilot", provider: "copilot", kind: "question" as const }]) {
      const pending = service.waitForLiveElicitationResponse("session-1", request, new AbortController().signal);
      service.resolveLiveElicitation("session-1", request.requestId, { action: "accept" });
      await pending;
    }
    const canceled = new AbortController();
    canceled.abort();
    assert.deepEqual(await service.waitForLiveElicitationResponse("session-1", { ...base, kind: "question" }, canceled.signal), { action: "cancel" });
    assert.equal(notifications.length, 0);
    const controller = new AbortController();
    const pending = service.waitForLiveElicitationResponse("session-1", { ...base, requestId: "native", kind: "question" }, controller.signal);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.aborted, false);
    if (settlement === "answer") service.resolveLiveElicitation("session-1", "native", { action: "accept", content: { q: "answer" } });
    else if (settlement === "abort") controller.abort();
    else service.reset();
    assert.deepEqual(await pending, settlement === "answer" ? { action: "accept", content: { q: "answer" } } : { action: "cancel" });
    assert.equal(notifications[0]?.aborted, true);
    assert.equal(state.elicitationRequest, null);
  }
});

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
