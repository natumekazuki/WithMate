import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { SessionMessageColumn, type SessionMessageColumnProps } from "../../src/chat/conversation/session-message-column.js";
import { useIssuedCoordinations, type IssuedCoordination } from "../../src/chat/conversation/use-issued-coordinations.js";
import { buildMessageCollapseTargets } from "../../src/chat/conversation/session-message-collapse.js";
import type { SentDelivery } from "../../src/chat/conversation/use-sent-deliveries.js";
import type { CoordinationInvalidation } from "../../src-shared/coordination/coordination-window-contract.js";
import { sentInstructionReaderFixture } from "./sent-instruction-reader-fixture.js";

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
// claim = "チャットは起票元応答に相談入口をまとめ、receipt本文が未取得でも重複させず、当時の別送受信本文を読み、正確な詳細導線・collapseを保持する"
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
  let completeSentRead!: () => void;
  const sentBodyRead = new Promise<void>((resolve) => { completeSentRead = resolve; });
  const coordinationChanged = new Set<(summary: CoordinationInvalidation) => void>();
  const sentChanged = new Set<(sessionId: string) => void>();
  const h = domHarness({ subscribeCoordinationChanged: (listener: (summary: CoordinationInvalidation) => void) => { coordinationChanged.add(listener); return () => { coordinationChanged.delete(listener); }; },
    onSessionSentDeliveriesChanged: (listener: (sessionId: string) => void) => { sentChanged.add(listener); return () => { sentChanged.delete(listener); }; },
    openCoordination: async (request: unknown) => { if (fail) throw new Error("Could not open saved Coordination."); opened.push(request); },
    readSessionExecution: async (_owner: string, operation: string, request: unknown) => {
      if (operation === "list_issued_coordinations") {
        await initialIssuedRead;
        return { ok: true, items: [{ id: "issued", sourceTurnId: "42", sourceMessageSeq: live ? null : 1, consultation: "Which approach?" }], nextCursor: null };
      }
      const sentRead = sentInstructionReaderFixture(sent, operation, request);
      if (sentRead) {
        if (operation === "read_sent_instruction_bodies") await sentBodyRead;
        return sentRead;
      }
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
    sent = [{ receiptId: "sent-receipt", sourceTurnId: "42", sourceMessageSeq: 1, sequence: 1, target: recipient, state: "queued", text: "Then-sent instruction", coordination: { id: "issued", text: "Then-sent instruction", consultation: "Which approach?" }, origin: { kind: "session", operation: "send", targetSessionId: recipient.sessionId, targetIncarnationId: recipient.incarnationId } }];
    await act(async () => {
      coordinationChanged.forEach((listener) => listener({ id: "issued", crewRootSessionId: "source", initiator: target }));
      sentChanged.forEach((listener) => listener(target.sessionId));
    });
    assert.ok(h.document.querySelector('[data-sent-instruction-key="sent-receipt"]'));
    assert.equal(h.document.querySelector(".issued-coordination-notice"), null);
    await act(async () => completeSentRead());
    assert.equal(h.document.querySelectorAll(".session-outbound .coordination-notice-link").length, 1);
    assert.equal(h.document.querySelector('.session-outbound [aria-label="Sent Content"] .rich-text')?.textContent, "Then-sent instruction");
    sent = []; live = true;
    await act(async () => h.root.render(<SessionMessageColumn {...column} messages={[{ role: "assistant", text: "Live response" }]} liveWithMateTurnId="42" isRunning />));
    assert.equal(h.document.querySelectorAll('.issued-coordination-notice[data-source-turn-id="42"]').length, 1);
  } finally { await h.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "表示済みの起票入口はlive終了と正本取得の間も同じ応答に一度だけ残り、別Turnへ移らない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: receiptなし起票の実行中/保存の配置; docs/design/session-run-lifecycle.md#入力から読み返しまでの所有境界" }
// fault = "目録のscope変更・空の中間snapshot・追加ページが残った時点で起票入口を落とすか、次のlive応答へ付け替える"
// observable = "対話列の同一応答内にある起票buttonの件数・DOM・focus、保存済み本文、後続ページ取得後に更新される起票本文、openCoordinationの既存IDとtarget"
// observation_boundary = "consumer"
// scope = "receiptなし起票のliveから保存への表示継続。read APIは固定入力"
// lifecycle = "permanent"
// impact = "表示済みの相談が再表示まで操作不能になったり、次Turnの相談と見間違えたりする"
// distinction = "通常の一時点の起票表示や受信本文と異なり、live・保存seq・目録更新の独立した到着を検証する"
// @end-test-value
test("an issued notice stays actionable in the same response until its saved scope is read", async () => {
  const opened: unknown[] = [];
  const notice = { id: "issued", sourceTurnId: "42", consultation: "Which approach?" };
  let completeSavedRead!: () => void;
  const savedRead = new Promise<void>((resolve) => { completeSavedRead = resolve; });
  const h = domHarness({
    openCoordination: async (request: unknown) => { opened.push(request); },
    readSessionExecution: async (_owner: string, operation: string, req: { liveTurnIds: string[]; messageSeqs: number[]; cursor?: string }) => {
      if (operation === "list_issued_coordinations") {
        if (req.messageSeqs.includes(1)) {
          await savedRead;
          if (req.cursor) return { ok: true, items: [{ ...notice, consultation: "Which approach after refresh?", sourceMessageSeq: 1 }], nextCursor: null };
          const items = Array.from({ length: 20 }, (_, index) => ({ id: `before-${String(index).padStart(2, "0")}`,
            consultation: `Consultation in B ${index}`, sourceTurnId: "43", sourceMessageSeq: null }));
          return { ok: true, items, nextCursor: items.at(-1)!.id };
        }
        return { ok: true, items: req.liveTurnIds.includes("42") ? [{ ...notice, sourceMessageSeq: null }] : [], nextCursor: null };
      }
      return operation === "list_sent_instruction_cards" ? { ok: true, items: [], cursors: { receipts: null, steers: null } }
        : { ok: false, message: "No other detail" };
    },
  });
  const again = (saved: boolean, next: boolean) => <SessionMessageColumn {...props()}
    messages={[{ role: "assistant", text: saved ? "Saved A" : "Partial A", ...(saved ? { historyIndex: 1 } : {}) },
      ...(next ? [{ role: "assistant" as const, text: "Live B" }] : [])]}
    messageKeys={next ? ["response", "other"] : ["response"]} isRunning liveWithMateTurnId={next ? "43" : "42"}
    savedReplySourceIndexes={next ? [saved ? 1 : undefined, undefined] : [undefined]}
    responseExecutionTurnIds={next ? ["42", "43"] : ["42"]} />;
  const locate = () => Array.from(h.document.querySelectorAll<HTMLButtonElement>('.issued-coordination-notice[data-source-turn-id="42"] button[aria-label^="Open Consultation"]'));
  try {
    await act(async () => h.root.render(again(false, false)));
    const [link] = locate();
    assert.ok(link);
    link.focus();
    await act(async () => h.root.render(again(false, true)));
    assert.deepEqual(locate(), [link], "a sweep restricted to the next Turn must not remove A's known notice");
    assert.ok(link.closest(".message-card")?.textContent?.includes("Partial A"));
    assert.equal(h.document.activeElement, link);
    await act(async () => h.root.render(again(true, true)));
    assert.deepEqual(locate(), [link], "the saved answer is visible while its Coordination read is still pending");
    assert.ok(link.closest(".message-card")?.textContent?.includes("Saved A"));
    assert.equal(h.document.activeElement, link);
    await act(async () => completeSavedRead());
    assert.deepEqual(locate(), [link], "the first saved page only covers B and must not evict A's already-visible notice");
    assert.equal(h.document.activeElement, link);
    assert.equal(link.getAttribute("aria-label"), "Open Consultation: Which approach?");
    const loadMore = Array.from(h.document.querySelectorAll("button")).find((button) => button.textContent === "Load More Coordination");
    assert.ok(loadMore);
    await act(async () => loadMore.click());
    assert.deepEqual(locate(), [link]);
    assert.equal(link.getAttribute("aria-label"), "Open Consultation: Which approach after refresh?");
    await act(async () => link.click());
    assert.deepEqual(opened, [{ id: "issued", ...target }]);
  } finally { await h.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "同一起票者の通知だけを直列に集約し、閲覧範囲、取得失敗時の内容と再試行、消去、旧owner応答の排除を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details: 起票と消去済み; docs/design/ui-design-guidelines.md#読込空失敗" }
// fault = "別起票者で再取得する、取得中の通知ごとに要求を増やすか最後の変更を捨てる、失敗で内容を消す、または旧ownerの遅延応答を適用する"
// observable = "owner/cursor付きread回数、hook consumerのID/本文・error、非表示時の購読数と遅延応答後の表示"
// observation_boundary = "consumer"
// scope = "useIssuedCoordinationsのページング・通知refresh・owner lifetime。read APIはfixture"
// lifecycle = "permanent"
// impact = "閲覧中の相談が消えるか、削除済みや別会話の相談を誤認する"
// distinction = "DB pagingと型検査ではrendererの閲覧範囲と応答寿命を検証できない"
// @end-test-value
test("issued notices coalesce matching changes across pagination and recover without obsolete responses", async (t) => {
  let records: IssuedCoordination[] = Array.from({ length: 45 }, (_, index) => ({ id: String(index).padStart(3, "0"), sourceTurnId: "42", sourceMessageSeq: 1, consultation: `Question ${index} ${"q".repeat(31980)}` }));
  const listeners = new Set<(summary: CoordinationInvalidation) => void>();
  const notify = (initiator: CoordinationInvalidation["initiator"] = target, crewRootSessionId = "source") => act(async () => {
    listeners.forEach((listener) => listener({ id: "002", crewRootSessionId, initiator }));
  });
  const calls: { owner: string; cursor?: string }[] = [];
  let hold = false, fail = false;
  let completeRead!: () => void;
  let resolveOld!: (result: unknown) => void;
  let state!: ReturnType<typeof useIssuedCoordinations>;
  const h = domHarness({ subscribeCoordinationChanged: (listener: (summary: CoordinationInvalidation) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readSessionExecution: async (owner: string, _operation: string, request: { target: { sessionId: string }; cursor?: string }) => {
      calls.push({ owner, cursor: request.cursor });
      if (request.target.sessionId === "old") return new Promise((resolve) => { resolveOld = resolve; });
      const items = records.filter((record) => record.id > (request.cursor ?? "")).slice(0, 20);
      const nextCursor = records.some((record) => record.id > items.at(-1)!.id) ? items.at(-1)!.id : null;
      if (hold) { hold = false; await new Promise<void>((resolve) => { completeRead = resolve; }); }
      if (fail) throw new Error("Read failed");
      return { ok: true, items, nextCursor };
    } });
  function Probe({ owner, enabled = true }: { owner: string; enabled?: boolean }) { state = useIssuedCoordinations({ ownerSessionId: owner, target: { ...target, sessionId: owner } }, [{ role: "assistant", text: "", historyIndex: 1 }], undefined, enabled); return null; }
  try {
    hold = true;
    await act(async () => h.root.render(<Probe owner="source" />));
    for (let index = 0; index < 10; index++) await notify({ ...target, sessionId: "other" }, "other-crew");
    await notify({ ...target, incarnationId: "replaced" });
    await notify({ ...target, kind: "auxiliary" });
    assert.equal(calls.length, 1);
    await act(async () => completeRead());
    assert.equal(calls.length, 1, "unrelated notifications must not queue a catch-up read");
    hold = true;
    await notify();
    for (let index = 0; index < 10; index++) await notify();
    assert.equal(calls.length, 2);
    records = [{ ...records[0], consultation: "Changed while reading" }, ...records.slice(1)];
    await act(async () => completeRead());
    assert.equal(calls.length, 3);
    assert.equal(state.items[0]?.consultation, "Changed while reading");
    t.diagnostic("initial read + unrelated notifications = 1 read; one related refresh + 10 related notifications while pending = 2 further reads");
    hold = true;
    await act(async () => state.loadMore());
    records = [...records.filter((record) => record.id !== "002"), { ...records[0], id: "000a", consultation: "New consultation" }].sort((a, b) => a.id < b.id ? -1 : 1);
    await notify();
    assert.equal(calls.length, 4);
    await act(async () => completeRead());
    assert.deepEqual(calls.slice(3).map(({ cursor }) => cursor), ["019", undefined, "019"]);
    assert.deepEqual(state.items.map((record) => record.id), records.slice(0, 40).map((record) => record.id));
    const previous = state.items;
    records = records.slice(1);
    fail = true;
    await notify();
    assert.equal(state.error, "Read failed");
    assert.deepEqual(state.items, previous);
    fail = false;
    await act(async () => state.retry());
    assert.equal(state.error, "");
    assert.deepEqual(state.items, records.slice(0, 40));
    await act(async () => h.root.render(<Probe owner="source" enabled={false} />));
    assert.equal(listeners.size, 0);
    const hiddenCount = calls.length;
    await notify();
    assert.equal(calls.length, hiddenCount);
    await act(async () => h.root.render(<Probe owner="old" />));
    await act(async () => h.root.render(<Probe owner="source" />));
    await act(async () => resolveOld({ ok: true, items: [{ id: "old", sourceTurnId: "42", sourceMessageSeq: 1, consultation: "Old owner" }], nextCursor: null }));
    assert.deepEqual(state.items.map((record) => record.id), records.slice(0, 40).map((record) => record.id));
  } finally { await h.close(); }
});
