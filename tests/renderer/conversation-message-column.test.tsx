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
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { ConversationPage } from "../../src-shared/session/conversation-page.js";

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
    await act(async () => latest?.conversationPaging?.onEarlier?.());
    assert.deepEqual(requests, [110]);
    await act(async () => resolvePage?.({ sessionId: "main", incarnationId: "main", startIndex: 110, totalCount: 200, messages: messages(110) }));
    assert.equal(getLatest()?.messages.length, 60);
    assert.equal(getLatest()?.messageKeys?.[0], "session-main-110");
    await act(async () => root?.render(React.createElement(Probe, { id: "main", text: "live updated" })));
    assert.equal(getLatest()?.messages.at(-1)?.text, "message 169");
    assert.equal(getLatest()?.isRunning, false);
    await act(async () => latest?.conversationPaging?.onEarlier?.());
    const stale = resolvePage;
    await act(async () => root?.render(React.createElement(Probe, { id: "other", text: "other live" })));
    assert.equal(cache.get("main")?.liveRun, null);
    assert.deepEqual(cache.get("main")?.bridge, { sessionId: "main", threadId: "thread", messageIndex: 200 });
    await act(async () => stale?.({ sessionId: "main", incarnationId: "main", startIndex: 80, totalCount: 200, messages: messages(80) }));
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
// observable = "最後に選んだmessage keyの存在、pageのstartIndex、messageJumpRequestのkey、読込完了状態"
// observation_boundary = "component-behavior"
// scope = "conversation-navigation-latest-intent"
// lifecycle = "permanent"
// impact = "MessagesとBookmark一覧から最後に選択した本文を読み続けられる"
// distinction = "会話owner testは別会話への遅延応答を検証するが、同一会話内の連続移動と完了順の競合を通らない"
// @end-test-value
test("conversation navigator は連続選択の最後の移動先を保持する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
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
    assert.equal(column.conversationPaging?.startIndex, startIndex);
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
// observable = "最後に選んだmessage keyの存在、pageのstartIndex、読込完了状態"
// observation_boundary = "component-behavior"
// scope = "conversation-find-latest-intent"
// lifecycle = "permanent"
// impact = "Findの連続移動で最後に選択した検索結果を読み続けられる"
// distinction = "navigator testはonJumpToMessageを通るが、Find専用のonLoadMessagePageの連続選択を通らない"
// @end-test-value
test("conversation Find は連続選択の最後の読込済み本文を保持する", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
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
    assert.equal(getLatest().conversationPaging?.startIndex, 140);
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
// oracle = { type = "contract", ref = "issue-710-conversation-live-ownership" }
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
      listeners.forEach((listener) => listener("main", { assistantText: "main live", approvalRequest: { requestId: "request-main" } }));
      listeners.forEach((listener) => listener("aux", { assistantText: "aux live", approvalRequest: { requestId: "request-aux" } }));
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
// claim = "conversation columnがscroll following状態と送信時追従操作をcontrolsへ公開する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "列の内部hookがscroll状態または送信時追従操作をcontrolsへ渡さない"
// observable = "column controlsのisMessageListFollowingとhandleMessageListSend"
// observation_boundary = "component-behavior"
// scope = "conversation-message-column"
// lifecycle = "permanent"
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
  let root: Root | null = null;
  let latest: ReturnType<typeof useConversationMessageColumn> = null;
  let controls = {
    isMessageListFollowing: false,
    handleMessageListSend: (_scrollToLatestOnSend: boolean) => {},
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
    assert.equal(controls?.isMessageListFollowing, false);

    await act(async () => controls?.handleMessageListSend(false));
    assert.equal(controls?.isMessageListFollowing, false);
    await act(async () => controls?.handleMessageListSend(true));
    assert.equal(controls?.isMessageListFollowing, true);
    assert.equal(element.scrollTop, 60);
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
