import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { createRef, useState, type ComponentType, type ProfilerOnRenderCallback } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SessionActionDockCompactRow,
  SessionContextPane,
  SessionComposerExpanded,
  SessionChatScreen,
  SessionMessageColumn,
  shouldAdjustSessionMessageScrollPosition,
  type SessionMessageColumnProps,
} from "../../src/session-components.js";
import { StableSessionMessageColumn } from "../../src/chat/chat-window.js";
import { ConversationMessageColumn } from "../../src/chat/conversation-message-column.js";
import { useCompanionCharacterProfile } from "../../src/companion-character-profile.js";
import type { CompanionSession } from "../../src/companion-state.js";
import { buildContextPaneProjection } from "../../src/session-ui-projection.js";
import { buildMessageCollapseTargets } from "../../src/session-message-collapse.js";
import type { MessageListSource } from "../../src/auxiliary-session-message-projection.js";
import type { CharacterProfile, LiveApprovalRequest, LiveElicitationRequest, Message } from "../../src/app-state.js";
import { resolveSelectionActionOverlayPosition } from "../../src/chat/selection-action-overlay.js";
import { createGlossaryAnnotationMatcher } from "../../src/glossary/glossary-annotation-projection.js";

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

const conversationTestThemeColors = {};

function ConversationBackedMessageColumn(props: SessionMessageColumnProps) {
  return React.createElement(ConversationMessageColumn, {
    session: {
      id: props.sessionId,
      messages: props.messages,
      characterId: "character",
      character: "Test Character",
      characterIconPath: "",
      characterThemeColors: conversationTestThemeColors,
    },
    baseProps: props,
    enabled: true,
  });
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

function createOperationsArtifactMessage(): Message {
  const message = createArtifactMessage();
  message.artifact!.operationTimeline = [
    {
      type: "command_execution",
      summary: "npm test",
      details: "test output",
    },
    {
      type: "command_execution",
      summary: "npm run typecheck",
      details: "typecheck output",
    },
    {
      type: "mcp_tool_call",
      summary: "filesystem/read",
      details: "mcp output",
    },
    {
      type: "command_execution",
      summary: "npm run build",
      details: "build output",
    },
  ];
  return message;
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
  liveRunErrorMessage?: string;
  pendingMessageText?: string;
  pendingMessageGroupId?: string | null;
  withResponseActions?: boolean;
  messageGroups?: SessionMessageColumnProps["messageGroups"];
  messageKeys?: SessionMessageColumnProps["messageKeys"];
  messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
  collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
  messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
  onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
  onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
  messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  glossaryAnnotationMatcher?: SessionMessageColumnProps["glossaryAnnotationMatcher"];
  onActivateGlossaryEntry?: SessionMessageColumnProps["onActivateGlossaryEntry"];
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
      liveRunErrorMessage: options.liveRunErrorMessage ?? "",
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
      messageViewMode: options.messageViewMode,
      glossaryAnnotationMatcher: options.glossaryAnnotationMatcher,
      onActivateGlossaryEntry: options.onActivateGlossaryEntry,
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
    isContentActive?: boolean;
    isMessageListFollowing?: boolean;
    messageGroups?: SessionMessageColumnProps["messageGroups"];
    messageKeys?: SessionMessageColumnProps["messageKeys"];
    messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
    collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
    messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
    onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
    onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
    messages?: Message[];
    onCopyMessageText?: (text: string) => void;
    onQuoteMessageText?: (text: string) => void;
    pendingMessageGroupId?: string | null;
    pendingMessageText?: string;
    messageViewMode?: SessionMessageColumnProps["messageViewMode"];
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
  isContentActive?: boolean;
  component?: ComponentType<SessionMessageColumnProps>;
  isRunning?: boolean;
  messageGroups?: SessionMessageColumnProps["messageGroups"];
  messageKeys?: SessionMessageColumnProps["messageKeys"];
  messageCollapseTargets?: SessionMessageColumnProps["messageCollapseTargets"];
  collapsedMessageKeys?: SessionMessageColumnProps["collapsedMessageKeys"];
  messageJumpRequest?: SessionMessageColumnProps["messageJumpRequest"];
  onToggleMessageCollapse?: SessionMessageColumnProps["onToggleMessageCollapse"];
  onToggleAllMessageCollapse?: SessionMessageColumnProps["onToggleAllMessageCollapse"];
  pendingMessageGroupId?: string | null;
  pendingMessageText?: string;
  messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  onRender?: ProfilerOnRenderCallback;
}): Promise<MountedSessionMessageColumn> {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousDOMRect = globalThis.DOMRect;
  const previousEvent = globalThis.Event;
  const previousMouseEvent = globalThis.MouseEvent;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const messageListRef = createRef<HTMLDivElement>();
  const root = createRoot(container);
  const originalGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const originalAttachEvent = (dom.window.HTMLElement.prototype as unknown as { attachEvent?: () => void }).attachEvent;
  const originalDetachEvent = (dom.window.HTMLElement.prototype as unknown as { detachEvent?: () => void }).detachEvent;
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "offsetHeight");
  const originalClientHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "clientHeight");
  const originalScrollHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "scrollHeight");
  const originalScrollTo = dom.window.HTMLElement.prototype.scrollTo;
  const originalScrollIntoView = dom.window.HTMLElement.prototype.scrollIntoView;
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
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
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains("session-selection-action-overlay")) {
      return createRect({ left: 0, top: 0, width: 960, height: 720 });
    }
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
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
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
    isContentActive?: boolean;
    isMessageListFollowing?: boolean;
    messageGroups?: SessionMessageColumnProps["messageGroups"];
    messages?: Message[];
    onCopyMessageText?: (text: string) => void;
    onQuoteMessageText?: (text: string) => void;
    pendingMessageGroupId?: string | null;
    pendingMessageText?: string;
    messageViewMode?: SessionMessageColumnProps["messageViewMode"];
  }) => {
    await act(async () => {
      const messageColumn = React.createElement(MessageColumn, {
          sessionId: "session-1",
          character,
          messages: callbacks.messages ?? options.messages,
          messageKeys: callbacks.messageKeys ?? options.messageKeys,
          messageGroups: callbacks.messageGroups ?? options.messageGroups,
          messageCollapseTargets: callbacks.messageCollapseTargets ?? options.messageCollapseTargets,
          collapsedMessageKeys: callbacks.collapsedMessageKeys ?? options.collapsedMessageKeys,
          messageJumpRequest: callbacks.messageJumpRequest ?? options.messageJumpRequest,
          expandedArtifacts,
          messageListRef,
          isRunning: options.isRunning ?? false,
          liveApprovalRequest: null,
          approvalActionRequestId: null,
          liveElicitationRequest: null,
          elicitationActionRequestId: null,
          liveRunAssistantText: "",
          hasLiveRunAssistantText: false,
          liveRunErrorMessage: "",
          pendingMessageText: callbacks.pendingMessageText ?? options.pendingMessageText,
          pendingMessageGroupId: callbacks.pendingMessageGroupId ?? options.pendingMessageGroupId,
          isMessageListFollowing: callbacks.isMessageListFollowing ?? false,
          isContentActive: callbacks.isContentActive ?? options.isContentActive ?? true,
          onMessageListScroll() {},
          onToggleMessageCollapse: callbacks.onToggleMessageCollapse ?? options.onToggleMessageCollapse,
          onToggleAllMessageCollapse: callbacks.onToggleAllMessageCollapse ?? options.onToggleAllMessageCollapse,
          onToggleArtifact() {},
          onOpenDiff() {},
          onResolveLiveApproval() {},
          onResolveLiveElicitation() {},
          onOpenPath: undefined,
          getChangedFilesEmptyText: callbacks.getChangedFilesEmptyText ?? defaultGetChangedFilesEmptyText,
          onCopyMessageText: callbacks.onCopyMessageText,
          onQuoteMessageText: callbacks.onQuoteMessageText,
          messageViewMode: callbacks.messageViewMode ?? options.messageViewMode,
        });
      const profiledMessageColumn = options.onRender
        ? React.createElement(React.Profiler, { id: "session-message-column", onRender: options.onRender }, messageColumn)
        : messageColumn;
      root.render(React.createElement(SessionChatScreen, {
        mode: "agent",
        header: null,
        headerSplitter: null,
        isHeaderVisible: false,
        messageColumn: profiledMessageColumn,
        actionDock: null,
        actionDockSplitter: null,
        isActionDockExpanded: false,
        splitter: null,
        rightPane: null,
      }));
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
      for (const input of dom.window.document.querySelectorAll<HTMLInputElement>("input, textarea, [contenteditable='true']")) {
        input.blur();
      }
      if (dom.window.document.activeElement instanceof dom.window.HTMLElement) {
        dom.window.document.activeElement.blur();
      }
      await act(async () => {
        root.unmount();
      });
      dom.window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalAttachEvent) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
          configurable: true,
          value: originalAttachEvent,
        });
      } else {
        delete (dom.window.HTMLElement.prototype as unknown as { attachEvent?: () => void }).attachEvent;
      }
      if (originalDetachEvent) {
        Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
          configurable: true,
          value: originalDetachEvent,
        });
      } else {
        delete (dom.window.HTMLElement.prototype as unknown as { detachEvent?: () => void }).detachEvent;
      }
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
      dom.window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      dom.window.close();
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
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

test("SessionMessageColumn はvalid glossaryを通常messageへだけ投影しSourceでは注釈しない", () => {
  const glossaryAnnotationMatcher = createGlossaryAnnotationMatcher([{
    term: "Runtime",
    aliases: [],
    definition: "Runtime definition",
  }], "revision-1");
  const messages: Message[] = [{
    role: "assistant",
    text: "Runtime",
    artifact: {
      title: "Runtime artifact",
      activitySummary: [],
      operationTimeline: [{ type: "command_execution", summary: "Runtime", details: "Runtime" }],
      changedFiles: [],
      runChecks: [],
    },
  }];
  const previewHtml = renderSessionMessageColumn({
    messages,
    expandedArtifacts: { "message-0": true },
    glossaryAnnotationMatcher,
    onActivateGlossaryEntry: () => undefined,
  });
  const sourceHtml = renderSessionMessageColumn({
    messages,
    glossaryAnnotationMatcher,
    onActivateGlossaryEntry: () => undefined,
    messageViewMode: "source",
  });

  assert.equal((previewHtml.match(/class="glossary-annotation"/g) ?? []).length, 1);
  assert.doesNotMatch(sourceHtml, /class="glossary-annotation"/);
});

// @test-value v1
// kind = "contract"
// claim = "個別collapse controlは状態と対象本文を支援技術へ公開しkeyboard focusとclickで操作でき、一括shortcutも維持される"
// oracle = { type = "contract", ref = "accepted behavior: accessible name、aria-expanded、aria-controlsと一括shortcutを維持する" }
// failure_mode = "個別controlがkeyboardから到達不能になるかARIAの状態・対象を失う、または一括shortcutが動作しなくなる"
// scope = "SessionMessageColumn collapse controls"
// lifecycle = "permanent"
// distinction = "DOM owner境界ではなく、個別controlのaccessibility contractと一括shortcutの操作経路を検証する"
// @end-test-value
test("SessionMessageColumn は個別・一括collapseをnative controlで操作する", async () => {
  const messages: Message[] = [
    { role: "user", text: "first **collapsed** message" },
    { role: "assistant", text: "second message" },
  ];
  const messageKeys = ["session-s-0", "session-s-1"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    messages.map((_, messageIndex): MessageListSource => ({ kind: "session", messageIndex })),
    messageKeys,
  );
  let toggledKey: string | null = null;
  let allToggleCount = 0;
  const collapsedMessageKeys = new Set(["session-s-0"]);
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    collapsedMessageKeys,
    onToggleMessageCollapse: (key) => {
      toggledKey = key;
    },
    onToggleAllMessageCollapse: () => {
      allToggleCount += 1;
    },
  });

  try {
    const collapsedBody = mounted.container.querySelector("#message-body-session-s-0");
    assert.ok(collapsedBody);
    assert.equal(collapsedBody.querySelector(".rich-text"), null);
    assert.equal(collapsedBody.querySelector(".message-collapsed-preview")?.textContent, "first collapsed message");
    const individualButton = mounted.container.querySelector<HTMLButtonElement>(
      "button[aria-label^='メッセージを展開']",
    );
    assert.ok(individualButton);
    assert.equal(individualButton.getAttribute("aria-expanded"), "false");
    assert.equal(individualButton.getAttribute("aria-controls"), "message-body-session-s-0");
    await act(async () => {
      individualButton.focus();
    });
    assert.equal(mounted.dom.window.document.activeElement, individualButton);
    await act(async () => {
      individualButton.click();
    });
    assert.equal(toggledKey, "session-s-0");

    const shortcutEvent = new mounted.dom.window.KeyboardEvent("keydown", {
      key: "M",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      mounted.dom.window.document.body.dispatchEvent(shortcutEvent);
    });
    assert.equal(allToggleCount, 1);
    assert.equal(shortcutEvent.defaultPrevented, true);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v1
// kind = "regression"
// claim = "個別collapse controlとmessage本文は同じtext wrapperに属し、Detailsはそのwrapperの外側に残る"
// oracle = { type = "contract", ref = "accepted behavior: 個別の縮小・展開controlはMessage本文領域だけをownerにする" }
// failure_mode = "collapse controlのoverlay ownerがmessage card全体になり、展開したDetails上へcontrolが追従する"
// scope = "SessionMessageColumn message text owner boundary"
// lifecycle = "permanent"
// distinction = "個別・一括操作の状態遷移ではなく、本文とDetailsのDOM owner境界を検証する"
// @end-test-value
test("SessionMessageColumn は個別collapse controlを本文wrapper内に保ちDetailsをownerに含めない", async () => {
  const messages = [createArtifactMessage()];
  messages[0]!.text = "long message ".repeat(80);
  const messageKeys = ["session-s-0"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    [{ kind: "session", messageIndex: 0 }],
    messageKeys,
  );
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    expandedArtifacts: { "session-1-0": true },
    onToggleMessageCollapse: () => undefined,
  });

  try {
    const card = mounted.container.querySelector(".message-card");
    const textWrapper = card?.querySelector(".message-text-wrapper");
    const collapseControl = card?.querySelector(".message-collapse-control");
    const messageBody = card?.querySelector("[data-message-body='true']");
    const artifactShell = card?.querySelector(".artifact-shell");

    assert.ok(textWrapper);
    assert.equal(collapseControl?.parentElement, textWrapper);
    assert.equal(messageBody?.parentElement, textWrapper);
    assert.equal(textWrapper.querySelector(".artifact-shell"), null);
    assert.equal(artifactShell?.parentElement, textWrapper.parentElement);
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn はfind中だけ縮小messageを一時展開する", async () => {
  const messages: Message[] = [{ role: "assistant", text: "**needle** remains searchable" }];
  const messageKeys = ["session-s-0"];
  const messageCollapseTargets = buildMessageCollapseTargets(
    messages,
    [{ kind: "session", messageIndex: 0 }],
    messageKeys,
  );
  const mounted = await mountSessionMessageColumn({
    messages,
    messageKeys,
    messageCollapseTargets,
    collapsedMessageKeys: new Set(messageKeys),
  });

  try {
    assert.ok(mounted.container.querySelector(".message-collapsed-preview"));
    await act(async () => {
      mounted.dom.window.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }));
    });
    const input = mounted.container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });
    assert.equal(mounted.container.querySelector(".message-collapsed-preview"), null);
    assert.ok(mounted.container.querySelector("#message-body-session-s-0 > .rich-text"));
  } finally {
    await mounted.cleanup();
  }
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

test("SessionMessageColumn は検索開始時に未mountの最初の一致へ移動する", async () => {
  class TestHighlight {
    readonly ranges: Range[] = [];

    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const messages = createMessages(100);
  messages[0] = { role: "assistant", text: "only early needle and another needle" };
  const mounted = await mountSessionMessageColumn({ messages });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    const initialScrollTop = messageList.scrollTop;
    assert.doesNotMatch(mounted.container.textContent ?? "", /only early needle/);

    await act(async () => {
      mounted.dom.window.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }));
    });
    const input = mounted.container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.ok(messageList.scrollTop < initialScrollTop);
    await act(async () => {
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    assert.match(mounted.container.textContent ?? "", /only early needle/);
    assert.deepEqual(
      highlights.get("withmate-find-match")?.ranges.map((range) => range.toString()),
      ["needle", "needle"],
    );
    assert.deepEqual(
      highlights.get("withmate-find-current")?.ranges.map((range) => range.startOffset),
      [11],
    );
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn の検索は表示文字列とpendingを同じ順序で数え現在位置をclampする", async () => {
  class TestHighlight {
    readonly ranges: Range[] = [];

    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const linkMessage: Message = {
    role: "assistant",
    text: "[needle](https://needle.example/path)",
  };
  const mounted = await mountSessionMessageColumn({
    isRunning: true,
    messages: [linkMessage],
    pendingMessageText: "pending needle",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }));
    });
    const input = mounted.container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "1/2");
    assert.equal(highlights.get("withmate-find-match")?.ranges.length, 2);
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.startContainer.parentElement?.tagName,
      "A",
    );

    const nextButton = mounted.container.querySelector<HTMLButtonElement>("button[aria-label='Next match']");
    assert.ok(nextButton);
    await act(async () => {
      nextButton.click();
    });
    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "2/2");
    assert.equal(
      highlights.get("withmate-find-current")?.ranges[0]?.startContainer.parentElement?.tagName,
      "P",
    );

    await mounted.rerender({
      messages: [],
      pendingMessageText: "pending needle",
    });
    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "1/1");
    assert.equal(highlights.get("withmate-find-current")?.ranges.length, 1);
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn の Source 検索は link URL を含む元 Markdown を対象にする", async () => {
  class TestHighlight {
    readonly ranges: Range[] = [];

    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const mounted = await mountSessionMessageColumn({
    messages: [{ role: "assistant", text: "[label](https://example.test/source-path)" }],
    messageViewMode: "source",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }));
    });
    const input = mounted.container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "example.test/source-path");
      const propertyChange = new mounted.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "1/1");
    assert.equal(highlights.get("withmate-find-current")?.ranges[0]?.toString(), "example.test/source-path");
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn の検索は Auxiliary group 内のpendingを画面表示順に数える", async () => {
  class TestHighlight {
    readonly ranges: Range[] = [];

    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const mounted = await mountSessionMessageColumn({
    isRunning: true,
    messages: [
      { role: "assistant", text: "main needle" },
      { role: "user", text: "aux needle", accent: true },
      { role: "assistant", text: "later needle" },
    ],
    messageGroups: [
      null,
      { id: "aux-1", label: "Auxiliary" },
      null,
    ],
    pendingMessageText: "pending needle",
    pendingMessageGroupId: "aux-1",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }));
    });
    const input = mounted.container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "needle");
      const propertyChange = new mounted.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    const nextButton = mounted.container.querySelector<HTMLButtonElement>("button[aria-label='Next match']");
    assert.ok(nextButton);
    await act(async () => nextButton.click());
    await act(async () => nextButton.click());

    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "3/4");
    const pendingRange = highlights.get("withmate-find-current")?.ranges[0];
    assert.ok(pendingRange);
    assert.ok(
      pendingRange.startContainer.parentElement?.closest("[data-pending-message-body='true']"),
      "3件目は後続main messageではなくgroup内pendingを指す",
    );

    await act(async () => nextButton.click());
    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "4/4");
    const laterRange = highlights.get("withmate-find-current")?.ranges[0];
    assert.equal(
      laterRange?.startContainer.parentElement?.closest<HTMLElement>(".session-message-virtual-row")?.dataset.index,
      "2",
    );
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn の検索は5000件highlight budgetへgroup内pendingを表示順に含める", async () => {
  class TestHighlight {
    readonly ranges: Range[] = [];

    constructor(...ranges: Range[]) {
      assert.equal(ranges.length, 0);
    }

    add(range: Range) {
      this.ranges.push(range);
      return this;
    }
  }

  const mounted = await mountSessionMessageColumn({
    isRunning: true,
    messages: [
      { role: "user", text: "x", accent: true },
      { role: "assistant", text: "x".repeat(6_000) },
    ],
    messageGroups: [
      { id: "aux-1", label: "Auxiliary" },
      null,
    ],
    pendingMessageText: "x",
    pendingMessageGroupId: "aux-1",
  });

  try {
    const highlights = new Map<string, TestHighlight>();
    Object.defineProperty(mounted.dom.window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(mounted.dom.window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });
    await act(async () => {
      mounted.dom.window.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
      }));
    });
    const input = mounted.container.querySelector<HTMLInputElement>("input[aria-label='Find in current content']");
    assert.ok(input);
    const setInputValue = Object.getOwnPropertyDescriptor(
      mounted.dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(input, "x");
      const propertyChange = new mounted.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      input.dispatchEvent(propertyChange);
    });

    assert.equal(mounted.container.querySelector(".session-content-find-count")?.textContent, "1/6002");
    const allMatches = highlights.get("withmate-find-match")?.ranges ?? [];
    assert.equal(allMatches.length, 5_000);
    assert.ok(
      allMatches.some((range) => range.startContainer.parentElement?.closest("[data-pending-message-body='true']")),
      "semantic順で2件目のpendingを先頭5000件highlightへ含める",
    );
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
      const start = Number.parseFloat(
        row.style.top
          || (
            row.style.transform.match(/translate3d\(0,\s*([^p]+)px/)?.[1]
            ?? row.style.transform.match(/translateY\(([^p]+)px\)/)?.[1]
            ?? "0"
          ),
      );
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

test("SessionMessageColumn は上方向scroll中も上側rowのvisible anchorを補正する", () => {
  assert.equal(shouldAdjustSessionMessageScrollPosition({
    itemStart: 1_000,
    scrollOffset: 4_000,
  }), true);
  assert.equal(shouldAdjustSessionMessageScrollPosition({
    itemStart: 5_000,
    scrollOffset: 4_000,
  }), false);
});

test("SessionMessageColumn はappend時の末尾移動をfollow ownerへ委ねる", async () => {
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
    await act(async () => {
      await new Promise<void>((resolve) => mounted.dom.window.requestAnimationFrame(() => resolve()));
    });

    assert.equal(messageList.scrollTop, followingScrollTop);
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

test("SessionMessageColumn は同じ仮想範囲内の連続scrollでmessageを再描画しない", async () => {
  let renderCount = 0;
  const messages = Array.from({ length: 100 }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    text: `message ${index + 1}`,
  }));
  const mounted = await mountSessionMessageColumn({
    messages,
    onRender: () => {
      renderCount += 1;
    },
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = 3_000;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const rendersAfterFirstScroll = renderCount;

    for (const scrollTop of [3_002, 3_004, 3_006, 3_008, 3_010]) {
      await act(async () => {
        messageList.scrollTop = scrollTop;
        messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
      });
    }

    assert.equal(renderCount, rendersAfterFirstScroll);
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn は非表示から復帰したとき独自に末尾へ移動しない", async () => {
  const mounted = await mountSessionMessageColumn({
    messages: createMessages(100),
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);

    await mounted.rerender({
      isContentActive: false,
      isMessageListFollowing: false,
    });
    messageList.scrollTop = 0;

    await mounted.rerender({
      isContentActive: true,
      isMessageListFollowing: false,
    });

    assert.equal(messageList.scrollTop, 0);
  } finally {
    await mounted.cleanup();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "StableSessionMessageColumnはcallbackの再生成だけで既存messageを再描画しない"
// oracle = { type = "contract", ref = "Issue #714: 親callback更新時も既存Markdown画像を保持する" }
// fault = "callback参照の更新だけでmemoized message columnが再描画され、既存messageの本文評価や画像lifecycleがやり直される"
// observable = "既存Message.text getterの読み取り回数"
// observation_boundary = "component-behavior"
// scope = "StableSessionMessageColumnのcallback安定化境界"
// lifecycle = "permanent"
// impact = "composer入力時の無関係な親更新で表示済み会話の画像が再mountされる"
// distinction = "ConversationMessageColumnのprojection生成を通した回帰とは別に、共通stable boundary単体のmemo動作を観測する"
// @end-test-value
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

// @test-value v2
// kind = "invariant"
// claim = "ConversationMessageColumnは親callbackの再生成だけで既存messageの本文を再評価しない"
// oracle = { type = "contract", ref = "Issue #714: ConversationMessageColumnから共通SessionMessageColumnへの既存Markdown保持" }
// fault = "ConversationMessageColumnが生成するcharacter・Set・callbackが親更新だけでSessionMessageColumnへ伝播し、既存messageのMarkdown処理が再実行される"
// observable = "既存Message.text getterの読み取り回数"
// observation_boundary = "component-behavior"
// scope = "ConversationMessageColumnの共通stable boundary"
// lifecycle = "permanent"
// impact = "composer入力時に表示済み会話のMarkdown画像が再mountされ、loading状態や表示位置が失われる"
// distinction = "StableSessionMessageColumn単体の確認とは別に、実際のConversationMessageColumn componentでprojection・character・Set生成を通した親更新を観測する"
// @end-test-value
test("ConversationMessageColumn は callback 再生成だけでは既存 message を再評価しない", async () => {
  let messageTextReadCount = 0;
  const message = {
    role: "assistant" as const,
    get text() {
      messageTextReadCount += 1;
      return "stable conversation message";
    },
  };
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    component: ConversationBackedMessageColumn,
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

test("SessionMessageColumn は未追従時に message list 内の jump UI を描画しない", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(2),
    isMessageListFollowing: false,
  });

  assert.doesNotMatch(html, /message-follow-banner/);
  assert.doesNotMatch(html, /末尾へ移動/);
});

test("SessionMessageColumn はChanged Filesを描画せずRun Checksを維持し、Operationsを1groupで初期closedにする", () => {
  const html = renderSessionMessageColumn({
    messages: [createOperationsArtifactMessage()],
    expandedArtifacts: { "session-1-0": true },
  });
  const dom = new JSDOM(html);
  const operationsGroup = dom.window.document.querySelector<HTMLDetailsElement>(".artifact-operations-fold");
  const operationFolds = Array.from(operationsGroup?.querySelectorAll<HTMLDetailsElement>(".artifact-operation-fold") ?? []);

  assert.match(html, /artifact-panel-session-1-0/);
  assert.doesNotMatch(html, /Changed Files/);
  assert.doesNotMatch(html, /src\/App\.tsx/);
  assert.doesNotMatch(html, /Open Diff/);
  assert.match(html, /snapshot files/);
  assert.ok(operationsGroup);
  assert.equal(operationsGroup.querySelector(".artifact-fold-summary-copy span")?.textContent, "4 operations");
  assert.equal(operationsGroup.open, false);
  assert.equal(operationsGroup.querySelector("summary")?.getAttribute("aria-expanded"), "false");
  assert.equal(operationFolds.length, 4);
  assert.deepEqual(
    operationFolds.map((operation) => operation.querySelector(".artifact-operation-type")?.textContent),
    ["Command", "Command", "MCP", "Command"],
  );
  assert.deepEqual(
    operationFolds.map((operation) => operation.querySelector(".artifact-operation-summary-text")?.textContent),
    ["npm test", "npm run typecheck", "filesystem/read", "npm run build"],
  );
  for (const operation of operationFolds) {
    assert.equal(operation.open, false);
    assert.equal(operation.querySelector("summary")?.getAttribute("aria-expanded"), "false");
  }
});

test("SessionMessageColumn はOperationsと個別operationを開閉でき、長文operationをgroup内部へ保持する", async () => {
  const message = createArtifactMessage();
  message.artifact!.operationTimeline = [{
    type: "command_execution",
    summary: "npm test",
    details: Array.from({ length: 120 }, (_, index) => `output line ${index + 1}`).join("\n"),
  }];
  const mounted = await mountSessionMessageColumn({
    messages: [message],
    expandedArtifacts: { "session-1-0": true },
  });

  try {
    const operationsGroup = mounted.container.querySelector<HTMLDetailsElement>(".artifact-operations-fold");
    const operationGroup = mounted.container.querySelector<HTMLDetailsElement>(".artifact-operation-fold");
    assert.ok(operationsGroup);
    assert.ok(operationGroup);
    const operationsSummary = operationsGroup.querySelector("summary");
    const operationSummary = operationGroup.querySelector("summary");
    assert.ok(operationsSummary);
    assert.ok(operationSummary);
    assert.equal(operationsGroup.open, false);
    assert.equal(operationGroup.open, false);
    assert.equal(operationsSummary.textContent?.includes("1 operation"), true);
    assert.equal(operationsSummary.getAttribute("aria-controls"), operationsGroup.querySelector(".artifact-operations-body")?.id);
    assert.equal(operationSummary.getAttribute("aria-controls"), operationGroup.querySelector(".artifact-operation-body")?.id);

    await act(async () => {
      operationsGroup.open = true;
      operationsGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationsGroup.open, true);
    assert.equal(operationsGroup.querySelector("summary")?.getAttribute("aria-expanded"), "true");
    assert.equal(operationGroup.open, false);
    assert.match(operationsGroup.querySelector(".artifact-operations-body")?.textContent ?? "", /output line 120/);

    await act(async () => {
      operationGroup.open = true;
      operationGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationGroup.open, true);
    assert.equal(operationGroup.querySelector("summary")?.getAttribute("aria-expanded"), "true");

    await act(async () => {
      operationGroup.open = false;
      operationGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationGroup.open, false);
    assert.equal(operationGroup.querySelector("summary")?.getAttribute("aria-expanded"), "false");

    await act(async () => {
      operationsGroup.open = false;
      operationsGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(operationsGroup.open, false);
    assert.equal(operationsGroup.querySelector("summary")?.getAttribute("aria-expanded"), "false");
  } finally {
    await mounted.cleanup();
  }
});

test("SessionMessageColumn はvirtualizationでrowが再mountしてもOperationsとoperationの開閉状態を維持する", async () => {
  const messages = Array.from({ length: 30 }, (_, index) => (
    index === 0
      ? createOperationsArtifactMessage()
      : { role: "user" as const, text: `message ${index + 1}` }
  ));
  const mounted = await mountSessionMessageColumn({
    messages,
    expandedArtifacts: { "session-1-0": true },
  });

  try {
    const messageList = mounted.messageListRef.current;
    assert.ok(messageList);
    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });

    const initialOperationsGroup = mounted.container.querySelector<HTMLDetailsElement>(".artifact-operations-fold");
    assert.ok(initialOperationsGroup);
    await act(async () => {
      initialOperationsGroup.open = true;
      initialOperationsGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    const initialOperationGroup = mounted.container.querySelector<HTMLDetailsElement>(".artifact-operation-fold");
    assert.ok(initialOperationGroup);
    await act(async () => {
      initialOperationGroup.open = true;
      initialOperationGroup.dispatchEvent(new mounted.dom.window.Event("toggle"));
    });
    assert.equal(initialOperationsGroup.open, true);
    assert.equal(initialOperationGroup.open, true);

    await act(async () => {
      messageList.scrollTop = messageList.scrollHeight;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    assert.equal(mounted.container.querySelector(".artifact-operations-fold"), null);

    await act(async () => {
      messageList.scrollTop = 0;
      messageList.dispatchEvent(new mounted.dom.window.Event("scroll"));
    });
    const remountedOperationsGroup = mounted.container.querySelector<HTMLDetailsElement>(".artifact-operations-fold");
    const remountedOperationGroup = mounted.container.querySelector<HTMLDetailsElement>(".artifact-operation-fold");
    assert.ok(remountedOperationsGroup);
    assert.ok(remountedOperationGroup);
    assert.equal(remountedOperationsGroup.open, true);
    assert.equal(remountedOperationsGroup.querySelector("summary")?.getAttribute("aria-expanded"), "true");
    assert.equal(remountedOperationGroup.open, true);
    assert.equal(remountedOperationGroup.querySelector("summary")?.getAttribute("aria-expanded"), "true");
  } finally {
    await mounted.cleanup();
  }
});

test("selection action geometry は viewport と ActionDock 境界内で flip と左右 clamp を行う", () => {
  const overlayRect = createRect({ left: 0, top: 0, width: 360, height: 640 });
  const sourceRect = createRect({ left: 12, top: 80, width: 336, height: 500 });
  const actionDockRect = createRect({ left: 12, top: 580, width: 336, height: 48 });
  const toolbarRect = { width: 112, height: 32 };

  const nearDock = resolveSelectionActionOverlayPosition({
    anchorRect: createRect({ left: 150, top: 566, width: 60, height: 12 }),
    actionDockRect,
    overlayRect,
    sourceRect,
    toolbarRect,
  });
  assert.deepEqual(nearDock, { left: 124, maxWidth: 320, top: 526 });
  assert.ok((nearDock?.top as number) + toolbarRect.height < actionDockRect.top);

  const leftEdge = resolveSelectionActionOverlayPosition({
    anchorRect: createRect({ left: -20, top: 120, width: 20, height: 20 }),
    actionDockRect,
    overlayRect,
    sourceRect,
    toolbarRect,
  });
  assert.equal(leftEdge?.left, 20);

  const rightEdge = resolveSelectionActionOverlayPosition({
    anchorRect: createRect({ left: 350, top: 120, width: 20, height: 20 }),
    actionDockRect,
    overlayRect,
    sourceRect,
    toolbarRect,
  });
  assert.equal(rightEdge?.left, 228);
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

test("SessionMessageColumn は保持された assistant text を run の終了状態に関係なく response action 対象にする", () => {
  const states = [
    { label: "cancel前", isRunning: true, liveRunErrorMessage: "" },
    { label: "cancel後", isRunning: false, liveRunErrorMessage: "キャンセルしました" },
    { label: "failed", isRunning: false, liveRunErrorMessage: "実行に失敗しました" },
    { label: "running", isRunning: true, liveRunErrorMessage: "" },
    { label: "通常完了", isRunning: false, liveRunErrorMessage: "" },
  ];

  for (const state of states) {
    const html = renderSessionMessageColumn({
      messages: [{ role: "assistant", text: `${state.label}の保持済みresponse` }],
      isRunning: state.isRunning,
      liveRunErrorMessage: state.liveRunErrorMessage,
      withResponseActions: true,
    });

    assert.equal(
      (html.match(/data-message-text-actions="true"/g) ?? []).length,
      1,
      `${state.label}でも保持された assistant text を操作対象にする`,
    );
  }
});

test("SessionMessageColumn は pending response text も response action 対象にする", () => {
  const html = renderSessionMessageColumn({
    messages: [{ role: "user", text: "prompt" }],
    isRunning: true,
    pendingMessageText: "途中まで生成されたresponse",
    withResponseActions: true,
  });

  const dom = new JSDOM(html);
  const pendingBody = dom.window.document.querySelector("[data-pending-message-body='true']");
  assert.ok(pendingBody);
  assert.equal(pendingBody.getAttribute("data-message-body"), "true");
  assert.equal(pendingBody.getAttribute("data-message-text-actions"), "true");
});

// @test-value v2
// kind = "contract"
// claim = "選択範囲がassistant本文内にあるときresponse action toolbarを表示し、対象外本文では除去する。Source切替時は既存toolbarを除去し、Source本文を新たに選択した場合は再表示する"
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023D9" }
// fault = "user message選択でtoolbarが残る、Source切替後の既存toolbarが残る、Source本文の新規選択でtoolbarが再表示されない、copy/quote actionが選択本文を受け取れない"
// observable = "mounted SessionMessageColumn DOMとselectionchange・resize・scrollによるtoolbarの表示・除去、Source本文の再選択後のtoolbar、copy/quote callback"
// observation_boundary = "component-behavior"
// scope = "SessionMessageColumn selection response actions"
// lifecycle = "permanent"
// impact = "assistant response text actionの到達性と非対象messageへの誤表示を防ぐ"
// distinction = "selection eventの実DOM遷移を検証し、static markupやtypecheckではselection ownerとlifecycleを確認しない"
// @end-test-value
test("SessionMessageColumn は選択範囲にだけ response action toolbar を表示する", async () => {
  const copiedTexts: string[] = [];
  const quotedTexts: string[] = [];
  const assistantMessage = "assistant result text\n\n```text\nnested code text\n```";
  const mounted = await mountSessionMessageColumn({
    messages: [
      { role: "assistant", text: assistantMessage },
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
    let resolveSelectionNode: (() => Node | null) | null = null;
    const selection = {
      get isCollapsed() {
        return isCollapsed;
      },
      get rangeCount() {
        return isCollapsed ? 0 : 1;
      },
      getRangeAt() {
        return {
          get commonAncestorContainer() {
            return resolveSelectionNode?.() ?? selectionNode;
          },
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

    const selectText = async (body: Element, text: string, rect: DOMRect, targetSelector?: string) => {
      const target = targetSelector
        ? body.querySelector(targetSelector)
        : body.querySelector(".message-paragraph") ?? body.querySelector(".message-body");
      const textNode = target?.firstChild;
      assert.ok(textNode);
      selectionNode = textNode;
      resolveSelectionNode = targetSelector
        ? () => container
          .querySelector("[data-message-text-actions='true']")
          ?.querySelector(targetSelector)
          ?.firstChild ?? null
        : null;
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

    const getAssistantBody = () => {
      const body = container.querySelector("[data-message-text-actions=\"true\"]");
      assert.ok(body);
      return body;
    };
    let assistantBody = getAssistantBody();
    await selectText(assistantBody, "  assistant result\n", anchorRect);

    let toolbar = container.querySelector(".message-response-actions") as HTMLElement | null;
    assert.ok(toolbar);
    assert.ok(toolbar.parentElement?.classList.contains("session-selection-action-overlay"));
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
    assert.deepEqual(copiedTexts, ["  assistant result\n"]);
    assert.deepEqual(quotedTexts, ["  assistant result\n"]);

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

    assistantBody = getAssistantBody();
    await selectText(
      assistantBody,
      "nested code text",
      createRect({ left: 180, top: 280, width: 80, height: 20 }),
      ".message-code-block code",
    );
    assistantBody = getAssistantBody();
    const nestedScrollOwner = assistantBody.querySelector(".message-code-block");
    assert.ok(nestedScrollOwner);
    anchorRect = createRect({ left: 120, top: 280, width: 80, height: 20 });
    await act(async () => {
      nestedScrollOwner.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
    });
    toolbar = container.querySelector(".message-response-actions") as HTMLElement | null;
    assert.ok(toolbar);
    assert.equal(toolbar.style.left, "104px");
    assert.equal(toolbar.style.top, "240px");

    anchorRect = createRect({ left: 520, top: 520, width: 40, height: 20 });
    await act(async () => {
      messageList.dispatchEvent(new dom.window.Event("scroll"));
    });
    assert.equal(container.querySelector(".message-response-actions"), null);

    assistantBody = getAssistantBody();
    await selectText(assistantBody, "assistant result", createRect({ left: 100, top: 100, width: 60, height: 20 }));
    assert.ok(container.querySelector(".message-response-actions"));
    await mounted.rerender({
      messageViewMode: "source",
      onCopyMessageText: (text) => copiedTexts.push(text),
      onQuoteMessageText: (text) => quotedTexts.push(text),
    });
    assert.equal(container.querySelector(".message-response-actions"), null);
    assert.equal(
      container.querySelector("[data-message-text-actions='true']")?.textContent,
      assistantMessage,
    );

    const currentAssistantBody = container.querySelector("[data-message-text-actions='true']");
    assert.ok(currentAssistantBody);
    await selectText(
      currentAssistantBody,
      "assistant result",
      createRect({ left: 100, top: 100, width: 60, height: 20 }),
    );
    const sourceToolbar = container.querySelector(".message-response-actions") as HTMLElement | null;
    assert.ok(sourceToolbar);
    const sourceCopyButton = Array.from(sourceToolbar.querySelectorAll("button"))
      .find((button) => button.textContent === "Copy") as HTMLButtonElement | undefined;
    const sourceQuoteButton = Array.from(sourceToolbar.querySelectorAll("button"))
      .find((button) => button.textContent === "Quote") as HTMLButtonElement | undefined;
    assert.ok(sourceCopyButton);
    assert.ok(sourceQuoteButton);
    await act(async () => {
      sourceCopyButton.click();
      sourceQuoteButton.click();
    });
    assert.deepEqual(copiedTexts, ["  assistant result\n", "assistant result"]);
    assert.deepEqual(quotedTexts, ["  assistant result\n", "assistant result"]);
    await mounted.rerender({
      messages: [],
      onCopyMessageText: (text) => copiedTexts.push(text),
      onQuoteMessageText: (text) => quotedTexts.push(text),
      messageViewMode: "source",
    });
    await act(async () => Promise.resolve());
    assert.equal(container.querySelector(".message-response-actions"), null);
    await clearSelection();
  } finally {
    await mounted.cleanup();
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

test("SessionMessageColumn の Source は通常 message と pending の元 Markdown を表示する", () => {
  const messageSource = "> quote\n- [label](https://example.test/path)\n- `code`";
  const pendingSource = "pending  line\n\nnext";
  const html = renderSessionMessageColumn({
    messages: [{ role: "assistant", text: messageSource }],
    isRunning: true,
    pendingMessageText: pendingSource,
    messageViewMode: "source",
  });
  const dom = new JSDOM(html);
  const sources = [
    dom.window.document.querySelector("[data-message-body='true'] > .message-body"),
    dom.window.document.querySelector("[data-pending-message-body='true'] > .message-body"),
  ];

  assert.deepEqual(sources.map((element) => element?.textContent), [messageSource, pendingSource]);
  assert.equal(dom.window.document.querySelector("[data-message-body='true'] a"), null);
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

// @test-value v2
// kind = "contract"
// claim = "SessionComposerExpandedのidle DOMはattachment/view操作、closedなattachment menu、Add Directory/Dirs、target dock、Cancel予約slot、settingsとSendの構成を維持し、Hide/reopen導線を置かず、Cancel slotを非activeで保つ"
// oracle = { type = "contract", ref = "docs/manual-test-checklist.md: MT-023C, MT-023D4; docs/design/desktop-ui.md: Action Dock" }
// fault = "idle表示でattachment/view action・closedなattachment menu・Add Directory/Dirs・target dock・Cancel slot・SendのDOM配置が崩れる、Hide/reopen導線が混入する、Cancel slotがactiveまたはbuttonを持つ、Sendがsettings group内へ移動する"
// observable = "parsed SessionComposerExpandedのidle DOMにおけるattachment toolbar、closedなattachment menu、Skill直後のAdd Directory/Dirs、composer-toolbar-view-actions、Hide/reopen導線の不在、target/Cancel slot、composer-control-row直下のsettings groupとSend button"
// observation_boundary = "component-behavior"
// scope = "expanded ActionDock idle layout and Cancel slot"
// lifecycle = "permanent"
// impact = "SessionComposerExpandedのidle DOMで主操作とCancel予約領域の位置を維持し、誤操作可能なCancelを表示しない"
// distinction = "CSS declaration testは共有slotの幅を確認し、running component testはactiveなCancelとdisabled Sendを確認し、このtestはSessionComposerExpanded単体のidle DOMを確認する"
// @end-test-value
test("SessionComposerExpanded は Hide を描画せず、Send を設定グループの外へ配置する", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionComposerExpanded, {
      isRunning: false,
      pendingRunIndicatorAnnouncement: "処理を実行中",
      pendingRunIndicatorText: "処理を実行中",
      targetDock: React.createElement("span", { className: "test-target-dock" }, "Main / Auxiliary"),
      composerBlocked: false,
      canSelectCustomAgent: true,
      showCustomAgentPicker: true,
      showSkillPicker: true,
      showMessageViewModeControls: true,
      messageViewMode: "source",
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
      onMessageViewModeChange() {},
    }),
  );

  const renderedDocument = new JSDOM(html).window.document;
  const composer = renderedDocument.querySelector(".composer");
  const attachmentToolbar = renderedDocument.querySelector(".composer-attachments-toolbar");
  const attachmentMenu = attachmentToolbar?.querySelector(".composer-attachment-menu-shell");
  const attachmentButton = attachmentMenu?.querySelector("button.composer-attachment-trigger");
  const attachmentPanel = renderedDocument.querySelector("#composer-attachment-menu");
  const skillButton = Array.from(attachmentToolbar?.querySelectorAll("button") ?? [])
    .find((button) => button.textContent?.trim() === "Skill");
  const additionalDirectoryToolbar = attachmentToolbar?.querySelector(".composer-additional-directory-toolbar");
  const addDirectoryButton = additionalDirectoryToolbar?.querySelector("button:nth-child(1)");
  const directoriesButton = additionalDirectoryToolbar?.querySelector("button:nth-child(2)");
  const viewActions = renderedDocument.querySelector(".composer-toolbar-view-actions");
  const cancelSlot = viewActions?.querySelector(":scope > .session-action-dock-cancel-slot");
  const targetSlot = viewActions?.querySelector(":scope > .composer-target-dock-slot");
  const jumpButton = viewActions?.querySelector("button.message-jump-bottom-button");
  const viewModeGroup = viewActions?.querySelector(".composer-message-view-mode");
  const previewButton = viewModeGroup?.querySelector("button:nth-child(1)");
  const sourceButton = viewModeGroup?.querySelector("button:nth-child(2)");
  const composerInputRow = renderedDocument.querySelector(".composer-input-row");
  const controlRow = renderedDocument.querySelector(".composer-control-row");
  const settingsGroup = controlRow?.querySelector(":scope > .composer-settings");
  const sendButton = controlRow?.querySelector<HTMLButtonElement>(":scope > button.session-send-button");
  assert.ok(composer);
  assert.ok(attachmentToolbar);
  assert.ok(attachmentMenu);
  assert.ok(attachmentButton);
  assert.ok(skillButton);
  assert.ok(additionalDirectoryToolbar);
  assert.ok(addDirectoryButton);
  assert.ok(directoriesButton);
  assert.ok(viewActions);
  assert.ok(cancelSlot);
  assert.ok(targetSlot);
  assert.ok(jumpButton);
  assert.ok(viewModeGroup);
  assert.ok(previewButton);
  assert.ok(sourceButton);
  assert.ok(composerInputRow);
  assert.ok(controlRow);
  assert.ok(settingsGroup);
  assert.ok(sendButton);
  assert.equal(composer.firstElementChild, attachmentToolbar);
  assert.equal(attachmentToolbar.nextElementSibling, composerInputRow);
  assert.equal(attachmentMenu.parentElement, attachmentToolbar);
  assert.equal(attachmentButton.parentElement, attachmentMenu);
  assert.equal(attachmentPanel, null);
  assert.equal(skillButton.nextElementSibling, additionalDirectoryToolbar);
  assert.match(attachmentButton.textContent ?? "", /Attach/);
  assert.equal(addDirectoryButton.textContent, "Add Directory");
  assert.equal(directoriesButton.textContent, "Dirs 0");
  assert.ok((additionalDirectoryToolbar.compareDocumentPosition(viewActions) & 4) !== 0);
  assert.ok((attachmentMenu.compareDocumentPosition(viewActions) & 4) !== 0);
  assert.equal(viewActions.firstElementChild, cancelSlot);
  assert.equal(cancelSlot.nextElementSibling, targetSlot);
  assert.equal(cancelSlot.classList.contains("is-active"), false);
  assert.equal(cancelSlot.getAttribute("aria-hidden"), "true");
  assert.equal(cancelSlot.querySelector("button"), null);
  const forbiddenDockHitArea = Array.from(
    composer.querySelectorAll("button, [role=\"button\"], a, [tabindex]")
  ).find((element) => {
    const accessibleText = [
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ].filter(Boolean).join(" ");
    return /\b(?:hide|reopen)\b/i.test(accessibleText);
  });
  assert.equal(forbiddenDockHitArea, undefined);
  assert.equal(targetSlot.textContent, "Main / Auxiliary");
  assert.equal(jumpButton.textContent, "末尾へ移動");
  assert.equal(viewModeGroup.getAttribute("aria-label"), "Message display mode");
  assert.equal(previewButton.getAttribute("aria-pressed"), "false");
  assert.equal(sourceButton.getAttribute("aria-pressed"), "true");
  assert.equal(controlRow.firstElementChild, settingsGroup);
  assert.equal(settingsGroup.nextElementSibling, sendButton);
  assert.equal(settingsGroup.contains(sendButton), false);
  assert.equal(sendButton.textContent, "Send");
  assert.equal(sendButton.disabled, true);
});

// @test-value v2
// kind = "contract"
// claim = "SessionComposerExpandedのrunning/idle DOMは実行中だけCancel slotをactiveにし、Main / Auxiliary直前の位置を保ち、Sendは実行中だけdisabledになり、running中はtitle属性を持つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "running/idleでCancel slotのactive・aria・button有無が誤る、target直前位置が崩れる、running中のSend title属性が欠ける、またはisSendDisabled=falseのSendがrunningでenabledかidleでdisabledになる"
// observable = "running/idleでrender済みSessionComposerExpanded DOMのCancel slot class・aria・button有無、target slot位置、composer-control-row直下のSend disabled状態とrunning時のtitle属性"
// observation_boundary = "component-behavior"
// scope = "expanded ActionDock primary action"
// lifecycle = "permanent"
// impact = "SessionComposerExpandedのrunning/idle DOMでCancelの相対位置を揃え、実行中の下段Send枠の消失によるレイアウトシフトを防ぐ"
// distinction = "このtestはSessionComposerExpanded単体のrunning/idle DOMを確認し、typecheck/buildや実画面確認では得られない状態別の構成を補う"
// @end-test-value
test("SessionComposerExpanded は実行中の操作後に jump button と表示切替を右側 group へ描画する", () => {
  const renderComposer = (isRunning: boolean) => renderToStaticMarkup(
    React.createElement(SessionComposerExpanded, {
      isRunning,
      pendingRunIndicatorAnnouncement: "処理を実行中",
      pendingRunIndicatorText: "処理を実行中",
      targetDock: React.createElement("span", { className: "test-target-dock" }, "Main / Auxiliary"),
      composerBlocked: false,
      canSelectCustomAgent: true,
      showCustomAgentPicker: true,
      showSkillPicker: true,
      showMessageViewModeControls: true,
      messageViewMode: "preview",
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
      draft: "実行中の下書き",
      composerTextareaRef: createRef<HTMLTextAreaElement>(),
      isComposerDisabled: false,
      isSendDisabled: false,
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
      onMessageViewModeChange() {},
    }),
  );
  const html = renderComposer(true);

  assert.match(html, /composer-toolbar-progress/);
  assert.match(html, /処理を実行中/);
  assert.match(html, /末尾へ移動/);
  assert.ok(html.indexOf("Attach") < html.indexOf("処理を実行中"));
  assert.ok(html.indexOf("処理を実行中") < html.indexOf("末尾へ移動"));
  assert.ok(html.indexOf("末尾へ移動") < html.indexOf("Preview"));
  assert.match(html, /composer-toolbar-view-actions[\s\S]*末尾へ移動[\s\S]*Message display mode/);

  const renderedDocument = new JSDOM(html).window.document;
  const toolbar = renderedDocument.querySelector(".composer-attachments-toolbar");
  const viewActions = renderedDocument.querySelector(".composer-toolbar-view-actions");
  const cancelSlot = viewActions?.querySelector(":scope > .session-action-dock-cancel-slot");
  const cancelButton = cancelSlot?.querySelector<HTMLButtonElement>(":scope > button.session-send-button.danger");
  const targetSlot = viewActions?.querySelector(":scope > .composer-target-dock-slot");
  const controlRow = renderedDocument.querySelector(".composer-control-row");
  const sendButton = controlRow?.querySelector<HTMLButtonElement>(":scope > button.session-send-button");
  assert.ok(toolbar);
  assert.ok(viewActions);
  assert.ok(cancelSlot);
  assert.ok(cancelButton);
  assert.ok(targetSlot);
  assert.ok(controlRow);
  assert.ok(sendButton);
  assert.equal(viewActions.firstElementChild, cancelSlot);
  assert.equal(cancelSlot.nextElementSibling, targetSlot);
  assert.equal(cancelSlot.classList.contains("is-active"), true);
  assert.equal(cancelSlot.hasAttribute("aria-hidden"), false);
  assert.equal(cancelButton.textContent, "Cancel");
  assert.equal(cancelButton.disabled, false);
  assert.equal(targetSlot.textContent, "Main / Auxiliary");
  assert.equal(sendButton.textContent, "Send");
  assert.equal(sendButton.disabled, true);
  assert.ok(sendButton.getAttribute("title"), "running中のSendはblocked reason titleを持つ");
  assert.equal(sendButton.classList.contains("danger"), false);
  assert.equal(controlRow.querySelectorAll(":scope > button.session-send-button").length, 1);

  const idleHtml = renderComposer(false);
  const idleDocument = new JSDOM(idleHtml).window.document;
  const idleViewActions = idleDocument.querySelector(".composer-toolbar-view-actions");
  const idleCancelSlot = idleViewActions?.querySelector(":scope > .session-action-dock-cancel-slot");
  const idleTargetSlot = idleViewActions?.querySelector(":scope > .composer-target-dock-slot");
  const idleControlRow = idleDocument.querySelector(".composer-control-row");
  const idleSendButton = idleControlRow?.querySelector<HTMLButtonElement>(":scope > button.session-send-button");
  assert.ok(idleViewActions);
  assert.ok(idleCancelSlot);
  assert.ok(idleTargetSlot);
  assert.ok(idleControlRow);
  assert.ok(idleSendButton);
  assert.equal(idleCancelSlot.classList.contains("is-active"), false);
  assert.equal(idleCancelSlot.getAttribute("aria-hidden"), "true");
  assert.equal(idleCancelSlot.querySelector("button"), null);
  assert.equal(idleCancelSlot.nextElementSibling, idleTargetSlot);
  assert.equal(idleSendButton.disabled, false);
});

test("SessionActionDockCompactRow は通常時に preview/source と jump を表示し Send と下書きを表示しない", () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionActionDockCompactRow, {
      attachmentCount: 0,
      isRunning: false,
      showJumpToBottom: true,
      showMessageViewModeControls: true,
      messageViewMode: "preview",
      onExpand() {},
      onJumpToBottom() {},
      onCancel() {},
      onMessageViewModeChange() {},
    }),
  );

  assert.match(html, /末尾へ移動/);
  assert.match(html, />Preview<\/button>/);
  assert.match(html, />Source<\/button>/);
  assert.match(html, /class="session-action-dock-compact-meta session-action-dock-compact-expand-button"/);
  assert.match(html, /aria-label="ActionDock を展開"/);
  assert.doesNotMatch(html, />Send<\/button>/);
  assert.doesNotMatch(html, /Draft|下書きなし/);
});

// @test-value v2
// kind = "contract"
// claim = "compact ActionDockは実行中に展開導線を実際に操作でき、progress・CancelとMain / Auxiliary操作列を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "実行中のcompact ActionDockに展開導線、progress、Cancel、Main / Auxiliary操作列のいずれかが欠ける、展開callbackが呼ばれない、またはCancelがtarget slotの直前にない"
// observable = "SessionActionDockCompactRowの実行中static DOMにおけるprogress、jump button、Cancel、target slot、操作列のDOM順と、展開button clickによるonExpand callback"
// observation_boundary = "component-behavior"
// scope = "compact ActionDock running presentation"
// lifecycle = "permanent"
// impact = "実行中のcompact ActionDockで展開導線とCancelの発見性、Main / Auxiliaryとの操作順を維持し、展開操作を失わせない"
// distinction = "同一React treeのidle/running遷移は別testで確認し、このtestは実行中のstatic DOMと展開buttonの実clickを確認する"
// @end-test-value
test("SessionActionDockCompactRow は実行中の compact 表示から展開でき、jump button と Cancel を描画する", () => {
  const expansionProbe = { calls: 0 },
    compactProps = {
      attachmentCount: 2,
      isRunning: true,
      pendingRunIndicatorAnnouncement: "処理を実行中",
      pendingRunIndicatorText: "処理を実行中",
      targetDock: React.createElement("span", { className: "test-target-dock" }, "Main / Auxiliary"),
      chatNotice: "New messages",
      showJumpToBottom: true,
      cancelButtonTitle: "実行をキャンセル",
      onExpand() {
        expansionProbe.calls += 1;
      },
      onJumpToBottom() {},
      onCancel() {},
    },
    html = renderToStaticMarkup(
      React.createElement(SessionActionDockCompactRow, compactProps),
    );

  assert.match(html, /aria-label="ActionDock を展開"/);
  assert.match(html, /session-action-dock-compact-progress-button/);
  assert.match(html, /session-action-dock-compact-progress/);
  assert.match(html, /処理を実行中/);
  assert.match(html, /New messages/);
  assert.match(html, /session-action-dock-compact-actions/);
  assert.ok(html.indexOf("Cancel") < html.indexOf("末尾へ移動"));
  assert.match(html, />Cancel<\/button>/);
  const renderedDocument = new JSDOM(html).window.document;
  const actions = renderedDocument.querySelector(".session-action-dock-compact-actions");
  const cancelSlot = actions?.querySelector(":scope > .session-action-dock-cancel-slot");
  const targetSlot = actions?.querySelector(":scope > .session-action-dock-target-slot");
  assert.ok(cancelSlot);
  assert.ok(targetSlot);
  assert.equal(actions.firstElementChild, cancelSlot);
  assert.equal(cancelSlot.nextElementSibling, targetSlot);
  assert.equal(targetSlot.textContent, "Main / Auxiliary");

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const mountedDom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: mountedDom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: mountedDom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: mountedDom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: mountedDom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: mountedDom.window.navigator });
  let root: Root | null = null;
  try {
    act(() => {
      root = createRoot(mountedDom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(SessionActionDockCompactRow, compactProps));
    });
    const expandButton = mountedDom.window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="ActionDock を展開"]',
    );
    assert.ok(expandButton);
    act(() => {
      expandButton.click();
    });
    assert.equal(expansionProbe.calls, 1);
  } finally {
    act(() => root?.unmount());
    mountedDom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});

// @test-value v2
// kind = "contract"
// claim = "compact ActionDockはidleとrunningの双方向遷移でもMain / Auxiliary直前のCancel予約slotを同じ位置に保持し、実行中だけCancel buttonをenabledで描画する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "idleまたはrunningでslotが消えるか、双方向の実行状態切替でCancelがMain / Auxiliary直前以外へ移動する、active状態・aria・Cancel buttonのenabled状態が崩れる"
// observable = "React stateをidle/runningへ双方向に更新したSessionActionDockCompactRowのslot親、target内容、class、aria、Cancel button"
// observation_boundary = "component-behavior"
// scope = "compact ActionDock Cancel slot"
// lifecycle = "permanent"
// impact = "compactとexpandedでCancelの相対位置を揃え、target切替とrun状態変更による操作位置の横ずれを双方向に防ぐ"
// distinction = "CSS declaration testは固定幅を確認し、component testはReact state更新後もslotのDOM位置とtarget内容を確認する"
// @end-test-value
test("SessionActionDockCompactRow は実行状態が変わっても Main / Auxiliary 直前の Cancel 予約slotを維持する", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  let root: Root | null = null;
  let setRunning: React.Dispatch<React.SetStateAction<boolean>> | null = null;
  let setTargetLabel: React.Dispatch<React.SetStateAction<string>> | null = null;
  function Harness() {
    const [isRunning, updateRunning] = React.useState(false);
    const [targetLabel, updateTargetLabel] = React.useState("Main / Auxiliary");
    setRunning = updateRunning;
    setTargetLabel = updateTargetLabel;
    return React.createElement(SessionActionDockCompactRow, {
      attachmentCount: 0,
      isRunning,
      targetDock: React.createElement("span", { className: "test-target-dock" }, targetLabel),
      showJumpToBottom: true,
      cancelButtonTitle: "実行をキャンセル",
      onExpand() {},
      onJumpToBottom() {},
      onCancel() {},
    });
  }

  const assertSlot = (slot: Element | null, isRunning: boolean, targetLabel: string) => {
    assert.ok(slot);
    const parent = slot.parentElement;
    assert.ok(parent?.classList.contains("session-action-dock-compact-actions"));
    assert.equal(parent?.firstElementChild, slot);
    assert.equal(slot.nextElementSibling?.classList.contains("session-action-dock-target-slot"), true);
    assert.equal(slot.nextElementSibling?.textContent, targetLabel);
    assert.equal(slot.classList.contains("is-active"), isRunning);
    if (isRunning) {
      const cancelButton = slot.querySelector<HTMLButtonElement>("button");
      assert.equal(slot.hasAttribute("aria-hidden"), false);
      assert.equal(cancelButton?.textContent, "Cancel");
      assert.equal(cancelButton?.disabled, false);
    } else {
      assert.equal(slot.getAttribute("aria-hidden"), "true");
      assert.equal(slot.querySelector("button"), null);
    }
  };

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness));
    });
    const container = dom.window.document.getElementById("root") as HTMLElement;
    const idleSlot = container.querySelector(".session-action-dock-cancel-slot");
    assertSlot(idleSlot, false, "Main / Auxiliary");
    assert.ok(setRunning);
    assert.ok(setTargetLabel);

    await act(async () => {
      setRunning?.(true);
      setTargetLabel?.("Auxiliary");
    });
    const runningSlot = container.querySelector(".session-action-dock-cancel-slot");
    assertSlot(runningSlot, true, "Auxiliary");

    await act(async () => {
      setRunning?.(false);
      setTargetLabel?.("Main / Auxiliary");
    });
    const restoredSlot = container.querySelector(".session-action-dock-cancel-slot");
    assertSlot(restoredSlot, false, "Main / Auxiliary");
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
