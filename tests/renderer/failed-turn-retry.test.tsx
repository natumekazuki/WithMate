import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { FailedTurnRetry } from "../../src/chat/conversation/failed-turn-retry.js";
import { FailedTurnRetryContext } from "../../src/chat/runtime/failed-turn-retry-context.js";
import { executionOperationResultSchemas } from "../../src-shared/session/session-execution-read.js";
import type { RetryFailedSessionTurnRequest, SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

// @test-value v2
// kind = "contract"
// claim = "履歴の確定失敗だけに再実行操作を示し、確定前に元送信者、編集差と副作用を知らせる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 確定した送信・実行失敗; docs/design/session-run-lifecycle.md#gui-turn-queue" }
// fault = "失敗以外に操作を出す、確認前に送る、編集差や副作用を伏せる、対象identityを取り違える"
// observable = "失敗表示に付く操作、確認dialogの内容、送信された対象と要求数"
// observation_boundary = "component-behavior"
// scope = "保存済み失敗messageの再実行確認 UI。IPCはfixture"
// lifecycle = "permanent"
// impact = "過去指示や外部副作用を認識せず別の会話を再実行する"
// distinction = "main facadeとstorageのtestは利用者への確認と画面の対象選択を検証しない"
// @end-test-value
test("failed message requires an explicit confirmation with the source and side effects", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true, url: "https://fixture.invalid" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const target = { kind: "main" as const, sessionId: "recipient", incarnationId: "recipient-inc" };
  let turnState = "failed";
  const origin = { kind: "session" as const, operation: "send" as const, targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId,
    actorKind: "main" as const, actorSessionId: "sender", actorIncarnationId: "sender-inc", actorTurnId: "12", actorSnapshot: { sessionTitle: "Source", character: { id: "sender-character", name: "Sender", iconPath: "" } } };
  const execution = () => executionOperationResultSchemas.get_execution.parse({ ok: true, origin, receiptId: "source", receiptState: turnState, turnId: "42", turnState, resultState: "partial", userMessageSeq: 4, assistantMessageSeq: 5,
    inputs: { entry: { receiptId: "source", inputSeq: 4, kind: "start", stage: "fixed", comparison: "changed", detail: { operation: "get_execution_input", receiptId: "source" } }, startChanged: true,
      additional: { confirmedCount: 0, references: [], referencesNextOffset: null, unresolved: [], unresolvedCount: 0, unresolvedNextOffset: null, notSent: [], notSentCount: 0, notSentNextOffset: null, coverage: "recorded" } }, executionSettings: null, output: null });
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: { readSessionExecution: async () => execution() } });
  const sent: Array<Omit<RetryFailedSessionTurnRequest, "executionOptions">> = [];
  const context = { submit: async (request: Omit<RetryFailedSessionTurnRequest, "executionOptions">) => { sent.push(request); return {} as SessionTurnQueueReceipt; }, blocked: () => false };
  const render = () => <FailedTurnRetryContext.Provider value={context}><FailedTurnRetry message={{ role: "assistant", text: "failure", runFailure: "failed", historyIndex: 5 }} context={{ ownerSessionId: "recipient", target }} /></FailedTurnRetryContext.Provider>;
  try {
    await act(async () => root.render(render()));
    const button = dom.window.document.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.textContent, "Retry Failed Turn");
    assert.equal(sent.length, 0);
    await act(async () => button.click());
    assert.equal(sent.length, 0);
    const dialog = dom.window.document.querySelector("dialog")!;
    assert.equal(dialog.open, true);
    assert.match(dialog.textContent!, /Sender/);
    assert.match(dialog.textContent!, /edited before/);
    assert.match(dialog.textContent!, /may already have taken effect/);
    assert.equal(dom.window.document.activeElement?.textContent, "Cancel");
    const confirm = [...dialog.querySelectorAll("button")].find((item) => item.textContent === "Retry Failed Turn")!;
    await act(async () => confirm.click());
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.receiptId, "source");
    assert.equal(sent[0]?.turnId, "42");
    assert.deepEqual(sent[0]?.target, target);
    turnState = "canceled";
    await act(async () => root.render(<></>));
    await act(async () => root.render(render()));
    assert.equal(dom.window.document.querySelector("button"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
