import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, type UIEvent } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useConversationMessageColumn,
  type ConversationColumnCache,
  type ConversationMessageColumnApi,
} from "../../src/chat/conversation-message-column.js";
import type { SessionMessageColumnProps } from "../../src/session-components.js";

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
    getChangedFilesEmptyText: () => "",
  };
}

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
