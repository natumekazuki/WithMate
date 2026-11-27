import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { CancelSessionRunRequest, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { useSessionRunActions } from "../../src/chat/runtime/session-run-actions.js";

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの取消はAPI待機中から対象会話をbusyにし、同じrunの重複要求を抑止する。live受付へ引継ぎ、失敗では再試行可能へ戻り、owner切替と次run開始後の旧ACKは新しい取消要求を解除しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Main／Auxiliaryの取消click直後からのbusyとlive状態への引継ぎ" }
// fault = "live受付までfeedbackしない、取消を二重送信する、失敗後もbusyを残す、別ownerをbusyにする、または旧ACKで次runの取消busyを解除する"
// observable = "hook consumerのpendingCancelSessionIds、APIへ渡るowner/世代/Turnまたはreceiptと呼出数、error通知"
// observation_boundary = "consumer"
// scope = "Main/Aux cancellation request feedback lifetime"
// lifecycle = "permanent"
// impact = "取消操作の受付が分からず重複操作され、会話切替や次runで誤ったbusy状態が残る"
// distinction = "Window testのMain操作とは別に、Auxの取消・API失敗後の回復・次runの取消要求と旧ACKの競合を、小さいhook consumerとdeferredで検査する"
// @end-test-value
test("取消要求のbusyはMain/Auxの対象runへ限定し、失敗と遅いACKを扱う", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const listeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]>();
  const requests: { target: CancelSessionRunRequest; kind: string; resolve(): void; reject(error: Error): void }[] = [];
  const request = (target: CancelSessionRunRequest, kind: string) => new Promise<void>((resolve, reject) => requests.push({ target, kind, resolve, reject }));
  const api = {
    subscribeLiveSessionRun: (listener: Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancelSessionRun: (target: CancelSessionRunRequest) => request(target, "main"),
    cancelAuxiliarySessionRun: (target: CancelSessionRunRequest) => request(target, "auxiliary"),
  } as WithMateWindowApi;
  const errors: string[] = [];
  let owner = "main";
  const stopTarget = (sessionId: string, id: string, kind: "turn" | "receipt" = "turn", receiptId?: string) => ({
    request: { sessionId, incarnationId: `${sessionId}-generation`, execution: { kind, id } }, receiptId,
  });
  let target: ReturnType<typeof stopTarget> | null = null;
  let latest!: ReturnType<typeof useSessionRunActions>;
  function View() {
    latest = useSessionRunActions({ api, activeRunSessionId: owner, stopTargets: [target], setLiveRunState() {}, onError: (error) => errors.push(error) });
    return null;
  }
  const render = () => act(async () => root.render(<View />));
  const live = (id: string, sessionTurnId: string, cancellationState?: "requested" | "terminating", receiptId?: string): LiveSessionRunState => ({
    sessionId: id, threadId: "thread", sessionTurnId, turnId: "native-turn", cancellationState, assistantText: "received", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
    queueReceipt: receiptId ? { id: receiptId, incarnationId: `${id}-generation`, userMessageSeq: 0 } : undefined,
  });
  const emit = (id: string, state: LiveSessionRunState | null) => act(async () => listeners.forEach((listener) => listener(id, state)));
  try {
    await render();
    for (const kind of ["main", "auxiliary"] as const) {
      const firstTarget = kind === "main" ? stopTarget(kind, "first") : stopTarget(kind, "start-receipt", "receipt", "start-receipt");
      owner = kind; target = firstTarget; await render();
      let first!: Promise<void>;
      const start = requests.length;
      await act(async () => { first = latest.cancelRun(firstTarget, kind); void latest.cancelRun(firstTarget, kind); });
      assert.equal(requests.length, start + 1);
      assert.deepEqual([requests[start]!.target, requests[start]!.kind], [firstTarget.request, kind]);
      assert.equal(latest.pendingCancelSessionIds.has(kind), true);
      owner = "other"; await render();
      assert.equal(latest.pendingCancelSessionIds.has(owner), false);
      owner = kind; await render();
      assert.equal(latest.pendingCancelSessionIds.has(kind), true);
      const promoted = stopTarget(kind, "first", "turn", firstTarget.receiptId);
      target = promoted; await render();
      assert.equal(latest.pendingCancelSessionIds.has(kind), true, "promotion keeps feedback for the same receipt");
      await emit(kind, live(kind, "first", "requested", firstTarget.receiptId));
      assert.equal(latest.pendingCancelSessionIds.has(kind), false, "live cancellation owns feedback after receipt");
      await act(async () => { void latest.cancelRun(promoted, kind); });
      assert.equal(requests.length, start + 1, "receipt cannot reopen the same request before ACK");
      await emit(kind, null);
      await emit(kind, live(kind, "second"));
      const secondTarget = stopTarget(kind, "second");
      target = secondTarget; await render();
      let second!: Promise<void>;
      await act(async () => { second = latest.cancelRun(secondTarget, kind); });
      await act(async () => { requests[start]!.resolve(); await first; });
      assert.equal(latest.pendingCancelSessionIds.has(kind), true, "old ACK cannot remove next run request feedback");
      await act(async () => { requests[start + 1]!.reject(new Error(`${kind} cancel failed`)); await second; });
      assert.equal(latest.pendingCancelSessionIds.has(kind), false);
      let retry!: Promise<void>;
      await act(async () => { retry = latest.cancelRun(secondTarget, kind); });
      assert.equal(requests.length, start + 3, "failed cancellation can be retried");
      await emit(kind, live(kind, "third"));
      target = stopTarget(kind, "third"); await render();
      assert.equal(latest.pendingCancelSessionIds.has(kind), false, "a newer live turn clears stale request feedback without waiting for ACK");
      await act(async () => { requests[start + 2]!.resolve(); await retry; });
    }
    assert.deepEqual(errors, ["main cancel failed", "auxiliary cancel failed"]);
  } finally {
    requests.forEach((pending) => pending.resolve());
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
