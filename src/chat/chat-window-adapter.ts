import { DEFAULT_APPROVAL_MODE } from "../approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../codex-sandbox-mode.js";
import { DEFAULT_CODEX_SPEED } from "../codex-speed.js";
import {
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterProfile,
  type Message,
  type MessageArtifact,
} from "../app-state.js";
import {
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject,
  type UIEventHandler,
} from "react";
import type { SessionContextPaneProps } from "../session-components.js";
import type { ChatWindowProps } from "./chat-window.js";

export const chatWindowNoop = () => {};

type ChatHeaderProps = ChatWindowProps["headerProps"];
type ChatMessageColumnProps = ChatWindowProps["messageColumnProps"];
type ChatComposerProps = ChatWindowProps["composerProps"];
type ChatCompactActionDockProps = ChatWindowProps["compactActionDockProps"];

export function resolveAuxiliaryModeLabel(isAuxiliaryMode?: boolean): string | undefined {
  return isAuxiliaryMode ? "Auxiliary" : undefined;
}

type StaticChatCharacterInput = {
  id: string;
  name: string;
} & Partial<Omit<CharacterProfile, "id" | "name">>;

type ChatRoleMessage = {
  role: string;
  text: string;
};

type StaticChatHeaderProps = {
  taskTitle: string;
  titleDraft?: string;
  isRunning: boolean;
} & Partial<Omit<ChatHeaderProps, "taskTitle" | "titleDraft" | "isRunning">>;

type IdleChatMessageColumnProps = Pick<
  ChatMessageColumnProps,
  | "sessionId"
  | "character"
  | "messages"
  | "messageListRef"
  | "isRunning"
> &
  Partial<
    Omit<
      ChatMessageColumnProps,
      | "sessionId"
      | "character"
      | "messages"
      | "messageListRef"
      | "isRunning"
    >
  >;

type HiddenControlsChatComposerProps = Pick<
  ChatComposerProps,
  | "draft"
  | "composerTextareaRef"
  | "isComposerDisabled"
  | "isSendDisabled"
  | "composerSendability"
  | "modelOptions"
  | "selectedModel"
  | "selectedModelFallbackLabel"
  | "reasoningOptions"
  | "selectedReasoningEffort"
  | "onDraftChange"
  | "onDraftKeyDown"
  | "onSendOrCancel"
  | "onChangeModel"
  | "onChangeReasoningEffort"
> &
  Partial<
    Omit<
      ChatComposerProps,
      | "draft"
      | "composerTextareaRef"
      | "isComposerDisabled"
      | "isSendDisabled"
      | "composerSendability"
      | "modelOptions"
      | "selectedModel"
      | "selectedModelFallbackLabel"
      | "reasoningOptions"
      | "selectedReasoningEffort"
      | "onDraftChange"
      | "onDraftKeyDown"
      | "onSendOrCancel"
      | "onChangeModel"
      | "onChangeReasoningEffort"
    >
  >;

type StaticChatCompactActionDockProps = Pick<
  ChatCompactActionDockProps,
  "isRunning" | "onCancel"
> &
  Partial<Omit<ChatCompactActionDockProps, "isRunning" | "onCancel">>;

type StaticTextConversationMessageColumnProps = {
  sessionId: string;
  characterId: string;
  characterName: string;
  characterIconPath?: string;
  messages: ChatRoleMessage[];
  messageListRef: ChatMessageColumnProps["messageListRef"];
  isRunning: boolean;
} & Partial<Omit<IdleChatMessageColumnProps, "sessionId" | "character" | "messages" | "messageListRef" | "isRunning">>;

type HiddenControlsTextChatComposerProps = Pick<
  ChatComposerProps,
  | "draft"
  | "placeholder"
  | "composerTextareaRef"
  | "modelOptions"
  | "selectedModel"
  | "selectedModelFallbackLabel"
  | "reasoningOptions"
  | "selectedReasoningEffort"
  | "onDraftChange"
  | "onDraftKeyDown"
  | "onSendOrCancel"
  | "onChangeModel"
  | "onChangeReasoningEffort"
> & {
  isRunning: boolean;
  feedback: string;
  sendButtonTitleWhenEnabled?: string;
} & Partial<
  Omit<
    ChatComposerProps,
    | "draft"
    | "placeholder"
    | "composerTextareaRef"
    | "modelOptions"
    | "selectedModel"
    | "selectedModelFallbackLabel"
    | "reasoningOptions"
    | "selectedReasoningEffort"
    | "onDraftChange"
    | "onDraftKeyDown"
    | "onSendOrCancel"
    | "onChangeModel"
    | "onChangeReasoningEffort"
  >
>;

type StaticTextChatCompactActionDockProps = {
  pendingRunIndicatorAnnouncement?: ChatCompactActionDockProps["pendingRunIndicatorAnnouncement"];
  pendingRunIndicatorText?: ChatCompactActionDockProps["pendingRunIndicatorText"];
  onExpand?: ChatCompactActionDockProps["onExpand"];
};

export type LiveSessionMessageColumnProps = {
  sessionId: string;
  character: ChatMessageColumnProps["character"];
  messages: Message[];
  messageKeys?: ChatMessageColumnProps["messageKeys"];
  messageGroups?: ChatMessageColumnProps["messageGroups"];
  messageCollapseTargets?: ChatMessageColumnProps["messageCollapseTargets"];
  collapsedMessageKeys?: ChatMessageColumnProps["collapsedMessageKeys"];
  messageJumpRequest?: ChatMessageColumnProps["messageJumpRequest"];
  isContentActive?: ChatMessageColumnProps["isContentActive"];
  onToggleMessageCollapse?: ChatMessageColumnProps["onToggleMessageCollapse"];
  onToggleAllMessageCollapse?: ChatMessageColumnProps["onToggleAllMessageCollapse"];
  expandedArtifacts: Record<string, boolean>;
  messageListRef: RefObject<HTMLDivElement | null>;
  isRunning: boolean;
  liveApprovalRequest: ChatMessageColumnProps["liveApprovalRequest"];
  approvalActionRequestId: ChatMessageColumnProps["approvalActionRequestId"];
  liveElicitationRequest: ChatMessageColumnProps["liveElicitationRequest"];
  elicitationActionRequestId: ChatMessageColumnProps["elicitationActionRequestId"];
  liveRunAssistantText: string;
  hasLiveRunAssistantText?: boolean;
  liveRunErrorMessage: string;
  pendingMessageText?: string;
  pendingMessageGroupId?: ChatMessageColumnProps["pendingMessageGroupId"];
  isMessageListFollowing: boolean;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: ChatMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: ChatMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: ChatMessageColumnProps["onResolveLiveElicitation"];
  onOpenPath: (target: string) => void;
  getChangedFilesEmptyText: ChatMessageColumnProps["getChangedFilesEmptyText"];
  onCopyMessageText?: ChatMessageColumnProps["onCopyMessageText"];
  onQuoteMessageText?: ChatMessageColumnProps["onQuoteMessageText"];
  glossaryAnnotationMatcher?: ChatMessageColumnProps["glossaryAnnotationMatcher"];
  onActivateGlossaryEntry?: ChatMessageColumnProps["onActivateGlossaryEntry"];
};

export type LiveSessionComposerProps = Omit<
  ChatComposerProps,
  | "showAttachmentControls"
  | "showAdditionalDirectoryControls"
  | "showExecutionModeControls"
  | "showCustomAgentPicker"
  | "showSkillPicker"
> & {
  showAttachmentControls?: boolean;
  showAdditionalDirectoryControls?: boolean;
  showExecutionModeControls?: boolean;
  showCustomAgentPicker?: boolean;
  showSkillPicker?: boolean;
};

export type StaticTextChatComposerCapabilityProps = Partial<
  Omit<
    ChatComposerProps,
    | "draft"
    | "placeholder"
    | "composerTextareaRef"
    | "isRunning"
    | "composerBlocked"
    | "isComposerDisabled"
    | "isSendDisabled"
    | "composerSendability"
    | "sendButtonTitle"
    | "modelOptions"
    | "selectedModel"
    | "selectedModelFallbackLabel"
    | "reasoningOptions"
    | "selectedReasoningEffort"
    | "onDraftChange"
    | "onDraftKeyDown"
    | "onSendOrCancel"
    | "onChangeModel"
    | "onChangeReasoningEffort"
  >
>;

const liveSessionComposerCapabilityDefaults = {
  showAttachmentControls: true,
  showAdditionalDirectoryControls: true,
  showExecutionModeControls: true,
  showCustomAgentPicker: true,
  showSkillPicker: true,
} as const;

export const staticTextChatRuntimeComposerCapabilityDefaults = {
  showAttachmentControls: true,
  showAdditionalDirectoryControls: true,
  showExecutionModeControls: true,
  showCustomAgentPicker: false,
  showSkillPicker: false,
} as const;

export type LiveSessionCompactActionDockProps = Omit<ChatCompactActionDockProps, "showJumpToBottom"> & {
  showJumpToBottom: boolean;
};

export type LiveSessionComposerDockPropsInput = Omit<
  LiveSessionComposerProps,
  "showJumpToBottom"
> & {
  attachmentCount: number;
  isMessageListFollowing: boolean;
  onExpandActionDock: () => void;
};

export type LiveSessionSplitterProps = {
  isContextRailResizing: boolean;
  isContextRailVisible: boolean;
  onStartContextRailResize?: PointerEventHandler<HTMLButtonElement>;
  onToggleContextRailVisibility: MouseEventHandler<HTMLButtonElement>;
};

export type LiveSessionChatBodyPropsInput = {
  messageColumn: LiveSessionMessageColumnProps;
  composer: LiveSessionComposerProps;
  compactActionDock: LiveSessionCompactActionDockProps;
  splitter: LiveSessionSplitterProps;
};

export type LiveSessionContextPanePropsInput = SessionContextPaneProps;

export function buildLiveSessionChatBodyProps(input: LiveSessionChatBodyPropsInput): Pick<
  ChatWindowProps,
  "messageColumnProps" | "composerProps" | "compactActionDockProps"
> & {
  splitterProps: ReturnType<typeof buildLiveSessionSplitterProps>;
} {
  return {
    messageColumnProps: buildLiveSessionMessageColumnProps(input.messageColumn),
    composerProps: buildLiveSessionComposerProps(input.composer),
    compactActionDockProps: buildLiveSessionCompactActionDockProps(input.compactActionDock),
    splitterProps: buildLiveSessionSplitterProps(input.splitter),
  };
}

export function buildLiveSessionComposerDockProps(
  input: LiveSessionComposerDockPropsInput,
): {
  composer: LiveSessionComposerProps;
  compactActionDock: LiveSessionCompactActionDockProps;
} {
  const {
    attachmentCount,
    isMessageListFollowing,
    onExpandActionDock,
    ...composerInput
  } = input;
  const showJumpToBottom = !isMessageListFollowing;

  return {
    composer: {
      ...composerInput,
      showJumpToBottom,
    },
    compactActionDock: {
      attachmentCount,
      isRunning: input.isRunning,
      pendingRunIndicatorAnnouncement: input.pendingRunIndicatorAnnouncement,
      pendingRunIndicatorText: input.pendingRunIndicatorText,
      modeLabel: input.modeLabel,
      chatNotice: input.chatNotice,
      showJumpToBottom,
      cancelButtonTitle: input.sendButtonTitle,
      onExpand: onExpandActionDock,
      onJumpToBottom: input.onJumpToBottom,
      onCancel: input.onSendOrCancel,
    },
  };
}

export function buildLiveSessionContextPaneProps(
  input: LiveSessionContextPanePropsInput,
): SessionContextPaneProps {
  return { ...input };
}

export function buildLiveSessionMessageColumnProps(input: LiveSessionMessageColumnProps): ChatMessageColumnProps {
  return {
    sessionId: input.sessionId,
    character: input.character,
    messages: input.messages,
    messageKeys: input.messageKeys,
    messageGroups: input.messageGroups,
    messageCollapseTargets: input.messageCollapseTargets,
    collapsedMessageKeys: input.collapsedMessageKeys,
    messageJumpRequest: input.messageJumpRequest,
    isContentActive: input.isContentActive,
    onToggleMessageCollapse: input.onToggleMessageCollapse,
    onToggleAllMessageCollapse: input.onToggleAllMessageCollapse,
    expandedArtifacts: input.expandedArtifacts,
    messageListRef: input.messageListRef,
    isRunning: input.isRunning,
    liveApprovalRequest: input.liveApprovalRequest,
    approvalActionRequestId: input.approvalActionRequestId,
    liveElicitationRequest: input.liveElicitationRequest,
    elicitationActionRequestId: input.elicitationActionRequestId,
    liveRunAssistantText: input.liveRunAssistantText,
    hasLiveRunAssistantText: input.hasLiveRunAssistantText ?? input.liveRunAssistantText.length > 0,
    liveRunErrorMessage: input.liveRunErrorMessage,
    pendingMessageText: input.pendingMessageText,
    pendingMessageGroupId: input.pendingMessageGroupId,
    isMessageListFollowing: input.isMessageListFollowing,
    onMessageListScroll: input.onMessageListScroll,
    onToggleArtifact: input.onToggleArtifact,
    onLoadArtifactDetail: input.onLoadArtifactDetail,
    onOpenDiff: input.onOpenDiff,
    onResolveLiveApproval: input.onResolveLiveApproval,
    onResolveLiveElicitation: input.onResolveLiveElicitation,
    onOpenPath: input.onOpenPath,
    getChangedFilesEmptyText: input.getChangedFilesEmptyText,
    onCopyMessageText: input.onCopyMessageText,
    onQuoteMessageText: input.onQuoteMessageText,
    glossaryAnnotationMatcher: input.glossaryAnnotationMatcher,
    onActivateGlossaryEntry: input.onActivateGlossaryEntry,
  };
}

export function buildLiveSessionComposerProps(input: LiveSessionComposerProps): ChatComposerProps {
  return {
    ...liveSessionComposerCapabilityDefaults,
    ...input,
  };
}

export function buildStaticTextChatComposerCapabilityProps(
  props: StaticTextChatComposerCapabilityProps = {},
): StaticTextChatComposerCapabilityProps {
  return {
    showAttachmentControls: false,
    showAdditionalDirectoryControls: false,
    showExecutionModeControls: false,
    showCustomAgentPicker: false,
    showSkillPicker: false,
    ...props,
  };
}

export function buildLiveSessionCompactActionDockProps(
  input: LiveSessionCompactActionDockProps,
): ChatCompactActionDockProps {
  return input;
}

export function buildLiveSessionSplitterProps(
  input: LiveSessionSplitterProps,
): {
  isActive: boolean;
  isPanelExpanded: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onTogglePanel: MouseEventHandler<HTMLButtonElement>;
} {
  return {
    isActive: input.isContextRailResizing,
    isPanelExpanded: input.isContextRailVisible,
    onPointerDown: input.isContextRailVisible ? input.onStartContextRailResize : undefined,
    onTogglePanel: input.onToggleContextRailVisibility,
  };
}

export function createStaticChatHeaderProps({
  taskTitle,
  titleDraft = taskTitle,
  isRunning,
  ...props
}: StaticChatHeaderProps): ChatHeaderProps {
  return {
    taskTitle,
    isEditingTitle: false,
    titleDraft,
    isRunning,
    showRenameButton: false,
    showAuditLogButton: false,
    showTerminalButton: false,
    showDeleteButton: false,
    onOpenAuditLog: chatWindowNoop,
    onOpenTerminal: chatWindowNoop,
    onTitleDraftChange: chatWindowNoop,
    onTitleInputKeyDown: chatWindowNoop,
    onSaveTitle: chatWindowNoop,
    onCancelTitleEdit: chatWindowNoop,
    onStartTitleEdit: chatWindowNoop,
    onDeleteSession: chatWindowNoop,
    ...props,
  };
}

export function createStaticChatCharacterProfile({
  id,
  name,
  iconPath = "",
  description = "",
  roleMarkdown = "",
  notesMarkdown = "",
  updatedAt = "",
  themeColors = { ...DEFAULT_CHARACTER_THEME_COLORS },
  sessionCopy = DEFAULT_CHARACTER_SESSION_COPY,
}: StaticChatCharacterInput): CharacterProfile {
  return {
    id,
    name,
    iconPath,
    description,
    roleMarkdown,
    notesMarkdown,
    updatedAt,
    themeColors,
    sessionCopy,
  };
}

export function toConversationMessages(messages: ChatRoleMessage[]): Message[] {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    text: message.text,
  }));
}

export function createIdleChatMessageColumnProps(props: IdleChatMessageColumnProps): ChatMessageColumnProps {
  return {
    expandedArtifacts: {},
    liveApprovalRequest: null,
    approvalActionRequestId: null,
    liveElicitationRequest: null,
    elicitationActionRequestId: null,
    liveRunAssistantText: "",
    hasLiveRunAssistantText: false,
    liveRunErrorMessage: "",
    isMessageListFollowing: true,
    onMessageListScroll: chatWindowNoop,
    onToggleArtifact: chatWindowNoop,
    onOpenDiff: chatWindowNoop,
    onResolveLiveApproval: chatWindowNoop,
    onResolveLiveElicitation: chatWindowNoop,
    getChangedFilesEmptyText: () => "",
    ...props,
  };
}

export function createStaticTextConversationMessageColumnProps({
  sessionId,
  characterId,
  characterName,
  characterIconPath,
  messages,
  messageListRef,
  isRunning,
  ...props
}: StaticTextConversationMessageColumnProps): ChatMessageColumnProps {
  return createIdleChatMessageColumnProps({
    sessionId,
    character: createStaticChatCharacterProfile({ id: characterId, name: characterName, iconPath: characterIconPath }),
    messages: toConversationMessages(messages),
    messageListRef,
    isRunning,
    ...props,
  });
}

export function createHiddenControlsChatComposerProps(props: HiddenControlsChatComposerProps): ChatComposerProps {
  return {
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: false,
    showAttachmentControls: false,
    showCustomAgentPicker: false,
    showSkillPicker: false,
    showAdditionalDirectoryControls: false,
    showExecutionModeControls: false,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isAdditionalDirectoryListOpen: false,
    selectedCustomAgentLabel: "Agent",
    selectedCustomAgentTitle: "",
    additionalDirectoryCount: 0,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    customAgentItems: [],
    attachmentItems: [],
    placeholder: undefined,
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: DEFAULT_APPROVAL_MODE, label: DEFAULT_APPROVAL_MODE }],
    selectedApprovalMode: DEFAULT_APPROVAL_MODE,
    sandboxOptions: [],
    selectedCodexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    speedOptions: [],
    selectedCodexSpeed: DEFAULT_CODEX_SPEED,
    onPickFile: chatWindowNoop,
    onPickFolder: chatWindowNoop,
    onPickImage: chatWindowNoop,
    onToggleAgentPicker: chatWindowNoop,
    onToggleSkillPicker: chatWindowNoop,
    onAddAdditionalDirectory: chatWindowNoop,
    onToggleAdditionalDirectoryList: chatWindowNoop,
    onJumpToBottom: chatWindowNoop,
    onSelectCustomAgent: chatWindowNoop,
    onRemoveAttachment: chatWindowNoop,
    onDraftFocus: chatWindowNoop,
    onDraftSelect: chatWindowNoop,
    onDraftCompositionStart: chatWindowNoop,
    onDraftCompositionEnd: chatWindowNoop,
    onChangeApprovalMode: chatWindowNoop,
    onChangeCodexSandboxMode: chatWindowNoop,
    onChangeCodexSpeed: chatWindowNoop,
    ...props,
  };
}

export function createHiddenControlsTextChatComposerProps({
  draft,
  isRunning,
  feedback,
  sendButtonTitleWhenEnabled,
  ...props
}: HiddenControlsTextChatComposerProps): ChatComposerProps {
  const isSendDisabled = isStaticChatSendDisabled({ draft, isRunning });

  return createHiddenControlsChatComposerProps({
    composerBlocked: isRunning,
    draft,
    isComposerDisabled: isRunning,
    isSendDisabled,
    composerSendability: createStaticChatComposerSendability(feedback),
    sendButtonTitle: isSendDisabled ? undefined : sendButtonTitleWhenEnabled,
    ...props,
  });
}

export function isStaticChatSendDisabled({ draft, isRunning }: { draft: string; isRunning: boolean }): boolean {
  return isRunning || draft.trim() === "";
}

export function createStaticChatComposerSendability(
  feedback: string,
): ChatComposerProps["composerSendability"] {
  return {
    primaryFeedback: feedback,
    secondaryFeedback: [],
    feedbackTone: feedback ? "helper" : null,
    shouldShowFeedback: feedback.trim().length > 0,
  };
}

export function createStaticChatCompactActionDockProps(
  props: StaticChatCompactActionDockProps,
): ChatCompactActionDockProps {
  return {
    attachmentCount: 0,
    showJumpToBottom: false,
    onExpand: chatWindowNoop,
    onJumpToBottom: chatWindowNoop,
    ...props,
  };
}

export function createStaticTextChatCompactActionDockProps({
  pendingRunIndicatorAnnouncement,
  pendingRunIndicatorText,
  onExpand,
}: StaticTextChatCompactActionDockProps): ChatCompactActionDockProps {
  return createStaticChatCompactActionDockProps({
    isRunning: false,
    pendingRunIndicatorAnnouncement,
    pendingRunIndicatorText,
    onExpand,
    onCancel: chatWindowNoop,
  });
}
