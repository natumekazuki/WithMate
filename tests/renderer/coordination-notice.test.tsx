import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { CoordinationNotice } from "../../src/chat/conversation/coordination-notice.js";
import type { CoordinationRecord } from "../../src-shared/coordination/coordination-contract.js";
import type { CoordinationInvalidation } from "../../src-shared/coordination/coordination-window-contract.js";

// @test-value v2
// kind = "contract"
// claim = "表示範囲の相談だけ正確なIDで状態を取得し、現行回答と解決を区別し、通知・再表示・失敗回復・削除と対象変更を反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 相談状態の取得・状態文言・失敗・消去" }
// fault = "非表示/無関係通知で取得する、改訂番号を回答と誤認する、別IDの遅い応答を表示する、または失敗を解決済みとして扱う"
// observable = "get request列、状態label、loading、再試行と削除後の表示、詳細操作のexact identity/ID"
// observation_boundary = "consumer"
// scope = "CoordinationNoticeと既存useCoordinationQuery、IPCはfixture"
// lifecycle = "permanent"
// impact = "相談の現在状態を誤認し別の相談へ操作する、または長い履歴で不要な取得を増やす"
// distinction = "storage testや型検査では可視範囲・非同期通知からbuttonと状態への接続を保証できない。小さなDOMで状態遷移を確認する"
// @end-test-value
test("consultation notices read visible IDs and distinguish live answer, resolution and unavailable state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const intersections = new Map<Element, (visible: boolean) => void>();
  class Observer {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    private element: Element | null = null;
    observe(element: Element) { this.element = element; intersections.set(element, (visible) => this.callback([{ isIntersecting: visible }])); }
    disconnect() { if (this.element) intersections.delete(this.element); }
  }
  const globals = { window: dom.window, document: dom.window.document, IntersectionObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const target = { kind: "auxiliary" as const, sessionId: "aux", incarnationId: "exact-inc" };
  let record: CoordinationRecord = { id: "first", crewRootSessionId: "crew", kind: "blocker", initiator: target, initiatorTurnId: "42", originReceiptId: null, caller: null,
    body: "First question", choices: [], respondent: { kind: "user" }, state: "open", answerRevision: 2, answers: [], createdAt: "now", updatedAt: "now" };
  const requests: unknown[] = [], opened: unknown[] = [];
  const listeners = new Set<(summary: CoordinationInvalidation) => void>();
  let failure = false, deleted = false;
  let deferred: Promise<unknown> | null = null;
  Object.defineProperty(dom.window, "withmate", { value: {
    executeCoordination: async (request: unknown) => {
      requests.push(request);
      if (deferred) return deferred;
      if (failure) throw new Error("Read failed");
      if (deleted) return { error: { code: "COORDINATION_DELETED", message: "Deleted" } };
      return { record: structuredClone(record) };
    },
    subscribeCoordinationChanged: (listener: (summary: CoordinationInvalidation) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    openCoordination: async (request: unknown) => { opened.push(request); },
  } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const notify = async (id = record.id) => act(async () => { for (const listener of [...listeners]) listener({ id, crewRootSessionId: "crew", initiator: target }); });
  const visible = async (value: boolean) => act(async () => { for (const callback of intersections.values()) callback(value); });
  const state = () => dom.window.document.querySelector(".coordination-notice-state")?.textContent;
  try {
    await act(async () => root.render(<CoordinationNotice id="first" consultation="First **question**" target={target} />));
    assert.equal(requests.length, 0);
    await visible(true);
    assert.deepEqual(requests, [{ operation: "get", id: "first" }]);
    assert.equal(state(), "Awaiting Your Reply"); // Retiring an answer can leave a positive revision without an answer.
    const count = requests.length;
    await notify("unrelated");
    assert.equal(requests.length, count);
    record = { ...record, respondent: { ...target, sessionId: "respondent" } };
    await notify(); assert.equal(state(), "Awaiting Reply");
    record = { ...record, answers: [{ id: "answer", revision: 3, actor: { kind: "user" }, body: "Answer", selectedChoices: [], createdAt: "now" }] };
    await notify(); assert.equal(state(), "Reply Recorded");
    record = { ...record, state: "resolved" };
    await notify(); assert.equal(state(), "Resolved");
    record = { ...record, state: "withdrawn" };
    await notify(); assert.equal(state(), "Withdrawn");
    record = { ...record, state: "corrected" };
    await notify(); assert.equal(state(), "Corrected");
    failure = true;
    await notify(); assert.equal(state(), "State Unavailable");
    assert.ok(dom.window.document.querySelector('[aria-label="Consultation State Error"]'));
    const link = dom.window.document.querySelector<HTMLButtonElement>(".coordination-notice-link")!;
    assert.equal(link.getAttribute("aria-label"), "Open Consultation: First question");
    assert.equal(dom.window.document.getElementById(link.getAttribute("aria-describedby")!)?.textContent, "State Unavailable");
    await act(async () => link.click());
    assert.deepEqual(opened, [{ id: "first", ...target }]);
    failure = false; record = { ...record, state: "open", answers: [] };
    await act(async () => [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click());
    assert.equal(state(), "Awaiting Reply");
    assert.equal(dom.window.document.getElementById(link.getAttribute("aria-describedby")!)?.textContent, "Awaiting Reply");
    await visible(false);
    const hiddenCount = requests.length;
    await notify(); assert.equal(requests.length, hiddenCount);
    record = { ...record, state: "resolved" };
    await visible(true); assert.equal(state(), "Resolved");
    let resolveOld!: (value: unknown) => void;
    deferred = new Promise((resolve) => { resolveOld = resolve; });
    await notify();
    assert.equal(dom.window.document.querySelector('[aria-label="Loading Consultation State"]')?.getAttribute("aria-busy"), "true");
    deferred = null; record = { ...record, id: "second", state: "open", answers: [] };
    await act(async () => root.render(<CoordinationNotice id="second" consultation="Second question" target={target} />));
    await act(async () => resolveOld({ record: { ...record, id: "first", state: "withdrawn" } }));
    assert.equal(state(), "Awaiting Reply");
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".coordination-notice-link")!.click());
    assert.deepEqual(opened.at(-1), { id: "second", ...target });
    deleted = true; await notify(); assert.equal(state(), "Deleted");
    assert.equal(dom.window.document.querySelector(".coordination-notice-link .related-session-title")?.textContent, "Second question");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
