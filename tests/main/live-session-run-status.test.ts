import assert from "node:assert/strict";
import test from "node:test";

import { SessionElicitationService } from "../../src-electron/session/session-elicitation-service.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type { LiveElicitationRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

function createState(): LiveSessionRunState {
  return {
    sessionId: "session-1", threadId: "thread-1", runState: "running", assistantText: "",
    steps: [], backgroundTasks: [], usage: null, errorMessage: "",
    approvalRequest: null, elicitationRequest: null,
  };
}

const question: LiveElicitationRequest = {
  requestId: "question", provider: "codex", kind: "question", blocking: false,
  mode: "form", message: "Choose", fields: [{ name: "answer", title: "Choose", type: "text", required: true }],
};

// @test-value v2
// kind = "contract"
// claim = "軽量live状態は承認と単一・複数の有効な入力要求をapprovalPendingへ集約し、runStateと取消状態を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Home Window / Monitor" }
// fault = "入力要求を無視する、空配列を待機扱いする、または待機表示のためにrunStateや取消状態を書き換える"
// observable = "projectLiveSessionRunStatusが返すapprovalPending、runState、cancellationStateとnull"
// observation_boundary = "consumer"
// scope = "Monitorの軽量live状態投影"
// lifecycle = "permanent"
// impact = "質問待ちを見落とす、終了後も承認待ちが残る、または取消中の会話を誤分類する"
// distinction = "型検査やrendererのsummary fixtureはlive入力要求から軽量状態への変換を検査しない"
// @end-test-value
test("軽量live状態は承認と入力待ちを集約し実行・取消状態を維持する", () => {
  assert.equal(projectLiveSessionRunStatus(null), null);
  const state = createState();
  assert.deepEqual(projectLiveSessionRunStatus(state), { runState: "running", cancellationState: undefined });
  assert.equal(projectLiveSessionRunStatus({ ...state, elicitationRequests: [] })?.approvalPending, undefined);
  const approvalRequest = {
    requestId: "approval", provider: "codex", kind: "command", title: "Command",
    summary: "Run command", decisionMode: "direct-decision" as const,
  };
  for (const pending of [
    { approvalRequest }, { elicitationRequest: question }, { elicitationRequests: [question] },
  ]) {
    for (const cancellationState of [undefined, "requested", "terminating"] as const) {
      assert.deepEqual(projectLiveSessionRunStatus({ ...state, ...pending, cancellationState }), {
        runState: "running", cancellationState, approvalPending: true,
      });
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "共通質問serviceの入力待ちは回答・Close・拒否・失効・終了で解除され、複数要求では最後の解決までMonitor用待機を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Question Forms / Home Window Monitor" }
// fault = "最初の解決で全待機を落とすか、解決後の入力要求を待機として残す"
// observable = "実SessionElicitationServiceの公開操作後にprojectLiveSessionRunStatusが返すapprovalPendingと待機Promiseの解決"
// observation_boundary = "consumer"
// scope = "共通入力要求のlifecycleからMonitor状態への投影"
// lifecycle = "permanent"
// impact = "複数質問の回答漏れや回答済みSessionの誤った待機表示が続く"
// distinction = "service単体のフォーム一覧検査とrenderer単体のsummary検査の間にある待機集約の結線を少量のin-memory状態で確認する"
// @end-test-value
test("質問serviceの回答・取消・終了をMonitor用待機状態へ反映する", async () => {
  let state = createState();
  const service = new SessionElicitationService({
    updateLiveSessionRun: (_id, recipe) => { state = recipe(state); return state; },
    sendUserMessage: async () => {},
  });
  const requests: LiveElicitationRequest[] = [
    { ...question, blocking: true }, question,
    { ...question, delivery: "user-message", turnId: "turn-1" },
    { ...question, provider: "copilot", kind: undefined },
    { ...question, kind: undefined, mode: "url", url: "https://example.com/auth", fields: [] },
    { ...question, provider: "claude" },
  ];
  for (const request of requests) {
    for (const action of ["accept", "decline", "cancel", "expire", "end"] as const) {
      const controller = new AbortController();
      const response = service.waitForLiveElicitationResponse(state.sessionId, request, controller.signal);
      assert.equal(projectLiveSessionRunStatus(state)?.approvalPending, true);
      if (action === "expire") controller.abort();
      else if (action === "end") service.cancelSession(state.sessionId);
      else await service.resolveLiveElicitation(state.sessionId, request.requestId, { action, content: { answer: "Yes" } });
      await response;
      assert.equal(projectLiveSessionRunStatus(state)?.approvalPending, undefined, `${request.provider}/${request.mode}/${action}`);
    }
  }
  const controller = new AbortController();
  const first = service.waitForLiveElicitationResponse(state.sessionId, question, controller.signal);
  const second = service.waitForLiveElicitationResponse(state.sessionId, { ...question, requestId: "second" }, controller.signal);
  service.resolveLiveElicitation(state.sessionId, question.requestId, { action: "cancel" });
  await first;
  assert.equal(projectLiveSessionRunStatus(state)?.approvalPending, true);
  service.reset();
  await second;
  assert.equal(projectLiveSessionRunStatus(state)?.approvalPending, undefined);
});
