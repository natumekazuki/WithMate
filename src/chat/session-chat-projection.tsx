import type { CSSProperties, KeyboardEventHandler, PointerEventHandler, ReactNode, RefObject, UIEventHandler } from "react";

import type { CharacterProfile, DiffPreviewPayload, Message, MessageArtifact } from "../app-state.js";
import type { HomeMonitorEntry } from "../home/home-session-projection.js";
import type { Session } from "../session-state.js";
import {
  SessionContextPane,
  SessionPaneErrorBoundary,
  SessionRetryBanner,
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
import { ChatWorkbenchSplitter, type ChatWindowProps } from "./chat-window.js";
import {
  buildChatPageClassName,
  buildLiveSessionCompactActionDockProps,
  buildLiveSessionComposerProps,
  buildLiveSessionMessageColumnProps,
  buildLiveSessionSplitterProps,
} from "./chat-window-adapter.js";

export type AgentSessionChatProjectionInput = {
  selectedSession: Session;
  selectedSessionCharacter: CharacterProfile;
  displayedMessages: Message[];
  displayedMessageKeys?: SessionMessageColumnProps["messageKeys"];
  displayedMessageGroups?: SessionMessageColumnProps["messageGroups"];
  expandedArtifacts: Record<string, boolean>;
  sessionThemeStyle: CSSProperties | undefined;
  sessionWorkbenchRef: RefObject<HTMLDivElement | null>;
  sessionWorkbenchStyle: CSSProperties | undefined;
  isSessionHeaderExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isSelectedSessionRunning: boolean;
  isSelectedSessionReadOnly: boolean;
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
  isMessageListFollowing: boolean;
  pendingMessageGroupId?: SessionMessageColumnProps["pendingMessageGroupId"];
  retryBanner: SessionRetryBannerProps["retryBanner"];
  isRetryDetailsOpen: boolean;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  composerBlocked: boolean;
  isAgentPickerOpen: boolean;
  isSkillPickerOpen: boolean;
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
  workspacePathMatchItems: SessionComposerExpandedProps["workspacePathMatchItems"];
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
  attachmentCount: number;
  isActionDockExpanded: boolean;
  isContextRailResizing: boolean;
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
  onToggleHeaderExpanded: () => void;
  onOpenAuditLog: () => void;
  onOpenSessionTerminal: () => void;
  onOpenSessionFilesTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onDeleteSession: () => void;
  onOpenSessionExplorer: () => void;
  onOpenSessionFilesExplorer: () => void;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: SessionMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"];
  onOpenInlinePath: (target: string) => void;
  getChangedFilesEmptyText: SessionMessageColumnProps["getChangedFilesEmptyText"];
  onCopyMessageText: NonNullable<SessionMessageColumnProps["onCopyMessageText"]>;
  onQuoteMessageText: NonNullable<SessionMessageColumnProps["onQuoteMessageText"]>;
  onToggleRetryDetails: () => void;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
  onAddToSessionFiles: NonNullable<SessionComposerExpandedProps["onAddToSessionFiles"]>;
  onPickSessionFiles: NonNullable<SessionComposerExpandedProps["onPickSessionFiles"]>;
  onToggleAgentPicker: () => void;
  onToggleSkillPicker: () => void;
  onAddAdditionalDirectory: () => void;
  onToggleAdditionalDirectoryList: () => void;
  onCollapseActionDock: () => void;
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
  onExpandActionDock: () => void;
  onSelectWorkspacePathMatch: SessionComposerExpandedProps["onSelectWorkspacePathMatch"];
  onActivateWorkspacePathMatch: SessionComposerExpandedProps["onActivateWorkspacePathMatch"];
  onChangeApprovalMode: SessionComposerExpandedProps["onChangeApprovalMode"];
  onChangeCodexSandboxMode: SessionComposerExpandedProps["onChangeCodexSandboxMode"];
  onChangeModel: SessionComposerExpandedProps["onChangeModel"];
  onChangeReasoningEffort: SessionComposerExpandedProps["onChangeReasoningEffort"];
  onStartContextRailResize: PointerEventHandler<HTMLButtonElement>;
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
  const headerProps: SessionHeaderProps = {
    taskTitle: input.selectedSession.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isSelectedSessionRunning,
    isReadOnly: input.isSelectedSessionReadOnly,
    showRenameButton: !input.isAuxiliaryMode,
    showDeleteButton: !input.isAuxiliaryMode,
    showTerminalButton: true,
    onToggleExpanded: input.onToggleHeaderExpanded,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenSessionTerminal,
    sessionFilesActions: (
      <>
        <button
          className="drawer-toggle compact secondary"
          type="button"
          onClick={input.onOpenSessionFilesExplorer}
          title="Open session files directory"
        >
          Explorer
        </button>
        <button
          className="drawer-toggle compact secondary"
          type="button"
          onClick={input.onOpenSessionFilesTerminal}
          title="Open terminal in session files directory"
        >
          Terminal
        </button>
      </>
    ),
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: input.onDeleteSession,
    actions: input.headerActions,
    workspaceActions: (
      <button className="drawer-toggle compact secondary" type="button" onClick={input.onOpenSessionExplorer}>
        Explorer
      </button>
    ),
  };

  const messageColumnProps = buildLiveSessionMessageColumnProps({
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
  });

  const composerProps = buildLiveSessionComposerProps({
    retryBanner: (
      <SessionRetryBanner
        retryBanner={input.retryBanner}
        isRetryDetailsOpen={input.isRetryDetailsOpen}
        isRetryActionDisabled={input.isRetryActionDisabled}
        isRetryEditDisabled={input.isRetryEditDisabled}
        isRetryDraftReplacePending={input.isRetryDraftReplacePending}
        onToggleDetails={input.onToggleRetryDetails}
        onResendLastMessage={input.onResendLastMessage}
        onEditLastMessage={input.onEditLastMessage}
        onConfirmRetryDraftReplace={input.onConfirmRetryDraftReplace}
        onCancelRetryDraftReplace={input.onCancelRetryDraftReplace}
        onOpenPath={input.onOpenInlinePath}
      />
    ),
    isRunning: input.selectedSession.runState === "running",
    pendingRunIndicatorAnnouncement: input.pendingRunIndicatorAnnouncement,
    pendingRunIndicatorText: input.pendingRunIndicatorText,
    modeLabel: input.isAuxiliaryMode ? "Auxiliary" : undefined,
    composerBlocked: input.composerBlocked,
    canSelectCustomAgent: input.selectedSession.provider === "copilot",
    showAttachmentControls: true,
    showCustomAgentPicker: true,
    showSkillPicker: true,
    isAgentPickerOpen: input.isAgentPickerOpen,
    isSkillPickerOpen: input.isSkillPickerOpen,
    isAdditionalDirectoryListOpen: input.isAdditionalDirectoryListOpen,
    selectedCustomAgentLabel: input.selectedSession.provider === "copilot" ? input.selectedCustomAgentLabel : "Agent",
    selectedCustomAgentTitle: input.selectedCustomAgentTitle,
    additionalDirectoryCount: input.selectedSession.allowedAdditionalDirectories.length,
    canCollapseActionDock: input.canCollapseActionDock,
    showJumpToBottom: !input.isMessageListFollowing,
    isCustomAgentListLoading: input.isCustomAgentListLoading,
    isSkillListLoading: input.isSkillListLoading,
    customAgentItems: input.customAgentItems,
    skillItems: input.skillItems,
    attachmentItems: input.composerAttachmentItems,
    additionalDirectoryItems: input.additionalDirectoryItems,
    workspacePathMatchItems: input.workspacePathMatchItems,
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
    onPickFile: input.onPickFile,
    onPickFolder: input.onPickFolder,
    onPickImage: input.onPickImage,
    onAddToSessionFiles: input.onAddToSessionFiles,
    onPickSessionFiles: input.onPickSessionFiles,
    onToggleAgentPicker: input.onToggleAgentPicker,
    onToggleSkillPicker: input.onToggleSkillPicker,
    onAddAdditionalDirectory: input.onAddAdditionalDirectory,
    onToggleAdditionalDirectoryList: input.onToggleAdditionalDirectoryList,
    onCollapse: input.onCollapseActionDock,
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
    onSelectWorkspacePathMatch: input.onSelectWorkspacePathMatch,
    onActivateWorkspacePathMatch: input.onActivateWorkspacePathMatch,
    onChangeApprovalMode: input.onChangeApprovalMode,
    onChangeCodexSandboxMode: input.onChangeCodexSandboxMode,
    onChangeModel: input.onChangeModel,
    onChangeReasoningEffort: input.onChangeReasoningEffort,
  });

  const compactActionDockProps = buildLiveSessionCompactActionDockProps({
    draft: input.draft,
    actionDockCompactPreview: input.actionDockCompactPreview,
    attachmentCount: input.attachmentCount,
    isRunning: input.selectedSession.runState === "running",
    pendingRunIndicatorAnnouncement: input.pendingRunIndicatorAnnouncement,
    pendingRunIndicatorText: input.pendingRunIndicatorText,
    modeLabel: input.isAuxiliaryMode ? "Auxiliary" : undefined,
    isSendDisabled: input.isSendDisabled,
    showJumpToBottom: !input.isMessageListFollowing,
    sendButtonTitle: input.composerSendButtonTitle,
    onExpand: input.onExpandActionDock,
    onJumpToBottom: input.onJumpToMessageListBottom,
    onSendOrCancel: input.onSendOrCancel,
  });

  return {
    mode: "agent",
    className: `${buildChatPageClassName({ isHeaderExpanded: input.isSessionHeaderExpanded })}${
      input.isAuxiliaryMode ? " auxiliary-session-mode" : ""
    }`,
    style: input.sessionThemeStyle,
    workbenchRef: input.sessionWorkbenchRef,
    workbenchStyle: input.sessionWorkbenchStyle,
    isHeaderExpanded: input.isSessionHeaderExpanded,
    headerProps,
    messageColumnProps,
    isActionDockExpanded: input.isActionDockExpanded,
    composerProps,
    compactActionDockProps,
    splitter: (
      <ChatWorkbenchSplitter {...buildLiveSessionSplitterProps({
        isContextRailResizing: input.isContextRailResizing,
        onStartContextRailResize: input.onStartContextRailResize,
      })} />
    ),
    rightPane: (
      <SessionPaneErrorBoundary>
        <SessionContextPane
          taskTitle={input.selectedSession.taskTitle}
          isHeaderExpanded={input.isSessionHeaderExpanded}
          activeContextPaneTab={input.activeContextPaneTab}
          availableContextPaneTabs={input.availableContextPaneTabs}
          contextPaneProjection={input.contextPaneProjection}
          latestCommandView={input.latestCommandView}
          runningDetailsEntries={input.runningDetailsEntries}
          liveRunReasoningText={input.liveRunReasoningText}
          backgroundTasks={input.selectedBackgroundTasks}
          companionGroupMonitorEntries={input.selectedCompanionGroupMonitorEntries}
          selectedSessionLiveRunErrorMessage={input.liveRunErrorMessage}
          isSelectedSessionRunning={input.isSelectedSessionRunning}
          isCopilotSession={input.isCopilotSession}
          selectedCopilotRemainingPercentLabel={input.selectedCopilotRemainingPercentLabel}
          selectedCopilotRemainingRequestsLabel={input.selectedCopilotRemainingRequestsLabel}
          selectedCopilotQuotaResetLabel={input.selectedCopilotQuotaResetLabel}
          selectedSessionContextTelemetry={input.selectedSessionContextTelemetry}
          selectedSessionContextTelemetryProjection={input.selectedSessionContextTelemetryProjection}
          contextEmptyText={input.selectedContextEmptyText}
          latestCommandEmptyText={input.latestCommandEmptyText}
          onToggleHeaderExpanded={input.onToggleHeaderExpanded}
          onCycleContextPaneTab={input.onCycleContextPaneTab}
          onOpenCompanionReview={input.onOpenCompanionReview}
        />
      </SessionPaneErrorBoundary>
    ),
    modals: <ChatSessionModals {...input} />,
  };
}
