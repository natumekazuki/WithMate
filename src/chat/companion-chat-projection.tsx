import type {
  CSSProperties,
  KeyboardEventHandler,
  PointerEventHandler,
  ReactNode,
  RefObject,
  UIEventHandler,
} from "react";

import type { CharacterProfile, DiffPreviewPayload, MessageArtifact } from "../app-state.js";
import type { CompanionSession } from "../companion-state.js";
import type { AdditionalDirectoryItem } from "../session-composer-paths.js";
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
import {
  buildLiveSessionChatBodyProps,
  buildLiveSessionComposerDockProps,
  resolveAuxiliaryModeLabel,
} from "./chat-window-adapter.js";
import type { ChatWindowProps } from "./chat-window.js";
import { buildLiveSessionWindowShellProps } from "./live-session-window-props.js";
import { buildLiveSessionHeaderProps } from "./chat-header-actions.js";
import { COMPANION_PENDING_RUN_INDICATOR_TEXT } from "./pending-run-indicator.js";
import {
  buildLiveSessionCommonComposerDockInput,
  buildLiveSessionCommonContextPaneProps,
  buildLiveSessionCommonMessageColumnProps,
  buildLiveSessionErrorNotices,
  buildLiveSessionRecoveryActions,
} from "./live-session-projection.js";

const getCompanionChangedFilesEmptyText = () => "差分はまだないよ。";

export type CompanionChatProjectionInput = {
  session: CompanionSession;
  character: CharacterProfile;
  displayedMessages?: CompanionSession["messages"];
  displayedMessageKeys?: SessionMessageColumnProps["messageKeys"];
  displayedMessageGroups?: SessionMessageColumnProps["messageGroups"];
  expandedArtifacts: Record<string, boolean>;
  themeStyle: CSSProperties | undefined;
  layoutRef: RefObject<HTMLDivElement | null>;
  headerDockRef: RefObject<HTMLDivElement | null>;
  actionDockRef: RefObject<HTMLDivElement | null>;
  dockLayoutStyle: CSSProperties;
  workbenchRef: RefObject<HTMLDivElement | null>;
  workbenchStyle: CSSProperties | undefined;
  layoutPriority: ChatWindowProps["layoutPriority"];
  onActivateSidePanePriority: () => void;
  onActivateDockPriority: () => void;
  isHeaderExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isSelectedSessionRunning: boolean;
  isHeaderActionDisabled: boolean;
  messageListRef: RefObject<HTMLDivElement | null>;
  liveApprovalRequest: SessionMessageColumnProps["liveApprovalRequest"];
  approvalActionRequestId: string | null;
  liveElicitationRequest: SessionMessageColumnProps["liveElicitationRequest"];
  elicitationActionRequestId: string | null;
  liveRunAssistantText: string;
  liveRunErrorMessage: string;
  pendingMessageText: string;
  pendingMessageGroupId?: SessionMessageColumnProps["pendingMessageGroupId"];
  isMessageListFollowing: boolean;
  retryBanner: SessionRetryBannerProps["retryBanner"];
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  isActionDockExpanded: boolean;
  isActionDockResizing: boolean;
  composerBlocked: boolean;
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
  isAdditionalDirectoryListOpen: boolean;
  selectedCustomAgentLabel: string;
  selectedCustomAgentTitle: string;
  canCollapseActionDock: boolean;
  isCustomAgentListLoading: boolean;
  isSkillListLoading: boolean;
  skillListError: string | null;
  customAgentItems: SessionComposerExpandedProps["customAgentItems"];
  skillItems: NonNullable<ChatWindowProps["skillPickerProps"]>["items"];
  attachmentItems: SessionComposerExpandedProps["attachmentItems"];
  additionalDirectoryItems: AdditionalDirectoryItem[];
  draft: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerExpandedProps["composerSendability"];
  sendButtonTitle: string | undefined;
  isComposerBlockedFeedbackActive: boolean;
  approvalOptions: SessionComposerExpandedProps["approvalOptions"];
  reviewerOptions: SessionComposerExpandedProps["reviewerOptions"];
  selectedApprovalMode: SessionComposerExpandedProps["selectedApprovalMode"];
  selectedCodexReviewer: SessionComposerExpandedProps["selectedCodexReviewer"];
  sandboxOptions: SessionComposerExpandedProps["sandboxOptions"];
  selectedCodexSandboxMode: SessionComposerExpandedProps["selectedCodexSandboxMode"];
  speedOptions: SessionComposerExpandedProps["speedOptions"];
  selectedCodexSpeed: SessionComposerExpandedProps["selectedCodexSpeed"];
  modelOptions: SessionComposerExpandedProps["modelOptions"];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: SessionComposerExpandedProps["reasoningOptions"];
  selectedReasoningEffort: string;
  attachmentCount: number;
  isContextRailResizing: boolean;
  isContextRailVisible: boolean;
  activeContextPaneTab: ContextPaneTabKey;
  availableContextPaneTabs: ContextPaneTabKey[];
  contextPaneProjection: SessionContextPaneProps["contextPaneProjection"];
  latestCommandView: SessionContextPaneProps["latestCommandView"];
  runningDetailsEntries: SessionContextPaneProps["runningDetailsEntries"];
  liveRunReasoningText: SessionContextPaneProps["liveRunReasoningText"];
  backgroundTasks: SessionContextPaneProps["backgroundTasks"];
  companionGroupMonitorEntries: SessionContextPaneProps["companionGroupMonitorEntries"];
  isCopilotSession: boolean;
  selectedCopilotRemainingPercentLabel: string;
  selectedCopilotRemainingRequestsLabel: string;
  selectedCopilotQuotaResetLabel: string;
  selectedSessionContextTelemetry: SessionContextPaneProps["selectedSessionContextTelemetry"];
  selectedSessionContextTelemetryProjection: SessionContextPaneProps["selectedSessionContextTelemetryProjection"];
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
  toastMessage: string;
  toastTone: "error" | "success";
  onToggleHeaderSplitter: () => void;
  onOpenAuditLog: () => void;
  onOpenTerminal: () => void;
  onOpenSessionFilesTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onOpenWorktree: () => void;
  onOpenSessionFilesExplorer: () => void;
  onOpenMergeWindow: () => void;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: SessionMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"];
  onOpenInlinePath: (target: string) => void;
  onCopyMessageText: SessionMessageColumnProps["onCopyMessageText"];
  onQuoteMessageText: SessionMessageColumnProps["onQuoteMessageText"];
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
  onAddAdditionalDirectory: () => void;
  onToggleAdditionalDirectoryList: () => void;
  onJumpToMessageListBottom: () => void;
  onSelectCustomAgent: SessionComposerExpandedProps["onSelectCustomAgent"];
  onSelectSkill: NonNullable<ChatWindowProps["skillPickerProps"]>["onSelectSkill"];
  onRemoveAttachment: SessionComposerExpandedProps["onRemoveAttachment"];
  onRemoveAdditionalDirectory: (path: string) => void;
  onDraftChange: SessionComposerExpandedProps["onDraftChange"];
  onDraftFocus: () => void;
  onDraftKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onDraftPaste: SessionComposerExpandedProps["onDraftPaste"];
  onDraftSelect: (selectionStart: number) => void;
  onDraftCompositionStart: () => void;
  onDraftCompositionEnd: () => void;
  onSendOrCancel: () => void;
  onChangeApprovalMode: SessionComposerExpandedProps["onChangeApprovalMode"];
  onChangeCodexReviewer: SessionComposerExpandedProps["onChangeCodexReviewer"];
  onChangeCodexSandboxMode: SessionComposerExpandedProps["onChangeCodexSandboxMode"];
  onChangeCodexSpeed: SessionComposerExpandedProps["onChangeCodexSpeed"];
  onChangeModel: SessionComposerExpandedProps["onChangeModel"];
  onChangeReasoningEffort: SessionComposerExpandedProps["onChangeReasoningEffort"];
  onStartContextRailResize: PointerEventHandler<HTMLButtonElement>;
  onStartActionDockResize: PointerEventHandler<HTMLButtonElement>;
  onToggleActionDock: () => void;
  onToggleContextRailVisibility: () => void;
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

export function buildCompanionChatWindowProps(input: CompanionChatProjectionInput): ChatWindowProps {
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
    taskTitle: input.session.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isSelectedSessionRunning,
    isAuxiliaryMode: input.isAuxiliaryMode,
    canDeleteSession: false,
    canViewAuditLog: true,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenTerminal,
    onOpenSessionFilesExplorer: input.onOpenSessionFilesExplorer,
    onOpenSessionFilesTerminal: input.onOpenSessionFilesTerminal,
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: () => {},
    onOpenWorkspaceExplorer: input.onOpenWorktree,
    isWorkspaceExplorerDisabled: input.isHeaderActionDisabled,
    actions: (
      <>
        {input.headerActions}
        {input.isAuxiliaryMode ? null : (
          <button
            className="drawer-toggle compact secondary"
            type="button"
            disabled={input.isHeaderActionDisabled || input.session.status !== "active"}
            onClick={input.onOpenMergeWindow}
          >
            Merge
          </button>
        )}
      </>
    ),
  });

  const composerDockProps = buildLiveSessionComposerDockProps(
    buildLiveSessionCommonComposerDockInput({
      isRunning: input.isSelectedSessionRunning,
      ...COMPANION_PENDING_RUN_INDICATOR_TEXT,
      modeLabel: resolveAuxiliaryModeLabel(input.isAuxiliaryMode),
      composerBlocked: input.composerBlocked,
      canSelectCustomAgent: input.session.provider === "copilot",
      isAgentPickerOpen: input.isAgentPickerOpen,
      isSkillPickerOpen: input.isSkillPickerOpen,
      isAdditionalDirectoryListOpen: input.isAdditionalDirectoryListOpen,
      selectedCustomAgentLabel: input.selectedCustomAgentLabel,
      selectedCustomAgentTitle: input.selectedCustomAgentTitle,
      additionalDirectoryCount: (input.session.allowedAdditionalDirectories ?? []).length,
      isMessageListFollowing: input.isMessageListFollowing,
      isCustomAgentListLoading: input.isCustomAgentListLoading,
      customAgentItems: input.customAgentItems,
      attachmentItems: input.attachmentItems,
      draft: input.draft,
      composerTextareaRef: input.composerTextareaRef,
      isComposerDisabled: input.isComposerDisabled,
      isSendDisabled: input.isSendDisabled,
      composerSendability: input.composerSendability,
      sendButtonTitle: input.sendButtonTitle,
      isComposerBlockedFeedbackActive: input.isComposerBlockedFeedbackActive,
      approvalOptions: input.approvalOptions,
      selectedApprovalMode: input.selectedApprovalMode,
      reviewerOptions: input.reviewerOptions,
      selectedCodexReviewer: input.selectedCodexReviewer,
      sandboxOptions: input.sandboxOptions,
      selectedCodexSandboxMode: input.selectedCodexSandboxMode,
      speedOptions: input.speedOptions,
      selectedCodexSpeed: input.selectedCodexSpeed,
      modelOptions: input.modelOptions,
      selectedModel: input.selectedModel,
      selectedModelFallbackLabel: input.selectedModelFallbackLabel,
      reasoningOptions: input.reasoningOptions,
      selectedReasoningEffort: input.selectedReasoningEffort,
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
      onAddAdditionalDirectory: input.onAddAdditionalDirectory,
      onToggleAdditionalDirectoryList: input.onToggleAdditionalDirectoryList,
      onExpandActionDock: input.onToggleActionDock,
      onJumpToBottom: input.onJumpToMessageListBottom,
      onSelectCustomAgent: input.onSelectCustomAgent,
      onRemoveAttachment: input.onRemoveAttachment,
      onDraftChange: input.onDraftChange,
      onDraftFocus: input.onDraftFocus,
      onDraftKeyDown: input.onDraftKeyDown,
      onDraftPaste: input.onDraftPaste,
      onDraftSelect: input.onDraftSelect,
      onDraftCompositionStart: input.onDraftCompositionStart,
      onDraftCompositionEnd: input.onDraftCompositionEnd,
      onSendOrCancel: input.onSendOrCancel,
      onChangeApprovalMode: input.onChangeApprovalMode,
      onChangeCodexReviewer: input.onChangeCodexReviewer,
      onChangeCodexSandboxMode: input.onChangeCodexSandboxMode,
      onChangeCodexSpeed: input.onChangeCodexSpeed,
      onChangeModel: input.onChangeModel,
      onChangeReasoningEffort: input.onChangeReasoningEffort,
    }),
  );

  const chatBodyProps = buildLiveSessionChatBodyProps({
    messageColumn: buildLiveSessionCommonMessageColumnProps({
      sessionId: input.session.id,
      character: input.character,
      messages: input.displayedMessages ?? input.session.messages,
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
      getChangedFilesEmptyText: getCompanionChangedFilesEmptyText,
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
    backgroundTasks: input.backgroundTasks,
    companionGroupMonitorEntries: input.companionGroupMonitorEntries,
    selectedSessionLiveRunErrorMessage: input.liveRunErrorMessage,
    isSelectedSessionRunning: input.isSelectedSessionRunning,
    isCopilotSession: input.isCopilotSession,
    selectedCopilotRemainingPercentLabel: input.selectedCopilotRemainingPercentLabel,
    selectedCopilotRemainingRequestsLabel: input.selectedCopilotRemainingRequestsLabel,
    selectedCopilotQuotaResetLabel: input.selectedCopilotQuotaResetLabel,
    selectedSessionContextTelemetry: input.selectedSessionContextTelemetry,
    selectedSessionContextTelemetryProjection: input.selectedSessionContextTelemetryProjection,
    contextEmptyText: "context usage はまだありません。",
    onCycleContextPaneTab: input.onCycleContextPaneTab,
    onOpenCompanionReview: input.onOpenCompanionReview,
  });

  return buildLiveSessionWindowShellProps({
    mode: "companion",
    baseClassName: "theme-accent",
    style: { ...input.themeStyle, ...input.dockLayoutStyle },
    layoutRef: input.layoutRef,
    headerDockRef: input.headerDockRef,
    actionDockRef: input.actionDockRef,
    isHeaderExpanded: input.isHeaderExpanded,
    workbenchRef: input.workbenchRef,
    workbenchStyle: input.workbenchStyle,
    layoutPriority: input.layoutPriority,
    onActivateSidePanePriority: input.onActivateSidePanePriority,
    onActivateDockPriority: input.onActivateDockPriority,
    headerProps,
    messageColumnProps: chatBodyProps.messageColumnProps,
    errorNotices: buildLiveSessionErrorNotices({
      composerFeedback: input.composerSendability,
    }),
    recoveryActions,
    isActionDockExpanded: input.isActionDockExpanded,
    headerSplitterProps: {
      isPanelExpanded: input.isHeaderExpanded,
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
    additionalDirectoryListProps: {
      isOpen: input.isAdditionalDirectoryListOpen,
      items: input.additionalDirectoryItems,
      isInteractionDisabled: input.isSelectedSessionRunning || input.composerBlocked,
      onRemove: input.onRemoveAdditionalDirectory,
    },
    skillPickerProps: {
      isOpen: input.isSkillPickerOpen,
      isLoading: input.isSkillListLoading,
      errorMessage: input.skillListError,
      items: input.skillItems,
      onSelectSkill: input.onSelectSkill,
      onDismiss: input.onToggleSkillPicker,
    },
    compactActionDockProps: chatBodyProps.compactActionDockProps,
    splitterProps: chatBodyProps.splitterProps,
    isRightPaneVisible: input.isContextRailVisible,
    rightPaneProps,
    modals: (
      <ChatSessionModals {...input}>
        {input.toastMessage ? (
          <div className={`companion-session-toast ${input.toastTone}`}>
            {input.toastMessage}
          </div>
        ) : null}
      </ChatSessionModals>
    ),
    isAuxiliaryMode: input.isAuxiliaryMode,
  });
}
