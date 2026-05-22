import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import {
  buildChatPageClassName,
  buildLiveSessionCompactActionDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionMessageColumnProps,
  buildLiveSessionSplitterProps,
  createStaticChatCharacterProfile,
  createStaticChatComposerSendability,
  createHiddenControlsChatComposerProps,
  createHiddenControlsTextChatComposerProps,
  createIdleChatMessageColumnProps,
  createStaticChatCompactActionDockProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  createStaticTextConversationMessageColumnProps,
  isStaticChatSendDisabled,
  toConversationMessages,
} from "../../src/chat/chat-window-adapter.js";
import type { ChatWindowProps } from "../../src/chat/chat-window.js";

const noop = () => {};

test("buildChatPageClassName は header collapse class を共通形式で組み立てる", () => {
  assert.equal(buildChatPageClassName({ isHeaderExpanded: true }), "");
  assert.equal(
    buildChatPageClassName({ isHeaderExpanded: false }),
    "session-page-header-collapsed",
  );
  assert.equal(
    buildChatPageClassName({ baseClassName: "theme-accent", isHeaderExpanded: true }),
    "theme-accent",
  );
  assert.equal(
    buildChatPageClassName({ baseClassName: "theme-accent", isHeaderExpanded: false }),
    "theme-accent session-page-header-collapsed",
  );
});

function createCharacter(): ChatWindowProps["messageColumnProps"]["character"] {
  return createStaticChatCharacterProfile({ id: "mate", name: "Mate" });
}

test("createStaticChatHeaderProps は操作を隠す header 既定値を補う", () => {
  const headerProps = createStaticChatHeaderProps({
    taskTitle: "メイトーク",
    isRunning: false,
    onToggleExpanded: noop,
  });

  assert.equal(headerProps.taskTitle, "メイトーク");
  assert.equal(headerProps.titleDraft, "メイトーク");
  assert.equal(headerProps.isEditingTitle, false);
  assert.equal(headerProps.showRenameButton, false);
  assert.equal(headerProps.showAuditLogButton, false);
  assert.equal(headerProps.showTerminalButton, false);
  assert.equal(headerProps.showDeleteButton, false);
});

test("createIdleChatMessageColumnProps は approval や diff のない message column 既定値を補う", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const messageColumnProps = createIdleChatMessageColumnProps({
    sessionId: "mate-talk",
    character: createCharacter(),
    messages: [{ role: "assistant", text: "こんにちは" }],
    messageListRef,
    isRunning: false,
  });

  assert.deepEqual(messageColumnProps.expandedArtifacts, {});
  assert.equal(messageColumnProps.liveApprovalRequest, null);
  assert.equal(messageColumnProps.approvalActionRequestId, null);
  assert.equal(messageColumnProps.liveElicitationRequest, null);
  assert.equal(messageColumnProps.elicitationActionRequestId, null);
  assert.equal(messageColumnProps.hasLiveRunAssistantText, false);
  assert.equal(messageColumnProps.liveRunErrorMessage, "");
  assert.equal(messageColumnProps.isMessageListFollowing, true);
  assert.equal(messageColumnProps.getChangedFilesEmptyText("artifact-1", false), "");
});

test("createStaticTextConversationMessageColumnProps は text conversation を共通 message column に変換する", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const messageColumnProps = createStaticTextConversationMessageColumnProps({
    sessionId: "mate-talk",
    characterId: "mate",
    characterName: "Mate",
    characterIconPath: "data:image/png;base64,AA==",
    messages: [
      { role: "user", text: "おはよう" },
      { role: "mate", text: "やあ" },
    ],
    messageListRef,
    isRunning: true,
  });

  assert.equal(messageColumnProps.sessionId, "mate-talk");
  assert.equal(messageColumnProps.character.id, "mate");
  assert.equal(messageColumnProps.character.name, "Mate");
  assert.equal(messageColumnProps.character.iconPath, "data:image/png;base64,AA==");
  assert.deepEqual(messageColumnProps.messages, [
    { role: "user", text: "おはよう" },
    { role: "assistant", text: "やあ" },
  ]);
  assert.equal(messageColumnProps.isRunning, true);
});

test("buildLiveSessionMessageColumnProps は live message props を共通形式で組み立てる", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const composerMessageColumnProps = buildLiveSessionMessageColumnProps({
    sessionId: "session-id",
    character: createCharacter(),
    messages: [{ role: "assistant", text: "こんにちは" }],
    expandedArtifacts: {},
    messageListRef,
    isRunning: false,
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "",
    hasLiveRunAssistantText: false,
    liveRunErrorMessage: "",
    isMessageListFollowing: true,
    onMessageListScroll: () => {},
    onToggleArtifact: () => {},
    onLoadArtifactDetail: async () => null,
    onOpenDiff: () => {},
    onResolveLiveApproval: () => {},
    onResolveLiveElicitation: () => {},
    onOpenPath: () => {},
    getChangedFilesEmptyText: () => "",
  });

  assert.equal(composerMessageColumnProps.sessionId, "session-id");
  assert.equal(composerMessageColumnProps.liveRunAssistantText, "");
  assert.equal(composerMessageColumnProps.hasLiveRunAssistantText, false);
});

test("buildLiveSessionComposerProps は composer の表示デフォルトを反映する", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = buildLiveSessionComposerProps({
    retryBanner: null,
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: false,
    showCustomAgentPicker: true,
    showSkillPicker: true,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 0,
    canCollapseActionDock: false,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    isSkillListLoading: false,
    customAgentItems: [],
    skillItems: [],
    attachmentItems: [],
    additionalDirectoryItems: [],
    workspacePathMatchItems: [],
    draft: "",
    composerTextareaRef,
    isComposerDisabled: false,
    isSendDisabled: true,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    sendButtonTitle: undefined,
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: "never", label: "never" }],
    selectedApprovalMode: "never",
    sandboxOptions: [],
    selectedCodexSandboxMode: "workspace-write",
    modelOptions: [{ value: "gpt-test", label: "GPT Test" }],
    selectedModel: "gpt-test",
    selectedModelFallbackLabel: "GPT Test",
    reasoningOptions: [{ value: "low", label: "low" }],
    selectedReasoningEffort: "low",
    onPickFile: () => {},
    onPickFolder: () => {},
    onPickImage: () => {},
    onToggleAgentPicker: () => {},
    onToggleSkillPicker: () => {},
    onAddAdditionalDirectory: () => {},
    onToggleAdditionalDirectoryList: () => {},
    onCollapse: () => {},
    onJumpToBottom: () => {},
    onSelectCustomAgent: () => {},
    onSelectSkill: () => {},
    onRemoveAttachment: () => {},
    onRemoveAdditionalDirectory: () => {},
    onDraftChange: () => {},
    onDraftFocus: () => {},
    onDraftKeyDown: () => {},
    onDraftSelect: () => {},
    onDraftCompositionStart: () => {},
    onDraftCompositionEnd: () => {},
    onSendOrCancel: () => {},
    onSelectWorkspacePathMatch: () => {},
    onActivateWorkspacePathMatch: () => {},
    onChangeApprovalMode: () => {},
    onChangeCodexSandboxMode: () => {},
    onChangeModel: () => {},
    onChangeReasoningEffort: () => {},
  });

  assert.equal(composerProps.showAttachmentControls, true);
  assert.equal(composerProps.showAdditionalDirectoryControls, true);
  assert.equal(composerProps.showExecutionModeControls, true);
});

test("buildLiveSessionSplitterProps は context rail resize state を反映する", () => {
  const onPointerDown = () => {};
  const splitterProps = buildLiveSessionSplitterProps({
    isContextRailResizing: true,
    onStartContextRailResize: onPointerDown,
  });

  assert.equal(splitterProps.isActive, true);
  assert.equal(splitterProps.onPointerDown, onPointerDown);
});

test("createStaticChatCharacterProfile は静的 chat 用 CharacterProfile 既定値を補う", () => {
  const character = createStaticChatCharacterProfile({
    id: "static-chat",
    name: "Static Mate",
  });

  assert.equal(character.id, "static-chat");
  assert.equal(character.name, "Static Mate");
  assert.equal(character.iconPath, "");
  assert.equal(character.description, "");
  assert.equal(character.roleMarkdown, "");
  assert.equal(character.notesMarkdown, "");
  assert.equal(character.updatedAt, "");
  assert.equal(character.themeColors.main, "#6f8cff");
  assert.equal(character.themeColors.sub, "#6fb8c7");
  assert.deepEqual(character.sessionCopy.pendingResponding, ["応答を生成中"]);
});

test("toConversationMessages は user 以外を assistant として共通 message に変換する", () => {
  assert.deepEqual(
    toConversationMessages([
      { role: "user", text: "おはよう" },
      { role: "mate", text: "やあ" },
    ]),
    [
      { role: "user", text: "おはよう" },
      { role: "assistant", text: "やあ" },
    ],
  );
});

test("createHiddenControlsChatComposerProps は composer の非対応操作を隠す", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsChatComposerProps({
    draft: "おはよう",
    composerTextareaRef,
    isComposerDisabled: false,
    isSendDisabled: false,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
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
  });

  assert.equal(composerProps.showAttachmentControls, false);
  assert.equal(composerProps.showCustomAgentPicker, false);
  assert.equal(composerProps.showSkillPicker, false);
  assert.equal(composerProps.showAdditionalDirectoryControls, false);
  assert.equal(composerProps.showExecutionModeControls, false);
  assert.equal(composerProps.canSelectCustomAgent, false);
  assert.deepEqual(composerProps.customAgentItems, []);
  assert.deepEqual(composerProps.skillItems, []);
  assert.deepEqual(composerProps.attachmentItems, []);
  assert.deepEqual(composerProps.additionalDirectoryItems, []);
  assert.deepEqual(composerProps.workspacePathMatchItems, []);
  assert.equal(composerProps.selectedCustomAgentLabel, "Agent");
});

test("createHiddenControlsTextChatComposerProps は text chat 用の送信可否と feedback を補う", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "おはよう",
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isRunning: false,
    feedback: "準備できています",
    sendButtonTitleWhenEnabled: "メッセージを送信",
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
  });

  assert.equal(composerProps.composerBlocked, false);
  assert.equal(composerProps.isRunning, false);
  assert.equal(composerProps.isComposerDisabled, false);
  assert.equal(composerProps.isSendDisabled, false);
  assert.equal(composerProps.placeholder, "今日はどうする？");
  assert.equal(composerProps.sendButtonTitle, "メッセージを送信");
  assert.deepEqual(composerProps.composerSendability, {
    primaryFeedback: "準備できています",
    secondaryFeedback: [],
    feedbackTone: "helper",
    shouldShowFeedback: true,
  });
});

test("createHiddenControlsTextChatComposerProps は running 中も cancel 表示へ切り替えない", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "おはよう",
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isRunning: true,
    feedback: "",
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
  });

  assert.equal(composerProps.isRunning, false);
  assert.equal(composerProps.composerBlocked, true);
  assert.equal(composerProps.isComposerDisabled, true);
  assert.equal(composerProps.isSendDisabled, true);
});

test("createHiddenControlsTextChatComposerProps は必要な共通操作だけを再表示できる", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = createHiddenControlsTextChatComposerProps({
    draft: "おはよう",
    placeholder: "今日はどうする？",
    composerTextareaRef,
    isRunning: false,
    feedback: "",
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
    showAttachmentControls: true,
    showAdditionalDirectoryControls: true,
    showExecutionModeControls: true,
    approvalOptions: [{ value: "untrusted", label: "untrusted" }],
    selectedApprovalMode: "untrusted",
    sandboxOptions: [{ value: "workspace-write", label: "workspace-write" }],
    selectedCodexSandboxMode: "workspace-write",
  });

  assert.equal(composerProps.showAttachmentControls, true);
  assert.equal(composerProps.showAdditionalDirectoryControls, true);
  assert.equal(composerProps.showExecutionModeControls, true);
  assert.equal(composerProps.showCustomAgentPicker, false);
  assert.equal(composerProps.showSkillPicker, false);
  assert.equal(composerProps.approvalOptions[0]?.value, "untrusted");
  assert.equal(composerProps.sandboxOptions[0]?.value, "workspace-write");
});

test("static chat sendability helper は running と空白 draft を送信不可にする", () => {
  assert.equal(isStaticChatSendDisabled({ draft: "こんにちは", isRunning: false }), false);
  assert.equal(isStaticChatSendDisabled({ draft: "   ", isRunning: false }), true);
  assert.equal(isStaticChatSendDisabled({ draft: "こんにちは", isRunning: true }), true);

  assert.deepEqual(createStaticChatComposerSendability("入力してから送信してね。"), {
    primaryFeedback: "入力してから送信してね。",
    secondaryFeedback: [],
    feedbackTone: "helper",
    shouldShowFeedback: true,
  });
  assert.deepEqual(createStaticChatComposerSendability(""), {
    primaryFeedback: "",
    secondaryFeedback: [],
    feedbackTone: null,
    shouldShowFeedback: false,
  });
});

test("createStaticChatCompactActionDockProps は静的 compact dock の既定値を補う", () => {
  const compactProps = createStaticChatCompactActionDockProps({
    draft: "  ",
    isRunning: false,
    isSendDisabled: true,
    onSendOrCancel: noop,
  });

  assert.equal(compactProps.actionDockCompactPreview, "下書きなし");
  assert.equal(compactProps.attachmentCount, 0);
  assert.equal(compactProps.showJumpToBottom, false);
});

test("createStaticTextChatCompactActionDockProps は text chat 用の compact dock を補う", () => {
  const compactProps = createStaticTextChatCompactActionDockProps({
    draft: "  ",
    isRunning: true,
    onSendOrCancel: noop,
  });

  assert.equal(compactProps.actionDockCompactPreview, "下書きなし");
  assert.equal(compactProps.isSendDisabled, true);
  assert.equal(compactProps.isRunning, false);
});
