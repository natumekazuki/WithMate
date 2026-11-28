import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src-shared/settings/codex-sandbox-mode.js";
import { DEFAULT_CODEX_SPEED } from "../../src-shared/settings/codex-speed.js";
import { DEFAULT_CHARACTER_THEME_COLORS } from "../../src-shared/character/character-state.js";
import type { CharacterProfile } from "../../src-shared/character/character-state.js";
import type {
  Message,
  MessageArtifact,
} from "../../src-shared/session/session-state.js";
import {
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject,
  type UIEventHandler,
} from "react";
import type { SessionContextPaneProps } from "./shell/session-context-pane.js";
import type { ChatWindowProps } from "./chat-window.js";

/** 静的な画面で提供しない操作に割り当てる、何も実行しないコールバック。 */
export const chatWindowNoop = () => {};

/** 共通ウィンドウがヘッダーに渡す表示状態と操作。 */
type ChatHeaderProps = ChatWindowProps["headerProps"];
/** 共通ウィンドウで会話履歴と進行中の応答を表示するための契約。 */
type ChatMessageColumnProps = ChatWindowProps["messageColumnProps"];
/** 共通ウィンドウの入力欄が必要とする送信状態と選択操作。 */
type ChatComposerProps = ChatWindowProps["composerProps"];
/** 折りたたんだドックで使用する簡易操作の契約。 */
type ChatCompactActionDockProps = ChatWindowProps["compactActionDockProps"];

/** 静的チャットの話者は ID と名前を必須とし、プロフィールの残りは省略できる。 */
type StaticChatCharacterInput = {
  id: string;
  name: string;
} & Partial<Omit<CharacterProfile, "id" | "name">>;

/** 共通の会話メッセージへ変換する前の話者、本文、任意の入力要求記録。 */
type ChatRoleMessage = {
  role: string;
  text: string;
  elicitationRecords?: Message["elicitationRecords"];
};

/** 操作を隠したヘッダーに渡すタイトルと進行状態、および既定値の上書き。 */
type StaticChatHeaderProps = {
  taskTitle: string;
  titleDraft?: string;
  isRunning: boolean;
} & Partial<Omit<ChatHeaderProps, "taskTitle" | "titleDraft" | "isRunning">>;

/** 進行中の表示を空にするメッセージ列の必須項目と、個別に追加できる操作。 */
type IdleChatMessageColumnProps = Pick<
  ChatMessageColumnProps,
  "sessionId" | "character" | "messages" | "messageListRef" | "isRunning"
> &
  Partial<
    Omit<
      ChatMessageColumnProps,
      "sessionId" | "character" | "messages" | "messageListRef" | "isRunning"
    >
  >;

/** 補助操作を隠した場合も、下書き・送信の可否・モデルや推論の選択は必要とする。 */
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

/** 簡易ドックで進行状態と中止操作のみ必須とし、他は個別に有効化できる。 */
type StaticChatCompactActionDockProps = Pick<
  ChatCompactActionDockProps,
  "isRunning" | "onCancel"
> &
  Partial<Omit<ChatCompactActionDockProps, "isRunning" | "onCancel">>;

/** 文字ベースの会話と最小限の話者情報から共通メッセージ列を組み立てる入力。 */
type StaticTextConversationMessageColumnProps = {
  sessionId: string;
  characterId: string;
  characterName: string;
  characterIconPath?: string;
  messages: ChatRoleMessage[];
  messageListRef: ChatMessageColumnProps["messageListRef"];
  isRunning: boolean;
} & Partial<
  Omit<
    IdleChatMessageColumnProps,
    "sessionId" | "character" | "messages" | "messageListRef" | "isRunning"
  >
>;

/** 文字入力用の下書き・稼働状態と、入力補助や送信ボタンに使う説明。 */
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

/** 文字入力用の簡易ドックに差し込める展開操作。 */
type StaticTextChatCompactActionDockProps = {
  onExpand?: ChatCompactActionDockProps["onExpand"];
};

/** 保存済みの履歴と進行中の応答・承認・入力要求を共通の会話列へ渡す入力。 */
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
  onToggleMessageBookmark?: ChatMessageColumnProps["onToggleMessageBookmark"];
  expandedArtifacts: Record<string, boolean>;
  messageListRef: RefObject<HTMLDivElement | null>;
  isRunning: boolean;
  pendingRunIndicatorAnnouncement?: ChatMessageColumnProps["pendingRunIndicatorAnnouncement"];
  pendingCancelSessionIds?: ReadonlySet<string>;
  liveApprovalRequest: ChatMessageColumnProps["liveApprovalRequest"];
  approvalActionRequestId: ChatMessageColumnProps["approvalActionRequestId"];
  liveElicitationRequest: ChatMessageColumnProps["liveElicitationRequest"];
  liveElicitationRequests?: ChatMessageColumnProps["liveElicitationRequests"];
  liveElicitationRecords?: ChatMessageColumnProps["liveElicitationRecords"];
  elicitationInputAvailable?: boolean;
  elicitationActionRequestId: ChatMessageColumnProps["elicitationActionRequestId"];
  liveRunAssistantText: string;
  hasLiveRunAssistantText?: boolean;
  liveRunErrorMessage: string;
  pendingMessageText?: string;
  pendingMessageTextVisible?: boolean;
  pendingMessageGroupId?: ChatMessageColumnProps["pendingMessageGroupId"];
  isMessageListFollowing: boolean;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (
    messageIndex: number,
  ) => Promise<MessageArtifact | null>;
  onOpenDiff: ChatMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: ChatMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: ChatMessageColumnProps["onResolveLiveElicitation"];
  onOpenPath: (target: string) => void;
  onCopyMessageText?: ChatMessageColumnProps["onCopyMessageText"];
  onQuoteMessageText?: ChatMessageColumnProps["onQuoteMessageText"];
  glossaryAnnotationMatcher?: ChatMessageColumnProps["glossaryAnnotationMatcher"];
  onActivateGlossaryEntry?: ChatMessageColumnProps["onActivateGlossaryEntry"];
};

/** 稼働中のセッションの入力欄に渡し、対応機能の表示は必要に応じて絞り込む。 */
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

/** 文字入力用に設定する基本送信項目以外で、利用側が上書きできる入力欄の項目。 */
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

/** 稼働中のセッションで個別指定がなければ表示する入力補助操作。 */
const liveSessionComposerCapabilityDefaults = {
  showAttachmentControls: true,
  showAdditionalDirectoryControls: true,
  showExecutionModeControls: true,
  showCustomAgentPicker: true,
  showSkillPicker: true,
} as const;

/** 文字入力画面で実行用の操作だけを有効にし、Agent と Skill の選択は表示しない。 */
export const staticTextChatRuntimeComposerCapabilityDefaults = {
  showAttachmentControls: true,
  showAdditionalDirectoryControls: true,
  showExecutionModeControls: true,
  showCustomAgentPicker: false,
  showSkillPicker: false,
} as const;

/** 簡易ドックには、末尾移動ボタンの表示可否を明示して渡す。 */
export type LiveSessionCompactActionDockProps = Omit<
  ChatCompactActionDockProps,
  "showJumpToBottom"
> & {
  showJumpToBottom: boolean;
};

/** 入力欄の設定に会話の追従状態と展開操作を加え、簡易ドックと共有する。 */
export type LiveSessionComposerDockPropsInput = Omit<
  LiveSessionComposerProps,
  "showJumpToBottom"
> & {
  isMessageListFollowing: boolean;
  onExpandActionDock: () => void;
};

/** 右ペインの開閉と、ドラッグまたはキーボードによる幅変更を接続する。 */
export type LiveSessionSplitterProps = {
  isContextRailResizing: boolean;
  isContextRailVisible: boolean;
  onStartContextRailResize?: PointerEventHandler<HTMLButtonElement>;
  onKeyDownContextRailResize?: import("react").KeyboardEventHandler<HTMLButtonElement>;
  onToggleContextRailVisibility: MouseEventHandler<HTMLButtonElement>;
};

/** 会話列・入力欄・簡易ドック・右ペインの区切りを構成するセッション側の入力。 */
export type LiveSessionChatBodyPropsInput = {
  messageColumn: LiveSessionMessageColumnProps;
  composer: LiveSessionComposerProps;
  compactActionDock: LiveSessionCompactActionDockProps;
  splitter: LiveSessionSplitterProps;
};

/** 稼働中のセッションから右ペインへ渡す項目は、ペイン側の契約と同じとする。 */
export type LiveSessionContextPanePropsInput = SessionContextPaneProps;

/** セッションの各表示領域をそれぞれ変換し、共通ウィンドウの本文用にまとめる。 */
export function buildLiveSessionChatBodyProps(
  input: LiveSessionChatBodyPropsInput,
): Pick<
  ChatWindowProps,
  "messageColumnProps" | "composerProps" | "compactActionDockProps"
> & {
  splitterProps: ReturnType<typeof buildLiveSessionSplitterProps>;
} {
  return {
    messageColumnProps: buildLiveSessionMessageColumnProps(input.messageColumn),
    composerProps: buildLiveSessionComposerProps(input.composer),
    compactActionDockProps: buildLiveSessionCompactActionDockProps(
      input.compactActionDock,
    ),
    splitterProps: buildLiveSessionSplitterProps(input.splitter),
  };
}

/** 会話を追従していないときは、入力欄と簡易ドックの両方で末尾移動を表示する。 */
export function buildLiveSessionComposerDockProps(
  input: LiveSessionComposerDockPropsInput,
): {
  composer: LiveSessionComposerProps;
  compactActionDock: LiveSessionCompactActionDockProps;
} {
  const { isMessageListFollowing, onExpandActionDock, ...composerInput } =
    input;
  const showJumpToBottom = !isMessageListFollowing;

  return {
    composer: {
      ...composerInput,
      showJumpToBottom,
    },
    compactActionDock: {
      isRunning: input.isRunning,
      ...(input.isCanceling !== undefined
        ? { isCanceling: input.isCanceling }
        : {}),
      ...(input.isAwaitingRunStop !== undefined
        ? { isAwaitingRunStop: input.isAwaitingRunStop }
        : {}),
      showJumpToBottom,
      cancelButtonTitle: input.canSendInput
        ? "Cancel run"
        : input.sendButtonTitle,
      onExpand: onExpandActionDock,
      onJumpToBottom: input.onJumpToBottom,
      onCancel: input.onSendOrCancel,
    },
  };
}

/** 内容を加工せず、右ペイン用の props を新しいオブジェクトとして渡す。 */
export function buildLiveSessionContextPaneProps(
  input: LiveSessionContextPanePropsInput,
): SessionContextPaneProps {
  return { ...input };
}

/** 進行中の応答の有無が明示されていない場合は本文長から補う。 */
export function buildLiveSessionMessageColumnProps(
  input: LiveSessionMessageColumnProps,
): ChatMessageColumnProps {
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
    onToggleMessageBookmark: input.onToggleMessageBookmark,
    expandedArtifacts: input.expandedArtifacts,
    messageListRef: input.messageListRef,
    isRunning: input.isRunning,
    pendingRunIndicatorAnnouncement: input.pendingRunIndicatorAnnouncement,
    pendingCancelSessionIds: input.pendingCancelSessionIds,
    liveApprovalRequest: input.liveApprovalRequest,
    approvalActionRequestId: input.approvalActionRequestId,
    liveElicitationRequest: input.liveElicitationRequest,
    liveElicitationRequests: input.liveElicitationRequests,
    liveElicitationRecords: input.liveElicitationRecords,
    elicitationInputAvailable: input.elicitationInputAvailable,
    elicitationActionRequestId: input.elicitationActionRequestId,
    liveRunAssistantText: input.liveRunAssistantText,
    hasLiveRunAssistantText:
      input.hasLiveRunAssistantText ?? input.liveRunAssistantText.length > 0,
    liveRunErrorMessage: input.liveRunErrorMessage,
    pendingMessageText: input.pendingMessageText,
    pendingMessageTextVisible: input.pendingMessageTextVisible,
    pendingMessageGroupId: input.pendingMessageGroupId,
    isMessageListFollowing: input.isMessageListFollowing,
    onMessageListScroll: input.onMessageListScroll,
    onToggleArtifact: input.onToggleArtifact,
    onLoadArtifactDetail: input.onLoadArtifactDetail,
    onOpenDiff: input.onOpenDiff,
    onResolveLiveApproval: input.onResolveLiveApproval,
    onResolveLiveElicitation: input.onResolveLiveElicitation,
    onOpenPath: input.onOpenPath,
    onCopyMessageText: input.onCopyMessageText,
    onQuoteMessageText: input.onQuoteMessageText,
    glossaryAnnotationMatcher: input.glossaryAnnotationMatcher,
    onActivateGlossaryEntry: input.onActivateGlossaryEntry,
  };
}

/** 入力欄の機能表示を既定で有効にし、利用側の指定を優先する。 */
export function buildLiveSessionComposerProps(
  input: LiveSessionComposerProps,
): ChatComposerProps {
  return {
    ...liveSessionComposerCapabilityDefaults,
    ...input,
  };
}

/** 静的な文字チャットでは補助操作を隠し、明示的に指定したものだけを表示できる。 */
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

/** セッションが決めた簡易ドックの設定を、そのまま共通ウィンドウに渡す。 */
export function buildLiveSessionCompactActionDockProps(
  input: LiveSessionCompactActionDockProps,
): ChatCompactActionDockProps {
  return input;
}

/** 右ペインの状態に合わせた開閉ラベルを付け、区切りの操作を対応付ける。 */
export function buildLiveSessionSplitterProps(
  input: LiveSessionSplitterProps,
): {
  isActive: boolean;
  isPanelExpanded: boolean;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
  onKeyDown?: import("react").KeyboardEventHandler<HTMLButtonElement>;
  title: string;
  ariaLabel: string;
  onTogglePanel: MouseEventHandler<HTMLButtonElement>;
} {
  return {
    isActive: input.isContextRailResizing,
    isPanelExpanded: input.isContextRailVisible,
    onPointerDown: input.onStartContextRailResize,
    onKeyDown: input.onKeyDownContextRailResize,
    title:
      "Click to toggle the right pane. Drag or use arrow keys to resize when expanded.",
    ariaLabel: input.isContextRailVisible
      ? "Collapse right pane"
      : "Open right pane",
    onTogglePanel: input.onToggleContextRailVisibility,
  };
}

/** 静的表示では管理操作を隠し、別の下書きがなければ現在のタイトルを使う。 */
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
    showTerminalButton: false,
    showDeleteButton: false,
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

/** 話者の最小情報に空の詳細と既定の配色を補い、共通プロフィールに変換する。 */
export function createStaticChatCharacterProfile({
  id,
  name,
  iconPath = "",
  description = "",
  roleMarkdown = "",
  notesMarkdown = "",
  updatedAt = "",
  themeColors = { ...DEFAULT_CHARACTER_THEME_COLORS },
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
  };
}

/** user 以外の話者は assistant に写し、既存の入力要求記録があれば引き継ぐ。 */
export function toConversationMessages(messages: ChatRoleMessage[]): Message[] {
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    text: message.text,
    ...(message.elicitationRecords
      ? { elicitationRecords: message.elicitationRecords }
      : {}),
  }));
}

/** 保存済み履歴の表示に、進行中の要求がなく末尾に追従する初期値を補う。 */
export function createIdleChatMessageColumnProps(
  props: IdleChatMessageColumnProps,
): ChatMessageColumnProps {
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
    ...props,
  };
}

/** 最小限の話者情報と文字ベースの会話を、共通の履歴表示に渡せる形へ変換する。 */
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
    character: createStaticChatCharacterProfile({
      id: characterId,
      name: characterName,
      iconPath: characterIconPath,
    }),
    messages: toConversationMessages(messages),
    messageListRef,
    isRunning,
    ...props,
  });
}

/** 入力補助と実行モードの操作を隠しつつ、利用側で必要な項目は再指定できるようにする。 */
export function createHiddenControlsChatComposerProps(
  props: HiddenControlsChatComposerProps,
): ChatComposerProps {
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
    placeholder: undefined,
    isComposerBlockedFeedbackActive: false,
    approvalOptions: [],
    selectedApprovalMode: "",
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
    /** 追加ディレクトリ機能を提供しない場合は検証済みとして扱わない。 */
    onValidateAdditionalDirectory: async () => ({
      valid: false,
      reason: "unavailable",
    }),
    onToggleAdditionalDirectoryList: chatWindowNoop,
    onJumpToBottom: chatWindowNoop,
    onSelectCustomAgent: chatWindowNoop,
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

/** 実行中は入力と送信を止め、通常の送信ボタンを中止ボタンに切り替えない。 */
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

/** 静的チャットでは実行中、または下書きが空白だけのときは送信できない。 */
export function isStaticChatSendDisabled({
  draft,
  isRunning,
}: {
  draft: string;
  isRunning: boolean;
}): boolean {
  return isRunning || draft.trim() === "";
}

/** 入力欄の説明を補助メッセージにし、空白だけなら表示しない。 */
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

/** 静的チャットの簡易ドックに、末尾移動と展開操作の既定値を補う。 */
export function createStaticChatCompactActionDockProps(
  props: StaticChatCompactActionDockProps,
): ChatCompactActionDockProps {
  return {
    showJumpToBottom: false,
    onExpand: chatWindowNoop,
    onJumpToBottom: chatWindowNoop,
    ...props,
  };
}

/** 文字チャットでは中止や末尾移動を提供せず、指定があればドックを展開できる。 */
export function createStaticTextChatCompactActionDockProps({
  onExpand,
}: StaticTextChatCompactActionDockProps): ChatCompactActionDockProps {
  return createStaticChatCompactActionDockProps({
    isRunning: false,
    onExpand,
    onCancel: chatWindowNoop,
  });
}
