import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import { useLatestSessionTurn, type LatestSessionTurnApi } from "../../src/chat/runtime/use-latest-session-turn.js";
import { resolveRetrySource } from "../../src/chat/retry-state.js";
import { buildLiveSessionRecoveryActions } from "../../src/chat/live-session-projection.js";
import { SessionRecoveryActions } from "../../src/chat/runtime/session-recovery-actions.js";

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
// claim = "turn読込はbusy status、取得失敗はalertとRetryで示し、既知のCanceled回復操作を保持しながらowner/incarnationを分離する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "読込statusを失う、再取得で既知turnを消す、取得失敗のRetryを失う、または別owner/incarnationへ古いturn応答を反映する"
// observable = "production hookのturn/loading/error、loading statusのbusy属性、Resend・Edit・alert・RetryのDOM、API読取回数"
// observation_boundary = "consumer"
// scope = "latest-session-turn-and-recovery-actions"
// lifecycle = "permanent"
// impact = "正常な送信や背景読込を失敗と誤認させず、取消済み依頼と実際の取得障害からの回復操作を維持する"
// distinction = "既存の同期component testや型checkでは検出できない通知・revision再取得・開始と完了・失敗・遅延owner切替を一つのproduction hookとconsumerで確認する"
// @end-test-value
test("latest turn recovery separates normal loading, preserves recovery, and isolates owner reads", async () => {
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
  let runState: Session["runState"] = "idle";
  let output: ReturnType<typeof useLatestSessionTurn> | undefined;
  const noop = () => {};
  function Harness() {
    output = useLatestSessionTurn(api, sessionId, scope, revision);
    const source = resolveRetrySource({ sessionId, messages: [{ role: "user", text: "Fix it" }], latestTurn: output.turn, runState });
    return <SessionRecoveryActions {...buildLiveSessionRecoveryActions({
      retryState: source ? { kind: source.kind, lastRequestText: source.lastRequestText } : null,
      requestKey: `${sessionId}:${scope}:0`, targetLabel: sessionId,
      latestTurnLoading: output.loading, latestTurnError: output.error, onRetryLatestTurn: output.retry,
      isRetryActionDisabled: false, isRetryEditDisabled: false, isRetryDraftReplacePending: false,
      onResendLastMessage: noop, onEditLastMessage: noop, onConfirmRetryDraftReplace: noop, onCancelRetryDraftReplace: noop,
    })} />;
  }
  const state = () => { assert.ok(output); return output; };
  const render = async () => { await act(async () => root.render(<Harness />)); };
  const update = async () => { await act(async () => { for (const listener of listeners) listener(sessionId); }); };
  const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  const assertNormalLoading = () => {
    const status = host.querySelector('[role="status"][aria-label="Loading latest execution"]');
    assert.ok(status);
    assert.equal(status.getAttribute("aria-busy"), "true");
    assert.equal(host.querySelector('[role="alert"]'), null);
    assert.equal(button("Resend"), undefined);
  };
  const assertCanceledActions = () => {
    assert.equal(state().turn?.phase, "canceled");
    assert.ok(button("Resend"));
    assert.ok(button("Edit"));
    assert.equal(button("Resend")!.disabled, false);
  };
  try {
    await render();
    assert.equal(state().loading, true);
    assertNormalLoading();
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
    assert.equal(host.querySelector('[role="group"]')!.getAttribute("aria-busy"), "true");
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
    assertNormalLoading();
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

    runState = "running";
    revision = "started";
    await render();
    assertNormalLoading();
    await act(async () => requests[10].result.resolve({ ...canceledTurn("other"), phase: "running" }));
    assert.equal(host.childElementCount, 0);
    runState = "idle";
    revision = "completed";
    await render();
    assertNormalLoading();
    await act(async () => requests[11].result.resolve({ ...canceledTurn("other"), phase: "completed" }));
    assert.equal(host.childElementCount, 0);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
