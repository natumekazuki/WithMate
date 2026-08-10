import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatDockSplitter, ChatWindow, ChatWindowStatusScreen, type ChatWindowProps } from "../../src/chat/chat-window.js";
import {
  createHiddenControlsTextChatComposerProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  createStaticTextConversationMessageColumnProps,
} from "../../src/chat/chat-window-adapter.js";
import { SessionActionDockCompactRow, SessionChatScreen } from "../../src/session-components.js";

const noop = () => {};

function createChatWindowProps(
  overrides: Partial<ChatWindowProps["messageColumnProps"]> = {},
): ChatWindowProps {
  const draft = "";
  return {
    mode: "agent",
    headerSplitter: null,
    actionDockSplitter: null,
    layoutPriority: "dock-first",
    rightPane: null,
    splitter: null,
    isHeaderExpanded: true,
    headerProps: createStaticChatHeaderProps({ taskTitle: "Test chat", isRunning: false }),
    messageColumnProps: createStaticTextConversationMessageColumnProps({
      sessionId: "chat-1",
      characterId: "character-1",
      characterName: "Character",
      characterIconPath: "",
      messages: [{ role: "mate", text: "[label](https://example.test/source)" }],
      messageListRef: React.createRef<HTMLDivElement>(),
      isRunning: false,
      onQuoteMessageText: noop,
      ...overrides,
    }),
    isActionDockExpanded: true,
    composerProps: createHiddenControlsTextChatComposerProps({
      draft,
      isRunning: false,
      feedback: "",
      composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
      modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
      selectedModel: "gpt-test",
      selectedModelFallbackLabel: "GPT Test",
      reasoningOptions: [{ value: "low", label: "low" }],
      selectedReasoningEffort: "low",
      onDraftChange: noop,
      onDraftKeyDown: noop,
      onSendOrCancel: noop,
      onChangeModel: noop,
      onChangeReasoningEffort: noop,
    }),
    compactActionDockProps: createStaticTextChatCompactActionDockProps({
      draft,
      isRunning: false,
      onSendOrCancel: noop,
    }),
  };
}

test("ChatWindowStatusScreen は Session 共通 shell で状態表示をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWindowStatusScreen, { message: "準備しています。" }));

  assert.match(html, /<main class="page-shell session-page">/);
  assert.match(html, /<section class="session-work-surface chat-panel" aria-live="polite">/);
  assert.match(html, /<p class="session-message-empty">準備しています。<\/p>/);
  assert.doesNotMatch(html, /session-plain/);
});

test("ChatWindow は preview と compact ActionDock の間に recovery actions を維持する", () => {
  const props = createChatWindowProps();
  props.mainContent = React.createElement("div", null, "File Preview");
  props.recoveryActions = React.createElement("div", null, "Retry Actions");
  props.isActionDockExpanded = false;

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /class="session-recovery-actions-slot"><div>Retry Actions<\/div>/);
  assert.match(html, /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/);
  assert.ok(html.indexOf("File Preview") < html.indexOf("Retry Actions"));
  assert.ok(html.indexOf("Retry Actions") < html.indexOf("session-action-dock-slot"));
});

test("ChatWindow は Quote 対応 chat の表示 mode を message column と ActionDock で共有する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(ChatWindow, createChatWindowProps({
        messages: [],
        isRunning: true,
        pendingMessageText: "[label](https://example.test/source)",
      })));
    });
    const sourceButton = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".composer-message-view-mode-button",
    )).find((button) => button.textContent === "Source");
    assert.ok(sourceButton);
    assert.ok(dom.window.document.querySelector("[data-pending-message-body='true'] a"));

    await act(async () => sourceButton.click());

    const source = dom.window.document.querySelector("[data-pending-message-body='true'] > .message-body");
    assert.equal(source?.textContent, "[label](https://example.test/source)");
    assert.equal(dom.window.document.querySelector("[data-pending-message-body='true'] a"), null);
    assert.equal(sourceButton.getAttribute("aria-pressed"), "true");
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: previousResizeObserver });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
  }
});

test("ChatWindow は Quote 非対応 chat に表示 mode controls を出さない", () => {
  const html = renderToStaticMarkup(React.createElement(ChatWindow, createChatWindowProps({
    onQuoteMessageText: undefined,
  })));

  assert.doesNotMatch(html, /Message display mode/);
  assert.doesNotMatch(html, />Source<\/button>/);
});

test("ChatDockSplitter は resize handler がない場合に静的 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(React.createElement(ChatDockSplitter, { edge: "right" }));

  assert.equal(html, '<div class="session-dock-splitter edge-right is-static" aria-hidden="true"></div>');
});

test("ChatDockSplitter は resize handler がある場合に操作可能 splitter をレンダリングする", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "right",
      isActive: true,
      onPointerDown() {},
    }),
  );

  assert.match(html, /<button class="session-dock-splitter edge-right is-active" type="button"/);
  assert.match(html, /aria-label="右ペインのサイズを調整"/);
  assert.match(html, /title="右ペインのサイズをドラッグで調整"/);
});

test("ChatDockSplitter は各辺の表示状態を切り替える affordance を示す", () => {
  const expandedHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "right",
      isPanelExpanded: true,
      onPointerDown() {},
      onTogglePanel() {},
    }),
  );
  const collapsedHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "bottom",
      isPanelExpanded: false,
      onTogglePanel() {},
    }),
  );
  const fixedHeaderHtml = renderToStaticMarkup(
    React.createElement(ChatDockSplitter, {
      edge: "top",
      isPanelExpanded: true,
      onTogglePanel() {},
    }),
  );

  assert.match(expandedHtml, /aria-label="右ペインを折りたたむ"/);
  assert.match(expandedHtml, /aria-controls="session-right-pane"/);
  assert.match(expandedHtml, /aria-expanded="true"/);
  assert.match(expandedHtml, /クリックで右ペインを折りたたみ、ドラッグでサイズを調整/);
  assert.match(expandedHtml, /session-dock-splitter-chevron direction-right/);
  assert.match(expandedHtml, /<svg viewBox="0 0 12 12" focusable="false">/);
  assert.match(expandedHtml, /<path d="M4 2.5 8 6 4 9.5"><\/path>/);

  assert.match(collapsedHtml, /class="session-dock-splitter edge-bottom is-toggle-only is-collapsed"/);
  assert.match(collapsedHtml, /aria-label="ActionDockを展開"/);
  assert.match(collapsedHtml, /aria-controls="session-action-dock"/);
  assert.match(collapsedHtml, /aria-expanded="false"/);
  assert.match(collapsedHtml, /session-dock-splitter-chevron direction-up/);

  assert.match(fixedHeaderHtml, /class="session-dock-splitter edge-top is-toggle-only"/);
  assert.match(fixedHeaderHtml, /title="クリックでヘッダーを折りたたみ"/);
  assert.doesNotMatch(fixedHeaderHtml, /ドラッグでサイズを調整/);
});

test("SessionChatScreen は左右ペインを mounted のまま非表示・操作不可にする", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionChatScreen, {
      mode: "agent",
      header: null,
      headerSplitter: React.createElement("button", { type: "button" }, "Header Toggle"),
      isHeaderVisible: false,
      messageColumn: React.createElement("div", null, "Messages"),
      mainContent: React.createElement("div", null, "File Preview"),
      actionDock: React.createElement("div", null, "Composer"),
      actionDockSplitter: React.createElement("button", { type: "button" }, "Dock Toggle"),
      isActionDockExpanded: false,
      layoutPriority: "side-pane-first",
      splitter: React.createElement("button", { type: "button" }, "Toggle"),
      rightPane: React.createElement("aside", null, "Latest Command"),
      isRightPaneVisible: false,
    }),
  );

  assert.match(html, /class="page-shell session-page session-chat-layout layout-priority-side-pane/);
  assert.match(html, /id="session-header-dock"[^>]*class="session-header-dock-slot is-hidden"[^>]*aria-hidden="true"/);
  assert.match(html, /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/);
  assert.match(html, /id="session-left-pane" class="session-left-pane-slot is-hidden" aria-hidden="true" inert=""/);
  assert.match(html, /id="session-right-pane" class="session-right-pane-slot is-hidden" aria-hidden="true" inert=""/);
  assert.match(html, /class="session-central-surface" hidden=""><div>Messages<\/div><\/div>/);
  assert.match(html, /class="session-central-surface"><div>File Preview<\/div><\/div>/);
  assert.match(html, /<div>Composer<\/div>/);
  assert.match(html, /Latest Command/);
});

test("ChatDockSplitter は pointer と keyboard click の操作軸を通知する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
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
  const activations: string[] = [];
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(
        "div",
        null,
        React.createElement(ChatDockSplitter, {
          edge: "left",
          onActivate: () => activations.push("side"),
          onTogglePanel() {},
        }),
        React.createElement(ChatDockSplitter, {
          edge: "bottom",
          onActivate: () => activations.push("dock"),
          onTogglePanel() {},
        }),
      ));
    });
    const leftSplitter = dom.window.document.querySelector<HTMLButtonElement>(".edge-left");
    const bottomSplitter = dom.window.document.querySelector<HTMLButtonElement>(".edge-bottom");
    assert.ok(leftSplitter);
    assert.ok(bottomSplitter);

    await act(async () => {
      leftSplitter.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await act(async () => bottomSplitter.click());

    assert.deepEqual(activations, ["side", "dock"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
  }
});

test("SessionChatScreen は dock 優先を layout class へ投影する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionChatScreen, {
      mode: "agent",
      header: null,
      headerSplitter: null,
      isHeaderVisible: false,
      messageColumn: null,
      actionDock: null,
      actionDockSplitter: null,
      isActionDockExpanded: false,
      layoutPriority: "dock-first",
      splitter: null,
      rightPane: null,
    }),
  );

  assert.match(html, /layout-priority-dock/);
});

test("SessionActionDockCompactRow は preview 中の chat notice を表示する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      draft: "",
      actionDockCompactPreview: "下書きなし",
      attachmentCount: 0,
      isRunning: false,
      chatNotice: "New messages",
      isSendDisabled: true,
      showJumpToBottom: false,
      onExpand() {},
      onJumpToBottom() {},
      onSendOrCancel() {},
    }),
  );

  assert.match(html, /session-action-dock-compact-badge attention/);
  assert.match(html, />New messages<\/span>/);
  assert.match(html, /<button class="session-action-dock-compact-preview"[^>]*>/);
});
