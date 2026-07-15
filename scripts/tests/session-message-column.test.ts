import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { createRef, useState, type ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SessionActionDockCompactRow,
  SessionContextPane,
  SessionComposerExpanded,
  SessionMessageColumn,
  type SessionMessageColumnProps,
} from "../../src/session-components.js";
import { StableSessionMessageColumn } from "../../src/chat/chat-window.js";
import { useCompanionCharacterProfile } from "../../src/companion-character-profile.js";
import type { CompanionSession } from "../../src/companion-state.js";
import { buildContextPaneProjection } from "../../src/session-ui-projection.js";
import type { CharacterProfile, LiveApprovalRequest, LiveElicitationRequest, Message } from "../../src/app-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createCharacterProfile(): CharacterProfile {
  return {
    id: "char-1",
    name: "Test Character",
    iconPath: "/icons/test-character.svg",
    description: "for virtualized list red test",
    roleMarkdown: "テストキャラクター",
    notesMarkdown: "",
    updatedAt: "2026-04-29T00:00:00.000Z",
    themeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    sessionCopy: {
      pendingApproval: ["承認を待機中"],
      pendingWorking: ["処理を実行中"],
      pendingResponding: ["応答を生成中"],
      pendingPreparing: ["応答を準備中"],
      retryInterruptedTitle: ["前回の依頼は中断されたままです"],
      retryFailedTitle: ["前回の依頼は完了できませんでした"],
      retryCanceledTitle: ["この依頼は途中で停止しました"],
      latestCommandWaiting: ["最初の command を待機中"],
      latestCommandEmpty: ["直近 run の command 記録はありません"],
      changedFilesEmpty: ["ファイル変更はありません"],
      contextEmpty: ["context usage はまだありません"],
    },
  };
}

const companionSession: CompanionSession = {
  id: "companion-session-1",
  groupId: "group-1",
  taskTitle: "Companion session",
  status: "active",
  repoRoot: "C:/workspace/WithMate",
  focusPath: "",
  targetBranch: "master",
  baseSnapshotRef: "master",
  baseSnapshotCommit: "abc123",
  companionBranch: "companion/test",
  worktreePath: "C:/workspace/WithMate-companion",
  selectedPaths: [],
  changedFiles: [],
  siblingWarnings: [],
  allowedAdditionalDirectories: [],
  runState: "idle",
  threadId: "thread-1",
  provider: "codex",
  catalogRevision: 1,
  model: "gpt-test",
  reasoningEffort: "low",
  customAgentName: "",
  approvalMode: "never",
  codexSandboxMode: "workspace-write",
  characterId: "companion",
  character: "Companion",
  characterRoleMarkdown: "",
  characterIconPath: "",
  characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
  characterRuntimeSnapshot: null,
  createdAt: "2026-05-25T00:00:00.000Z",
  updatedAt: "2026-05-25T00:00:00.000Z",
  messages: [],
};

function CompanionDraftMessageColumn(props: SessionMessageColumnProps) {
  const [draft, setDraft] = useState("");
  const character = useCompanionCharacterProfile(companionSession);
  assert.ok(character);

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(StableSessionMessageColumn, { ...props, character }),
    React.createElement(
      "button",
      { type: "button", onClick: () => setDraft((current) => `${current}a`) },
      `draft:${draft}`,
    ),
  );
}

function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" : "user",
    text: `message ${index + 1}`,
  }));
}

function createArtifactMessage(): Message {
  return {
    role: "assistant",
    text: "artifact message",
    artifact: {
      title: "artifact result",
      activitySummary: ["updated app"],
      operationTimeline: [
        {
          type: "file_write",
          summary: "updated file",
          details: "details for operation",
        },
      ],
      changedFiles: [
        {
          kind: "edit",
          path: "src/App.tsx",
          summary: "updated app component",
          diffRows: [{ kind: "add", rightNumber: 1, rightText: "new line" }],
        },
      ],
      runChecks: [{ label: "snapshot files", value: "ok" }],
    },
  };
}

function createLiveApprovalRequest(): LiveApprovalRequest {
  return {
    requestId: "approval-1",
    provider: "codex",
    kind: "command",
    title: "コマンド実行の承認",
    summary: "npm test を実行します",
    details: "approval details",
    warning: "確認してね",
    decisionMode: "direct-decision",
  };
}

function createLiveElicitationRequest(): LiveElicitationRequest {
  return {
    requestId: "elicitation-1",
    provider: "codex",
    mode: "form",
    message: "対象ブランチを選んでね。",
    fields: [
      {
        type: "text",
        name: "branch",
        title: "Branch",
        required: true,
        defaultValue: "main",
      },
    ],
  };
}

function renderSessionMessageColumn(options: {
  messages: Message[];
  expandedArtifacts?: Record<string, boolean>;
  isRunning?: boolean;
  isMessageListFollowing?: boolean;
  liveApprovalRequest?: LiveApprovalRequest | null;
  liveElicitationRequest?: LiveElicitationRequest | null;
  liveRunAssistantText?: string;
  pendingMessageText?: string;
  pendingMessageGroupId?: string | null;
  withResponseActions?: boolean;
  messageGroups?: SessionMessageColumnProps["messageGroups"];
}): string {
  return renderToStaticMarkup(
    React.createElement(SessionMessageColumn, {
      sessionId: "session-1",
      character: createCharacterProfile(),
      messages: options.messages,
      messageGroups: options.messageGroups,
      expandedArtifacts: options.expandedArtifacts ?? {},
      messageListRef: createRef<HTMLDivElement>(),
      isRunning: options.isRunning ?? false,
      liveApprovalRequest: options.liveApprovalRequest ?? null,
      approvalActionRequestId: null,
      liveElicitationRequest: options.liveElicitationRequest ?? null,
      elicitationActionRequestId: null,
      liveRunAssistantText: options.liveRunAssistantText ?? "",
      hasLiveRunAssistantText: !!options.liveRunAssistantText,
      liveRunErrorMessage: "",
      pendingMessageText: options.pendingMessageText,
      pendingMessageGroupId: options.pendingMessageGroupId,
      isMessageListFollowing: options.isMessageListFollowing ?? false,
      onMessageListScroll() {},
      onToggleArtifact() {},
      onOpenDiff() {},
      onResolveLiveApproval() {},
      onResolveLiveElicitation() {},
      onOpenPath: undefined,
      getChangedFilesEmptyText() {
        return "変更ファイルはありません";
      },
      onCopyMessageText: options.withResponseActions ? () => {} : undefined,
      onQuoteMessageText: options.withResponseActions ? () => {} : undefined,
    }),
  );
}

function createRect(input: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    left: input.left,
    top: input.top,
    width: input.width,
    height: input.height,
    right: input.left + input.width,
    bottom: input.top + input.height,
    x: input.left,
    y: input.top,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

type MountedSessionMessageColumn = {
  container: HTMLElement;
  dom: JSDOM;
  messageListRef: React.RefObject<HTMLDivElement | null>;
  root: Root;
  rerender: (callbacks: {
    getChangedFilesEmptyText?: (artifactKey: string, artifactHasSnapshotRisk: boolean) => string;
    isMessageListFollowing?: boolean;
    messages?: Message[];
    onCopyMessageText?: (text: string) => void;
    onQuoteMessageText?: (text: string) => void;
  }) => Promise<void>;
  resizeMessageRow: (index: number, height: number) => Promise<void>;
  cleanup: () => Promise<void>;
};

async function mountSessionMessageColumn(options: {
  messages: Message[];
  onCopyMessageText?: (text: string) => void;
  onQuoteMessageText?: (text: string) => void;
  expandedArtifacts?: Record<string, boolean>;
  getChangedFilesEmptyText?: (artifactKey: string, artifactHasSnapshotRisk: boolean) => string;
  component?: ComponentType<SessionMessageColumnProps>;
}): Promise<MountedSessionMessageColumn> {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousDOMRect = globalThis.DOMRect;
  const previousEvent = globalThis.Event;
  const previousMouseEvent = globalThis.MouseEvent;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const messageListRef = createRef<HTMLDivElement>();
  const root = createRoot(container);
  const originalGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "offsetHeight");
  const originalClientHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "clientHeight");
  const originalScrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollHeight");
  const originalScrollTo = dom.window.HTMLElement.prototype.scrollTo;
  const originalResizeObserver = dom.window.ResizeObserver;
  const messageRowHeights = new Map<number, number>();
  const resizeObservers: Array<{
    callback: ResizeObserverCallback;
    elements: Set<Element>;
  }> = [];

  class TestResizeObserver implements ResizeObserver {
    private readonly registration: (typeof resizeObservers)[number];

    constructor(callback: ResizeObserverCallback) {
      this.registration = { callback, elements: new Set() };
      resizeObservers.push(this.registration);
    }

    observe(target: Element): void {
      this.registration.elements.add(target);
    }

    unobserve(target: Element): void {
      this.registration.elements.delete(target);
    }

    disconnect(): void {
      this.registration.elements.clear();
    }

    takeRecords(): ResizeObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(
    optionsOrX?: ScrollToOptions | number,
    y?: number,
  ): void {
    if (typeof optionsOrX === "number") {
      this.scrollLeft = optionsOrX;
      this.scrollTop = y ?? this.scrollTop;
      return;
    }
    if (typeof optionsOrX?.left === "number") {
      this.scrollLeft = optionsOrX.left;
    }
    if (typeof optionsOrX?.top === "number") {
      this.scrollTop = optionsOrX.top;
    }
  };

  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains("session-message-list")) {
      return createRect({ left: 0, top: 0, width: 960, height: 720 });
    }
    if (this.classList.contains("session-message-virtual-row")) {
      const index = Number(this.getAttribute("data-index"));
      return createRect({ left: 0, top: 0, width: 960, height: messageRowHeights.get(index) ?? 168 });
    }
    return originalGetBoundingClientRect.call(this);
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      if (this.classList.contains("session-message-list")) {
        return 720;
      }
      if (this.classList.contains("session-message-virtual-row")) {
        const index = Number(this.getAttribute("data-index"));
        return messageRowHeights.get(index) ?? 168;
      }
      return 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("session-message-list") ? 720 : 0;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (!this.classList.contains("session-message-list")) {
        return 0;
      }
      const items = this.querySelector(".session-message-list-window-items") as HTMLElement | null;
      return Number.parseFloat(items?.style.height ?? "0") || 0;
    },
  });

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: dom.window.DOMRect });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: dom.window.MouseEvent });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  const MessageColumn = options.component ?? SessionMessageColumn;
  const character = createCharacterProfile();
  const expandedArtifacts = options.expandedArtifacts ?? {};
  const defaultGetChangedFilesEmptyText = () => "変更ファイルはありません";
  const renderMessageColumn = async (callbacks: {
    getChangedFilesEmptyText?: (artifactKey: string, artifactHasSnapshotRisk: boolean) => string;
    isMessageListFollowing?: boolean;
    messages?: Message[];
    onCopyMessageText?: (text: string) => void;
    onQuoteMessageText?: (text: string) => void;
  }) => {
    await act(async () => {
      root.render(
        React.createElement(MessageColumn, {
          sessionId: "session-1",
          character,
          messages: callbacks.messages ?? options.messages,
          expandedArtifacts,
          messageListRef,
          isRunning: false,
          liveApprovalRequest: null,
          approvalActionRequestId: null,
          liveElicitationRequest: null,
          elicitationActionRequestId: null,
          liveRunAssistantText: "",
          hasLiveRunAssistantText: false,
          liveRunErrorMessage: "",
          isMessageListFollowing: callbacks.isMessageListFollowing ?? false,
          onMessageListScroll() {},
          onToggleArtifact() {},
          onOpenDiff() {},
          onResolveLiveApproval() {},
          onResolveLiveElicitation() {},
          onOpenPath: undefined,
          getChangedFilesEmptyText: callbacks.getChangedFilesEmptyText ?? defaultGetChangedFilesEmptyText,
          onCopyMessageText: callbacks.onCopyMessageText,
          onQuoteMessageText: callbacks.onQuoteMessageText,
        }),
      );
    });
  };

  await renderMessageColumn(options);

  return {
    container,
    dom,
    messageListRef,
    root,
    rerender: renderMessageColumn,
    async resizeMessageRow(index, height) {
      messageRowHeights.set(index, height);
      const row = container.querySelector(`.session-message-virtual-row[data-index="${index}"]`);
      assert.ok(row, `message row ${index} が描画されていない`);
      const entry = {
        target: row,
        borderBoxSize: [{ inlineSize: 960, blockSize: height }],
        contentRect: createRect({ left: 0, top: 0, width: 960, height }),
      } as unknown as ResizeObserverEntry;
      await act(async () => {
        for (const observer of resizeObservers) {
          if (observer.elements.has(row)) {
            observer.callback([entry], observer as unknown as ResizeObserver);
          }
        }
      });
    },
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      dom.window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalOffsetHeight) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      } else {
        delete (dom.window.HTMLElement.prototype as unknown as { offsetHeight?: number }).offsetHeight;
      }
      if (originalClientHeight) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", originalClientHeight);
      } else {
        delete (dom.window.HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
      }
      if (originalScrollHeight) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (dom.window.HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
      }
      Object.defineProperty(dom.window, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
      });
      dom.window.HTMLElement.prototype.scrollTo = originalScrollTo;
      dom.window.close();
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
      Object.defineProperty(globalThis, "DOMRect", { configurable: true, value: previousDOMRect });
      Object.defineProperty(globalThis, "Event", { configurable: true, value: previousEvent });
      Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: previousMouseEvent });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    },
  };
}

test("SessionMessageColumn は全履歴を仮想化し、最新メッセージ周辺だけを描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isMessageListFollowing: false,
  });

  const messageRowCount = (html.match(/message-row/g) ?? []).length;
  assert.ok(messageRowCount > 0, "message-row が1件も描画されていない");
  assert.ok(messageRowCount < 100, "100件全て message-row が描画されている");
  assert.doesNotMatch(html, /message 1<\/p>/);
  assert.match(html, /message 100<\/p>/);
  assert.match(html, /session-message-virtual-row/);
  assert.doesNotMatch(html, /以前のメッセージを読み込む/);
});

test("SessionMessageColumn は上方向へスクロールして先頭メッセージへ到達できる", async () => {
  const mounted = await mountSessionMessageColumn({ messages: createMessages(100) });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    assert.doesNotMatch(mounted.container.textContent ?? "", /message 1(?:\D|$)/);

    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });

    assert.match(mounted.container.textContent ?? "", /message 1(?:\D|$)/);
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn は上側rowの可変高再計測後も表示位置を維持する", async () => {
  const mounted = await mountSessionMessageColumn({ messages: createMessages(100) });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
      messageList.scrollTop = 4_000;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
      await new Promise((resolve) => mounted.dom.window.setTimeout(resolve, 180));
    });
    const renderedRows = Array.from(
      mounted.container.querySelectorAll<HTMLElement>(".session-message-virtual-row"),
    );
    const rowAboveViewport = renderedRows.find((row) => {
      const start = Number.parseFloat(row.style.transform.match(/translateY\(([^p]+)px\)/)?.[1] ?? "0");
      return start < messageList.scrollTop;
    });
    assert.ok(rowAboveViewport);
    const rowIndex = Number(rowAboveViewport.dataset.index);
    const scrollTopBeforeResize = messageList.scrollTop;

    await mounted.resizeMessageRow(rowIndex, 268);

    assert.equal(messageList.scrollTop, scrollTopBeforeResize + 100);
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn は末尾追従中だけappend後も末尾へ追従する", async () => {
  const initialMessages = createMessages(20);
  const mounted = await mountSessionMessageColumn({
    messages: initialMessages,
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = messageList.scrollHeight - messageList.clientHeight;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const followingScrollTop = messageList.scrollTop;
    const appendedMessages = [...initialMessages, { role: "assistant" as const, text: "appended at end" }];

    await mounted.rerender({
      isMessageListFollowing: true,
      messages: appendedMessages,
    });

    assert.ok(messageList.scrollTop > followingScrollTop);
    assert.match(mounted.container.textContent ?? "", /appended at end/);

    await act(async () => {
      messageList.scrollTop = 300;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const nonFollowingScrollTop = messageList.scrollTop;

    await mounted.rerender({
      messages: [...appendedMessages, { role: "user", text: "append while reading history" }],
    });

    assert.equal(messageList.scrollTop, nonFollowingScrollTop);
  } finally {
    await mounted.cleanup();
  }
});

test("StableSessionMessageColumn は callback の再生成だけでは既存 message を再描画しない", async () => {
  let messageTextReadCount = 0;
  const message = {
    role: "assistant" as const,
    get text() {
      messageTextReadCount += 1;
      return "stable assistant message";
    },
  };
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    component: StableSessionMessageColumn,
    onCopyMessageText() {},
  });

  try {
    const initialReadCount = messageTextReadCount;
    assert.ok(initialReadCount > 0);

    await mounted.rerender({ onCopyMessageText() {} });

    assert.equal(messageTextReadCount, initialReadCount);
  } finally {
    await mounted.cleanup();
  }
});

test("Companion draft 更新では既存 message column を再描画しない", async () => {
  let messageTextReadCount = 0;
  const message = {
    role: "assistant" as const,
    get text() {
      messageTextReadCount += 1;
      return "stable companion message";
    },
  };
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    component: CompanionDraftMessageColumn,
  });

  try {
    const initialReadCount = messageTextReadCount;
    assert.ok(initialReadCount > 0);
    const draftButton = Array.from(mounted.container.querySelectorAll("button"))
      .find((button) => button.textContent?.startsWith("draft:"));
    assert.ok(draftButton);

    await act(async () => {
      draftButton.dispatchEvent(new mounted.dom.window.MouseEvent("click", { bubbles: true }));
    });

    assert.equal(messageTextReadCount, initialReadCount);
  } finally {
    await mounted.cleanup();
  }
});

test("StableSessionMessageColumn は描画用 callback の更新を空表示文言へ反映する", async () => {
  const message = createArtifactMessage();
  message.artifact!.changedFiles = [];
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    expandedArtifacts: { "session-1-0": true },
    component: StableSessionMessageColumn,
    getChangedFilesEmptyText: () => "変更前の空表示",
  });

  try {
    assert.match(mounted.container.textContent ?? "", /変更前の空表示/);

    await mounted.rerender({
      getChangedFilesEmptyText: () => "変更後の空表示",
    });

    assert.doesNotMatch(mounted.container.textContent ?? "", /変更前の空表示/);
    assert.match(mounted.container.textContent ?? "", /変更後の空表示/);
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn は未追従時に message list 内の jump UI を描画しない", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(2),
    isMessageListFollowing: false,
  });

  assert.doesNotMatch(html, /message-follow-banner/);
  assert.doesNotMatch(html, /末尾へ移動/);
});

test("SessionMessageColumn は artifact 展開と diff 起動に必要な表示断片を維持する", () => {
  const html = renderSessionMessageColumn({
    messages: [createArtifactMessage()],
    expandedArtifacts: { "session-1-0": true },
  });

  assert.match(html, /artifact-panel-session-1-0/);
  assert.match(html, /src\/App\.tsx/);
  assert.match(html, /Open Diff/);
  assert.match(html, /snapshot files/);
});

test("SessionMessageColumn は未選択時に response action を描画しない", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "assistant", text: "assistant result" },
      { role: "user", text: "user prompt" },
    ],
    withResponseActions: true,
  });

  assert.doesNotMatch(html, /message-response-actions/);
  assert.doesNotMatch(html, />Copy</);
  assert.doesNotMatch(html, />Quote</);
  assert.match(html, /data-message-text-actions="true"/);
  assert.equal((html.match(/data-message-text-actions="true"/g) ?? []).length, 1);
});

test("SessionMessageColumn は選択範囲にだけ response action toolbar を表示する", async () => {
  const copiedTexts: string[] = [];
  const quotedTexts: string[] = [];
  const mounted = await mountSessionMessageColumn({
    messages: [
      { role: "assistant", text: "assistant result text" },
      { role: "user", text: "user prompt text" },
    ],
    onCopyMessageText: (text) => copiedTexts.push(text),
    onQuoteMessageText: (text) => quotedTexts.push(text),
  });

  try {
    const { container, dom, messageListRef } = mounted;
    const messageList = messageListRef.current;
    assert.ok(messageList);
    Object.defineProperty(messageList, "getBoundingClientRect", {
      configurable: true,
      value: () => createRect({ left: 0, top: 0, width: 500, height: 500 }),
    });

    let selectedText = "";
    let isCollapsed = true;
    let anchorRect = createRect({ left: 100, top: 100, width: 60, height: 20 });
    let selectionNode: Node = container;
    const selection = {
      get isCollapsed() {
        return isCollapsed;
      },
      get rangeCount() {
        return isCollapsed ? 0 : 1;
      },
      getRangeAt() {
        return {
          commonAncestorContainer: selectionNode,
          getBoundingClientRect: () => anchorRect,
          getClientRects: () => [anchorRect],
        };
      },
      toString() {
        return selectedText;
      },
    } as unknown as Selection;
    Object.defineProperty(dom.window, "getSelection", {
      configurable: true,
      value: () => selection,
    });

    const selectText = async (body: Element, text: string, rect: DOMRect) => {
      const paragraph = body.querySelector(".message-paragraph");
      assert.ok(paragraph?.firstChild);
      selectionNode = paragraph.firstChild;
      selectedText = text;
      isCollapsed = false;
      anchorRect = rect;
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
      });
    };
    const clearSelection = async () => {
      isCollapsed = true;
      selectedText = "";
      await act(async () => {
        dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
      });
    };

    const assistantBody = container.querySelector("[data-message-text-actions=\"true\"]");
    assert.ok(assistantBody);
    await selectText(assistantBody, "assistant result", anchorRect);

    let toolbar = container.querySelector(".message-response-actions") as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "74px");
    assert.equal(toolbar.style.top, "60px");

    const copyButton = Array.from(toolbar.querySelectorAll("button"))
      .find((button) => button.textContent === "Copy") as HTMLButtonElement | undefined;
    const quoteButton = Array.from(toolbar.querySelectorAll("button"))
      .find((button) => button.textContent === "Quote") as HTMLButtonElement | undefined;
    assert.ok(copyButton);
    assert.ok(quoteButton);

    await act(async () => {
      copyButton.click();
      quoteButton.click();
    });
    assert.deepEqual(copiedTexts, ["assistant result"]);
    assert.deepEqual(quotedTexts, ["assistant result"]);

    const userBody = Array.from(container.querySelectorAll("[data-message-body=\"true\"]"))
      .find((body) => body.getAttribute("data-message-text-actions") !== "true");
    assert.ok(userBody);
    await selectText(userBody, "user prompt", createRect({ left: 120, top: 140, width: 60, height: 20 }));
    assert.equal(container.querySelector(".message-response-actions"), null);

    await selectText(assistantBody, "result text", createRect({ left: 200, top: 220, width: 80, height: 20 }));
    toolbar = container.querySelector(".message-response-actions") as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "184px");
    assert.equal(toolbar.style.top, "180px");

    anchorRect = createRect({ left: 240, top: 260, width: 80, height: 20 });
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    });
    toolbar = container.querySelector(".message-response-actions") as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "224px");
    assert.equal(toolbar.style.top, "220px");

    anchorRect = createRect({ left: 520, top: 520, width: 40, height: 20 });
    await act(async () => {
      messageList.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.equal(container.querySelector(".message-response-actions"), null);

    await selectText(assistantBody, "assistant result", createRect({ left: 100, top: 100, width: 60, height: 20 }));
    assert.ok(container.querySelector(".message-response-actions"));
    await clearSelection();
    assert.equal(container.querySelector(".message-response-actions"), null);
  } finally {
    mounted.cleanup();
  }
});

test("SessionMessageColumn は Auxiliary transcript group を message list 内に描画する", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "user", text: "aux prompt", accent: true },
      { role: "assistant", text: "aux response", accent: true },
    ],
    messageGroups: [
      { id: "aux-1", label: "Auxiliary" },
      { id: "aux-1", label: "Auxiliary" },
    ],
  });

  assert.match(html, /auxiliary-message-group-label/);
  assert.match(html, /auxiliary-message-group-item/);
  assert.match(html, /session-message-virtual-row auxiliary-message-group-continues/);
  assert.match(html, />Auxiliary</);
  assert.doesNotMatch(html, />Closed</);
  assert.ok(
    html.indexOf("auxiliary-message-group-label") < html.indexOf("aux prompt"),
    "Auxiliary group label は対象 transcript の先頭 message より前に描画する",
  );
});

test("SessionMessageColumn は pending と live approval\/elicitation を message window の末尾で維持する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isRunning: true,
    liveApprovalRequest: createLiveApprovalRequest(),
    liveElicitationRequest: createLiveElicitationRequest(),
  });

  assert.match(html, /pending-row/);
  assert.match(html, /承認待ち/);
  assert.match(html, /コマンド実行の承認/);
  assert.match(html, /対象ブランチを選んでね。/);
  assert.match(html, /Branch/);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("pending-row"),
    "pending row は既存メッセージの後に描画する",
  );
  assert.ok(
    html.indexOf("pending-row") < html.indexOf("message-list-bottom-anchor"),
    "pending row は bottom anchor より前に描画する",
  );
});

test("SessionMessageColumn は projection 済みの実行中 assistant text を通常 message row として表示する", () => {
  const html = renderSessionMessageColumn({
    messages: [
      ...createMessages(100),
      { role: "assistant", text: "ストリーミング中の返答" },
    ],
    isRunning: true,
    liveRunAssistantText: "ストリーミング中の返答",
  });

  assert.doesNotMatch(html, /pending-row/);
  assert.match(html, /ストリーミング中の返答/);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("ストリーミング中の返答"),
    "projection 済みの live assistant text は既存メッセージの後に描画する",
  );
  assert.ok(
    html.indexOf("ストリーミング中の返答") < html.indexOf("message-list-bottom-anchor"),
    "projection 済みの live assistant text は bottom anchor より前に描画する",
  );
  assert.doesNotMatch(html, /処理を実行中/);
});

test("SessionMessageColumn は inline content のない pending bubble を描画しない", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
  });

  assert.doesNotMatch(html, /pending-row/);
  assert.match(html, /message-list-bottom-anchor/);
});

test("SessionMessageColumn は pending message text があれば実行開始直後の assistant row を描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(1),
    isRunning: true,
    pendingMessageText: "応答を準備しています",
  });

  assert.match(html, /pending-row/);
  assert.match(html, /応答を準備しています/);
  assert.ok(
    html.indexOf("message 1") < html.indexOf("pending-row"),
    "pending row は既存メッセージの後に描画する",
  );
});

test("SessionMessageColumn は Auxiliary 実行中の pending row を group 内に描画する", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "assistant", text: "main response" },
      { role: "user", text: "aux prompt", accent: true },
      { role: "assistant", text: "later main response" },
    ],
    messageGroups: [
      null,
      { id: "aux-1", label: "Auxiliary" },
      null,
    ],
    isRunning: true,
    pendingMessageText: "応答を準備しています",
    pendingMessageGroupId: "aux-1",
  });

  assert.match(html, /auxiliary-message-group-item auxiliary-message-group-end/);
  assert.ok(
    html.indexOf("aux prompt") < html.indexOf("応答を準備しています"),
    "pending row は Auxiliary prompt の後に描画する",
  );
  assert.ok(
    html.indexOf("応答を準備しています") < html.indexOf("later main response"),
    "pending row は後続 main message より前の Auxiliary group 内に描画する",
  );
});

test("SessionMessageColumn は pending 対象の Auxiliary group が window 外なら末尾に fallback 描画する", () => {
  const messages = createMessages(100);
  messages[0] = { role: "user", text: "aux prompt outside window", accent: true };
  const messageGroups: SessionMessageColumnProps["messageGroups"] = Array.from({ length: 100 }, () => null);
  messageGroups[0] = { id: "aux-1", label: "Auxiliary" };

  const html = renderSessionMessageColumn({
    messages,
    messageGroups,
    isRunning: true,
    pendingMessageText: "応答を準備しています",
    pendingMessageGroupId: "aux-1",
  });

  assert.doesNotMatch(html, /aux prompt outside window/);
  assert.match(html, /応答を準備しています/);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("応答を準備しています"),
    "対象 group が描画 window 外なら pending row は通常どおり末尾に描画する",
  );
});

test("SessionComposerExpanded は jump button を Hide の左に描画する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionComposerExpanded, {
      retryBanner: null,
      isRunning: false,
      pendingRunIndicatorAnnouncement: "処理を実行中",
      pendingRunIndicatorText: "処理を実行中",
      composerBlocked: false,
      canSelectCustomAgent: true,
      showCustomAgentPicker: true,
      showSkillPicker: true,
      isAgentPickerOpen: false,
      isSkillPickerOpen: false,
      isAdditionalDirectoryListOpen: false,
      selectedCustomAgentLabel: "Agent",
      selectedCustomAgentTitle: "Agent",
      additionalDirectoryCount: 0,
      canCollapseActionDock: true,
      showJumpToBottom: true,
      isCustomAgentListLoading: false,
      isSkillListLoading: false,
      customAgentItems: [],
      skillItems: [],
      attachmentItems: [],
      additionalDirectoryItems: [],
      draft: "",
      composerTextareaRef: createRef<HTMLTextAreaElement>(),
      isComposerDisabled: false,
      isSendDisabled: true,
      composerSendability: {
        primaryFeedback: "",
        secondaryFeedback: [],
        feedbackTone: null,
        shouldShowFeedback: false,
      },
      sendButtonTitle: "送信できないよ。",
      isComposerBlockedFeedbackActive: false,
      approvalOptions: [{ value: "untrusted", label: "untrusted" }],
      selectedApprovalMode: "untrusted",
      sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
      selectedCodexSandboxMode: "workspace-write",
      modelOptions: [{ value: "gpt-5.4", label: "GPT-5.4" }],
      selectedModel: "gpt-5.4",
      selectedModelFallbackLabel: "gpt-5.4",
      reasoningOptions: [{ value: "high", label: "high" }],
      selectedReasoningEffort: "high",
      onPickFile() {},
      onPickFolder() {},
      onPickImage() {},
      onToggleAgentPicker() {},
      onToggleSkillPicker() {},
      onAddAdditionalDirectory() {},
      onToggleAdditionalDirectoryList() {},
      onCollapse() {},
      onJumpToBottom() {},
      onSelectCustomAgent() {},
      onSelectSkill() {},
      onRemoveAttachment() {},
      onRemoveAdditionalDirectory() {},
      onDraftChange() {},
      onDraftFocus() {},
      onDraftKeyDown() {},
      onDraftSelect() {},
      onDraftCompositionStart() {},
      onDraftCompositionEnd() {},
      onSendOrCancel() {},
      onChangeApprovalMode() {},
      onChangeCodexSandboxMode() {},
      onChangeModel() {},
      onChangeReasoningEffort() {},
    }),
  );

  assert.ok(html.indexOf("末尾へ移動") < html.indexOf("Hide"));
  const composerBoxHtml = html.match(/<div class="composer-box">(?<content>[\s\S]*?)<\/div><button class="session-send-button"/);
  assert.ok(composerBoxHtml, "Send button は composer-box の外に描画する");
  assert.doesNotMatch(composerBoxHtml.groups?.content ?? "", />Send<\/button>/);
});

test("SessionComposerExpanded は実行中の progress と Cancel を上部 toolbar に描画し、下段の送信ボタンを隠す", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionComposerExpanded, {
      retryBanner: null,
      isRunning: true,
      pendingRunIndicatorAnnouncement: "処理を実行中",
      pendingRunIndicatorText: "処理を実行中",
      composerBlocked: false,
      canSelectCustomAgent: true,
      showCustomAgentPicker: true,
      showSkillPicker: true,
      isAgentPickerOpen: false,
      isSkillPickerOpen: false,
      isAdditionalDirectoryListOpen: false,
      selectedCustomAgentLabel: "Agent",
      selectedCustomAgentTitle: "Agent",
      additionalDirectoryCount: 0,
      canCollapseActionDock: true,
      showJumpToBottom: false,
      isCustomAgentListLoading: false,
      isSkillListLoading: false,
      customAgentItems: [],
      skillItems: [],
      attachmentItems: [],
      additionalDirectoryItems: [],
      draft: "実行中の下書き",
      composerTextareaRef: createRef<HTMLTextAreaElement>(),
      isComposerDisabled: true,
      isSendDisabled: true,
      composerSendability: {
        primaryFeedback: "",
        secondaryFeedback: [],
        feedbackTone: null,
        shouldShowFeedback: false,
      },
      sendButtonTitle: "実行をキャンセル",
      isComposerBlockedFeedbackActive: false,
      approvalOptions: [{ value: "untrusted", label: "untrusted" }],
      selectedApprovalMode: "untrusted",
      sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
      selectedCodexSandboxMode: "workspace-write",
      modelOptions: [{ value: "gpt-5.4", label: "GPT-5.4" }],
      selectedModel: "gpt-5.4",
      selectedModelFallbackLabel: "gpt-5.4",
      reasoningOptions: [{ value: "high", label: "high" }],
      selectedReasoningEffort: "high",
      onPickFile() {},
      onPickFolder() {},
      onPickImage() {},
      onToggleAgentPicker() {},
      onToggleSkillPicker() {},
      onAddAdditionalDirectory() {},
      onToggleAdditionalDirectoryList() {},
      onCollapse() {},
      onJumpToBottom() {},
      onSelectCustomAgent() {},
      onSelectSkill() {},
      onRemoveAttachment() {},
      onRemoveAdditionalDirectory() {},
      onDraftChange() {},
      onDraftFocus() {},
      onDraftKeyDown() {},
      onDraftSelect() {},
      onDraftCompositionStart() {},
      onDraftCompositionEnd() {},
      onSendOrCancel() {},
      onChangeApprovalMode() {},
      onChangeCodexSandboxMode() {},
      onChangeModel() {},
      onChangeReasoningEffort() {},
    }),
  );

  assert.match(html, /composer-toolbar-progress/);
  assert.match(html, /処理を実行中/);
  assert.match(html, /composer-toolbar-cancel-button/);
  assert.ok(html.indexOf("File") < html.indexOf("処理を実行中"));
  assert.ok(html.indexOf("処理を実行中") < html.indexOf("Cancel"));
  assert.doesNotMatch(html, />Send<\/button>/);
});

test("SessionActionDockCompactRow は jump button を Send の左に描画する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      draft: "",
      actionDockCompactPreview: "下書きなし",
      attachmentCount: 0,
      isRunning: false,
      isSendDisabled: true,
      showJumpToBottom: true,
      sendButtonTitle: "送信できないよ。",
      onExpand() {},
      onJumpToBottom() {},
      onSendOrCancel() {},
    }),
  );

  assert.ok(html.indexOf("末尾へ移動") < html.indexOf("Send"));
});

test("SessionActionDockCompactRow は実行中の compact 表示に jump button と Cancel を描画する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      draft: "draft",
      actionDockCompactPreview: "draft",
      attachmentCount: 2,
      isRunning: true,
      pendingRunIndicatorAnnouncement: "処理を実行中",
      pendingRunIndicatorText: "処理を実行中",
      isSendDisabled: false,
      showJumpToBottom: true,
      sendButtonTitle: "実行をキャンセル",
      onExpand() {},
      onJumpToBottom() {},
      onSendOrCancel() {},
    }),
  );

  assert.match(html, /aria-label="ActionDock を展開"/);
  assert.match(html, /session-action-dock-compact-progress-button/);
  assert.match(html, /session-action-dock-compact-progress/);
  assert.match(html, /処理を実行中/);
  assert.match(html, /session-action-dock-compact-actions/);
  assert.ok(html.indexOf("末尾へ移動") < html.indexOf("Cancel"));
  assert.match(html, />Cancel<\/button>/);
  assert.doesNotMatch(html, /Draft/);
  assert.doesNotMatch(html, /添付 2/);
});

test("SessionContextPane は latest command がないとき empty text を表示する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionContextPane, {
      taskTitle: "task",
      isHeaderExpanded: false,
      activeContextPaneTab: "latest-command",
      availableContextPaneTabs: ["latest-command"],
      contextPaneProjection: buildContextPaneProjection({
        activeContextPaneTab: "latest-command",
        latestCommandView: null,
        backgroundTasks: [],
      }),
      latestCommandView: null,
      latestCommandEmptyText: "直近 run の command 記録はありません",
      runningDetailsEntries: [],
      liveRunReasoningText: "",
      backgroundTasks: [],
      companionGroupMonitorEntries: [],
      selectedSessionLiveRunErrorMessage: "",
      isSelectedSessionRunning: false,
      isCopilotSession: false,
      selectedCopilotRemainingPercentLabel: "",
      selectedCopilotRemainingRequestsLabel: "",
      selectedCopilotQuotaResetLabel: "",
      selectedSessionContextTelemetry: null,
      selectedSessionContextTelemetryProjection: {
        summaryLabel: "",
        currentTokensLabel: "",
        tokenLimitLabel: "",
        messagesLengthLabel: "",
        systemTokensLabel: "",
        conversationTokensLabel: "",
      },
      contextEmptyText: "context usage はまだありません",
      onToggleHeaderExpanded() {},
      onCycleContextPaneTab() {},
      onOpenCompanionReview() {},
    }),
  );

  assert.match(html, /直近 run の command 記録はありません/);
  assert.match(html, /command-monitor-empty-shell/);
});
