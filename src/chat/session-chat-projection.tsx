import type { CSSProperties, KeyboardEventHandler, PointerEventHandler, RefObject, UIEventHandler } from "react";

import type { CharacterProfile, DiffPreviewPayload, Message, MessageArtifact } from "../app-state.js";
import type { CharacterUpdateMemoryExtract } from "../character-update-state.js";
import type { HomeMonitorEntry } from "../home/home-session-projection.js";
import type { Session } from "../session-state.js";
import {
  CharacterUpdateContextPane,
  SessionAuditLogModal,
  SessionContextPane,
  SessionDiffModal,
  SessionPaneErrorBoundary,
  SessionRetryBanner,
  type CharacterUpdateContextPaneProps,
  type SessionActionDockCompactRowProps,
  type SessionAuditLogModalProps,
  type SessionComposerExpandedProps,
  type SessionContextPaneProps,
  type SessionHeaderProps,
  type SessionMessageColumnProps,
  type SessionRetryBannerProps,
} from "../session-components.js";
import type { ContextPaneTabKey } from "../session-ui-projection.js";
import type { ChatWindowProps } from "./chat-window.js";

export type AgentSessionChatProjectionInput = {
  selectedSession: Session;
  selectedSessionCharacter: CharacterProfile;
  displayedMessages: Message[];
  expandedArtifacts: Record<string, boolean>;
  sessionThemeStyle: CSSProperties | undefined;
  sessionWorkbenchRef: RefObject<HTMLDivElement | null>;
  sessionWorkbenchStyle: CSSProperties | undefined;
  isSessionHeaderExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isSelectedSessionRunning: boolean;
  isCharacterUpdateSession: boolean;
  messageListRef: RefObject<HTMLDivElement | null>;
  pendingRunIndicatorAnnouncement: string;
  pendingRunIndicatorText: string;
  liveApprovalRequest: SessionMessageColumnProps["liveApprovalRequest"];
  approvalActionRequestId: string | null;
  liveElicitationRequest: SessionMessageColumnProps["liveElicitationRequest"];
  elicitationActionRequestId: string | null;
  liveRunAssistantText: string;
  hasLiveRunAssistantText: boolean;
  liveRunErrorMessage: string;
  isMessageListFollowing: boolean;
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
  activeCharacterUpdatePaneTab: CharacterUpdateContextPaneProps["activePaneTab"];
  latestCommandView: SessionContextPaneProps["latestCommandView"];
  runningDetailsEntries: SessionContextPaneProps["runningDetailsEntries"];
  selectedCharacterUpdateMemoryExtract: CharacterUpdateMemoryExtract | null;
  isCharacterUpdateMemoryExtractLoading: boolean;
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
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  auditLogsOpen: boolean;
  displayedSessionAuditLogs: SessionAuditLogModalProps["entries"];
  auditLogDetails: SessionAuditLogModalProps["details"];
  auditLogOperationDetails: SessionAuditLogModalProps["operationDetails"];
  auditLogsHasMore: boolean;
  auditLogsLoading: boolean;
  auditLogsTotal: number;
  auditLogsErrorMessage: string | null;
  onToggleHeaderExpanded: () => void;
  onOpenAuditLog: () => void;
  onOpenSessionTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onDeleteSession: () => void;
  onOpenSessionExplorer: () => void;
  onMessageListScroll: UIEventHandler<HTMLDivElement>;
  onToggleArtifact: (artifactKey: string) => void;
  onLoadArtifactDetail: (messageIndex: number) => Promise<MessageArtifact | null>;
  onOpenDiff: SessionMessageColumnProps["onOpenDiff"];
  onResolveLiveApproval: SessionMessageColumnProps["onResolveLiveApproval"];
  onResolveLiveElicitation: SessionMessageColumnProps["onResolveLiveElicitation"];
  onOpenInlinePath: (target: string) => void;
  getChangedFilesEmptyText: SessionMessageColumnProps["getChangedFilesEmptyText"];
  onToggleRetryDetails: () => void;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickImage: () => void;
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
  onSelectCharacterUpdatePaneTab: CharacterUpdateContextPaneProps["onSelectPaneTab"];
  onRefreshCharacterUpdateMemoryExtract: () => void;
  onCopyCharacterUpdateMemoryExtract: () => void;
  onCycleContextPaneTab: (direction: -1 | 1) => void;
  onOpenCompanionReview: (sessionId: string) => void;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  onLoadMoreAuditLogs: () => void;
  onLoadAuditLogDetail: SessionAuditLogModalProps["onLoadDetail"];
  onLoadAuditLogOperationDetail: SessionAuditLogModalProps["onLoadOperationDetail"];
  onCloseAuditLog: () => void;
};

export function buildAgentSessionChatWindowProps(input: AgentSessionChatProjectionInput): ChatWindowProps {
  const headerProps: SessionHeaderProps = {
    taskTitle: input.selectedSession.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isSelectedSessionRunning,
    showTerminalButton: !input.isCharacterUpdateSession,
    onToggleExpanded: input.onToggleHeaderExpanded,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenSessionTerminal,
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: input.onDeleteSession,
    workspaceActions: !input.isCharacterUpdateSession ? (
      <button className="drawer-toggle compact secondary" type="button" onClick={input.onOpenSessionExplorer}>
        Explorer
      </button>
    ) : null,
  };

  const messageColumnProps: SessionMessageColumnProps = {
    sessionId: input.selectedSession.id,
    character: input.selectedSessionCharacter,
    messages: input.displayedMessages,
    expandedArtifacts: input.expandedArtifacts,
    messageListRef: input.messageListRef,
    isRunning: input.isSelectedSessionRunning,
    pendingRunIndicatorAnnouncement: input.pendingRunIndicatorAnnouncement,
    pendingRunIndicatorText: input.pendingRunIndicatorText,
    liveApprovalRequest: input.liveApprovalRequest,
    approvalActionRequestId: input.approvalActionRequestId,
    liveElicitationRequest: input.liveElicitationRequest,
    elicitationActionRequestId: input.elicitationActionRequestId,
    liveRunAssistantText: input.liveRunAssistantText,
    hasLiveRunAssistantText: input.hasLiveRunAssistantText,
    liveRunErrorMessage: input.liveRunErrorMessage,
    isMessageListFollowing: input.isMessageListFollowing,
    onMessageListScroll: input.onMessageListScroll,
    onToggleArtifact: input.onToggleArtifact,
    onLoadArtifactDetail: input.onLoadArtifactDetail,
    onOpenDiff: input.onOpenDiff,
    onResolveLiveApproval: input.onResolveLiveApproval,
    onResolveLiveElicitation: input.onResolveLiveElicitation,
    onOpenPath: input.onOpenInlinePath,
    getChangedFilesEmptyText: input.getChangedFilesEmptyText,
  };

  const composerProps: SessionComposerExpandedProps = {
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
    composerBlocked: input.composerBlocked,
    canSelectCustomAgent: !input.isCharacterUpdateSession && input.selectedSession.provider === "copilot",
    showCustomAgentPicker: !input.isCharacterUpdateSession,
    showSkillPicker: !input.isCharacterUpdateSession,
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
  };

  const compactActionDockProps: SessionActionDockCompactRowProps = {
    draft: input.draft,
    actionDockCompactPreview: input.actionDockCompactPreview,
    attachmentCount: input.attachmentCount,
    isRunning: input.selectedSession.runState === "running",
    isSendDisabled: input.isSendDisabled,
    showJumpToBottom: !input.isMessageListFollowing,
    sendButtonTitle: input.composerSendButtonTitle,
    onExpand: input.onExpandActionDock,
    onJumpToBottom: input.onJumpToMessageListBottom,
    onSendOrCancel: input.onSendOrCancel,
  };

  return {
    mode: "agent",
    className: input.isSessionHeaderExpanded ? "" : "session-page-header-collapsed",
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
      <button
        className={`session-workbench-splitter${input.isContextRailResizing ? " is-active" : ""}`}
        type="button"
        onPointerDown={input.onStartContextRailResize}
        aria-label="会話と command pane の幅を調整"
        title="左右の幅をドラッグで調整"
      />
    ),
    rightPane: (
      <SessionPaneErrorBoundary>
        {input.isCharacterUpdateSession ? (
          <CharacterUpdateContextPane
            taskTitle={input.selectedSession.taskTitle}
            isHeaderExpanded={input.isSessionHeaderExpanded}
            activePaneTab={input.activeCharacterUpdatePaneTab}
            latestCommandView={input.latestCommandView}
            runningDetailsEntries={input.runningDetailsEntries}
            selectedSessionLiveRunErrorMessage={input.liveRunErrorMessage}
            memoryExtract={input.selectedCharacterUpdateMemoryExtract}
            isLoadingMemoryExtract={input.isCharacterUpdateMemoryExtractLoading}
            onToggleHeaderExpanded={input.onToggleHeaderExpanded}
            onSelectPaneTab={input.onSelectCharacterUpdatePaneTab}
            onRefreshMemoryExtract={input.onRefreshCharacterUpdateMemoryExtract}
            onCopyMemoryExtract={input.onCopyCharacterUpdateMemoryExtract}
          />
        ) : (
          <SessionContextPane
            taskTitle={input.selectedSession.taskTitle}
            isHeaderExpanded={input.isSessionHeaderExpanded}
            activeContextPaneTab={input.activeContextPaneTab}
            availableContextPaneTabs={input.availableContextPaneTabs}
            contextPaneProjection={input.contextPaneProjection}
            latestCommandView={input.latestCommandView}
            runningDetailsEntries={input.runningDetailsEntries}
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
            onToggleHeaderExpanded={input.onToggleHeaderExpanded}
            onCycleContextPaneTab={input.onCycleContextPaneTab}
            onOpenCompanionReview={input.onOpenCompanionReview}
          />
        )}
      </SessionPaneErrorBoundary>
    ),
    modals: (
      <>
        <SessionDiffModal
          selectedDiff={input.selectedDiff}
          themeStyle={input.selectedDiffThemeStyle}
          onClose={input.onCloseDiff}
          onOpenDiffWindow={input.onOpenDiffWindow}
        />

        <SessionAuditLogModal
          open={input.auditLogsOpen}
          entries={input.displayedSessionAuditLogs}
          details={input.auditLogDetails}
          operationDetails={input.auditLogOperationDetails}
          hasMore={input.auditLogsHasMore}
          loadingMore={input.auditLogsLoading}
          total={input.auditLogsTotal}
          errorMessage={input.auditLogsErrorMessage}
          onLoadMore={input.onLoadMoreAuditLogs}
          onLoadDetail={input.onLoadAuditLogDetail}
          onLoadOperationDetail={input.onLoadAuditLogOperationDetail}
          onClose={input.onCloseAuditLog}
        />
      </>
    ),
  };
}
