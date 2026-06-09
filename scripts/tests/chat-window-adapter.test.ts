import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildChatPageClassName,
  buildLiveSessionContextPaneProps,
  buildLiveSessionChatBodyProps,
  buildLiveSessionCompactActionDockProps,
  buildLiveSessionComposerDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionMessageColumnProps,
  buildLiveSessionSplitterProps,
  buildStaticTextChatComposerCapabilityProps,
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
  resolveAuxiliaryModeLabel,
  staticTextChatRuntimeComposerCapabilityDefaults,
  toConversationMessages,
} from "../../src/chat/chat-window-adapter.js";
import {
  buildAuxiliaryAwareRuntimeOptionChangeHandler,
} from "../../src/chat/auxiliary-runtime-option-routing.js";
import {
  buildAuxiliaryAwareSendOrCancelHandler,
  buildRunningSessionCancelTarget,
  resolveAuxiliaryAwareSendOrCancelAction,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
  resolveRunningSessionCancelTargetId,
  runRunningSessionCancelOperation,
} from "../../src/chat/send-or-cancel.js";
import type { ChatWindowProps } from "../../src/chat/chat-window.js";
import { buildLiveSessionWindowShellProps } from "../../src/chat/live-session-window-props.js";
import { createSessionFilesActions } from "../../src/chat/session-files-actions.js";

const noop = () => {};

test("createSessionFilesActions は共通の session files action group を描画する", () => {
  const html = renderToStaticMarkup(createSessionFilesActions({
    onOpenExplorer: noop,
    onOpenTerminal: noop,
  }));

  assert.match(html, /title="Open session files directory">Explorer<\/button>/);
  assert.match(html, /title="Open terminal in session files directory">Terminal<\/button>/);
  assert.match(html, /class="drawer-toggle compact secondary"/);
});

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

test("resolveAuxiliaryModeLabel は Auxiliary mode だけ label を返す", () => {
  assert.equal(resolveAuxiliaryModeLabel(true), "Auxiliary");
  assert.equal(resolveAuxiliaryModeLabel(false), undefined);
  assert.equal(resolveAuxiliaryModeLabel(undefined), undefined);
});

test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary が running のときに優先 cancel する", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: true,
    isSelectedSessionRunning: true,
    preferAuxiliarySendOverSelectedCancel: true,
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["cancel-aux"]);
});

test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary running を最優先する", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: true,
      isAuxiliarySessionRunning: true,
      isSelectedSessionRunning: true,
      preferAuxiliarySendOverSelectedCancel: true,
    }),
    "cancel-auxiliary",
  );
});

test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary 優先なら selected cancel より auxiliary send を返す", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: true,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: true,
      preferAuxiliarySendOverSelectedCancel: true,
    }),
    "send-auxiliary",
  );
});

test("resolveAuxiliaryAwareSendOrCancelAction は selected running を auxiliary send より優先できる", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: true,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: true,
    }),
    "cancel-selected",
  );
});

test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary がなく selected running なら selected cancel を返す", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: false,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: true,
    }),
    "cancel-selected",
  );
});

test("resolveAuxiliaryAwareSendOrCancelAction は auxiliary も running selected もなければ selected send を返す", () => {
  assert.equal(
    resolveAuxiliaryAwareSendOrCancelAction({
      shouldSendAuxiliary: false,
      isAuxiliarySessionRunning: false,
      isSelectedSessionRunning: false,
    }),
    "send-selected",
  );
});

test("resolveRunningSessionCancelTargetId は running session の id だけ返す", () => {
  assert.equal(resolveRunningSessionCancelTargetId({ id: "session-1", runState: "running" }), "session-1");
  assert.equal(resolveRunningSessionCancelTargetId({ id: "session-1", runState: "idle" }), null);
  assert.equal(resolveRunningSessionCancelTargetId({ id: "session-1", runState: undefined }), null);
  assert.equal(resolveRunningSessionCancelTargetId(null), null);
});

test("resolveRunningSessionCancelTargetId は UI 側 running 判定を優先できる", () => {
  assert.equal(
    resolveRunningSessionCancelTargetId({ id: "session-1", runState: "idle", isRunning: true }),
    "session-1",
  );
});

test("buildRunningSessionCancelTarget は Companion turnRunning 中の cancel 対象を維持する", () => {
  const target = buildRunningSessionCancelTarget({
    sessionId: "companion-session-1",
    runState: "idle",
    isRunning: true,
  });

  assert.equal(resolveRunningSessionCancelTargetId(target), "companion-session-1");
});

test("buildRunningSessionCancelTarget は runState running の cancel 対象を作る", () => {
  const target = buildRunningSessionCancelTarget({
    sessionId: "session-1",
    runState: "running",
    isRunning: false,
  });

  assert.equal(resolveRunningSessionCancelTargetId(target), "session-1");
});

test("buildRunningSessionCancelTarget は session 未選択なら cancel 対象を作らない", () => {
  assert.equal(
    buildRunningSessionCancelTarget({
      sessionId: null,
      runState: "running",
      isRunning: true,
    }),
    null,
  );
});

test("runRunningSessionCancelOperation は running target の cancel callback を呼ぶ", async () => {
  const calls: string[] = [];
  const didCancel = await runRunningSessionCancelOperation({
    target: buildRunningSessionCancelTarget({
      sessionId: "session-1",
      runState: "idle",
      isRunning: true,
    }),
    cancelRun: (sessionId) => {
      calls.push(sessionId);
    },
  });

  assert.equal(didCancel, true);
  assert.deepEqual(calls, ["session-1"]);
});

test("runRunningSessionCancelOperation は runState running の target も cancel する", async () => {
  const calls: string[] = [];
  const didCancel = await runRunningSessionCancelOperation({
    target: {
      id: "auxiliary-session-1",
      runState: "running",
    },
    cancelRun: (sessionId) => {
      calls.push(sessionId);
    },
  });

  assert.equal(didCancel, true);
  assert.deepEqual(calls, ["auxiliary-session-1"]);
});

test("runRunningSessionCancelOperation は target や cancel callback がなければ no-op", async () => {
  const calls: string[] = [];

  assert.equal(
    await runRunningSessionCancelOperation({
      target: buildRunningSessionCancelTarget({
        sessionId: "session-1",
        runState: "idle",
        isRunning: false,
      }),
      cancelRun: (sessionId) => {
        calls.push(sessionId);
      },
    }),
    false,
  );
  assert.equal(
    await runRunningSessionCancelOperation({
      target: buildRunningSessionCancelTarget({
        sessionId: "session-1",
        runState: "running",
        isRunning: true,
      }),
      cancelRun: null,
    }),
    false,
  );
  assert.deepEqual(calls, []);
});

test("resolveSelectedSessionRunState は session runState を live run より優先する", () => {
  assert.equal(
    resolveSelectedSessionRunState({
      runState: "idle",
      hasLiveRun: true,
    }),
    "idle",
  );
});

test("resolveSelectedSessionRunState は runState 未取得時に live run / turnRunning で running にする", () => {
  assert.equal(
    resolveSelectedSessionRunState({
      runState: null,
      hasLiveRun: true,
    }),
    "running",
  );
  assert.equal(
    resolveSelectedSessionRunState({
      runState: undefined,
      isTurnRunning: true,
    }),
    "running",
  );
});

test("resolveSelectedSessionIsRunning は runState と turnRunning を見る", () => {
  assert.equal(resolveSelectedSessionIsRunning({ runState: "running" }), true);
  assert.equal(resolveSelectedSessionIsRunning({ runState: "idle", isTurnRunning: true }), true);
  assert.equal(resolveSelectedSessionIsRunning({ runState: "idle" }), false);
});

test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary 優先なら selected running より auxiliary send を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: true,
    preferAuxiliarySendOverSelectedCancel: true,
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["send-aux"]);
});

test("buildAuxiliaryAwareSendOrCancelHandler は selected running 優先なら auxiliary send より selected cancel を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: true,
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["cancel-main"]);
});

test("buildAuxiliaryAwareSendOrCancelHandler は selected idle なら auxiliary send を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: true,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: false,
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["send-aux"]);
});

test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary がなく main running のとき main cancel を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: false,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: true,
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["cancel-main"]);
});

test("buildAuxiliaryAwareSendOrCancelHandler は auxiliary/main どちらもないとき main send を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareSendOrCancelHandler({
    shouldSendAuxiliary: false,
    isAuxiliarySessionRunning: false,
    isSelectedSessionRunning: false,
    onCancelAuxiliaryRun: () => {
      calls.push("cancel-aux");
    },
    onSendAuxiliary: () => {
      calls.push("send-aux");
    },
    onCancelSelectedSessionRun: () => {
      calls.push("cancel-main");
    },
    onSendSelectedSession: () => {
      calls.push("send-main");
    },
  });

  handler();
  assert.deepEqual(calls, ["send-main"]);
});

test("buildAuxiliaryAwareRuntimeOptionChangeHandler は auxiliary があるとき auxiliary handler を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
    shouldUseAuxiliary: true,
    onAuxiliaryChange: (value) => {
      calls.push(`aux:${value}`);
    },
    onSelectedSessionChange: (value) => {
      calls.push(`main:${value}`);
    },
  });

  handler("codex-4");
  assert.deepEqual(calls, ["aux:codex-4"]);
});

test("buildAuxiliaryAwareRuntimeOptionChangeHandler は auxiliary がないとき main handler を使う", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
    shouldUseAuxiliary: false,
    onAuxiliaryChange: (value) => {
      calls.push(`aux:${value}`);
    },
    onSelectedSessionChange: (value) => {
      calls.push(`main:${value}`);
    },
  });

  handler("codex-4");
  assert.deepEqual(calls, ["main:codex-4"]);
});

test("buildAuxiliaryAwareRuntimeOptionChangeHandler は reasoningEffort 型も generic で扱える", () => {
  const calls: string[] = [];
  const handler = buildAuxiliaryAwareRuntimeOptionChangeHandler<"low" | "medium" | "high">({
    shouldUseAuxiliary: true,
    onAuxiliaryChange: (value) => {
      calls.push(`aux:${value}`);
    },
    onSelectedSessionChange: (value) => {
      calls.push(`main:${value}`);
    },
  });

  handler("high");
  assert.deepEqual(calls, ["aux:high"]);
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
  const onCopyMessageText = () => {};
  const onQuoteMessageText = () => {};
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
    onCopyMessageText,
    onQuoteMessageText,
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
  assert.equal(messageColumnProps.onCopyMessageText, onCopyMessageText);
  assert.equal(messageColumnProps.onQuoteMessageText, onQuoteMessageText);
});

test("buildLiveSessionMessageColumnProps は live message props を共通形式で組み立てる", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const onCopyMessageText = () => {};
  const onQuoteMessageText = () => {};
  const messageColumnInput = {
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
    liveRunAssistantText: "生成中",
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
    onCopyMessageText,
    onQuoteMessageText,
  };
  const composerMessageColumnProps = buildLiveSessionMessageColumnProps(messageColumnInput);
  const explicitEmptyMessageColumnProps = buildLiveSessionMessageColumnProps({
    ...messageColumnInput,
    hasLiveRunAssistantText: false,
  });

  assert.equal(composerMessageColumnProps.sessionId, "session-id");
  assert.equal(composerMessageColumnProps.liveRunAssistantText, "生成中");
  assert.equal(composerMessageColumnProps.hasLiveRunAssistantText, true);
  assert.equal(explicitEmptyMessageColumnProps.hasLiveRunAssistantText, false);
  assert.equal(composerMessageColumnProps.onCopyMessageText, onCopyMessageText);
  assert.equal(composerMessageColumnProps.onQuoteMessageText, onQuoteMessageText);
});

test("buildLiveSessionComposerProps は composer の表示デフォルトを反映する", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const composerProps = buildLiveSessionComposerProps({
    retryBanner: null,
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: false,
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
  assert.equal(composerProps.showCustomAgentPicker, true);
  assert.equal(composerProps.showSkillPicker, true);
});

test("buildStaticTextChatComposerCapabilityProps は静的 chat の controls を既定で隠す", () => {
  const composerProps = buildStaticTextChatComposerCapabilityProps();

  assert.equal(composerProps.showAttachmentControls, false);
  assert.equal(composerProps.showAdditionalDirectoryControls, false);
  assert.equal(composerProps.showExecutionModeControls, false);
  assert.equal(composerProps.showCustomAgentPicker, false);
  assert.equal(composerProps.showSkillPicker, false);
});

test("staticTextChatRuntimeComposerCapabilityDefaults は runtime controls だけを表示する", () => {
  assert.equal(staticTextChatRuntimeComposerCapabilityDefaults.showAttachmentControls, true);
  assert.equal(staticTextChatRuntimeComposerCapabilityDefaults.showAdditionalDirectoryControls, true);
  assert.equal(staticTextChatRuntimeComposerCapabilityDefaults.showExecutionModeControls, true);
  assert.equal(staticTextChatRuntimeComposerCapabilityDefaults.showCustomAgentPicker, false);
  assert.equal(staticTextChatRuntimeComposerCapabilityDefaults.showSkillPicker, false);
});

test("buildLiveSessionComposerDockProps は composer と compact dock の共通 props を対応付ける", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const onCollapseActionDock = () => {};
  const onExpandActionDock = () => {};
  const onJumpToBottom = () => {};
  const onSendOrCancel = () => {};
  const props = buildLiveSessionComposerDockProps({
    retryBanner: null,
    isRunning: true,
    pendingRunIndicatorAnnouncement: "実行中",
    pendingRunIndicatorText: "応答を生成中",
    modeLabel: "Auxiliary",
    composerBlocked: false,
    canSelectCustomAgent: true,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 2,
    canCollapseActionDock: true,
    isMessageListFollowing: false,
    isCustomAgentListLoading: false,
    isSkillListLoading: false,
    customAgentItems: [],
    skillItems: [],
    attachmentItems: [],
    additionalDirectoryItems: [],
    workspacePathMatchItems: [],
    draft: "draft",
    composerTextareaRef,
    isComposerDisabled: false,
    isSendDisabled: false,
    composerSendability: {
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
    },
    sendButtonTitle: "Stop",
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
    actionDockCompactPreview: "preview",
    attachmentCount: 1,
    onPickFile: () => {},
    onPickFolder: () => {},
    onPickImage: () => {},
    onToggleAgentPicker: () => {},
    onToggleSkillPicker: () => {},
    onAddAdditionalDirectory: () => {},
    onToggleAdditionalDirectoryList: () => {},
    onCollapseActionDock,
    onExpandActionDock,
    onJumpToBottom,
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
    onSendOrCancel,
    onSelectWorkspacePathMatch: () => {},
    onActivateWorkspacePathMatch: () => {},
    onChangeApprovalMode: () => {},
    onChangeCodexSandboxMode: () => {},
    onChangeModel: () => {},
    onChangeReasoningEffort: () => {},
  });

  assert.equal(props.composer.showJumpToBottom, true);
  assert.equal(props.composer.onCollapse, onCollapseActionDock);
  assert.equal(props.compactActionDock.draft, "draft");
  assert.equal(props.compactActionDock.actionDockCompactPreview, "preview");
  assert.equal(props.compactActionDock.attachmentCount, 1);
  assert.equal(props.compactActionDock.modeLabel, "Auxiliary");
  assert.equal(props.compactActionDock.showJumpToBottom, true);
  assert.equal(props.compactActionDock.sendButtonTitle, "Stop");
  assert.equal(props.compactActionDock.onExpand, onExpandActionDock);
  assert.equal(props.compactActionDock.onJumpToBottom, onJumpToBottom);
  assert.equal(props.compactActionDock.onSendOrCancel, onSendOrCancel);
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

test("buildLiveSessionWindowShellProps は mode と auxiliary class を含む shell を組み立てる", () => {
  const headerProps = createStaticChatHeaderProps({
    taskTitle: "agent session",
    isRunning: false,
    onToggleExpanded: noop,
  });
  const messageColumnProps = createIdleChatMessageColumnProps({
    sessionId: "session-id",
    character: createCharacter(),
    messages: [],
    messageListRef: React.createRef<HTMLDivElement>(),
    isRunning: false,
  });
  const composerProps = createHiddenControlsChatComposerProps({
    draft: "",
    composerTextareaRef: React.createRef<HTMLTextAreaElement>(),
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
  });
  const compactActionDockProps = createStaticChatCompactActionDockProps({
    draft: "",
    isRunning: false,
    isSendDisabled: true,
    onSendOrCancel: noop,
  });
  const rightPaneProps = buildLiveSessionContextPaneProps({
    taskTitle: "Right pane",
    isHeaderExpanded: false,
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      latestCommand: { state: "empty", tone: "muted", label: "No command" },
      tasks: { state: "empty", tone: "muted", label: "No tasks" },
      reasoning: { state: "empty", tone: "muted", label: "No reasoning" },
      context: { state: "empty", tone: "muted", label: "No context" },
      companion: { state: "empty", tone: "muted", label: "No companion" },
    },
    latestCommandView: null,
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
    selectedSessionContextTelemetryProjection: null,
    contextEmptyText: "context empty",
    latestCommandEmptyText: "latest command empty",
    onToggleHeaderExpanded: noop,
    onCycleContextPaneTab: noop,
    onOpenCompanionReview: noop,
  });

  const agentProps = buildLiveSessionWindowShellProps({
    mode: "agent",
    isHeaderExpanded: false,
    workbenchRef: React.createRef<HTMLDivElement>(),
    headerProps,
    messageColumnProps,
    isActionDockExpanded: true,
    composerProps,
    compactActionDockProps,
    splitterProps: {
      isActive: false,
      onPointerDown: noop,
    },
    rightPaneProps,
    modals: React.createElement("div"),
  });
  const companionProps = buildLiveSessionWindowShellProps({
    mode: "companion",
    baseClassName: "theme-accent",
    isHeaderExpanded: false,
    workbenchRef: React.createRef<HTMLDivElement>(),
    headerProps,
    messageColumnProps,
    isActionDockExpanded: true,
    composerProps,
    compactActionDockProps,
    splitterProps: {
      isActive: false,
      onPointerDown: noop,
    },
    rightPaneProps,
    modals: React.createElement("div"),
    isAuxiliaryMode: true,
  });

  const rightPane = agentProps.rightPane as React.ReactElement<{
    children: React.ReactElement;
  }>;

  assert.equal(agentProps.mode, "agent");
  assert.equal(agentProps.className, "session-page-header-collapsed");
  assert.equal(companionProps.className, "theme-accent session-page-header-collapsed auxiliary-session-mode");
  assert.equal(rightPane.props.children.props.taskTitle, "Right pane");
  assert.equal(rightPane.type, companionProps.rightPane.type);
});

test("buildLiveSessionChatBodyProps は live session body props をまとめて組み立てる", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const onPointerDown = () => {};
  const onSendOrCancel = () => {};
  const bodyProps = buildLiveSessionChatBodyProps({
    messageColumn: {
      sessionId: "session-id",
      character: createCharacter(),
      messages: [{ role: "assistant", text: "こんにちは" }],
      expandedArtifacts: {},
      messageListRef,
      isRunning: true,
      liveApprovalRequest: null,
      approvalActionRequestId: null,
      liveElicitationRequest: null,
      elicitationActionRequestId: null,
      liveRunAssistantText: "",
      hasLiveRunAssistantText: false,
      liveRunErrorMessage: "",
      pendingMessageText: "応答を待っています",
      isMessageListFollowing: false,
      onMessageListScroll: () => {},
      onToggleArtifact: () => {},
      onLoadArtifactDetail: async () => null,
      onOpenDiff: () => {},
      onResolveLiveApproval: () => {},
      onResolveLiveElicitation: () => {},
      onOpenPath: () => {},
      getChangedFilesEmptyText: () => "",
    },
    composer: {
      retryBanner: null,
      isRunning: true,
      pendingRunIndicatorAnnouncement: "実行中",
      pendingRunIndicatorText: "応答を生成中",
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
      canCollapseActionDock: true,
      showJumpToBottom: true,
      isCustomAgentListLoading: false,
      isSkillListLoading: false,
      customAgentItems: [],
      skillItems: [],
      attachmentItems: [],
      additionalDirectoryItems: [],
      workspacePathMatchItems: [],
      draft: "draft",
      composerTextareaRef,
      isComposerDisabled: false,
      isSendDisabled: true,
      composerSendability: {
        primaryFeedback: "",
        secondaryFeedback: [],
        feedbackTone: null,
        shouldShowFeedback: false,
      },
      sendButtonTitle: "Send",
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
      onSendOrCancel,
      onSelectWorkspacePathMatch: () => {},
      onActivateWorkspacePathMatch: () => {},
      onChangeApprovalMode: () => {},
      onChangeCodexSandboxMode: () => {},
      onChangeModel: () => {},
      onChangeReasoningEffort: () => {},
    },
    compactActionDock: {
      draft: "draft",
      actionDockCompactPreview: "preview",
      attachmentCount: 1,
      isRunning: true,
      pendingRunIndicatorAnnouncement: "実行中",
      pendingRunIndicatorText: "応答を生成中",
      isSendDisabled: true,
      showJumpToBottom: true,
      sendButtonTitle: "Send",
      onExpand: () => {},
      onJumpToBottom: () => {},
      onSendOrCancel,
    },
    splitter: {
      isContextRailResizing: true,
      onStartContextRailResize: onPointerDown,
    },
  });

  assert.equal(bodyProps.messageColumnProps.sessionId, "session-id");
  assert.equal(bodyProps.messageColumnProps.pendingMessageText, "応答を待っています");
  assert.equal(bodyProps.composerProps.showAttachmentControls, true);
  assert.equal(bodyProps.composerProps.showAdditionalDirectoryControls, true);
  assert.equal(bodyProps.compactActionDockProps.onSendOrCancel, onSendOrCancel);
  assert.equal(bodyProps.splitterProps.isActive, true);
  assert.equal(bodyProps.splitterProps.onPointerDown, onPointerDown);
});

test("buildLiveSessionContextPaneProps は right pane props を共通形式で保持する", () => {
  const onToggleHeaderExpanded = () => {};
  const onCycleContextPaneTab = () => {};
  const onOpenCompanionReview = () => {};
  const props = buildLiveSessionContextPaneProps({
    taskTitle: "Right pane",
    isHeaderExpanded: true,
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      latestCommand: { state: "empty", tone: "muted", label: "No command" },
      tasks: { state: "empty", tone: "muted", label: "No tasks" },
      reasoning: { state: "empty", tone: "muted", label: "No reasoning" },
      context: { state: "empty", tone: "muted", label: "No context" },
      companion: { state: "empty", tone: "muted", label: "No companion" },
    },
    latestCommandView: null,
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
    selectedSessionContextTelemetryProjection: null,
    contextEmptyText: "context empty",
    latestCommandEmptyText: "latest command empty",
    onToggleHeaderExpanded,
    onCycleContextPaneTab,
    onOpenCompanionReview,
  });

  assert.equal(props.taskTitle, "Right pane");
  assert.equal(props.contextEmptyText, "context empty");
  assert.equal(props.latestCommandEmptyText, "latest command empty");
  assert.equal(props.onToggleHeaderExpanded, onToggleHeaderExpanded);
  assert.equal(props.onCycleContextPaneTab, onCycleContextPaneTab);
  assert.equal(props.onOpenCompanionReview, onOpenCompanionReview);
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
