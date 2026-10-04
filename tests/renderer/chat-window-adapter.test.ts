import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildLiveSessionContextPaneProps,
  buildLiveSessionCompactActionDockProps,
  buildLiveSessionComposerDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionMessageColumnProps,
  buildLiveSessionSplitterProps,
  buildStaticTextChatComposerCapabilityProps,
  createStaticChatCharacterProfile,
  createStaticChatComposerSendability,
  createHiddenControlsTextChatComposerProps,
  createIdleChatMessageColumnProps,
  createStaticChatCompactActionDockProps,
  createStaticChatHeaderProps,
  createStaticTextChatCompactActionDockProps,
  isStaticChatSendDisabled,
  staticTextChatRuntimeComposerCapabilityDefaults,
  toConversationMessages,
} from "../../src/chat/chat-window-adapter.js";
import {
  buildAuxiliaryAwareRuntimeOptionChangeHandler,
} from "../../src/chat/auxiliary-runtime-option-routing.js";
import {
  buildAuxiliaryAwareSendOrCancelHandler,
  buildAuxiliarySessionCancelTarget,
  buildRunningSessionCancelTarget,
  resolveAuxiliaryAwareSendOrCancelAction,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
  resolveRunningSessionCancelTargetId,
  runRunningSessionCancelOperation,
} from "../../src/chat/send-or-cancel.js";
import { ChatWindow, type ChatWindowProps } from "../../src/chat/chat-window.js";
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

test("buildAuxiliarySessionCancelTarget は active Auxiliary session から cancel 対象を作る", () => {
  const target = buildAuxiliarySessionCancelTarget({
    session: { id: "auxiliary-session-1", runState: "running" },
  });

  assert.equal(resolveRunningSessionCancelTargetId(target), "auxiliary-session-1");
});

test("buildAuxiliarySessionCancelTarget は idle や未選択の Auxiliary session では cancel 対象を作らない", () => {
  assert.equal(
    resolveRunningSessionCancelTargetId(
      buildAuxiliarySessionCancelTarget({
        session: { id: "auxiliary-session-1", runState: "idle" },
      }),
    ),
    null,
  );
  assert.equal(buildAuxiliarySessionCancelTarget({ session: null }), null);
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
  });

  assert.equal(headerProps.taskTitle, "メイトーク");
  assert.equal(headerProps.titleDraft, "メイトーク");
  assert.equal(headerProps.isEditingTitle, false);
  assert.equal(headerProps.showRenameButton, false);
  assert.equal(headerProps.showAuditLogButton, false);
  assert.equal(headerProps.showTerminalButton, false);
  assert.equal(headerProps.showDeleteButton, false);
});

// @test-value v2
// kind = "invariant"
// claim = "live session message column projection が bookmark toggle callback を共通propsへ保持する"
// oracle = { type = "contract", ref = "docs/features/message-bookmark-filter.md: UI仕様" }
// fault = "buildLiveSessionMessageColumnProps が入力された onToggleMessageBookmark を返却propsから落とす"
// observable = "返却された message column props の onToggleMessageBookmark"
// observation_boundary = "component-behavior"
// scope = "chat-window-adapter-message-bookmark"
// lifecycle = "permanent"
// distinction = "TypeScript の optional property 検査では検出できない adapter のcallback転送漏れを直接確認する"
// @end-test-value
test("buildLiveSessionMessageColumnProps は live message props を共通形式で組み立てる", () => {
  const messageListRef = React.createRef<HTMLDivElement>();
  const onCopyMessageText = () => {};
  const onQuoteMessageText = () => {};
  const onToggleMessageBookmark = () => {};
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
    pendingMessageText: "Preparing a response",
    pendingMessageTextVisible: false,
    liveRunErrorMessage: "",
    isMessageListFollowing: true,
    onMessageListScroll: () => {},
    onToggleArtifact: () => {},
    onLoadArtifactDetail: async () => null,
    onOpenDiff: () => {},
    onResolveLiveApproval: () => {},
    onResolveLiveElicitation: () => {},
    onOpenPath: () => {},
    onCopyMessageText,
    onQuoteMessageText,
    onToggleMessageBookmark,
  } satisfies Parameters<typeof buildLiveSessionMessageColumnProps>[0];
  const composerMessageColumnProps = buildLiveSessionMessageColumnProps(messageColumnInput);
  const explicitEmptyMessageColumnProps = buildLiveSessionMessageColumnProps({
    ...messageColumnInput,
    hasLiveRunAssistantText: false,
  });

  assert.equal(composerMessageColumnProps.sessionId, "session-id");
  assert.equal(composerMessageColumnProps.liveRunAssistantText, "生成中");
  assert.equal(composerMessageColumnProps.hasLiveRunAssistantText, true);
  assert.equal(composerMessageColumnProps.pendingMessageText, "Preparing a response");
  assert.equal(composerMessageColumnProps.pendingMessageTextVisible, false);
  assert.equal(explicitEmptyMessageColumnProps.hasLiveRunAssistantText, false);
  assert.equal(composerMessageColumnProps.onCopyMessageText, onCopyMessageText);
  assert.equal(composerMessageColumnProps.onQuoteMessageText, onQuoteMessageText);
  assert.equal(composerMessageColumnProps.onToggleMessageBookmark, onToggleMessageBookmark);
});

// @test-value v2
// kind = "contract"
// claim = "live session composer adapterはownerが指定した操作capabilityを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#ui-implementation-boundary: provider差分はcapabilityとして注入する" }
// fault = "明示された操作capabilityを共通既定値で上書きし、非対応操作を表示または対応操作を隠す"
// observable = "enabled/disabledそれぞれの入力に対する返却composer propsの5表示flag"
// observation_boundary = "component-behavior"
// scope = "chat-window-adapter.live-composer"
// lifecycle = "permanent"
// distinction = "adapterの表示capability projectionをDOMではなく共通props値で確認する"
// @end-test-value
test("buildLiveSessionComposerProps は owner の操作capabilityを保持する", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const input: Parameters<typeof buildLiveSessionComposerProps>[0] = {
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: false,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 0,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    customAgentItems: [],
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
    reviewerOptions: [],
    selectedCodexReviewer: "user",
    speedOptions: [],
    selectedCodexSpeed: "standard",
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
    onJumpToBottom: () => {},
    onSelectCustomAgent: () => {},
    onDraftChange: () => {},
    onDraftFocus: () => {},
    onDraftKeyDown: () => {},
    onDraftSelect: () => {},
    onDraftCompositionStart: () => {},
    onDraftCompositionEnd: () => {},
    onSendOrCancel: () => {},
    onChangeApprovalMode: () => {},
    onChangeCodexReviewer: () => {},
    onChangeCodexSpeed: () => {},
    onChangeCodexSandboxMode: () => {},
    onChangeModel: () => {},
    onChangeReasoningEffort: () => {},
  };

  for (const enabled of [false, true]) {
    const composerProps = buildLiveSessionComposerProps({
      ...input,
      showAttachmentControls: enabled,
      showAdditionalDirectoryControls: enabled,
      showExecutionModeControls: enabled,
      showCustomAgentPicker: enabled,
      showSkillPicker: enabled,
    });
    assert.equal(composerProps.showAttachmentControls, enabled);
    assert.equal(composerProps.showAdditionalDirectoryControls, enabled);
    assert.equal(composerProps.showExecutionModeControls, enabled);
    assert.equal(composerProps.showCustomAgentPicker, enabled);
    assert.equal(composerProps.showSkillPicker, enabled);
  }
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

// @test-value v2
// kind = "contract"
// claim = "buildLiveSessionComposerDockPropsはcomposerとcompact ActionDockへ共通のjump・send・cancel情報を投影する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action Dock" }
// fault = "composerとcompact ActionDockで末尾移動、送信・cancel、noticeのpropsが不一致になる"
// observable = "composer.showJumpToBottom/chatNoticeとcompactActionDockのshowJumpToBottom・cancelButtonTitle・callback identity"
// observation_boundary = "public-boundary"
// scope = "live-session-composer-dock-adapter"
// lifecycle = "permanent"
// @end-test-value
test("buildLiveSessionComposerDockProps は composer と compact dock の共通 props を対応付ける", () => {
  const composerTextareaRef = React.createRef<HTMLTextAreaElement>();
  const onJumpToBottom = () => {};
  const onSendOrCancel = () => {};
  const onExpandActionDock = () => {};
  const props = buildLiveSessionComposerDockProps({
    isRunning: true,
    chatNotice: "New messages",
    composerBlocked: false,
    canSelectCustomAgent: true,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 2,
    isMessageListFollowing: false,
    isCustomAgentListLoading: false,
    customAgentItems: [],
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
    reviewerOptions: [],
    selectedCodexReviewer: "user",
    speedOptions: [],
    selectedCodexSpeed: "standard",
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
    onExpandActionDock,
    onJumpToBottom,
    onSelectCustomAgent: () => {},
    onDraftChange: () => {},
    onDraftFocus: () => {},
    onDraftKeyDown: () => {},
    onDraftSelect: () => {},
    onDraftCompositionStart: () => {},
    onDraftCompositionEnd: () => {},
    onSendOrCancel,
    onChangeApprovalMode: () => {},
    onChangeCodexReviewer: () => {},
    onChangeCodexSpeed: () => {},
    onChangeCodexSandboxMode: () => {},
    onChangeModel: () => {},
    onChangeReasoningEffort: () => {},
  });

  assert.equal(props.composer.showJumpToBottom, true);
  assert.equal(props.composer.chatNotice, "New messages");
  assert.equal("onCollapse" in props.composer, false);
  assert.equal(props.compactActionDock.chatNotice, "New messages");
  assert.equal(props.compactActionDock.showJumpToBottom, true);
  assert.equal(props.compactActionDock.cancelButtonTitle, "Stop");
  assert.equal(props.compactActionDock.onExpand, onExpandActionDock);
  assert.equal(props.compactActionDock.onJumpToBottom, onJumpToBottom);
  assert.equal(props.compactActionDock.onCancel, onSendOrCancel);
});

test("buildLiveSessionSplitterProps は context rail resize state を反映する", () => {
  const onPointerDown = () => {};
  const onToggle = () => {};
  const splitterProps = buildLiveSessionSplitterProps({
    isContextRailResizing: true,
    isContextRailVisible: true,
    onStartContextRailResize: onPointerDown,
    onToggleContextRailVisibility: onToggle,
  });

  assert.equal(splitterProps.isActive, true);
  assert.equal(splitterProps.isPanelExpanded, true);
  assert.equal(splitterProps.onPointerDown, onPointerDown);
  assert.equal(splitterProps.onTogglePanel, onToggle);
});

// @test-value v2
// kind = "contract"
// claim = "AgentとAuxiliaryのmodeを共通shellへ反映し、右ペインの内容と操作をChatWindowへ渡す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Agent / Auxiliary shared chat screen" }
// fault = "mode classや右ペイン入力が失われ、対応する共通画面を表示できない"
// observable = "shellのclassName、mainContent、rightPanePropsとChatWindow内のLatest Command表示"
// observation_boundary = "component-behavior"
// scope = "live-session-window-shell"
// lifecycle = "permanent"
// @end-test-value
test("buildLiveSessionWindowShellProps は mode と auxiliary class を含む shell を組み立てる", () => {
  const headerProps = createStaticChatHeaderProps({
    taskTitle: "agent session",
    isRunning: false,
  });
  const messageColumnProps = createIdleChatMessageColumnProps({
    sessionId: "session-id",
    character: createCharacter(),
    messages: [],
    messageListRef: React.createRef<HTMLDivElement>(),
    isRunning: false,
  });
  const composerProps = createHiddenControlsTextChatComposerProps({
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
    isRunning: false,
    onCancel: noop,
  });
  const rightPaneProps = buildLiveSessionContextPaneProps({
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      activeTab: "latest-command",
      badgeLabel: "",
      toneClassName: "",
      latestCommandToneClassName: "",
      latestCommandStatusLabel: "",
      latestCommandSourceCopy: "",
      reasoningToneClassName: "",
      tasksToneClassName: "",
    },
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
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
    onCycleContextPaneTab: noop,
  });

  const agentProps = buildLiveSessionWindowShellProps({
    mode: "agent",
    isHeaderExpanded: false,
    workbenchRef: React.createRef<HTMLDivElement>(),
    headerProps,
    messageColumnProps,
    mainContent: React.createElement("div", null, "Preview"),
    isActionDockExpanded: true,
    composerProps,
    compactActionDockProps,
    splitterProps: {
      isActive: false,
      isPanelExpanded: true,
      onPointerDown: noop,
      onTogglePanel: noop,
    },
    skillPickerProps: undefined,
    isRightPaneVisible: true,
    rightPaneProps,
    modals: React.createElement("div"),
  });
  const auxiliaryProps = buildLiveSessionWindowShellProps({
    mode: "agent",
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
      isPanelExpanded: true,
      onPointerDown: noop,
      onTogglePanel: noop,
    },
    skillPickerProps: undefined,
    isRightPaneVisible: true,
    rightPaneProps,
    modals: React.createElement("div"),
    isAuxiliaryMode: true,
  });

  assert.equal(agentProps.mode, "agent");
  assert.equal(agentProps.messageColumnProps.isContentActive, false);
  assert.equal(auxiliaryProps.messageColumnProps.isContentActive, true);
  assert.equal(agentProps.className, "");
  assert.equal(auxiliaryProps.className, "theme-accent auxiliary-session-mode");
  assert.match(renderToStaticMarkup(agentProps.mainContent), /Preview/);
  assert.match(renderToStaticMarkup(React.createElement(ChatWindow, agentProps)), /Latest Command/);
  assert.equal(auxiliaryProps.rightPaneProps, rightPaneProps);
});

// @test-value v2
// kind = "contract"
// claim = "live sessionのright pane propsは共通形式でcallbackと表示文言を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "right paneの表示情報またはtab操作callbackがprojectionから欠落する"
// observable = "生成されたright pane propsの表示文言とtab callback"
// observation_boundary = "public-boundary"
// scope = "live-session-context-pane-props"
// lifecycle = "permanent"
// @end-test-value
test("buildLiveSessionContextPaneProps は right pane props を共通形式で保持する", () => {
  const onCycleContextPaneTab = () => {};
  const props = buildLiveSessionContextPaneProps({
    activeContextPaneTab: "latest-command",
    availableContextPaneTabs: ["latest-command"],
    contextPaneProjection: {
      activeTab: "latest-command",
      badgeLabel: "Running",
      toneClassName: "is-running",
      latestCommandToneClassName: "command-running",
      latestCommandStatusLabel: "Command running",
      latestCommandSourceCopy: "npm test",
      reasoningToneClassName: "",
      tasksToneClassName: "",
    },
    latestCommandView: null,
    runningDetailsEntries: [],
    liveRunReasoningText: "",
    backgroundTasks: [],
    selectedSessionLiveRunErrorMessage: "Command failed",
    isSelectedSessionRunning: true,
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
    onCycleContextPaneTab,
  });

  assert.equal(props.activeContextPaneTab, "latest-command");
  assert.deepEqual(props.availableContextPaneTabs, ["latest-command"]);
  assert.equal(props.contextPaneProjection.activeTab, "latest-command");
  assert.equal(props.contextPaneProjection.badgeLabel, "Running");
  assert.equal(props.contextPaneProjection.latestCommandStatusLabel, "Command running");
  assert.equal(props.contextPaneProjection.latestCommandSourceCopy, "npm test");
  assert.equal(props.selectedSessionLiveRunErrorMessage, "Command failed");
  assert.equal(props.isSelectedSessionRunning, true);
  assert.equal(props.onCycleContextPaneTab, onCycleContextPaneTab);
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

test("createStaticTextChatCompactActionDockProps は text chat 用の compact dock を補う", () => {
  const compactProps = createStaticTextChatCompactActionDockProps({});

  assert.equal(compactProps.isRunning, false);
  assert.equal(typeof compactProps.onCancel, "function");
});
