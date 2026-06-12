import assert from "node:assert/strict";
import test from "node:test";
import React, { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SessionActionDockCompactRow,
  SessionContextPane,
  SessionComposerExpanded,
  SessionMessageColumn,
  type SessionMessageColumnProps,
} from "../../src/session-components.js";
import { buildContextPaneProjection } from "../../src/session-ui-projection.js";
import type { CharacterProfile, LiveApprovalRequest, LiveElicitationRequest, Message } from "../../src/app-state.js";

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

test("SessionMessageColumn は大量メッセージを最新 chunk に絞って描画する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isMessageListFollowing: false,
  });

  const messageRowCount = (html.match(/message-row/g) ?? []).length;
  assert.ok(messageRowCount > 0, "message-row が1件も描画されていない");
  assert.ok(messageRowCount < 100, "100件全て message-row が描画されている");
  assert.doesNotMatch(html, /message 1<\/p>/);
  assert.match(html, /message 100<\/p>/);
  assert.match(html, /以前のメッセージを読み込む/);
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

test("SessionMessageColumn は assistant response action を assistant message にだけ描画する", () => {
  const html = renderSessionMessageColumn({
    messages: [
      { role: "assistant", text: "assistant result" },
      { role: "user", text: "user prompt" },
    ],
    withResponseActions: true,
  });

  assert.match(html, /message-response-actions/);
  assert.match(html, />Copy</);
  assert.match(html, />Quote</);
  assert.equal((html.match(/message-response-actions/g) ?? []).length, 1);
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

test("SessionMessageColumn は実行中の assistant text を pending bubble 内に表示する", () => {
  const html = renderSessionMessageColumn({
    messages: createMessages(100),
    isRunning: true,
    liveRunAssistantText: "ストリーミング中の返答",
  });

  assert.match(html, /pending-row/);
  assert.match(html, /ストリーミング中の返答/);
  assert.ok(
    html.indexOf("message 100") < html.indexOf("pending-row"),
    "pending row は既存メッセージの後に描画する",
  );
  assert.ok(
    html.indexOf("pending-row") < html.indexOf("ストリーミング中の返答"),
    "streaming assistant text は pending row 内に描画する",
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
      workspacePathMatchItems: [],
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
      onSelectWorkspacePathMatch() {},
      onActivateWorkspacePathMatch() {},
      onChangeApprovalMode() {},
      onChangeCodexSandboxMode() {},
      onChangeModel() {},
      onChangeReasoningEffort() {},
    }),
  );

  assert.ok(html.indexOf("末尾へ移動") < html.indexOf("Hide"));
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
      workspacePathMatchItems: [],
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
      onSelectWorkspacePathMatch() {},
      onActivateWorkspacePathMatch() {},
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
