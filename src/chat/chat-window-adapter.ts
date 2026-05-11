import { DEFAULT_APPROVAL_MODE } from "../approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../codex-sandbox-mode.js";
import {
  DEFAULT_CHARACTER_SESSION_COPY,
  DEFAULT_CHARACTER_THEME_COLORS,
  type CharacterProfile,
  type Message,
} from "../app-state.js";
import type { ChatWindowProps } from "./chat-window.js";

export const chatWindowNoop = () => {};

type ChatHeaderProps = ChatWindowProps["headerProps"];
type ChatMessageColumnProps = ChatWindowProps["messageColumnProps"];
type ChatComposerProps = ChatWindowProps["composerProps"];
type ChatCompactActionDockProps = ChatWindowProps["compactActionDockProps"];

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
  onToggleExpanded: () => void;
} & Partial<Omit<ChatHeaderProps, "taskTitle" | "titleDraft" | "isRunning" | "onToggleExpanded">>;

type IdleChatMessageColumnProps = Pick<
  ChatMessageColumnProps,
  | "sessionId"
  | "character"
  | "messages"
  | "messageListRef"
  | "isRunning"
  | "pendingRunIndicatorAnnouncement"
  | "pendingRunIndicatorText"
> &
  Partial<
    Omit<
      ChatMessageColumnProps,
      | "sessionId"
      | "character"
      | "messages"
      | "messageListRef"
      | "isRunning"
      | "pendingRunIndicatorAnnouncement"
      | "pendingRunIndicatorText"
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
  "draft" | "isRunning" | "isSendDisabled" | "onSendOrCancel"
> &
  Partial<Omit<ChatCompactActionDockProps, "draft" | "isRunning" | "isSendDisabled" | "onSendOrCancel">>;

export function createStaticChatHeaderProps({
  taskTitle,
  titleDraft = taskTitle,
  isRunning,
  onToggleExpanded,
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
    onToggleExpanded,
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

export function createHiddenControlsChatComposerProps(props: HiddenControlsChatComposerProps): ChatComposerProps {
  return {
    retryBanner: null,
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
    canCollapseActionDock: false,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    isSkillListLoading: false,
    customAgentItems: [],
    skillItems: [],
    attachmentItems: [],
    additionalDirectoryItems: [],
    workspacePathMatchItems: [],
    placeholder: undefined,
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [{ value: DEFAULT_APPROVAL_MODE, label: DEFAULT_APPROVAL_MODE }],
    selectedApprovalMode: DEFAULT_APPROVAL_MODE,
    sandboxOptions: [],
    selectedCodexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    onPickFile: chatWindowNoop,
    onPickFolder: chatWindowNoop,
    onPickImage: chatWindowNoop,
    onToggleAgentPicker: chatWindowNoop,
    onToggleSkillPicker: chatWindowNoop,
    onAddAdditionalDirectory: chatWindowNoop,
    onToggleAdditionalDirectoryList: chatWindowNoop,
    onCollapse: chatWindowNoop,
    onJumpToBottom: chatWindowNoop,
    onSelectCustomAgent: chatWindowNoop,
    onSelectSkill: chatWindowNoop,
    onRemoveAttachment: chatWindowNoop,
    onRemoveAdditionalDirectory: chatWindowNoop,
    onDraftFocus: chatWindowNoop,
    onDraftSelect: chatWindowNoop,
    onDraftCompositionStart: chatWindowNoop,
    onDraftCompositionEnd: chatWindowNoop,
    onSelectWorkspacePathMatch: chatWindowNoop,
    onActivateWorkspacePathMatch: chatWindowNoop,
    onChangeApprovalMode: chatWindowNoop,
    onChangeCodexSandboxMode: chatWindowNoop,
    ...props,
  };
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
    actionDockCompactPreview: props.draft.trim() || "下書きなし",
    attachmentCount: 0,
    showJumpToBottom: false,
    onExpand: chatWindowNoop,
    onJumpToBottom: chatWindowNoop,
    ...props,
  };
}

export function buildChatPageClassName({
  baseClassName = "",
  isHeaderExpanded,
}: {
  baseClassName?: string;
  isHeaderExpanded: boolean;
}): string {
  return [baseClassName, isHeaderExpanded ? "" : "session-page-header-collapsed"]
    .filter((className) => className.length > 0)
    .join(" ");
}
