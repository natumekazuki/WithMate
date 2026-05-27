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
import {
  SessionContextPane,
  SessionPaneErrorBoundary,
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
  buildLiveSessionChatBodyProps,
} from "./chat-window-adapter.js";
import { resolveChatHeaderVisibility } from "./chat-header-visibility.js";
import { buildLiveSessionRetryBanner } from "./retry-banner-adapter.js";
import { createSessionFilesActions } from "./session-files-actions.js";

export type CompanionChatProjectionInput = {
  session: CompanionSession;
  character: CharacterProfile;
  displayedMessages?: CompanionSession["messages"];
  displayedMessageKeys?: SessionMessageColumnProps["messageKeys"];
  displayedMessageGroups?: SessionMessageColumnProps["messageGroups"];
  expandedArtifacts: Record<string, boolean>;
  themeStyle: CSSProperties | undefined;
  workbenchRef: RefObject<HTMLDivElement | null>;
  workbenchStyle: CSSProperties | undefined;
  isHeaderExpanded: boolean;
  isEditingTitle: boolean;
  titleDraft: string;
  isRunning: boolean;
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
  isRetryDetailsOpen: boolean;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  isActionDockExpanded: boolean;
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
  attachmentItems: SessionComposerExpandedProps["attachmentItems"];
  additionalDirectoryItems: SessionComposerExpandedProps["additionalDirectoryItems"];
  workspacePathMatchItems: SessionComposerExpandedProps["workspacePathMatchItems"];
  draft: string;
  composerTextareaRef: RefObject<HTMLTextAreaElement | null>;
  isComposerDisabled: boolean;
  isSendDisabled: boolean;
  composerSendability: SessionComposerExpandedProps["composerSendability"];
  sendButtonTitle: string | undefined;
  isComposerBlockedFeedbackActive: boolean;
  approvalOptions: SessionComposerExpandedProps["approvalOptions"];
  selectedApprovalMode: SessionComposerExpandedProps["selectedApprovalMode"];
  sandboxOptions: SessionComposerExpandedProps["sandboxOptions"];
  selectedCodexSandboxMode: SessionComposerExpandedProps["selectedCodexSandboxMode"];
  modelOptions: SessionComposerExpandedProps["modelOptions"];
  selectedModel: string;
  selectedModelFallbackLabel: string;
  reasoningOptions: SessionComposerExpandedProps["reasoningOptions"];
  selectedReasoningEffort: string;
  actionDockCompactPreview: string;
  attachmentCount: number;
  isContextRailResizing: boolean;
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
  onToggleHeaderExpanded: () => void;
  onToggleContextPaneHeaderExpanded: () => void;
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

export function buildCompanionChatWindowProps(input: CompanionChatProjectionInput): ChatWindowProps {
  const headerProps: SessionHeaderProps = {
    taskTitle: input.session.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isRunning,
    ...resolveChatHeaderVisibility({
      isAuxiliaryMode: input.isAuxiliaryMode,
      canDeleteSession: false,
      canViewAuditLog: true,
    }),
    showTerminalButton: true,
    onToggleExpanded: input.onToggleHeaderExpanded,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenTerminal,
    sessionFilesActions: createSessionFilesActions({
      onOpenExplorer: input.onOpenSessionFilesExplorer,
      onOpenTerminal: input.onOpenSessionFilesTerminal,
    }),
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: () => {},
    workspaceActions: (
      <button
        className="drawer-toggle compact secondary"
        type="button"
        disabled={input.isHeaderActionDisabled}
        onClick={input.onOpenWorktree}
      >
        Explorer
      </button>
    ),
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
  };

  const chatBodyProps = buildLiveSessionChatBodyProps({
    messageColumn: {
      sessionId: input.session.id,
      character: input.character,
      messages: input.displayedMessages ?? input.session.messages,
      messageKeys: input.displayedMessageKeys,
      messageGroups: input.displayedMessageGroups,
      expandedArtifacts: input.expandedArtifacts,
      messageListRef: input.messageListRef,
      isRunning: input.isRunning,
      liveApprovalRequest: input.liveApprovalRequest,
      approvalActionRequestId: input.approvalActionRequestId,
      liveElicitationRequest: input.liveElicitationRequest,
      elicitationActionRequestId: input.elicitationActionRequestId,
      liveRunAssistantText: input.liveRunAssistantText,
      hasLiveRunAssistantText: input.liveRunAssistantText.length > 0,
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
      getChangedFilesEmptyText: () => "差分はまだないよ。",
      onCopyMessageText: input.onCopyMessageText,
      onQuoteMessageText: input.onQuoteMessageText,
    },
    composer: {
      retryBanner: buildLiveSessionRetryBanner({
        retryBanner: input.retryBanner,
        isRetryDetailsOpen: input.isRetryDetailsOpen,
        isRetryActionDisabled: input.isRetryActionDisabled,
        isRetryEditDisabled: input.isRetryEditDisabled,
        isRetryDraftReplacePending: input.isRetryDraftReplacePending,
        onToggleDetails: input.onToggleRetryDetails,
        onResendLastMessage: input.onResendLastMessage,
        onEditLastMessage: input.onEditLastMessage,
        onConfirmRetryDraftReplace: input.onConfirmRetryDraftReplace,
        onCancelRetryDraftReplace: input.onCancelRetryDraftReplace,
        onOpenPath: input.onOpenInlinePath,
      }),
      isRunning: input.isRunning,
      pendingRunIndicatorAnnouncement: "Companion が実行中",
      pendingRunIndicatorText: "Companion が応答を生成中...",
      modeLabel: input.isAuxiliaryMode ? "Auxiliary" : undefined,
      composerBlocked: input.composerBlocked,
      canSelectCustomAgent: input.session.provider === "copilot",
      showCustomAgentPicker: true,
      showSkillPicker: true,
      isAgentPickerOpen: input.isAgentPickerOpen,
      isSkillPickerOpen: input.isSkillPickerOpen,
      isAdditionalDirectoryListOpen: input.isAdditionalDirectoryListOpen,
      selectedCustomAgentLabel: input.selectedCustomAgentLabel,
      selectedCustomAgentTitle: input.selectedCustomAgentTitle,
      additionalDirectoryCount: (input.session.allowedAdditionalDirectories ?? []).length,
      canCollapseActionDock: input.canCollapseActionDock,
      showJumpToBottom: !input.isMessageListFollowing,
      isCustomAgentListLoading: input.isCustomAgentListLoading,
      isSkillListLoading: input.isSkillListLoading,
      customAgentItems: input.customAgentItems,
      skillItems: input.skillItems,
      attachmentItems: input.attachmentItems,
      additionalDirectoryItems: input.additionalDirectoryItems,
      workspacePathMatchItems: input.workspacePathMatchItems,
      draft: input.draft,
      composerTextareaRef: input.composerTextareaRef,
      isComposerDisabled: input.isComposerDisabled,
      isSendDisabled: input.isSendDisabled,
      composerSendability: input.composerSendability,
      sendButtonTitle: input.sendButtonTitle,
      isComposerBlockedFeedbackActive: input.isComposerBlockedFeedbackActive,
      approvalOptions: input.approvalOptions,
      selectedApprovalMode: input.selectedApprovalMode,
      sandboxOptions: input.sandboxOptions,
      selectedCodexSandboxMode: input.selectedCodexSandboxMode,
      modelOptions: input.modelOptions,
      selectedModel: input.selectedModel,
      selectedModelFallbackLabel: input.selectedModelFallbackLabel,
      reasoningOptions: input.reasoningOptions,
      selectedReasoningEffort: input.selectedReasoningEffort,
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
    },
    compactActionDock: {
      draft: input.draft,
      actionDockCompactPreview: input.actionDockCompactPreview,
      attachmentCount: input.attachmentCount,
      isRunning: input.isRunning,
      pendingRunIndicatorAnnouncement: "Companion が実行中",
      pendingRunIndicatorText: "Companion が応答を生成中...",
      modeLabel: input.isAuxiliaryMode ? "Auxiliary" : undefined,
      isSendDisabled: input.isSendDisabled,
      showJumpToBottom: !input.isMessageListFollowing,
      sendButtonTitle: input.sendButtonTitle,
      onExpand: input.onExpandActionDock,
      onJumpToBottom: input.onJumpToMessageListBottom,
      onSendOrCancel: input.onSendOrCancel,
    },
    splitter: {
      isContextRailResizing: input.isContextRailResizing,
      onStartContextRailResize: input.onStartContextRailResize,
    },
  });

  return {
    mode: "companion",
    className: `${buildChatPageClassName({
      baseClassName: "theme-accent",
      isHeaderExpanded: input.isHeaderExpanded,
    })}${input.isAuxiliaryMode ? " auxiliary-session-mode" : ""}`,
    style: input.themeStyle,
    workbenchRef: input.workbenchRef,
    workbenchStyle: input.workbenchStyle,
    isHeaderExpanded: input.isHeaderExpanded,
    headerProps,
    messageColumnProps: chatBodyProps.messageColumnProps,
    isActionDockExpanded: input.isActionDockExpanded,
    composerProps: chatBodyProps.composerProps,
    compactActionDockProps: chatBodyProps.compactActionDockProps,
    splitter: <ChatWorkbenchSplitter {...chatBodyProps.splitterProps} />,
    rightPane: (
      <SessionPaneErrorBoundary>
        <SessionContextPane
          taskTitle={input.session.taskTitle}
          isHeaderExpanded={input.isHeaderExpanded}
          activeContextPaneTab={input.activeContextPaneTab}
          availableContextPaneTabs={input.availableContextPaneTabs}
          contextPaneProjection={input.contextPaneProjection}
          latestCommandView={input.latestCommandView}
          runningDetailsEntries={input.runningDetailsEntries}
          liveRunReasoningText={input.liveRunReasoningText}
          backgroundTasks={input.backgroundTasks}
          companionGroupMonitorEntries={input.companionGroupMonitorEntries}
          selectedSessionLiveRunErrorMessage={input.liveRunErrorMessage}
          isSelectedSessionRunning={input.isRunning}
          isCopilotSession={input.isCopilotSession}
          selectedCopilotRemainingPercentLabel={input.selectedCopilotRemainingPercentLabel}
          selectedCopilotRemainingRequestsLabel={input.selectedCopilotRemainingRequestsLabel}
          selectedCopilotQuotaResetLabel={input.selectedCopilotQuotaResetLabel}
          selectedSessionContextTelemetry={input.selectedSessionContextTelemetry}
          selectedSessionContextTelemetryProjection={input.selectedSessionContextTelemetryProjection}
          contextEmptyText="context usage はまだありません。"
          onToggleHeaderExpanded={input.onToggleContextPaneHeaderExpanded}
          onCycleContextPaneTab={input.onCycleContextPaneTab}
          onOpenCompanionReview={input.onOpenCompanionReview}
        />
      </SessionPaneErrorBoundary>
    ),
    modals: (
      <ChatSessionModals {...input}>
        {input.toastMessage ? (
          <div className={`companion-session-toast ${input.toastTone}`}>
            {input.toastMessage}
          </div>
        ) : null}
      </ChatSessionModals>
    ),
  };
}
