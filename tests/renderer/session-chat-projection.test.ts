import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useSessionComposerFeature,
  type SessionComposerFeature,
  type SessionComposerFeatureBridge,
} from "../../src/chat/composer/use-session-composer-feature.js";
import { ComposerControllerRegistry, type ComposerOwner } from "../../src/chat/composer-controller.js";
import { buildSessionChatRuntimeFeature } from "../../src/chat/runtime/session-chat-runtime-feature.js";
import {
  useSessionHeaderOperations,
  type SessionHeaderOperations,
} from "../../src/chat/shell/use-session-header-operations.js";
import type { AuxiliaryDraftPersistence } from "../../src/chat/auxiliary/use-auxiliary-draft-persistence.js";
import type { DiscoveredSkill } from "../../src-shared/session/runtime-state.js";
import type { SessionContextPaneProps } from "../../src/chat/shell/session-context-pane.js";
import type { Session } from "../../src-shared/session/session-state.js";

const noop = () => {};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createSession(): Session {
  return { taskTitle: "Main session" } as Session;
}

// @test-value v2
// kind = "contract"
// claim = "session runtime featureはcomposerのblocked feedbackとworkspace/path noticeを共通error surfaceへ投影する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md:348" }
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
      dismissLabel: "パスを開いた結果を閉じる",
      onDismiss: onDismissInlinePathFeedback,
    },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "session header ownerはauxiliary modeでparent sessionのrename/deleteを隠し、audit logとsession action callbackを維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md:229" }
// fault = "auxiliary conversationで親sessionの操作が誤表示される、またはworkspace/session action callbackが別操作へ接続される"
// observable = "useSessionHeaderOperationsが返すheader propsのvisibility flagsとaction callback identity"
// observation_boundary = "public-boundary"
// scope = "session-chat-header-auxiliary-actions"
// lifecycle = "permanent"
// impact = "補助会話から親sessionを誤って変更・削除する危険と、workspace/session操作不能が発生する"
// distinction = "共通header componentの描画testとは分け、現在のheader hook ownerが受け取ったsession stateをaction surfaceへ投影する境界をReact hook harnessで確認する"
// risk_tags = ["authorization"]
// @end-test-value
test("session header owner は auxiliary の parent 操作を隠し action callback を維持する", async () => {
  const onOpenSessionExplorer = () => {};
  const onOpenSessionFilesExplorer = () => {};
  const onOpenSessionFilesTerminal = () => {};
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
      onOpenAuditLog: noop,
      onOpenSessionTerminal: noop,
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
    const workspaceActions = feature.workspaceActions as React.ReactElement<{ onClick: () => void }>;
    assert.equal(workspaceActions.props.onClick, onOpenSessionExplorer);
    const sessionFileActions = React.Children.toArray(
      (feature.sessionFilesActions as React.ReactElement<{ children: React.ReactNode }>).props.children,
    ) as Array<React.ReactElement<{ onClick: () => void }>>;
    assert.equal(sessionFileActions[0]?.props.onClick, onOpenSessionFilesExplorer);
    assert.equal(sessionFileActions[1]?.props.onClick, onOpenSessionFilesTerminal);
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

function createComposerSession(): Session {
  return {
    taskTitle: "Main session",
    provider: "copilot",
    customAgentName: "",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "fast",
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
): SessionComposerFeatureBridge {
  return {
    session: createComposerSession(),
    isCharacterAuthoringSession,
    target,
    runtime: {
      isRunning: false,
      selectedRunState: "idle",
      auxiliaryRunState: "idle",
      busyReason: "",
      blockedReason: "",
      isReadOnly: false,
      forceBlockedFeedback: false,
      pendingRunIndicatorAnnouncement: undefined,
      pendingRunIndicatorText: undefined,
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
        runMain: noop,
        auxiliary: {
          session: null,
          update: async () => {},
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
        removeAttachment: noop,
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
    const harness = await renderComposerHarness(root, createComposerInput(composerRegistry, composerOwner));
    const feature = harness.getFeature();
    assert.ok(feature);
    const log: ComposerOperationLog = {
      mainDrafts: [],
      auxiliaryDrafts: [],
      mainSkills: [],
      auxiliarySkills: [],
      mainSends: 0,
      auxiliarySends: 0,
    };

    composerRegistry.freeze();
    const frozenSurface = feature.buildSurface(createComposerBridge(log, "main"));
    frozenSurface.onSelectSkill(testSkill.id);
    assert.deepEqual(log.mainSkills, []);
    assert.equal(frozenSurface.isSkillPickerOpen, false);

    composerRegistry.unfreeze();
    const authoringSurface = feature.buildSurface(createComposerBridge(log, "main", true));
    assert.equal(authoringSurface.composer.showCustomAgentPicker, false);
    assert.equal(authoringSurface.composer.showSkillPicker, false);
    assert.equal(authoringSurface.composer.canSelectCustomAgent, false);
    assert.equal(authoringSurface.skillPickerProps.isOpen, false);
  });
});
