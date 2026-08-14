import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChatDockSplitter,
  ChatAdditionalDirectoryList,
  ChatSkillPickerPanel,
  ChatWindow,
  ChatWindowStatusScreen,
  filterChatSkillItems,
  type ChatWindowProps,
} from "../../src/chat/chat-window.js";
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

test("ChatWindow は ActionDock の展開状態に依存しない共通エラー領域を描画する", () => {
  const props = createChatWindowProps();
  props.isActionDockExpanded = false;
  props.composerProps = {
    ...props.composerProps,
    composerSendability: {
      primaryFeedback: "Path not found: C:/missing",
      secondaryFeedback: ["Expected a file: C:/directory"],
      feedbackTone: "blocked",
      shouldShowFeedback: true,
    },
  };
  props.errorNotices = [{
    id: "composer-sendability",
    message: "Path not found: C:/missing",
    details: ["Expected a file: C:/directory"],
    relatedControl: "composer",
  }];

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /class="chat-error-surface" role="region" aria-label="チャットエラー"/);
  assert.match(html, /class="chat-error-notice" role="alert"/);
  assert.match(html, /Path not found: C:\/missing/);
  assert.match(html, /Expected a file: C:\/directory/);
  assert.match(html, /<textarea[^>]*aria-describedby="[^"]+-notice-0"[^>]*aria-invalid="true"/);
  assert.doesNotMatch(html, /class="composer-sendability-feedback blocked"/);
  assert.match(html, /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/);
  assert.ok(html.indexOf("session-central-surface") < html.indexOf("chat-error-surface"));
  assert.ok(html.indexOf("chat-error-surface") < html.indexOf("session-action-dock-slot"));
});

test("ChatWindow の共通エラー領域は owner が指定したdismissと回復操作を表示する", () => {
  const props = createChatWindowProps();
  props.errorNotices = [{
    id: "workspace-unavailable",
    message: "Workspace unavailable.",
    dismissLabel: "Workspaceエラーを閉じる",
    onDismiss: noop,
    actionLabel: "Recheck",
    onAction: noop,
  }];

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /class="drawer-toggle compact secondary"[^>]*>Recheck<\/button>/);
  assert.match(html, /aria-label="Workspaceエラーを閉じる"/);
});

test("chat work surface は補助情報と共通エラーの有無に関係なく中央contentへ可変領域を割り当てる", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const stackRule = styles.match(/\.session-message-stack\s*\{([^}]*)\}/)?.[1] ?? "";
  const errorRule = styles.match(/\.chat-error-surface\s*\{([^}]*)\}/)?.[1] ?? "";
  const centralRule = styles.match(/\.session-central-surface\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(stackRule, /grid-template-rows:\s*minmax\(0, 1fr\) auto auto auto/);
  assert.match(errorRule, /grid-row:\s*4/);
  assert.match(errorRule, /padding:\s*0 12px 12px/);
  assert.match(centralRule, /grid-row:\s*1/);
});

test("ChatWindow は追加Directory一覧をActionDock外の共通work surfaceへ描画する", () => {
  const props = createChatWindowProps();
  props.isActionDockExpanded = false;
  props.additionalDirectoryListProps = {
    isOpen: true,
    items: [{
      key: "C:/shared/docs",
      path: "C:/shared/docs",
      primaryLabel: "docs",
      secondaryLabel: "C:/shared",
      title: "C:/shared/docs",
      canRemove: true,
    }],
    isInteractionDisabled: false,
    onRemove: noop,
  };

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /class="chat-additional-directory-surface"/);
  assert.match(html, /aria-label="許可中の追加Directory"/);
  assert.doesNotMatch(html, /composer-additional-directory-list/);
  assert.ok(html.indexOf("chat-additional-directory-surface") < html.indexOf("session-action-dock-slot"));
  assert.match(html, /id="session-action-dock"[^>]*class="session-action-dock-slot is-compact"/);
});

test("ChatAdditionalDirectoryList は削除可否とdisabled状態を投影する", () => {
  const html = renderToStaticMarkup(React.createElement(ChatAdditionalDirectoryList, {
    isOpen: true,
    items: [
      {
        key: "C:/shared/removable",
        path: "C:/shared/removable",
        primaryLabel: "removable",
        secondaryLabel: "C:/shared",
        title: "C:/shared/removable",
        canRemove: true,
      },
      {
        key: "C:/shared/allowed",
        path: "C:/shared/allowed",
        primaryLabel: "allowed",
        secondaryLabel: "C:/shared",
        title: "C:/shared/allowed",
        canRemove: false,
      },
    ],
    isInteractionDisabled: true,
    onRemove: noop,
  }));

  assert.match(html, /class="chat-additional-directory-remove" disabled=""/);
  assert.match(html, /aria-label="removable を削除"/);
  assert.match(html, /class="chat-additional-directory-readonly">許可中/);
});

test("ChatWindow は preview を保持したまま Skill 候補を中央 work surface に重ねる", () => {
  const props = createChatWindowProps();
  props.mainContent = React.createElement("div", null, "File Preview");
  props.skillPickerProps = {
    isOpen: true,
    isLoading: false,
    items: [{
      key: "skill-review",
      skillId: "review",
      primaryLabel: "review",
      secondaryLabel: "Workspace",
      title: "review",
    }],
    onSelectSkill: noop,
    onDismiss: noop,
  };

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /class="session-central-surface"><div>File Preview<\/div><\/div>/);
  assert.match(html, /class="chat-skill-picker-layer"/);
  assert.match(html, /role="listbox"/);
  assert.ok(html.indexOf("File Preview") < html.indexOf("chat-skill-picker-layer"));
  assert.ok(html.indexOf("chat-skill-picker-layer") < html.indexOf("session-action-dock-slot"));
});

test("Skill候補panelはchat work surfaceのほぼ全体を使う", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const layerRule = styles.match(/\.chat-skill-picker-layer\s*\{([^}]*)\}/)?.[1] ?? "";
  const panelRule = styles.match(/\.chat-skill-picker-panel\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(layerRule, /inset:\s*0/);
  assert.match(layerRule, /padding:\s*clamp\(6px,\s*1vw,\s*12px\)/);
  assert.match(panelRule, /width:\s*100%/);
  assert.match(panelRule, /height:\s*100%/);
  assert.doesNotMatch(panelRule, /max-height/);
});

test("ChatSkillPickerPanel は loading・empty・error状態を区別する", () => {
  const commonProps = {
    isOpen: true,
    items: [],
    onSelectSkill: noop,
    onDismiss: noop,
  };
  const loadingHtml = renderToStaticMarkup(React.createElement(ChatSkillPickerPanel, {
    ...commonProps,
    isLoading: true,
  }));
  const emptyHtml = renderToStaticMarkup(React.createElement(ChatSkillPickerPanel, {
    ...commonProps,
    isLoading: false,
  }));
  const errorHtml = renderToStaticMarkup(React.createElement(ChatSkillPickerPanel, {
    ...commonProps,
    isLoading: false,
    errorMessage: "Skill error",
  }));

  assert.match(loadingHtml, /role="status"/);
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /chat-skill-picker-spinner/);
  assert.match(emptyHtml, /使える Skill がありません/);
  assert.match(errorHtml, /class="chat-skill-picker-state error">Skill error/);
});

test("Skill候補検索はnameとdescriptionを対象にしsource labelを対象にしない", () => {
  const items = [
    {
      key: "skill-a",
      skillId: "a",
      primaryLabel: "Audit",
      secondaryLabel: "Provider · Review completed work",
      title: "Audit",
      searchText: "Audit\nReview completed work",
    },
    {
      key: "skill-b",
      skillId: "b",
      primaryLabel: "Commit",
      secondaryLabel: "Workspace · Create a commit note",
      title: "Commit",
      searchText: "Commit\nCreate a commit note",
    },
  ];

  assert.deepEqual(filterChatSkillItems(items, "audit"), [items[0]]);
  assert.deepEqual(filterChatSkillItems(items, "commit note"), [items[1]]);
  assert.deepEqual(filterChatSkillItems(items, "provider"), []);
  assert.equal(filterChatSkillItems(items, "missing").length, 0);
});

test("ChatWindow の Skill panel は矢印・Enter・Escapeとfocus復帰を扱う", async () => {
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });

  const selected: string[] = [];
  let dismissCount = 0;
  let root: Root | null = null;
  const items = [
    {
      key: "skill-a",
      skillId: "a",
      primaryLabel: "A",
      secondaryLabel: "Workspace · First description",
      title: "A",
      searchText: "A\nFirst description",
    },
    {
      key: "skill-b",
      skillId: "b",
      primaryLabel: "B",
      secondaryLabel: "Provider · Second description",
      title: "B",
      searchText: "B\nSecond description",
    },
  ];

  function SkillPickerHarness() {
    const [isOpen, setIsOpen] = React.useState(false);
    const props = createChatWindowProps();
    props.composerProps = {
      ...props.composerProps,
      showSkillPicker: true,
      isSkillPickerOpen: isOpen,
      onToggleSkillPicker: () => setIsOpen((current) => !current),
    };
    props.skillPickerProps = {
      isOpen,
      isLoading: false,
      items,
      onSelectSkill: (skillId) => {
        selected.push(skillId);
        setIsOpen(false);
      },
      onDismiss: () => {
        dismissCount += 1;
        setIsOpen(false);
      },
    };
    return React.createElement(ChatWindow, props);
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(SkillPickerHarness));
    });
    const skillButton = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Skill");
    assert.ok(skillButton);

    await act(async () => skillButton.click());
    const searchInput = dom.window.document.querySelector<HTMLInputElement>(".chat-skill-picker-search");
    assert.ok(searchInput);
    assert.equal(dom.window.document.activeElement, searchInput);

    const options = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("[role='option']"));
    assert.equal(options.length, 2);

    await act(async () => {
      searchInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    assert.equal(dom.window.document.activeElement, options[0]);

    await act(async () => {
      options[0]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(selected, ["a"]);
    assert.equal(dom.window.document.querySelector(".chat-skill-picker-panel"), null);
    assert.equal(dom.window.document.activeElement, skillButton);

    await act(async () => skillButton.click());
    const reopenedSearchInput = dom.window.document.querySelector<HTMLInputElement>(".chat-skill-picker-search");
    assert.ok(reopenedSearchInput);
    assert.equal(reopenedSearchInput.value, "");
    await act(async () => {
      reopenedSearchInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(dismissCount, 1);
    assert.equal(dom.window.document.activeElement, skillButton);
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
