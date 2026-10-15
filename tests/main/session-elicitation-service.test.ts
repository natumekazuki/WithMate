import assert from "node:assert/strict";
import test from "node:test";

import { SessionElicitationService } from "../../src-electron/session/session-elicitation-service.js";
import { normalizeMessage } from "../../src-shared/session/session-state.js";
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
// claim = "同じturnの非同期質問と既存RPCフォームを独立に回答・失効でき、秘密の入力値を記録へ残さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms" }
// fault = "後の質問が既存要求を上書きするか、別要求を解決するか、フォームの秘密値を履歴へ保存する"
// observable = "live質問一覧、各待機Promiseの回答、保存用message正規化後の質問記録"
// observation_boundary = "consumer"
// scope = "SessionElicitationService multiple requests and terminal history"
// lifecycle = "permanent"
// impact = "未回答の質問が失われる、古い要求へ誤送信する、または秘密入力が履歴へ残る"
// distinction = "型検査では同一turn内の並行要求の所有と保存境界を確認できない"
// @end-test-value
test("複数質問を独立に解決しフォーム入力値を履歴へ保存しない", async () => {
  let state = createLiveRunState();
  const service = new SessionElicitationService({
    updateLiveSessionRun: (_id, recipe) => { state = recipe(state); return state; },
    sendUserMessage: async () => {},
  });
  const native: LiveElicitationRequest = {
    requestId: "native", provider: "codex", kind: "question", mode: "form", message: "Credentials",
    fields: [{ name: "secret", title: "Token", type: "text", secret: true, defaultValue: "secret-default", required: true }],
  };
  const asyncQuestion: LiveElicitationRequest = {
    requestId: "async:turn-1:q", provider: "codex", kind: "question", delivery: "user-message", turnId: "turn-1",
    mode: "form", message: "Question", fields: [{ name: "q", title: "Choose", type: "select", required: true,
      options: [{ value: "a", label: "Option A" }], allowFreeText: true }],
  };
  const controller = new AbortController();
  const nativeWait = service.waitForLiveElicitationResponse("session-1", native, controller.signal);
  const asyncWait = service.waitForLiveElicitationResponse("session-1", asyncQuestion, controller.signal);
  assert.equal(service.waitForLiveElicitationResponse("session-1", asyncQuestion, controller.signal), asyncWait);
  assert.deepEqual(state.elicitationRequests?.map((item) => item.requestId), ["native", asyncQuestion.requestId]);
  assert.equal(state.elicitationRecords?.length, 2);
  service.resolveLiveElicitation("session-1", "native", { action: "accept", content: { secret: "secret-answer" } });
  assert.deepEqual(await nativeWait, { action: "accept", content: { secret: "secret-answer" } });
  assert.equal(state.elicitationRequest?.requestId, asyncQuestion.requestId);
  controller.abort();
  assert.deepEqual(await asyncWait, { action: "cancel" });
  assert.deepEqual(state.elicitationRecords?.map((item) => item.status), ["answered", "expired"]);
  assert.throws(() => service.resolveLiveElicitation("session-1", asyncQuestion.requestId, { action: "accept" }), /no longer exists/);
  const stored = normalizeMessage(JSON.parse(JSON.stringify({ role: "assistant", text: "done", elicitationRecords: state.elicitationRecords })));
  assert.deepEqual(stored?.elicitationRecords, state.elicitationRecords);
  assert.doesNotMatch(JSON.stringify(stored), /secret-default|secret-answer|defaultValue/);
  assert.deepEqual(stored?.elicitationRecords?.[1]?.fields[0]?.options, ["Option A"]);
});

// @test-value v2
// kind = "contract"
// claim = "非同期フォーム回答は対象turnの通常入力受付成功後だけ送信済みになり、失敗時は同じフォームから再試行できる"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "送信失敗を成功扱いしてフォームを閉じる、重複送信を許す、または回答を別turnへ振り替える"
// observable = "送信先turnと本文、通知signal、live質問と履歴status、resolve公開APIの成否"
// observation_boundary = "consumer"
// scope = "SessionElicitationService async answer acknowledgment"
// lifecycle = "permanent"
// impact = "回答の消失や重複を利用者に成功と表示する"
// distinction = "adapterのsteer testではフォーム状態と送信結果の対応は検証できない"
// @end-test-value
test("非同期回答は受付後に確定し失敗時はフォームを維持する", async () => {
  let state = createLiveRunState();
  let release!: () => void;
  let fail!: (reason: Error) => void;
  let sent: { sessionId: string; turnId: string; message: string } | undefined;
  let notification!: AbortSignal;
  const service = new SessionElicitationService({
    updateLiveSessionRun: (_id, recipe) => { state = recipe(state); return state; },
    notifyQuestion: (_id, signal) => { notification = signal; },
    sendUserMessage: async (sessionId, turnId, message) => {
      sent = { sessionId, turnId, message };
      await new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    },
  });
  const request: LiveElicitationRequest = {
    requestId: "async:q", provider: "codex", kind: "question", delivery: "user-message", turnId: "turn-one",
    mode: "form", message: "Question", fields: [{ name: "q", title: "Which scope?", type: "text", required: true }],
  };
  const pending = service.waitForLiveElicitationResponse("session-1", request, new AbortController().signal);
  assert.throws(() => service.resolveLiveElicitation("session-1", request.requestId, { action: "accept", content: { q: "" } }), /answer is required/);
  const first = service.resolveLiveElicitation("session-1", request.requestId, { action: "accept", content: { q: " Focused " } });
  const rejected = assert.rejects(Promise.resolve(first), /not accepted/);
  assert.throws(() => service.resolveLiveElicitation("session-1", request.requestId, { action: "accept" }), /already being sent/);
  await Promise.resolve();
  assert.deepEqual(sent, { sessionId: "session-1", turnId: "turn-one", message: "Which scope?\nFocused" });
  assert.equal(state.elicitationRecords?.[0]?.status, "pending");
  assert.equal(notification.aborted, false);
  fail(new Error("not accepted"));
  await rejected;
  assert.equal(state.elicitationRequest?.requestId, request.requestId);
  const retry = service.resolveLiveElicitation("session-1", request.requestId, { action: "accept", content: { q: "Focused" } });
  await Promise.resolve();
  release();
  await retry;
  assert.equal((await pending).action, "accept");
  assert.equal(state.elicitationRecords?.[0]?.status, "answered");
  assert.equal(state.elicitationRequest, null);
  assert.equal(notification.aborted, true);
});

// @test-value v2
// kind = "contract"
// claim = "turn終了と送信中の回答受付が競合しても操作を失効し、受付結果を待って履歴状態を確定する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md#current-runtime" }
// fault = "終端で早期に待機を解放して受付成功を未回答として保存するか、失効後に再送する"
// observable = "live操作の除去、待機Promiseのsettlement、受付結果ごとの最終record status"
// observation_boundary = "consumer"
// scope = "SessionElicitationService turn-end answer race"
// lifecycle = "permanent"
// impact = "回答済み状態を誤保存する、または終了済みturnへ重複送信する"
// distinction = "通常の回答成功とabort単体testでは同時進行時の保存境界を保証できない"
// @end-test-value
test("終了時に送信中だった回答の受付結果を待って記録を確定する", async () => {
  for (const succeeds of [true, false]) {
    let state = createLiveRunState();
    let release!: () => void;
    let settled = false;
    const service = new SessionElicitationService({
      updateLiveSessionRun: (_id, recipe) => { state = recipe(state); return state; },
      sendUserMessage: async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        if (!succeeds) throw new Error("turn ended");
      },
    });
    const request: LiveElicitationRequest = { requestId: "async", provider: "codex", kind: "question",
      delivery: "user-message", turnId: "turn", mode: "form", message: "Question",
      fields: [{ name: "q", title: "Question", type: "text", required: true }] };
    const controller = new AbortController();
    const waiting = service.waitForLiveElicitationResponse("session-1", request, controller.signal);
    void waiting.then(() => { settled = true; });
    const sent = Promise.resolve(service.resolveLiveElicitation("session-1", "async", { action: "accept", content: { q: "Answer" } }));
    const result = succeeds ? sent : assert.rejects(sent, /turn ended/);
    await Promise.resolve();
    controller.abort();
    assert.equal(state.elicitationRequest, null);
    assert.equal(settled, false);
    assert.throws(() => service.resolveLiveElicitation("session-1", "async", { action: "accept" }), /no longer exists/);
    release();
    await result;
    assert.equal((await waiting).action, succeeds ? "accept" : "cancel");
    assert.equal(state.elicitationRecords?.[0]?.status, succeeds ? "answered" : "expired");
  }
});

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
