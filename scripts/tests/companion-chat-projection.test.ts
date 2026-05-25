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
