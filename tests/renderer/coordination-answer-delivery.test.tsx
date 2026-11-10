import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CoordinationAnswerDelivery } from "../../src/coordination/CoordinationAnswerDelivery.js";
import { CoordinationPane } from "../../src/coordination/CoordinationPane.js";
import type { CoordinationRecord, CoordinationRequest } from "../../src-shared/coordination/coordination-contract.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { ExecutionReadOperation } from "../../src-shared/session/session-execution-read.js";

const target: SessionTarget = { kind: "auxiliary", sessionId: "actual-aux", incarnationId: "actual-aux-inc", mainSessionId: "actual-parent", mainIncarnationId: "actual-parent-inc" };
const description = { ok: true, origin: null, receiptId: "saved-receipt", receiptState: "completed", turnId: "42", turnState: "running", resultState: "running", userMessageSeq: 10, assistantMessageSeq: null };

function harness(read: (operation: ExecutionReadOperation, request: unknown) => Promise<unknown>, extraApi: Record<string, unknown> = {}) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  for (const key of ["HTMLElement", "Node", "navigator"] as const) Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  const requests: { owner: string; operation: ExecutionReadOperation; request: unknown }[] = [];
  const listeners = new Set<(id: string) => void>();
  const subscribe = (listener: (id: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  Object.defineProperty(dom.window, "withmate", { value: {
    readSessionExecution: async (owner: string, operation: ExecutionReadOperation, request: unknown) => { requests.push({ owner, operation, request }); return read(operation, request); },
    onSessionTurnQueueChanged: subscribe, onSessionTurnUpdated: subscribe,
    ...extraApi,
  } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  return { dom, root, requests, listeners,
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

// @test-value v2
// kind = "contract"
// claim = "保存回答の実receiptを起票元へ照会し、配送完了を受信Turn完了や回答利用と混同せずに表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordinationの保存・配送・利用" }
// fault = "別のSessionやreceiptを読み、受付完了をTurn完了や回答利用として表示する"
// observable = "実paneの配送statusとexact target/receiptの読取、対象通知後の状態、pane非表示中の購読解除"
// observation_boundary = "consumer"
// scope = "CoordinationPaneの最新保存回答からexecution読取まで。storageとIPCはfixture"
// lifecycle = "permanent"
// impact = "利用者が別の応答を確認する、または未完了の処理を完了と誤認する"
// distinction = "保存serviceと型検査だけではrendererのtarget固定と表示を確認できない"
// @end-test-value
test("saved answer reads the exact delivery without claiming the recipient turn is complete", async () => {
  let turnState = "running";
  const record: CoordinationRecord = { id: "actual-consultation", crewRootSessionId: "actual-parent", kind: "blocker", initiator: { kind: "auxiliary", sessionId: target.sessionId, incarnationId: target.incarnationId }, initiatorTurnId: "origin-turn", originReceiptId: null, caller: null, body: "Need a decision", choices: [], respondent: { kind: "user" }, state: "open", answerRevision: 1, answers: [{ id: "answer-1", revision: 1, actor: { kind: "user" }, body: "Use the agreed approach", selectedChoices: [], createdAt: "2026-11-07T00:00:00Z", receiptId: "saved-receipt" }], history: [], createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z" };
  const h = harness(async () => ({ ...description, turnState }), {
    getCoordinationIdentity: async () => ({ title: "Origin Session", character: { name: "Origin Character", iconPath: "" } }),
    subscribeSessionInvalidation: () => () => {},
    executeCoordination: async (request: CoordinationRequest) => request.operation === "get" ? { record, initiatorTarget: target } : { items: [], total: 0, nextOffset: null },
    subscribeCoordinationChanged: () => () => {},
  });
  const navigation = { ...record.initiator, id: record.id };
  const renderPane = (active: boolean) => h.root.render(<CoordinationPane sessionId="viewer-main" active={active} navigation={navigation} />);
  try {
    await act(async () => renderPane(true));
    assert.match(h.dom.window.document.body.textContent!, /Delivered/);
    assert.doesNotMatch(h.dom.window.document.body.textContent!, /Turn Completed|Answer Used/);
    assert.deepEqual(h.requests[0], { owner: "viewer-main", operation: "get_execution", request: { target, receiptId: "saved-receipt" } });
    await act(async () => { for (const listener of h.listeners) listener("other-session"); });
    assert.equal(h.requests.length, 1);
    turnState = "failed";
    await act(async () => { for (const listener of h.listeners) listener(target.sessionId); });
    assert.match(h.dom.window.document.body.textContent!, /Delivered · Turn Failed/);
    await act(async () => renderPane(false));
    assert.equal(h.listeners.size, 0);
    await act(async () => renderPane(true));
    assert.equal(h.requests.length, 3);
  } finally { await h.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "回答配送を確認できない時は不明と示し、同じreceiptの再読取で失敗を判別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md Coordinationの保存・配送・回復" }
// fault = "取得失敗を配送成功に見せる、または再確認時に別のSessionやreceiptへfallbackする"
// observable = "Delivery Unknown/Failedと明示retry後のexact target/receiptへの読取"
// observation_boundary = "consumer"
// scope = "保存回答の配送状態の読取と再試行。storageとIPC認可はfixture"
// lifecycle = "permanent"
// impact = "未確認の配送を成功と誤認し、相談を放置する"
// distinction = "共通reader単体はCoordination回答からの宛先固定と利用者向け不明表示を確認しない"
// @end-test-value
test("answer delivery preserves unknown and failure for the exact receipt", async () => {
  let unavailable = true;
  const h = harness(async () => unavailable ? { ok: false, code: "EXECUTION_NOT_FOUND", message: "Exact receipt unavailable.", effect: "none" } : { ...description, receiptState: "failed", turnState: "failed" });
  try {
    await act(async () => h.root.render(<CoordinationAnswerDelivery ownerSessionId="viewer-main" target={target} receiptId="saved-receipt" />));
    assert.match(h.dom.window.document.body.textContent!, /Delivery Unknown/);
    unavailable = false;
    const retry = h.dom.window.document.querySelector("button")!;
    await act(async () => retry.click());
    assert.match(h.dom.window.document.body.textContent!, /Delivery Failed/);
    assert.deepEqual(h.requests.map(({ owner, operation, request }) => ({ owner, operation, request })), [0, 1].map(() => ({ owner: "viewer-main", operation: "get_execution", request: { target, receiptId: "saved-receipt" } })));
  } finally { await h.close(); }
});
