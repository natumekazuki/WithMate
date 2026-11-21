import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useSentDeliveries, sentInstructionKey, type SentDelivery, type SentInstruction, type SentSteer } from "../../src/chat/conversation/use-sent-deliveries.js";
import type { TurnInputReadContext } from "../../src/chat/conversation/turn-input-details.js";
import type { Message } from "../../src-shared/session/session-state.js";

const context = (sessionId: string): TurnInputReadContext => ({ ownerSessionId: sessionId, target: { kind: "main", sessionId, incarnationId: `${sessionId}-inc` } });
const delivery = (sequence: number, state: SentDelivery["state"] = "queued"): SentDelivery => ({ receiptId: `receipt-${sequence}`, sequence, sourceTurnId: "47", sourceMessageSeq: 1, target: context("recipient").target, state, origin: { kind: "session", actorKind: "main", actorSessionId: "sender", actorIncarnationId: "sender-inc", actorTurnId: "47", operation: "send", targetSessionId: "recipient", targetIncarnationId: "recipient-inc" }, text: `instruction ${sequence}` });
type ReadRequest = { target: { sessionId: string }; messageSeqs: number[]; liveTurnIds: string[]; cursor?: number; limit: number };
type Page = { ok: true; items: SentInstruction[]; nextCursor: number | null };

async function harness(read: (request: ReadRequest, operation: string) => Promise<Page>, action: (h: { render: (owner: string, liveTurnId?: string | null, enabled?: boolean, messages?: Message[]) => Promise<void>; current: () => ReturnType<typeof useSentDeliveries>; notify: (id?: string) => void }) => Promise<void>) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  const listeners = new Set<(id: string) => void>();
  Object.defineProperty(dom.window, "withmate", { value: { readSessionExecution: async (_owner: string, operation: string, request: ReadRequest) => read(request, operation), onSessionSentDeliveriesChanged: (listener: (id: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } });
  let currentOwner = "";
  let current!: ReturnType<typeof useSentDeliveries>;
  function Probe({ owner, liveTurnId, enabled, messages }: { owner: string; liveTurnId?: string | null; enabled: boolean; messages: Message[] }) { current = useSentDeliveries(context(owner), messages, liveTurnId, enabled); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await action({ current: () => current, notify: (id = currentOwner) => { for (const listener of listeners) listener(id); }, render: async (owner, liveTurnId, enabled = true, messages = [{ role: "assistant", text: "answer", historyIndex: 1 }]) => { currentOwner = owner; await act(async () => root.render(<Probe owner={owner} liveTurnId={liveTurnId} enabled={enabled} messages={messages} />)); } });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

// @test-value v2
// kind = "contract"
// claim = "送信一覧は表示範囲の全送信を自動取得し、送信元通知後も更新状態を反映して削除済みreceiptを残さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "先頭20件だけを表示する、古いpageを残す、または通知後の配送状態を表示しない"
// observable = "hook consumerのreceipt列と状態、共通読取requestのcursor列とlimit"
// observation_boundary = "consumer"
// scope = "送信一覧hookの自動page読取と通知後refresh。storageは決定的page応答で代替"
// lifecycle = "permanent"
// impact = "読み返し中の送信が消えたり、削除済み・古い配送状態を利用者が誤認することを防ぐ"
// distinction = "storage paging testと型検査ではrendererの通知と追加閲覧状態の結合を検証できない"
// @end-test-value
test("sent deliveries load all bounded pages and refresh automatically", async () => {
  let values = Array.from({ length: 50 }, (_, index) => delivery(index + 1));
  const requests: ReadRequest[] = [];
  await harness(async (request, operation) => {
    if (operation === "list_sent_steers") return { ok: true, items: [], nextCursor: null };
    requests.push(request);
    const items = values.filter((item) => item.sequence > (request.cursor ?? 0)).slice(0, request.limit);
    return { ok: true, items, nextCursor: values.some((item) => item.sequence > items.at(-1)!.sequence) ? items.at(-1)!.sequence : null };
  }, async (h) => {
    await h.render("sender");
    assert.equal(h.current().items.length, 50);
    values = values.filter((item) => item.sequence < 3 || item.sequence > 7).map((item) => ({ ...item, state: "completed" }));
    await act(async () => h.notify());
    assert.equal(h.current().items.length, 45);
    assert.deepEqual(h.current().items.map((item) => item.sequence), values.map((item) => item.sequence));
    assert.ok(h.current().items.every((item) => item.state === "completed"));
    assert.deepEqual(requests.map((request) => [request.cursor ?? 0, request.limit]), [[0, 20], [20, 20], [40, 20], [0, 20], [25, 20], [45, 20]]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "送信記録は後続pageの完了を待たずに表示し、取得失敗では既読分とエラーを保って再試行できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "最終pageまで本文を隠す、失敗を空の成功にする、または再試行で続きを取得できない"
// observable = "後続page待機・失敗・再試行後の送信件数とエラー"
// observation_boundary = "consumer"
// scope = "表示範囲の自動page取得と失敗・再試行、APIを制御したhook consumer"
// lifecycle = "permanent"
// impact = "利用者が送信内容の欠落や取得失敗に気付けず、内容を確認できなくなる"
// distinction = "storageのpaging testは画面側の段階表示と失敗時の回復を観測しない"
// @end-test-value
test("sent deliveries appear before later pages and recover from a read failure", async () => {
  let fail = true;
  let rejectSecond!: (error: Error) => void;
  await harness(async (request, operation) => {
    if (operation === "list_sent_steers") return { ok: true, items: [], nextCursor: null };
    if (request.cursor === undefined) return { ok: true, items: Array.from({ length: 20 }, (_, index) => delivery(index + 1)), nextCursor: 20 };
    if (fail) return new Promise((_, reject) => { rejectSecond = reject; });
    return { ok: true, items: [delivery(21)], nextCursor: null };
  }, async (h) => {
    await h.render("sender");
    assert.equal(h.current().items.length, 20);
    await act(async () => rejectSecond(new Error("page unavailable")));
    assert.equal(h.current().items.length, 20);
    assert.match(h.current().error, /page unavailable/);
    fail = false;
    await act(async () => h.current().retry());
    assert.equal(h.current().items.length, 21);
    assert.equal(h.current().error, "");
  });
});

// @test-value v2
// kind = "contract"
// claim = "receiptのない実行も明示WithMate Turnで送信を取得し、owner切替と非表示後の古い応答を新しい会話へ反映しない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/837" }
// fault = "live Turnをreceiptからしか取得しない、Provider IDで代用する、または切替前の遅延応答を現ownerへ適用する"
// observable = "共通読取へ渡るliveTurnIds/messageSeqsとowner切替・非表示後のhook receipt列"
// observation_boundary = "consumer"
// scope = "送信一覧hookの明示WithMate Turnと非同期応答寿命"
// lifecycle = "permanent"
// impact = "進行中送信の欠落と別Sessionの送信内容の誤表示を防ぐ"
// distinction = "storageの正確なowner照合だけではrendererが旧応答を別表示へ採用しないことを検証できない"
// @end-test-value
test("sent delivery reads accept an explicit WithMate live Turn and discard obsolete responses", async () => {
  const requests: ReadRequest[] = [];
  let resolveOld!: (value: Page) => void;
  let resolveHidden!: (value: Page) => void;
  let waitForHidden = false;
  await harness(async (request, operation) => {
    if (operation === "list_sent_steers") return { ok: true, items: [], nextCursor: null };
    requests.push(request);
    if (request.target.sessionId === "old") return new Promise((resolve) => { resolveOld = resolve; });
    if (waitForHidden) return new Promise((resolve) => { resolveHidden = resolve; });
    return { ok: true, items: [delivery(2)], nextCursor: null };
  }, async (h) => {
    await h.render("old", "47", true, []);
    await h.render("current", "48", true, []);
    assert.deepEqual(requests.map((request) => [request.target.sessionId, request.messageSeqs, request.liveTurnIds]), [["old", [], ["47"]], ["current", [], ["48"]]]);
    await act(async () => resolveOld({ ok: true, items: [delivery(1)], nextCursor: null }));
    assert.deepEqual(h.current().items.map(sentInstructionKey), ["receipt-2"]);
    waitForHidden = true;
    await act(async () => h.current().retry());
    await h.render("current", "48", false, []);
    await act(async () => resolveHidden({ ok: true, items: [delivery(3)], nextCursor: null }));
    assert.deepEqual(h.current().items.map(sentInstructionKey), ["receipt-2"]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "同じ送信元Turnのreceiptと直接Steerを別keyで保持し、送信元通知で直接入力の4状態と全pageを更新する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/966; docs/design/desktop-ui.md#turn-input-details" }
// fault = "receiptとmessageの数値sequence衝突で入力を落とす、直接Steerだけが通知を受けない、または追加pageをrefreshで失う"
// observable = "hook consumerの安定key・本文・stateとrequestのoperation/cursor、別送信元通知後のrequest件数"
// observation_boundary = "consumer"
// scope = "送信元hookの2 evidence sourceの独立keysetとsource限定invalidation。IPCは決定的page fixture"
// lifecycle = "permanent"
// impact = "同じTurnの複数指示が欠落する、または未確定入力が古い状態のままになる"
// distinction = "storage testではrendererの2一覧合成と自動pageの再取得、通知filterを確認できない"
// @end-test-value
test("receipts and direct Steers retain separate keys, paging and source invalidation", async () => {
  const states = ["pending", "confirmed", "unknown", "not-sent"] as const;
  let values: SentSteer[] = Array.from({ length: 25 }, (_, index) => ({ sequence: index + 1, sourceTurnId: "47", sourceMessageSeq: 1,
    target: context("recipient").target, messageSeq: index + 5, text: `correction ${index}`, state: states[index % 4],
    origin: { kind: "session", operation: "steer", actorKind: "main", actorSessionId: "sender", actorIncarnationId: "sender-inc", actorTurnId: "47", targetSessionId: "recipient", targetIncarnationId: "recipient-inc" } }));
  const requests: string[] = [];
  await harness(async (request, operation) => {
    requests.push(operation);
    if (operation === "list_sent_deliveries") return { ok: true, items: [delivery(1)], nextCursor: null };
    const items = values.filter((item) => item.sequence > (request.cursor ?? 0)).slice(0, 20);
    return { ok: true, items, nextCursor: items.at(-1)?.sequence !== values.at(-1)?.sequence ? items.at(-1)!.sequence : null };
  }, async (h) => {
    await h.render("sender");
    assert.equal(h.current().items.length, 26);
    assert.equal(new Set(h.current().items.map(sentInstructionKey)).size, 26);
    assert.deepEqual(h.current().items.slice(1, 5).map((item) => item.state), states);
    assert.equal(h.current().items.length, 26);
    const count = requests.length;
    await act(async () => h.notify("another-source"));
    assert.equal(requests.length, count);
    values = values.map((item) => ({ ...item, state: "confirmed" }));
    await act(async () => h.notify());
    assert.equal(h.current().items.length, 26);
    assert.ok(h.current().items.slice(1).every((item) => item.state === "confirmed"));
  });
});
