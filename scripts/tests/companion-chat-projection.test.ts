import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildCompanionChatWindowProps,
  type CompanionChatProjectionInput,
} from "../../src/chat/companion-chat-projection.js";
import {
  createOptimisticRunningSessionState,
  createOwnedPendingLiveSessionRunState,
} from "../../src/session-live-run-state.js";
import type { CharacterProfile } from "../../src/app-state.js";
import type { CompanionSession } from "../../src/companion-state.js";
import type { SessionContextPaneProps } from "../../src/session-components.js";

const noop = () => {};

function createCharacterProfile(): CharacterProfile {
  return {
    id: "companion",
    name: "Companion",
    iconPath: "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    updatedAt: "2026-05-25T00:00:00.000Z",
    themeColors: { main: "#6f8cff", sub: "#6fb8c7" },
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

function createCompanionSession(): CompanionSession {
  return {
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
    runState: "running",
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
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    messages: [{ role: "user", text: "調べて" }],
  };
}

function createProjectionInput(
  overrides: Partial<CompanionChatProjectionInput> = {},
): CompanionChatProjectionInput {
  return {
    session: createCompanionSession(),
    character: createCharacterProfile(),
    expandedArtifacts: {},
    themeStyle: undefined,
    workbenchRef: React.createRef<HTMLDivElement>(),
    workbenchStyle: undefined,
    isHeaderExpanded: true,
    isEditingTitle: false,
    titleDraft: "Companion session",
    isRunning: true,
    isHeaderActionDisabled: false,
    messageListRef: React.createRef<HTMLDivElement>(),
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "",
    liveRunErrorMessage: "",
    pendingMessageText: "Companion の応答を待っています。",
    isMessageListFollowing: true,
    retryBanner: null,
    isRetryDetailsOpen: false,
    isRetryActionDisabled: true,
    isRetryEditDisabled: true,
    isRetryDraftReplacePending: false,
    isActionDockExpanded: true,
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
    attachmentItems: [],
    additionalDirectoryItems: [],
    workspacePathMatchItems: [],
    draft: "",
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
    isComposerDisabled: true,
    isSendDisabled: true,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    sendButtonTitle: "Companion を停止",
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: "never", label: "never" }],
    selectedApprovalMode: "never",
    sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
    selectedCodexSandboxMode: "workspace-write",
    modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    actionDockCompactPreview: "実行中",
    attachmentCount: 0,
    isContextRailResizing: false,
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      latestCommand: { state: "empty", tone: "muted", label: "No command" },
      tasks: { state: "empty", tone: "muted", label: "No tasks" },
      reasoning: { state: "empty", tone: "muted", label: "No reasoning" },
      context: { state: "empty", tone: "muted", label: "No context" },
      companion: { state: "empty", tone: "muted", label: "No companion" },
    } as CompanionChatProjectionInput["contextPaneProjection"],
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    companionGroupMonitorEntries: [],
    isCopilotSession: false,
    selectedCopilotRemainingPercentLabel: "",
    selectedCopilotRemainingRequestsLabel: "",
    selectedCopilotQuotaResetLabel: "",
    selectedSessionContextTelemetry: null,
    selectedSessionContextTelemetryProjection: null,
    selectedDiff: null,
    selectedDiffThemeStyle: {},
    auditLogsOpen: false,
    displayedSessionAuditLogs: [],
    auditLogSourceLabel: "Companion",
    auditLogDetails: {},
    auditLogOperationDetails: {},
    auditLogsHasMore: false,
    auditLogsLoading: false,
    auditLogsTotal: 0,
    auditLogsErrorMessage: null,
    toastMessage: "",
    toastTone: "success",
    onToggleHeaderExpanded: noop,
    onToggleContextPaneHeaderExpanded: noop,
    onOpenAuditLog: noop,
    onOpenTerminal: noop,
    onOpenSessionFilesTerminal: noop,
    onTitleDraftChange: noop,
    onTitleInputKeyDown: noop,
    onSaveTitle: noop,
    onCancelTitleEdit: noop,
    onStartTitleEdit: noop,
    onOpenWorktree: noop,
    onOpenSessionFilesExplorer: noop,
    onOpenMergeWindow: noop,
    onMessageListScroll: noop,
    onToggleArtifact: noop,
    onLoadArtifactDetail: async () => null,
    onOpenDiff: noop,
    onResolveLiveApproval: noop,
    onResolveLiveElicitation: noop,
    onOpenInlinePath: noop,
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
    onSelectWorkspacePathMatch: noop,
    onActivateWorkspacePathMatch: noop,
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

test("buildCompanionChatWindowProps は running 中の response 待機文を message column に渡す", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput());

  assert.equal(props.messageColumnProps.isRunning, true);
  assert.equal(props.messageColumnProps.pendingMessageText, "Companion の応答を待っています。");
  assert.deepEqual(props.messageColumnProps.messages, [{ role: "user", text: "調べて" }]);
});

test("buildCompanionChatWindowProps は live assistant text の有無を共通 message column helper に委ねる", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput({
    liveRunAssistantText: "途中応答",
  }));

  assert.equal(props.messageColumnProps.liveRunAssistantText, "途中応答");
  assert.equal(props.messageColumnProps.hasLiveRunAssistantText, true);
});

test("buildCompanionChatWindowProps は投影済み transcript と group を message column に渡す", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput({
    displayedMessages: [
      { role: "user", text: "親の依頼" },
      { role: "assistant", text: "Auxiliary の回答", accent: true },
    ],
    displayedMessageKeys: ["session-companion-session-1-0", "auxiliary-aux-1-0"],
    displayedMessageGroups: [null, { id: "aux-1", label: "Auxiliary" }],
    pendingMessageGroupId: "aux-1",
  }));

  assert.deepEqual(props.messageColumnProps.messages, [
    { role: "user", text: "親の依頼" },
    { role: "assistant", text: "Auxiliary の回答", accent: true },
  ]);
  assert.deepEqual(props.messageColumnProps.messageKeys, ["session-companion-session-1-0", "auxiliary-aux-1-0"]);
  assert.deepEqual(props.messageColumnProps.messageGroups, [null, { id: "aux-1", label: "Auxiliary" }]);
  assert.equal(props.messageColumnProps.pendingMessageGroupId, "aux-1");
});

test("buildCompanionChatWindowProps は retry banner を共通 composer に渡す", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput({
    retryBanner: {
      kind: "failed",
      badge: "失敗",
      title: "前回の依頼は完了できませんでした",
      stopSummary: "assistant error",
      lastRequestText: "調べて",
    },
    isRetryDetailsOpen: true,
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: false,
  }));

  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, props.composerProps.retryBanner));

  assert.match(html, /retry-banner failed/);
  assert.match(html, />同じ依頼を再送<\/button>/);
  assert.match(html, />編集して再送<\/button>/);
});

test("buildCompanionChatWindowProps は retry draft 上書き確認を共通 composer に渡す", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput({
    retryBanner: {
      kind: "failed",
      badge: "失敗",
      title: "前回の依頼は完了できませんでした",
      stopSummary: "assistant error",
      lastRequestText: "調べて",
    },
    isRetryDetailsOpen: true,
    isRetryActionDisabled: false,
    isRetryEditDisabled: false,
    isRetryDraftReplacePending: true,
  }));

  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, props.composerProps.retryBanner));

  assert.match(html, /今の下書きは残しています/);
  assert.match(html, />前回の依頼で置き換える<\/button>/);
  assert.match(html, />今の下書きを続ける<\/button>/);
});

test("buildCompanionChatWindowProps は通常 Companion の header action を維持する", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput());
  const headerActionsHtml = renderToStaticMarkup(React.createElement(React.Fragment, null, props.headerProps.actions));

  assert.equal(props.headerProps.showRenameButton, true);
  assert.equal(props.headerProps.showAuditLogButton, true);
  assert.equal(props.headerProps.showDeleteButton, false);
  assert.doesNotMatch(props.className, /auxiliary-session-mode/);
  assert.match(headerActionsHtml, />Merge<\/button>/);
  assert.equal(props.composerProps.modeLabel, undefined);
  assert.equal(props.compactActionDockProps.modeLabel, undefined);
});

test("buildCompanionChatWindowProps は Audit Log modal に source label を渡す", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput());
  const modalsElement = props.modals as React.ReactElement<{ auditLogSourceLabel?: string }>;

  assert.equal(modalsElement.props.auditLogSourceLabel, "Companion");
});

test("buildCompanionChatWindowProps は Auxiliary mode の header action slot と mode label を渡す", () => {
  const props = buildCompanionChatWindowProps(createProjectionInput({
    headerActions: React.createElement(
      "button",
      { className: "drawer-toggle compact secondary", type: "button" },
      "Return to main",
    ),
    isAuxiliaryMode: true,
  }));

  const headerActionsHtml = renderToStaticMarkup(React.createElement(React.Fragment, null, props.headerProps.actions));

  assert.equal(props.headerProps.showRenameButton, false);
  assert.equal(props.headerProps.showAuditLogButton, false);
  assert.equal(props.headerProps.showDeleteButton, false);
  assert.match(props.className, /auxiliary-session-mode/);
  assert.match(headerActionsHtml, />Return to main<\/button>/);
  assert.doesNotMatch(headerActionsHtml, />Merge<\/button>/);
  assert.equal(props.composerProps.modeLabel, "Auxiliary");
  assert.equal(props.compactActionDockProps.modeLabel, "Auxiliary");
});

test("buildCompanionChatWindowProps は Companion right pane props を共通 pane に渡す", () => {
  const onToggleContextPaneHeaderExpanded = () => {};
  const onCycleContextPaneTab = () => {};
  const onOpenCompanionReview = () => {};
  const props = buildCompanionChatWindowProps(createProjectionInput({
    onToggleContextPaneHeaderExpanded,
    onCycleContextPaneTab,
    onOpenCompanionReview,
  }));
  const rightPane = props.rightPane as React.ReactElement<{
    children: React.ReactElement<SessionContextPaneProps>;
  }>;
  const paneProps = rightPane.props.children.props;

  assert.equal(paneProps.contextEmptyText, "context usage はまだありません。");
  assert.equal(paneProps.latestCommandEmptyText, undefined);
  assert.equal(paneProps.onToggleHeaderExpanded, onToggleContextPaneHeaderExpanded);
  assert.equal(paneProps.onCycleContextPaneTab, onCycleContextPaneTab);
  assert.equal(paneProps.onOpenCompanionReview, onOpenCompanionReview);
});

test("buildCompanionChatWindowProps は header action callbacks と Merge disabled state を維持する", () => {
  const onOpenWorktree = () => {};
  const onOpenSessionFilesExplorer = () => {};
  const onOpenSessionFilesTerminal = () => {};
  const inactiveSession: CompanionSession = {
    ...createCompanionSession(),
    status: "recovery-required",
  };
  const props = buildCompanionChatWindowProps(createProjectionInput({
    session: inactiveSession,
    onOpenWorktree,
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
  const headerActionsHtml = renderToStaticMarkup(React.createElement(React.Fragment, null, props.headerProps.actions));

  assert.equal(workspaceAction.props.onClick, onOpenWorktree);
  assert.equal(sessionFilesExplorer.props.onClick, onOpenSessionFilesExplorer);
  assert.equal(sessionFilesTerminal.props.onClick, onOpenSessionFilesTerminal);
  assert.match(headerActionsHtml, /disabled=""/);
  assert.match(headerActionsHtml, />Merge<\/button>/);
});

test("Companion の optimistic running state は user prompt と pending live run を同じ session に紐づける", () => {
  const session = createCompanionSession();
  const runningSession = createOptimisticRunningSessionState(
    session,
    "続けて",
    "2026-05-25T00:01:00.000Z",
  );
  const ownedLiveRun = createOwnedPendingLiveSessionRunState(runningSession, {
    ownerSessionId: "other-session",
    state: null,
  });

  assert.equal(runningSession.status, "active");
  assert.equal(runningSession.runState, "running");
  assert.equal(runningSession.updatedAt, "2026-05-25T00:01:00.000Z");
  assert.deepEqual(session.messages, [{ role: "user", text: "調べて" }]);
  assert.deepEqual(runningSession.messages, [
    { role: "user", text: "調べて" },
    { role: "user", text: "続けて" },
  ]);
  assert.equal(ownedLiveRun.ownerSessionId, runningSession.id);
  assert.equal(ownedLiveRun.state?.sessionId, runningSession.id);
  assert.equal(ownedLiveRun.state?.threadId, runningSession.threadId);
  assert.equal(ownedLiveRun.state?.assistantText, "");
  assert.equal(ownedLiveRun.state?.errorMessage, "");
});
