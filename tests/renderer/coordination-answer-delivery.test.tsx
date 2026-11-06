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
const description = {
  ok: true, origin: null, receiptId: "saved-receipt", receiptState: "completed", turnId: "42", turnState: "running", resultState: "running", userMessageSeq: 10, assistantMessageSeq: null,
  inputs: { entry: null, startChanged: false, additional: { confirmedCount: 0, references: [], referencesNextOffset: null, unresolved: [], unresolvedCount: 0, unresolvedNextOffset: null, notSent: [], notSentCount: 0, notSentNextOffset: null, coverage: "recorded" } },
  output: null,
};
const unit = { id: "saved-output", start: 0, end: 10, role: "answer", phase: "final", completion: "complete", final: true, evidence: "native-final" };

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
    toggle: async (details: HTMLDetailsElement, open = true) => { await act(async () => { details.open = open; details.dispatchEvent(new dom.window.Event("toggle")); }); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

// @test-value v2
// kind = "contract"
// claim = "保存済みCoordination回答は再mount後も展開時だけ実receiptを読み、配送完了と受信Turn実行中を分けて表示し開いている間だけ更新を読む"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/839; docs/design/desktop-ui.md Coordination Delivery Details" }
// fault = "receipt IDだけを状態扱いする、completed受付をTurn完了に読み替える、閉鎖中に履歴を先読みする"
// observable = "実component DOMのReceipt Delivery/Recipient Turn、共通readの呼出時点・実target/receipt、再mount後と通知後の読取"
// observation_boundary = "consumer"
// scope = "実CoordinationPaneの保存回答からCoordinationAnswerDeliveryとexecution GUI APIへの接続、保存serviceは状態fixture"
// lifecycle = "permanent"
// impact = "利用者が保存回答の配送と実反映を再表示で確かめられず誤って作業完了と判断する"
// distinction = "保存serviceと型検査はdisclosure/lifecycleと利用者向け状態投影を保証しない。小さいDOM consumerで境界を確認する"
// @end-test-value
test("saved answer delivery lazily reloads exact receipt after remount and separates Turn state", async () => {
  let turnState = "running";
  const record: CoordinationRecord = { id: "actual-consultation", crewRootSessionId: "actual-parent", kind: "blocker", initiator: { kind: "auxiliary", sessionId: target.sessionId, incarnationId: target.incarnationId }, initiatorTurnId: "origin-turn", originReceiptId: null, caller: null, body: "Need a decision", choices: [], respondent: { kind: "user" }, state: "open", answerRevision: 1, answers: [{ id: "answer-1", revision: 1, actor: { kind: "user" }, body: "Use the agreed approach", selectedChoices: [], createdAt: "2026-11-07T00:00:00Z", receiptId: "saved-receipt" }], history: [], createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z" };
  const h = harness(async () => ({ ...description, turnState }), {
    executeCoordination: async (request: CoordinationRequest) => request.operation === "get" ? { record, initiatorTarget: target } : { items: [], total: 0, nextOffset: null },
    subscribeCoordinationChanged: () => () => {},
  });
  const navigation = { ...record.initiator, id: record.id };
  const renderPane = (key: string) => h.root.render(<CoordinationPane key={key} sessionId="viewer-main" active navigation={navigation} />);
  try {
    await act(async () => renderPane("first"));
    assert.equal(h.requests.length, 0);
    assert.equal(h.dom.window.document.querySelector(".coordination-answer-delivery summary")?.textContent, "Saved · Delivery Details");
    await h.toggle(h.dom.window.document.querySelector<HTMLDetailsElement>(".coordination-answer-delivery")!);
    const pairs = [...h.dom.window.document.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    assert.ok(pairs.some(([label, value]) => label === "Receipt Delivery" && value === "Completed"));
    assert.ok(pairs.some(([label, value]) => label === "Recipient Turn" && value === "Running"));
    assert.ok(pairs.some(([label, value]) => label === "WithMate Turn" && value === "42"));
    assert.deepEqual(h.requests[0], { owner: "viewer-main", operation: "get_execution", request: { target, receiptId: "saved-receipt" } });
    await act(async () => { for (const listener of h.listeners) listener("other-session"); });
    assert.equal(h.requests.length, 1);
    turnState = "completed";
    await act(async () => { for (const listener of h.listeners) listener(target.sessionId); });
    assert.equal(h.requests.length, 2);
    await act(async () => renderPane("reopened"));
    assert.equal(h.requests.length, 2);
    assert.equal(h.listeners.size, 0);
    await h.toggle(h.dom.window.document.querySelector<HTMLDetailsElement>(".coordination-answer-delivery")!);
    assert.equal(h.requests.length, 3);
    assert.match(h.dom.window.document.body.textContent!, /Recipient TurnCompleted/);
  } finally { await h.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "回答配送の失敗・不明と保存結果の取得を実受付の同じ宛先へ接続し、閲覧失敗時も別Sessionや最新Turnへfallbackしない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/836#Session・受付・Turnの読取入口; https://github.com/natumekazuki/WithMate/issues/839" }
// fault = "存在しない受付を配送済みに見せる、回答結果を現在Sessionから取得する、一覧表示だけで全出力本文を先読みする"
// observable = "Delivery Unknown/Failed表示、明示操作までのread件数、出力paging requestのtarget/receipt/index/offsetと連結本文"
// observation_boundary = "consumer"
// scope = "保存回答のexecution/出力一覧/本文の必要時取得。storageとIPC認可はfixture境界"
// lifecycle = "permanent"
// impact = "利用者が別Turnの答えを回答の実反映と誤認するか、未確認の配送を成功扱いする"
// distinction = "共通reader単体はCoordination回答から出力の明示読取までの宛先固定と表示を確認しない"
// @end-test-value
test("answer delivery keeps unknown failures and lazily pages only the exact recipient result", async () => {
  let unavailable = true;
  const h = harness(async (operation, request) => {
    if (operation === "get_execution") return unavailable ? { ok: false, code: "EXECUTION_NOT_FOUND", message: "Exact receipt unavailable.", effect: "none" } : { ...description, receiptState: "failed", turnState: "failed", resultState: "partial" };
    if (operation === "list_execution_outputs") return { ...description, resultState: "partial", finality: "identified", items: [{ ...unit, index: 0, textChars: 10 }], offset: 0, total: 1, nextOffset: null };
    const offset = (request as { offset: number }).offset;
    return { ...description, unit, finality: "identified", text: offset === 0 ? "first " : "last", offset, nextOffset: offset === 0 ? 6 : null, totalChars: 10 };
  });
  try {
    await act(async () => h.root.render(<CoordinationAnswerDelivery ownerSessionId="viewer-main" target={target} receiptId="saved-receipt" />));
    await h.toggle(h.dom.window.document.querySelector("details")!);
    assert.match(h.dom.window.document.body.textContent!, /Delivery Unknown/);
    assert.equal(h.dom.window.document.querySelector("dl"), null);
    unavailable = false;
    const retry = h.dom.window.document.querySelector("button")!;
    await act(async () => retry.click());
    assert.match(h.dom.window.document.body.textContent!, /Receipt DeliveryFailed/);
    assert.equal(h.requests.length, 2);
    const resultDetails = h.dom.window.document.querySelectorAll("details")[1];
    await h.toggle(resultDetails);
    assert.equal(h.requests.at(-1)?.operation, "list_execution_outputs");
    assert.equal(h.requests.some(({ operation }) => operation === "get_execution_output"), false);
    const readButton = [...h.dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Read Final Answer 1")!;
    await act(async () => readButton.click());
    const more = [...h.dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Load More Output")!;
    await act(async () => more.click());
    assert.equal(h.dom.window.document.querySelector("pre")?.textContent, "first last");
    assert.deepEqual(h.requests.slice(-2).map(({ operation, request }) => ({ operation, request })), [0, 6].map((offset) => ({ operation: "get_execution_output", request: { target, receiptId: "saved-receipt", index: 0, offset } })));
    assert.ok(h.requests.every(({ owner }) => owner === "viewer-main"));
  } finally { await h.close(); }
});
