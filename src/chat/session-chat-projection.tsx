import type { CSSProperties, KeyboardEventHandler, PointerEventHandler, ReactNode, RefObject, UIEventHandler } from "react";

import type { CharacterProfile, DiffPreviewPayload, Message, MessageArtifact } from "../app-state.js";
import type { HomeMonitorEntry } from "../home/home-session-projection.js";
import type { Session } from "../session-state.js";
import {
  type SessionActionDockCompactRowProps,
  type SessionAuditLogModalProps,
  type SessionComposerExpandedProps,
  type SessionContextPaneProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
  type SessionRetryBannerProps,
} from "../session-components.js";
import type { ContextPaneTabKey } from "../session-ui-projection.js";
import { ChatSessionModals } from "./chat-session-modals.js";
import type { ChatWindowProps } from "./chat-window.js";
import { buildLiveSessionWindowShellProps } from "./live-session-window-props.js";
import {
  buildLiveSessionChatBodyProps,
  buildLiveSessionComposerDockProps,
  resolveAuxiliaryModeLabel,
} from "./chat-window-adapter.js";
import { buildLiveSessionHeaderProps } from "./chat-header-actions.js";
import {
  buildLiveSessionCommonComposerDockInput,
  buildLiveSessionCommonContextPaneProps,
  buildLiveSessionCommonMessageColumnProps,
  buildLiveSessionRecoveryActions,
} from "./live-session-projection.js";

export type AgentSessionChatProjectionInput = {
  mainContent?: ReactNode;
  leftPane?: ReactNode;
  isFilesPaneVisible: boolean;
  selectedSession: Session;
  selectedSessionCharacter: CharacterProfile;
  displayedMessages: Message[];
  displayedMessageKeys?: SessionMessageColumnProps["messageKeys"];
  displayedMessageGroups?: SessionMessageColumnProps["messageGroups"];
  expandedArtifacts: Record<string, boolean>;
  sessionThemeStyle: CSSProperties | undefined;
  sessionDockLayoutRef: RefObject<HTMLDivElement | null>;
  headerDockRef: RefObject<HTMLDivElement | null>;
  actionDockRef: RefObject<HTMLDivElement | null>;
  sessionDockLayoutStyle: CSSProperties;
  sessionWorkbenchRef: RefObject<HTMLDivElement | null>;
  sessionWorkbenchStyle: CSSProperties | undefined;
  layoutPriority: ChatWindowProps["layoutPriority"];
  onActivateSidePanePriority: () => void;
  onActivateDockPriority: () => void;
  isSessionHeaderExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isSelectedSessionRunning: boolean;
  isSelectedSessionReadOnly: boolean;
  isSelectedSessionPinned: boolean;
  isSessionPinPending: boolean;
  messageListRef: RefObject<HTMLDivElement | null>;
  pendingRunIndicatorAnnouncement: string;
  pendingRunIndicatorText: string;
  pendingMessageText: string;
  liveApprovalRequest: SessionMessageColumnProps["liveApprovalRequest"];
  approvalActionRequestId: string | null;
  liveElicitationRequest: SessionMessageColumnProps["liveElicitationRequest"];
  elicitationActionRequestId: string | null;
  liveRunAssistantText: string;
  hasLiveRunAssistantText: boolean;
  liveRunErrorMessage: string;
  inlinePathFeedback: string;
  isMessageListFollowing: boolean;
  pendingMessageGroupId?: SessionMessageColumnProps["pendingMessageGroupId"];
  retryBanner: SessionRetryBannerProps["retryBanner"];
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  composerBlocked: boolean;
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
  isPromptTemplateWorkspaceOpen: boolean;
  isAdditionalDirectoryListOpen: boolean;
  selectedCustomAgentLabel: string;
  selectedCustomAgentTitle: string;
  canCollapseActionDock: boolean;
  isCustomAgentListLoading: boolean;
  isSkillListLoading: boolean;
  customAgentItems: SessionComposerExpandedProps["customAgentItems"];
  skillItems: SessionComposerExpandedProps["skillItems"];
  composerAttachmentItems: SessionComposerExpandedProps["attachmentItems"];
  additionalDirectoryItems: SessionComposerExpandedProps["additionalDirectoryItems"];
  draft: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerExpandedProps["composerSendability"];
  composerSendButtonTitle: string | undefined;
  isComposerBlockedFeedbackActive: boolean;
  approvalChoiceOptions: SessionComposerExpandedProps["approvalOptions"];
  sandboxChoiceOptions: SessionComposerExpandedProps["sandboxOptions"];
  modelSelectOptions: SessionComposerExpandedProps["modelOptions"];
  selectedModelFallbackLabel: string;
  reasoningSelectOptions: SessionComposerExpandedProps["reasoningOptions"];
  actionDockCompactPreview: string;
  chatNotice?: string;
  attachmentCount: number;
  isActionDockExpanded: boolean;
  isActionDockResizing: boolean;
  isContextRailResizing: boolean;
  isFilesPaneResizing: boolean;
  isContextRailVisible: boolean;
  latestCommandView: SessionContextPaneProps["latestCommandView"];
  runningDetailsEntries: SessionContextPaneProps["runningDetailsEntries"];
  liveRunReasoningText: SessionContextPaneProps["liveRunReasoningText"];
  activeContextPaneTab: ContextPaneTabKey;
  availableContextPaneTabs: ContextPaneTabKey[];
  contextPaneProjection: SessionContextPaneProps["contextPaneProjection"];
  selectedBackgroundTasks: SessionContextPaneProps["backgroundTasks"];
  selectedCompanionGroupMonitorEntries: HomeMonitorEntry[];
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextPaneProps["selectedSessionContextTelemetry"];
  selectedSessionContextTelemetryProjection: SessionContextPaneProps["selectedSessionContextTelemetryProjection"];
  selectedContextEmptyText: string;
  latestCommandEmptyText: string;
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  auditLogsOpen: boolean;
  displayedSessionAuditLogs: SessionAuditLogModalProps["entries"];
  auditLogSourceLabel?: SessionAuditLogModalProps["sourceLabel"];
  auditLogDetails: SessionAuditLogModalProps["details"];
  auditLogOperationDetails: SessionAuditLogModalProps["operationDetails"];
  auditLogsHasMore: boolean;
  auditLogsLoading: boolean;
  auditLogsTotal: number;
  auditLogsErrorMessage: string | null;
  onToggleHeaderSplitter: () => void;
  onOpenAuditLog: () => void;
  onOpenSessionTerminal: () => void;
  onOpenSessionFilesTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onDeleteSession: () => void;
  onToggleSessionPin: () => void;
  onOpenSessionExplorer: () => void;
  onOpenSessionFilesExplorer: () => void;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: SessionMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"];
  onOpenInlinePath: (target: string) => void;
  onDismissInlinePathFeedback: () => void;
  getChangedFilesEmptyText: SessionMessageColumnProps["getChangedFilesEmptyText"];
  onCopyMessageText: NonNullable<SessionMessageColumnProps["onCopyMessageText"]>;
  onQuoteMessageText: NonNullable<SessionMessageColumnProps["onQuoteMessageText"]>;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
  onAddToSessionFiles: NonNullable<SessionComposerExpandedProps["onAddToSessionFiles"]>;
  onPickSessionFiles: NonNullable<SessionComposerExpandedProps["onPickSessionFiles"]>;
  onPickSessionFolder: NonNullable<SessionComposerExpandedProps["onPickSessionFolder"]>;
  onPickSessionImage: NonNullable<SessionComposerExpandedProps["onPickSessionImage"]>;
  onToggleAgentPicker: () => void;
  onToggleSkillPicker: () => void;
  onOpenPromptTemplates: () => void;
  onAddAdditionalDirectory: () => void;
  onToggleAdditionalDirectoryList: () => void;
  onJumpToMessageListBottom: () => void;
  onSelectCustomAgent: SessionComposerExpandedProps["onSelectCustomAgent"];
  onSelectSkill: SessionComposerExpandedProps["onSelectSkill"];
  onRemoveAttachment: SessionComposerExpandedProps["onRemoveAttachment"];
  onRemoveAdditionalDirectory: SessionComposerExpandedProps["onRemoveAdditionalDirectory"];
  onDraftChange: SessionComposerExpandedProps["onDraftChange"];
  onDraftFocus: () => void;
  onDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onDraftPaste: SessionComposerExpandedProps["onDraftPaste"];
  onDraftSelect: (selectionStart: number) => void;
  onDraftCompositionStart: () => void;
  onDraftCompositionEnd: () => void;
  onSendOrCancel: () => void;
  onChangeApprovalMode: SessionComposerExpandedProps["onChangeApprovalMode"];
  onChangeCodexSandboxMode: SessionComposerExpandedProps["onChangeCodexSandboxMode"];
  onChangeModel: SessionComposerExpandedProps["onChangeModel"];
  onChangeReasoningEffort: SessionComposerExpandedProps["onChangeReasoningEffort"];
  onStartContextRailResize: PointerEventHandler<HTMLButtonElement>;
  onStartFilesPaneResize: PointerEventHandler<HTMLButtonElement>;
  onStartActionDockResize: PointerEventHandler<HTMLButtonElement>;
  onToggleActionDock: () => void;
  onToggleContextRailVisibility: () => void;
  onToggleFilesPaneVisibility: () => void;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  onLoadMoreAuditLogs: () => void;
  onLoadAuditLogDetail: SessionAuditLogModalProps["onLoadDetail"];
  onLoadAuditLogOperationDetail: SessionAuditLogModalProps["onLoadOperationDetail"];
  onCloseAuditLog: () => void;
  headerActions?: ReactNode;
  isAuxiliaryMode?: boolean;
};

export function buildAgentSessionChatWindowProps(input: AgentSessionChatProjectionInput): ChatWindowProps {
  const isCharacterAuthoringSession = input.selectedSession.sessionKind === "character-authoring";
  const recoveryActions = buildLiveSessionRecoveryActions({
    retryBanner: input.retryBanner,
    isRetryActionDisabled: input.isRetryActionDisabled,
    isRetryEditDisabled: input.isRetryEditDisabled,
    isRetryDraftReplacePending: input.isRetryDraftReplacePending,
    onResendLastMessage: input.onResendLastMessage,
    onEditLastMessage: input.onEditLastMessage,
    onConfirmRetryDraftReplace: input.onConfirmRetryDraftReplace,
    onCancelRetryDraftReplace: input.onCancelRetryDraftReplace,
  });
  const headerProps: SessionHeaderProps = buildLiveSessionHeaderProps({
    taskTitle: input.selectedSession.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isSelectedSessionRunning,
    isReadOnly: input.isSelectedSessionReadOnly,
    isPinned: input.isSelectedSessionPinned,
    isPinPending: input.isSessionPinPending,
    isAuxiliaryMode: input.isAuxiliaryMode,
    canViewAuxiliaryAuditLog: true,
    canDeleteSession: true,
    canViewAuditLog: true,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenSessionTerminal,
    onOpenSessionFilesExplorer: input.onOpenSessionFilesExplorer,
    onOpenSessionFilesTerminal: input.onOpenSessionFilesTerminal,
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: input.onDeleteSession,
    onTogglePin: input.onToggleSessionPin,
    actions: input.headerActions,
    onOpenWorkspaceExplorer: input.onOpenSessionExplorer,
  });

  const composerDockProps = buildLiveSessionComposerDockProps(
    buildLiveSessionCommonComposerDockInput({
      isRunning: input.isSelectedSessionRunning,
      pendingRunIndicatorAnnouncement: input.pendingRunIndicatorAnnouncement,
      pendingRunIndicatorText: input.pendingRunIndicatorText,
      modeLabel: resolveAuxiliaryModeLabel(input.isAuxiliaryMode),
      composerBlocked: input.composerBlocked,
      canSelectCustomAgent: !isCharacterAuthoringSession && input.selectedSession.provider === "copilot",
      showCustomAgentPicker: !isCharacterAuthoringSession && input.selectedSession.provider === "copilot",
      showSkillPicker: !isCharacterAuthoringSession,
      showPromptTemplateButton: true,
      isAgentPickerOpen: input.isAgentPickerOpen,
      isSkillPickerOpen: input.isSkillPickerOpen,
      isPromptTemplateWorkspaceOpen: input.isPromptTemplateWorkspaceOpen,
      isAdditionalDirectoryListOpen: input.isAdditionalDirectoryListOpen,
      selectedCustomAgentLabel:
        !isCharacterAuthoringSession && input.selectedSession.provider === "copilot"
          ? input.selectedCustomAgentLabel
          : "Agent",
      selectedCustomAgentTitle: input.selectedCustomAgentTitle,
      additionalDirectoryCount: input.selectedSession.allowedAdditionalDirectories.length,
      isMessageListFollowing: input.isMessageListFollowing,
      isCustomAgentListLoading: input.isCustomAgentListLoading,
      isSkillListLoading: input.isSkillListLoading,
      customAgentItems: input.customAgentItems,
      skillItems: input.skillItems,
      attachmentItems: input.composerAttachmentItems,
      additionalDirectoryItems: input.additionalDirectoryItems,
      draft: input.draft,
      composerTextareaRef: input.composerTextareaRef,
      isComposerDisabled: input.isComposerDisabled,
      isSendDisabled: input.isSendDisabled,
      composerSendability: input.composerSendability,
      sendButtonTitle: input.composerSendButtonTitle,
      isComposerBlockedFeedbackActive: input.isComposerBlockedFeedbackActive,
      approvalOptions: input.approvalChoiceOptions,
      selectedApprovalMode: input.selectedSession.approvalMode,
      sandboxOptions: input.sandboxChoiceOptions,
      selectedCodexSandboxMode: input.selectedSession.codexSandboxMode,
      modelOptions: input.modelSelectOptions,
      selectedModel: input.selectedSession.model,
      selectedModelFallbackLabel: input.selectedModelFallbackLabel,
      reasoningOptions: input.reasoningSelectOptions,
      selectedReasoningEffort: input.selectedSession.reasoningEffort,
      actionDockCompactPreview: input.actionDockCompactPreview,
      chatNotice: input.chatNotice,
      attachmentCount: input.attachmentCount,
      onPickFile: input.onPickFile,
      onPickFolder: input.onPickFolder,
      onPickImage: input.onPickImage,
      onAddToSessionFiles: input.onAddToSessionFiles,
      onPickSessionFiles: input.onPickSessionFiles,
      onPickSessionFolder: input.onPickSessionFolder,
      onPickSessionImage: input.onPickSessionImage,
      onToggleAgentPicker: input.onToggleAgentPicker,
      onToggleSkillPicker: input.onToggleSkillPicker,
      onOpenPromptTemplates: input.onOpenPromptTemplates,
      onAddAdditionalDirectory: input.onAddAdditionalDirectory,
      onToggleAdditionalDirectoryList: input.onToggleAdditionalDirectoryList,
      onExpandActionDock: input.onToggleActionDock,
      onJumpToBottom: input.onJumpToMessageListBottom,
      onSelectCustomAgent: input.onSelectCustomAgent,
      onSelectSkill: input.onSelectSkill,
      onRemoveAttachment: input.onRemoveAttachment,
      onRemoveAdditionalDirectory: input.onRemoveAdditionalDirectory,
      onDraftChange: input.onDraftChange,
      onDraftFocus: input.onDraftFocus,
      onDraftKeyDown: input.onDraftKeyDown,
      onDraftPaste: input.onDraftPaste,
      onDraftSelect: input.onDraftSelect,
      onDraftCompositionStart: input.onDraftCompositionStart,
      onDraftCompositionEnd: input.onDraftCompositionEnd,
      onSendOrCancel: input.onSendOrCancel,
      onChangeApprovalMode: input.onChangeApprovalMode,
      onChangeCodexSandboxMode: input.onChangeCodexSandboxMode,
      onChangeModel: input.onChangeModel,
      onChangeReasoningEffort: input.onChangeReasoningEffort,
    }),
  );

  const chatBodyProps = buildLiveSessionChatBodyProps({
    messageColumn: buildLiveSessionCommonMessageColumnProps({
      sessionId: input.selectedSession.id,
      character: input.selectedSessionCharacter,
      messages: input.displayedMessages,
      messageKeys: input.displayedMessageKeys,
      messageGroups: input.displayedMessageGroups,
      expandedArtifacts: input.expandedArtifacts,
      messageListRef: input.messageListRef,
      isRunning: input.isSelectedSessionRunning,
      liveApprovalRequest: input.liveApprovalRequest,
      approvalActionRequestId: input.approvalActionRequestId,
      liveElicitationRequest: input.liveElicitationRequest,
      elicitationActionRequestId: input.elicitationActionRequestId,
      liveRunAssistantText: input.liveRunAssistantText,
      hasLiveRunAssistantText: input.hasLiveRunAssistantText,
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
      onOpenPath: input.onOpenInlinePath,
      getChangedFilesEmptyText: input.getChangedFilesEmptyText,
      onCopyMessageText: input.onCopyMessageText,
      onQuoteMessageText: input.onQuoteMessageText,
    }),
    composer: composerDockProps.composer,
    compactActionDock: composerDockProps.compactActionDock,
    splitter: {
      isContextRailResizing: input.isContextRailResizing,
      isContextRailVisible: input.isContextRailVisible,
      onStartContextRailResize: input.onStartContextRailResize,
      onToggleContextRailVisibility: input.onToggleContextRailVisibility,
    },
  });
  const rightPaneProps = buildLiveSessionCommonContextPaneProps({
    activeContextPaneTab: input.activeContextPaneTab,
    availableContextPaneTabs: input.availableContextPaneTabs,
    contextPaneProjection: input.contextPaneProjection,
    latestCommandView: input.latestCommandView,
    runningDetailsEntries: input.runningDetailsEntries,
    liveRunReasoningText: input.liveRunReasoningText,
    backgroundTasks: input.selectedBackgroundTasks,
    companionGroupMonitorEntries: input.selectedCompanionGroupMonitorEntries,
    selectedSessionLiveRunErrorMessage: input.liveRunErrorMessage,
    isSelectedSessionRunning: input.isSelectedSessionRunning,
    isCopilotSession: input.isCopilotSession,
    selectedCopilotRemainingPercentLabel: input.selectedCopilotRemainingPercentLabel,
    selectedCopilotRemainingRequestsLabel: input.selectedCopilotRemainingRequestsLabel,
    selectedCopilotQuotaResetLabel: input.selectedCopilotQuotaResetLabel,
    selectedSessionContextTelemetry: input.selectedSessionContextTelemetry,
    selectedSessionContextTelemetryProjection: input.selectedSessionContextTelemetryProjection,
    contextEmptyText: input.selectedContextEmptyText,
    latestCommandEmptyText: input.latestCommandEmptyText,
    onCycleContextPaneTab: input.onCycleContextPaneTab,
    onOpenCompanionReview: input.onOpenCompanionReview,
  });

  return buildLiveSessionWindowShellProps({
    mode: "agent",
    style: { ...input.sessionThemeStyle, ...input.sessionDockLayoutStyle },
    layoutRef: input.sessionDockLayoutRef,
    headerDockRef: input.headerDockRef,
    actionDockRef: input.actionDockRef,
    isHeaderExpanded: input.isSessionHeaderExpanded,
    workbenchRef: input.sessionWorkbenchRef,
    workbenchStyle: input.sessionWorkbenchStyle,
    layoutPriority: input.layoutPriority,
    onActivateSidePanePriority: input.onActivateSidePanePriority,
    onActivateDockPriority: input.onActivateDockPriority,
    headerProps,
    messageColumnProps: {
      ...chatBodyProps.messageColumnProps,
      inlinePathFeedback: input.inlinePathFeedback,
      onDismissInlinePathFeedback: input.onDismissInlinePathFeedback,
    },
    recoveryActions,
    mainContent: input.mainContent,
    isActionDockExpanded: input.isActionDockExpanded,
    headerSplitterProps: {
      isPanelExpanded: input.isSessionHeaderExpanded,
      canCollapse: !input.isEditingTitle,
      onTogglePanel: input.onToggleHeaderSplitter,
    },
    actionDockSplitterProps: {
      isActive: input.isActionDockResizing,
      isPanelExpanded: input.isActionDockExpanded,
      canCollapse: input.canCollapseActionDock,
      onPointerDown: input.isActionDockExpanded ? input.onStartActionDockResize : undefined,
      onTogglePanel: input.onToggleActionDock,
    },
    composerProps: chatBodyProps.composerProps,
    compactActionDockProps: chatBodyProps.compactActionDockProps,
    splitterProps: chatBodyProps.splitterProps,
    leftPane: input.leftPane,
    leftSplitterProps: {
      isActive: input.isFilesPaneResizing,
      isPanelExpanded: input.isFilesPaneVisible,
      onPointerDown: input.isFilesPaneVisible ? input.onStartFilesPaneResize : undefined,
      onTogglePanel: input.onToggleFilesPaneVisibility,
      ariaLabel: input.isFilesPaneVisible ? "File Explorer を非表示" : "File Explorer を表示",
      title: input.isFilesPaneVisible ? "File Explorer を非表示" : "File Explorer を表示",
    },
    isLeftPaneVisible: input.isFilesPaneVisible,
    isRightPaneVisible: input.isContextRailVisible,
    rightPaneProps,
    modals: <ChatSessionModals {...input} />,
    isAuxiliaryMode: input.isAuxiliaryMode,
  });
}
