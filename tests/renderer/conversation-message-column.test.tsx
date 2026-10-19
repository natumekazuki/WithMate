import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, type UIEvent } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useConversationMessageColumn,
  type ConversationColumnCache,
  type ConversationColumnControls,
  type ConversationMessageColumnApi,
} from "../../src/chat/conversation-message-column.js";
import type { SessionMessageColumnProps } from "../../src/chat/conversation/session-message-column.js";
import { SessionMessageColumn } from "../../src/chat/conversation/session-message-column.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ConversationPage } from "../../src-shared/session/conversation-page.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { SessionTurnSubmissions } from "../../src/chat/runtime/session-turn-submissions.js";

// @test-value v2
// kind = "contract"
// claim = "追尾停止と同frameのanchor計測と仮想range確定後の再計測で最新位置を保存し、owner切替・再表示で復元し、会話別の新着を末尾復帰で消す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: message list follow mode" }
// fault = "render前の停止を見落とす、未commitのrangeのoverscan行を保存する、range確定後に保存しない、別会話へ新着が漏れる、または非表示中の更新を落とす"
// observable = "column propsのhasNewActivity、isMessageListFollowing、messageJumpRequest、cacheのanchor"
// observation_boundary = "component-behavior"
// scope = "実follow hookと列cacheの接合。制御RAFと行矩形で停止直後・range commit通知・owner/visibility遷移を確認し、実virtualizerとCSS折返しは別のcomponent testとbrowserで確認する"
// lifecycle = "permanent"
// impact = "MainとAuxiliaryの往復やPreview終了で読んでいた本文を見失わず、新着へ明示的に戻れる"
// distinction = "hook単体ではownerごとのactivityと仮想行keyへの復元handoffを通らない。小さいhook fixtureで列の接合を確認する"
// @end-test-value
test("conversation column はownerと非表示期間を跨いで閲覧anchorと新着を保持する", async () => {
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
      assert.deepEqual(cache.get("main")?.anchor, { key: "session-main-0", offset: -12 }, "the frame sees a stop before React commits its following flag");
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
    assert.equal(current().hasNewActivity, true, "same-length visible text replacement is new activity even without a timestamp change");
    assert.equal(current().isMessageListFollowing, false);
    assert.equal(list.scrollTop, 200);
    await render("aux");
    assert.equal(current().hasNewActivity, false, "new activity belongs to Main only");
    rowTop = 80;
    rowHeight = 200;
    await render();
    assert.equal(current().hasNewActivity, true);
    assert.equal(current().messageJumpRequest?.key, "session-main-0");
    assert.equal(current().messageJumpRequest?.offset, -22, "restore retains the latest reading offset after geometry changes");
    await act(async () => current().onJumpToBottom?.());
    assert.equal(current().hasNewActivity, false);
    await act(async () => list.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -10, bubbles: true })));
    await render("main", false);
    text = "modified";
    updatedAt = "2026-10-17T01:00:01.000Z";
    await render("main", false);
    await render();
    assert.equal(current().hasNewActivity, true, "same-length canonical update while hidden is identified by updatedAt");
    assert.equal(current().isMessageListFollowing, false);
    await act(async () => current().onJumpToBottom?.());
    assert.equal(current().hasNewActivity, false);
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
    sessionId: "aux", incarnationId: "inc", id: "steer", requestId: "request", sequence: 1, state: "queued", turnId: null, userMessageSeq: null,
    captured: { request: { userMessage: "needle", clientRequestId: "request", executionOptions: {
      catalogRevision: 1, model: "model", reasoningEffort: "medium", approvalMode: "never", codexSandboxMode: "read-only", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
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
    receipts = [{ sessionId: "aux", incarnationId: "inc", id: "next", requestId: "request", sequence: 2, state: "running", turnId: "2", userMessageSeq: 2,
      captured: { request: { userMessage: "second", clientRequestId: "request", executionOptions: {
        catalogRevision: 1, model: "model", reasoningEffort: "medium", approvalMode: "never", codexSandboxMode: "read-only", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
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
    receipts = [{ ...receipts[0], id: "third", requestId: "third-request", sequence: 3, turnId: "3", userMessageSeq: 4,
      captured: { ...receipts[0].captured, request: { ...receipts[0].captured.request, clientRequestId: "third-request", userMessage: "third" } } }];
    await act(async () => { changed?.("aux"); root?.render(React.createElement(Probe, { live: run("third response", "third"), saved: thirdUser })); });
    assert.equal(column().pendingResponseMessageKey, column().messageKeys?.[5]);
    const inputReceipt: SessionTurnQueueReceipt = { ...receipts[0], id: "steer", requestId: "steer-request", sequence: 4, state: "queued", turnId: null, userMessageSeq: null,
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
// claim = "Main/AuxのSendはreceipt未取得からpromptと通常待機枠を描画し、ACK・開始・終端先着・追加入力userを含むcanonical到着を同じrequestで橋渡しする。次の予約は前応答の後ろを維持し、明示失敗は対象表示へ反映し、別ownerや旧incarnationへ漏らさない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 送信直後の先行表示; docs/design/auxiliary-session.md: 送信受付の共通反映" }
// fault = "ACKまで枠を出さない、ACK/保存到着でpromptや枠を消す・二重化する、次予約を前応答より先に表示する、先行表示で実runを偽造する、または失敗をspinnerのまま隠す"
// observable = "実Column DOMのprompt件数・pending枠・alert・応答本文・予約の表示順、ColumnのisRunning/responsePending、storeの所有request"
// observation_boundary = "component-behavior"
// scope = "optimistic conversation submission handoff"
// lifecycle = "permanent"
// impact = "送信直後とデータ到着順により会話が飛び、失敗した要求を待ち続けたり別会話に誤表示したりする"
// distinction = "operation通知testはColumnの実購読とreceipt/canonical結合を通らない。小さいJSDOM遷移で正常・失敗・高速終端の継続契約を確認する"
// @end-test-value
test("conversation column bridges optimistic sends to receipts and canonical responses", async () => {
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
      const api: ConversationMessageColumnApi = {
        listSessionTurnQueue: () => holdQueue ? new Promise(() => {}) : Promise.resolve(active),
        getSessionTurnQueueReceipt: async (_id, requestId) => resolved?.requestId === requestId ? resolved : active.find((item) => item.requestId === requestId) ?? null,
        onSessionTurnQueueChanged: (listener) => { changed = listener; return () => { changed = undefined; }; },
      };
      let latest: SessionMessageColumnProps | null = null;
      let saved: SessionMessageColumnProps["messages"] = [];
      let live: LiveSessionRunState | null = null;
      function View() {
        latest = useConversationMessageColumn({
          session: { id: kind, incarnationId: "inc", messages: saved, runState: live?.runState ?? "idle" },
          baseProps: { ...createBaseProps(kind), turnSubmissions: store }, enabled: true, api, liveRun: live, messageSourceKind: kind,
        });
        return latest ? <SessionMessageColumn {...latest} /> : null;
      }
      const column = () => { assert.ok(latest); return latest; };
      const render = () => act(async () => { root.render(<View key={kind} />); });
      const promptCount = () => [...dom.window.document.querySelectorAll(".message-row.user")].filter((row) => row.textContent?.includes("captured prompt")).length;
      const pendingCount = () => dom.window.document.querySelectorAll(".pending-row").length;
      const start = () => store.start({ sessionId: kind, incarnationId: "inc", requestId: "request", userMessage: "captured prompt", historyMessageCount: 0, queuedBehindRun: false, error: "" });
      const receipt: SessionTurnQueueReceipt = {
        sessionId: kind, incarnationId: "inc", id: "receipt", requestId: "request", sequence: 1, state: "queued",
        captured: { request: { clientRequestId: "request", userMessage: "captured prompt", executionOptions: {
          catalogRevision: 1, model: "model", reasoningEffort: "medium", approvalMode: "on-request", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user", customAgentName: "",
        } }, attachments: [], provider: "codex", workspacePath: "workspace" },
        turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
      };
      await render();
      await act(async () => { start(); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      assert.equal(column().isRunning, false);
      assert.equal(column().responsePending, true);
      assert.equal(dom.window.document.querySelector("[role=alert]"), null);
      await act(async () => { store.fail("request", "Turn acceptance timed out. Check Receipt."); });
      assert.equal(promptCount(), 1);
      assert.match(dom.window.document.querySelector("[role=alert]")!.textContent!, /timed out/);
      assert.equal(dom.window.document.querySelector(".pending-row [role=status]"), null);
      await act(async () => { store.accept(receipt); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      assert.equal(dom.window.document.querySelector("[role=alert]"), null);
      holdQueue = false;
      active = [{ ...receipt, state: "starting" }];
      resolved = active[0];
      await act(async () => { changed?.(kind); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      active = [{ ...receipt, state: "running", turnId: "turn", userMessageSeq: 0 }];
      resolved = active[0];
      live = { sessionId: kind, threadId: "thread", turnId: "turn", runState: "running", assistantText: "", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 1);
      assert.equal(column().isRunning, true);
      saved = [{ role: "user", text: "captured prompt" }, { role: "user", text: "additional input in this turn" }];
      live = { ...live, assistantText: "streamed answer" };
      await render();
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 0, "the same response surface now owns streaming content");
      assert.equal(dom.window.document.querySelectorAll(".pending-response-content").length, 1);
      assert.match(dom.window.document.body.textContent!, /streamed answer/);
      resolved = { ...active[0], state: "completed" };
      active = [];
      live = null;
      await act(async () => { changed?.(kind); root.render(<View key={kind} />); });
      assert.equal(promptCount(), 1);
      assert.equal(pendingCount(), 0, "the streamed response keeps its surface while canonical saving catches up");
      assert.equal(dom.window.document.querySelectorAll(".pending-response-content").length, 1);
      assert.match(dom.window.document.body.textContent!, /streamed answer/);
      const nextReceipt = { ...receipt, id: "next-receipt", requestId: "next-request", sequence: 2,
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
      assert.equal(store.getSnapshot().length, 0);
      await act(async () => {
        store.start({ sessionId: "different", incarnationId: "inc", requestId: "other", userMessage: "wrong owner", historyMessageCount: 0, queuedBehindRun: false, error: "" });
        store.start({ sessionId: kind, incarnationId: "old", requestId: "old", userMessage: "old incarnation", historyMessageCount: 0, queuedBehindRun: false, error: "" });
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
// claim = "MainとAuxiliaryの承認・入力応答後、遅い再取得は後着の要求を消さず、競合のない再取得は解決済み要求を消す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 表示言語・操作・状態" }
// fault = "応答後の古いlive snapshotが購読で届いた次の要求を上書きする、または通常の再取得で解決済み要求が残る"
// observable = "各会話列のliveApprovalRequest・liveElicitationRequest・isRunning"
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
    resolveLiveElicitation: async () => {},
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
        auxiliary = useConversationMessageColumn({ session: { id: "aux", runState: "running" }, baseProps: createBaseProps("aux"), enabled: true, api });
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
      await act(async () => emit(scenario.sessionId, first));
      await act(async () => {
        scenario.kind === "approval"
          ? column()?.onResolveLiveApproval(first.approvalRequest!, "approve")
          : column()?.onResolveLiveElicitation(first.elicitationRequest!, { action: "accept" });
        await Promise.resolve();
      });
      assert.ok(fetchResolvers.has(scenario.sessionId));
      await act(async () => emit(scenario.sessionId, second));
      await act(async () => {
        fetchResolvers.get(scenario.sessionId)?.(scenario.stale);
        await Promise.resolve();
      });
      const currentRequest = scenario.kind === "approval" ? column()?.liveApprovalRequest : column()?.liveElicitationRequest;
      assert.equal(currentRequest?.requestId, "r2", `${scenario.sessionId} must retain the later request`);
      assert.equal(column()?.isRunning, true);

      await act(async () => {
        scenario.kind === "approval"
          ? column()?.onResolveLiveApproval(second.approvalRequest!, "approve")
          : column()?.onResolveLiveElicitation(second.elicitationRequest!, { action: "accept" });
        await Promise.resolve();
      });
      await act(async () => {
        fetchResolvers.get(scenario.sessionId)?.(createRun(scenario.sessionId, null));
        await Promise.resolve();
      });
      assert.equal(column()?.liveApprovalRequest, null);
      assert.equal(column()?.liveElicitationRequest, null);
      assert.equal(column()?.isRunning, true);
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
