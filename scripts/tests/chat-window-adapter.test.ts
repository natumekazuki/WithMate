import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import {
  createHiddenControlsChatComposerProps,
  createIdleChatMessageColumnProps,
  createStaticChatCompactActionDockProps,
  createStaticChatHeaderProps,
} from "../../src/chat/chat-window-adapter.js";
import type { ChatWindowProps } from "../../src/chat/chat-window.js";

const noop = () => {};

function createCharacter(): ChatWindowProps["messageColumnProps"]["character"] {
  return {
    id: "mate",
    name: "Mate",
    iconPath: "",
    description: "",
    roleMarkdown: "",
    notesMarkdown: "",
    updatedAt: "",
    themeColors: {
      background: "#ffffff",
      text: "#111111",
      accent: "#3366ff",
    },
    sessionCopy: {
      newSessionTitle: "",
      inputPlaceholder: "",
      emptyStateTitle: "",
      emptyStateDescription: "",
      emptyStateAction: "",
      runningStatusLabel: "",
      completedStatusLabel: "",
      failedStatusLabel: "",
    },
  };
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
    pendingRunIndicatorAnnouncement: "返信待ち",
    pendingRunIndicatorText: "返信準備中",
  });

  assert.deepEqual(messageColumnProps.expandedArtifacts, {});
  assert.equal(messageColumnProps.liveApprovalRequest, null);
  assert.equal(messageColumnProps.approvalActionRequestId, null);
  assert.equal(messageColumnProps.liveElicitationRequest, null);
  assert.equal(messageColumnProps.elicitationActionRequestId, null);
  assert.equal(messageColumnProps.hasLiveRunAssistantText, false);
  assert.equal(messageColumnProps.liveRunErrorMessage, "");
  assert.equal(messageColumnProps.isMessageListFollowing, true);
  assert.equal(messageColumnProps.getChangedFilesEmptyText(), "");
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
