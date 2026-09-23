import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  useSessionComposerFeature,
  type SessionComposerFeature,
  type SessionComposerFeatureBridge,
  type SessionComposerFeatureSurface,
} from "../../src/chat/composer/use-session-composer-feature.js";
import { SessionComposerExpanded } from "../../src/chat/composer/session-composer.js";
import { ComposerControllerRegistry, type ComposerOwner } from "../../src/chat/composer-controller.js";
import {
  createHiddenControlsTextChatComposerProps,
  createIdleChatMessageColumnProps,
  createStaticChatHeaderProps,
  createStaticChatCharacterProfile,
  createStaticTextChatCompactActionDockProps,
} from "../../src/chat/chat-window-adapter.js";
import { ChatWindow } from "../../src/chat/chat-window.js";
import { buildSessionChatRuntimeFeature } from "../../src/chat/runtime/session-chat-runtime-feature.js";
import { useSessionContextPaneFeature } from "../../src/chat/runtime/use-session-context-pane-feature.js";
import { composeAgentSessionChatWindow } from "../../src/chat/session-chat-window-composition.js";
import {
  useSessionChatConversationFeature,
  type SessionChatConversationFeature,
  type SessionChatConversationFeatureInput,
} from "../../src/chat/conversation/session-chat-conversation-feature.js";
import {
  useSessionHeaderOperations,
  type SessionHeaderOperations,
} from "../../src/chat/shell/use-session-header-operations.js";
import type { AuxiliaryDraftPersistence } from "../../src/chat/auxiliary/use-auxiliary-draft-persistence.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { DiscoveredSkill } from "../../src-shared/session/runtime-state.js";
import type { SessionContextPaneProps } from "../../src/chat/shell/session-context-pane.js";
import type { SessionChatShellFeature } from "../../src/chat/shell/session-chat-shell-feature.js";
import type { Session } from "../../src-shared/session/session-state.js";

const noop = () => {};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createSession(): Session {
  return { taskTitle: "Main session" } as Session;
}

// @test-value v2
// kind = "contract"
// claim = "session runtime featureはcomposerのblocked feedbackとworkspace/path noticeを共通error surfaceへ投影する"
// oracle = { type = "contract", ref = "docs/features/session-interface-refinements.md#blocked状態と送信エラー; docs/manual-test-checklist.md: MT-023D11; docs/design/desktop-ui.md: sendability" }
// fault = "workspaceまたはpathの失敗がerror surfaceから欠落する、またはcomposerのblocked feedbackが表示されない"
// observable = "buildSessionChatRuntimeFeatureのerrorNoticesに含まれるnoticeの内容とcallback identity"
// observation_boundary = "public-boundary"
// scope = "session-chat-runtime-error-notices"
// lifecycle = "permanent"
// impact = "送信失敗やworkspace/path復旧操作を利用者が確認できず、再試行できない"
// distinction = "旧projection builderの巨大props配線ではなく、現runtime ownerの公開error surfaceを直接確認する"
// @end-test-value
test("session runtime feature は blocked feedback と workspace/path notice を共通error surfaceへ投影する", () => {
  const onRecheckWorkspaceAvailability = () => {};
  const onDismissInlinePathFeedback = () => {};
  const feature = buildSessionChatRuntimeFeature({
    recovery: {
      retryBanner: null,
      isRetryActionDisabled: false,
      isRetryEditDisabled: false,
      isRetryDraftReplacePending: false,
      onResendLastMessage: noop,
      onEditLastMessage: noop,
      onConfirmRetryDraftReplace: noop,
      onCancelRetryDraftReplace: noop,
    },
    composerFeedback: {
      primaryFeedback: "Path not found: C:/missing",
      secondaryFeedback: ["C:/missing"],
      feedbackTone: "blocked",
      shouldShowFeedback: true,
    },
    workspaceAvailabilityMessage: "Workspace not found: C:/workspace.",
    isWorkspaceAvailabilityCheckPending: false,
    onRecheckWorkspaceAvailability,
    inlinePathFeedback: "The local path was not found.",
    onDismissInlinePathFeedback,
    // The context-pane feature owns this projection; this test isolates runtime notices.
    contextPane: {} as SessionContextPaneProps,
  });

  assert.deepEqual(feature.errorNotices, [
    {
      id: "composer-sendability",
      message: "Path not found: C:/missing",
      details: ["C:/missing"],
      relatedControl: "composer",
    },
    {
      id: "workspace-unavailable",
      message: "Workspace not found: C:/workspace.",
      relatedControl: "composer",
      actionLabel: "Recheck",
      isActionDisabled: false,
      onAction: onRecheckWorkspaceAvailability,
    },
    {
      id: "inline-path-open",
      message: "The local path was not found.",
      dismissLabel: "Dismiss path result",
      onDismiss: onDismissInlinePathFeedback,
    },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "session header ownerはauxiliary modeでparent sessionのrename/deleteを隠し、audit logとsession action callbackを維持する"
// oracle = { type = "characterization", ref = "99a1a9b09b23b54553790edeb63f390125d21ecb:src/chat/chat-header-visibility.ts resolveChatHeaderVisibility; docs/manual-test-checklist.md: MT-023D1, MT-023D2" }
// fault = "auxiliary conversationで親sessionの操作が誤表示される、またはworkspace/session action callbackが別操作へ接続される"
// observable = "useSessionHeaderOperationsが返すheader propsのvisibility flags、audit/terminal/pin callback identity、描画したworkspace/session-file操作の呼出先"
// observation_boundary = "public-boundary"
// scope = "session-chat-header-auxiliary-actions"
// lifecycle = "permanent"
// impact = "補助会話から親sessionを誤って変更・削除する危険と、workspace/session操作不能が発生する"
// distinction = "共通header componentの描画testとは分け、現在のheader hook ownerが受け取ったsession stateをaction surfaceへ投影する境界をReact hook harnessで確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("session header owner は auxiliary の parent 操作を隠し action callback を維持する", async () => {
  const actionCalls: string[] = [];
  const onOpenSessionExplorer = () => { actionCalls.push("workspace-explorer"); };
  const onOpenSessionFilesExplorer = () => { actionCalls.push("session-files-explorer"); };
  const onOpenSessionFilesTerminal = () => { actionCalls.push("session-files-terminal"); };
  const onOpenAuditLog = () => {};
  const onOpenSessionTerminal = () => {};
  const onToggleSessionPin = () => {};
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    PointerEvent: globalThis.PointerEvent,
  };
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  let root: Root | null = null;
  let operations: SessionHeaderOperations | null = null;

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    MouseEvent: { configurable: true, value: dom.window.MouseEvent },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
  });

  function Harness() {
    operations = useSessionHeaderOperations({
      api: null,
      selectedSession: createSession(),
      isReadOnly: false,
      runState: "idle",
      persistSession: async (session) => session,
      closeWindow: noop,
    });
    return null;
  }

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness));
    });
    const currentOperations = operations as SessionHeaderOperations | null;
    assert.ok(currentOperations);
    const feature = currentOperations.buildChatHeader({
      isRunning: false,
      isReadOnly: false,
      isPinned: true,
      isPinPending: false,
      isAuxiliaryMode: true,
      isWorkspaceAvailable: true,
      onOpenAuditLog,
      onOpenSessionTerminal,
      onOpenSessionFilesExplorer,
      onOpenSessionFilesTerminal,
      onTitleInputKeyDown: noop,
      onDeleteSession: noop,
      onToggleSessionPin,
      onOpenSessionExplorer,
    });

    assert.equal(feature.showRenameButton, false);
    assert.equal(feature.showAuditLogButton, true);
    assert.equal(feature.showDeleteButton, false);
    assert.equal(feature.isPinned, true);
    assert.equal(feature.onTogglePin, onToggleSessionPin);
    assert.equal(feature.onOpenAuditLog, onOpenAuditLog);
    assert.equal(feature.onOpenTerminal, onOpenSessionTerminal);
    await act(async () => root?.render(React.createElement(React.Fragment, null,
      React.createElement("section", { "aria-label": "Workspace actions" }, feature.workspaceActions),
      feature.sessionFilesActions)));
    const workspaceButton = dom.window.document.querySelector<HTMLButtonElement>('section[aria-label="Workspace actions"] button');
    assert.ok(workspaceButton);
    await act(async () => workspaceButton.click());
    for (const title of ["Open session files directory", "Open terminal in session files directory"]) {
      const button = dom.window.document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
      assert.ok(button, title);
      await act(async () => button.click());
    }
    assert.deepEqual(actionCalls, ["workspace-explorer", "session-files-explorer", "session-files-terminal"]);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previousGlobals.window },
      document: { configurable: true, value: previousGlobals.document },
      Node: { configurable: true, value: previousGlobals.Node },
      HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
      Event: { configurable: true, value: previousGlobals.Event },
      MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
      KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
      PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
    });
  }
});

type SessionComposerInput = Parameters<typeof useSessionComposerFeature>[0];

type ComposerOperationLog = {
  mainDrafts: Array<{ value: string; selectionStart: number }>;
  auxiliaryDrafts: Array<{ value: string; selectionStart: number }>;
  mainSkills: DiscoveredSkill[];
  auxiliarySkills: DiscoveredSkill[];
  mainSpeedChanges: Array<Session["codexSpeed"]>;
  auxiliarySpeedChanges: Array<Session["codexSpeed"]>;
  mainSends: number;
  auxiliarySends: number;
};

const testSkill: DiscoveredSkill = {
  id: "skill-review",
  name: "Review changes",
  description: "Review the current changes",
  source: "workspace",
  sourcePath: "C:/workspace/.agents/skills/review/SKILL.md",
  sourceLabel: "workspace",
};

function createComposerSession(
  provider = "copilot",
  codexSpeed: Session["codexSpeed"] = "fast",
): Session {
  return {
    taskTitle: "Main session",
    provider,
    customAgentName: "",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed,
    codexReviewer: "user",
    model: "gpt-test",
    reasoningEffort: "medium",
    allowedAdditionalDirectories: [],
  } as unknown as Session;
}

function createDraftPersistenceStub(): AuxiliaryDraftPersistence {
  return {
    getOwner: () => null,
    observeSave: async () => {},
    changeDraft: async () => {},
    retrySave: () => {},
    trackSend: <T>(operation: Promise<T>) => operation,
    waitForPendingSends: async () => {},
    flushAll: async () => {},
    pendingSessionIds: () => [],
  };
}

function createComposerBridge(
  log: ComposerOperationLog,
  target: "main" | "auxiliary",
  isCharacterAuthoringSession = false,
  options: {
    provider?: string;
    codexSpeed?: Session["codexSpeed"];
    isRunning?: boolean;
    selectedRunState?: Session["runState"] | null;
    auxiliaryRunState?: Session["runState"] | null;
    auxiliarySession?: AuxiliarySession | null;
  } = {},
): SessionComposerFeatureBridge {
  return {
    session: createComposerSession(options.provider, options.codexSpeed),
    isCharacterAuthoringSession,
    target,
    runtime: {
      isRunning: options.isRunning ?? false,
      selectedRunState: options.selectedRunState ?? "idle",
      auxiliaryRunState: options.auxiliaryRunState ?? "idle",
      busyReason: "",
      blockedReason: "",
      isReadOnly: false,
      forceBlockedFeedback: false,
      isMessageListFollowing: true,
      isPromptTemplateWorkspaceOpen: false,
      chatNotice: undefined,
      providerCatalog: null,
      models: [],
      reasoningEfforts: [],
    },
    resources: {
      availableCustomAgents: [],
      availableSkills: [testSkill],
      isCustomAgentListLoading: false,
      isSkillListLoading: false,
      skillListError: null,
    },
    operations: {
      send: {
        main: () => { log.mainSends += 1; },
        auxiliary: () => { log.auxiliarySends += 1; },
        cancelMain: noop,
        cancelAuxiliary: noop,
      },
      runtimeOptions: {
        runMain: (option) => {
          if (option.kind === "codex-speed") {
            log.mainSpeedChanges.push(option.value);
          }
        },
        auxiliary: {
          session: options.auxiliarySession ?? null,
          update: async (recipe) => {
            if (options.auxiliarySession) {
              log.auxiliarySpeedChanges.push(recipe(options.auxiliarySession).codexSpeed);
            }
          },
          catalogRevision: null,
          timestamp: () => "2026-09-22T00:00:00.000Z",
        },
      },
      customAgent: {
        main: noop,
        auxiliary: noop,
      },
      skill: {
        main: (skill) => { log.mainSkills.push(skill); },
        auxiliary: (skill) => { log.auxiliarySkills.push(skill); },
      },
      draft: {
        main: (value, selectionStart) => { log.mainDrafts.push({ value, selectionStart }); },
        auxiliary: (value, selectionStart) => { log.auxiliaryDrafts.push({ value, selectionStart }); },
        focus: noop,
      },
      files: {
        pick: noop,
      },
      layout: {
        beforeOpenSkillPicker: () => true,
        addAdditionalDirectory: {
          main: noop,
          auxiliary: noop,
        },
        removeAdditionalDirectory: {
          main: noop,
          auxiliary: noop,
        },
        expandActionDock: noop,
        jumpToBottom: noop,
      },
    },
  };
}

async function withReactDom<T>(callback: (root: Root) => Promise<T>): Promise<T> {
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    PointerEvent: globalThis.PointerEvent,
  };
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    MouseEvent: { configurable: true, value: dom.window.MouseEvent },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
  });

  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  try {
    return await callback(root);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previousGlobals.window },
      document: { configurable: true, value: previousGlobals.document },
      Node: { configurable: true, value: previousGlobals.Node },
      HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
      Event: { configurable: true, value: previousGlobals.Event },
      MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
      KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
      PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
    });
  }
}

async function renderComposerHarness(
  root: Root,
  input: SessionComposerInput,
): Promise<{ getFeature: () => SessionComposerFeature | null }> {
  let feature: SessionComposerFeature | null = null;
  function Harness() {
    feature = useSessionComposerFeature(input);
    return null;
  }
  await act(async () => {
    root.render(React.createElement(Harness));
  });
  return { getFeature: () => feature };
}

function createComposerInput(
  composerRegistry: ComposerControllerRegistry,
  composerOwner: ComposerOwner,
): SessionComposerInput {
  return {
    api: null,
    composerRegistry,
    composerOwner,
    composerDraft: "",
    activeRunSessionId: "main-session",
    selectedSessionId: "main-session",
    sessionProvider: "copilot",
    sessionWorkspacePath: "C:/workspace",
    visibleRunState: "idle",
    auxiliaryDraftPersistence: createDraftPersistenceStub(),
    setForceComposerBlockedFeedback: noop,
  };
}

function createAuxiliaryRuntimeSession(): AuxiliarySession {
  return {
    id: "auxiliary-session",
    parentSessionId: "main-session",
    status: "active",
    runState: "idle",
    title: "Auxiliary session",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-test",
    reasoningEffort: "medium",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-auxiliary",
    composerDraft: "",
    messages: [],
    displayAfterMessageIndex: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    closedAt: "",
  };
}

// @test-value v2
// kind = "contract"
// claim = "context pane ownerのLatest Command projectionはruntime/compositionを経由して共通ChatWindowへ到達する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md:287" }
// fault = "useSessionContextPaneFeatureのcommand表示がruntimeまたはcompositionで欠落し、ChatWindowのright paneに最新commandが表示されない"
// observable = "useSessionContextPaneFeatureから組み立てたChatWindowのright pane HTMLに含まれるtabとcommand summary"
// observation_boundary = "component-behavior"
// scope = "session-context-pane-owner-to-chat-window"
// lifecycle = "permanent"
// impact = "実行中のcommand安全確認面が空表示になり、利用者が実行対象を確認できない"
// distinction = "下位projectionの値だけでなく、実hook・runtime feature・composition・ChatWindowの公開表示面を一度に通る"
// @end-test-value
test("context pane owner は runtime/composition 経由で ChatWindow の Latest Command へ到達する", async () => {
  await withReactDom(async (root) => {
    let contextFeature: ReturnType<typeof useSessionContextPaneFeature> | null = null;
    const getContextFeature = () => {
      assert.ok(contextFeature);
      return contextFeature;
    };
    const contextInput: Parameters<typeof useSessionContextPaneFeature>[0] = {
      selectedSession: {
        id: "session-1",
        updatedAt: "2026-09-22T00:00:00.000Z",
        provider: "codex",
        reasoningEffort: "medium",
      },
      displayedSession: {
        id: "session-1",
        updatedAt: "2026-09-22T00:00:00.000Z",
        provider: "codex",
        reasoningEffort: "medium",
      },
      activeRunSessionId: "session-1",
      liveRun: {
        sessionId: "session-1",
        threadId: "thread-1",
        assistantText: "",
        reasoningText: "",
        steps: [{
          id: "command-1",
          type: "command_execution",
          summary: "Get-ChildItem C:/workspace",
          status: "completed",
        }],
        backgroundTasks: [],
        usage: null,
        errorMessage: "",
        approvalRequest: null,
        elicitationRequest: null,
      },
      auditLogEntries: [],
      selectedSessionContextTelemetry: null,
      selectedProviderQuotaTelemetry: null,
      availableReasoningEfforts: ["medium"],
      renderedIsRunning: true,
      glossaryPaneProps: undefined,
      onShowContextRail: noop,
    };

    function ContextHarness() {
      contextFeature = useSessionContextPaneFeature(contextInput);
      return null;
    }

    await act(async () => root.render(React.createElement(ContextHarness)));

    const runtime = buildSessionChatRuntimeFeature({
      recovery: {
        retryBanner: null,
        isRetryActionDisabled: false,
        isRetryEditDisabled: false,
        isRetryDraftReplacePending: false,
        onResendLastMessage: noop,
        onEditLastMessage: noop,
        onConfirmRetryDraftReplace: noop,
        onCancelRetryDraftReplace: noop,
      },
      composerFeedback: {
        primaryFeedback: "",
        secondaryFeedback: [],
        feedbackTone: null,
        shouldShowFeedback: false,
      },
      workspaceAvailabilityMessage: "",
      isWorkspaceAvailabilityCheckPending: false,
      onRecheckWorkspaceAvailability: noop,
      inlinePathFeedback: "",
      onDismissInlinePathFeedback: noop,
      contextPane: getContextFeature().rightPaneProps,
    });
    const shell: SessionChatShellFeature = {
      mode: "agent",
      isHeaderExpanded: true,
      workbenchRef: React.createRef<HTMLDivElement>(),
      isActionDockExpanded: true,
      splitterProps: {
        isActive: false,
        isPanelExpanded: true,
        onPointerDown: noop,
        onTogglePanel: noop,
      },
      isRightPaneVisible: true,
      modals: null,
    };
    const composerProps = createHiddenControlsTextChatComposerProps({
      draft: "",
      isRunning: true,
      feedback: "",
      composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
      modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
      selectedModel: "gpt-test",
      selectedModelFallbackLabel: "GPT Test",
      reasoningOptions: [{ value: "medium", label: "medium" }],
      selectedReasoningEffort: "medium",
      onDraftChange: noop,
      onDraftKeyDown: noop,
      onSendOrCancel: noop,
      onChangeModel: noop,
      onChangeReasoningEffort: noop,
    });
    const composer: SessionComposerFeatureSurface = {
      composer: composerProps,
      compactActionDock: createStaticTextChatCompactActionDockProps({}),
      additionalDirectoryListProps: {
        isOpen: false,
        items: [],
        isInteractionDisabled: true,
        onRemove: noop,
      },
      skillPickerProps: {
        isOpen: false,
        isInteractionDisabled: true,
        isLoading: false,
        errorMessage: null,
        items: [],
        onSelectSkill: noop,
        onDismiss: noop,
      },
      skillItems: [],
      onSelectSkill: noop,
      onToggleSkillPicker: noop,
      isSkillPickerOpen: false,
      isSkillListLoading: false,
      skillListError: null,
      additionalDirectoryItems: [],
      isAdditionalDirectoryListOpen: false,
      onRemoveAdditionalDirectory: noop,
      isComposerFrozen: false,
    };
    const composed = composeAgentSessionChatWindow({
      shell,
      header: createStaticChatHeaderProps({ taskTitle: "Main session", isRunning: true }),
      composer,
      conversation: createIdleChatMessageColumnProps({
        sessionId: "session-1",
        character: createStaticChatCharacterProfile({ id: "character-1", name: "Character" }),
        messages: [],
        messageListRef: React.createRef<HTMLDivElement>(),
        isRunning: true,
      }),
      runtime,
    });

    const html = renderToStaticMarkup(React.createElement(ChatWindow, composed));
    assert.match(html, /session-context-pane/);
    assert.match(html, /LatestCommand/);
    assert.match(html, /Get-ChildItem C:\/workspace/);
  });
});

// @test-value v2
// kind = "contract"
// claim = "composer ownerはCodex Speedのselected valueを保持し、main/auxiliaryの操作routeを分け、running中はSpeedを変更不可にする"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md:342" }
// fault = "Speedのselected valueが表示面へ渡らない、対象会話と異なるruntime optionへ書き込む、またはrunning中に変更できる"
// observable = "composer surfaceのSpeed options/value、main/auxiliary operation log、running surfaceのSpeed select disabled state"
// observation_boundary = "component-behavior"
// scope = "session-composer-speed-owner-route"
// lifecycle = "permanent"
// impact = "実行対象とは異なる会話のruntime設定を変更する、または実行中のprovider optionを変更してrun条件を混線させる"
// distinction = "runtime option helper単体ではなく、useSessionComposerFeatureのowner surfaceから実composer controlまで確認する"
// @end-test-value
test("session composer feature は Speed の値・route・running guard を維持する", async () => {
  await withReactDom(async (root) => {
    const composerRegistry = new ComposerControllerRegistry();
    const composerOwner: ComposerOwner = { kind: "main", id: "main-session" };
    const harness = await renderComposerHarness(root, createComposerInput(composerRegistry, composerOwner));
    const feature = harness.getFeature();
    assert.ok(feature);
    const log: ComposerOperationLog = {
      mainDrafts: [],
      auxiliaryDrafts: [],
      mainSkills: [],
      auxiliarySkills: [],
      mainSpeedChanges: [],
      auxiliarySpeedChanges: [],
      mainSends: 0,
      auxiliarySends: 0,
    };
    const mainSurface = feature.buildSurface(createComposerBridge(log, "main", false, { provider: "codex" }));
    assert.equal(mainSurface.composer.selectedCodexSpeed, "fast");
    assert.deepEqual(mainSurface.composer.speedOptions, [
      { value: "standard", label: "Standard" },
      { value: "fast", label: "Fast" },
    ]);
    mainSurface.composer.onChangeCodexSpeed("standard");
    assert.deepEqual(log.mainSpeedChanges, ["standard"]);
    assert.deepEqual(log.auxiliarySpeedChanges, []);

    const auxiliarySurface = feature.buildSurface(createComposerBridge(log, "auxiliary", false, {
      provider: "codex",
      codexSpeed: "standard",
      auxiliarySession: createAuxiliaryRuntimeSession(),
    }));
    assert.equal(auxiliarySurface.composer.selectedCodexSpeed, "standard");
    auxiliarySurface.composer.onChangeCodexSpeed("fast");
    await act(async () => await Promise.resolve());
    assert.deepEqual(log.auxiliarySpeedChanges, ["fast"]);
    assert.deepEqual(log.mainSpeedChanges, ["standard"]);

    const runningSurface = feature.buildSurface(createComposerBridge(log, "main", false, {
      provider: "codex",
      isRunning: true,
      selectedRunState: "running",
    }));
    const runningHtml = renderToStaticMarkup(React.createElement(SessionComposerExpanded, runningSurface.composer));
    const runningDom = new JSDOM(runningHtml);
    const speedSelect = runningDom.window.document.querySelector('select[aria-label="Speed"]') as HTMLSelectElement | null;
    assert.ok(speedSelect);
    assert.equal(speedSelect.value, "fast");
    assert.equal(speedSelect.disabled, true);
    runningDom.window.close();
  });
});

// @test-value v2
// kind = "contract"
// claim = "composer featureは同じ表示surfaceからmainとauxiliaryのdraft、skill、send操作を対象会話へrouteする"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md:73" }
// fault = "auxiliaryの入力やskillがmainへ書き込まれる、またはmainの送信がauxiliaryへ流れる"
// observable = "useSessionComposerFeatureのbuildSurfaceから得たcomposer callbackのoperation log"
// observation_boundary = "public-boundary"
// scope = "session-composer-target-routing"
// lifecycle = "permanent"
// impact = "会話をまたいだdraft・skill・送信の混線により、ユーザーの入力または実行対象が失われる"
// distinction = "helperのprops shapeではなく、現composer ownerのhook surfaceがtarget別operationへ到達する挙動を確認する"
// @end-test-value
test("session composer feature は main と auxiliary の operation を target へ route する", async () => {
  await withReactDom(async (root) => {
    const composerRegistry = new ComposerControllerRegistry();
    const composerOwner: ComposerOwner = { kind: "main", id: "main-session" };
    const harness = await renderComposerHarness(root, createComposerInput(composerRegistry, composerOwner));
    const feature = harness.getFeature();
    assert.ok(feature);
    const log: ComposerOperationLog = {
      mainDrafts: [],
      auxiliaryDrafts: [],
      mainSkills: [],
      auxiliarySkills: [],
      mainSpeedChanges: [],
      auxiliarySpeedChanges: [],
      mainSends: 0,
      auxiliarySends: 0,
    };

    const mainSurface = feature.buildSurface(createComposerBridge(log, "main"));
    const auxiliarySurface = feature.buildSurface(createComposerBridge(log, "auxiliary"));
    await act(async () => {
      mainSurface.composer.onDraftChange("main draft", 5);
      mainSurface.onSelectSkill(testSkill.id);
      mainSurface.composer.onSendOrCancel();
      auxiliarySurface.composer.onDraftChange("auxiliary draft", 9);
      auxiliarySurface.onSelectSkill(testSkill.id);
      auxiliarySurface.composer.onSendOrCancel();
    });

    assert.deepEqual(log.mainDrafts, [{ value: "main draft", selectionStart: 5 }]);
    assert.deepEqual(log.auxiliaryDrafts, [{ value: "auxiliary draft", selectionStart: 9 }]);
    assert.deepEqual(log.mainSkills, [testSkill]);
    assert.deepEqual(log.auxiliarySkills, [testSkill]);
    assert.equal(log.mainSends, 1);
    assert.equal(log.auxiliarySends, 1);
  });
});

// @test-value v2
// kind = "contract"
// claim = "composer featureは終了凍結中のskill挿入を拒否し、character-authoring sessionではuser-selectable skill/agent capabilityを公開しない"
// oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md:104" }
// fault = "quit flushの凍結中にskillがdraftへ挿入される、またはauthoring sessionから任意skill/agentを選択できる"
// observable = "frozen registryのskill operation logとauthoring composer surfaceのpicker capability"
// observation_boundary = "public-boundary"
// scope = "session-composer-freeze-authoring-capability"
// lifecycle = "permanent"
// impact = "終了処理中の入力復活やauthoring policy外のskill/agent選択により、保存内容または固定authoring workflowが壊れる"
// distinction = "controller単体のfreeze testではなく、実際のcomposer feature surfaceが挿入callbackを遮断しcapabilityを絞る境界を確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("session composer feature は凍結中のskill挿入を拒否し authoring capability を絞る", async () => {
  await withReactDom(async (root) => {
    const composerRegistry = new ComposerControllerRegistry();
    const composerOwner: ComposerOwner = { kind: "main", id: "main-session" };
    const composerInput = createComposerInput(composerRegistry, composerOwner);
    const harness = await renderComposerHarness(root, composerInput);
    const feature = harness.getFeature();
    assert.ok(feature);
    const log: ComposerOperationLog = {
      mainDrafts: [],
      auxiliaryDrafts: [],
      mainSkills: [],
      auxiliarySkills: [],
      mainSpeedChanges: [],
      auxiliarySpeedChanges: [],
      mainSends: 0,
      auxiliarySends: 0,
    };

    const idleBridge = createComposerBridge(log, "main");
    const idleSurface = feature.buildSurface(idleBridge);
    await act(async () => idleSurface.onToggleSkillPicker());
    const openedFeature = harness.getFeature();
    assert.ok(openedFeature);
    const openedSurface = openedFeature.buildSurface(idleBridge);
    assert.equal(openedSurface.isSkillPickerOpen, true);

    composerRegistry.freeze();
    const frozenSurface = openedFeature.buildSurface(idleBridge);
    frozenSurface.onSelectSkill(testSkill.id);
    assert.deepEqual(log.mainSkills, []);

    composerRegistry.unfreeze();
    const authoringSurface = openedFeature.buildSurface(createComposerBridge(log, "main", true));
    assert.equal(authoringSurface.composer.showCustomAgentPicker, false);
    assert.equal(authoringSurface.composer.showSkillPicker, false);
    assert.equal(authoringSurface.composer.canSelectCustomAgent, false);
    assert.equal(authoringSurface.skillPickerProps.isOpen, false);
  });
});

// @test-value v2
// kind = "contract"
// claim = "conversation featureのartifact開閉操作は対象message keyだけを変更し、会話を切り替えても展開状態を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#ui-implementation-boundary" }
// fault = "開閉callbackがfeatureの状態へ接続されない、別messageの状態も変わる、または会話切替で展開状態が失われる"
// observable = "同一hookの再renderと会話切替後に返るmessageColumn surfaceのexpandedArtifacts"
// observation_boundary = "component-behavior"
// scope = "session-conversation-artifact-expansion"
// lifecycle = "permanent"
// impact = "Detailsを開閉できなくなる、または別会話へ移動して戻るたびに閲覧状態が失われる"
// distinction = "toggle helper単体や固定propsの描画では検出できない、featureのReact stateと実callback・投影の接続を確認する"
// @end-test-value
test("session conversation feature はartifact開閉状態をmessage keyごとに保持する", async () => {
  await withReactDom(async (root) => {
    let surface: SessionChatConversationFeature | null = null;
    const getSurface = () => {
      assert.ok(surface);
      return surface;
    };
    const input: SessionChatConversationFeatureInput = {
      sessionId: "main",
      character: {
        id: "character",
        name: "Mate",
        iconPath: "",
        description: "",
        roleMarkdown: "",
        notesMarkdown: "",
        updatedAt: "",
        themeColors: {},
      } as SessionChatConversationFeatureInput["character"],
      messages: [],
      messageListRef: { current: null },
      isRunning: false,
      liveApprovalRequest: null,
      approvalActionRequestId: null,
      liveElicitationRequest: null,
      elicitationActionRequestId: null,
      liveRunAssistantText: "",
      liveRunErrorMessage: "",
      isMessageListFollowing: true,
      onMessageListScroll: noop,
      onLoadArtifactDetail: async () => null,
      onOpenDiff: noop,
      onResolveLiveApproval: noop,
      onResolveLiveElicitation: noop,
      onOpenPath: noop,
    };
    function Harness({ sessionId }: { sessionId: string }) {
      const feature = useSessionChatConversationFeature();
      surface = feature.buildSurface({ ...input, sessionId });
      return null;
    }

    await act(async () => root.render(React.createElement(Harness, { sessionId: "main" })));
    assert.deepEqual(getSurface().expandedArtifacts, {});
    await act(async () => getSurface().onToggleArtifact("main-0"));
    assert.deepEqual(getSurface().expandedArtifacts, { "main-0": true });

    await act(async () => root.render(React.createElement(Harness, { sessionId: "auxiliary" })));
    assert.equal(getSurface().sessionId, "auxiliary");
    await act(async () => getSurface().onToggleArtifact("auxiliary-0"));
    assert.deepEqual(getSurface().expandedArtifacts, { "main-0": true, "auxiliary-0": true });

    await act(async () => root.render(React.createElement(Harness, { sessionId: "main" })));
    assert.equal(getSurface().sessionId, "main");
    assert.deepEqual(getSurface().expandedArtifacts, { "main-0": true, "auxiliary-0": true });
    await act(async () => getSurface().onToggleArtifact("main-0"));
    assert.deepEqual(getSurface().expandedArtifacts, { "main-0": false, "auxiliary-0": true });
  });
});
