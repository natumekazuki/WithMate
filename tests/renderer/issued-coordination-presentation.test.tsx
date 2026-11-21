import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionMessageColumn, type SessionMessageColumnProps } from "../../src/chat/conversation/session-message-column.js";
import { useIssuedCoordinations, type IssuedCoordination } from "../../src/chat/conversation/use-issued-coordinations.js";
import { buildMessageCollapseTargets } from "../../src/chat/conversation/session-message-collapse.js";
import type { SentDelivery } from "../../src/chat/conversation/use-sent-deliveries.js";

const target = { kind: "main" as const, sessionId: "source", incarnationId: "source-inc" };
const context = { ownerSessionId: "source", target };
function domHarness(api: object) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientHeight: { get: () => 720 }, clientWidth: { get: () => 900 }, offsetHeight: { get: () => 160 }, offsetWidth: { get: () => 900 } });
  dom.window.HTMLElement.prototype.scrollTo = function (options) { if (typeof options === "object") this.scrollTop = options.top ?? 0; };
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const before = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "window" ? dom.window : Reflect.get(dom.window, key) });
  Object.defineProperty(dom.window, "withmate", { value: api });
  const root = createRoot(dom.window.document.getElementById("root")!);
  return { root, document: dom.window.document, close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const key of keys) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}
function props(): SessionMessageColumnProps {
  const noop = () => {};
  return { sessionId: "source", inputReadContext: context, character: { id: "c", name: "Character", iconPath: "", description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "", themeColors: { main: "#445566", sub: "#667788" } },
    messages: [{ role: "assistant", text: "Source response", historyIndex: 1 }, { role: "user", text: "saved notification", historyIndex: 2 }],
    messageKeys: ["response", "received"], expandedArtifacts: {}, messageListRef: createRef(), isRunning: false,
    liveApprovalRequest: null, approvalActionRequestId: null, liveElicitationRequest: null, elicitationActionRequestId: null,
    liveRunAssistantText: "", hasLiveRunAssistantText: false, liveRunErrorMessage: "", isMessageListFollowing: true,
    onMessageListScroll: noop, onToggleArtifact: noop, onOpenDiff: noop, onResolveLiveApproval: noop, onResolveLiveElicitation: noop };
}

// @test-value v2
// kind = "contract"
// claim = "チャットは起票元応答に相談入口をまとめ、receiptで重複させず、当時の別送受信本文を読み、正確な詳細導線・collapseを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 相談入口・当時本文・起票表示; docs/design/ui-design-guidelines.md#読込空失敗" }
// fault = "未取得を正常0件に見せる、別rowへ起票を置く、receipt取得で重複させる、受信本文を閉じた詳細へ隠す/現在回答で置換する、またはcollapse後も本文を表示する"
// observable = "実chat columnの読込status、起票rowとリンク数、初期表示の当時本文、openCoordination引数、失敗表示とcollapse preview"
// observation_boundary = "consumer"
// scope = "起票/送信/受信readから本番SessionMessageColumnへの接続。IPCはfixture"
// lifecycle = "permanent"
// impact = "ユーザーが相談の対象Turn・対応先・送信済み内容を取り違える"
// distinction = "SQLiteと個別row testでは起票receipt統合・本文開閉・非同期readの表示接続を検査できない"
// @end-test-value
test("issued chat notices align with their source response and preserve exact received content", async () => {
  let sent: SentDelivery[] = [];
  let live = false, fail = false;
  const opened: unknown[] = [];
  let completeIssuedRead!: () => void;
  const initialIssuedRead = new Promise<void>((resolve) => { completeIssuedRead = resolve; });
  const coordinationChanged = new Set<() => void>();
  const sentChanged = new Set<(sessionId: string) => void>();
  const h = domHarness({ subscribeCoordinationChanged: (listener: () => void) => { coordinationChanged.add(listener); return () => { coordinationChanged.delete(listener); }; },
    onSessionSentDeliveriesChanged: (listener: (sessionId: string) => void) => { sentChanged.add(listener); return () => { sentChanged.delete(listener); }; },
    openCoordination: async (request: unknown) => { if (fail) throw new Error("Could not open saved Coordination."); opened.push(request); },
    readSessionExecution: async (_owner: string, operation: string) => {
      if (operation === "list_issued_coordinations") {
        await initialIssuedRead;
        return { ok: true, items: [{ id: "issued", sourceTurnId: "42", sourceMessageSeq: live ? null : 1, consultation: "Which approach?" }], nextCursor: null };
      }
      if (operation === "list_sent_deliveries") return { ok: true, items: sent, nextCursor: null };
      if (operation === "list_sent_steers") return { ok: true, items: [], nextCursor: null };
      return { ok: true, coordination: { id: "received", consultation: "Original question", text: "Then-delivered answer" }, origin: null, receiptId: "received-receipt" };
    } });
  try {
    const column = props();
    await act(async () => h.root.render(<SessionMessageColumn {...column} />));
    assert.equal(h.document.querySelector('[role="status"][aria-label="Loading Coordination"]')?.getAttribute("aria-busy"), "true");
    await act(async () => completeIssuedRead());
    assert.equal(h.document.querySelector('[aria-label="Loading Coordination"]'), null);
    const issued = h.document.querySelector('.issued-coordination-notice[data-source-turn-id="42"]')!;
    assert.ok(issued.closest(".session-message-virtual-row")!.textContent!.includes("Source response"));
    assert.ok(issued.closest(".message-card")?.textContent?.includes("Source response"));
    const link = issued.querySelector<HTMLButtonElement>("button")!;
    fail = true; await act(async () => link.click());
    assert.ok(issued.querySelector('[aria-label="Could Not Open Consultation"]'));
    fail = false; await act(async () => link.click());
    assert.deepEqual(opened.at(-1), { id: "issued", ...target });
    const received = h.document.querySelector(".received-coordination-content")!;
    assert.equal(received.closest("details:not([open])"), null);
    assert.equal(received.querySelector(".rich-text")?.textContent, "Then-delivered answer");
    const collapse = buildMessageCollapseTargets(column.messages, column.messages.map((_, messageIndex) => ({ kind: "session", messageIndex })), column.messageKeys!);
    await act(async () => h.root.render(<SessionMessageColumn {...column} messageCollapseTargets={collapse} collapsedMessageKeys={new Set(["received"])} onToggleMessageCollapse={() => {}} />));
    assert.equal(h.document.querySelector(".message-collapsed-preview")?.textContent, "Original question");
    assert.equal(h.document.querySelector('[aria-label="Expand message: Original question"]')?.getAttribute("aria-expanded"), "false");
    await act(async () => h.root.render(<SessionMessageColumn {...column} messageCollapseTargets={collapse} collapsedMessageKeys={new Set(["response"])} onToggleMessageCollapse={() => {}} />));
    assert.equal(h.document.querySelector(".issued-coordination-notice"), null);
    assert.equal(h.document.querySelector(".message-collapsed-preview")?.textContent, "Source response");
    await act(async () => h.root.render(<SessionMessageColumn {...column} />));
    const recipient = { kind: "main" as const, sessionId: "recipient", incarnationId: "recipient-inc" };
    sent = [{ receiptId: "sent-receipt", sourceTurnId: "42", sourceMessageSeq: 1, sequence: 1, target: recipient, state: "queued", text: "Which approach?", coordination: { id: "issued", text: "Which approach?", consultation: "Which approach?" }, origin: { kind: "session", operation: "send", targetSessionId: recipient.sessionId, targetIncarnationId: recipient.incarnationId } }];
    await act(async () => {
      coordinationChanged.forEach((listener) => listener());
      sentChanged.forEach((listener) => listener(target.sessionId));
    });
    assert.equal(h.document.querySelectorAll(".session-outbound .coordination-notice-link").length, 1);
    assert.equal(h.document.querySelector(".issued-coordination-notice"), null);
    sent = []; live = true;
    await act(async () => h.root.render(<SessionMessageColumn {...column} messages={[{ role: "assistant", text: "Live response" }]} liveWithMateTurnId="42" isRunning />));
    assert.equal(h.document.querySelectorAll('.issued-coordination-notice[data-source-turn-id="42"]').length, 1);
  } finally { await h.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "起票の追加閲覧後も更新通知で閲覧範囲を再取得し、削除を反映し、旧owner応答を新会話へ適用しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 起票と消去済み; docs/design/ui-design-guidelines.md#読込空失敗" }
// fault = "更新で先頭20件へ戻る、古いrecordをcacheから復元する、または旧ownerの遅延応答を適用する"
// observable = "hook consumerのID列・error、owner/cursor付きread呼出と遅延応答後の表示"
// observation_boundary = "consumer"
// scope = "useIssuedCoordinationsのページング・通知refresh・owner lifetime。read APIはfixture"
// lifecycle = "permanent"
// impact = "閲覧中の相談が消えるか、削除済みや別会話の相談を誤認する"
// distinction = "DB pagingと型検査ではrendererの閲覧範囲と応答寿命を検証できない"
// @end-test-value
test("issued notices refresh the viewed prefix and reject obsolete owner responses", async () => {
  let records: IssuedCoordination[] = Array.from({ length: 45 }, (_, index) => ({ id: String(index).padStart(3, "0"), sourceTurnId: "42", sourceMessageSeq: 1, consultation: `Question ${index}` }));
  let notify = () => {};
  let resolveOld!: (result: unknown) => void;
  let state!: ReturnType<typeof useIssuedCoordinations>;
  const h = domHarness({ subscribeCoordinationChanged: (listener: () => void) => { notify = listener; return () => {}; },
    readSessionExecution: async (_owner: string, _operation: string, request: { target: { sessionId: string }; cursor?: string }) => {
      if (request.target.sessionId === "old") return new Promise((resolve) => { resolveOld = resolve; });
      const items = records.filter((record) => record.id > (request.cursor ?? "")).slice(0, 20);
      return { ok: true, items, nextCursor: records.some((record) => record.id > items.at(-1)!.id) ? items.at(-1)!.id : null };
    } });
  function Probe({ owner }: { owner: string }) { state = useIssuedCoordinations({ ownerSessionId: owner, target: { ...target, sessionId: owner } }, [{ role: "assistant", text: "", historyIndex: 1 }], undefined, true); return null; }
  try {
    await act(async () => h.root.render(<Probe owner="source" />));
    await act(async () => state.loadMore());
    assert.equal(state.items.length, 40);
    records = records.filter((record) => record.id !== "002");
    await act(async () => notify());
    assert.deepEqual(state.items.map((record) => record.id), records.slice(0, 40).map((record) => record.id));
    await act(async () => h.root.render(<Probe owner="old" />));
    await act(async () => h.root.render(<Probe owner="source" />));
    await act(async () => resolveOld({ ok: true, items: [{ id: "old", sourceTurnId: "42", sourceMessageSeq: 1, consultation: "Old owner" }], nextCursor: null }));
    assert.deepEqual(state.items.map((record) => record.id), records.slice(0, 40).map((record) => record.id));
  } finally { await h.close(); }
});
