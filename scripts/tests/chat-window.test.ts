import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChatDockSplitter,
  ConcurrentChatSplitter,
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
import { SessionSwitcher } from "../../src/chat/session-switcher.js";
import { createAuxiliaryHeaderActions } from "../../src/chat/chat-header-actions.js";

const noop = () => {};

// @test-value v2
// kind = "contract"
// claim = "既存Auxiliaryがあっても新規追加ボタンは終了処理を呼ばず追加処理を呼ぶ"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 新規追加" }
// fault = "既存会話の終了制約を新規追加のdisabled条件に流用する"
// observable = "active時のNew Auxiliaryクリック後の追加／終了callback呼出し"
// observation_boundary = "component-behavior"
// scope = "auxiliary-header"
// lifecycle = "permanent"
// @end-test-value
test("createAuxiliaryHeaderActions は active 時も新規追加を呼ぶ", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const calls: string[] = [];
  try {
    await act(async () => root.render(createAuxiliaryHeaderActions({
      onStart: () => calls.push("start"),
    })));
    const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "New Auxiliary");
    assert.ok(button);
    assert.equal(button.disabled, false);
    await act(async () => button.click());
    assert.deepEqual(calls, ["start"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previousWindow },
      document: { configurable: true, value: previousDocument },
    });
  }
});

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
    compactActionDockProps: createStaticTextChatCompactActionDockProps({}),
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

test("ChatWindow は submit pending を非表示の busy status として通知し、エラー表示しない", () => {
  const props = createChatWindowProps();
  props.composerProps = {
    ...props.composerProps,
    isComposerDisabled: true,
    composerSendability: {
      isBusy: true,
      busyReason: "Message submission is in progress.",
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
  };

  const html = renderToStaticMarkup(React.createElement(ChatWindow, props));

  assert.match(html, /<textarea[^>]*disabled=""[^>]*aria-busy="true"/);
  assert.match(html, /class="visually-hidden" role="status"[^>]*>Message submission is in progress\.<\/span>/);
  assert.doesNotMatch(html, /chat-error-surface/);
  assert.doesNotMatch(html, /composer-sendability-feedback/);
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

test("ChatWindow は Skill 候補を中央 work surface overlayとして描画する", () => {
  const props = createChatWindowProps();
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

  assert.match(html, /class="chat-skill-picker-layer"/);
  assert.match(html, /role="listbox"/);
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
  assert.match(loadingHtml, /class="surface-close-button"/);
  assert.match(loadingHtml, /aria-label="Close skill picker">×<\/button>/);
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

test("ChatWindow は button とshortcutで共有表示modeを双方向に切り替える", async () => {
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

  let root: Root | null = null;
  try {
    let expandCallCount = 0;
    const props = createChatWindowProps({
      messages: [],
      isRunning: true,
      pendingMessageText: "[label](https://example.test/source)",
    });
    props.isActionDockExpanded = false;
    props.compactActionDockProps = {
      ...props.compactActionDockProps,
      onExpand: () => {
        expandCallCount += 1;
      },
    };
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(ChatWindow, props));
    });
    const sourceButton = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(
      ".session-action-dock-compact-content .composer-message-view-mode-button",
    )).find((button) => button.textContent === "Source");
    assert.ok(sourceButton);
    assert.ok(dom.window.document.querySelector("[data-pending-message-body='true'] a"));

    const composerTextarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea");
    assert.ok(composerTextarea);
    composerTextarea.focus();
    const editingShortcutEvent = new dom.window.KeyboardEvent("keydown", {
      key: "K",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => composerTextarea.dispatchEvent(editingShortcutEvent));
    assert.equal(editingShortcutEvent.defaultPrevented, false);
    assert.ok(dom.window.document.querySelector("[data-pending-message-body='true'] a"));

    const expandButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".session-action-dock-compact-content .session-action-dock-compact-expand-button",
    );
    assert.ok(expandButton);
    await act(async () => expandButton.click());
    assert.equal(expandCallCount, 1);

    await act(async () => sourceButton.click());

    const source = dom.window.document.querySelector("[data-pending-message-body='true'] > .message-body");
    assert.equal(source?.textContent, "[label](https://example.test/source)");
    assert.equal(dom.window.document.querySelector("[data-pending-message-body='true'] a"), null);
    assert.equal(sourceButton.getAttribute("aria-pressed"), "true");
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-action-dock-expanded-content .composer-message-view-mode-button:last-child",
      )?.getAttribute("aria-pressed"),
      "true",
    );

    const sourceText = source?.firstChild;
    assert.ok(sourceText);
    const selection = dom.window.getSelection();
    assert.ok(selection);
    const range = dom.window.document.createRange();
    range.selectNodeContents(sourceText);
    selection.addRange(range);
    assert.equal(selection.rangeCount, 1);

    const shortcutEvent = new dom.window.KeyboardEvent("keydown", {
      key: "K",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => dom.window.document.body.dispatchEvent(shortcutEvent));
    assert.equal(shortcutEvent.defaultPrevented, true);
    assert.equal(selection.rangeCount, 0);
    assert.ok(dom.window.document.querySelector("[data-pending-message-body='true'] a"));
    assert.equal(sourceButton.getAttribute("aria-pressed"), "false");
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(
        ".session-action-dock-expanded-content .composer-message-view-mode-button:first-child",
      )?.getAttribute("aria-pressed"),
      "true",
    );

    const secondShortcutEvent = new dom.window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => dom.window.document.body.dispatchEvent(secondShortcutEvent));
    assert.equal(secondShortcutEvent.defaultPrevented, true);
    assert.equal(
      dom.window.document.querySelector("[data-pending-message-body='true'] > .message-body")?.textContent,
      "[label](https://example.test/source)",
    );
    assert.equal(sourceButton.getAttribute("aria-pressed"), "true");

    const rapidShortcutEvents = [0, 1].map(() => new dom.window.KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await act(async () => {
      for (const event of rapidShortcutEvents) {
        dom.window.document.body.dispatchEvent(event);
      }
    });
    assert.ok(rapidShortcutEvents.every((event) => event.defaultPrevented));
    assert.equal(
      dom.window.document.querySelector("[data-pending-message-body='true'] > .message-body")?.textContent,
      "[label](https://example.test/source)",
    );
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

// @test-value v1
// kind = "contract"
// claim = "SessionChatScreenは左ペインのCollapseと再表示で同じchild instanceとstateを保持する"
// oracle = { type = "contract", ref = "accepted behavior: preserve the complete left pane state while collapsed in the same Window" }
// failure_mode = "左ペインのCollapseでchildがunmountされ、再表示時にtab、tree、Git結果などのlocal stateが初期化される"
// scope = "SessionChatScreen left pane visibility lifecycle"
// lifecycle = "permanent"
// distinction = "Sessionやroot ownerの変更ではなく、同じWindow内の表示切替だけを検証する"
// @end-test-value
test("SessionChatScreen は左ペインのCollapse後もchild stateを保持する", async () => {
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

  function StatefulLeftPane() {
    const [count, setCount] = React.useState(0);
    return React.createElement("button", {
      type: "button",
      "data-left-pane-state": "true",
      onClick: () => setCount((current) => current + 1),
    }, `state:${count}`);
  }
  const renderScreen = (visible: boolean) => React.createElement(SessionChatScreen, {
    mode: "agent" as const,
    header: null,
    headerSplitter: null,
    isHeaderVisible: true,
    messageColumn: React.createElement("div", null, "Messages"),
    actionDock: React.createElement("div", null, "Composer"),
    actionDockSplitter: null,
    isActionDockExpanded: true,
    layoutPriority: "side-pane-first" as const,
    splitter: null,
    leftPane: React.createElement(StatefulLeftPane),
    isLeftPaneVisible: visible,
  });

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(renderScreen(true));
    });
    const button = dom.window.document.querySelector<HTMLButtonElement>("[data-left-pane-state='true']");
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(false)));
    assert.equal(dom.window.document.getElementById("session-left-pane")?.getAttribute("aria-hidden"), "true");
    assert.equal(dom.window.document.querySelector("[data-left-pane-state='true']"), button);
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(true)));
    assert.equal(dom.window.document.querySelector("[data-left-pane-state='true']"), button);
    assert.equal(button.textContent, "state:1");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    dom.window.close();
  }
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

// @test-value v2
// kind = "contract"
// claim = "Concurrent chat columns は保存幅が最小領域を下回っても実幅に合わせて補正し、利用可能幅不足では単体表示へ切り替える"
// oracle = { type = "contract", ref = "issue-710-concurrent-column-minimums" }
// fault = "保存されたAuxiliary幅がMain/Auxiliaryの最小幅を侵食する、または両方を表示できない幅で通常レイアウトを維持する"
// observable = "columnsのgridTemplateColumnsとis-single-chat class"
// observation_boundary = "component-behavior"
// scope = "SessionChatScreen concurrent columns"
// lifecycle = "permanent"
// @end-test-value
test("SessionChatScreen はConcurrent columnsの実幅不足を補正する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  let resizeCallback: (() => void) | null = null;
  class TestResizeObserver {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(SessionChatScreen, {
        mode: "agent",
        header: null,
        headerSplitter: null,
        isHeaderVisible: true,
        messageColumn: React.createElement("div", null, "Main"),
        auxiliaryMessageColumn: React.createElement("div", null, "Auxiliary"),
        auxiliarySplitter: React.createElement("button", { type: "button" }, "Splitter"),
        isAuxiliaryVisible: true,
        auxiliaryWidthRatio: 0.1,
        concurrentTarget: "main",
        actionDock: null,
        actionDockSplitter: null,
        isActionDockExpanded: true,
        layoutPriority: "dock-first",
        rightPane: null,
        splitter: null,
      }));
    });
    const columns = dom.window.document.querySelector<HTMLElement>(".session-concurrent-chat-columns");
    assert.ok(columns);
    const main = columns.querySelector<HTMLElement>(".session-concurrent-chat-main");
    const auxiliary = columns.querySelector<HTMLElement>(".session-concurrent-chat-auxiliary");
    assert.ok(main);
    assert.ok(auxiliary);
    main.style.setProperty("--session-region-min-width", "360px");
    auxiliary.style.setProperty("--session-region-min-width", "360px");
    columns.style.setProperty("--session-dock-splitter-size", "8px");
    Object.defineProperty(columns, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300 }),
    });
    await act(async () => resizeCallback?.());
    assert.doesNotMatch(columns.style.gridTemplateColumns, /0\.1fr/);
    assert.match(columns.style.gridTemplateColumns, /0\.45/);
    Object.defineProperty(columns, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 700, height: 300, top: 0, left: 0, right: 700, bottom: 300 }),
    });
    await act(async () => resizeCallback?.());
    assert.ok(columns.classList.contains("is-single-chat"));
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: previousResizeObserver });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Compact ActionDock は通常時の通知を維持しつつ不要な下書き表示を出さない"
// oracle = { type = "contract", ref = "chat-action-dock" }
// fault = "通常通知が消えるか、非送信状態に下書き表示を誤って出す"
// observable = "Compact ActionDockのrender済みHTML"
// observation_boundary = "component-behavior"
// scope = "chat-action-dock"
// lifecycle = "permanent"
// @end-test-value
test("SessionActionDockCompactRow は通常時の chat notice を下書き表示なしで維持する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      attachmentCount: 0,
      isRunning: false,
      chatNotice: "New messages",
      showJumpToBottom: false,
      onExpand() {},
      onJumpToBottom() {},
      onCancel() {},
    }),
  );

  assert.match(html, /session-action-dock-compact-badge attention/);
  assert.match(html, />New messages<\/span>/);
  assert.doesNotMatch(html, /Draft|下書きなし|>Send<\/button>/);
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent chat shell はActionDockのMain/Auxiliary操作対象、mode badgeなしの非対象overlay、Auxiliary一覧、独立splitterを同じWindowへ投影する"
// oracle = { type = "contract", ref = "issue-710-ui-shell" }
// fault = "Auxiliaryを表示しても対象切替や折りたたみ導線がActionDockと中央列へ接続されない"
// observable = "expanded/compact ActionDock操作対象ボタンとcallback、mode badgeの不在、非対象列内のoverlay、一覧trigger、splitterのARIA属性と会話列"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
test("ChatWindow は concurrent chat shell の操作対象と切り替え導線を描画する", async () => {
  const props = createChatWindowProps();
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
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  const targetChanges: Array<"main" | "auxiliary"> = [];
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(ChatWindow, {
        ...props,
        concurrentChats: {
          main: props.messageColumnProps,
          auxiliary: props.messageColumnProps,
          selectedAuxiliaryId: "aux-b",
          auxiliaryItems: [
            { id: "aux-a", label: "A", preview: "first preview", icon: "✦" },
            { id: "aux-b", label: "B", preview: "second preview", icon: "✧" },
          ],
          target: "auxiliary",
          widthRatio: 0.45,
          onSelectAuxiliary() {},
          onTargetChange: (target) => targetChanges.push(target),
          onWidthRatioChange() {},
        },
      }));
    });

    const container = dom.window.document.getElementById("root") as HTMLElement;
    const html = container.innerHTML;
    assert.match(html, /操作対象チャット/);
    assert.match(html, />Main<\/button>/);
    assert.match(html, />Auxiliary<\/button>/);
    assert.doesNotMatch(html, /action-dock-mode-badge/);
    assert.match(html, /concurrent-chat-target-overlay/);
    assert.equal((html.match(/concurrent-chat-target-overlay/g) ?? []).length, 1);
    assert.ok(container.querySelector(".composer-target-dock-slot .concurrent-chat-target-dock"));
    assert.equal(container.querySelector(".concurrent-chat-target-dock-slot"), null);
    assert.ok(container.querySelector(".session-concurrent-chat-main .concurrent-chat-target-overlay"));
    assert.equal(container.querySelector(".session-concurrent-chat-auxiliary .concurrent-chat-target-overlay"), null);
    assert.match(html, /Auxiliary会話切り替え/);
    assert.match(html, /session-auxiliary-chat-pane/);
    assert.match(html, /aria-controls="session-auxiliary-chat-pane"/);

    const targetDocks = [
      container.querySelector(".composer-target-dock-slot .concurrent-chat-target-dock"),
      container.querySelector(".session-action-dock-target-slot .concurrent-chat-target-dock"),
    ];
    assert.ok(targetDocks[0]);
    assert.ok(targetDocks[1]);
    for (const targetDock of targetDocks) {
      const targetButtons = [...targetDock.querySelectorAll<HTMLButtonElement>("button")];
      assert.deepEqual(targetButtons.map((button) => button.textContent), ["Main", "Auxiliary"]);
      await act(async () => targetButtons[0].click());
      await act(async () => targetButtons[1].click());
    }
    assert.deepEqual(targetChanges, ["main", "auxiliary", "main", "auxiliary"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: previousResizeObserver });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent ChatのCollapseは折りたたみ対象がない間はdisabledで、対象messageが追加されるとenabledになり、クリックで全対象を縮小する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: message collapse" }
// fault = "対象messageがない状態でCollapseを操作できる、対象追加後もdisabledのままになる、またはクリックしても対象messageが縮小されない"
// observable = "Collapse buttonのdisabled状態、New Auxiliaryとの順序、click後のmessage card縮小状態とExpand label"
// observation_boundary = "component-behavior"
// scope = "ChatWindow concurrent message collapse action"
// lifecycle = "permanent"
// impact = "利用可能な操作だけを有効化し、Main/Auxiliaryの表示内容をActionDockから一貫して操作できる"
// distinction = "静的render確認では列側の非同期control projectionとclick後のmessage縮小状態を同時に確認できない"
// @end-test-value
test("ChatWindowのCollapseは対象messageの有無に応じてdisabledを切り替え、クリックで縮小する", async () => {
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | null = null;
  const props = createChatWindowProps({ messages: [] });
  props.headerProps.actions = createAuxiliaryHeaderActions({ onStart: noop });
  const buildConcurrentChats = (messages: ChatWindowProps["messageColumnProps"]["messages"]) => ({
    mainSession: { id: "main", messages },
    auxiliarySession: null,
    main: { ...props.messageColumnProps, messages },
    auxiliary: null,
    selectedAuxiliaryId: null,
    auxiliaryItems: [],
    target: "main" as const,
    widthRatio: 0.45,
    onSelectAuxiliary() {},
    onTargetChange() {},
    onWidthRatioChange() {},
  });

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(ChatWindow, {
        ...props,
        concurrentChats: buildConcurrentChats([]),
      }));
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    let collapseButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Collapse");
    assert.ok(collapseButton);
    assert.equal(collapseButton.disabled, true);
    const newAuxiliaryButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "New Auxiliary");
    assert.ok(newAuxiliaryButton);
    assert.ok(collapseButton.compareDocumentPosition(newAuxiliaryButton) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);

    const messages = [{ role: "assistant" as const, text: "完了したmessage" }];
    await act(async () => {
      root?.render(React.createElement(ChatWindow, {
        ...props,
        concurrentChats: buildConcurrentChats(messages),
      }));
    });
    collapseButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Collapse");
    assert.ok(collapseButton);
    assert.equal(collapseButton.disabled, false);

    assert.ok(container.querySelector(".message-card.assistant"));
    await act(async () => collapseButton?.click());
    assert.ok(container.querySelector(".message-card.assistant.is-collapsed .message-collapsed-preview"));
    const expandedButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Expand");
    assert.ok(expandedButton);
    assert.equal(expandedButton.disabled, false);
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

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの幅0でも列とsplitterを残し、クリックで開く操作を提示する"
// oracle = { type = "contract", ref = "issue-710-zero-width-auxiliary" }
// fault = "Auxiliaryを幅0にするとsplitterが消えるか開く操作として提示されず、再表示できない"
// observable = "0frのgrid templateとsplitterのaria-expanded"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
test("ChatWindow はAuxiliaryを幅0で残しsplitterの再展開導線を表示する", () => {
  const props = createChatWindowProps();
  const html = renderToStaticMarkup(React.createElement(ChatWindow, {
    ...props,
    concurrentChats: {
      main: props.messageColumnProps,
      auxiliary: props.messageColumnProps,
      selectedAuxiliaryId: "aux-a",
      auxiliaryItems: [{ id: "aux-a", label: "A" }],
      target: "main",
      widthRatio: 0,
      onSelectAuxiliary() {},
      onTargetChange() {},
      onWidthRatioChange() {},
    },
  }));

  assert.match(html, /0fr/);
  assert.match(html, /aria-label="Auxiliaryを開く"/);
  assert.match(html, /aria-expanded="false"/);
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの読み込みエラー中もsummary switcherを保持し、Main targetから別Auxiliaryを選択できる"
// oracle = { type = "contract", ref = "issue-710-auxiliary-switcher-error" }
// fault = "Auxiliary detail errorがswitcherを消してしまい、Main表示中に別のAuxiliaryへ切り替えられない"
// observable = "switcher trigger、error region、Main/Auxiliary target button、別Auxiliary選択callbackのrender済みDOM"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
test("ChatWindow はAuxiliary detail error中もsummary switcherを維持する", async () => {
  const props = createChatWindowProps();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  let root: Root | null = null;
  const selected: string[] = [];
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(ChatWindow, {
        ...props,
        concurrentChats: {
          main: props.messageColumnProps,
          auxiliary: null,
          selectedAuxiliaryId: "aux-a",
          auxiliaryItems: [
            { id: "aux-a", label: "A", preview: "first" },
            { id: "aux-b", label: "B", preview: "second" },
          ],
          target: "main",
          widthRatio: 0.5,
          error: "Auxiliary detail failed",
          onSelectAuxiliary: (id) => selected.push(id),
          onTargetChange() {},
          onWidthRatioChange() {},
        },
      }));
    });

    assert.ok(dom.window.document.querySelector("[aria-label='Auxiliary会話切り替え']"));
    assert.match(dom.window.document.body.textContent ?? "", /Auxiliary detail failed/);
    assert.ok([...dom.window.document.querySelectorAll<HTMLButtonElement>(".concurrent-chat-target-dock button")]
      .some((button) => button.textContent === "Main"));
    assert.ok([...dom.window.document.querySelectorAll<HTMLButtonElement>(".concurrent-chat-target-dock button")]
      .some((button) => button.textContent === "Auxiliary"));
    assert.equal(dom.window.document.querySelector(".concurrent-chat-state")?.textContent, "Auxiliary detail failed");
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".session-switcher-current");
    assert.ok(trigger);
    await act(async () => trigger.click());
    const optionB = [...dom.window.document.querySelectorAll<HTMLButtonElement>("[role='option']")]
      .find((option) => option.textContent?.includes("B"));
    assert.ok(optionB);
    await act(async () => optionB.click());
    assert.deepEqual(selected, ["aux-b"]);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: previousResizeObserver });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
  }
});

// @test-value v2
// kind = "contract"
// claim = "ChatWindowはMain targetの末尾移動をメッセージ欄へ置き、Auxiliaryにも導線を表示して送信時追従を維持する"
// oracle = { type = "contract", ref = "issue-710-shared-scroll-following" }
// fault = "末尾移動がActionDockに残る、Auxiliaryの導線が欠ける、または送信時にMain列が末尾へ戻らない"
// observable = "Main/Auxiliary message listの末尾移動button、クリック後scrollTop、ActionDock全体、composer送信callback"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
test("ChatWindow はMain/Auxiliaryの末尾移動をメッセージ欄に表示し送信時追従を維持する", async () => {
  const props = createChatWindowProps({
    messages: [{ role: "mate", text: "message" }],
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousResizeObserver = globalThis.ResizeObserver;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { pretendToBeVisual: true });
  class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) {
      let parent = this.parentElement;
      while (parent && !parent.classList.contains("session-message-list")) {
        parent = parent.parentElement;
      }
      if (parent) {
        parent.scrollTop = Math.max(0, parent.scrollHeight - parent.clientHeight);
      }
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  let root: Root | null = null;
  let sendCount = 0;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(ChatWindow, {
        ...props,
        composerProps: {
          ...props.composerProps,
          draft: "send this",
          isSendDisabled: false,
          onSendOrCancel: () => { sendCount += 1; },
        },
        concurrentChats: {
          main: props.messageColumnProps,
          auxiliary: props.messageColumnProps,
          mainSession: { id: "main", messages: props.messageColumnProps.messages },
          auxiliarySession: { id: "aux", messages: props.messageColumnProps.messages },
          selectedAuxiliaryId: "aux",
          auxiliaryItems: [{ id: "aux", label: "Auxiliary", preview: "Auxiliary" }],
          target: "main",
          widthRatio: 0.5,
          scrollToLatestOnSend: true,
          onSelectAuxiliary() {},
          onTargetChange() {},
          onWidthRatioChange() {},
        },
      }));
    });
    const messageList = dom.window.document.querySelector<HTMLDivElement>(".session-concurrent-chat-main .session-message-list");
    assert.ok(messageList);
    Object.defineProperties(messageList, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
    });
    messageList.scrollTop = 10;
    await act(async () => messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));
    const mainJumpButton = dom.window.document.querySelector<HTMLButtonElement>(".session-concurrent-chat-main .message-list-jump-bottom-button");
    const auxiliaryJumpButton = dom.window.document.querySelector<HTMLButtonElement>(".session-concurrent-chat-auxiliary .message-list-jump-bottom-button");
    assert.ok(mainJumpButton);
    assert.ok(auxiliaryJumpButton);
    assert.equal(dom.window.document.querySelector(".session-action-dock .message-jump-bottom-button"), null);

    const auxiliaryMessageList = dom.window.document.querySelector<HTMLDivElement>(".session-concurrent-chat-auxiliary .session-message-list");
    assert.ok(auxiliaryMessageList);
    Object.defineProperties(auxiliaryMessageList, {
      scrollHeight: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
    });
    auxiliaryMessageList.scrollTop = 10;
    await act(async () => auxiliaryJumpButton.click());
    assert.equal(auxiliaryMessageList.scrollTop, 60);

    await act(async () => mainJumpButton.click());
    assert.equal(messageList.scrollTop, 60);
    messageList.scrollTop = 10;
    await act(async () => messageList.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));

    const sendButton = dom.window.document.querySelector<HTMLButtonElement>(".session-action-dock-expanded-content .session-send-button");
    assert.ok(sendButton);
    await act(async () => sendButton.click());
    assert.equal(sendCount, 1);
    assert.equal(messageList.scrollTop, 60);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: previousResizeObserver });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Concurrent splitter のクリックは幅0への縮小だけを行い、保存幅が最小未満でもドラッグ開始位置を実幅へ補正する"
// oracle = { type = "contract", ref = "issue-710-ui-shell" }
// fault = "splitterをドラッグして幅を変えた直後に幅0へ縮小される、最小幅を割り込む、またはクリックで幅0にならない"
// observable = "Main/AuxiliaryのCSS最小幅を反映したonWidthRatioChangeの値"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
test("ConcurrentChatSplitter は drag と collapse click を分離する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", { configurable: true, value() {} });
  let root: Root | null = null;
  const ratios: number[] = [];
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement("div", { style: { width: "1000px" } },
        React.createElement("div", { className: "session-concurrent-chat-main" }),
        React.createElement(ConcurrentChatSplitter, {
          widthRatio: 0.1,
          onWidthRatioChange: (ratio: number) => ratios.push(ratio),
        }),
        React.createElement("div", { className: "session-concurrent-chat-auxiliary" }),
      ));
    });
    const splitter = dom.window.document.querySelector<HTMLButtonElement>(".concurrent-chat-splitter");
    assert.ok(splitter);
    dom.window.document.querySelector<HTMLElement>(".session-concurrent-chat-main")?.style.setProperty("--session-region-min-width", "360px");
    dom.window.document.querySelector<HTMLElement>(".session-concurrent-chat-auxiliary")?.style.setProperty("--session-region-min-width", "360px");
    Object.defineProperty(splitter.parentElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1000, height: 300, top: 0, left: 0, right: 1000, bottom: 300 }),
    });
    Object.defineProperty(splitter, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 20, height: 300, top: 0, left: 500, right: 520, bottom: 300 }),
    });
    const pointerEvent = (type: string, clientX: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        pointerId: { value: 1 },
      });
      return event;
    };
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 500));
      dom.window.dispatchEvent(pointerEvent("pointermove", 510));
      dom.window.dispatchEvent(pointerEvent("pointerup", 510));
    });
    assert.ok(ratios.length > 0);
    assert.equal(ratios.at(-1), 360 / 980);
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      dom.window.dispatchEvent(pointerEvent("pointermove", 490));
      dom.window.dispatchEvent(pointerEvent("pointerup", 490));
    });
    assert.ok(Math.abs(ratios.at(-1)! - 380 / 980) < 1e-9);

    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      dom.window.dispatchEvent(pointerEvent("pointermove", 1010));
      dom.window.dispatchEvent(pointerEvent("pointerup", 1010));
    });
    assert.equal(ratios.at(-1), 360 / 980);
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 510));
      dom.window.dispatchEvent(pointerEvent("pointerup", 510));
      splitter.click();
    });
    assert.equal(ratios.at(-1), 0);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
  }
});

// @test-value v2
// kind = "contract"
// claim = "幅0のConcurrent splitterはpointer dragやキーでは開かず、クリックだけで既定幅へ再表示する"
// oracle = { type = "contract", ref = "issue-710-zero-width-splitter-drag" }
// fault = "幅0のAuxiliaryがpointer dragやキーで意図せず開く、またはクリックで既定幅へ戻らない"
// observable = "幅0からのpointer drag／keyboard操作／clickによる比率"
// observation_boundary = "component-behavior"
// scope = "concurrent-chat-shell"
// lifecycle = "permanent"
// @end-test-value
test("ConcurrentChatSplitter は幅0をclickだけで既定幅へ戻す", async () => {
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "setPointerCapture", { configurable: true, value() {} });
  let root: Root | null = null;
  const ratios: number[] = [];
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement("div", { style: { width: "1000px" } },
        React.createElement("div", { className: "session-concurrent-chat-main" }),
        React.createElement(ConcurrentChatSplitter, {
          widthRatio: 0,
          onWidthRatioChange: (ratio: number) => ratios.push(ratio),
        }),
        React.createElement("div", { className: "session-concurrent-chat-auxiliary" }),
      ));
    });
    const splitter = dom.window.document.querySelector<HTMLButtonElement>(".concurrent-chat-splitter");
    assert.ok(splitter);
    dom.window.document.querySelector<HTMLElement>(".session-concurrent-chat-main")?.style.setProperty("--session-region-min-width", "360px");
    dom.window.document.querySelector<HTMLElement>(".session-concurrent-chat-auxiliary")?.style.setProperty("--session-region-min-width", "360px");
    Object.defineProperty(splitter.parentElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 1000, height: 300, top: 0, left: 0, right: 1000, bottom: 300 }),
    });
    const pointerEvent = (type: string, clientX: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        pointerId: { value: 1 },
      });
      return event;
    };
    await act(async () => {
      splitter.dispatchEvent(pointerEvent("pointerdown", 500));
      dom.window.dispatchEvent(pointerEvent("pointermove", 480));
      dom.window.dispatchEvent(pointerEvent("pointerup", 480));
    });
    assert.equal(ratios.length, 0);
    await act(async () => splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    assert.equal(ratios.length, 0);
    await act(async () => splitter.click());
    assert.equal(ratios.at(-1), 0.5);
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
// claim = "共通switcherは中央triggerから検索一覧を開き、検索中の矢印・IME入力を壊さず、候補確定・outside click・Escape後のfocus復帰を扱う"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: UI flow" }
// fault = "検索中のArrowDownで候補を飛ばす、IMEのEscapeで一覧を閉じる、候補を選べない、または閉じた後にtriggerへfocusが戻らない"
// observable = "候補一覧、選択callback、popoverの表示状態、document.activeElement"
// observation_boundary = "component-behavior"
// scope = "session-switcher"
// lifecycle = "permanent"
// @end-test-value
test("SessionSwitcher は検索・確定・取消操作とfocus復帰を扱う", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const previousEvent = globalThis.Event;
  const previousInputEvent = globalThis.InputEvent;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div><div id=\"outside\"></div></body></html>");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, "InputEvent", { configurable: true, value: dom.window.InputEvent });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => dom.window.setTimeout(callback, 0) });
  let root: Root | null = null;
  const selected: string[] = [];
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(SessionSwitcher, {
        ariaLabel: "Auxiliary会話切り替え",
        options: [
          { id: "a", label: "Alpha", preview: "first" },
          { id: "b", label: "Beta", preview: "second" },
        ],
        selectedId: "a",
        searchable: true,
        onMove() {},
        onSelect: (id: string) => selected.push(id),
      }));
    });
    const trigger = dom.window.document.querySelector<HTMLButtonElement>(".session-switcher-current");
    assert.ok(trigger);
    await act(async () => trigger.click());
    const search = dom.window.document.querySelector<HTMLInputElement>(".session-switcher-search");
    assert.ok(search);
    assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 2);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(search, "beta");
      search.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "beta" }));
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    });
    const filteredOptions = [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.equal(filteredOptions.length, 1);
    assert.equal(filteredOptions[0]?.querySelector(".session-switcher-option-label")?.textContent, "Beta");
    await act(async () => search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('[role="option"]'));
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true })));
    assert.ok(dom.window.document.querySelector('[role="listbox"]'));
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    await act(async () => trigger.click());
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[role="option"][aria-selected="false"]')?.click());
    assert.deepEqual(selected, ["b"]);
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    await act(async () => trigger.click());
    await act(async () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    assert.equal(dom.window.document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () => dom.window.document.getElementById("outside")?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    Object.defineProperty(globalThis, "Event", { configurable: true, value: previousEvent });
    Object.defineProperty(globalThis, "InputEvent", { configurable: true, value: previousInputEvent });
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: previousRequestAnimationFrame });
  }
});

// @test-value v2
// kind = "contract"
// claim = "中央の残余高さが160px未満なら非表示・操作不可とし、160pxに復帰すると同じ会話stateとscroll位置を再表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 中央表示最低高" }
// fault = "最低高境界が逆転するか、非表示時のunmountで会話stateやscroll位置を失う"
// observable = "高さ変更前後のaria-hidden、child instance、state、scrollTop"
// observation_boundary = "component-behavior"
// scope = "SessionChatScreen central visibility lifecycle"
// lifecycle = "permanent"
// impact = "ActionDockを広げた後の会話継続位置と操作可能状態を守る"
// distinction = "CSS描画寸法は対象外とし、実componentの高さ判定とReact instance保持を検証する"
// @end-test-value
test("SessionChatScreen は中央160px境界で非表示と復帰を切り替えて状態を保持する", async () => {
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

  Object.defineProperty(dom.window, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 800; } });
  const style = dom.window.document.createElement("style");
  style.textContent = ".session-message-stack { --session-region-min-height: 160px; }";
  dom.window.document.head.append(style);

  function StatefulCentral() {
    const [count, setCount] = React.useState(0);
    return React.createElement("button", {
      type: "button",
      "data-central-state": "true",
      onClick: () => setCount((current) => current + 1),
    }, `state:${count}`);
  }
  const renderScreen = (height: number) => React.createElement(SessionChatScreen, {
    mode: "agent" as const,
    header: null,
    headerSplitter: null,
    isHeaderVisible: true,
    messageColumn: React.createElement(StatefulCentral),
    style: { "--session-action-dock-height": `${height}px`, "--session-header-dock-row-height": "64px", "--session-dock-splitter-size": "20px" } as React.CSSProperties,
    actionDock: React.createElement("div", null, "Composer"),
    actionDockSplitter: null,
    isActionDockExpanded: true,
    layoutPriority: "side-pane-first" as const,
    splitter: null,
  });

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(renderScreen(536));
    });
    const button = dom.window.document.querySelector<HTMLButtonElement>("[data-central-state='true']");
    assert.ok(button);
    assert.equal(dom.window.document.querySelector(".session-message-stack")?.getAttribute("aria-hidden"), "false");
    const central = dom.window.document.querySelector<HTMLElement>(".session-message-stack")!;
    central.scrollTop = 42;
    await act(async () => button.click());
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(537)));
    assert.equal(dom.window.document.querySelector(".session-message-stack")?.getAttribute("aria-hidden"), "true");
    assert.ok(central.hasAttribute("inert"));
    assert.ok(dom.window.document.querySelector(".session-chat-layout.is-central-collapsed"));
    assert.equal(dom.window.document.querySelector("[data-central-state='true']"), button);
    assert.equal(button.textContent, "state:1");

    await act(async () => root?.render(renderScreen(536)));
    assert.equal(dom.window.document.querySelector("[data-central-state='true']"), button);
    assert.equal(button.textContent, "state:1");
    assert.equal(central.getAttribute("aria-hidden"), "false");
    assert.equal(central.scrollTop, 42);
    assert.equal(central.hasAttribute("inert"), false);
    Object.defineProperty(dom.window, "innerWidth", { value: 1200, configurable: true });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    assert.equal(central.getAttribute("aria-hidden"), "true");
    await act(async () => root?.render(renderScreen(496)));
    assert.equal(central.getAttribute("aria-hidden"), "false");
    assert.equal(button.textContent, "state:1");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "展開中ActionDockの実幅900px未満かつ実高さ420px未満で上下優先を要求し、片方だけ不足またはcompact時には要求しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: ActionDockの優先切り替え" }
// fault = "AND条件をORにする、境界を含める、またはresize後の不足を検知できない"
// observable = "実componentの計測とResizeObserver通知による配置変更callback回数"
// observation_boundary = "component-behavior"
// scope = "SessionChatScreen ActionDock priority"
// lifecycle = "permanent"
// impact = "狭い入力領域を確保しつつ、収まる配置を勝手に切り替えない"
// distinction = "CSSの描画は対象外とし、実寸通知から既存配置変更callbackへ至る判断を検証する"
// @end-test-value
test("SessionChatScreen はActionDockの幅と高さが両方不足した時だけ上下優先を要求する", async () => {
  const dom = new JSDOM("<div id='root'></div><style>.session-action-dock-slot { --session-preferred-min-width: 900px; --session-preferred-min-height: 420px; }</style>");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let notifyResize: () => void = () => {};
  let width = 900;
  let height = 419;
  class Observer {
    constructor(callback: () => void) { notifyResize = callback; }
    observe() {}
    disconnect() {}
  }
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: Observer });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} };
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let requests = 0;
  const onRequireDockPriority = () => { requests += 1; };
  const render = (expanded: boolean, priority: "side-pane-first" | "dock-first" = "side-pane-first") =>
    root.render(React.createElement(SessionChatScreen, {
      mode: "agent", header: null, headerSplitter: null, isHeaderVisible: true,
      messageColumn: null, actionDock: null, actionDockSplitter: null, splitter: null,
      isActionDockExpanded: expanded, layoutPriority: priority, onRequireDockPriority,
    }));
  try {
    await act(async () => render(true));
    assert.equal(requests, 0, "幅900pxは不足に含めない");
    width = 899; height = 420;
    await act(async () => notifyResize());
    assert.equal(requests, 0, "高さ420pxは不足に含めない");
    height = 419;
    await act(async () => notifyResize());
    assert.equal(requests, 1, "両方不足なら配置を変更する");
    await act(async () => render(true, "dock-first"));
    width = 1000; height = 500;
    await act(async () => render(true, "dock-first"));
    assert.equal(requests, 1, "回復しても自動では元へ戻さない");
    width = 899; height = 419;
    await act(async () => render(false));
    assert.equal(requests, 1, "compactは判定対象外");
    await act(async () => render(true));
    assert.equal(requests, 2, "左右優先へ戻した場合も不足を再判定する");
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    dom.window.close();
  }
});
