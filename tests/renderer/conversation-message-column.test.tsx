import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, type UIEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SentDelivery as SentCardFixture } from "../../src/chat/conversation/use-sent-deliveries.js";
import { sentInstructionReaderFixture } from "./sent-instruction-reader-fixture.js";

import {
  useConversationMessageColumn,
  type ConversationColumnCache,
  type ConversationColumnControls,
  type ConversationMessageColumnApi,
} from "../../src/chat/conversation-message-column.js";
import type { SessionMessageColumnProps } from "../../src/chat/conversation/session-message-column.js";
import { SessionMessageColumn } from "../../src/chat/conversation/session-message-column.js";
import { ALL_MAIN_THREADS_ID, useMainConversationThreads } from "../../src/chat/conversation/use-main-conversation-threads.js";
import { SessionTurnQueueRow } from "../../src/chat/conversation/session-turn-queue-row.js";
import type { SentDelivery } from "../../src/chat/conversation/use-sent-deliveries.js";
import { QueuedTurnEditContext } from "../../src/chat/conversation/use-queued-turn-edit.js";
import { conversationPeerKey } from "../../src-shared/session/conversation-threads.js";
import type { LiveElicitationResponse, LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { CONVERSATION_PAGE_SIZE, type ConversationPage, type ConversationPageRequest } from "../../src-shared/session/conversation-page.js";
import type { SessionTurnQueueCapturedInput, SessionTurnQueueReceipt, SessionTurnQueueStore } from "../../src-shared/session/session-turn-queue.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { MainSessionTurnQueueFacade } from "../../src-electron/app/main-session-turn-queue-facade.js";
import { SessionTurnQueueService } from "../../src-electron/session/session-turn-queue-service.js";
import type { MarkdownImageApi } from "../../src/ui/markdown/image-resource-loader.js";
import type { SessionFilePreviewImageActionRequest, SessionImageResourceRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";
import { SessionTurnSubmissions } from "../../src/chat/runtime/session-turn-submissions.js";
import { subscribeSessionRunControls } from "../../src/chat/runtime/session-window-live-ingress.js";
import type { HtmlPreviewEvent, HtmlPreviewMountRequest } from "../../src-shared/window/html-preview.js";

function peerColumnFixture() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetHeight: { get: () => 600 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 600 }, clientWidth: { get: () => 800 },
  });
  const intersection = installIntersectionObserver();
  const document = dom.window.document;
  const root = createRoot(document.getElementById("root")!);
  const main = { kind: "main" as const, sessionId: "main", incarnationId: "main-inc" };
  const peers = ["A", "B", "C"].map((name) => ({ target: { kind: "main" as const, sessionId: name, incarnationId: name + "-inc" },
    title: name, messageIndexes: [] as number[], sentMessageIndexes: [] as number[], inboundTurnIds: [] as string[] }));
  const submissions = new SessionTurnSubmissions();
  const replies: unknown[] = [];
  const state = { live: null as LiveSessionRunState | null, saved: [] as SessionMessageColumnProps["messages"], receipts: [] as SessionTurnQueueReceipt[],
    sent: [] as SentDelivery[], holdSeq: undefined as number | undefined };
  const onQueue = new Set<(id: string) => void>();
  const onTurn = new Set<(id: string) => void>();
  const heldPages: (() => void)[] = [];
  const api: ConversationMessageColumnApi = {
    listSessionTurnQueue: async () => state.receipts.filter((receipt) => receipt.state !== "completed"),
    getSessionTurnQueueReceipt: async (_id, requestId) => state.receipts.find((receipt) => receipt.requestId === requestId) ?? null,
    onSessionTurnQueueChanged: (listener) => { onQueue.add(listener); return () => { onQueue.delete(listener); }; },
    async getConversationPage(id, request) {
      const messageIndexes = request?.messageIndexes;
      const messages = messageIndexes ? state.saved.filter((message) => messageIndexes.includes(message.historyIndex!)) : state.saved;
      const page = { sessionId: id, incarnationId: main.incarnationId, totalCount: state.saved.length, startIndex: messages[0]?.historyIndex ?? 0, messages };
      if (state.holdSeq !== undefined && messageIndexes?.includes(state.holdSeq)) {
        await new Promise<void>((resolve) => heldPages.push(resolve));
      }
      return page;
    },
  };
  Object.defineProperty(dom.window, "withmate", { value: {
    ...api,
    onSessionTurnUpdated: (listener: (id: string) => void) => { onTurn.add(listener); return () => { onTurn.delete(listener); }; },
    readSessionExecution: async (_owner: string, operation: string, input: { messageSeqs?: number[]; liveTurnIds?: string[] }) => {
      if (operation === "read_conversation_threads") return { ok: true, initialMessageIndexes: [], children: peers.map((peer) => ({ ...peer })) };
      const scopedItems = state.sent.filter((item) => input.liveTurnIds?.includes(item.sourceTurnId)
        || item.sourceMessageSeq !== null && input.messageSeqs?.includes(item.sourceMessageSeq));
      return sentInstructionReaderFixture(scopedItems, operation, input) ?? { ok: true, items: [], nextCursor: null };
    },
  } });
  const readContext = { ownerSessionId: main.sessionId, target: main };
  const editor = { edits: {}, begin() {} };
  let threads: ReturnType<typeof useMainConversationThreads>;
  let column: ReturnType<typeof useConversationMessageColumn>;
  function View() {
    threads = useMainConversationThreads(readContext, true, "", () => {});
    column = useConversationMessageColumn({
      session: { id: main.sessionId, incarnationId: main.incarnationId, provider: "codex", messageCount: state.saved.length, messages: state.saved },
      baseProps: { ...createBaseProps(main.sessionId), turnSubmissions: submissions, inputReadContext: readContext, onSelectReply: (_key, reply) => replies.push(reply) },
      api, enabled: true, liveRun: state.live, frame: threads.frame, mainThreads: threads.projection, showAllThreads: threads.showAllThreads,
    });
    return column ? <QueuedTurnEditContext.Provider value={editor}><SessionMessageColumn {...column} /></QueuedTurnEditContext.Provider> : null;
  }
  function receipt(peer: typeof peers[number], sequence: number): SessionTurnQueueReceipt {
    const requestId = "request-" + peer.title;
    return { sessionId: main.sessionId, incarnationId: main.incarnationId, id: "receipt-" + peer.title, requestId, sequence, queuePosition: sequence,
      state: "queued", turnId: null, userMessageSeq: null, releasedAt: null, reason: null, createdAt: "now", updatedAt: "now",
      captured: { origin: { kind: "gui", operation: "send", targetSessionId: main.sessionId, targetIncarnationId: main.incarnationId },
        request: { clientRequestId: requestId, userMessage: "Prompt " + peer.title, mainConversationFrame: peer.target,
          executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write",
            codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } },
        attachments: [], provider: "codex", workspacePath: "workspace" } };
  }
  function live(r: SessionTurnQueueReceipt, text: string): LiveSessionRunState {
    assert.ok(r.turnId && r.userMessageSeq !== null);
    return { sessionId: main.sessionId, threadId: "provider-thread", sessionTurnId: r.turnId, turnId: "provider-" + r.turnId, runState: "running",
      queueReceipt: { id: r.id, incarnationId: r.incarnationId, userMessageSeq: r.userMessageSeq },
      assistantText: text, steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
  }
  return {
    main, peers, replies, state, document, receipt, live, submissions, heldPages,
    column: () => { assert.ok(column); return column; },
    render: () => act(async () => root.render(<View />)),
    select: (peer?: typeof peers[number]) => act(async () => threads.select(peer ? conversationPeerKey(peer.target) : ALL_MAIN_THREADS_ID)),
    queueChanged: () => [...onQueue].forEach((listener) => listener(main.sessionId)),
    indexChanged: () => [...onTurn].forEach((listener) => listener(main.sessionId)),
    close: async () => {
      await act(async () => root.unmount()); intersection.restore(); dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Mainの実行中・次実行の表示をSession全体の実行と予約順で一つに絞り、枠切替や次Turn開始で送信カードを別の応答に付け替えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/976; docs/design/session-history.md#main列の初期枠子session枠" }
// fault = "A実行中にB/Cの予約に応答を出す、アイドル時にCをBより先に表示する、Aの送信をBに表示する、Cで重複する、またはA/ALLでカードを本文と別にする"
// observable = "A/B/CとALLの会話DOMでの予約編集・取消・待機表示・応答本文・カード配置と件数、B実開始後の応答"
// observation_boundary = "component-behavior"
// scope = "Mainの会話選択→Column投影→カードと予約の実DOM。履歴・キュー・liveの到着はfixture"
// lifecycle = "permanent"
// impact = "別の指示が実行されたように見え、他の相手への送信を自分の依頼の結果と取り違える"
// distinction = "キュー単体と既存のカード配置testでは、同一Session内の別枠の実行・待機・宛先カードを横断する同時条件を通らない"
// @end-test-value
test("peer reservations keep Session queue order and outgoing cards keep their response and recipient", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = peerColumnFixture();
  const [a, b, c] = f.peers;
  const ra = { ...f.receipt(a, 1), state: "running" as const, turnId: "42", userMessageSeq: 0 };
  const rb = f.receipt(b, 2);
  const rc = f.receipt(c, 3);
  const cards = () => [...f.document.querySelectorAll(".session-outbound-inline, article.session-outbound")];
  const answer = () => f.document.querySelector(".message-row.assistant:not(.session-outbound)");
  const dots = () => f.document.querySelector(".typing-dots");
  const waiting = (id: string) => f.document.querySelector(`[data-queue-receipt-id="receipt-${id}"] button[aria-label^="Cancel queued turn"]`);
  f.state.receipts = [ra, rb, rc];
  f.state.live = f.live(ra, "BEFORE\n\nAFTER");
  f.state.sent = [{ receiptId: "outgoing", sourceTurnId: ra.turnId, sourceMessageSeq: null, sourceDisplayPosition: 6,
    sequence: 1, target: c.target, state: "queued", text: "HANDOFF TO C",
    origin: { kind: "session", actorKind: "main", actorSessionId: f.main.sessionId, actorIncarnationId: f.main.incarnationId,
      actorTurnId: ra.turnId, operation: "send", targetSessionId: c.target.sessionId, targetIncarnationId: c.target.incarnationId,
      targetSnapshot: { sessionTitle: "Peer C", character: { id: "C", name: "Mate C", iconPath: "" } } } }];
  try {
    await f.render();
    await f.select(b);
    assert.ok(waiting("B"));
    assert.ok(f.document.querySelector('[data-queue-receipt-id="receipt-B"] button[title="Edit queued message"]'));
    assert.ok(!answer(), "B must not contain an assistant row while A runs");
    assert.ok(!dots(), "B must not show typing dots while A runs");
    assert.equal(cards().length, 0);
    await f.select(c);
    assert.ok(waiting("C"));
    assert.ok(!answer(), "C's recipient card must not create an assistant row");
    assert.equal(cards().length, 1);
    assert.match(cards()[0].textContent ?? "", /HANDOFF TO C/);
    assert.ok(!cards()[0].closest('[data-message-source="turn-queue"]'), "C's card is independent of the queued input");
    for (const peer of [a, undefined]) {
      await f.select(peer);
      await act(async () => t.mock.timers.tick(100));
      assert.equal(cards().length, 1);
      assert.ok(answer()?.contains(cards()[0]));
      assert.match(answer()?.textContent ?? "", /BEFORE[\s\S]*HANDOFF TO C[\s\S]*AFTER/);
    }

    f.state.live = null;
    f.state.saved = [{ role: "user", text: "Prompt A", historyIndex: 0 }, { role: "assistant", text: "BEFORE\n\nAFTER", historyIndex: 1 }];
    f.state.receipts = [{ ...ra, state: "completed" }, rb, rc];
    f.state.sent = f.state.sent.map((item) => ({ ...item, sourceMessageSeq: 1 }));
    a.messageIndexes = [0, 1];
    a.inboundTurnIds = [ra.turnId];
    c.sentMessageIndexes = [1];
    await act(async () => { f.queueChanged(); f.indexChanged(); });
    await f.select(c);
    assert.ok(waiting("C"));
    assert.ok(!dots(), "an idle window does not promote C ahead of B");
    assert.equal(cards().length, 1, "the recipient keeps the same single card after the source is saved");
    await f.select(a);
    assert.ok(answer()?.contains(cards()[0]));
    assert.match(answer()?.textContent ?? "", /BEFORE[\s\S]*HANDOFF TO C[\s\S]*AFTER/);
    await f.select(b);
    assert.ok(dots(), "the eligible Session head keeps the accepted response surface");
    const startedB = { ...rb, state: "running" as const, turnId: "43", userMessageSeq: 2 };
    f.state.live = f.live(startedB, "B has started");
    f.state.receipts = [{ ...ra, state: "completed" }, startedB, rc];
    await act(async () => f.queueChanged());
    await f.render();
    await act(async () => t.mock.timers.tick(100));
    assert.ok(!waiting("B"), "B no longer offers reservation actions after start");
    assert.equal(f.document.querySelectorAll(".message-row.assistant:not(.session-outbound)").length, 1);
    assert.match(answer()?.textContent ?? "", /B has started/);
    assert.doesNotMatch(answer()?.textContent ?? "", /BEFORE|AFTER/);
    assert.equal(cards().length, 0);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "通常Sendの同じpeer応答は、全体tail・peer index・scoped pageが別々に到着しても表示済み本文と応答行を維持し、確定seqが表示枠へ届いたら同じ行からすぐ返信できる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/975; docs/design/session-history.md#明示返信" }
// fault = "全体tailだけでlive本文を廃棄する、scoped pageで応答を再作成または二重化する、仮seqにReplyを許す、または保存行のReplyを次のSendまで出さない"
// observable = "peer→ALL→peer後の各到着段階におけるassistant行の件数・本文・DOM identity・Replyの可否と選択された正本seq"
// observation_boundary = "component-behavior"
// scope = "Mainの通常Send受付以降から保存行への引渡し。実会話選択とColumnを使い、親snapshotとIPC応答・通知をfixtureで制御する"
// lifecycle = "permanent"
// impact = "読めていた回答が消えたり、同じ回答へその場で返信できなくなったりする"
// distinction = "ALLや単一列のhandoff testでは、保存tailとは別のpeer indexとscoped pageが遅れる境界を通らない"
// @end-test-value
test("peer response survives delayed index and page and can be replied to on the same saved row", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = peerColumnFixture();
  const [a] = f.peers;
  const accepted = f.receipt(a, 1);
  const started = { ...accepted, state: "running" as const, turnId: "42", userMessageSeq: 0 };
  const reply = (row: Element) => row.querySelector<HTMLButtonElement>('button[aria-label="Reply to message"]');
  const answer = (text: string) => {
    const rows = f.document.querySelectorAll(".message-row.assistant");
    assert.equal(rows.length, 1);
    assert.match(rows[0].textContent ?? "", new RegExp(text));
    return rows[0];
  };
  try {
    await f.render();
    await f.select(a);
    await act(async () => {
      f.submissions.start({ sessionId: f.main.sessionId, incarnationId: f.main.incarnationId, requestId: accepted.requestId,
        userMessage: accepted.captured.request.userMessage, historyMessageCount: 0, queuedBehindRun: false, mainConversationFrame: a.target, error: "" });
      f.submissions.accept(accepted);
    });
    assert.ok(f.document.querySelector(".typing-dots"));
    f.state.receipts = [started];
    f.state.live = f.live(started, "Streamed answer");
    await act(async () => f.queueChanged());
    await f.render();
    await act(async () => t.mock.timers.tick(100));
    answer("Streamed answer");
    await f.select();
    await act(async () => t.mock.timers.tick(100));
    answer("Streamed answer");
    await f.select(a);
    await act(async () => t.mock.timers.tick(100));
    const row = answer("Streamed answer");
    assert.ok(!reply(row), "a live row is not a Reply target");

    f.state.live = null;
    f.state.receipts = [{ ...started, state: "completed" }];
    f.state.saved = [{ role: "user", text: "Prompt A", historyIndex: 0 }, { role: "assistant", text: "Saved answer", historyIndex: 1 }];
    await act(async () => f.queueChanged());
    await f.render();
    assert.ok(answer("Streamed answer") === row, "canonical tail alone is not the selected scope");
    assert.ok(!reply(row));

    f.state.holdSeq = 1;
    a.messageIndexes = [0, 1];
    a.inboundTurnIds = [started.turnId];
    await act(async () => f.indexChanged());
    assert.equal(f.heldPages.length, 1, "the new peer index arrived but its body request has not resolved");
    assert.ok(answer("Streamed answer") === row, "the index alone cannot replace the response row");
    assert.ok(!reply(row));
    await act(async () => f.heldPages.splice(0).forEach((release) => release()));
    assert.ok(answer("Saved answer") === row, "the saved body replaces the live body in the same row");
    const button = reply(row);
    assert.ok(button);
    await act(async () => button.click());
    assert.deepEqual(f.replies, [{ target: f.main, seq: 1 }]);
  } finally { await f.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "送信元Turn待ち・状態不明・実解放待ちの予約は応答待ちを始めず、配送可能な別予約や開始済みTurnの応答を妨げない"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md: Bound Session API; https://github.com/natumekazuki/WithMate/issues/963" }
// fault = "送信元待ちを実行中の応答として描画する、後続の即時配送を隠す、または開始後も予約操作を残す"
// observable = "実Columnの応答待ち状態、入力順序と予約取消操作"
// observation_boundary = "component-behavior"
// scope = "Main/Auxiliaryの遅延配送と通常queue投影"
// lifecycle = "permanent"
// impact = "実行できない予約が処理開始済みと誤認され、別の配送の進行を見失う"
// distinction = "storageの配送条件testや単体projection testでは会話Columnの応答待機と予約操作を検証できない"
// @end-test-value
test("conversation column keeps source-blocked deliveries queued until dispatch", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, { offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) {
      let changed: ((id: string) => void) | undefined;
      const blocked: SessionTurnQueueReceipt = {
        sessionId: kind, incarnationId: "inc", id: "blocked", requestId: "blocked-request", sequence: 1, queuePosition: 1,
        state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
        sourceTurnPhase: "running",
        captured: { origin: { kind: "session", operation: "send", deliveryTiming: "after_source_turn", targetSessionId: kind, targetIncarnationId: "inc" },
          request: { clientRequestId: "blocked-request", userMessage: "delayed prompt", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
      };
      let active = [blocked];
      const api: ConversationMessageColumnApi = {
        listSessionTurnQueue: async () => active,
        onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
      };
      let latest: SessionMessageColumnProps | null = null;
      function View() {
        latest = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", messages: [], runState: "idle" },
          baseProps: createBaseProps(kind), enabled: true, api, messageSourceKind: kind, liveRun: null });
        return latest ? <SessionMessageColumn {...latest} /> : null;
      }
      await act(async () => root.render(<View key={kind} />));
      const column = () => latest!;
      for (const source of [{ sourceTurnPhase: "running" as const }, { sourceTurnPhase: "unknown" as const }, { sourceTurnPhase: undefined }, { sourceTurnPhase: "canceled" as const, sourceTurnPendingRelease: true }]) {
        active = [{ ...blocked, ...source }];
        await act(async () => changed?.(kind));
        assert.equal(column().responsePending, false, `${kind}: source-blocked input is not a pending response`);
        assert.equal(dom.window.document.querySelectorAll(".pending-row").length, 0);
        assert.ok(dom.window.document.querySelector('button[aria-label="Cancel queued turn 1"]'));
      }
      active = [{ ...blocked, sourceTurnPhase: "completed" }];
      await act(async () => changed?.(kind));
      assert.equal(column().responsePending, true, `${kind}: released delivery can own the response`);
      const immediate = { ...blocked, id: "immediate", requestId: "immediate-request", sequence: 2, queuePosition: 2,
        captured: { ...blocked.captured, origin: { ...blocked.captured.origin!, deliveryTiming: "immediate" as const }, request: { ...blocked.captured.request, clientRequestId: "immediate-request", userMessage: "immediate prompt" } } };
      active = [blocked, immediate];
      await act(async () => changed?.(kind));
      assert.equal(column().responsePending, true, `${kind}: immediate work can pass the blocked delivery`);
      assert.equal(column().messages.at(-1)?.text, "immediate prompt");
      assert.ok(dom.window.document.body.textContent?.includes("delayed prompt"));
      active = [blocked, { ...immediate, state: "starting" }];
      await act(async () => changed?.(kind));
      assert.equal(column().responsePending, true, `${kind}: starting owns the response`);
      assert.equal(dom.window.document.querySelector('[data-queue-receipt-id="immediate"]'), null);
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="blocked"]'));
      await act(async () => root.render(<></>));
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryのlive開始が先に届いても、同じ予約の待機操作を外し、別の予約と保存済み入力を保つ"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/963; docs/design/desktop-ui.md: pending 中の live activity / streaming response" }
// fault = "古いqueued receiptで開始済み入力のQueue操作を残す、異なる予約の操作を消す、または保存済み入力を二重表示する"
// observable = "Column DOMの予約操作、user本文の件数とlive応答、開始失敗の表示"
// observation_boundary = "consumer"
// scope = "Main/Auxiliaryのqueue snapshotとlive実行の表示結合。IPCと保存はfixture"
// lifecycle = "permanent"
// impact = "利用者が実行中の予約を操作可能と誤認したり、別の待機予約や入力の対応を見失う"
// distinction = "renderer queue購読単体ではlive開始通知と古いreceipt・保存履歴が別順序で到着する画面を検証できない"
// @end-test-value
test("conversation column binds live starts to the matching stale queued receipt", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, { offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) {
      let changed: ((id: string) => void) | undefined;
      const makeReceipt = (id: string, sequence: number): SessionTurnQueueReceipt => ({
        sessionId: kind, incarnationId: "inc", id, requestId: `request-${id}`, sequence, queuePosition: sequence,
        state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
        captured: { request: { clientRequestId: `request-${id}`, userMessage: `prompt ${id}`, executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
      });
      const first = makeReceipt("first", 1);
      const second = makeReceipt("second", 2);
      let active = [first, second];
      let holdReads = false;
      const heldReads: Array<() => void> = [];
      const api: ConversationMessageColumnApi = {
        listSessionTurnQueue: () => {
          const snapshot = [...active];
          return holdReads ? new Promise((resolve) => heldReads.push(() => resolve(snapshot))) : Promise.resolve(snapshot);
        },
        onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
      };
      let live: LiveSessionRunState | null = null;
      let messages: SessionMessageColumnProps["messages"] = [];
      let latest: SessionMessageColumnProps | null = null;
      function View() {
        const column = latest = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", messages, runState: live ? "running" : "idle" },
          baseProps: createBaseProps(kind), enabled: true, api, messageSourceKind: kind, liveRun: live });
        return column ? <SessionMessageColumn {...column} /> : null;
      }
      await act(async () => root.render(<View key={kind} />));
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="first"]'));
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="second"]'));

      live = { sessionId: kind, threadId: "thread", runState: "running", sessionTurnId: "42", turnId: "native",
        queueReceipt: { id: "first", incarnationId: "other", userMessageSeq: 0 }, assistantText: "live answer", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
      await act(async () => root.render(<View key={kind} />));
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="first"]'), "another incarnation must not claim the receipt");
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="second"]'));

      holdReads = true;
      await act(async () => changed?.(kind));
      active = [{ ...first, state: "running", turnId: "42", userMessageSeq: 0 }, second];
      live = { ...live, queueReceipt: { id: "first", incarnationId: "inc", userMessageSeq: 0 } };
      messages = [{ role: "user", text: "prompt first", historyIndex: 0 }];
      await act(async () => root.render(<View key={kind} />));
      assert.equal(dom.window.document.querySelector('[data-queue-receipt-id="first"]'), null, "a known start must not retain queued actions");
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="second"]'), "the other queued receipt remains actionable");
      assert.equal(dom.window.document.body.textContent?.split("prompt first").length, 2, "canonical and queued copies merge");
      assert.equal((latest as SessionMessageColumnProps | null)?.liveRunAssistantText, "live answer");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      assert.match(dom.window.document.body.textContent ?? "", /live answer/);

      live = null;
      active = [{ ...first, state: "failed", turnId: "42", userMessageSeq: 0, reason: "start failed" }, second];
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.equal(dom.window.document.querySelector('[data-queue-receipt-id="first"]'), null, "an in-flight stale read must not restore queued actions");
      assert.equal(dom.window.document.body.textContent?.split("prompt first").length, 2);
      holdReads = false;
      await act(async () => { heldReads.reverse().forEach((resolve) => resolve()); });
      assert.match(dom.window.document.body.textContent ?? "", /start failed/);
      assert.ok(dom.window.document.querySelector('[data-queue-receipt-id="second"]'));
      await act(async () => root.render(<></>));
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "新規・既存のMain/Auxiliaryは保存turn IDとnative IDが異なっても初回送信からlive本文を更新し、保存応答へ同じ応答面を引き継ぐ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: pending 中の live activity / streaming response" }
// fault = "receiptの保存IDをnative IDと比較して本文を隠すか、保存履歴への切替で本文を欠落・重複させる"
// observable = "実Column DOMの待機・逐次本文・保存本文の行identityと件数、live controlsのnative ID"
// observation_boundary = "consumer"
// scope = "共有live ingress・queue receipt・Column。providerとIPCはfixtureで代替"
// lifecycle = "permanent"
// impact = "利用者が実行中の応答を読めず、完了時に応答の対応や内容を見失う"
// distinction = "provider単体や型検査はlocal submissionと別IDのlive ingressが実表示へ合流することを検証しない"
// @end-test-value
test("conversation column は異なる保存IDとnative IDで初回のlive応答を表示する", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, { offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) for (const priorHistory of [false, true]) {
      const store = new SessionTurnSubmissions();
      const liveListeners = new Set<(id: string, state: LiveSessionRunState | null) => void>();
      let queueChanged: ((id: string) => void) | undefined;
      let live: LiveSessionRunState | null = null;
      let saved: SessionMessageColumnProps["messages"] = priorHistory
        ? [{ role: "user", text: "old prompt" }, { role: "assistant", text: "old response" }] : [];
      const userMessageSeq = saved.length;
      let receipt: SessionTurnQueueReceipt = {
        sessionId: kind, incarnationId: "inc", id: "receipt", requestId: "request", sequence: 1, queuePosition: 1,
        state: "starting", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
        captured: { request: { clientRequestId: "request", userMessage: "new prompt", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
      };
      const api = {
        getLiveSessionRun: async () => live,
        subscribeLiveSessionRun: (listener: (id: string, state: LiveSessionRunState | null) => void) => { liveListeners.add(listener); return () => { liveListeners.delete(listener); }; },
        listSessionTurnQueue: async () => receipt.state === "completed" ? [] : [receipt],
        getSessionTurnQueueReceipt: async () => receipt,
        onSessionTurnQueueChanged: (listener: (id: string) => void) => { queueChanged = listener; return () => { queueChanged = undefined; }; },
      };
      let controlTurnId: string | undefined;
      const disposeControls = subscribeSessionRunControls({ api, sessionId: kind, onChange: (controls) => { controlTurnId = controls.inputTurnId; } });
      let latest: SessionMessageColumnProps | null = null;
      function View() {
        latest = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", messages: saved, runState: live ? "running" : "idle" },
          baseProps: { ...createBaseProps(kind), turnSubmissions: store }, messageSourceKind: kind, enabled: true, api });
        return latest ? <SessionMessageColumn {...latest} /> : null;
      }
      const render = () => act(async () => root.render(<View key={`${kind}-${priorHistory}`} />));
      const responses = () => [...dom.window.document.querySelectorAll(".message-row.assistant")];
      await render();
      await act(async () => {
        store.start({ sessionId: kind, incarnationId: "inc", requestId: "request", userMessage: "new prompt", historyMessageCount: userMessageSeq, queuedBehindRun: false, error: "" });
        store.accept(receipt); queueChanged?.(kind);
      });
      const response = responses().at(-1);
      assert.ok(response, "the submitted request already owns a waiting response");
      receipt = { ...receipt, state: "running", turnId: "42", userMessageSeq };
      saved = [...saved, { role: "user", text: "new prompt" }];
      await act(async () => { queueChanged?.(kind); root.render(<View key={`${kind}-${priorHistory}`} />); });
      live = { sessionId: kind, threadId: "thread", sessionTurnId: "42", turnId: "native-codex-turn", inputAvailable: true,
        runState: "running", assistantText: "first live response", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
      await act(async () => { liveListeners.forEach((listener) => listener(kind, live)); });
      assert.equal((latest as SessionMessageColumnProps | null)?.liveRunAssistantText, "first live response");
      assert.equal(controlTurnId, "native-codex-turn");
      assert.ok(responses().at(-1) === response);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      assert.match(response.textContent ?? "", /first live response/);
      live = { ...live, assistantText: "first live response extended" };
      await act(async () => { liveListeners.forEach((listener) => listener(kind, live)); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      assert.equal((latest as SessionMessageColumnProps | null)?.liveRunAssistantText, "first live response extended");
      assert.match(response.textContent ?? "", /first live response extended/);
      receipt = { ...receipt, state: "completed" };
      saved = [...saved, { role: "assistant", text: "saved response" }];
      live = null;
      await act(async () => { liveListeners.forEach((listener) => listener(kind, live)); queueChanged?.(kind); root.render(<View key={`${kind}-${priorHistory}`} />); });
      assert.ok(responses().at(-1) === response);
      assert.match(response.textContent ?? "", /saved response/);
      assert.equal(responses().length, priorHistory ? 2 : 1);
      assert.deepEqual((latest as SessionMessageColumnProps | null)?.messages.map((message) => message.text), [
        ...(priorHistory ? ["old prompt", "old response"] : []), "new prompt", "saved response",
      ]);
      disposeControls();
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxはqueueなし・receipt先着・回答先着のいずれでも保存済み質問回答を表示し、予約と同文でも回答を一度だけ表示する。履歴以前の遅いreceipt読込では合流待ちを解かず、最新照会後は回答・応答identityと予約順を保つ。後続予約がlive通知なしで完了しても、receipt/canonicalの到着順によらず待機DOMを保存済み応答へ継承する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Question Forms / Session Windowの受付済みreceiptと保存user seqの表示" }
// fault = "未実行予約で質問回答を隠し続ける、古い照会で通常予約を二重表示する、同文の回答を予約に誤結合する、または応答identity・予約順を変える"
// observable = "実Column DOMのuser本文・順序・件数、応答node identity、Column messageKeys、submissionの残存request ID、queue操作API呼出"
// observation_boundary = "component-behavior"
// scope = "保存済み質問回答とqueue receiptを受け取るMain/Aux共有hook・Column。Provider配送や保存APIの実行は含まない"
// lifecycle = "permanent"
// impact = "回答済み入力が表示されず再送を誘発し、予約や会話の対応を見失う"
// distinction = "既存handoff testは未実行予約中の独立した質問回答を通らない。小さいDOM fixtureで到着順を制御し、型検査では分からない表示とidentityを検証する"
// @end-test-value
test("conversation column shows question answers independently of queued submissions", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) {
      for (const arrival of ["no-queue", "receipt-first", "answer-first"] as const) {
        const store = new SessionTurnSubmissions();
        const receipt = (sequence: number): SessionTurnQueueReceipt => ({
          sessionId: kind, incarnationId: "inc", id: `receipt-${sequence}`, requestId: `request-${sequence}`, sequence, queuePosition: sequence,
          state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
          captured: { request: { clientRequestId: `request-${sequence}`, userMessage: sequence === 1 ? "same answer" : "later prompt",
            executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
        });
        const reserved = arrival === "no-queue" ? [] : [receipt(1), receipt(2)];
        let active = arrival === "receipt-first" ? reserved : [];
        const terminals = new Map<string, SessionTurnQueueReceipt>();
        let holdReads = false;
        const reads: (() => void)[] = [];
        let changed: ((id: string) => void) | undefined;
        const mutations: string[] = [];
        const api: ConversationMessageColumnApi = {
          listSessionTurnQueue: () => {
            const snapshot = [...active];
            return holdReads ? new Promise((resolve) => reads.push(() => resolve(snapshot))) : Promise.resolve(snapshot);
          },
          getSessionTurnQueueReceipt: async (_id, requestId) => terminals.get(requestId) ?? active.find((item) => item.requestId === requestId) ?? null,
          onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
          cancelQueuedSessionTurn: async () => { mutations.push("cancel"); throw new Error("Unexpected queue mutation"); },
          sendQueuedSessionInput: async () => { mutations.push("input"); throw new Error("Unexpected queue mutation"); },
        };
        let saved: SessionMessageColumnProps["messages"] = [{ role: "user", text: "current prompt", historyIndex: 0 }];
        let live: LiveSessionRunState | null = { sessionId: kind, threadId: "thread", turnId: "current", runState: "running", assistantText: "current response", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
        let latest: SessionMessageColumnProps | null = null;
        function View() {
          latest = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", messages: saved, runState: live?.runState ?? "idle" },
            baseProps: { ...createBaseProps(kind), turnSubmissions: store }, messageSourceKind: kind, enabled: true, api, liveRun: live });
          return latest ? <SessionMessageColumn {...latest} /> : null;
        }
        const render = () => act(async () => root.render(<View key={`${kind}-${arrival}`} />));
        const column = () => { assert.ok(latest); return latest; };
        const users = () => [...dom.window.document.querySelectorAll(".message-row.user .rich-text")].map((node) => node.textContent);
        const finishReads = () => act(async () => { reads.splice(0).forEach((reply) => reply()); });
        await render();
        const responseNode = dom.window.document.querySelector(".message-row.assistant");
        const responseKey = column().responsePresentationKey;
        await act(async () => {
          for (const item of reserved) {
            store.start({ sessionId: kind, incarnationId: "inc", requestId: item.requestId, userMessage: item.captured.request.userMessage, historyMessageCount: 1, queuedBehindRun: true, error: "" });
            if (arrival === "receipt-first") store.accept(item);
          }
        });
        holdReads = true;
        await act(async () => changed?.(kind));
        const staleRead = reads.shift()!;
        saved = [...saved, { role: "user", text: "same answer", historyIndex: 1 }];
        await render();
        await act(async () => staleRead());
        if (reserved.length) assert.equal(column().messages.some((message) => message.role === "user" && message.historyIndex === 1), false, "a pre-history read cannot resolve this handoff");
        await finishReads();
        assert.deepEqual(users(), ["current prompt", "same answer", ...(arrival === "receipt-first" ? reserved.map((item) => item.captured.request.userMessage) : [])], `${kind}/${arrival}: saved answer is not a queued prompt`);
        const answerKey = column().messageKeys?.[1];
        assert.equal(dom.window.document.querySelector(".message-row.assistant"), responseNode);
        assert.equal(column().responsePresentationKey, responseKey);
        active = reserved;
        await act(async () => { reserved.forEach((item) => store.accept(item)); changed?.(kind); });
        await finishReads();
        saved = [...saved, { role: "user", text: "second answer", historyIndex: 2 }];
        await render();
        await finishReads();
        assert.deepEqual(users(), ["current prompt", "same answer", "second answer", ...reserved.map((item) => item.captured.request.userMessage)]);
        assert.equal(column().messageKeys?.[1], answerKey);
        assert.equal(dom.window.document.querySelector(".message-row.assistant"), responseNode);
        assert.deepEqual(store.getSnapshot().map((item) => item.requestId), reserved.map((item) => item.requestId));
        saved = [...saved, { role: "assistant", text: "current response", historyIndex: 3 }];
        live = null;
        await render();
        if (reserved.length) {
          const queuedUserKey = column().messageKeys?.[4];
          const queuedResponseNode = dom.window.document.querySelector(".pending-row");
          // Persisted user and bound receipt are committed together; only their delivery order differs.
          terminals.set("request-1", { ...reserved[0], state: "completed", turnId: "next", userMessageSeq: 4 });
          active = [reserved[1]];
          if (arrival === "receipt-first") {
            await act(async () => changed?.(kind));
            await finishReads();
            assert.ok(queuedResponseNode && dom.window.document.querySelector(".pending-row") === queuedResponseNode);
          }
          saved = [...saved, { role: "user", text: "same answer", historyIndex: 4 }, { role: "assistant", text: "next response", historyIndex: 5 }];
          await render();
          assert.deepEqual(users(), ["current prompt", "same answer", "second answer", "same answer", "later prompt"], "canonical-first delivery does not duplicate the reserved prompt");
          await finishReads();
          assert.deepEqual(column().messages.filter((message) => message.role === "user").map((message) => message.text), ["current prompt", "same answer", "second answer", "same answer", "later prompt"]);
          assert.equal(column().messageKeys?.[4], queuedUserKey);
          assert.deepEqual(store.getSnapshot().map((item) => item.requestId), ["request-2"]);
          const savedResponse = () => [...dom.window.document.querySelectorAll(".message-row.assistant")].find((node) => node.textContent?.includes("next response"));
          assert.ok(queuedResponseNode && savedResponse() === queuedResponseNode, `${kind}/${arrival}: fast completion retains the pending response DOM`);
          assert.ok(dom.window.document.querySelector(".pending-row") && dom.window.document.querySelector(".pending-row") !== queuedResponseNode, "the next queued turn owns a separate pending response");
          await act(async () => changed?.(kind));
          await finishReads();
          assert.ok(savedResponse() === queuedResponseNode, "the saved response keeps its DOM after the consumed receipt is removed");
        }
        assert.deepEqual(mutations, []);
        assert.deepEqual(reserved, arrival === "no-queue" ? [] : [receipt(1), receipt(2)], "projection does not modify queued receipts");
      }
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxは受付順と実行順が一致・逆転のどちらでも、次予約のstarting/runningと旧履歴の到着順によらず旧応答と次応答のDOMを保持する。Steerを挟んでも保存応答・本文・質問・承認を正しい面へ接続し、未確定のliveはreceiptで所属が確定するまで待つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 通常応答のrequest/turn表示identity、確定応答の取得待ち" }
// fault = "受付sequenceを実行境界とみなして旧待機DOMを捨てる、後着旧履歴を次応答へ結合する、または同じ保存応答を重複表示する"
// observable = "実Columnのassistant DOM・avatar・card identity、取得待ちstatus、保存本文と行順、質問・承認の所属、key一意性、submission消費"
// observation_boundary = "component-behavior"
// scope = "Main/Aux共有Columnのqueue receipt・live・canonical履歴の合流。Providerや保存処理はmock境界"
// lifecycle = "permanent"
// impact = "連続送信で待機面が消失・再生成され、どのpromptへの応答かと閲覧位置が揺れる"
// distinction = "既存連続queue testは旧live本文があるhook propsを検証する。本文なしの旧待機面を実DOMで検証し、型検査や既存handoffでは検出できない順序を小さいfixtureで固定する"
// @end-test-value
test("conversation column retains empty responses when the next turn starts before history", async (t) => {
  const consoleErrors = t.mock.method(console, "error");
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) for (const reversed of [false, true]) for (const [nextState, liveFirst, withInput] of [["starting", false, false], ["starting", true, false], ["running", false, false], ["running", true, false], ["running", true, true]] as const) {
      const store = new SessionTurnSubmissions();
      const receipt = (sequence: number): SessionTurnQueueReceipt => ({
        sessionId: kind, incarnationId: "inc", id: `receipt-${sequence}`, requestId: `request-${sequence}`,
        sequence: reversed && sequence <= 2 ? 3 - sequence : sequence, queuePosition: sequence,
        state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
        captured: { request: { clientRequestId: `request-${sequence}`, userMessage: `prompt-${sequence}`, executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
      });
      let active = [receipt(1), receipt(2)];
      const terminals = new Map<string, SessionTurnQueueReceipt>();
      let changed: ((id: string) => void) | undefined;
      const api: ConversationMessageColumnApi = {
        listSessionTurnQueue: async () => active,
        getSessionTurnQueueReceipt: async (_id, requestId) => terminals.get(requestId) ?? active.find((item) => item.requestId === requestId) ?? null,
        onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
      };
      for (const item of active) {
        store.start({ sessionId: kind, incarnationId: "inc", requestId: item.requestId, userMessage: item.captured.request.userMessage, historyMessageCount: 0, queuedBehindRun: item.queuePosition > 1, error: "" });
        store.accept(item);
      }
      let saved: SessionMessageColumnProps["messages"] = [];
      let live: LiveSessionRunState | null = null;
      let latest: SessionMessageColumnProps | null = null;
      function View() {
        const props = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", messages: saved, runState: live?.runState ?? "idle" }, baseProps: { ...createBaseProps(kind), turnSubmissions: store }, messageSourceKind: kind, enabled: true, api, liveRun: live });
        latest = props;
        if (props) assert.equal(new Set(props.messageKeys).size, props.messageKeys?.length, "projected row keys stay unique");
        return props ? <SessionMessageColumn {...props} /> : null;
      }
      const viewKey = `${kind}-${reversed}-${nextState}-${liveFirst}-${withInput}`;
      const nextUserSeq = withInput ? 3 : 2;
      const thirdUserSeq = nextUserSeq + 2;
      const render = () => act(async () => root.render(<View key={viewKey} />));
      const responses = () => [...dom.window.document.querySelectorAll(".message-row.assistant")];
      await render();
      const first = responses()[0];
      assert.ok(first);
      const firstAvatar = first.querySelector(".message-avatar");
      const firstCard = first.querySelector(".message-card");
      terminals.set("request-1", { ...receipt(1), state: "completed", turnId: "turn-1", userMessageSeq: 0 });
      active = [{ ...receipt(2), state: nextState, turnId: nextState === "running" ? "turn-2" : null, userMessageSeq: nextState === "running" ? nextUserSeq : null }];
      const nextLive: LiveSessionRunState = { sessionId: kind, threadId: "thread", sessionTurnId: "turn-2", turnId: "native-turn-2", runState: "running", assistantText: "response-2", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
      if (nextState === "starting" && liveFirst) {
        nextLive.approvalRequest = { requestId: "approval-2", provider: "codex", kind: "command", title: "Approve next task", summary: "Next task approval", decisionMode: "direct-decision" };
        nextLive.elicitationRequest = { requestId: "question-2", provider: "codex", turnId: "native-turn-2", kind: "question", delivery: "user-message", mode: "form", message: "Next task question", fields: [{ type: "text", name: "answer", title: "Next answer", required: true }] };
      }
      if (liveFirst) live = nextLive;
      await act(async () => {
        if (withInput) {
          const input = { ...receipt(3), state: "completed" as const, inputTurnId: "turn-1", turnId: "turn-1", userMessageSeq: 1 };
          terminals.set(input.requestId, input);
          store.start({ sessionId: kind, incarnationId: "inc", requestId: input.requestId, userMessage: "prompt-3", historyMessageCount: 0, queuedBehindRun: true, error: "" });
          store.accept(input);
        }
        changed?.(kind); root.render(<View key={viewKey} />);
      });
      assert.ok(first.isConnected && responses()[0] === first, `${kind}/${nextState}: the old waiting surface survives the next start`);
      assert.equal(responses().length, 2);
      assert.match(first.textContent ?? "", /Loading response/);
      const second = responses()[1];
      const secondAvatar = second.querySelector(".message-avatar");
      const secondCard = second.querySelector(".message-card");
      if (nextState === "running") {
        live = nextLive;
        await render();
        assert.ok(responses()[0] === first && responses()[1] === second, "the next live body belongs to the next response surface");
      }
      saved = [{ role: "user", text: "prompt-1", historyIndex: 0 }];
      if (withInput) saved.push({ role: "user", text: "prompt-3", historyIndex: 1 });
      saved.push({ role: "assistant", text: "final-1", historyIndex: nextUserSeq - 1 });
      await render();
      assert.ok(responses()[0] === first && responses()[1] === second, "old canonical arrival cannot replace either response surface");
      assert.ok(first.querySelector(".message-avatar") === firstAvatar && first.querySelector(".message-card") === firstCard);
      assert.match(first.textContent ?? "", /final-1/);
      assert.doesNotMatch(second.textContent ?? "", /final-1/);
      assert.deepEqual(store.getSnapshot().map((item) => item.requestId), ["request-2"]);
      if (nextState === "starting" && liveFirst) {
        assert.equal((latest as unknown as SessionMessageColumnProps).isRunning, true, "binding wait does not fake an idle runtime");
        assert.doesNotMatch(dom.window.document.body.textContent ?? "", /response-2|Next answer|Next task approval/);
        active = [{ ...receipt(2), state: "running", turnId: "turn-2", userMessageSeq: nextUserSeq }];
        await act(async () => { changed?.(kind); root.render(<View key={viewKey} />); });
        assert.ok(responses()[0] === first && responses()[1] === second, "receipt binding keeps both response surfaces");
        assert.match(second.textContent ?? "", /response-2/);
        assert.match(second.textContent ?? "", /Next answer/);
        assert.match(second.textContent ?? "", /Next task approval/);
        assert.doesNotMatch(first.textContent ?? "", /response-2|Next answer|Next task approval/);
      }
      terminals.set("request-2", { ...receipt(2), state: "completed", turnId: "turn-2", userMessageSeq: nextUserSeq }); active = []; live = null;
      await act(async () => { changed?.(kind); root.render(<View key={viewKey} />); });
      saved = [...saved, { role: "user", text: "prompt-2", historyIndex: nextUserSeq }, { role: "assistant", text: "final-2", historyIndex: nextUserSeq + 1 }];
      await render();
      assert.ok(responses()[0] === first && responses()[1] === second);
      assert.ok(first.querySelector(".message-avatar") === firstAvatar && first.querySelector(".message-card") === firstCard);
      assert.ok(second.querySelector(".message-avatar") === secondAvatar && second.querySelector(".message-card") === secondCard);
      assert.deepEqual([...dom.window.document.querySelectorAll(".message-row .rich-text")].map((node) => node.textContent), ["prompt-1", ...(withInput ? ["prompt-3"] : []), "final-1", "prompt-2", "final-2"]);
      assert.equal(store.getSnapshot().length, 0);
      active = [receipt(4)];
      await act(async () => {
        store.start({ sessionId: kind, incarnationId: "inc", requestId: "request-4", userMessage: "prompt-4", historyMessageCount: thirdUserSeq, queuedBehindRun: false, error: "" });
        store.accept(active[0]); changed?.(kind);
      });
      const third = responses().at(-1);
      assert.ok(third && third !== second);
      active = [{ ...receipt(4), state: "running", turnId: "turn-3", userMessageSeq: thirdUserSeq }];
      live = { ...nextLive, sessionTurnId: "turn-3", turnId: "native-turn-3", assistantText: "", approvalRequest: null, elicitationRequest: null };
      await act(async () => { changed?.(kind); root.render(<View key={viewKey} />); });
      assert.ok(responses().at(-1) === third, "a request's own first live cannot replace its pending surface");
      live = { ...live, runState: "completed", assistantText: "final-3" };
      terminals.set("request-4", { ...active[0], state: "completed" }); active = [];
      saved = [...saved, { role: "user", text: "prompt-4", historyIndex: thirdUserSeq }, { role: "assistant", text: "final-3", historyIndex: thirdUserSeq + 1 }];
      await act(async () => { changed?.(kind); root.render(<View key={viewKey} />); });
      assert.ok(responses().at(-1) === third);
    }
    assert.equal(consoleErrors.mock.calls.filter((call) => /same key|unique.*key/i.test(String(call.arguments[0]))).length, 0, "React receives no duplicate response keys");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryのHTMLプレビューFind通知は一度でactive会話の検索を開き、非active列では検索を開かない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Ctrl+Fはactiveなchatを検索する" }
// fault = "HTML consumerがFind callbackを渡さずfocus復帰だけになる、または非active列で検索を開く"
// observable = "実SessionMessageColumnのFind inputの有無とfocus、HTML previewのmount/通知IDとlink出自"
// observation_boundary = "consumer"
// scope = "SessionMessageColumn→MessageRichText→MarkdownHtmlPreview→HtmlPreviewのFind接続"
// lifecycle = "permanent"
// impact = "HTML操作中に会話検索が使えない、または別会話の検索を意図せず開く"
// distinction = "HtmlPreview単体のcallback testはchat consumerへの接続を通らない。2ownerの小さなDOM遷移で接続漏れを検出する"
// @end-test-value
test("HTML previewのFind通知はactiveなMain/Auxiliary会話の検索を開く", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [dom.window, dom.window.document, dom.window.HTMLElement, dom.window.Node, dom.window.navigator, true];
  globals.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get: () => 600 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get: () => 800 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 600 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => 800 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { value() {} });
  const intersection = installIntersectionObserver();
  const listeners = new Set<(event: HtmlPreviewEvent) => void>();
  let mountedId = "";
  Object.defineProperty(dom.window, "withmate", { value: {
    readSessionHtmlPreview: async () => ({ html: "<h1>Chart</h1>", fileName: "chart.html" }),
    mountHtmlPreview: async ({ id, source }: HtmlPreviewMountRequest) => {
      assert.equal(source.kind, "link");
      if (source.kind === "link") assert.equal(source.request.target, "/work/chart.html");
      mountedId = id;
      return { url: "withmate-html-preview://test/", partition: "test" };
    },
    disposeHtmlPreview: async () => {},
    respondHtmlPreview: async () => {},
    subscribeHtmlPreviewEvents: (listener: (event: HtmlPreviewEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (id: string, active: boolean) => root.render(<SessionMessageColumn
    {...createBaseProps(id)} key={id} provider="codex" isContentActive={active}
    messages={[{ role: "assistant", text: 'Before visualize{"path":"/work/chart.html"} After' }]} messageKeys={["response"]}
  />);
  const findInput = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Find in current content"]');
  try {
    for (const owner of ["main", "aux"]) {
      mountedId = "";
      await act(async () => render(owner, true));
      assert.ok(mountedId, owner);
      assert.equal(findInput(), null, owner);
      await act(async () => listeners.forEach((listener) => listener({ id: mountedId, type: "find" })));
      assert.ok(findInput(), owner);
      assert.equal(dom.window.document.activeElement, findInput(), owner);
      await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close find"]')!.click());
      await act(async () => render(owner, false));
      await act(async () => listeners.forEach((listener) => listener({ id: mountedId, type: "find" })));
      assert.equal(findInput(), null, owner);
    }
  } finally {
    await act(async () => root.unmount());
    intersection.restore();
    dom.window.close();
    globals.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "追尾停止直後と仮想range確定後のanchorを保存し、owner切替と非表示中の本文更新後の再表示で保存key・offsetを復元requestへ渡し、会話別の追従状態と末尾操作による再開を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: message list follow mode" }
// fault = "render前の停止を見落とす、overscan行を保存する、range確定後に保存しない、会話別の追従状態を失う、または再表示時に保存key・offsetを新しい復元requestへ渡さない"
// observable = "column propsのisMessageListFollowing、messageJumpRequestのsessionId・key・offset・requestId、list.scrollTop、cacheのanchor・scrollState"
// observation_boundary = "component-behavior"
// scope = "実follow hookと列cacheの接合。制御RAFと行矩形で停止直後・range commit通知・owner/visibility遷移のanchor保存と復元handoffまでを観測し、実virtualizerやCSSによる最終描画位置は保証しない"
// lifecycle = "permanent"
// impact = "MainとAuxiliaryの往復やPreview終了で読んでいた本文を見失わず、新着へ明示的に戻れる"
// distinction = "hook単体ではownerごとのcacheと仮想行keyへの復元handoffを通らない。小さいhook fixtureで列の接合を確認する"
// @end-test-value
test("conversation column はownerと非表示期間を跨いで閲覧anchorと追従状態を保持する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  const actEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  dom.window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  dom.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flushFrames = async () => {
    await act(async () => {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((callback) => callback(0));
    });
  };
  const cache = new Map<string, ConversationColumnCache>();
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let text = "response";
  let updatedAt = "2026-10-17T01:00:00.000Z";
  let rowTop = -12;
  let rowHeight = 100;
  let rowReads = 0;
  function Probe({ id, enabled }: { id: string; enabled: boolean }) {
    latest = useConversationMessageColumn({ session: { id, updatedAt, messages: [{ role: "assistant", text }] }, baseProps: createBaseProps(id), enabled, stateCache: cache, liveRun: null });
    return React.createElement("div", { ref: latest?.messageListRef, onScroll: latest?.onMessageListScroll },
      React.createElement("div", { className: "session-message-virtual-row", "data-index": 0 }));
  }
  const current = () => { assert.ok(latest); return latest; };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (id = "main", enabled = true) => act(async () => root.render(React.createElement(Probe, { id, enabled })));
  try {
    await render();
    const list = current().messageListRef.current!;
    Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1_000 }, clientHeight: { configurable: true, value: 100 } });
    const row = list.firstElementChild as HTMLElement;
    row.getBoundingClientRect = () => { rowReads += 1; return new dom.window.DOMRect(0, rowTop, 400, rowHeight); };
    await act(async () => {
      list.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true }));
      list.scrollTop = 200;
      list.dispatchEvent(new dom.window.Event("scroll"));
      list.dispatchEvent(new dom.window.Event("scroll"));
      assert.equal(rowReads, 0, "scroll handlers defer anchor layout reads");
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((callback) => callback(0));
      assert.deepEqual(cache.get("main")?.anchor, { key: "session-main-0", offset: -12, messageIndex: 0 }, "the frame sees a stop before React commits its following flag");
    });
    assert.equal(rowReads, 1, "repeated scrolls share one anchor measurement per frame");
    rowTop = 150;
    await act(async () => list.dispatchEvent(new dom.window.Event("scroll")));
    await flushFrames();
    assert.equal(cache.get("main")?.anchor?.offset, -12, "an overscan row below the viewport is not a visible anchor");
    rowTop = -22;
    await act(async () => current().onMessageListLayout?.());
    await flushFrames();
    assert.equal(cache.get("main")?.anchor?.offset, -22, "committed virtual range layout refreshes the reading position without another scroll event");
    text = "replaced";
    await render();
    assert.equal(current().isMessageListFollowing, false);
    assert.equal(list.scrollTop, 200);
    await render("aux");
    assert.equal(current().isMessageListFollowing, true, "Auxiliary has its own following state");
    rowTop = 80;
    rowHeight = 200;
    await render();
    assert.equal(current().isMessageListFollowing, false);
    assert.equal(current().messageJumpRequest?.key, "session-main-0");
    assert.equal(current().messageJumpRequest?.offset, -22, "restore retains the latest reading offset after geometry changes");
    await act(async () => current().onJumpToBottom?.());
    assert.equal(current().isMessageListFollowing, true);
    await flushFrames();
    rowTop = -37;
    await act(async () => {
      list.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true }));
      list.scrollTop = 360;
      list.dispatchEvent(new dom.window.Event("scroll"));
    });
    await flushFrames();
    const readingAnchor = { key: "session-main-0", offset: -37, messageIndex: 0 };
    assert.equal(current().isMessageListFollowing, false);
    assert.equal(list.scrollTop, 360);
    assert.equal(cache.get("main")?.scrollState?.scrollTop, 360);
    assert.deepEqual(cache.get("main")?.anchor, readingAnchor, "the hook captures a distinct reading position before hiding");
    const requestIdBeforeHide = current().messageJumpRequest?.requestId ?? 0;
    await render("main", false);
    text = "modified";
    updatedAt = "2026-10-17T01:00:01.000Z";
    await render("main", false);
    await render();
    assert.equal(current().isMessageListFollowing, false);
    const restoredRequest = current().messageJumpRequest;
    assert.ok(restoredRequest);
    assert.equal(restoredRequest.sessionId, "main");
    assert.equal(restoredRequest.key, readingAnchor.key);
    assert.equal(restoredRequest.offset, readingAnchor.offset);
    assert.ok(restoredRequest.requestId > requestIdBeforeHide, "redisplay issues a fresh restore handoff rather than reusing the owner-switch request");
    await act(async () => current().onJumpToBottom?.());
    assert.equal(current().isMessageListFollowing, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "有限FindはSteer受付済みuserのcanonical未着bridgeを正しい履歴seqで数え、保存到着後も1件を維持し、未開始予約と過去閲覧pageをtailへ混ぜない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴Findのglobal ordinalと未保存末尾の一意な合流" }
// fault = "receipt bridgeを検索tailから落とす、列内indexで検索対象へ渡す、保存後に二重計上する、または予約本文やbrowse pageを未保存末尾へ加える"
// observable = "実Find barの件数、column検索tailのhistoryIndexと本文、canonical前後の本文投影"
// observation_boundary = "component-behavior"
// scope = "Auxiliary queue receipt bridge through finite conversation Find"
// lifecycle = "permanent"
// impact = "画面に見える受付済み入力を検索できず、件数と選択位置が不一致になる"
// distinction = "queue投影単体とFind単体はreceipt→column検索tail→有限Findの接合を通らない。小さいJS DOM遷移1件で保存到着順を検証する"
// @end-test-value
test("finite Find counts accepted Steer bridge once before and after canonical arrival", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator", "DOMRect", "Event", "MouseEvent"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  const actEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { value(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { value(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); } });
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const saved = [
    { role: "user" as const, text: "old request", historyIndex: 60 },
    { role: "assistant" as const, text: "old response", historyIndex: 61 },
    { role: "user" as const, text: "current request", historyIndex: 62 },
    { role: "assistant" as const, text: "current response", historyIndex: 63 },
  ];
  let canonical = false;
  let active: SessionTurnQueueReceipt[] = [{
    sessionId: "aux", incarnationId: "inc", id: "steer", requestId: "request", sequence: 1, queuePosition: 1, state: "queued", turnId: null, userMessageSeq: null,
    captured: { request: { userMessage: "needle", clientRequestId: "request", executionOptions: {
      model: "model", reasoningEffort: "medium", approvalMode: "never", codexSandboxMode: "read-only", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
    } }, attachments: [], provider: "codex", workspacePath: "workspace" },
    reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
  }];
  const completed = { ...active[0], state: "completed" as const, inputTurnId: "turn", userMessageSeq: 64 };
  const live: LiveSessionRunState = { sessionId: "aux", threadId: "thread", turnId: "turn", runState: "running", inputAvailable: true,
    assistantText: "", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
  const api: ConversationMessageColumnApi = {
    listSessionTurnQueue: async () => active,
    getSessionTurnQueueReceipt: async () => completed,
    sendQueuedSessionInput: async () => { active = []; return completed; },
    getConversationPage: async () => ({ sessionId: "aux", incarnationId: "inc", startIndex: 0, totalCount: canonical ? 65 : 64, messages: [{ role: "user", text: "browse request", historyIndex: 0 }] }),
    searchConversation: async (_id, request) => ({
      status: "complete", stamp: { generationId: "generation", ownerIdentity: "aux:inc", contentRevision: canonical ? 65 : 64, requestId: request.requestId },
      incarnationId: "inc", messageCount: canonical ? 65 : 64, totalCount: canonical ? 1 : 0, offset: 0,
      items: canonical ? [{ messageIndex: 64, occurrenceIndex: 0 }] : [],
    }),
  };
  let latest: SessionMessageColumnProps | null = null;
  let controls: ConversationColumnControls | undefined;
  function Probe() {
    latest = useConversationMessageColumn({ session: { id: "aux", incarnationId: "inc", provider: "codex", runState: "running",
      messages: canonical ? [...saved, { role: "user", text: "needle", historyIndex: 64 }] : saved, messageCount: canonical ? 65 : 64 },
      baseProps: createBaseProps("aux"), enabled: true, api, messageSourceKind: "auxiliary", liveRun: live, onColumnControls: (value) => { controls = value; } });
    return latest ? React.createElement(SessionMessageColumn, latest) : null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
    const input = dom.window.document.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "needle");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" }); input.dispatchEvent(event);
    });
    const count = () => dom.window.document.querySelector(".session-content-find-count")?.textContent;
    assert.equal(count(), "0/0", "unstarted queue text is not conversation history");
    const steer = Array.from(dom.window.document.querySelectorAll("button")).find((button) => button.textContent === "Steer");
    assert.ok(steer);
    await act(async () => steer.click());
    assert.equal(count(), "1/1");
    assert.equal(latest!.messages.filter((message) => message.text === "needle").length, 1);
    assert.deepEqual(latest!.searchTailMessages?.filter((message) => message.text === "needle").map((message) => message.historyIndex), [64]);
    assert.equal(latest!.searchMessageIndexes?.[latest!.messages.findIndex((message) => message.text === "needle")], 64);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Close find']")!.click());
    await act(async () => controls!.onJumpToMessage("session-aux-0"));
    assert.ok(latest!.messages.some((message) => message.text === "browse request"));
    assert.equal(latest!.searchTailMessages?.filter((message) => message.historyIndex === 0).length, 0, "browse window is not appended to tail");
    assert.deepEqual(latest!.searchTailMessages?.filter((message) => message.text === "needle").map((message) => message.historyIndex), [64]);
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
    assert.equal(count(), "1/1");
    canonical = true;
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(count(), "1/1");
    assert.equal(latest!.searchTailMessages?.filter((message) => message.text === "needle").length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
});


// @test-value v2
// kind = "contract"
// claim = "全縮小の意図は未読込の履歴pageにも適用され、個別展開の例外はpage復帰で維持し、別incarnationには持ち越さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 全履歴Messagesの縮小状態" }
// fault = "全縮小を現在pageのkey集合だけへ保存する、page切替で例外を落とす、または別incarnationへ縮小意図を流用する"
// observable = "columnのcollapsedMessageKeysとcontrolsのallMessagesCollapsed"
// observation_boundary = "component-behavior"
// scope = "conversation-global-fold-intent"
// lifecycle = "permanent"
// impact = "長い履歴で全縮小後のpage閲覧と個別展開を同じ会話に限定して維持できる"
// distinction = "既存collapse helper testは有限本文pageを跨ぐowner単位の既定意図を通らない"
// @end-test-value
test("paged column applies all-fold intent across unloaded pages", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id: number) => dom.window.clearTimeout(id) });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const messages = (start: number) => Array.from({ length: 60 }, (_, index) => ({ role: "user" as const, text: `message ${start + index}`, historyIndex: start + index }));
  const tail = messages(140);
  const api: ConversationMessageColumnApi = { getConversationPage: async (sessionId, request) => ({ sessionId, incarnationId: "first", totalCount: 200, startIndex: request?.startIndex ?? 140, messages: messages(request?.startIndex ?? 140) }) };
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls: ConversationColumnControls | undefined;
  const getLatest = () => { assert.ok(latest); return latest; };
  const getControls = () => { assert.ok(controls); return controls; };
  function Probe({ incarnationId }: { incarnationId: string }) {
    latest = useConversationMessageColumn({ session: { id: "main", incarnationId, messages: tail, messageCount: 200 }, baseProps: createBaseProps("main"), enabled: true, api, liveRun: null, onColumnControls: (value) => { controls = value; } });
    return React.createElement("div", { ref: latest?.messageListRef });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Probe, { incarnationId: "first" })));
    await act(async () => getControls().onToggleAllMessageCollapse());
    assert.equal(getControls().allMessagesCollapsed, true);
    await act(async () => getControls().onJumpToMessage("session-main-30"));
    assert.ok(getLatest().collapsedMessageKeys?.has("session-main-30"));
    await act(async () => getLatest().onToggleMessageCollapse?.("session-main-30"));
    assert.equal(getControls().allMessagesCollapsed, false);
    await act(async () => getControls().onJumpToMessage("session-main-150"));
    assert.ok(getLatest().collapsedMessageKeys?.has("session-main-150"));
    await act(async () => getControls().onJumpToMessage("session-main-30"));
    assert.equal(getLatest().collapsedMessageKeys?.has("session-main-30"), false);
    assert.ok(getLatest().collapsedMessageKeys?.has("session-main-31"));
    await act(async () => root.render(React.createElement(Probe, { incarnationId: "second" })));
    assert.equal(getLatest().collapsedMessageKeys?.size, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const value = previous[index]; if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryの予約・送信失敗時の本文は対象会話の画像APIでlocal画像を読み込み、同じ文脈で画像copy menuへ到達し、previewと予約取消操作を保持する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Image Handling; docs/design/desktop-ui.md: 予約は通常のuser bubbleとして表示" }
// fault = "予約・送信失敗行へ画像resolverまたは操作文脈を渡さない、別会話のcontextで読む・copyする、または取得した画像をpreview可能な状態にしない"
// observable = "画像APIとnative menu requestのsessionId・target、表示画像のaltとblob内容、load後のpreview button、予約取消button"
// observation_boundary = "component-behavior"
// scope = "useConversationMessageColumnからSessionMessageColumnと予約・送信失敗時の本文の画像読込・copy menuまでの接合"
// lifecycle = "permanent"
// impact = "実行中に送信した画像付き本文を待機中に確認・copyできなくなる"
// distinction = "画像loader単体とqueue購読単体は会話列から予約・送信失敗行へのresolverとmenu文脈の接続を通らず、型検査では任意propの渡し漏れを検知できない。小さい画像1枚を両ownerと両表示経路で確認する"
// @end-test-value
test("queued images load through their Main or Auxiliary conversation context", async () => {
  for (const { sessionId, source } of ["main", "aux"].flatMap((sessionId) =>
    ["turn-queue", "turn-submission"].map((source) => ({ sessionId, source })))) {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
    const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    dom.window.HTMLElement.prototype.scrollIntoView = function () {};
    const intersection = installIntersectionObserver();
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    const inspected: SessionImageResourceRequest[] = [];
    const menuRequests: SessionFilePreviewImageActionRequest[] = [];
    const imageApi: MarkdownImageApi = {
      async inspectSessionImage(request) {
        inspected.push(request);
        return { sessionId, absolutePath: "C:/workspace/queued.svg", absoluteFilePath: "C:/workspace/queued.svg", name: "queued.svg",
          kind: "svg", byteLength: bytes.byteLength, mimeType: "image/svg+xml", revision: "image-1", modifiedAt: "now", suggestedEncoding: "utf-8" };
      },
      async readSessionImageChunk(request) {
        assert.equal(request.sessionId, sessionId);
        assert.equal(request.target, "./queued.svg");
        return { data: bytes.buffer, offset: 0, nextOffset: bytes.byteLength, totalBytes: bytes.byteLength, done: true, revision: request.expectedRevision };
      },
    };
    Object.defineProperty(dom.window, "withmate", { configurable: true, value: {
      ...imageApi,
      async showSessionFilePreviewImageContextMenu(request: SessionFilePreviewImageActionRequest) {
        menuRequests.push(request);
        return { status: "copied-path" };
      },
    } });
    const queued: SessionTurnQueueReceipt = {
      sessionId, incarnationId: "inc", id: "queued", requestId: "request", sequence: 1, queuePosition: 1, state: "queued", turnId: null, userMessageSeq: null,
      captured: { request: { userMessage: "![queued image](./queued.svg)\n\nnext request", clientRequestId: "request", executionOptions: {
        model: "model", reasoningEffort: "medium", approvalMode: "never", codexSandboxMode: "read-only", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
      } }, attachments: [], provider: "codex", workspacePath: "C:/workspace" },
      reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
    };
    const submissions = new SessionTurnSubmissions();
    if (source === "turn-submission") {
      submissions.start({ sessionId, incarnationId: "inc", requestId: "request",
        userMessage: queued.captured.request.userMessage, historyMessageCount: 0, queuedBehindRun: true, error: "" });
      submissions.fail("request", "Workspace is no longer available.");
    }
    const api: ConversationMessageColumnApi = { listSessionTurnQueue: async () => source === "turn-queue" ? [queued] : [] };
    function View() {
      const props = useConversationMessageColumn({ session: { id: sessionId, incarnationId: "inc", messages: [], runState: "running" },
        baseProps: { ...createBaseProps(sessionId), turnSubmissions: submissions }, messageSourceKind: sessionId === "main" ? "session" : "auxiliary", enabled: true, api, liveRun: null });
      return props ? <SessionMessageColumn {...props} /> : null;
    }
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      await act(async () => root.render(<View />));
      assert.deepEqual(inspected, [{ sessionId, target: "./queued.svg" }]);
      const image = dom.window.document.querySelector<HTMLImageElement>(`[data-message-source="${source}"] img`);
      assert.ok(image);
      assert.equal(image.alt, "queued image");
      assert.match(image.src, /^blob:/);
      assert.equal(await (await fetch(image.src)).text(), new TextDecoder().decode(bytes));
      await act(async () => image.dispatchEvent(new dom.window.Event("load")));
      assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Open image preview: queued image"]')?.disabled, false);
      const rightClick = new dom.window.MouseEvent("contextmenu", { clientX: 42, clientY: 62, bubbles: true, cancelable: true });
      await act(async () => image.dispatchEvent(rightClick));
      assert.equal(rightClick.defaultPrevented, true);
      assert.deepEqual(menuRequests, [{ sessionId, point: { x: 42, y: 62 }, image: { target: "./queued.svg" } }]);
      assert.equal(dom.window.document.querySelector(".message-copy-toast")?.textContent, "Path copied.");
      if (source === "turn-queue") assert.ok(dom.window.document.querySelector('button[aria-label="Cancel queued turn 1"]'));
    } finally {
      await act(async () => root.unmount());
      intersection.restore();
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});

async function mountScrollingConversation(stableAnchor = false) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  const previousAct = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  dom.window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  dom.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const history = (start: number) => Array.from({ length: Math.min(60, 600 - start) }, (_, index) => ({ role: "user" as const, text: `message ${start + index}`, historyIndex: start + index }));
  const tail = history(540);
  const requests: Array<{ id: string; start: number; resolve: (page: ConversationPage) => void; reject: (error: Error) => void }> = [];
  const api: ConversationMessageColumnApi = {
    getConversationPage: (id, request) => new Promise((resolve, reject) => requests.push({ id, start: request?.startIndex ?? 540, resolve, reject })),
    ...(stableAnchor ? { listSessionTurnQueue: async (id: string): Promise<SessionTurnQueueReceipt[]> => [{
      sessionId: id, incarnationId: id, id: "receipt", requestId: "request", sequence: 1, queuePosition: 1,
      state: "running", turnId: "42", userMessageSeq: 540, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
      captured: { request: { clientRequestId: "request", userMessage: "message 540", executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
    }] } : {}),
  };
  const cache = new Map<string, ConversationColumnCache>();
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls: ConversationColumnControls | undefined;
  const column = () => { assert.ok(latest); return latest; };
  const list = () => column().messageListRef.current!;
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: () => (latest?.messages.length ?? 60) * 40 },
    getBoundingClientRect: { configurable: true, value: function (this: HTMLElement) {
      return new dom.window.DOMRect(0, this.classList.contains("session-message-virtual-row") ? Number(this.dataset.index) * 40 - list().scrollTop : 0, 500, this.classList.contains("session-message-virtual-row") ? 40 : 200);
    } },
  });
  function Probe({ id, enabled }: { id: string; enabled: boolean }) {
    latest = useConversationMessageColumn({ session: { id, incarnationId: id, messages: tail, messageCount: 600 }, baseProps: createBaseProps(id), enabled, messageSourceKind: id === "aux" ? "auxiliary" : "session", api, stateCache: cache, liveRun: null, onColumnControls: (value) => { controls = value; } });
    return <div ref={latest?.messageListRef} onScroll={latest?.onMessageListScroll}>{latest?.messages.map((message, index) => <div key={message.historyIndex} className="session-message-virtual-row" data-index={index}>{message.text}</div>)}</div>;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (id = "main", enabled = true) => act(async () => root.render(<Probe id={id} enabled={enabled} />));
  const flush = async () => act(async () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
  const scroll = async (top: number) => {
    await act(async () => {
      list().dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: top <= list().scrollTop ? -1 : 1, bubbles: true }));
      list().scrollTop = top;
      list().dispatchEvent(new dom.window.Event("scroll"));
    });
    await flush();
  };
  const complete = async (request = requests.at(-1)!) => act(async () => request.resolve({ sessionId: request.id, incarnationId: request.id, startIndex: request.start, totalCount: 600, messages: history(request.start) }));
  // This hook fixture consumes the restoration request; actual virtualizer geometry is checked separately.
  const restore = async () => {
    const jump = column().messageJumpRequest;
    assert.ok(jump);
    const index = column().messageKeys!.indexOf(jump.key);
    assert.ok(index >= 0);
    list().scrollTop = index * 40 - (jump.offset ?? 0);
    await act(async () => column().onMessageListLayout?.());
    await flush();
  };
  await render();
  return { column, list, requests, cache, render, flush, scroll, complete, restore,
    jump: async (key: string) => act(async () => { controls!.onJumpToMessage(key); }),
    close: async () => {
      await act(async () => root.unmount()); dom.window.close();
      globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
      (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryはスクロールで古い本文を連続取得し、重複なしの有限範囲と応答到着時の閲覧anchorを保持して新しい本文側と最新追従へ戻れる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Main／Auxiliaryの会話の追加読み込み" }
// fault = "scrollから取得しない、既存本文を失う、本文を重複・無限蓄積する、要求時の古いanchorへ戻す、または過去page末尾を最新と扱う"
// observable = "scroll後のAPI要求、列propsのhistoryIndex列・件数・追従状態、復元requestのkeyとoffset、Messages jump後の追加取得範囲"
// observation_boundary = "component-behavior"
// scope = "実conversation/follow hookと制御されたページAPI・行矩形。実virtualizerの最終描画位置は対象外"
// lifecycle = "permanent"
// impact = "長い会話をスクロールだけで読み返し、現在へ戻る主要導線と保持量を維持する"
// distinction = "既存page testは取得callbackを直接呼ぶためscroll起点の結合を検出できない。小さい2会話fixtureで有限窓と実follow hookを確認する"
// @end-test-value
test("conversation scroll loads bounded history in both directions for Main and Auxiliary", async () => {
  const view = await mountScrollingConversation();
  try {
    for (const id of ["main", "aux"]) {
      await view.render(id);
      await view.flush();
      const initialReads = view.requests.length;
      assert.equal(view.column().messages.length, 60);
      assert.equal(view.column().isMessageListFollowing, true);
      await view.scroll(93);
      assert.equal(view.requests.length, initialReads + 1);
      assert.equal(view.requests.at(-1)?.start, 480);
      await view.scroll(133);
      assert.equal(view.requests.length, initialReads + 1, "scrolls during a request do not duplicate it");
      await view.complete();
      assert.equal(view.column().messages.length, 120);
      assert.deepEqual({ key: view.column().messageJumpRequest?.key, offset: view.column().messageJumpRequest?.offset }, { key: `session-${id}-543`, offset: -13 });
      await view.restore();
      for (const start of [420, 360]) {
        await view.scroll(13);
        assert.equal(view.requests.at(-1)?.start, start);
        await view.complete();
        assert.deepEqual(view.column().messages.map((message) => message.historyIndex), Array.from({ length: 180 }, (_, index) => start + index));
        await view.restore();
      }
      await view.scroll(view.list().scrollHeight - view.list().clientHeight);
      assert.equal(view.requests.at(-1)?.start, 540);
      assert.equal(view.column().isMessageListFollowing, false, "a history-window boundary is not the conversation end");
      await view.complete();
      assert.deepEqual(view.column().messages.map((message) => message.historyIndex), Array.from({ length: 180 }, (_, index) => 420 + index));
      await view.restore();
      await view.scroll(view.list().scrollHeight - view.list().clientHeight);
      assert.equal(view.column().isMessageListFollowing, true);
      assert.equal(view.column().messages[0]?.historyIndex, 540);
      await view.jump(`session-${id}-100`);
      assert.equal(view.requests.at(-1)?.start, 70);
      await view.complete();
      assert.equal(view.column().messageJumpRequest?.key, `session-${id}-100`);
      await view.restore();
      await view.scroll(13);
      assert.equal(view.requests.at(-1)?.start, 10);
      await view.complete();
      assert.deepEqual(view.column().messages.map((message) => message.historyIndex), Array.from({ length: 120 }, (_, index) => 10 + index));
      await view.restore();
      await view.scroll(13);
      assert.equal(view.requests.at(-1)?.start, 0);
      await view.complete();
      assert.deepEqual(view.column().messages.map((message) => message.historyIndex), Array.from({ length: 130 }, (_, index) => index));
      await view.restore();
      const oldestReads = view.requests.length;
      await view.scroll(0);
      assert.equal(view.requests.length, oldestReads, "the oldest boundary does not reload overlapping pages");
    }
  } finally { await view.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryは送信受付に結び付いた保存行を読んでいても古い履歴を取得し、会話切替後に位置を復元する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Main／Auxiliaryの会話の追加読み込み" }
// fault = "表示keyの形式を保存seqと混同し、取得した履歴を破棄するか復帰先を失う"
// observable = "上端scroll後の履歴範囲、anchor keyとoffset、会話再選択時の取得位置"
// observation_boundary = "component-behavior"
// scope = "実conversation hookと受付済み行の表示key、制御されたpage APIと行矩形"
// lifecycle = "permanent"
// impact = "利用者が長い会話を先頭まで読めず、会話切替後に位置を見失う"
// distinction = "通常履歴keyだけのscroll testでは受付済み行の表示keyと保存seqの違いを検出できない"
// @end-test-value
test("conversation paging retains receipt-backed anchors across session switches", async () => {
  const view = await mountScrollingConversation(true);
  try {
    for (const id of ["main", "aux"]) {
      await view.render(id);
      await view.scroll(13);
      assert.equal(view.requests.at(-1)?.start, 480);
      await view.complete();
      assert.equal(view.column().messages[0]?.historyIndex, 480);
      assert.deepEqual({ key: view.column().messageJumpRequest?.key, offset: view.column().messageJumpRequest?.offset }, { key: `turn-submission-${id}-request`, offset: -13 });
      await view.restore();
      await view.render(id === "main" ? "aux" : "main");
      await view.render(id);
      assert.equal(view.requests.at(-1)?.start, 510);
      await view.complete();
      assert.ok(view.column().messageKeys?.includes(`turn-submission-${id}-request`));
      await view.restore();
    }
  } finally { await view.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "履歴の追加取得失敗は既存本文を保持し明示Retryだけで再開し、後続jump・会話切替・非表示後の応答は表示を上書きしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Main／Auxiliaryの会話の追加読み込み" }
// fault = "失敗を自動再試行する、Retryで範囲を置換する、または失効した追加取得を後続操作へ適用する"
// observable = "API要求数、error・loading、historyIndex列、jump key、owner別表示、復帰時の要求範囲"
// observation_boundary = "component-behavior"
// scope = "実conversation hookのscroll取得と遅延応答・Retry・navigation。APIのみ制御しDOMの行矩形を固定する"
// lifecycle = "permanent"
// impact = "通信失敗や操作の競合で閲覧中の会話と位置を失わない"
// distinction = "既存直接page取得testは追加結合のRetryとscroll要求の失効を通らない。制御promiseで待ち時間なく検証する"
// @end-test-value
test("conversation scroll retries preserve history and reject superseded requests", async () => {
  const view = await mountScrollingConversation();
  try {
    await view.scroll(13);
    await act(async () => view.requests[0].reject(new Error("page unavailable")));
    assert.match(view.column().conversationPaging!.error, /page unavailable/);
    assert.equal(view.column().messages[0]?.historyIndex, 540);
    await view.scroll(14);
    assert.equal(view.requests.length, 1);
    await act(async () => { view.column().conversationPaging!.onRetry(); view.column().conversationPaging!.onRetry(); });
    assert.equal(view.requests.length, 2);
    await view.complete();
    assert.equal(view.column().messages.length, 120);
    await view.restore();
    await view.scroll(13);
    const superseded = view.requests.at(-1)!;
    await view.jump("session-main-550");
    await view.complete(superseded);
    assert.equal(view.column().messages[0]?.historyIndex, 480);
    assert.equal(view.column().messageJumpRequest?.key, "session-main-550");
    await view.restore();
    await view.scroll(13);
    const hidden = view.requests.at(-1)!;
    await view.render("main", false);
    await view.render("main", true);
    await view.complete(hidden);
    assert.equal(view.column().messages[0]?.historyIndex, 480);
    await view.restore();
    await view.scroll(13);
    const oldOwner = view.requests.at(-1)!;
    await view.render("aux");
    await view.complete(oldOwner);
    assert.equal(view.column().sessionId, "aux");
    assert.equal(view.column().messages[0]?.historyIndex, 540);
    await view.render("main");
    assert.equal(view.requests.at(-1)?.start, 450, "restore reloads around the visible global anchor");
    await view.complete();
    assert.ok(view.column().messageKeys?.includes("session-main-480"));
  } finally { await view.close(); }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの連続queueはlocal submissionの有無によらず前turnのcanonical未到着中に次turn本文が届いても各応答を保持し、queue receiptが旧turnのrunningまたはturnId未確定のstartingのまま次liveが先着しても異なる表示identityを確保してreceipt追従・canonical合流後まで維持する。startingの旧receiptではterminal nullを挟んでも前turnのidentityを次turnへ流用しない。requestのuser keyと各応答keyはcanonical合流・submission消費後まで維持し、seq未確認のrequestはcanonical先着でも再照会で接続する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信受付の共通反映; docs/design/desktop-ui.md: 確定応答の取得待ち" }
// fault = "次runのlive本文が前応答を置換する、旧receiptと異なるlive turnへ同じ表示keyを割り当てる、user/assistantの順序を崩す、canonical到着で二重化する、またはreceipt解放後に同じ表示行のkeyを差し替える"
// observable = "共有Column propsの本文順序・messageKeys・responsePresentationKey、canonical到着後のsubmission消費、非表示中のpropsからのlive本文除外"
// observation_boundary = "component-behavior"
// scope = "consecutive queued conversation handoff"
// lifecycle = "permanent"
// impact = "連続送信で既読応答を見失い、確定履歴との接続で本文や閲覧位置が揺れる"
// distinction = "既存handoff testは前canonical到着後に次runへ進む。小さい共有hook fixtureでrunningとstarting/nullの旧receiptから次liveが直結またはterminal nullを挟んで先着する配送順と非表示時の投影を確認する。内部refの解放は観測しない"
// @end-test-value
test("conversation column は連続queueの各応答とcanonical行identityを保持する", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const [kind, firstReceiptState, terminalFirst] of [
      ["session", "running", false], ["session", "starting", false],
      ["auxiliary", "running", false], ["auxiliary", "starting", false],
      ["session", "starting", true], ["auxiliary", "starting", true],
    ] as const) {
      const store = new SessionTurnSubmissions();
      let active: SessionTurnQueueReceipt[] = [];
      const terminals = new Map<string, SessionTurnQueueReceipt>();
      let changed: ((id: string) => void) | undefined;
      const api: ConversationMessageColumnApi = {
        listSessionTurnQueue: async () => active,
        getSessionTurnQueueReceipt: async (_id, requestId) => terminals.get(requestId) ?? active.find((receipt) => receipt.requestId === requestId) ?? null,
        onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
      };
      const receipt = (sequence: number): SessionTurnQueueReceipt => ({
        sessionId: kind, incarnationId: "inc", id: `receipt-${sequence}`, requestId: `request-${sequence}`, sequence, queuePosition: sequence, state: "running", turnId: `turn-${sequence}`, userMessageSeq: (sequence - 1) * 2,
        captured: { request: { clientRequestId: `request-${sequence}`, userMessage: `prompt-${sequence}`, executionOptions: { model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "" } }, attachments: [], provider: "codex", workspacePath: "workspace" },
        reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
      });
      let saved: SessionMessageColumnProps["messages"] = [];
      let live: LiveSessionRunState | null = null;
      let enabled = true;
      let latest: SessionMessageColumnProps | null = null;
      const column = () => { assert.ok(latest); return latest; };
      const run = (sequence: number): LiveSessionRunState => ({ sessionId: kind, threadId: "thread", sessionTurnId: `turn-${sequence}`, turnId: `native-turn-${sequence}`, runState: "running", assistantText: `response-${sequence}`, steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null });
      function View() {
        latest = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", messages: saved, runState: live?.runState ?? "idle" }, baseProps: { ...createBaseProps(kind), turnSubmissions: store }, messageSourceKind: kind, enabled, api, liveRun: live });
        return null;
      }
      const render = () => act(async () => root.render(<View key={kind} />));
      await render();
      await act(async () => { store.start({ sessionId: kind, incarnationId: "inc", requestId: "request-1", userMessage: "prompt-1", historyMessageCount: 0, queuedBehindRun: false, error: "" }); });
      assert.equal(column().messages.length, 0, "the in-flight request is not displayed before a matching receipt");
      active = [{ ...receipt(1), state: firstReceiptState,
        turnId: firstReceiptState === "starting" ? null : "turn-1", userMessageSeq: firstReceiptState === "starting" ? null : 0 }]; live = run(1);
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      const firstUserKey = column().messageKeys?.[0];
      const firstResponseKey = column().messageKeys?.[1];
      const firstPresentationKey = column().responsePresentationKey;
      assert.ok(firstUserKey);
      await act(async () => { store.start({ sessionId: kind, incarnationId: "inc", requestId: "request-2", userMessage: "prompt-2", historyMessageCount: 0, queuedBehindRun: true, error: "" }); });
      if (terminalFirst) {
        live = null;
        await render();
        assert.equal(column().responsePresentationKey, firstPresentationKey);
        assert.deepEqual(column().messages.map((message) => message.text), ["prompt-1", "response-1"]);
      }
      live = run(2);
      await render(); // The live ingress advances before the queue snapshot.
      const earlySecondPresentationKey = column().responsePresentationKey;
      assert.notEqual(earlySecondPresentationKey, firstPresentationKey, `${kind}/${firstReceiptState}/terminalFirst=${terminalFirst}: a conflicting live turn cannot inherit the old receipt's response identity`);
      assert.deepEqual(column().messages.map((message) => message.text), ["prompt-1", "response-1", "response-2"]);
      terminals.set("request-1", { ...receipt(1), state: "completed" });
      active = [receipt(2)]; live = run(2);
      await act(async () => {
        changed?.(kind); root.render(<View key={kind} />);
      });
      assert.equal(column().responsePresentationKey, earlySecondPresentationKey, "the new receipt binds the response surface already owned by its live turn");
      assert.deepEqual(column().messages.map((message) => message.text), ["prompt-1", "response-1", "prompt-2", "response-2"]);
      const secondResponseKey = column().messageKeys?.[3];
      assert.equal(column().messageKeys?.[1], firstResponseKey);
      assert.equal(column().pendingResponseMessageKey, secondResponseKey);
      saved = [{ role: "user", text: "prompt-1" }, { role: "assistant", text: "final-1" }];
      await render();
      assert.deepEqual(column().messages.map((message) => message.text), ["prompt-1", "final-1", "prompt-2", "response-2"]);
      assert.equal(column().responsePresentationKey, earlySecondPresentationKey, "the prior canonical response cannot change the new turn's presentation identity");
      assert.equal(column().messageKeys?.[0], firstUserKey);
      assert.equal(column().messageKeys?.[1], firstResponseKey);
      assert.deepEqual(store.getSnapshot().map((submission) => submission.requestId), ["request-2"]);
      saved = [...saved, { role: "user", text: "prompt-2" }, { role: "assistant", text: "final-2" }];
      terminals.set("request-2", { ...receipt(2), state: "completed" }); active = []; live = null;
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.deepEqual(column().messages.map((message) => message.text), ["prompt-1", "final-1", "prompt-2", "final-2"]);
      assert.equal(column().messageKeys?.[0], firstUserKey);
      assert.equal(column().messageKeys?.[1], firstResponseKey);
      assert.equal(column().messageKeys?.[3], secondResponseKey);
      assert.equal(column().responsePresentationKey, earlySecondPresentationKey, "the current canonical response keeps the live turn's presentation identity");
      assert.equal(store.getSnapshot().length, 0);
      const startingThird = { ...receipt(3), state: "starting" as const, userMessageSeq: null };
      active = [startingThird];
      await act(async () => {
        store.start({ sessionId: kind, incarnationId: "inc", requestId: "request-3", userMessage: "prompt-3", historyMessageCount: 4, queuedBehindRun: false, error: "" });
        store.accept(startingThird); changed?.(kind);
      });
      terminals.set("request-3", { ...receipt(3), state: "completed" }); active = [];
      saved = [...saved, { role: "user", text: "prompt-3" }, { role: "assistant", text: "final-3" }];
      await render(); // No queue notification accompanies this canonical-first delivery.
      assert.deepEqual(column().messages.map((message) => message.text), ["prompt-1", "final-1", "prompt-2", "final-2", "prompt-3", "final-3"]);
      assert.equal(store.getSnapshot().length, 0);
      active = [receipt(4)]; live = run(4);
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      const fourthResponseKey = column().messageKeys?.at(-1);
      terminals.set("request-4", { ...receipt(4), state: "completed" });
      active = [receipt(5)]; live = run(5);
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.deepEqual(column().messages.slice(-4).map((message) => message.text), ["prompt-4", "response-4", "prompt-5", "response-5"], "existing queue turns have no local submission after reopening");
      assert.equal(column().messageKeys?.at(-3), fourthResponseKey);
      saved = [...saved, { role: "user", text: "prompt-4" }, { role: "assistant", text: "final-4" }];
      await render();
      assert.deepEqual(column().messages.slice(-4).map((message) => message.text), ["prompt-4", "final-4", "prompt-5", "response-5"]);
      assert.equal(column().messageKeys?.at(-3), fourthResponseKey);
      enabled = false; saved = []; live = null;
      await render();
      assert.deepEqual(column().messages, [], "hidden columns release unsaved live bodies");
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの取消要求と終了待ちは保存runStateがidleでも同じ応答identityと受信済み本文を維持し、停止通知で待機indicatorを終える"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Main／Auxiliaryの取消click直後からのbusyと停止確定までの応答保持" }
// fault = "保存idleで停止待ちindicatorを消す、取消中に本文または応答keyを失う、または停止通知後もrunningを保持する"
// observable = "共有Column propsのisRunning、pendingRunIndicatorAnnouncement、本文、responsePresentationKey"
// observation_boundary = "consumer"
// scope = "Main/Aux cancel response surface lifetime"
// lifecycle = "permanent"
// impact = "取消で読んでいた応答を見失い、処理が停止済みか終了待ちか分からなくなる"
// distinction = "取消buttonのWindow testは本文bridgeの保持とAuxのannouncementを検査しない。小さいcolumn consumerで保存idleとlive終了待ちの配送順を固定する"
// @end-test-value
test("conversation column はMain/Auxの取消終了待ちで応答面を保持する", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) {
      let requested = false;
      const api: ConversationMessageColumnApi = {};
      const messages: SessionMessageColumnProps["messages"] = [{ role: "user", text: "prompt" }];
      let live: LiveSessionRunState | null = { sessionId: kind, threadId: "thread", turnId: "turn", runState: "running", assistantText: "received response", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
      let latest: SessionMessageColumnProps | null = null;
      const column = () => { assert.ok(latest); return latest; };
      function View() {
        latest = useConversationMessageColumn({ session: { id: kind, incarnationId: "inc", runState: "idle", messages },
          baseProps: { ...createBaseProps(kind), pendingCancelSessionIds: new Set(requested ? [kind] : ["other"]) }, messageSourceKind: kind, enabled: true, api, liveRun: live });
        return null;
      }
      const render = () => act(async () => root.render(<View key={kind} />));
      await render();
      const key = column().responsePresentationKey;
      assert.ok(key);
      requested = true; await render();
      assert.equal(column().isRunning, true);
      assert.equal(column().pendingRunIndicatorAnnouncement, "Canceling run");
      assert.equal(column().messages.at(-1)?.text, "received response");
      assert.equal(column().responsePresentationKey, key);
      requested = false;
      live = { ...live!, runState: "idle", cancellationState: "terminating", assistantText: "" };
      await render();
      assert.equal(column().isRunning, true, "saved idle is not an authoritative stop while termination is pending");
      assert.equal(column().pendingRunIndicatorAnnouncement, "Waiting for the run to stop");
      assert.equal(column().messages.at(-1)?.text, "received response");
      assert.equal(column().responsePresentationKey, key);
      live = null; await render();
      assert.equal(column().isRunning, false);
      assert.equal(column().messages.at(-1)?.text, "received response", "canonical handoff retains the body after confirmed stop");
      assert.equal(column().responsePresentationKey, key);
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxiliaryの先頭queuedとtail間の移動は対象focusを維持し、開始競合の遅延再取得でcontrolが消えた場合は会話一覧へ退避する。別controlへ移したfocusは奪わない"
// oracle = { type = "contract", ref = "Issue #912: 上下操作後も対象focusを保持する採用方針" }
// fault = "本文とtailの再mountや開始競合後のcontrol消失でfocusを失う、または遅い応答が利用者の次操作からfocusを奪う"
// observable = "実columnのreceipt本文順、移動前buttonの切断、activeElementのreceipt所属と方向"
// observation_boundary = "consumer"
// scope = "queue reorder across virtualized head and queue tail"
// lifecycle = "permanent"
// impact = "待機中の会話でもkeyboardで対象を見失わず並べ替えを継続できる"
// distinction = "全tail row fixtureでは別subtree間の再mountと同じ先頭receiptのcontrolのみ消失を再現できない。実columnの2件でACKと再取得を分けて確認する"
// @end-test-value
test("queue move retains focus across the active queued head and tail", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get: () => 600 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get: () => 800 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 600 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { get: () => 800 });
  const intersection = installIntersectionObserver();
  let items: SessionTurnQueueReceipt[] = [];
  let finish!: () => void;
  let conflict = false;
  let readGate: Promise<void> | null = null;
  let finishRead!: () => void;
  const api: ConversationMessageColumnApi = {
    listSessionTurnQueue: async () => { await readGate; return items; },
    reorderQueuedSessionTurns: async (_id, request) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      if (conflict) {
        items = items.map((item, index) => index === 0 ? { ...item, state: "starting" } : item);
        readGate = new Promise<void>((resolve) => { finishRead = resolve; });
        return { outcome: "conflict", receipts: items };
      }
      items = request.queuedIds.map((id, index) => ({ ...items.find((item) => item.id === id)!, queuePosition: index + 1 }));
      return { outcome: "reordered", receipts: items };
    },
  };
  function View({ id }: { id: string }) {
    const props = useConversationMessageColumn({ session: { id, incarnationId: "inc", messages: [], runState: "idle" }, baseProps: createBaseProps(id), enabled: true, api, liveRun: null, messageSourceKind: id === "aux" ? "auxiliary" : "session" });
    return <><button id="outside">Other control</button>{props ? <SessionMessageColumn {...props} /> : null}</>;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const button = (position: number, direction: string) => dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="Move queued turn ${position} ${direction}"]`)!;
  const active = () => dom.window.document.activeElement;
  try {
    for (const id of ["main", "aux"]) {
      conflict = false;
      const session = buildNewSession({ taskTitle: "Queue", workspaceLabel: "workspace", workspacePath: "C:/workspace", branch: "main", characterId: "character", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request" });
      items = ["A", "B"].map((item, index) => ({ sessionId: id, incarnationId: "inc", id: item, requestId: item, sequence: index + 1, queuePosition: index + 1, state: "queued", captured: { request: { clientRequestId: item, userMessage: `Queued ${item}`, executionOptions: captureSessionExecutionOptions(session) }, attachments: [], provider: "codex", workspacePath: "workspace" }, turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now" }));
      await act(async () => root.render(<View key={id} id={id} />));
      const original = button(2, "up");
      original.focus();
      await act(async () => original.click());
      await act(async () => finish());
      assert.equal(original.isConnected, false, "the head and tail are different component subtrees");
      assert.equal(active()?.getAttribute("aria-label"), "Queued turn 1 of 2");
      assert.match(active()?.closest("article")?.textContent ?? "", /Queued B/);
      const down = button(1, "down");
      down.focus();
      await act(async () => down.click());
      await act(async () => finish());
      assert.equal(active()?.getAttribute("aria-label"), "Queued turn 2 of 2");
      assert.match(active()?.closest("article")?.textContent ?? "", /Queued B/);
      await act(async () => { button(2, "up").focus(); button(2, "up").click(); });
      const outside = dom.window.document.getElementById("outside")!;
      outside.focus();
      await act(async () => finish());
      assert.equal(active(), outside, "an explicit focus change wins over late save completion");
      conflict = true;
      for (const focusElsewhere of [false, true]) {
        items = items.map((item) => ({ ...item, state: "queued" }));
        await act(async () => root.render(<View key={`${id}:conflict:${focusElsewhere}`} id={id} />));
        const headMove = button(1, "down");
        const headArticle = headMove.closest("article");
        headMove.focus();
        await act(async () => headMove.click());
        await act(async () => finish());
        assert.equal(active(), headMove, "conflict ACK precedes the queued-to-starting refresh");
        assert.equal(headMove.isConnected, true);
        assert.notEqual(readGate, null);
        const other = dom.window.document.getElementById("outside")!;
        if (focusElsewhere) other.focus();
        await act(async () => { finishRead(); readGate = null; });
        assert.equal(headArticle?.isConnected, true, "the same head remains while only its controls disappear");
        assert.equal(headMove.isConnected, false);
        assert.ok(button(1, "up"), "remaining queued turn controls are still present");
        assert.equal(active(), focusElsewhere ? other : dom.window.document.querySelector(".session-message-list"));
      }
    }
  } finally {
    await act(async () => root.unmount());
    intersection.restore();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "保存済み・実行中の送信全文はMain/Auxiliaryそれぞれの会話のhandlerと画像・HTML・PDF contextを使い、宛先へ切り替えない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/930" }
// fault = "送信行へMarkdown contextを渡さない、別会話または宛先のSessionで資源を読む、または全文中の資源を欠落させる"
// observable = "送信行のlink click、画像inspect/read・HTML読取/mount・PDF inspect/readのSession IDとtarget、画像DOMと全文"
// observation_boundary = "consumer"
// scope = "SessionMessageColumnから保存済み/live SentDeliveryRowと共有Markdown資源loaderへの接続"
// lifecycle = "permanent"
// impact = "Session間の依頼・報告に添えた資料と成果物を送信履歴から確認できなくなる"
// distinction = "通常会話の画像・HTML/PDF単体testは送信行へのoptional propsの渡し漏れを検出しない。小さい資源を4つの表示経路で確認する"
// @end-test-value
test("sent deliveries render full content with the source conversation file context", async () => {
  for (const sessionId of ["sender-main", "sender-aux"]) for (const saved of [true, false]) {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
    const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node, navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      offsetHeight: { get: () => 600 }, offsetWidth: { get: () => 800 },
      clientHeight: { get: () => 600 }, clientWidth: { get: () => 800 },
    });
    const intersection = installIntersectionObserver();
    const imageBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    const requests: Array<{ kind: string; request: { sessionId: string; target: string } }> = [];
    const links: string[] = [];
    const text = `[Source File](src/foo.ts)\n\n![Local Diagram](docs/diagram.svg)\n\n${"Saved content. ".repeat(30)}\n\nvisualize{"path":"C:/workspace/docs/report.html"}\n\nvisualize{"path":"C:/workspace/docs/report.pdf"}`;
    const origin = { kind: "session", actorKind: sessionId === "sender-main" ? "main" : "auxiliary", actorSessionId: sessionId,
      actorMainSessionId: "sender-main", actorIncarnationId: "source-inc", actorTurnId: "42", operation: "send",
      targetSessionId: "recipient", targetIncarnationId: "recipient-inc" } as const;
    const items: SentCardFixture[] = [{ receiptId: "outgoing", sequence: 1, sourceTurnId: "42", sourceMessageSeq: saved ? 3 : null,
      target: { kind: "main", sessionId: "recipient", incarnationId: "recipient-inc" }, state: "queued", origin, text }];
    const record = (kind: string, request: { sessionId: string; target: string }) => { requests.push({ kind, request }); };
    Object.defineProperty(dom.window, "withmate", { value: {
      readSessionExecution: async (_owner: string, operation: string, request: unknown) => {
        if (operation === "list_issued_coordinations") return { ok: true, items: [], nextCursor: null };
        const answer = sentInstructionReaderFixture(items, operation, request);
        assert.ok(answer, operation);
        return answer;
      },
      inspectSessionImage: async (request: SessionImageResourceRequest) => {
        record("image-inspect", request);
        return { kind: "svg", byteLength: imageBytes.byteLength, mimeType: "image/svg+xml", revision: "image" };
      },
      readSessionImageChunk: async (request: SessionImageResourceRequest) => {
        record("image-read", request);
        return { data: imageBytes.buffer, offset: 0, nextOffset: imageBytes.byteLength, totalBytes: imageBytes.byteLength, done: true, revision: "image" };
      },
      readSessionHtmlPreview: async (request: { sessionId: string; target: string }) => {
        record("html-read", request); return { html: "<h1>Report</h1>", fileName: "report.html" };
      },
      mountHtmlPreview: async ({ source }: HtmlPreviewMountRequest) => {
        assert.equal(source.kind, "link");
        if (source.kind === "link") record("html-mount", source.request);
        return { url: "withmate-html-preview://test/", partition: "test" };
      },
      disposeHtmlPreview: async () => {},
      subscribeHtmlPreviewEvents: () => () => {},
      inspectSessionPdf: async (request: { sessionId: string; target: string }) => {
        record("pdf-inspect", request); return { byteLength: 5, revision: "pdf" };
      },
      readSessionPdfChunk: async (request: { sessionId: string; target: string }) => {
        record("pdf-read", request); return { data: new Uint8Array(5).buffer, offset: 0, nextOffset: 5, totalBytes: 5, done: true, revision: "pdf" };
      },
    } });
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      await act(async () => root.render(<SessionMessageColumn {...createBaseProps(sessionId)} provider="codex"
        inputReadContext={{ ownerSessionId: "sender-main", target: sessionId === "sender-main"
          ? { kind: "main", sessionId, incarnationId: "source-inc" }
          : { kind: "auxiliary", sessionId, mainSessionId: "sender-main", mainIncarnationId: "main-inc", incarnationId: "source-inc" } }}
        liveWithMateTurnId={saved ? undefined : "42"} messages={saved ? [{ role: "assistant", text: "Result", historyIndex: 3 }] : [{ role: "user", text: "Request", historyIndex: 2 }]}
        messageKeys={saved ? ["result"] : ["request"]} onOpenPath={(target) => links.push(target)} />));
      const row = dom.window.document.querySelector<HTMLElement>(".session-outbound")!;
      assert.ok(row, `${sessionId} ${saved ? "saved" : "live"}`);
      const image = row.querySelector<HTMLImageElement>('img[alt="Local Diagram"]');
      assert.ok(image); assert.match(image.src, /^blob:/);
      assert.equal(await (await fetch(image.src)).text(), new TextDecoder().decode(imageBytes));
      await act(async () => row.querySelector<HTMLAnchorElement>('a[href="src/foo.ts"]')!.click());
      assert.deepEqual(links, ["src/foo.ts"]);
      assert.deepEqual(requests.map(({ kind, request }) => [kind, request.sessionId, request.target]).sort(), [
        ["image-inspect", sessionId, "docs/diagram.svg"], ["image-read", sessionId, "docs/diagram.svg"],
        ["html-read", sessionId, "C:/workspace/docs/report.html"], ["pdf-inspect", sessionId, "C:/workspace/docs/report.pdf"],
        ["html-mount", sessionId, "C:/workspace/docs/report.html"], ["pdf-read", sessionId, "C:/workspace/docs/report.pdf"],
      ].sort());
      assert.ok(row.querySelector("iframe"));
      assert.equal(row.querySelector('[role="alert"]'), null);
    } finally {
      await act(async () => root.unmount()); intersection.restore(); dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/Auxの新旧通知は問いで相談を識別でき、異なる当時本文を開閉なしで読み、通常JSONと保存した発言者を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#turn-input-details" }
// fault = "受信本文に通知JSONを表示する、問いと本文を二重に並べる/異なる本文を隠す、通常JSONを相談として解釈する、または再読込で送信者を取り違える"
// observable = "本番Columnとqueue行のMarkdown本文、Character名、送信元リンク、正確なmessageSeqとtargetへの読取"
// observation_boundary = "consumer"
// scope = "SessionMessageColumn、SessionTurnQueueRowと共通execution読取のrenderer接続。IPCはfixture"
// lifecycle = "permanent"
// impact = "相談と回答を会話として読めず、誰から届いた判断かを取り違える"
// distinction = "SQLite testは実際のMarkdown consumerへの本文渡しと保存済み会話の非同期再表示を検証しない。小さいDOMで両ownerと新旧形式を比較する"
// @end-test-value
test("received Coordination text stays authored across queue and saved Main/Aux conversations", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, { offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["main", "auxiliary"] as const) for (const operation of ["create", "answer"]) {
      const target = kind === "main" ? { kind, sessionId: "receiver", incarnationId: "inc" } : { kind, sessionId: "receiver", incarnationId: "inc", mainSessionId: "parent", mainIncarnationId: "parent-inc" };
      const context = { ownerSessionId: "parent", target };
      const actor = { kind: "main" as const, sessionId: "sender", incarnationId: "sender-inc", turnId: "1" };
      const origin = { kind: "session" as const, operation: "send" as const, actorKind: actor.kind, actorSessionId: actor.sessionId, actorIncarnationId: actor.incarnationId, actorTurnId: actor.turnId, targetSessionId: target.sessionId, targetIncarnationId: target.incarnationId,
        actorSnapshot: { sessionTitle: "Saved Sender Session", character: { id: "sender-character", name: "Saved Sender", iconPath: "" } }, targetSnapshot: { sessionTitle: "Receiver", character: { id: "receiver-character", name: "Receiver", iconPath: "" } } };
      const notification = { coordinationId: "consultation", kind: "blocker" as const, consultation: "Which **approach**?", actor, operation, answer: { id: "answer", revision: 1, actor, body: "Use the **agreed approach**.", selectedChoices: [], createdAt: "now" }, state: "open" as const, withdrawalReason: null };
      const text = operation === "answer" ? notification.answer.body : notification.consultation;
      const raw = JSON.stringify(notification);
      const base = buildNewSession({ id: "receiver", taskTitle: "Receiver", workspaceLabel: "Workspace", workspacePath: "C:/workspace", branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "", characterThemeColors: { main: "#123456", sub: "#234567" }, approvalMode: "on-request" });
      const captured: SessionTurnQueueCapturedInput = { request: { clientRequestId: "request", userMessage: text, executionOptions: captureSessionExecutionOptions(base) }, attachments: [], provider: "codex", workspacePath: base.workspacePath, origin,
        coordination: { id: "consultation", operation, actor, answerId: "answer", answerRevision: 1, notification } };
      const receipt: SessionTurnQueueReceipt = { id: "receipt", sessionId: "receiver", incarnationId: "inc", requestId: "request", sequence: 1, queuePosition: 1, state: "queued", turnId: null, userMessageSeq: null, releasedAt: null, reason: null, createdAt: "now", updatedAt: "now", captured };
      for (const legacy of [false, true]) {
        const input = structuredClone(captured);
        if (legacy) { input.request.userMessage = raw; delete input.coordination!.notification; }
        await act(async () => root.render(<SessionTurnQueueRow inputReadContext={context} receipt={{ ...receipt, captured: input }} character={{ name: "Receiver", iconPath: "" }} busy={false} onCancel={() => {}} />));
        assert.match(dom.window.document.querySelector(".coordination-notice-link")?.textContent ?? "", /Which approach\?/);
        const content = dom.window.document.querySelector<HTMLElement>('[aria-label="Received Content"]')!;
        if (operation === "answer") {
          assert.equal(content.closest("details:not([open])"), null);
          assert.equal(content.querySelector(".rich-text")?.textContent, "Use the agreed approach.");
        }
      }
      const requests: number[] = [];
      Object.defineProperty(dom.window, "withmate", { configurable: true, value: { readSessionExecution: async (_owner: string, op: string, request: { target: unknown; messageSeq: number }) => {
        if (op === "list_sent_instruction_cards") return { ok: true, items: [], cursors: { receipts: null, steers: null } };
        if (op === "list_issued_coordinations") return { ok: true, items: [], nextCursor: null };
        assert.deepEqual(request.target, target); requests.push(request.messageSeq);
        return { ok: true, origin: request.messageSeq === 3 ? origin : null, ...(request.messageSeq === 3 ? { coordination: { id: "consultation", text, consultation: notification.consultation } } : {}) };
      } } });
      await act(async () => root.render(<SessionMessageColumn key={`${kind}-${operation}`} {...createBaseProps("receiver")} inputReadContext={context}
        messages={[{ role: "user", text: raw, historyIndex: 3 }, { role: "user", text: raw, historyIndex: 4 }]} messageKeys={["received", "ordinary"]} />));
      const rows = [...dom.window.document.querySelectorAll("[data-message-body]")];
      assert.match(rows[0]?.querySelector(".coordination-notice-link")?.textContent ?? "", /Which approach\?/);
      if (operation === "answer") assert.equal(rows[0]?.querySelector('[aria-label="Received Content"]')?.closest("details:not([open])"), null);
      assert.equal(rows[0]?.querySelector('[aria-label="Received Content"] .rich-text')?.textContent, operation === "answer" ? "Use the agreed approach." : undefined);
      assert.equal(rows[1]?.textContent, raw.replaceAll("**", ""));
      assert.match(dom.window.document.querySelector(".message-row.session-origin")?.textContent ?? "", /Saved Sender.*Saved Sender Session/);
      assert.deepEqual(requests.sort(), [3, 4]);
    }
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "複数宛先および同一宛先への複数送信は、実行中と保存後の対応するassistant本文内に、それぞれ一度ずつ順に表示する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/953" }
// fault = "宛先ごとに複数receiptをまとめる、送信カードを別行や本文末尾へ移す、本文との順を変える、または重複表示する"
// observable = "実行中と保存済みのassistant行の本文・各宛先の送信カードのDOM順と件数"
// observation_boundary = "consumer"
// scope = "SessionMessageColumnの送信位置投影"
// lifecycle = "permanent"
// impact = "利用者が同一Turnの発言と宛先付き送信の関係を見失う"
// distinction = "Markdown単体とreceipt保存のテストは会話列への位置付きカードの接続を検証しない"
// @end-test-value
test("multiple sent cards retain recipients and order within live and saved responses", async () => {
  for (const saved of [false, true]) {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
    const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node, navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    Object.defineProperties(dom.window.HTMLElement.prototype, { offsetHeight: { get: () => 600 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 600 }, clientWidth: { get: () => 800 } });
    const intersection = installIntersectionObserver();
    const origin = { kind: "session", actorKind: "main", actorSessionId: "sender", actorIncarnationId: "source-inc", actorTurnId: "42", operation: "send", targetIncarnationId: "recipient-inc" } as const;
    const items: SentCardFixture[] = ([["a", "FIRST", 6], ["b", "SECOND", 6], ["a", "THIRD", 14]] as const).map(([target, text, position], index) => ({ receiptId: `outgoing-${index}`, sequence: index + 1, sourceTurnId: "42", sourceMessageSeq: saved ? 1 : null, sourceDisplayPosition: position, target: { kind: "main", sessionId: target, incarnationId: "recipient-inc" }, state: "queued", origin: { ...origin, targetSessionId: target, targetSnapshot: { sessionTitle: `Session ${target}`, character: { id: target, name: `Mate ${target}`, iconPath: "" } } }, text }));
    Object.defineProperty(dom.window, "withmate", { value: { readSessionExecution: async (_owner: string, operation: string, request: unknown) =>
      sentInstructionReaderFixture(items, operation, request) ?? { ok: true, items: [], nextCursor: null } } });
    const root = createRoot(dom.window.document.getElementById("root")!);
    try {
      await act(async () => root.render(<SessionMessageColumn {...createBaseProps("sender")} provider="codex" isRunning={!saved} liveWithMateTurnId={saved ? undefined : "42"} liveRunAssistantText={saved ? "" : "BEFORE\n\nMIDDLE\n\nAFTER"} hasLiveRunAssistantText={!saved}
        inputReadContext={{ ownerSessionId: "sender", target: { kind: "main", sessionId: "sender", incarnationId: "source-inc" } }} messages={saved ? [{ role: "assistant", text: "BEFORE\n\nMIDDLE\n\nAFTER", historyIndex: 1 }] : [{ role: "user", text: "Request", historyIndex: 0 }]} messageKeys={saved ? ["result"] : ["request"]} />));
      const row = dom.window.document.querySelector(".message-row.assistant");
      assert.ok(row, saved ? "saved" : "live");
      const cards = [...row.querySelectorAll(".session-outbound-inline")];
      assert.equal(cards.length, 3);
      assert.deepEqual(cards.map((card) => card.getAttribute("aria-label")), ["Sent Message: Session a", "Sent Message: Session b", "Sent Message: Session a"]);
      assert.equal(dom.window.document.querySelectorAll('.session-outbound-inline, article.session-outbound').length, 3);
      assert.match(row.textContent ?? "", /BEFORE[\s\S]*FIRST[\s\S]*SECOND[\s\S]*MIDDLE[\s\S]*THIRD[\s\S]*AFTER/);
    } finally {
      await act(async () => root.unmount()); intersection.restore(); dom.window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Mainを新しく開くと既定のALLで同じSessionの連続ページを読む。同じ窓で手動選択した初期・個別枠は履歴revisionが変わっても維持し、個別枠からALLへ戻ると閲覧中だった過去ページに復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher" }
// fault = "新しい窓で初期枠を選ぶ、履歴revisionの変更で手動選択をリセットする、ALLで絞込や別Sessionを使う、または個別枠を往復すると閲覧中pageを失う"
// observable = "初回・再マウント時のALL、履歴revision変更後の選択と表示seq、過去pageの未絞込request、復帰の取得待ちと取得後の表示seq"
// observation_boundary = "component-behavior"
// scope = "Mainの選択hookから会話列への接合。保存readのみfixture"
// lifecycle = "permanent"
// impact = "複数相手と未分類の流れを通して読めない、または個別を確認するたびに閲覧位置を失う"
// distinction = "既存ページング単体のテストは、初期・全体・相手別を同じMainで切り替えるときの絞込と閲覧範囲の分離を検証しない"
// @end-test-value
test("Main All shows contiguous own history and resumes its older page after a peer switch", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const main = { kind: "main" as const, sessionId: "main", incarnationId: "main-inc" };
  const child = (id: string, messageIndexes: number[]) => ({
    target: { kind: "main" as const, sessionId: id, incarnationId: id + "-inc" }, title: id,
    messageIndexes, inboundTurnIds: [], sentMessageIndexes: [],
  });
  const [a, b] = [child("A", [0, 1, 68, 69]), child("B", [2, 3, 70, 71])];
  const saved = Array.from({ length: 130 }, (_, historyIndex) => ({
    role: historyIndex % 2 === 0 ? "user" as const : "assistant" as const, text: `saved ${historyIndex}`, historyIndex,
  }));
  const initial = saved.map(({ historyIndex }) => historyIndex).filter((seq) => !a.messageIndexes.includes(seq) && !b.messageIndexes.includes(seq));
  const tail = saved.slice(-CONVERSATION_PAGE_SIZE);
  const requests: { id: string; request?: ConversationPageRequest }[] = [];
  let suspendRestore = false;
  let releaseRestore: (() => void) | undefined;
  const api: ConversationMessageColumnApi = {
    async getConversationPage(id, request) {
      requests.push({ id, request });
      const startIndex = request?.startIndex ?? saved.length - tail.length;
      const messages = request?.messageIndexes?.map((seq) => saved[seq]) ?? saved.slice(startIndex, startIndex + tail.length);
      if (suspendRestore) await new Promise<void>((resolve) => { releaseRestore = resolve; });
      return { sessionId: id, incarnationId: main.incarnationId, totalCount: saved.length, startIndex, messages };
    },
  };
  Object.defineProperty(dom.window, "withmate", { value: { ...api, readSessionExecution: async () =>
    ({ ok: true, initialMessageIndexes: initial, children: [a, b] }) } });
  const context = { ownerSessionId: main.sessionId, target: main };
  let threads: ReturnType<typeof useMainConversationThreads>;
  let column: ReturnType<typeof useConversationMessageColumn>;
  let controls: ConversationColumnControls;
  function Probe({ revision = "" }: { revision?: string }) {
    threads = useMainConversationThreads(context, true, revision, () => controls?.captureReadingPosition?.());
    column = useConversationMessageColumn({
      session: { id: main.sessionId, incarnationId: main.incarnationId, messageCount: saved.length, messages: tail },
      baseProps: createBaseProps(main.sessionId), api, enabled: true, liveRun: null,
      frame: threads.frame, showAllThreads: threads.showAllThreads, onColumnControls: (next) => { controls = next; },
    });
    return <div ref={column?.messageListRef} />;
  }
  const indexes = () => column?.messages.map((message) => message.historyIndex);
  const select = (id: string) => act(async () => threads.select(id));
  try {
    await act(async () => root.render(<Probe />));
    assert.equal(threads!.selectedId, ALL_MAIN_THREADS_ID);
    assert.deepEqual(indexes(), tail.map(({ historyIndex }) => historyIndex));
    await act(async () => controls.onJumpToMessage("session-main-10"));
    const past = requests.at(-1);
    const start = past?.request?.startIndex;
    assert.equal(past?.id, "main");
    assert.equal(past?.request?.messageIndexes, undefined);
    assert.ok(start !== undefined && start <= 10);
    const olderPage = saved.slice(start, start + tail.length).map(({ historyIndex }) => historyIndex);
    assert.ok(olderPage.includes(10));
    assert.deepEqual(indexes(), olderPage);
    await select(conversationPeerKey(b.target));
    assert.deepEqual(indexes(), b.messageIndexes);
    await act(async () => root.render(<Probe revision="peer-update" />));
    assert.equal(threads!.selectedId, conversationPeerKey(b.target));
    assert.deepEqual(indexes(), b.messageIndexes);
    suspendRestore = true;
    await select(ALL_MAIN_THREADS_ID);
    assert.ok(releaseRestore, "All requested its older page after switching back");
    assert.deepEqual(indexes(), [], "the tail must not become a reading anchor while restoring an older page");
    suspendRestore = false;
    await act(async () => releaseRestore?.());
    assert.deepEqual(indexes(), olderPage);
    await select("");
    assert.deepEqual(indexes(), initial.slice(-tail.length));
    await act(async () => root.render(<Probe revision="initial-update" />));
    assert.equal(threads!.selectedId, "");
    assert.deepEqual(indexes(), initial.slice(-tail.length));
    await act(async () => root.render(<Probe key="reopened" />));
    assert.equal(threads!.selectedId, ALL_MAIN_THREADS_ID);
    assert.deepEqual(indexes(), tail.map(({ historyIndex }) => historyIndex));
    assert.deepEqual([...new Set(requests.map(({ id }) => id))], ["main"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Mainの相手選択は未読→既読・群内の更新順で候補だけが動き、同値や実行状態の変更で順位や選択を不必要に変えない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#main-conversation-switcher" }
// fault = "子Sessionの既読結果の通知を無視する、実行中を優先する、同値を不安定に並べる、または順位が変わった行に選択を移す"
// observable = "子Sessionの既存turn通知後の候補順と選択中ID"
// observation_boundary = "component-behavior"
// scope = "Mainの選択hook。IPC応答と既存turn通知はfixture"
// lifecycle = "permanent"
// impact = "Monitorと異なる優先順位のままになる、または閲覧中の相手を見失う"
// distinction = "比較関数やストレージ単体では子Sessionの更新通知と相手IDの選択保持を検証できない"
// @end-test-value
test("Main peers reorder on child unread notifications without moving the selected identity", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const context = { ownerSessionId: "main", target: { kind: "main" as const, sessionId: "main", incarnationId: "main-inc" } };
  const child = (id: string, lastActivityAt: number, hasUnreadResult: boolean, isProcessing = false) => ({
    target: { kind: "main" as const, sessionId: id, incarnationId: id + "-inc" }, title: id,
    lastActivityAt, hasUnreadResult, isProcessing, messageIndexes: [], inboundTurnIds: [], sentMessageIndexes: [],
  });
  // The persisted input order can differ from ID order when creation times differ.
  let items = [child("A", 100, true), child("B", 220, false, true), child("D", 300, true), child("C", 300, true), child("E", 500, false)];
  let onTurnUpdated: ((id: string) => void) | undefined;
  Object.defineProperty(dom.window, "withmate", { value: {
    getConversationPage: async () => null,
    readSessionExecution: async () => ({ ok: true, initialMessageIndexes: [], children: items }),
    onSessionTurnUpdated: (listener: typeof onTurnUpdated) => { onTurnUpdated = listener; return () => { onTurnUpdated = undefined; }; },
  } });
  let model: ReturnType<typeof useMainConversationThreads>;
  function Probe() {
    model = useMainConversationThreads(context, true, "", () => {});
    return null;
  }
  const order = () => model.children.map(({ title }) => title);
  const id = conversationPeerKey(items[3].target);
  try {
    await act(async () => root.render(<Probe />));
    assert.deepEqual(order(), ["D", "C", "A", "E", "B"]);
    await act(async () => model.select(id));
    assert.equal(model!.selectedId, id);
    items = items.map((item) => item.title === "C" ? { ...item, hasUnreadResult: false } : item);
    assert.ok(onTurnUpdated);
    await act(async () => onTurnUpdated?.("C"));
    assert.deepEqual(order(), ["D", "A", "E", "C", "B"]);
    assert.equal(model!.selectedId, id);
    items = items.map((item) => ({ ...item, isProcessing: !item.isProcessing }));
    await act(async () => onTurnUpdated?.("B"));
    assert.deepEqual(order(), ["D", "A", "E", "C", "B"]);
    assert.equal(model!.selectedId, id);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

function createBaseProps(id: string): SessionMessageColumnProps {
  return {
    sessionId: id,
    character: { id: "character", name: "Mate", iconPath: "", description: "", roleMarkdown: "", notesMarkdown: "", updatedAt: "", themeColors: {} } as SessionMessageColumnProps["character"],
    messages: [],
    messageKeys: [],
    expandedArtifacts: {},
    messageListRef: { current: null },
    isRunning: false,
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "",
    hasLiveRunAssistantText: false,
    liveRunErrorMessage: "",
    isMessageListFollowing: true,
    onMessageListScroll() {},
    onToggleArtifact() {},
    onOpenDiff() {},
    onResolveLiveApproval() {},
    onResolveLiveElicitation() {},
  };
}

// @test-value v2
// kind = "contract"
// claim = "有限Messages一覧は未保存userとassistantを末尾ordinalへ合流し、Bookmark絞込・本文jump・保存確定後の一意性を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 会話列は確定履歴の投影とlive末尾を分離し、保存確定時のmessage key、Bookmark、検索、navigatorを保持する" }
// fault = "未保存末尾を一覧件数から落とす、同identityまたは保存済み行を二重計上する、または過去閲覧中の未保存jumpをbackendへ送る"
// observable = "hook controlsのnavigator page items・offset・totalCount、ColumnのmessageJumpRequestと本文、page API呼出回数"
// observation_boundary = "component-behavior"
// scope = "conversation-navigator-unsaved-tail"
// lifecycle = "permanent"
// impact = "保存を待たず本文に見える送信と応答へMessagesから移動できる"
// distinction = "既存collapse testはbackend有限ordinalと未保存末尾の合流を通らず、型検査では行と総件数の重複を検知できない"
// @end-test-value
test("paged navigator merges unsaved tail with finite ordinals and bookmark filter", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  const previousAct = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const saved = Array.from({ length: 130 }, (_, historyIndex) => ({ role: "user" as const, text: `saved ${historyIndex}`, historyIndex }));
  const tail = [
    ...saved.slice(-60),
    { role: "user" as const, text: "unsaved request", historyIndex: 130 },
    { role: "assistant" as const, text: "unsaved response", historyIndex: 131, isBookmarked: true },
    { role: "user" as const, text: "unsaved request", historyIndex: 130 },
  ];
  let persistedCount = 130;
  let pageReads = 0;
  const api: ConversationMessageColumnApi = {
    getConversationPage: async (sessionId, request) => {
      pageReads += 1;
      const startIndex = request?.startIndex ?? 70;
      return { sessionId, incarnationId: "first", totalCount: persistedCount, startIndex, messages: saved.slice(startIndex, startIndex + 60) };
    },
    listConversationNavigator: async (_sessionId, request) => {
      const items = [...saved, ...tail.slice(60, 62)].slice(0, persistedCount)
        .filter((message) => request.filter === "all" || ("isBookmarked" in message && message.isBookmarked))
        .map((message) => ({ messageIndex: message.historyIndex, role: message.role, preview: message.text, accent: false, isBookmarked: "isBookmarked" in message && message.isBookmarked === true }));
      return { status: "complete", stamp: { generationId: "generation", ownerIdentity: "main:first", contentRevision: persistedCount, requestId: request.requestId }, incarnationId: "first", messageCount: persistedCount, totalCount: items.length, offset: request.offset ?? 0, items: items.slice(request.offset ?? 0, (request.offset ?? 0) + 64) };
    },
  };
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls: ConversationColumnControls | undefined;
  const getLatest = () => { assert.ok(latest); return latest; };
  const getControls = () => { assert.ok(controls); return controls; };
  const getPage = () => { const page = getControls().messageNavigatorPage; assert.ok(page); return page; };
  function Probe() {
    latest = useConversationMessageColumn({ session: { id: "main", incarnationId: "first", messages: tail, messageCount: persistedCount }, baseProps: createBaseProps("main"), enabled: true, navigatorActive: true, api, liveRun: null, onColumnControls: (value) => { controls = value; } });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(getPage().totalCount, 132);
    await act(async () => getPage().onRequestRange(128));
    assert.equal(getPage().offset, 64);
    assert.equal(getPage().items[130 - getPage().offset]?.preview, "unsaved request");
    assert.equal(getPage().items[131 - getPage().offset]?.preview, "unsaved response");
    assert.ok(getPage().items.length <= 192);
    await act(async () => getControls().onJumpToMessage("session-main-3"));
    assert.equal(pageReads, 1);
    await act(async () => getControls().onJumpToMessage("session-main-131"));
    assert.equal(pageReads, 1);
    assert.equal(getLatest().messageJumpRequest?.key, "session-main-131");
    assert.ok(getLatest().messages.some((message) => message.text === "unsaved response"));
    await act(async () => getPage().onFilterChange("bookmarks"));
    assert.equal(getPage().totalCount, 1);
    assert.deepEqual(getPage().items.map((entry) => entry.key), ["session-main-131"]);
    persistedCount = 132;
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(getPage().totalCount, 1);
    assert.deepEqual(getPage().items.map((entry) => entry.key), ["session-main-131"]);
    await act(async () => getPage().onFilterChange("all"));
    await act(async () => getPage().onRequestRange(128));
    assert.equal(getPage().totalCount, 132);
    assert.equal(getPage().items.filter((entry) => entry.key === "session-main-131").length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
    globals.forEach((key, index) => { const value = previous[index]; if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "canonical user未到着の次Turnも現在user後の応答を所有し、本文先行とSteerのuser追記から終端保存まで応答を一度だけ表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Window / pending response所属" }
// fault = "前Turnの完了応答へpendingを付ける、次Turn本文を前応答で隠す、終端で本文を二重化する、またはidle liveを実行中にする"
// observable = "Column propsのuser/assistant順序、pendingResponseMessageKey、messageKeys、isRunning"
// observation_boundary = "component-behavior"
// scope = "conversation-response-owner"
// lifecycle = "permanent"
// impact = "利用者が次の要求の進行と応答を区別できず、完了した要求を実行中と誤認する"
// distinction = "既存projection testは非同期queue受付と更新されない保存済みColumnの組合せを通らず、型検査では到着順を検出できない。小さいJS DOM状態遷移1件で契約を保持する"
// @end-test-value
test("conversation column は保存本文が遅れても次Turnの応答を所有する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  const actEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const oldMessages = [{ role: "user" as const, text: "first" }, { role: "assistant" as const, text: "same response" }];
  let receipts: SessionTurnQueueReceipt[] = [];
  const terminalReceipts = new Map<string, SessionTurnQueueReceipt>();
  let changed: ((id: string) => void) | undefined;
  const api: ConversationMessageColumnApi = {
    listSessionTurnQueue: async () => receipts,
    getSessionTurnQueueReceipt: async (_id, requestId) => terminalReceipts.get(requestId) ?? null,
    onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
  };
  let latest: SessionMessageColumnProps | null = null;
  const column = () => latest!;
  const run = (text: string, turnId: string, runState = "running"): LiveSessionRunState => ({
    sessionId: "aux", threadId: "thread", turnId, runState, assistantText: text,
    steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
  });
  function Probe({ live, saved = oldMessages }: { live: LiveSessionRunState | null; saved?: typeof oldMessages }) {
    latest = useConversationMessageColumn({ session: { id: "aux", incarnationId: "inc", messages: saved, runState: live?.runState ?? "idle" },
      baseProps: createBaseProps("aux"), messageSourceKind: "auxiliary", enabled: true, api, liveRun: live });
    return null;
  }
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(dom.window.document.getElementById("root")!); root.render(React.createElement(Probe, { live: run("same response", "first"), saved: oldMessages.slice(0, 1) })); });
    const oldResponseKey = column().messageKeys?.[1];
    await act(async () => root?.render(React.createElement(Probe, { live: null })));
    await act(async () => root?.render(React.createElement(Probe, { live: run("", "second") })));
    assert.equal(column().pendingResponseMessageKey, null);
    await act(async () => root?.render(React.createElement(Probe, { live: run("same response", "second") })));
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "same response"], "live delta stays visible before the receipt arrives");
    const earlyResponseKey = column().messageKeys?.[2];
    assert.equal(column().pendingResponseMessageKey, earlyResponseKey);
    assert.notEqual(earlyResponseKey, oldResponseKey);
    receipts = [{ sessionId: "aux", incarnationId: "inc", id: "next", requestId: "request", sequence: 2, queuePosition: 2, state: "running", turnId: "2", userMessageSeq: 2,
      captured: { request: { userMessage: "second", clientRequestId: "request", executionOptions: {
        model: "model", reasoningEffort: "medium", approvalMode: "never", codexSandboxMode: "read-only", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
      } }, attachments: [], provider: "codex", workspacePath: "workspace" },
      reason: null, releasedAt: null, createdAt: "now", updatedAt: "now" }];
    await act(async () => changed?.("aux"));
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "second", "same response"]);
    assert.equal(column().pendingResponseMessageKey, earlyResponseKey);
    assert.equal(column().isRunning, true);
    await act(async () => root?.render(React.createElement(Probe, { live: run("same response", "second") })));
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "second", "same response"]);
    const newResponseKey = column().messageKeys?.[3];
    assert.equal(column().pendingResponseMessageKey, newResponseKey);
    assert.notEqual(newResponseKey, oldResponseKey);
    assert.equal(newResponseKey, earlyResponseKey);
    const saved = [...oldMessages, { role: "user" as const, text: "second" }, { role: "assistant" as const, text: "saved response" }];
    await act(async () => root?.render(React.createElement(Probe, { live: run("same response", "second", "idle"), saved })));
    assert.equal(column().isRunning, false);
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "second", "saved response"]);
    assert.equal(column().messageKeys?.[3], newResponseKey);
    await act(async () => root?.render(React.createElement(Probe, { live: null, saved })));
    assert.equal(column().isRunning, false);
    assert.equal(column().messageKeys?.[3], newResponseKey);
    assert.equal(column().messages.length, 4);
    const thirdUser = [...saved, { role: "user" as const, text: "third" }];
    terminalReceipts.set(receipts[0].requestId, { ...receipts[0], state: "completed" });
    receipts = [{ ...receipts[0], id: "third", requestId: "third-request", sequence: 3, queuePosition: 3, turnId: "3", userMessageSeq: 4,
      captured: { ...receipts[0].captured, request: { ...receipts[0].captured.request, clientRequestId: "third-request", userMessage: "third" } } }];
    await act(async () => { changed?.("aux"); root?.render(React.createElement(Probe, { live: run("third response", "third"), saved: thirdUser })); });
    assert.equal(column().pendingResponseMessageKey, column().messageKeys?.[5]);
    const inputReceipt: SessionTurnQueueReceipt = { ...receipts[0], id: "steer", requestId: "steer-request", sequence: 4, queuePosition: 4, state: "queued", turnId: null, userMessageSeq: null,
      captured: { ...receipts[0].captured, request: { ...receipts[0].captured.request, clientRequestId: "steer-request", userMessage: "steer" } } };
    receipts = [...receipts, inputReceipt];
    await act(async () => changed?.("aux"));
    terminalReceipts.set(inputReceipt.requestId, { ...inputReceipt, state: "completed", inputTurnId: "third", userMessageSeq: 5 });
    receipts = receipts.filter((receipt) => receipt.id !== inputReceipt.id);
    await act(async () => { changed?.("aux"); root?.render(React.createElement(Probe, { live: run("steered response", "third"), saved: thirdUser })); });
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "second", "saved response", "third", "steer", "steered response"]);
    const acceptedSteerResponseKey = column().messageKeys?.[6];
    assert.equal(column().pendingResponseMessageKey, acceptedSteerResponseKey);
    const steeredUser = [...thirdUser, { role: "user" as const, text: "steer" }];
    await act(async () => root?.render(React.createElement(Probe, { live: run("steered response", "third"), saved: steeredUser })));
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "second", "saved response", "third", "steer", "steered response"]);
    const steeredResponseKey = column().messageKeys?.[6];
    assert.equal(steeredResponseKey, acceptedSteerResponseKey);
    assert.equal(column().pendingResponseMessageKey, steeredResponseKey);
    const steeredSaved = [...steeredUser, { role: "assistant" as const, text: "final steered response" }];
    await act(async () => root?.render(React.createElement(Probe, { live: run("steered response", "third", "idle"), saved: steeredSaved })));
    assert.equal(column().isRunning, false);
    assert.equal(column().messageKeys?.[6], steeredResponseKey);
    assert.deepEqual(column().messages.map((message) => message.text), ["first", "same response", "second", "saved response", "third", "steer", "final steered response"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "過去pageの閲覧は60件とglobal位置を維持し、live更新を混入せず、会話切替後の遅いpage応答を破棄し、旧会話のlive本文をcacheへ保持しない"
// oracle = { type = "contract", ref = "Issue #781: bounded conversation pages" }
// fault = "過去pageへliveをappendする、global keyをlocal位置へ戻す、旧会話のpageを新会話へ適用する、または非表示会話cacheへlive本文を保持する"
// observable = "列propsのmessage件数・key・本文、page APIのstartIndex、旧会話cacheのliveRunと本文なしbridge"
// observation_boundary = "component-behavior"
// scope = "conversation-page-ownership"
// lifecycle = "permanent"
// impact = "過去履歴を読みながら実行を続け、会話を切替えても別会話本文を表示しない"
// distinction = "storage testはrendererのlive投影・選択切替との応答競合を通らない"
// @end-test-value
test("conversation pages は過去閲覧と会話ownerを保持する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id: number) => dom.window.clearTimeout(id) });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const messages = (start: number) => Array.from({ length: 60 }, (_, index) => ({ role: "user" as const, text: `message ${start + index}`, historyIndex: start + index }));
  let resolvePage: ((page: NonNullable<Awaited<ReturnType<NonNullable<ConversationMessageColumnApi["getConversationPage"]>>>>) => void) | undefined;
  const requests: number[] = [];
  const cache = new Map<string, ConversationColumnCache>();
  const api: ConversationMessageColumnApi = { getConversationPage: async (_id, request) => {
    requests.push(request?.startIndex ?? -1);
    return new Promise((resolve) => { resolvePage = resolve; });
  } };
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  const getLatest = () => latest;
  const liveStates = new Map<string, LiveSessionRunState>();
  function Probe({ id, text }: { id: string; text: string }) {
    if (!liveStates.has(text)) liveStates.set(text, { assistantText: text, threadId: "thread" } as LiveSessionRunState);
    latest = useConversationMessageColumn({ session: { id, incarnationId: id, messages: messages(140), messageCount: 200, runState: "running" }, baseProps: createBaseProps(id), enabled: true, api, stateCache: cache, liveRun: liveStates.get(text) });
    return React.createElement("div", { ref: latest?.messageListRef });
  }
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(dom.window.document.getElementById("root")!); root.render(React.createElement(Probe, { id: "main", text: "live" })); });
    await act(async () => { void latest?.onLoadMessagePage?.(110); });
    assert.deepEqual(requests, [80]);
    await act(async () => resolvePage?.({ sessionId: "main", incarnationId: "main", startIndex: 80, totalCount: 200, messages: messages(80) }));
    assert.equal(getLatest()?.messages.length, 60);
    assert.equal(getLatest()?.messageKeys?.[0], "session-main-80");
    await act(async () => root?.render(React.createElement(Probe, { id: "main", text: "live updated" })));
    assert.equal(getLatest()?.messages.at(-1)?.text, "message 139");
    assert.equal(getLatest()?.isRunning, false);
    await act(async () => { void latest?.onLoadMessagePage?.(50); });
    const stale = resolvePage;
    await act(async () => root?.render(React.createElement(Probe, { id: "other", text: "other live" })));
    assert.equal(cache.get("main")?.liveRun, null);
    assert.deepEqual(cache.get("main")?.bridge, { sessionId: "main", threadId: "thread", messageIndex: 200 });
    await act(async () => stale?.({ sessionId: "main", incarnationId: "main", startIndex: 20, totalCount: 200, messages: messages(20) }));
    assert.equal(getLatest()?.sessionId, "other");
    assert.equal(getLatest()?.messageKeys?.[0], "session-other-140");
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Messages navigatorの連続移動は最後に選んだ本文と移動先を保持し、先行page応答で巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Window / 全履歴Messages navigator" }
// fault = "未読込対象の取得待ちに読込済み対象へ移動すると旧pageを適用するか、逆順応答で旧jumpを設定する"
// observable = "最後に選んだmessage keyの存在、本文先頭のglobal位置、messageJumpRequestのkey、読込完了状態"
// observation_boundary = "component-behavior"
// scope = "conversation-navigation-latest-intent"
// lifecycle = "permanent"
// impact = "MessagesとBookmark一覧から最後に選択した本文を読み続けられる"
// distinction = "会話owner testは別会話への遅延応答を検証するが、同一会話内の連続移動と完了順の競合を通らない"
// @end-test-value
test("conversation navigator は連続選択の最後の移動先を保持する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id: number) => dom.window.clearTimeout(id) });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const messages = (start: number) => Array.from({ length: 60 }, (_, index) => ({ role: "user" as const, text: `message ${start + index}`, historyIndex: start + index }));
  const tail = messages(140);
  const pendingPages = new Map<number, (page: ConversationPage) => void>();
  const api: ConversationMessageColumnApi = {
    getConversationPage: async (_id, request) => new Promise((resolve) => {
      const startIndex = request?.startIndex;
      assert.ok(startIndex !== undefined);
      pendingPages.set(startIndex, resolve);
    }),
  };
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls: ConversationColumnControls | undefined;
  const getLatest = () => { assert.ok(latest); return latest; };
  const getControls = () => { assert.ok(controls); return controls; };
  function Probe() {
    latest = useConversationMessageColumn({
      session: { id: "main", incarnationId: "main", messages: tail, messageCount: 200 },
      baseProps: createBaseProps("main"), enabled: true, api, liveRun: null,
      onColumnControls: (next) => { controls = next; },
    });
    return React.createElement("div", { ref: latest?.messageListRef });
  }
  const completePage = (startIndex: number) => {
    const resolve = pendingPages.get(startIndex);
    assert.ok(resolve);
    pendingPages.delete(startIndex);
    resolve({ sessionId: "main", incarnationId: "main", startIndex, totalCount: 200, messages: messages(startIndex) });
  };
  const assertTarget = (messageIndex: number, startIndex: number) => {
    const column = getLatest();
    assert.equal(column.messages[0]?.historyIndex, startIndex);
    assert.equal(column.messageJumpRequest?.key, `session-main-${messageIndex}`);
    assert.ok(column.messageKeys?.includes(`session-main-${messageIndex}`));
  };
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(React.createElement(Probe));
    });
    await act(async () => { void getControls().onJumpToMessage("session-main-100"); });
    assert.equal(getLatest().conversationPaging?.loading, true);
    await act(async () => getControls().onJumpToMessage("session-main-150"));
    assertTarget(150, 140);
    await act(async () => completePage(70));
    assertTarget(150, 140);
    assert.equal(getLatest().conversationPaging?.loading, false);

    await act(async () => { void getControls().onJumpToMessage("session-main-100"); });
    await act(async () => { void getControls().onJumpToMessage("session-main-110"); });
    await act(async () => completePage(80));
    assertTarget(110, 80);
    await act(async () => completePage(70));
    assertTarget(110, 80);
    assert.equal(getLatest().conversationPaging?.loading, false);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Findで最後に選んだ読込済み本文は、先行する未読込hitのpage応答後も表示を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Window / 全履歴Find" }
// fault = "未読込hitの取得待ちに読込済みhitを選ぶと、先行page応答が最後に選んだ本文を画面から外す"
// observable = "最後に選んだmessage keyの存在、本文先頭のglobal位置、読込完了状態"
// observation_boundary = "component-behavior"
// scope = "conversation-find-latest-intent"
// lifecycle = "permanent"
// impact = "Findの連続移動で最後に選択した検索結果を読み続けられる"
// distinction = "navigator testはonJumpToMessageを通るが、Find専用のonLoadMessagePageの連続選択を通らない"
// @end-test-value
test("conversation Find は連続選択の最後の読込済み本文を保持する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id: number) => dom.window.clearTimeout(id) });
  const globals = ["window", "document", "HTMLElement", "Node", "navigator"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  globals.forEach((key) => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const messages = (start: number) => Array.from({ length: 60 }, (_, index) => ({ role: "user" as const, text: `message ${start + index}`, historyIndex: start + index }));
  const tail = messages(140);
  let resolvePage: ((page: ConversationPage) => void) | undefined;
  const api: ConversationMessageColumnApi = {
    getConversationPage: async (_id, request) => {
      assert.equal(request?.startIndex, 70);
      return new Promise((resolve) => { resolvePage = resolve; });
    },
  };
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  const getLatest = () => { assert.ok(latest); return latest; };
  function Probe() {
    latest = useConversationMessageColumn({
      session: { id: "main", incarnationId: "main", messages: tail, messageCount: 200 },
      baseProps: createBaseProps("main"), enabled: true, api, liveRun: null,
    });
    return React.createElement("div", { ref: latest?.messageListRef });
  }
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root")!);
      root.render(React.createElement(Probe));
    });
    await act(async () => { void getLatest().onLoadMessagePage?.(100); });
    assert.equal(getLatest().conversationPaging?.loading, true);
    await act(async () => getLatest().onLoadMessagePage?.(150));
    assert.equal(getLatest().conversationPaging?.loading, false);
    assert.ok(resolvePage);
    await act(async () => resolvePage!({ sessionId: "main", incarnationId: "main", startIndex: 70, totalCount: 200, messages: messages(70) }));
    assert.equal(getLatest().messages[0]?.historyIndex, 140);
    assert.ok(getLatest().messageKeys?.includes("session-main-150"));
    assert.equal(getLatest().conversationPaging?.loading, false);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    globals.forEach((key, index) => { const descriptor = previous[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "invariant"
// claim = "同じWindowのMain/Auxiliary live eventは会話IDで分離され、非target会話へ混入しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: Context boundary" }
// fault = "Mainのlive eventやapprovalがAuxiliary columnへ表示・送信される"
// observable = "各columnのlive表示文字列とapproval APIへ渡るsessionId"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// @end-test-value
test("conversation columns はlive eventとapprovalをsession IDごとに分離する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const listeners = new Set<(id: string, state: any) => void>();
  const resolved: string[] = [];
  const api: ConversationMessageColumnApi = {
    subscribeLiveSessionRun: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getLiveSessionRun: async () => null,
    resolveLiveApproval: async (sessionId) => { resolved.push(sessionId); },
  };
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(function Probe() {
        const main = useConversationMessageColumn({ session: { id: "main" }, baseProps: createBaseProps("main"), enabled: true, api });
        const auxiliary = useConversationMessageColumn({ session: { id: "aux" }, baseProps: createBaseProps("aux"), enabled: true, api });
        const mainRequest = { requestId: "request-main" } as NonNullable<SessionMessageColumnProps["liveApprovalRequest"]>;
        const auxiliaryRequest = { requestId: "request-aux" } as NonNullable<SessionMessageColumnProps["liveApprovalRequest"]>;
        return React.createElement(React.Fragment, null,
          React.createElement("div", { "data-main-live": main?.liveRunAssistantText, "data-main-approval": main?.liveApprovalRequest?.requestId }),
          React.createElement("div", { "data-aux-live": auxiliary?.liveRunAssistantText, "data-aux-approval": auxiliary?.liveApprovalRequest?.requestId }),
          React.createElement("button", { id: "approve-main", onClick: () => main?.onResolveLiveApproval(mainRequest, "approve") }),
          React.createElement("button", { id: "approve-aux", onClick: () => auxiliary?.onResolveLiveApproval(auxiliaryRequest, "approve") }),
        );
      }));
    });
    await act(async () => {
      const emit = (sessionId: string, assistantText: string, requestId: string) => listeners.forEach((listener) => listener(sessionId, {
        sessionId, threadId: "thread", assistantText, steps: [], backgroundTasks: [], usage: null, errorMessage: "",
        elicitationRequest: null, approvalRequest: { requestId },
      }));
      emit("main", "main live", "request-main");
      emit("aux", "aux live", "request-aux");
    });
    assert.equal(dom.window.document.querySelector("[data-main-live]")?.getAttribute("data-main-live"), "main live");
    assert.equal(dom.window.document.querySelector("[data-aux-live]")?.getAttribute("data-aux-live"), "aux live");
    assert.equal(dom.window.document.querySelector("[data-aux-approval]")?.getAttribute("data-aux-approval"), "request-aux");
    await act(async () => dom.window.document.getElementById("approve-main")?.click());
    await act(async () => dom.window.document.getElementById("approve-aux")?.click());
    assert.deepEqual(resolved, ["main", "aux"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "contract"
// claim = "完了receiptの照会と更新通知が応答より先に届く配送順でも、受付済み送信はcanonical応答に合流し待機表示を終了する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Session Window / 保存済み応答への接続と待機表示の終了" }
// fault = "照会自身の通知で取得結果が失効し続け、完了済み応答を表示できず待機表示が残る"
// observable = "実Main facade/serviceからcolumnへの購読、responsePending、canonical本文、消費後のsubmission store"
// observation_boundary = "consumer"
// scope = "Main receipt reconciliation and conversation subscription"
// lifecycle = "permanent"
// impact = "保存済み応答への移行が止まりユーザーが会話を継続できないと認識する"
// distinction = "既存column testのfake receipt APIはMainの変更通知を通らない。実facade/serviceと小さいhook fixtureで配送順の結合を検証する"
// @end-test-value
test("completed receipt reads converge even when queue notifications arrive before replies", async () => {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const session = {
    ...buildNewSession({ taskTitle: "Queue", workspaceLabel: "workspace", workspacePath: "C:/workspace",
      branch: "main", characterId: "character", character: "Character", characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request" }),
    incarnationId: "inc",
  };
  const requestId = "13d5a026-53b0-4d79-94bc-a63b7733ab10";
  const terminal: SessionTurnQueueReceipt = {
    sessionId: session.id, incarnationId: session.incarnationId, id: "receipt", requestId, sequence: 1, queuePosition: 1,
    state: "completed", turnId: "turn", userMessageSeq: 0, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
    captured: { request: { clientRequestId: requestId, userMessage: "prompt", executionOptions: captureSessionExecutionOptions(session) },
      attachments: [], provider: session.provider, workspacePath: session.workspacePath },
  };
  const submissions = new SessionTurnSubmissions();
  submissions.start({ sessionId: session.id, incarnationId: session.incarnationId, requestId, userMessage: "prompt",
    historyMessageCount: 0, queuedBehindRun: false, error: "" });
  submissions.accept({ ...terminal, state: "queued", turnId: null, userMessageSeq: null });
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected queue operation"); };
  const store: SessionTurnQueueStore = {
    getReceipt: async () => terminal, getReceiptById: async () => terminal, listActive: async () => [], claimNext: async () => null,
    admit: unexpected, listReceipts: unexpected, listPendingOwners: unexpected, markStarted: unexpected,
    settle: unexpected, cancelQueued: unexpected, recoverInterrupted: unexpected,
    claimForInput: unexpected, restoreQueuedInput: unexpected, reorderQueued: unexpected, updateQueued: unexpected,
  };
  let listener: ((id: string) => void) | undefined;
  const notifications: Array<() => void> = [];
  const replies: Array<() => void> = [];
  const service = new SessionTurnQueueService({ store, isRunInFlight: () => false, dispatch: unexpected,
    onChanged: (owner) => { notifications.push(() => listener?.(owner.sessionId)); } });
  const facade = new MainSessionTurnQueueFacade({
    assertActive() {}, assertAccepting() {}, getSession: async () => session,
    getAppSettings: unexpected,
    validateWorkspace: unexpected, validateProvider: unexpected, preview: unexpected, store, service,
  });
  const api: ConversationMessageColumnApi = {
    listSessionTurnQueue: (id) => facade.listSessionTurnQueue(id),
    getSessionTurnQueueReceipt: async (id, request) => {
      const result = await facade.getSessionTurnQueueReceipt(id, request);
      return new Promise((resolve) => { replies.push(() => resolve(result)); });
    },
    onSessionTurnQueueChanged: (next) => { listener = next; return () => { listener = undefined; }; },
  };
  let latest: SessionMessageColumnProps | null = null;
  function View() {
    latest = useConversationMessageColumn({
      session: { ...session, messages: [{ role: "user", text: "prompt" }, { role: "assistant", text: "answer" }] },
      baseProps: { ...createBaseProps(session.id), turnSubmissions: submissions }, enabled: true, api, liveRun: null,
    });
    return null;
  }
  const column = () => { assert.ok(latest); return latest; };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<View />); });
    assert.equal(column().responsePending, true);
    assert.equal(replies.length, 1);
    // Model independent IPC event/reply delivery without allowing an unbounded loop.
    for (let batch = 0; batch < 4 && (replies.length || notifications.length); batch += 1) {
      const pendingReplies = replies.splice(0);
      await act(async () => { notifications.splice(0).forEach((notify) => notify()); });
      await act(async () => { pendingReplies.forEach((reply) => reply()); });
    }
    assert.equal(column().responsePending, false);
    assert.deepEqual(column().messages.map((message) => message.text), ["prompt", "answer"]);
    assert.equal(submissions.getSnapshot().length, 0);
    assert.equal(replies.length, 0);
    assert.equal(notifications.length, 0);
  } finally {
    await act(async () => root.unmount());
    await service.close();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Main/AuxのSendは受付を確認してからcanonical到着まで同じ応答DOMを保持し、集約した本文を終端で最新rawへ接続する。旧interruptedもFailedを一度表示し、後続は専用解除なしで順に待機・開始し、個別に取消せる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: 受付応答・自動照会・回復; docs/design/auxiliary-session.md#送信受付の共通反映" }
// fault = "受付前に仮行が出る、ACK/保存到着でpromptや枠を消す・二重化する、旧失敗に解除を要求する、後続順と取消対象を誤る、または失敗をspinnerに隠す"
// observable = "実Columnのprompt件数・応答DOM identity・制御clockごとの本文・Failed件数、後続の順とCancel対象、isRunning/responsePendingと所有request"
// observation_boundary = "component-behavior"
// scope = "optimistic conversation submission handoff"
// lifecycle = "permanent"
// impact = "データ到着順による会話の飛び、失敗した要求を待ち続ける状態、別会話への誤表示を防ぐ。再起動後も後続を手動で解除する必要がない"
// distinction = "operation通知testはColumnの実購読、receipt/canonical結合、旧失敗後の次予約の表示と実Cancelを通らない"
// @end-test-value
test("conversation column shows accepted sends and preserves the canonical response handoff", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.requestAnimationFrame = () => 1;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetHeight: { get: () => 720 }, offsetWidth: { get: () => 800 }, clientHeight: { get: () => 720 },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    for (const kind of ["session", "auxiliary"] as const) {
      const store = new SessionTurnSubmissions();
      let active: SessionTurnQueueReceipt[] = [];
      let resolved: SessionTurnQueueReceipt | null = null;
      let holdQueue = true;
      let changed: ((id: string) => void) | undefined;
      const canceled: string[] = [];
      const api: ConversationMessageColumnApi = {
        listSessionTurnQueue: () => holdQueue ? new Promise(() => {}) : Promise.resolve(active),
        getSessionTurnQueueReceipt: async (_id, requestId) => resolved?.requestId === requestId ? resolved : active.find((item) => item.requestId === requestId) ?? null,
        onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
        cancelQueuedSessionTurn: async (_id, receiptId) => {
          canceled.push(receiptId);
          resolved = { ...active.find((item) => item.id === receiptId)!, state: "canceled" };
          active = active.filter((item) => item.id !== receiptId);
          return resolved;
        },
      };
      let latest: SessionMessageColumnProps | null = null;
      let saved: SessionMessageColumnProps["messages"] = [];
      let live: LiveSessionRunState | null = null;
      function View() {
        latest = useConversationMessageColumn({
          session: { id: kind, incarnationId: "inc", messages: saved, runState: live?.runState ?? "idle" },
          baseProps: { ...createBaseProps(kind), turnSubmissions: store, messageViewMode: kind === "session" ? "preview" : "source" }, enabled: true, api, liveRun: live, messageSourceKind: kind,
        });
        return latest ? <SessionMessageColumn {...latest} /> : null;
      }
      const column = () => { assert.ok(latest); return latest; };
      const render = () => act(async () => { root.render(<View key={kind} />); });
      const promptCount = () => [...dom.window.document.querySelectorAll(".message-row.user")].filter((row) => row.textContent?.includes("captured prompt")).length;
      const pendingCount = () => dom.window.document.querySelectorAll(".pending-row").length;
      const start = () => store.start({ sessionId: kind, incarnationId: "inc", requestId: "request", userMessage: "captured prompt", historyMessageCount: 0, queuedBehindRun: false, error: "" });
      const receipt: SessionTurnQueueReceipt = {
        sessionId: kind, incarnationId: "inc", id: "receipt", requestId: "request", sequence: 1, queuePosition: 1, state: "queued",
        captured: { request: { clientRequestId: "request", userMessage: "captured prompt", executionOptions: {
          model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
        } }, attachments: [], provider: "codex", workspacePath: "workspace" },
        turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
      };
      await render();
      await act(async () => { start(); });
      assert.equal(promptCount(), 0);
      assert.equal(pendingCount(), 0);
      assert.equal(column().isRunning, false);
      assert.equal(column().responsePending, false);
      assert.equal(dom.window.document.querySelector("[role=alert]"), null);
      await act(async () => { store.fail("request", "Turn acceptance timed out. Check Receipt."); });
      assert.equal(promptCount(), 1);
      assert.match(dom.window.document.querySelector("[role=alert]")!.textContent!, /timed out/);
      assert.equal(dom.window.document.querySelector(".pending-row [role=status]"), null);
      await act(async () => { store.accept(receipt); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      const responseRow = dom.window.document.querySelector(".pending-row");
      assert.ok(responseRow?.closest(".session-message-virtual-row"));
      assert.equal(dom.window.document.querySelector("[role=alert]"), null);
      holdQueue = false;
      active = [{ ...receipt, state: "starting" }];
      resolved = active[0];
      await act(async () => { changed?.(kind); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      active = [{ ...receipt, state: "running", turnId: "turn", userMessageSeq: 0 }];
      resolved = active[0];
      live = { sessionId: kind, threadId: "thread", sessionTurnId: "turn", turnId: "native-turn", runState: "running", assistantText: "", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      assert.equal(column().isRunning, true);
      saved = [{ role: "user", text: "captured prompt" }, { role: "user", text: "additional input in this turn" }];
      live = { ...live, assistantText: "streamed answer" };
      await render();
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 0, "the same response surface now owns streaming content");
      assert.equal(dom.window.document.querySelector(".message-row.assistant"), responseRow);
      assert.equal(dom.window.document.querySelectorAll(".pending-response-content").length, 1);
      assert.equal(dom.window.document.body.textContent?.includes("streamed answer"), false);
      await act(async () => context.mock.timers.tick(50));
      live = { ...live, assistantText: "streamed answer changed" };
      await render();
      await act(async () => context.mock.timers.tick(49));
      assert.equal(dom.window.document.body.textContent?.includes("streamed answer"), false);
      await act(async () => context.mock.timers.tick(1));
      assert.match(dom.window.document.body.textContent!, /streamed answer changed/);
      live = { ...live, assistantText: "streamed answer" };
      await render();
      assert.match(dom.window.document.body.textContent!, /streamed answer changed/);
      resolved = { ...active[0], state: "completed" };
      active = [];
      live = null;
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 0, "the streamed response keeps its surface while canonical saving catches up");
      assert.equal(dom.window.document.querySelectorAll(".pending-response-content").length, 1);
      assert.match(dom.window.document.body.textContent!, /streamed answer/);
      assert.equal(dom.window.document.body.textContent?.includes("streamed answer changed"), false, "terminal flushes the latest replacement without waiting for the next interval");
      assert.equal(dom.window.document.querySelector(".message-row.assistant"), responseRow);
      const nextReceipt = { ...receipt, id: "next-receipt", requestId: "next-request", sequence: 2, queuePosition: 2,
        captured: { ...receipt.captured, request: { ...receipt.captured.request, clientRequestId: "next-request", userMessage: "next reserved prompt" } } };
      active = [nextReceipt];
      await act(async () => {
        store.start({ sessionId: kind, incarnationId: "inc", requestId: "next-request", userMessage: "next reserved prompt", historyMessageCount: 2, queuedBehindRun: true, error: "" });
        store.accept(nextReceipt);
        changed?.(kind);
      });
      assert.deepEqual(column().messages.map((message) => message.text), ["captured prompt", "additional input in this turn", "streamed answer"]);
      const textWhileSaving = dom.window.document.body.textContent!;
      assert.ok(textWhileSaving.indexOf("streamed answer") < textWhileSaving.indexOf("next reserved prompt"), "the next reserved prompt stays after the prior response");
      assert.equal(pendingCount(), 0);
      assert.equal(dom.window.document.querySelectorAll(".pending-response-content").length, 1);
      saved = [...saved, { role: "assistant", text: "final answer" }];
      await render();
      assert.equal(dom.window.document.querySelector(".message-row.assistant"), responseRow, "canonical saving updates the same virtualized response row");
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1, "the next turn gets its own response surface only after the prior canonical response arrives");
      assert.equal(column().isRunning, false);
      assert.deepEqual(column().messages.map((message) => message.text), ["captured prompt", "additional input in this turn", "final answer", "next reserved prompt"]);
      assert.deepEqual(store.getSnapshot().map((submission) => submission.requestId), ["next-request"]);
      resolved = { ...nextReceipt, state: "canceled" };
      active = [];
      await act(async () => { store.accept(resolved!); changed?.(kind); });
      assert.equal(pendingCount(), 0);
      assert.equal(store.getSnapshot().length, 0);

      // A turn can reach terminal before this column has ever observed an active receipt.
      holdQueue = true;
      await render();
      const fastReceipt = { ...receipt, id: "fast-receipt", requestId: "fast-request", sequence: 3 };
      await act(async () => {
        store.start({ sessionId: kind, incarnationId: "inc", requestId: "fast-request", userMessage: "captured prompt", historyMessageCount: 3, queuedBehindRun: false, error: "" });
        store.accept({ ...fastReceipt, state: "starting" });
      });
      const fastResponseRow = dom.window.document.querySelector(".pending-row");
      assert.ok(fastResponseRow);
      saved = [...saved, { role: "user", text: "captured prompt" }, { role: "assistant", text: "fast answer" }];
      await render();
      assert.equal(promptCount(), 2, "canonical user must not insert a second prompt before its receipt sequence arrives");
      assert.equal(pendingCount(), 1);
      resolved = { ...fastReceipt, state: "completed", turnId: "fast", userMessageSeq: 3 };
      holdQueue = false;
      await act(async () => { changed?.(kind); });
      assert.equal(promptCount(), 2);
      assert.equal(pendingCount(), 0);
      assert.match(dom.window.document.body.textContent!, /fast answer/);
      assert.equal([...dom.window.document.querySelectorAll(".message-row.assistant")].at(-1), fastResponseRow, "canonical-first completion preserves the initial response row");
      assert.equal(store.getSnapshot().length, 0);

      const interrupted = { ...receipt, id: "interrupted", requestId: "interrupted-request", sequence: 4, queuePosition: 4, state: "interrupted" as const, reason: "Interrupted by restart.",
        captured: { ...receipt.captured, request: { ...receipt.captured.request, clientRequestId: "interrupted-request", userMessage: "first interrupted prompt" } } };
      const held = { ...nextReceipt, id: "held", requestId: "held-request", sequence: 5, queuePosition: 5,
        captured: { ...nextReceipt.captured, request: { ...nextReceipt.captured.request, clientRequestId: "held-request", userMessage: "second held prompt" } } };
      saved = [];
      active = [held, interrupted];
      resolved = null;
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      const queueOrder = () => [...dom.window.document.querySelectorAll(".message-row.user")].map((row) => row.querySelector(".message-card-content")?.firstElementChild?.textContent);
      assert.deepEqual(column().messages.map((message) => message.text), ["first interrupted prompt", "", "second held prompt"]);
      assert.deepEqual(queueOrder(), ["first interrupted prompt", "second held prompt"]);
      assert.equal(pendingCount(), 1);
      assert.equal(column().responsePending, true);
      assert.equal(dom.window.document.querySelectorAll(".session-run-failure").length, 1);
      assert.match(dom.window.document.querySelector(".message-row.assistant .session-run-failure")!.textContent!, /FailedInterrupted by restart/);
      assert.doesNotMatch(dom.window.document.body.textContent!, /Release Later Turns|Later turns are held/);
      const local = { sessionId: kind, incarnationId: "inc", requestId: "local-held-request", userMessage: "third held prompt", historyMessageCount: 0, queuedBehindRun: false, error: "" };
      await act(async () => { store.start(local); });
      assert.deepEqual(queueOrder(), ["first interrupted prompt", "second held prompt"]);
      assert.equal(pendingCount(), 1);
      const third = { ...held, id: "third", requestId: local.requestId, sequence: 6, queuePosition: 6,
        captured: { ...held.captured, request: { ...held.captured.request, clientRequestId: local.requestId, userMessage: local.userMessage } } };
      active = [interrupted, held, third];
      await act(async () => { store.accept(third); changed?.(kind); });
      assert.deepEqual(queueOrder(), ["first interrupted prompt", "second held prompt", "third held prompt"]);
      const cancel = dom.window.document.querySelector<HTMLButtonElement>("[aria-label='Cancel queued turn 1']");
      assert.ok(cancel);
      await act(async () => { cancel.click(); });
      assert.deepEqual(canceled, ["held"]);
      assert.deepEqual(queueOrder(), ["first interrupted prompt", "third held prompt"]);
      assert.deepEqual(column().messages.map((message) => message.text), ["first interrupted prompt", "", "third held prompt"]);
      assert.equal(dom.window.document.querySelectorAll(".session-run-failure").length, 1);
      assert.equal(pendingCount(), 1);
      assert.equal(column().isRunning, false);
      await act(async () => {
        store.start({ sessionId: "different", incarnationId: "inc", requestId: "other", userMessage: "wrong owner", historyMessageCount: 0, queuedBehindRun: false, error: "" });
        store.start({ sessionId: kind, incarnationId: "old", requestId: "old", userMessage: "old incarnation", historyMessageCount: 0, queuedBehindRun: false, error: "" });
        store.fail("other", "Other conversation's acceptance is unknown.", true);
        store.fail("old", "Old incarnation's acceptance is unknown.", true);
      });
      assert.doesNotMatch(dom.window.document.body.textContent!, /wrong owner|old incarnation/);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});


// @test-value v2
// kind = "invariant"
// claim = "質問応答は次Turn予約を変更しない。遅い再取得は次の要求を消さず、古い質問応答が終了しても次の質問の送信中表示を解除しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#question-forms; docs/design/desktop-ui.md#approval-requests" }
// fault = "質問回答を予約操作へ送る、古いlive snapshotで後着要求を上書きする、古い応答で次の質問のbusyを解除する、または正しく解決した要求を残す"
// observable = "各会話列の承認・入力要求、質問APIの宛先と回答、質問の送信中ID、予約IDと予約操作の呼出、実行中状態"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// impact = "次の承認・入力面が消えるとProviderが利用者応答を待ったまま停止する"
// distinction = "既存testは応答APIの宛先と購読表示だけを確認し、応答後の非同期再取得との到着順を検証しない"
// @end-test-value
test("conversation columns は応答後の遅い再取得から次の要求を守る", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  let root: Root | null = null;
  const listeners = new Set<(id: string, state: LiveSessionRunState | null) => void>();
  const fetchResolvers = new Map<string, (state: LiveSessionRunState | null) => void>();
  const fetchCounts = new Map<string, number>();
  const answers: Array<[string, string, LiveElicitationResponse]> = [];
  const nextQueued: SessionTurnQueueReceipt = {
    sessionId: "aux", incarnationId: "aux-incarnation", id: "next-queued", requestId: "queued-request", sequence: 1, queuePosition: 1,
    state: "queued", turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
    captured: { request: { clientRequestId: "queued-request", userMessage: "Reserved for the next Turn", executionOptions: {
      model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
    } }, attachments: [], provider: "codex", workspacePath: "workspace" },
  };
  const queueActions: string[] = [];
  const createRun = (sessionId: string, requestKind: "approval" | "elicitation" | null, requestId = ""): LiveSessionRunState => ({
    sessionId,
    threadId: `${sessionId}-thread`,
    assistantText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: requestKind === "approval" ? { requestId } as LiveSessionRunState["approvalRequest"] : null,
    elicitationRequest: requestKind === "elicitation" ? { requestId } as LiveSessionRunState["elicitationRequest"] : null,
  });
  const api: ConversationMessageColumnApi = {
    subscribeLiveSessionRun: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getLiveSessionRun: (sessionId) => {
      const count = (fetchCounts.get(sessionId) ?? 0) + 1;
      fetchCounts.set(sessionId, count);
      if (count === 1) return Promise.resolve(null);
      return new Promise((resolve) => { fetchResolvers.set(sessionId, resolve); });
    },
    resolveLiveApproval: async () => {},
    resolveLiveElicitation: async (sessionId, requestId, response) => { answers.push([sessionId, requestId, response]); },
    listSessionTurnQueue: async (id) => id === "aux" ? [nextQueued] : [],
    onSessionTurnQueueChanged: () => () => {},
    sendQueuedSessionInput: async () => { queueActions.push("steer"); return nextQueued; },
    cancelQueuedSessionTurn: async () => { queueActions.push("cancel"); return nextQueued; },
    reorderQueuedSessionTurns: async () => { queueActions.push("reorder"); throw new Error("Unexpected queue reorder"); },
  };
  let main: SessionMessageColumnProps | null = null;
  let auxiliary: SessionMessageColumnProps | null = null;
  const emit = (sessionId: string, state: LiveSessionRunState | null) => {
    listeners.forEach((listener) => listener(sessionId, state));
  };
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(function Probe() {
        main = useConversationMessageColumn({ session: { id: "main", runState: "running" }, baseProps: createBaseProps("main"), enabled: true, api });
        auxiliary = useConversationMessageColumn({ session: { id: "aux", incarnationId: "aux-incarnation", runState: "running" }, baseProps: createBaseProps("aux"), enabled: true, api });
        return null;
      }));
    });

    for (const scenario of [
      { sessionId: "main", kind: "approval" as const, stale: null },
      { sessionId: "aux", kind: "elicitation" as const, stale: createRun("aux", null) },
    ]) {
      const column = () => scenario.sessionId === "main" ? main : auxiliary;
      const first = createRun(scenario.sessionId, scenario.kind, "r1");
      const second = createRun(scenario.sessionId, scenario.kind, "r2");
      const firstAnswer = { action: "accept", content: { answer: "First answer" } } as const;
      const secondAnswer = { action: "accept", content: { answer: "Second answer" } } as const;
      await act(async () => emit(scenario.sessionId, first));
      await act(async () => {
        scenario.kind === "approval"
          ? column()?.onResolveLiveApproval(first.approvalRequest!, "approve")
          : column()?.onResolveLiveElicitation(first.elicitationRequest!, firstAnswer);
        await Promise.resolve();
      });
      assert.ok(fetchResolvers.has(scenario.sessionId));
      const resolveStale = fetchResolvers.get(scenario.sessionId)!;
      await act(async () => emit(scenario.sessionId, second));
      if (scenario.kind === "elicitation") {
        assert.equal(column()?.elicitationActionRequestId, null, "an ended question must not block the next");
        await act(async () => {
          column()?.onResolveLiveElicitation(second.elicitationRequest!, secondAnswer);
          await Promise.resolve();
        });
        assert.equal(column()?.elicitationActionRequestId, "r2");
      }
      await act(async () => {
        resolveStale(scenario.stale);
        await Promise.resolve();
      });
      const currentRequest = scenario.kind === "approval" ? column()?.liveApprovalRequest : column()?.liveElicitationRequest;
      assert.equal(currentRequest?.requestId, "r2", `${scenario.sessionId} must retain the later request`);
      assert.equal(column()?.isRunning, true);

      if (scenario.kind === "approval") {
        await act(async () => {
          column()?.onResolveLiveApproval(second.approvalRequest!, "approve");
          await Promise.resolve();
        });
      } else {
        assert.equal(column()?.elicitationActionRequestId, "r2", "the old completion must not release the new answer");
        assert.deepEqual(answers, [["aux", "r1", firstAnswer], ["aux", "r2", secondAnswer]]);
      }
      await act(async () => {
        fetchResolvers.get(scenario.sessionId)?.(createRun(scenario.sessionId, null));
        await Promise.resolve();
      });
      assert.equal(column()?.liveApprovalRequest, null);
      assert.equal(column()?.liveElicitationRequest, null);
      assert.equal(column()?.isRunning, true);
      if (scenario.kind === "elicitation") {
        assert.deepEqual(column()?.queuedTurnIds, [nextQueued.id]);
        assert.deepEqual(queueActions, []);
      }
    }
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "会話IDを切り替えてもstate cacheに保存したscroll位置を再表示時に復元する"
// oracle = { type = "contract", ref = "issue-710-conversation-scroll-cache" }
// fault = "Auxiliary表示へ切り替えた後にMainのscroll状態が消える"
// observable = "Main column remount後のmessageListRef.scrollTop"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// @end-test-value
test("conversation column cache は切替後のscroll位置を保持する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id: number) => dom.window.clearTimeout(id) });
  let root: Root | null = null;
  const cache = new Map<string, ConversationColumnCache>();
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  function Probe({ id }: { id: string }) {
    latest = useConversationMessageColumn({ session: { id }, baseProps: createBaseProps(id), enabled: true, stateCache: cache });
    return React.createElement("div", { ref: latest?.messageListRef, "data-id": id, onScroll: latest?.onMessageListScroll });
  }
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Probe, { id: "main" }));
    });
    const main = dom.window.document.querySelector<HTMLDivElement>("[data-id='main']");
    assert.ok(main);
    Object.defineProperties(main, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 50 },
    });
    main.scrollTop = 37;
    await act(async () => main.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    await act(async () => latest?.onMessageListScroll({ currentTarget: main } as UIEvent<HTMLDivElement>));
    assert.equal(cache.get("main")?.scrollState?.scrollTop, 37);
    await act(async () => root?.render(React.createElement(Probe, { id: "aux" })));
    await act(async () => root?.render(React.createElement(Probe, { id: "main" })));
    const restored = dom.window.document.querySelector<HTMLDivElement>("[data-id='main']");
    assert.equal(restored?.scrollTop, 37);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "contract"
// claim = "送信の受付確定まで閲覧位置を維持し、受付待ちの上方向入力は送信時の末尾復帰を取り消す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: message list follow mode" }
// fault = "送信captureだけで末尾へ移動する、設定OFFで復帰する、または受付待ちの閲覧操作を上書きする"
// observable = "column controlsのisMessageListFollowingとlistのscrollTop"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// impact = "送信失敗や受付待ちに履歴を読む利用者の位置を奪わず、設定ONの受付済み送信だけを末尾へ戻す"
// distinction = "型検査ではcaptureと受付の時間差や、その間の閲覧入力による失効を確認できない"
// @end-test-value
test("conversation column controls はscroll状態と送信時追従操作を公開する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id: number) => dom.window.clearTimeout(id) });
  let root: Root | null = null;
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls = {
    isMessageListFollowing: false,
    captureMessageListSend: (_scrollToLatestOnSend: boolean) => () => {},
  };
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(function Probe() {
        latest = useConversationMessageColumn({
          session: { id: "main" },
          baseProps: createBaseProps("main"),
          enabled: true,
          onColumnControls: (next) => { controls = next; },
        });
        return React.createElement("div", {
          ref: latest?.messageListRef,
          "data-id": "main",
          onScroll: latest?.onMessageListScroll,
        });
      }));
    });
    assert.ok(controls);
    const element = dom.window.document.querySelector<HTMLDivElement>("[data-id='main']");
    assert.ok(element);
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
    });
    element.scrollTop = 10;
    await act(async () => latest?.onMessageListScroll({ currentTarget: element } as UIEvent<HTMLDivElement>));
    assert.equal(controls.isMessageListFollowing, true, "geometry alone does not express reading intent");
    await act(async () => element.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    assert.equal(controls?.isMessageListFollowing, false);

    await act(async () => controls.captureMessageListSend(false)());
    assert.equal(controls?.isMessageListFollowing, false);
    const accepted = controls.captureMessageListSend(true);
    assert.equal(controls.isMessageListFollowing, false, "capture must wait for acceptance");
    await act(async () => accepted());
    assert.equal(controls?.isMessageListFollowing, true);
    assert.equal(element.scrollTop, 60);
    const superseded = controls.captureMessageListSend(true);
    await act(async () => element.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    element.scrollTop = 10;
    await act(async () => superseded());
    assert.equal(controls.isMessageListFollowing, false);
    assert.equal(element.scrollTop, 10);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "ユーザー送信と保存済みレスポンスの折りたたみがnavigatorへ反映され、一覧選択が同じ会話のjump requestへ届く"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "live bridgeの安定キーを持つ保存済みレスポンスがcollapse targetから除外され、collapseまたはmessage jumpが表示へ届かない"
// observable = "Column propsのmessageCollapseTargetKeys・collapsedMessageKeys・messageNavigatorEntries・messageJumpRequest"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// @end-test-value
test("conversation column はcollapseとnavigator jumpを公開する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  let root: Root | null = null;
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls = {
    messageCollapseTargetKeys: [] as readonly string[],
    messageNavigatorEntries: [] as readonly { key: string; isCollapsed: boolean }[],
    onJumpToMessage: (_key: string) => {},
  };
  const testApi: ConversationMessageColumnApi = {};
  const liveRun: LiveSessionRunState = {
    sessionId: "main",
    threadId: "main-thread",
    assistantText: "response",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(function Probe() {
        latest = useConversationMessageColumn({
          session: {
            id: "main",
            messages: [
              { role: "user", text: "request" },
              { role: "assistant", text: "response" },
            ],
          },
          baseProps: createBaseProps("main"),
          enabled: true,
          api: testApi,
          liveRun,
          onColumnControls: (next) => { controls = next; },
        });
        return null;
      }));
    });
    assert.ok(controls);
    const getCurrent = () => latest!;
    assert.deepEqual(controls?.messageNavigatorEntries.map((entry) => entry.key), [
      "session-main-0",
      "live-assistant-main-1-main-thread",
    ]);
    assert.deepEqual(controls?.messageCollapseTargetKeys, [
      "session-main-0",
      "live-assistant-main-1-main-thread",
    ]);
    const key = controls?.messageNavigatorEntries[0]?.key;
    assert.ok(key);
    await act(async () => latest?.onToggleMessageCollapse?.(key));
    assert.equal(getCurrent().collapsedMessageKeys?.has(key), true);
    assert.equal(controls?.messageNavigatorEntries[0]?.isCollapsed, true);
    const responseKey = controls?.messageNavigatorEntries[1]?.key;
    assert.ok(responseKey);
    await act(async () => latest?.onToggleMessageCollapse?.(responseKey));
    assert.equal(getCurrent().collapsedMessageKeys?.has(responseKey), true);
    assert.equal(controls?.messageNavigatorEntries[1]?.isCollapsed, true);
    await act(async () => controls?.onJumpToMessage(responseKey));
    assert.equal(getCurrent().messageJumpRequest?.key, responseKey);
    assert.equal(getCurrent().messageJumpRequest?.sessionId, "main");
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "contract"
// claim = "親がlive snapshotを所有するColumnは二重購読せず、親が所有しないColumnは独自購読で更新する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "MainとAuxiliaryのlive表示が二重購読で競合する、または非対象Columnのlive更新が止まる"
// observable = "親snapshot更新後のMain表示、Auxiliary event後の表示、get/subscribe呼び出し対象"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// @end-test-value
test("conversation column は親snapshotを優先し、snapshot未提供Columnだけ購読する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const listeners = new Set<(id: string, state: LiveSessionRunState | null) => void>();
  const subscribedIds: string[] = [];
  const fetchedIds: string[] = [];
  const createRun = (sessionId: string, assistantText: string): LiveSessionRunState => ({
    sessionId,
    threadId: `${sessionId}-thread`,
    assistantText,
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  });
  const api: ConversationMessageColumnApi = {
    subscribeLiveSessionRun: (listener) => {
      subscribedIds.push("aux");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLiveSessionRun: async (sessionId) => {
      fetchedIds.push(sessionId);
      return null;
    },
  };
  let root: Root | null = null;
  function Probe({ mainLiveRun }: { mainLiveRun: LiveSessionRunState }) {
    const main = useConversationMessageColumn({
      session: { id: "main" },
      baseProps: createBaseProps("main"),
      enabled: true,
      api,
      liveRun: mainLiveRun,
    });
    const auxiliary = useConversationMessageColumn({
      session: { id: "aux" },
      baseProps: createBaseProps("aux"),
      enabled: true,
      api,
    });
    return React.createElement(React.Fragment, null,
      React.createElement("div", { "data-main-live": main?.liveRunAssistantText }),
      React.createElement("div", { "data-aux-live": auxiliary?.liveRunAssistantText }),
    );
  }
  try {
    const mainRun = createRun("main", "parent snapshot 1");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Probe, { mainLiveRun: mainRun }));
    });
    assert.deepEqual(subscribedIds, ["aux"]);
    assert.deepEqual(fetchedIds, ["aux"]);
    assert.equal(dom.window.document.querySelector("[data-main-live]")?.getAttribute("data-main-live"), "parent snapshot 1");

    await act(async () => {
      root?.render(React.createElement(Probe, { mainLiveRun: createRun("main", "parent snapshot 2") }));
    });
    await act(async () => {
      listeners.forEach((listener) => listener("aux", createRun("aux", "auxiliary event")));
    });
    assert.equal(dom.window.document.querySelector("[data-main-live]")?.getAttribute("data-main-live"), "parent snapshot 2");
    assert.equal(dom.window.document.querySelector("[data-aux-live]")?.getAttribute("data-aux-live"), "auxiliary event");
    assert.deepEqual(subscribedIds, ["aux"]);
    assert.deepEqual(fetchedIds, ["aux"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "親から渡されたlive snapshotはcache同期effectより先のrenderでも投影され、送信開始時に旧runのerrorを表示しない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md:61" }
// fault = "live snapshot更新時にcacheの旧errorを先にColumnへ投影し、送信直後に旧runの失敗表示が一瞬現れる"
// observable = "passive effect前のrenderでColumn propsから取得したliveRunErrorMessage"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
// impact = "旧runのエラーが新しい送信の会話中央へ誤表示され、利用者が新しい送信の失敗と誤認する"
// distinction = "既存の親snapshot testはpassive effect後の最終値だけを確認し、render間の旧cache投影を観測しない"
// @end-test-value
test("conversation column はsnapshot更新直後に旧live errorを投影しない", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const api: ConversationMessageColumnApi = {};
  const renderedErrors: string[] = [];
  const createRun = (errorMessage: string): LiveSessionRunState => ({
    sessionId: "main",
    threadId: "main-thread",
    assistantText: "",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage,
    approvalRequest: null,
    elicitationRequest: null,
  });
  let root: Root | null = null;
  try {
    function Probe({ liveRun }: { liveRun: LiveSessionRunState }) {
      const column = useConversationMessageColumn({
        session: { id: "main" },
        baseProps: createBaseProps("main"),
        enabled: true,
        api,
        liveRun,
      });
      React.useLayoutEffect(() => {
        renderedErrors.push(column?.liveRunErrorMessage ?? "");
      });
      return null;
    }
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Probe, { liveRun: createRun("Previous run failed") }));
    });
    assert.equal(renderedErrors.at(-1), "Previous run failed");
    renderedErrors.length = 0;

    await act(async () => {
      root?.render(React.createElement(Probe, { liveRun: createRun("") }));
    });
    assert.equal(renderedErrors[0], "");

    renderedErrors.length = 0;
    await act(async () => {
      root?.render(React.createElement(Probe, { liveRun: createRun("Current run failed") }));
    });
    assert.equal(renderedErrors[0], "Current run failed");
    assert.equal(renderedErrors.at(-1), "Current run failed");
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});
