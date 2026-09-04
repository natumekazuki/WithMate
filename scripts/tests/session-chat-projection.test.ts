import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildAgentSessionChatWindowProps,
  type AgentSessionChatProjectionInput,
} from "../../src/chat/session-chat-projection.js";
import type { CharacterProfile } from "../../src/app-state.js";
import { SessionComposerExpanded, type SessionContextPaneProps } from "../../src/session-components.js";
import type { Session } from "../../src/session-state.js";
import { createGlossaryAnnotationMatcher } from "../../src/glossary/glossary-annotation-projection.js";

const noop = () => {};

function createCharacterProfile(): CharacterProfile {
  return {
    id: "char-1",
    name: "Test Character",
    iconPath: "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    updatedAt: "2026-05-24T00:00:00.000Z",
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

function createSession(): Session {
  return {
    id: "session-1",
    taskTitle: "Main session",
    status: "idle",
    updatedAt: "2026-05-24T00:00:00.000Z",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "WithMate",
    workspacePath: "C:/workspace/WithMate",
    branch: "feat/temp-review-session",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 5,
    characterId: "char-1",
    character: "Test Character",
    characterIconPath: "",
    characterThemeColors: {
      main: "#6f8cff",
      sub: "#6fb8c7",
    },
    runState: "idle",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "fast",
    model: "gpt-test",
    reasoningEffort: "low",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    messages: [],
    stream: [],
  };
}

function createProjectionInput(overrides: Partial<AgentSessionChatProjectionInput> = {}): AgentSessionChatProjectionInput {
  return {
    selectedSession: createSession(),
    selectedSessionCharacter: createCharacterProfile(),
    displayedMessages: [],
    expandedArtifacts: {},
    sessionThemeStyle: undefined,
    sessionWorkbenchRef: React.createRef<HTMLDivElement>(),
    sessionWorkbenchStyle: undefined,
    isSessionHeaderExpanded: true,
    isEditingTitle: false,
    titleDraft: "Main session",
    isSelectedSessionRunning: false,
    isSelectedSessionReadOnly: false,
    isSelectedSessionPinned: false,
    isSessionPinPending: false,
    messageListRef: React.createRef<HTMLDivElement>(),
    pendingRunIndicatorAnnouncement: "",
    pendingRunIndicatorText: "",
    pendingMessageText: "",
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "",
    hasLiveRunAssistantText: false,
    liveRunErrorMessage: "",
    inlinePathFeedback: "",
    workspaceAvailabilityMessage: "",
    isWorkspaceAvailabilityCheckPending: false,
    isWorkspaceAvailable: true,
    isMessageListFollowing: true,
    retryBanner: null,
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    composerBlocked: false,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isPromptTemplateWorkspaceOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    canCollapseActionDock: true,
    isCustomAgentListLoading: false,
    isSkillListLoading: false,
    skillListError: null,
    customAgentItems: [],
    skillItems: [],
    composerAttachmentItems: [],
    additionalDirectoryItems: [],
    draft: "",
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
    isComposerDisabled: false,
    isSendDisabled: true,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    composerSendButtonTitle: undefined,
    isComposerBlockedFeedbackActive: false,
    approvalChoiceOptions: [{ value: "never", label: "never" }],
    sandboxChoiceOptions: [{ value: "workspace-write", label: "workspace-write" }],
    speedChoiceOptions: [{ value: "standard", label: "Standard" }, { value: "fast", label: "Fast" }],
    modelSelectOptions: [{ value: "gpt-test", label: "GPT Test" }],
    selectedModelFallbackLabel: "GPT Test",
    reasoningSelectOptions: [{ value: "low", label: "low" }],
    attachmentCount: 0,
    isActionDockExpanded: true,
    isContextRailResizing: false,
    isContextRailVisible: true,
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      latestCommand: { state: "empty", tone: "muted", label: "No command" },
      tasks: { state: "empty", tone: "muted", label: "No tasks" },
      reasoning: { state: "empty", tone: "muted", label: "No reasoning" },
      context: { state: "empty", tone: "muted", label: "No context" },
      companion: { state: "empty", tone: "muted", label: "No companion" },
    } as AgentSessionChatProjectionInput["contextPaneProjection"],
    selectedBackgroundTasks: [],
    selectedCompanionGroupMonitorEntries: [],
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "",
    selectedCopilotRemainingRequestsLabel: "",
    selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: null,
    selectedContextEmptyText: "context usage はまだありません",
    latestCommandEmptyText: "直近 run の command 記録はありません",
    selectedDiff: null,
    selectedDiffThemeStyle: {},
    auditLogsOpen: false,
    displayedSessionAuditLogs: [],
    auditLogDetails: {},
    auditLogOperationDetails: {},
    auditLogsHasMore: false,
    auditLogsLoading: false,
    auditLogsTotal: 0,
    auditLogsErrorMessage: null,
    onToggleHeaderExpanded: noop,
    onOpenAuditLog: noop,
    onOpenSessionTerminal: noop,
    onOpenSessionFilesTerminal: noop,
    onTitleDraftChange: noop,
    onTitleInputKeyDown: noop,
    onSaveTitle: noop,
    onCancelTitleEdit: noop,
    onStartTitleEdit: noop,
    onDeleteSession: noop,
    onToggleSessionPin: noop,
    onOpenSessionExplorer: noop,
    onOpenSessionFilesExplorer: noop,
    onMessageListScroll: noop,
    onToggleArtifact: noop,
    onLoadArtifactDetail: async () => null,
    onOpenDiff: noop,
    onResolveLiveApproval: noop,
    onResolveLiveElicitation: noop,
    onOpenInlinePath: noop,
    onDismissInlinePathFeedback: noop,
    onRecheckWorkspaceAvailability: noop,
    getChangedFilesEmptyText: () => "ファイル変更はありません",
    onCopyMessageText: noop,
    onQuoteMessageText: noop,
    onResendLastMessage: noop,
    onEditLastMessage: noop,
    onConfirmRetryDraftReplace: noop,
    onCancelRetryDraftReplace: noop,
    onPickFile: noop,
    onPickFolder: noop,
    onPickImage: noop,
    onAddToSessionFiles: noop,
    onPickSessionFiles: noop,
    onToggleAgentPicker: noop,
    onToggleSkillPicker: noop,
    onOpenPromptTemplates: noop,
    onAddAdditionalDirectory: noop,
    onToggleAdditionalDirectoryList: noop,
    onCollapseActionDock: noop,
    onJumpToMessageListBottom: noop,
    onSelectCustomAgent: noop,
    onSelectSkill: noop,
    onRemoveAttachment: noop,
    onRemoveAdditionalDirectory: noop,
    onDraftChange: noop,
    onDraftFocus: noop,
    onDraftKeyDown: noop,
    onDraftPaste: noop,
    onDraftSelect: noop,
    onDraftCompositionStart: noop,
    onDraftCompositionEnd: noop,
    onSendOrCancel: noop,
    onChangeApprovalMode: noop,
    onChangeCodexSandboxMode: noop,
    onChangeCodexSpeed: noop,
    onChangeModel: noop,
    onChangeReasoningEffort: noop,
    onStartContextRailResize: noop,
    onToggleContextRailVisibility: noop,
    onCycleContextPaneTab: noop,
    onOpenCompanionReview: noop,
    onCloseDiff: noop,
    onOpenDiffWindow: noop,
    onLoadMoreAuditLogs: noop,
    onLoadAuditLogDetail: async () => null,
    onLoadAuditLogOperationDetail: async () => null,
    onCloseAuditLog: noop,
    ...overrides,
  };
}

test("buildAgentSessionChatWindowProps は Auxiliary mode でも attachment 経路を維持する", () => {
  const onDraftPaste = noop;
  const attachmentItems: AgentSessionChatProjectionInput["composerAttachmentItems"] = [
    {
      key: "file:src/App.tsx",
      kind: "file",
      kindLabel: "File",
      locationLabel: "Workspace",
      primaryLabel: "src/App.tsx",
      secondaryLabel: "App component",
      title: "src/App.tsx",
      removeTargets: ["src/App.tsx"],
    },
  ];
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    isAuxiliaryMode: true,
    composerAttachmentItems: attachmentItems,
    attachmentCount: 1,
    onDraftPaste,
  }));

  assert.equal(props.composerProps.showAttachmentControls, true);
  assert.deepEqual(props.composerProps.attachmentItems, attachmentItems);
  assert.equal(props.composerProps.onDraftPaste, onDraftPaste);
  assert.equal(props.compactActionDockProps.attachmentCount, 1);
});

test("buildAgentSessionChatWindowProps は retry actions を共通 chat layout に渡す", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    retryBanner: {
      kind: "failed",
      badge: "失敗",
      title: "前回の依頼は完了できませんでした",
      lastRequestText: "調べて",
    },
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    isActionDockExpanded: false,
  }));

  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, props.recoveryActions));

  assert.equal(props.isActionDockExpanded, false);
  assert.match(html, /retry-banner failed/);
  assert.match(html, />再送<\/button>/);
  assert.match(html, />編集<\/button>/);
});

test("buildAgentSessionChatWindowProps は Workspace 利用不可を共通エラー領域へ投影して操作を無効化する", () => {
  const onRecheckWorkspaceAvailability = noop;
  const message = "Workspace not found: C:/missing. Restore it, then recheck.";
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    workspaceAvailabilityMessage: message,
    isWorkspaceAvailable: false,
    onRecheckWorkspaceAvailability,
    composerSendability: {
      primaryFeedback: message,
      secondaryFeedback: [],
      feedbackTone: "blocked",
      shouldShowFeedback: true,
    },
  }));

  assert.deepEqual(props.errorNotices, [{
    id: "workspace-unavailable",
    message,
    relatedControl: "composer",
    actionLabel: "Recheck",
    isActionDisabled: false,
    onAction: onRecheckWorkspaceAvailability,
  }]);
  assert.equal(props.headerProps.isTerminalDisabled, true);
  const headerHtml = renderToStaticMarkup(React.createElement(React.Fragment, null, props.headerProps.workspaceActions));
  assert.match(headerHtml, /disabled=""/);
});

test("buildAgentSessionChatWindowProps は composer とpath操作のエラーを共通領域へ投影する", () => {
  const onDismissInlinePathFeedback = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    inlinePathFeedback: "The local path was not found.",
    onDismissInlinePathFeedback,
    composerSendability: {
      primaryFeedback: "Path not found: C:/missing",
      secondaryFeedback: ["C:/missing"],
      feedbackTone: "blocked",
      shouldShowFeedback: true,
    },
    isActionDockExpanded: false,
  }));

  assert.deepEqual(props.errorNotices, [
    {
      id: "composer-sendability",
      message: "Path not found: C:/missing",
      details: ["C:/missing"],
      relatedControl: "composer",
    },
    {
      id: "inline-path-open",
      message: "The local path was not found.",
      dismissLabel: "パスを開いた結果を閉じる",
      onDismiss: onDismissInlinePathFeedback,
    },
  ]);
  assert.equal(props.isActionDockExpanded, false);
  assert.equal("inlinePathFeedback" in props.messageColumnProps, false);
});

test("ID-05: buildAgentSessionChatWindowProps は呼出元SessionのタイトルとWindow操作をmessage columnへ渡す", () => {
  const onOpenOriginSession = () => {};
  const originSessionDetails = [{
    sessionId: "origin-session",
    taskTitle: "呼出元の作業",
  }];
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    originSessionDetails,
    onOpenOriginSession,
  }));

  assert.deepEqual(props.messageColumnProps.originSessionDetails, originSessionDetails);
  assert.equal(props.messageColumnProps.onOpenOriginSession, onOpenOriginSession);
});

test("buildAgentSessionChatWindowProps は submit pending の helper feedback を共通エラー領域へ投影しない", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    composerSendability: {
      isBusy: true,
      busyReason: "Message submission is in progress.",
      primaryFeedback: "Message submission is in progress.",
      secondaryFeedback: [],
      feedbackTone: "helper",
      shouldShowFeedback: true,
    },
  }));

  assert.deepEqual(props.errorNotices, []);
  assert.equal(props.composerProps.composerSendability.feedbackTone, "helper");
  assert.equal(props.composerProps.composerSendability.isBusy, true);
});

// @test-value v1
// kind = "invariant"
// claim = "workspace再検証中のbusy状態は送信可否へ反映し、共通error表示へは投影しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md" }
// failure_mode = "正常な再検証中にerror bannerが表示され、利用者がworkspace障害と誤認する"
// scope = "agent-session-chat-projection-workspace-status"
// lifecycle = "permanent"
// @end-test-value
test("buildAgentSessionChatWindowProps は workspace 再検証中の busy status を共通エラー領域へ投影しない", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    composerSendability: {
      isBusy: true,
      busyReason: "Workspace availability is being checked.",
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    isAuxiliaryMode: true,
  }));

  assert.deepEqual(props.errorNotices, []);
  assert.equal(props.composerProps.composerSendability.isBusy, true);
  assert.equal(props.composerProps.composerSendability.feedbackTone, null);
});

test("buildAgentSessionChatWindowProps は blank draft の helper feedback を共通エラー領域へ投影しない", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    composerSendability: {
      primaryFeedback: "Message is empty.",
      secondaryFeedback: [],
      feedbackTone: "helper",
      shouldShowFeedback: true,
    },
  }));

  assert.deepEqual(props.errorNotices, []);
});

test("buildAgentSessionChatWindowProps は Auxiliary mode で parent header 操作だけ隠す", () => {
  const normalProps = buildAgentSessionChatWindowProps(createProjectionInput());
  const auxiliaryProps = buildAgentSessionChatWindowProps(createProjectionInput({ isAuxiliaryMode: true }));

  assert.equal(normalProps.headerProps.showRenameButton, true);
  assert.equal(normalProps.headerProps.showAuditLogButton, true);
  assert.equal(normalProps.headerProps.showDeleteButton, true);
  assert.equal(auxiliaryProps.headerProps.showRenameButton, false);
  assert.equal(auxiliaryProps.headerProps.showAuditLogButton, true);
  assert.equal(auxiliaryProps.headerProps.showDeleteButton, false);
});

// @test-value v1
// kind = "invariant"
// claim = "中央preview表示中はmessage操作shortcut scopeを無効にし、通常chat表示時だけ有効にする"
// oracle = { type = "contract", ref = "docs/features/keyboard-shortcuts.md" }
// failure_mode = "preview操作中のshortcutが背後のmessageへ誤作用する"
// scope = "agent-session-chat-projection-shortcut-scope"
// lifecycle = "permanent"
// @end-test-value
test("buildAgentSessionChatWindowProps は central preview 中に message shortcut scope を無効にする", () => {
  const chatProps = buildAgentSessionChatWindowProps(createProjectionInput());
  const previewProps = buildAgentSessionChatWindowProps(createProjectionInput({
    mainContent: React.createElement("div", null, "preview"),
  }));

  assert.equal(chatProps.messageColumnProps.isContentActive, true);
  assert.equal(previewProps.messageColumnProps.isContentActive, false);
});

// @test-value v1
// kind = "invariant"
// claim = "Glossary annotation matcherとactivation callbackをmessage ownerへ同じprojectionとして渡す"
// oracle = { type = "contract", ref = "docs/features/repository-glossary.md" }
// failure_mode = "Session messageで用語注釈が欠落する、または注釈を選択してもGlossary detailを開けない"
// scope = "agent-session-chat-projection-glossary"
// lifecycle = "permanent"
// @end-test-value
test("buildAgentSessionChatWindowProps はglossary annotation projectionとactivationをmessage ownerへ渡す", () => {
  const glossaryAnnotationMatcher = createGlossaryAnnotationMatcher([{
    term: "Runtime",
    aliases: [],
    definition: "Runtime definition",
  }], "revision-1");
  const onActivateGlossaryEntry = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    glossaryAnnotationMatcher,
    onActivateGlossaryEntry,
  }));

  assert.equal(props.messageColumnProps.glossaryAnnotationMatcher, glossaryAnnotationMatcher);
  assert.equal(props.messageColumnProps.onActivateGlossaryEntry, onActivateGlossaryEntry);
});

test("buildAgentSessionChatWindowProps は Header から独立した right pane props を共通 pane に渡す", () => {
  const onToggleHeaderExpanded = () => {};
  const onCycleContextPaneTab = () => {};
  const onOpenCompanionReview = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    selectedContextEmptyText: "Agent context empty",
    latestCommandEmptyText: "Agent latest command empty",
    onToggleHeaderExpanded,
    onCycleContextPaneTab,
    onOpenCompanionReview,
  }));
  const rightPane = props.rightPane as React.ReactElement<{
    children: React.ReactElement<SessionContextPaneProps>;
  }>;
  const paneProps = rightPane.props.children.props;

  assert.equal(paneProps.contextEmptyText, "Agent context empty");
  assert.equal(paneProps.latestCommandEmptyText, "Agent latest command empty");
  assert.equal("onToggleHeaderExpanded" in paneProps, false);
  assert.equal(paneProps.onCycleContextPaneTab, onCycleContextPaneTab);
  assert.equal(paneProps.onOpenCompanionReview, onOpenCompanionReview);
});

test("buildAgentSessionChatWindowProps は right pane visibility と toggle を共通 shell に渡す", () => {
  const onToggleContextRailVisibility = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    isContextRailVisible: false,
    onToggleContextRailVisibility,
  }));
  const splitter = props.splitter as React.ReactElement<{
    isPanelExpanded: boolean;
    onTogglePanel: () => void;
  }>;

  assert.equal(props.isRightPaneVisible, false);
  assert.equal(splitter.props.isPanelExpanded, false);
  assert.equal(splitter.props.onTogglePanel, onToggleContextRailVisibility);
});

test("buildAgentSessionChatWindowProps は header action callbacks を維持する", () => {
  const onOpenSessionExplorer = () => {};
  const onOpenSessionFilesExplorer = () => {};
  const onOpenSessionFilesTerminal = () => {};
  const onToggleSessionPin = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    isSelectedSessionPinned: true,
    onOpenSessionExplorer,
    onOpenSessionFilesExplorer,
    onOpenSessionFilesTerminal,
    onToggleSessionPin,
  }));
  const workspaceAction = props.headerProps.workspaceActions as React.ReactElement<{
    onClick: () => void;
  }>;
  const sessionFilesActions = props.headerProps.sessionFilesActions as React.ReactElement<{
    children: React.ReactNode;
  }>;
  const [sessionFilesExplorer, sessionFilesTerminal] = React.Children.toArray(
    sessionFilesActions.props.children,
  ) as Array<React.ReactElement<{ onClick: () => void }>>;

  assert.equal(workspaceAction.props.onClick, onOpenSessionExplorer);
  assert.equal(sessionFilesExplorer.props.onClick, onOpenSessionFilesExplorer);
  assert.equal(sessionFilesTerminal.props.onClick, onOpenSessionFilesTerminal);
  assert.equal(props.headerProps.isPinned, true);
  assert.equal(props.headerProps.onTogglePin, onToggleSessionPin);
});

test("buildAgentSessionChatWindowProps は composer と compact dock の live props を維持する", () => {
  const onCollapseActionDock = () => {};
  const onToggleActionDock = () => {};
  const onJumpToMessageListBottom = () => {};
  const onSendOrCancel = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    selectedSession: {
      ...createSession(),
      provider: "copilot",
      runState: "running",
      model: "gpt-agent",
      reasoningEffort: "medium",
      allowedAdditionalDirectories: ["C:/extra"],
    },
    selectedCustomAgentLabel: "Copilot Agent",
    isSelectedSessionRunning: true,
    pendingRunIndicatorAnnouncement: "Agent running",
    pendingRunIndicatorText: "Agent responding",
    isMessageListFollowing: false,
    composerSendButtonTitle: "Agent stop",
    chatNotice: "New messages",
    attachmentCount: 2,
    onCollapseActionDock,
    onToggleActionDock,
    onJumpToMessageListBottom,
    onSendOrCancel,
  }));

  assert.equal(props.composerProps.isRunning, true);
  assert.equal(props.composerProps.pendingRunIndicatorAnnouncement, "Agent running");
  assert.equal(props.composerProps.pendingRunIndicatorText, "Agent responding");
  assert.equal(props.composerProps.canSelectCustomAgent, true);
  assert.equal(props.composerProps.showCustomAgentPicker, true);
  assert.equal(props.composerProps.showPromptTemplateButton, true);
  assert.equal(props.composerProps.selectedCustomAgentLabel, "Copilot Agent");
  assert.equal(props.composerProps.additionalDirectoryCount, 1);
  assert.equal(props.composerProps.showJumpToBottom, true);
  assert.equal(props.composerProps.selectedApprovalMode, "never");
  assert.equal(props.composerProps.selectedCodexSandboxMode, "workspace-write");
  assert.equal(props.composerProps.selectedModel, "gpt-agent");
  assert.equal(props.composerProps.selectedReasoningEffort, "medium");
  assert.equal(props.composerProps.sendButtonTitle, "Agent stop");
  assert.equal("onCollapse" in props.composerProps, false);
  assert.equal(props.composerProps.chatNotice, "New messages");
  assert.equal(props.compactActionDockProps.attachmentCount, 2);
  assert.equal(props.compactActionDockProps.chatNotice, "New messages");
  assert.equal(props.compactActionDockProps.isRunning, true);
  assert.equal(props.compactActionDockProps.pendingRunIndicatorText, "Agent responding");
  assert.equal(props.compactActionDockProps.showJumpToBottom, true);
  assert.equal(props.compactActionDockProps.cancelButtonTitle, "Agent stop");
  assert.equal(props.compactActionDockProps.onExpand, onToggleActionDock);
  assert.equal(props.compactActionDockProps.onJumpToBottom, onJumpToMessageListBottom);
  assert.equal(props.compactActionDockProps.onCancel, onSendOrCancel);
  assert.equal("additionalDirectoryItems" in props.composerProps, false);
  assert.deepEqual(props.additionalDirectoryListProps?.items, []);
});

test("buildAgentSessionChatWindowProps は追加Directory一覧をshared chat surfaceへ投影する", () => {
  const onRemoveAdditionalDirectory = () => {};
  const additionalDirectoryItems = [{
    key: "C:/shared/docs",
    path: "C:/shared/docs",
    primaryLabel: "docs",
    secondaryLabel: "C:/shared",
    title: "C:/shared/docs",
    canRemove: true,
  }];
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    isAdditionalDirectoryListOpen: true,
    additionalDirectoryItems,
    onRemoveAdditionalDirectory,
  }));

  assert.deepEqual(props.additionalDirectoryListProps, {
    isOpen: true,
    items: additionalDirectoryItems,
    isInteractionDisabled: false,
    onRemove: onRemoveAdditionalDirectory,
  });
  assert.equal("additionalDirectoryItems" in props.composerProps, false);
  assert.equal("onRemoveAdditionalDirectory" in props.composerProps, false);
});

test("buildAgentSessionChatWindowProps は Codex で custom agent picker を隠す", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput());

  assert.equal(props.composerProps.canSelectCustomAgent, false);
  assert.equal(props.composerProps.showCustomAgentPicker, false);
});

test("buildAgentSessionChatWindowProps は Skill 候補を chat shell の一時 surface へ投影する", () => {
  const onSelectSkill = () => {};
  const onToggleSkillPicker = () => {};
  const skillItems = [{
    key: "skill-review",
    skillId: "review",
    primaryLabel: "review",
    secondaryLabel: "Workspace",
    title: "review",
  }];
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    isSkillPickerOpen: true,
    skillItems,
    skillListError: "",
    onSelectSkill,
    onToggleSkillPicker,
  }));

  assert.deepEqual(props.skillPickerProps?.items, skillItems);
  assert.equal(props.skillPickerProps?.isOpen, true);
  assert.equal(props.skillPickerProps?.onSelectSkill, onSelectSkill);
  assert.equal(props.skillPickerProps?.onDismiss, onToggleSkillPicker);
  assert.equal("skillItems" in props.composerProps, false);
});

test("buildAgentSessionChatWindowProps は Character Authoring で Skill panel を開かない", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    selectedSession: { ...createSession(), sessionKind: "character-authoring" },
    isSkillPickerOpen: true,
  }));

  assert.equal(props.composerProps.showSkillPicker, false);
  assert.equal(props.skillPickerProps?.isOpen, false);
});

test("buildAgentSessionChatWindowProps は selected session running boolean を composer dock に渡す", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    selectedSession: {
      ...createSession(),
      runState: "idle",
    },
    isSelectedSessionRunning: true,
  }));

  assert.equal(props.composerProps.isRunning, true);
  assert.equal(props.compactActionDockProps.isRunning, true);
});

test("buildAgentSessionChatWindowProps は session runState ではなく running boolean を優先する", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    selectedSession: {
      ...createSession(),
      runState: "running",
    },
    isSelectedSessionRunning: false,
  }));

  assert.equal(props.composerProps.isRunning, false);
  assert.equal(props.compactActionDockProps.isRunning, false);
});

// @test-value v1
// kind = "contract"
// claim = "shared composer projectionは表示中SessionのSpeedを渡し、running時は既存runtime option制約で変更不可にする"
// oracle = { type = "contract", ref = "accepted behavior: shared UI" }
// failure_mode = "表示中Sessionの選択値と表示がずれる、またはrun中にSpeedを変更できる"
// scope = "session-chat-projection"
// lifecycle = "permanent"
// @end-test-value
test("buildAgentSessionChatWindowProps はSpeed選択値とrunning制約をshared composerへ渡す", () => {
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    isSelectedSessionRunning: true,
  }));

  assert.equal(props.composerProps.selectedCodexSpeed, "fast");
  assert.deepEqual(props.composerProps.speedOptions, [
    { value: "standard", label: "Standard" },
    { value: "fast", label: "Fast" },
  ]);
  const html = renderToStaticMarkup(React.createElement(
    SessionComposerExpanded,
    props.composerProps,
  ));
  assert.match(html, /disabled="" aria-label="Speed"/);
});
