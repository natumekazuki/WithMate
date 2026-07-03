import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import {
  buildAgentSessionChatWindowProps,
  type AgentSessionChatProjectionInput,
} from "../../src/chat/session-chat-projection.js";
import type { CharacterProfile } from "../../src/app-state.js";
import type { SessionContextPaneProps } from "../../src/session-components.js";
import type { Session } from "../../src/session-state.js";

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
    isMessageListFollowing: true,
    retryBanner: null,
    isRetryDetailsOpen: false,
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
    composerBlocked: false,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    canCollapseActionDock: true,
    isCustomAgentListLoading: false,
    isSkillListLoading: false,
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
    modelSelectOptions: [{ value: "gpt-test", label: "GPT Test" }],
    selectedModelFallbackLabel: "GPT Test",
    reasoningSelectOptions: [{ value: "low", label: "low" }],
    actionDockCompactPreview: "",
    attachmentCount: 0,
    isActionDockExpanded: true,
    isContextRailResizing: false,
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
    onOpenSessionExplorer: noop,
    onOpenSessionFilesExplorer: noop,
    onMessageListScroll: noop,
    onToggleArtifact: noop,
    onLoadArtifactDetail: async () => null,
    onOpenDiff: noop,
    onResolveLiveApproval: noop,
    onResolveLiveElicitation: noop,
    onOpenInlinePath: noop,
    getChangedFilesEmptyText: () => "ファイル変更はありません",
    onCopyMessageText: noop,
    onQuoteMessageText: noop,
    onToggleRetryDetails: noop,
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
    onExpandActionDock: noop,
    onChangeApprovalMode: noop,
    onChangeCodexSandboxMode: noop,
    onChangeModel: noop,
    onChangeReasoningEffort: noop,
    onStartContextRailResize: noop,
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

test("buildAgentSessionChatWindowProps は right pane props を共通 pane に渡す", () => {
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
  assert.equal(paneProps.onToggleHeaderExpanded, onToggleHeaderExpanded);
  assert.equal(paneProps.onCycleContextPaneTab, onCycleContextPaneTab);
  assert.equal(paneProps.onOpenCompanionReview, onOpenCompanionReview);
});

test("buildAgentSessionChatWindowProps は header action callbacks を維持する", () => {
  const onOpenSessionExplorer = () => {};
  const onOpenSessionFilesExplorer = () => {};
  const onOpenSessionFilesTerminal = () => {};
  const props = buildAgentSessionChatWindowProps(createProjectionInput({
    onOpenSessionExplorer,
    onOpenSessionFilesExplorer,
    onOpenSessionFilesTerminal,
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
});

test("buildAgentSessionChatWindowProps は composer と compact dock の live props を維持する", () => {
  const onCollapseActionDock = () => {};
  const onExpandActionDock = () => {};
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
    actionDockCompactPreview: "Agent preview",
    attachmentCount: 2,
    onCollapseActionDock,
    onExpandActionDock,
    onJumpToMessageListBottom,
    onSendOrCancel,
  }));

  assert.equal(props.composerProps.isRunning, true);
  assert.equal(props.composerProps.pendingRunIndicatorAnnouncement, "Agent running");
  assert.equal(props.composerProps.pendingRunIndicatorText, "Agent responding");
  assert.equal(props.composerProps.canSelectCustomAgent, true);
  assert.equal(props.composerProps.selectedCustomAgentLabel, "Copilot Agent");
  assert.equal(props.composerProps.additionalDirectoryCount, 1);
  assert.equal(props.composerProps.showJumpToBottom, true);
  assert.equal(props.composerProps.selectedApprovalMode, "never");
  assert.equal(props.composerProps.selectedCodexSandboxMode, "workspace-write");
  assert.equal(props.composerProps.selectedModel, "gpt-agent");
  assert.equal(props.composerProps.selectedReasoningEffort, "medium");
  assert.equal(props.composerProps.sendButtonTitle, "Agent stop");
  assert.equal(props.composerProps.onCollapse, onCollapseActionDock);
  assert.equal(props.compactActionDockProps.actionDockCompactPreview, "Agent preview");
  assert.equal(props.compactActionDockProps.attachmentCount, 2);
  assert.equal(props.compactActionDockProps.isRunning, true);
  assert.equal(props.compactActionDockProps.pendingRunIndicatorText, "Agent responding");
  assert.equal(props.compactActionDockProps.showJumpToBottom, true);
  assert.equal(props.compactActionDockProps.sendButtonTitle, "Agent stop");
  assert.equal(props.compactActionDockProps.onExpand, onExpandActionDock);
  assert.equal(props.compactActionDockProps.onJumpToBottom, onJumpToMessageListBottom);
  assert.equal(props.compactActionDockProps.onSendOrCancel, onSendOrCancel);
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
