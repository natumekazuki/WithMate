import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionTurnQueueRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import { SentDeliveryRow } from "../../src/chat/conversation/sent-delivery-row.js";
import { SessionOriginRoute } from "../../src/chat/conversation/turn-input-details.js";
import type { SentDelivery, SentSteer } from "../../src/chat/conversation/use-sent-deliveries.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { sentInstructionFixtureItem } from "./sent-instruction-reader-fixture.js";

const origin = { kind: "session" as const, actorKind: "auxiliary" as const, actorSessionId: "sender-aux", actorMainSessionId: "sender-main", actorIncarnationId: "sender-inc", actorTurnId: "42", operation: "send" as const, targetSessionId: "target", targetIncarnationId: "target-inc",
  actorSnapshot: { sessionTitle: "Saved Sender Title", character: { id: "sender", name: "Saved Sender", iconPath: "" } },
  targetSnapshot: { sessionTitle: "Saved Target Title", character: { id: "target-character", name: "Saved Target", iconPath: "" } } };
const receipt: SessionTurnQueueReceipt = { id: "receipt", sessionId: "target", incarnationId: "target-inc", state: "queued", sequence: 1, queuePosition: 1, requestId: "request", turnId: null, userMessageSeq: null, inputTurnId: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
  captured: { origin, request: { userMessage: "Saved Instruction", clientRequestId: "request", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" } };
const context = { ownerSessionId: "sender-main", target: { kind: "main" as const, sessionId: "sender-main", incarnationId: "source-inc" } };
const item: SentDelivery = { receiptId: "receipt", sequence: 1, sourceTurnId: "42", sourceMessageSeq: 3, target: { kind: "main", sessionId: "target", incarnationId: "target-inc" }, state: "queued", origin, text: `${"Saved instruction. ".repeat(40)}End of full message.` };

// @test-value v2
// kind = "contract"
// claim = "直接Steerの送信カードは保存宛先・全文と不明/未送信理由を示し、状態詳細はreceiptではなく正確な宛先messageで読む"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; https://github.com/natumekazuki/WithMate/issues/966" }
// fault = "直接入力を通常受付として表示する、未確定を確認済みにする、または別の入力・Turnの状態を読む"
// observable = "送信カードの全文・宛先・unknown/not-sent理由とget_executionのtarget/messageSeq、Delivery Detailsの項目"
// observation_boundary = "consumer"
// scope = "本番SentDeliveryRowと共通AdditionalInputStatus。execution応答はfixture"
// lifecycle = "permanent"
// impact = "訂正の宛先や受信状態を誤認し、未送信を完了した指示として扱う"
// distinction = "型検査とstorage testでは実DOMの表示と詳細入口からの正確な照会を検証できない。4状態は同じ小型DOMで確認する"
// @end-test-value
test("direct Steer cards show the recorded input state and read the exact message", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const requests: unknown[] = [];
  Object.defineProperty(dom.window, "withmate", { value: { openSession: async () => {}, readSessionExecution: async (_owner: string, operation: string, request: unknown) => {
    assert.equal(operation, "get_execution"); requests.push(request); return { ok: true, turnState: "running", receiptState: null };
  } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const steer: SentSteer = { sequence: 1, sourceTurnId: "42", sourceMessageSeq: 3, target: item.target, messageSeq: 7, state: "pending", text: item.text,
    origin: { ...origin, actorKind: "main", actorSessionId: "sender-main", operation: "steer" } };
  try {
    for (const [state, reason] of [["pending", null], ["unknown", "Delivery or saving could not be confirmed. This input is not a confirmed addition."], ["not-sent", "This input was not delivered to the Turn. It has not been sent as a new Turn."], ["confirmed", null]] as const) {
      await act(async () => root.render(<SentDeliveryRow item={sentInstructionFixtureItem({ ...steer, state })} context={context} />));
      const row = dom.window.document.querySelector("article")!;
      assert.ok(row.textContent?.includes(item.text));
      assert.equal(row.querySelector(".session-message-mention")?.textContent, "@Saved Target");
      assert.equal(row.querySelector('[role="alert"]')?.textContent ?? null, reason);
    }
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Show Delivery Details"]')!.click());
    assert.deepEqual(requests, [{ target: item.target, messageSeq: 7 }]);
    assert.deepEqual([...dom.window.document.querySelectorAll("dt")].map((element) => element.textContent), ["Turn State"]);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "受信指示は保存送信者・送信元Session・@宛先を区別して本文に結び付け、snapshotのない既存入力へ現在Characterを代用しない"
// oracle = { type = "contract", ref = "docs/design/database-schema.md#現行DBと正本; docs/design/desktop-ui.md#turn-input-details" }
// fault = "受信rowの発言者と@宛先を取り違える、保存送信者名を失う、またはsnapshot欠落を現在identityで埋める"
// observable = "受信rowの発言者名、@宛先、送信元Sessionリンク、本文、Unknown SenderとUnknown Recipient表示"
// observation_boundary = "component-behavior"
// scope = "SessionTurnQueueRowの送信者snapshot投影"
// lifecycle = "permanent"
// impact = "利用者が誰からの指示か取り違える"
// distinction = "保存testではrendererの送信者と受信者の取り違えを検出しない。小さなSSRで識別表示を検証する"
// @end-test-value
test("incoming rows use saved sender identity and retain unknown legacy identity", () => {
  const render = (value: SessionTurnQueueReceipt) => new JSDOM(renderToStaticMarkup(<SessionTurnQueueRow receipt={value} character={{ name: "Current Recipient", iconPath: "" }} busy={false} onCancel={() => {}} />)).window.document;
  const document = render(receipt);
  assert.equal(document.querySelector(".message-character-name")?.textContent, "Saved Sender");
  assert.equal(document.querySelector(".related-session-title")?.textContent, "Saved Sender Title");
  assert.equal(document.querySelector(".session-message-mention")?.textContent, "@Saved Target");
  assert.equal(document.querySelector(".related-session-direction")?.textContent, "From");
  assert.match(document.querySelector(".message-card")!.textContent!, /Saved Instruction/);
  const legacy = render({ ...receipt, captured: { ...receipt.captured, origin: { ...origin, actorSnapshot: undefined, targetSnapshot: undefined } } });
  assert.equal(legacy.querySelector(".message-character-name")?.textContent, "Unknown Sender");
  assert.equal(legacy.querySelector(".session-message-mention")?.textContent, "@Unknown Recipient");
});

// @test-value v2
// kind = "contract"
// claim = "送受信とも@は保存宛先Characterを示し、独立したSessionリンクは送信側で宛先Auxiliary、受信側で送信元Auxiliaryを正確に開く"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details; user: @キャラ名とSession名を分け、両セッションを揃える" }
// fault = "@に発言者や現在Characterを使う、From/Toと実際の移動先を取り違える、または省略されたSession名の全文を失う"
// observable = "@文字列、方向label、Session buttonのtitleとaccessible name、click時のopenSession引数"
// observation_boundary = "consumer"
// scope = "SessionOriginRouteの保存snapshotから送受信ヘッダーとSession移動への接続"
// lifecycle = "permanent"
// impact = "同Characterの複数Sessionで誰への指示か・どの会話かを取り違える"
// distinction = "storageや型検査では表示方向と移動先IDの接続を検証できない。小さな2方向fixtureで確認し、狭幅の省略描画は実画面で確認する"
// @end-test-value
test("session address separates the shared recipient mention from directional Session links", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) Object.defineProperty(globalThis, key, { value, configurable: true });
  const opened: string[][] = [];
  Object.defineProperty(dom.window, "withmate", { value: { openSession: async (...ids: string[]) => { opened.push(ids); } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const target = { kind: "auxiliary", mainSessionId: "recipient-main", mainIncarnationId: "main-inc", sessionId: "recipient-aux", incarnationId: "recipient-inc" } as const;
  try {
    for (const outbound of [true, false]) {
      await act(async () => root.render(<SessionOriginRoute origin={origin} target={outbound ? target : undefined} onError={assert.fail} />));
      assert.equal(dom.window.document.querySelector(".session-message-mention")?.textContent, "@Saved Target");
      const link = dom.window.document.querySelector("button")!;
      assert.equal(link.contains(dom.window.document.querySelector(".session-message-mention")), false);
      const title = outbound ? "Saved Target Title" : "Saved Sender Title";
      assert.equal(link.querySelector(".related-session-direction")?.textContent, outbound ? "To" : "From");
      assert.equal(link.title, title);
      assert.equal(link.getAttribute("aria-label"), `${outbound ? "Open Recipient" : "Open Sender"}: ${title}`);
      await act(async () => link.click());
    }
    assert.deepEqual(opened, [["recipient-main", "recipient-aux"], ["sender-main", "sender-aux"]]);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "送信表示は保存宛先と全文を最初から示し、本文を保持したまま正確な宛先とreceiptの配送状態を通知と再展開で更新する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "別宛先へ照会する、本文を切り詰める、状態更新で本文を置換する、または配送状態を初回値のまま固定する"
// observable = "@宛先とTo表示、初期表示と状態更新後の全文、状態読取requestのtarget・receipt、通知と再展開後の配送とTurn状態"
// observation_boundary = "consumer"
// scope = "SentDeliveryRowの保存全文表示と共通execution状態読取への接続"
// lifecycle = "permanent"
// impact = "送信した指示の全文が欠落するか、別の送信内容を表示する"
// distinction = "storage読取とhook testは全文のDOM表示と、独立した配送状態更新への接続を通らない"
// @end-test-value
test("sent messages show full content while refreshing exact delivery state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const statusRequests: Record<string, unknown>[] = [];
  let statusFail = false;
  let receiptState = "queued";
  let turnState = "running";
  let turnUpdated: ((id: string) => void) | undefined;
  let queueChanged: ((id: string) => void) | undefined;
  Object.defineProperty(dom.window, "withmate", { value: { openSession: async () => {}, readSessionExecution: async (_owner: string, operation: string, request: Record<string, unknown>) => {
    assert.equal(operation, "get_execution");
    statusRequests.push(request);
    if (statusFail) return { ok: false, message: "State Read Failed" };
    return { ok: true, receiptState, turnState, turnId: "53" };
  }, onSessionTurnUpdated: (listener: (id: string) => void) => { turnUpdated = listener; return () => { turnUpdated = undefined; }; },
  onSessionTurnQueueChanged: (listener: (id: string) => void) => { queueChanged = listener; return () => { queueChanged = undefined; }; } } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const click = async (label: string) => { const button = [...dom.window.document.querySelectorAll("button")].find((element) => element.textContent?.includes(label) || element.getAttribute("aria-label") === label)!; assert.ok(button); await act(async () => button.click()); };
  try {
    const card = sentInstructionFixtureItem(item);
    assert.ok("receiptId" in card);
    await act(async () => root.render(<SentDeliveryRow item={card} context={context} />));
    assert.equal(dom.window.document.querySelector(".rich-text")?.textContent, item.text);
    assert.match(dom.window.document.body.textContent!, /Saved Target.*Saved Target Title/);
    assert.equal(dom.window.document.querySelector(".session-message-mention")?.textContent, "@Saved Target");
    assert.equal(dom.window.document.querySelector(".related-session-direction")?.textContent, "To");
    await click("Show Delivery Details");
    const state = (label: string) => [...dom.window.document.querySelectorAll("dt")].find((term) => term.textContent === label)?.nextElementSibling?.textContent;
    assert.equal(state("Receipt State"), "Queued");
    assert.equal(state("Turn State"), "Running");
    assert.deepEqual(statusRequests[0], { target: item.target, receiptId: item.receiptId });
    receiptState = "completed";
    await act(async () => root.render(<SentDeliveryRow item={{ ...card, state: "completed" }} context={context} />));
    assert.equal(state("Receipt State"), "Completed");
    turnState = "completed";
    await act(async () => turnUpdated?.("target"));
    assert.equal(state("Turn State"), "Completed");
    assert.equal(dom.window.document.querySelector(".rich-text")?.textContent, item.text);
    const readCount = statusRequests.length;
    await act(async () => queueChanged?.("unrelated-target"));
    assert.equal(statusRequests.length, readCount);
    await click("Hide Delivery Details");
    statusFail = true;
    await click("Show Delivery Details");
    assert.equal(statusRequests.length, readCount + 1);
    assert.match(dom.window.document.body.textContent!, /State Read Failed/);
    assert.equal(dom.window.document.querySelector(".rich-text")?.textContent, item.text);
    statusFail = false; turnState = "failed";
    await click("Retry Delivery Details");
    assert.equal(state("Turn State"), "Failed");
    assert.equal(dom.window.document.querySelector(".rich-text")?.textContent, item.text);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "送信通知は問いで識別できる正確な相談入口を持ち、別送本文と問い未記録の旧本文を一度だけ初期表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 相談の識別表示・当時本文・旧データ" }
// fault = "別Session/相談を開く、問いの識別を失う、または別送本文/旧本文を隠す/Detailsと二重表示する"
// observable = "plain textの問いとaccessible name、移動先identityと相談ID、送信本文の表示数と閉じた詳細外での可読性"
// observation_boundary = "consumer"
// scope = "SentDeliveryRowから保存済みCoordination表示・既存詳細navigationへの接続"
// lifecycle = "permanent"
// impact = "利用者が相談を読めず、対応先を取り違える"
// distinction = "storage schemaや型検査では共通APIの投影が本文・詳細操作へ正しく接続されることを保証できない"
// @end-test-value
test("Coordination notifications identify exact consultations and preserve separately sent and legacy content", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of [["window", dom.window], ["document", dom.window.document], ["IS_REACT_ACT_ENVIRONMENT", true]] as const) Object.defineProperty(globalThis, key, { value, configurable: true });
  const opened: unknown[] = [];
  Object.defineProperty(dom.window, "withmate", { value: { openCoordination: async (request: unknown) => { opened.push(request); }, readSessionExecution: async () => ({ ok: true, receiptState: "completed", turnState: "completed" }) } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    const consultation = `${"Which approach should we use? ".repeat(20)}\n\nFinal **condition**: preserve [the source](https://example.com/source).`;
    await act(async () => root.render(<SentDeliveryRow item={sentInstructionFixtureItem({ ...item, text: '{"coordinationId":"consultation"}', coordination: { id: "consultation", text: consultation } })} context={context} />));
    const button = dom.window.document.querySelector(".coordination-notice-link") as HTMLButtonElement;
    assert.ok(button);
    assert.match(button.textContent!, /Final condition: preserve the source/);
    assert.match(button.getAttribute("aria-label")!, /Open Consultation:.*Final condition/);
    await act(async () => button.click());
    assert.deepEqual(opened, [{ ...item.target, id: "consultation" }]);
    await act(async () => (dom.window.document.querySelector('[aria-label="Show Delivery Details"]') as HTMLButtonElement).click());
    assert.equal(dom.window.document.querySelectorAll('[aria-label="Sent Content"]').length, 1);
    assert.match(dom.window.document.querySelector('[aria-label="Sent Content"] .rich-text')?.textContent ?? "", /Final condition/);
    assert.equal(dom.window.document.querySelector('[aria-label="Sent Content"]')?.closest('[aria-label="Delivery Details"]'), null);
    await act(async () => (dom.window.document.querySelector('[aria-label="Hide Delivery Details"]') as HTMLButtonElement).click());
    await act(async () => root.render(<SentDeliveryRow item={sentInstructionFixtureItem({ ...item, coordination: { id: "consultation", consultation, text: consultation } })} context={context} />));
    await act(async () => (dom.window.document.querySelector('[aria-label="Show Delivery Details"]') as HTMLButtonElement).click());
    assert.equal(dom.window.document.querySelectorAll('[aria-label="Sent Content"]').length, 0);
    await act(async () => root.render(<SentDeliveryRow item={sentInstructionFixtureItem({ ...item, coordination: { id: "consultation", consultation: "Which approach?", text: "The saved reply." } })} context={context} />));
    const reply = dom.window.document.querySelector('[aria-label="Sent Content"]')!;
    assert.equal(dom.window.document.querySelectorAll('[aria-label="Sent Content"]').length, 1);
    assert.equal(reply.querySelector(".rich-text")?.textContent, "The saved reply.");
    assert.equal(reply.closest('[aria-label="Delivery Details"]'), null);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
