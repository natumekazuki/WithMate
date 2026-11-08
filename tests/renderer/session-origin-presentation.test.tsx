import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionTurnQueueRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import { SentDeliveryRow } from "../../src/chat/conversation/sent-delivery-row.js";
import type { SentDelivery } from "../../src/chat/conversation/use-sent-deliveries.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

const origin = { kind: "session" as const, actorKind: "auxiliary" as const, actorSessionId: "sender-aux", actorMainSessionId: "sender-main", actorIncarnationId: "sender-inc", actorTurnId: "42", operation: "send" as const, targetSessionId: "target", targetIncarnationId: "target-inc",
  actorSnapshot: { sessionTitle: "Saved Sender Title", character: { id: "sender", name: "Saved Sender", iconPath: "" } },
  targetSnapshot: { sessionTitle: "Saved Target Title", character: { id: "target-character", name: "Saved Target", iconPath: "" } } };
const receipt: SessionTurnQueueReceipt = { id: "receipt", sessionId: "target", incarnationId: "target-inc", state: "queued", sequence: 1, queuePosition: 1, requestId: "request", turnId: null, userMessageSeq: null, inputTurnId: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
  captured: { origin, request: { userMessage: "Saved Instruction", clientRequestId: "request", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" } };
const context = { ownerSessionId: "sender-main", target: { kind: "main" as const, sessionId: "sender-main", incarnationId: "source-inc" } };
const item: SentDelivery = { receiptId: "receipt", sequence: 1, sourceTurnId: "42", sourceMessageSeq: 3, target: { kind: "main", sessionId: "target", incarnationId: "target-inc" }, state: "queued", origin, textPreview: "preview", textChars: 9 };

// @test-value v2
// kind = "contract"
// claim = "受信指示は保存送信者snapshotとSession名を本文に結び付け、snapshotのない既存入力へ現在Characterを代用しない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#現行DBと正本" }
// fault = "受信rowに現在の受信Characterを出す、保存送信者名を失う、またはsnapshot欠落を現在identityで埋める"
// observable = "受信rowのCharacter名、Session名、本文、Unknown Sender表示"
// observation_boundary = "component-behavior"
// scope = "SessionTurnQueueRowの送信者snapshot投影"
// lifecycle = "permanent"
// impact = "利用者が誰からの指示か取り違える"
// distinction = "保存testではrendererの送信者と受信者の取り違えを検出しない。小さなSSRで識別表示を検証する"
// @end-test-value
test("incoming rows use saved sender identity and retain unknown legacy identity", () => {
  const render = (value: SessionTurnQueueReceipt) => new JSDOM(renderToStaticMarkup(<SessionTurnQueueRow receipt={value} character={{ name: "Current Recipient", iconPath: "" }} busy={false} onCancel={() => {}} onRelease={() => {}} />)).window.document;
  const document = render(receipt);
  assert.equal(document.querySelector(".message-character-name")?.textContent, "Saved Sender");
  assert.equal(document.querySelector(".related-session-title")?.textContent, "Saved Sender Title");
  assert.match(document.querySelector(".message-card")!.textContent!, /Saved Instruction/);
  const legacy = render({ ...receipt, captured: { ...receipt.captured, origin: { ...origin, actorSnapshot: undefined } } });
  assert.equal(legacy.querySelector(".message-character-name")?.textContent, "Unknown Sender");
});

// @test-value v2
// kind = "contract"
// claim = "送信表示は正確な宛先とreceiptで原文を継続取得し、既読本文を保持したまま配送状態を通知と再展開で更新する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "別宛先へ照会する、続きや状態更新で既読本文を置換する、取得失敗を全文取得済みにする、または配送状態を初回値のまま固定する"
// observable = "読取requestのtarget・receipt・offsetとsnapshot、表示本文、再読操作、通知と再展開後の配送とTurn状態"
// observation_boundary = "consumer"
// scope = "SentDeliveryRowのbounded previewから共通execution原文読取への接続"
// lifecycle = "permanent"
// impact = "送信した指示の全文が欠落するか、別の送信内容を表示する"
// distinction = "storage読取とhook testは全文buttonから継続snapshotとDOMへの接続を通らない"
// @end-test-value
test("sent messages retain input pages while refreshing exact delivery state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const requests: Record<string, unknown>[] = [];
  const statusRequests: Record<string, unknown>[] = [];
  let fail = false;
  let statusFail = false;
  let receiptState = "queued";
  let turnState = "running";
  let turnUpdated: ((id: string) => void) | undefined;
  let queueChanged: ((id: string) => void) | undefined;
  Object.defineProperty(dom.window, "withmate", { value: { openSession: async () => {}, readSessionExecution: async (_owner: string, operation: string, request: Record<string, unknown>) => {
    if (operation === "get_execution") {
      statusRequests.push(request);
      if (statusFail) return { ok: false, message: "State Read Failed" };
      return { ok: true, receiptState, turnState, turnId: "53" };
    }
    assert.equal(operation, "get_execution_input"); requests.push(request);
    if (fail) return { ok: false, message: "Read Failed" };
    const continuation = request.offset === 5;
    return { ok: true, receiptState: "completed", turnState: "running", turnId: "53", expectedInput: "snapshot", inputPair: { original: { text: continuation ? "text" : "full ", offset: continuation ? 5 : 0, nextOffset: continuation ? null : 5 }, comparison: null } };
  }, onSessionTurnUpdated: (listener: (id: string) => void) => { turnUpdated = listener; return () => { turnUpdated = undefined; }; },
  onSessionTurnQueueChanged: (listener: (id: string) => void) => { queueChanged = listener; return () => { queueChanged = undefined; }; } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const click = async (label: string) => { const button = [...dom.window.document.querySelectorAll("button")].find((element) => element.textContent?.includes(label) || element.getAttribute("aria-label") === label)!; assert.ok(button); await act(async () => button.click()); };
  try {
    await act(async () => root.render(<SentDeliveryRow item={item} context={context} />));
    assert.equal(requests.length, 0);
    assert.match(dom.window.document.body.textContent!, /Saved Target.*Saved Target Title/);
    await click("Read Full Message");
    assert.equal(requests[0].receiptId, "receipt"); assert.deepEqual(requests[0].target, item.target);
    fail = true; await click("Load More Message");
    assert.match(dom.window.document.body.textContent!, /full/); assert.match(dom.window.document.body.textContent!, /Read Failed/);
    fail = false; await click("Load More Message");
    assert.equal(requests.at(-1)!.offset, 5); assert.equal(requests.at(-1)!.expectedInput, "snapshot");
    assert.match(dom.window.document.body.textContent!, /full text/);
    await click("Show Delivery Details");
    const state = (label: string) => [...dom.window.document.querySelectorAll("dt")].find((term) => term.textContent === label)?.nextElementSibling?.textContent;
    assert.equal(state("Receipt State"), "Queued");
    assert.equal(state("Turn State"), "Running");
    assert.deepEqual(statusRequests[0], { target: item.target, receiptId: item.receiptId });
    receiptState = "completed";
    await act(async () => root.render(<SentDeliveryRow item={{ ...item, state: "completed" }} context={context} />));
    assert.equal(state("Receipt State"), "Completed");
    turnState = "completed";
    await act(async () => turnUpdated?.("target"));
    assert.equal(state("Turn State"), "Completed");
    assert.match(dom.window.document.body.textContent!, /full text/);
    const readCount = statusRequests.length;
    await act(async () => queueChanged?.("unrelated-target"));
    assert.equal(statusRequests.length, readCount);
    await click("Hide Delivery Details");
    statusFail = true;
    await click("Show Delivery Details");
    assert.equal(statusRequests.length, readCount + 1);
    assert.match(dom.window.document.body.textContent!, /State Read Failed/);
    assert.match(dom.window.document.body.textContent!, /full text/);
    statusFail = false; turnState = "failed";
    await click("Retry Delivery Details");
    assert.equal(state("Turn State"), "Failed");
    assert.match(dom.window.document.body.textContent!, /full text/);
    assert.equal(requests.length, 3, "state refresh does not reread or replace input pages");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
