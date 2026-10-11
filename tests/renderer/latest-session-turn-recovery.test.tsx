import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { useLatestSessionTurn, type LatestSessionTurnApi } from "../../src/chat/runtime/use-latest-session-turn.js";
import { resolveRetryBannerSource } from "../../src/chat/retry-state.js";
import { buildLiveSessionRecoveryActions } from "../../src/chat/live-session-projection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function canceledTurn(sessionId: string): SessionTurnRecord {
  return { id: 1, sessionId, phase: "canceled", createdAt: "now", provider: "codex", model: "model", reasoningEffort: "medium", approvalMode: "never", threadId: "thread", errorMessage: "", userMessageSeq: 0 };
}

// @test-value v2
// kind = "contract"
// claim = "同ownerのturn再取得中・失敗時はCanceledの回復操作を保持し、初回失敗も明示Retryで回復でき、owner/incarnation切替には古いturnを適用しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#表示言語・操作・状態" }
// fault = "再取得で既知turnを消す、読取errorや明示Retryを表示しない、または別owner/incarnationへ古いturn応答を反映する"
// observable = "production hookのturn/loading/error、recovery consumerのCanceled・Resend・Edit・alert・Retry・busy DOM、API読取回数"
// observation_boundary = "consumer"
// scope = "latest-session-turn-and-recovery-actions"
// lifecycle = "permanent"
// impact = "取消済み依頼の回復操作が消えたり、取得障害を理解・回復できず、別会話の取消状態を誤表示する"
// distinction = "型checkと同期Retry投影testが扱わない通知・revision再取得・失敗・遅延owner切替をproduction hookからDOMまで観測する"
// @end-test-value
test("latest turn recovery retains known cancellation and isolates owner read failures", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const requests: Array<{ sessionId: string; result: ReturnType<typeof deferred<SessionTurnRecord | null>> }> = [];
  const listeners = new Set<(id: string) => void>();
  const api: LatestSessionTurnApi = {
    getLatestSessionTurn: (sessionId) => {
      const result = deferred<SessionTurnRecord | null>();
      requests.push({ sessionId, result });
      return result.promise;
    },
    onSessionTurnUpdated: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  let sessionId = "main";
  let scope = "incarnation-1";
  let revision = "first";
  let output: ReturnType<typeof useLatestSessionTurn> | undefined;
  const noop = () => {};
  function Harness() {
    output = useLatestSessionTurn(api, sessionId, scope, revision);
    const source = resolveRetryBannerSource({ sessionId, messages: [{ role: "user", text: "Fix it" }], latestTurn: output.turn, runState: "idle" });
    return buildLiveSessionRecoveryActions({
      retryBanner: source ? { kind: source.kind, badge: "Canceled", title: "This request was stopped", lastRequestText: source.lastRequestText } : null,
      latestTurnLoading: output.loading, latestTurnError: output.error, onRetryLatestTurn: output.retry,
      isRetryActionDisabled: false, isRetryEditDisabled: false, isRetryDraftReplacePending: false,
      onResendLastMessage: noop, onEditLastMessage: noop, onConfirmRetryDraftReplace: noop, onCancelRetryDraftReplace: noop,
    });
  }
  const state = () => { assert.ok(output); return output; };
  const render = async () => { await act(async () => root.render(<Harness />)); };
  const update = async () => { await act(async () => { for (const listener of listeners) listener(sessionId); }); };
  const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  const assertCanceledActions = () => {
    assert.match(host.textContent ?? "", /Canceled/);
    assert.ok(button("Resend"));
    assert.ok(button("Edit"));
    assert.equal(button("Resend")!.disabled, false);
  };
  try {
    await render();
    assert.equal(state().loading, true);
    assert.ok(host.querySelector('[role="status"][aria-label="Loading latest execution"]'));
    await act(async () => requests[0].result.reject(new Error("first read failed")));
    assert.match(host.querySelector('[role="alert"]')!.textContent ?? "", /latest execution: first read failed/);
    assert.ok(button("Retry"));
    assert.equal(requests.length, 1);
    await act(async () => button("Retry")!.click());
    assert.equal(requests.length, 2);
    await act(async () => requests[1].result.resolve(canceledTurn("main")));
    assertCanceledActions();

    await update();
    assert.equal(state().turn?.phase, "canceled");
    assert.equal(host.querySelector("section")!.getAttribute("aria-busy"), "true");
    assertCanceledActions();
    await act(async () => requests[2].result.reject(new Error("refresh failed")));
    assertCanceledActions();
    assert.match(host.querySelector('[role="alert"]')!.textContent ?? "", /refresh failed/);
    assert.equal(requests.length, 3);
    await act(async () => button("Retry")!.click());
    assertCanceledActions();
    await act(async () => requests[3].result.resolve(canceledTurn("main")));
    assert.equal(state().error, null);
    assert.equal(host.querySelector('[role="alert"]'), null);

    revision = "updated";
    await render();
    assertCanceledActions();
    await act(async () => requests[4].result.reject(new Error("revision failed")));
    assertCanceledActions();

    await update();
    sessionId = "other";
    await render();
    assert.equal(state().turn, null);
    await act(async () => requests[5].result.resolve(canceledTurn("main")));
    assert.equal(state().turn, null);
    await act(async () => requests[6].result.resolve(canceledTurn("other")));
    assertCanceledActions();
    await update();
    scope = "incarnation-2";
    await render();
    assert.equal(state().turn, null);
    await act(async () => requests[7].result.resolve(canceledTurn("other")));
    assert.equal(state().turn, null);
    await act(async () => requests[8].result.reject(new Error("new incarnation failed")));
    assert.equal(state().turn, null);
    assert.match(host.querySelector('[role="alert"]')!.textContent ?? "", /new incarnation failed/);
    assert.ok(button("Retry"));
    await act(async () => button("Retry")!.click());
    await act(async () => requests[9].result.resolve(null));
    assert.equal(state().turn, null);
    assert.equal(state().loading, false);
    assert.equal(state().error, null);
    assert.equal(host.textContent, "");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
