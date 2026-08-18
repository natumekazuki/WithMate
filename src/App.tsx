import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type SetStateAction,
} from "react";

import {
  type ComposerPreview,
  currentTimestampLabel,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  getSessionIdFromLocation,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
  type LiveSessionRunState,
  type RunSessionTurnRequest,
} from "./app-state.js";
import {
  buildSessionWithAddedAdditionalDirectory,
  buildSessionWithRemovedAdditionalDirectory,
  resolveAdditionalDirectoryPickerBase,
  runAdditionalDirectoryRemovalOperation,
  runPickedAdditionalDirectoryOperation,
} from "./additional-directory-state.js";
import {
  buildSessionWithApprovalMode,
  buildSessionWithCodexSandboxMode,
  buildSessionWithModelChange,
  buildSessionWithReasoningEffort,
} from "./runtime-option-state.js";
import { DEFAULT_CHARACTER_SESSION_COPY, type CharacterProfile } from "./character-state.js";
import type { CompanionSessionSummary } from "./companion-state.js";
import { startCompanionSessionSummariesSubscription } from "./companion-session-summary-subscription.js";
import { startOpenCompanionReviewWindowIdsSubscription } from "./open-companion-review-window-subscription.js";
import { startAppSettingsSubscription } from "./app-settings-subscription.js";
import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { resolveMicrocopy, type MicrocopySlot } from "./microcopy-state.js";
import {
  type DiffPreviewPayload,
  type Message,
  applyCopilotCustomAgentSelection,
  isReadOnlySession,
  type Session,
} from "./session-state.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import { startModelCatalogSubscription } from "./model-catalog-subscription.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import {
  buildAuxiliaryAwareSendOrCancelHandler,
  buildAuxiliarySessionCancelTarget,
  buildRunningSessionCancelTarget,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
  runRunningSessionCancelOperation,
} from "./chat/send-or-cancel.js";
import { buildAuxiliaryAwareRuntimeOptionChangeHandler } from "./chat/auxiliary-runtime-option-routing.js";
import {
  approvalModeLabel,
} from "./ui-utils.js";
import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "./composer-textarea-focus.js";
import { buildRuntimeSelectionOptions } from "./runtime-selection-options.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandProjection,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  type ContextPaneTabKey,
  resolveAvailableContextPaneTabs,
} from "./session-ui-projection.js";
import { buildMainAuxiliaryRuntimeSession } from "./auxiliary-runtime-projection.js";
import {
  useMainAuxiliaryRuntimeSession,
  useMessageListAuxiliarySessions,
} from "./auxiliary-render-projections.js";
import { ChatWindow, ChatWindowStatusScreen } from "./chat/chat-window.js";
import type { SessionComposerExpandedProps } from "./session-components.js";
import { resolveSkillDiscoveryRequest } from "./skill-discovery-request.js";
import { applySessionDocumentTitle, resolveAgentSessionDocumentTitle } from "./chat/window-title.js";
import { resolveAuditLogOwner } from "./chat/audit-log-owner.js";
import {
  buildAuxiliaryLaunchProviderItems,
  createAuxiliaryLaunchDialogCloseHandler,
  createAuxiliaryLaunchDialogOpenHandler,
  createAuxiliaryLaunchProviderSelectHandler,
  resolveAuxiliaryLaunchStartProvider,
} from "./chat/auxiliary-launch-state.js";
import { AuxiliaryLaunchProviderDialog } from "./chat/AuxiliaryLaunchProviderDialog.js";
import { useAuxiliaryLaunchDialogState } from "./chat/use-auxiliary-launch-dialog-state.js";
import {
  createAuxiliaryHeaderActions,
  resolveAuxiliaryHeaderActionState,
} from "./chat/chat-header-actions.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
  resolveComposerSendPreflight,
  type ComposerSendabilityState,
} from "./session-composer-feedback.js";
import {
  buildActionDockRuntimeState,
  shouldFocusComposerForActionDockExpand,
} from "./action-dock-state.js";
import {
  buildCustomAgentMatchDisplay,
  buildSelectedCustomAgentDisplay,
  buildSkillMatchDisplay,
} from "./session-composer-selection.js";
import {
  runAuxiliaryCustomAgentPatchOperation,
  runAuxiliaryCustomAgentSelectionOperation,
} from "./auxiliary-custom-agent-operation.js";
import { runAuxiliarySkillPromptInsertionOperation } from "./auxiliary-skill-prompt-operation.js";
import {
  buildAdditionalDirectoryItems,
  buildComposerAttachmentItems,
  buildComposerReferenceInsertionState,
  pickComposerReferencePath,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "./session-composer-paths.js";
import {
  applyComposerDraftClearCommand,
  applyComposerDraftChangeCommand,
  buildComposerDraftKeyDownHandler,
  buildOnDraftCompositionHandlers,
  buildOnDraftSelectHandler,
} from "./chat/composer-draft-handlers.js";
import {
  createEmptyComposerPreview,
  resolveComposerPreviewDisplay,
} from "./composer-preview-config.js";
import {
  useChatLayoutPresentation,
  useSessionSidePanes,
  useSessionMessageListFollowing,
  useSessionVerticalDockResize,
} from "./session-chat-layout-hooks.js";
import { persistChatLayoutPreference } from "./chat/chat-layout-preference.js";
import type { SessionSidePane } from "./session-side-pane.js";
import { SessionFileExplorerPane } from "./file-explorer/SessionFileExplorerPane.js";
import { SessionDiffPreview, SessionFilePreview } from "./file-explorer/SessionFilePreview.js";
import { PromptTemplateWorkspace } from "./prompt-templates/PromptTemplateWorkspace.js";
import { insertComposerTextAtSelection } from "./chat/message-text-actions.js";
import { FileRootChangesPane } from "./file-explorer/FileRootChangesPane.js";
import type {
  FileRootFileDiffRequest,
  FileRootGitChangeScope,
  SessionFileRootResourceRequest,
} from "./file-explorer/file-explorer-contract.js";
import { buildFileRootDiffPreviewWindowRequest } from "./file-explorer/file-explorer-contract.js";
import { projectFileRootDiffAvailability } from "./file-explorer/file-preview-utils.js";
import {
  acknowledgePreviewChatMessageCount,
  beginPreviewChatActivity,
  endPreviewChatActivity,
  observePreviewChatMessageCount,
} from "./file-explorer/preview-chat-activity.js";
import {
  createOwnedPendingLiveSessionRunState,
  replaceLiveRunAfterResolvedRequest,
  resolveSessionRunErrorMessage,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
import {
  LatestRequestRevision,
  SessionSubmitCoordinator,
  StateMutationRevision,
  createSessionTurnClientRequestId,
  fingerprintSessionDraft,
  mergeRefetchedSessionProjection,
} from "./session-submit-coordinator.js";
import { buildAgentSessionChatWindowProps } from "./chat/session-chat-projection.js";
import type {
  SessionTurnExecutionProjection,
  SessionQueuedTurn,
  SessionRunningProjectionBarrier,
  SessionTurnAdmissionError,
} from "./session-turn-execution.js";
import {
  applySessionExecutionChangedEventWithBarrier,
  createSessionRunningProjectionBarrier,
  mergeTurnExecutionRefreshWithBarrier,
} from "./session-turn-execution.js";
import { appendTurnExecutionsToMessageList } from "./session-queued-turn-projection.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { ScheduleWorkspace } from "./session-schedule-workspace.js";
import {
  buildScheduleDraftComposerState,
  resolveSystemScheduleTimeZone,
  type ScheduleDraftProjection,
  type ScheduleSummaryProjection,
} from "./session-schedule-ui-projection.js";
import type { SessionScheduleProjection, SessionScheduleSummary, SessionScheduleTrigger, SessionScheduleTurn } from "./session-schedule.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "./open-path-result.js";
import { buildCompanionGroupMonitorEntries } from "./home/home-session-projection.js";
import {
  INITIAL_SESSION_WORKSPACE_AVAILABILITY,
  applySessionWorkspaceAvailabilityResult,
  beginSessionWorkspaceAvailabilityCheck,
  isSessionWorkspaceAvailable,
  resolveSessionWorkspaceBlockedReason,
  resolveSessionWorkspaceUnavailableMessage,
} from "./session-workspace-availability.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import {
  type AuxiliarySession,
} from "./auxiliary-session-state.js";
import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "./auxiliary-runtime-option-operation.js";
import {
  clearAuxiliarySessionsLoadState,
  createAuxiliaryLoadRevisionGuard,
  runActiveAuxiliarySessionLoadAndApply,
  runActiveAuxiliarySessionRefreshAndApply,
  runClosedAuxiliarySessionsLoadAndApply,
} from "./auxiliary-session-refresh-operation.js";
import {
  createComposerPreviewRequest,
} from "./chat/use-composer-preview-resolution.js";
import { createPastedSessionAttachmentHandler } from "./chat/composer-paste-handlers.js";
import {
  resolveOwnedProviderQuotaTelemetry,
  resolveOwnedSessionContextTelemetry,
  type ProviderOwnedQuotaTelemetry,
  type SessionOwnedContextTelemetry,
} from "./session-telemetry-state.js";
import {
  startProviderQuotaTelemetrySubscription,
  startSessionContextTelemetrySubscription,
} from "./session-telemetry-subscription.js";
import { startLiveSessionRunSubscription } from "./session-live-run-subscription.js";
import {
  createCopyMessageTextHandler,
} from "./chat/message-text-actions.js";
import { isTerminalAuditLogPhase } from "./audit-log-phase.js";
import {
  applyRetryDraftRestoreCommand,
  createCancelRetryDraftReplaceHandler,
  createRetryDraftReplaceConfirmationHandler,
  createRetryEditHandler,
  isRetryActionDisabled as resolveRetryActionDisabled,
  resolveRetryBannerSource,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
  type RetryBannerKind,
  type RetryBannerState,
} from "./chat/retry-state.js";
import {
  buildMessageListProjection,
  hasPersistedLiveAssistantMessage,
  loadProjectedMessageArtifact,
  resolveLiveAssistantMessageIndex,
  resolvePendingAuxiliaryMessageGroupId,
  shouldProjectLiveAssistantBridge,
  type LiveAssistantProjection,
} from "./auxiliary-session-message-projection.js";
import {
  runAuxiliaryDraftChangeAndSaveOperation,
  runAuxiliaryDraftPatchOperation,
} from "./auxiliary-draft-save-context.js";
import {
  createGuardedActiveAuxiliarySessionUpdater,
  enqueueAuxiliarySessionSaveWithQueue,
  syncActiveAuxiliarySessionRef,
} from "./auxiliary-session-update-operation.js";
import {
  runAddAuxiliaryAdditionalDirectoryOperationWithApi,
  runRemoveAuxiliaryAdditionalDirectoryOperation,
} from "./auxiliary-additional-directory-operation.js";
import {
  runGuardedAuxiliarySessionReturnToMainOperationWithApi,
} from "./auxiliary-session-return-operation.js";
import {
  beginAuxiliarySessionStartOperation,
  createActiveAuxiliarySessionStartResultApplier,
  createAuxiliarySessionStartErrorHandler,
  finishAuxiliarySessionStartClosedLoadWithApi,
  runSessionWindowAuxiliarySessionStartOperation,
} from "./auxiliary-session-start-operation.js";
import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  handleAuxiliarySessionSendOperationResult,
  runAuxiliarySessionSendOperationWithApi,
} from "./auxiliary-session-send-operation.js";
import {
  applyPickedAdditionalDirectoryUiStateCommand,
  applyPickedComposerReferencePathCommand,
  applyComposerReferenceInsertionCommand,
  applySelectedPathReferenceInsertionCommand,
  applySkillPromptInsertionCommand,
  applySessionFilesReferencePathsCommand,
  applySkillPromptInsertionUiState,
  applyUnavailableContextPaneTabFallbackCommand,
  createActionDockCollapseHandler,
  createActionDockExpandHandler,
  createAdditionalDirectoryListToggleHandler,
  createAgentPickerCloseHandler,
  createAgentPickerToggleHandler,
  createCancelTitleEditHandler,
  createComposerSubmitKeyHandler,
  createContextPaneTabCycleHandler,
  createExpandedArtifactToggleHandler,
  createHeaderExpandedToggleHandler,
  createPathReferenceRemovalHandler,
  createQuoteMessageTextHandler,
  createSessionFilesOpenHandler,
  createSkillPickerToggleHandler,
  createSkillPromptInsertionHandler,
  createStartTitleEditHandler,
  createTitleInputKeyHandler,
} from "./chat/session-shell-handlers.js";

const DEFAULT_SESSION_RUNTIME_NAME = "Mate";
const SESSION_RUN_STUCK_INVESTIGATION_LOG = "[investigate:session-run-stuck]";

function logSessionRunStuckInvestigation(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(SESSION_RUN_STUCK_INVESTIGATION_LOG, event, details);
}

function liveRunStepBucketPriority(status: string): number {
  switch (status) {
    case "failed":
    case "canceled":
    case "in_progress":
      return 0;
    case "completed":
      return 1;
    case "pending":
      return 2;
    default:
      return 2;
  }
}

type ParsedFileChangeSummaryLine = {
  actionLabel: string;
  toneClassName: "add" | "edit" | "delete" | "rename";
  path: string;
};

const FILE_CHANGE_SUMMARY_ACTION_META: Record<string, Pick<ParsedFileChangeSummaryLine, "actionLabel" | "toneClassName">> = {
  add: { actionLabel: "ADD", toneClassName: "add" },
  added: { actionLabel: "ADD", toneClassName: "add" },
  create: { actionLabel: "ADD", toneClassName: "add" },
  created: { actionLabel: "ADD", toneClassName: "add" },
  new: { actionLabel: "ADD", toneClassName: "add" },
  edit: { actionLabel: "EDIT", toneClassName: "edit" },
  edited: { actionLabel: "EDIT", toneClassName: "edit" },
  modify: { actionLabel: "EDIT", toneClassName: "edit" },
  modified: { actionLabel: "EDIT", toneClassName: "edit" },
  update: { actionLabel: "EDIT", toneClassName: "edit" },
  updated: { actionLabel: "EDIT", toneClassName: "edit" },
  delete: { actionLabel: "DEL", toneClassName: "delete" },
  deleted: { actionLabel: "DEL", toneClassName: "delete" },
  remove: { actionLabel: "DEL", toneClassName: "delete" },
  removed: { actionLabel: "DEL", toneClassName: "delete" },
  move: { actionLabel: "MOVE", toneClassName: "rename" },
  moved: { actionLabel: "MOVE", toneClassName: "rename" },
  rename: { actionLabel: "MOVE", toneClassName: "rename" },
  renamed: { actionLabel: "MOVE", toneClassName: "rename" },
};

function parseFileChangeSummary(summary: string): ParsedFileChangeSummaryLine[] | null {
  const lines = summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return null;
  }

  const parsedLines = lines.map((line) => {
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex <= 0) {
      return null;
    }

    const actionToken = line.slice(0, separatorIndex).trim().toLowerCase();
    const path = line.slice(separatorIndex + 2).trim();
    const actionMeta = FILE_CHANGE_SUMMARY_ACTION_META[actionToken];
    if (!actionMeta || !path) {
      return null;
    }

    return {
      actionLabel: actionMeta.actionLabel,
      toneClassName: actionMeta.toneClassName,
      path,
    } satisfies ParsedFileChangeSummaryLine;
  });

  return parsedLines.every((line) => line !== null) ? parsedLines : null;
}

function buildDisplayedMessagesScrollSignature(messages: Message[]): string {
  return messages
    .map((message) => {
      const artifact = message.artifact
        ? [
            message.artifact.title,
            message.artifact.activitySummary.join("\u001f"),
            message.artifact.runChecks.map((check) => `${check.label}=${check.value}`).join("\u001f"),
            message.artifact.changedFiles
              .map((file) => `${file.kind}:${file.path}:${file.summary}:${file.diffRows.length}`)
              .join("\u001f"),
            message.artifact.operationTimeline
              ? message.artifact.operationTimeline
                  .map((operation) => `${operation.type}:${operation.summary}:${operation.details?.length ?? 0}`)
                  .join("\u001f")
              : "",
          ].join("\u001e")
        : "";

      return [message.role, message.accent ? "1" : "0", message.text, artifact].join("\u001d");
    })
    .join("\u001c");
}

function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

function buildLiveRunScrollSignature(liveRun: LiveSessionRunState | null): string {
  if (!liveRun) {
    return "";
  }

  return [
    liveRun.assistantText,
    liveRun.reasoningText ?? "",
    liveRun.errorMessage,
    liveRun.approvalRequest
      ? [
          liveRun.approvalRequest.requestId,
          liveRun.approvalRequest.kind,
          liveRun.approvalRequest.summary,
          liveRun.approvalRequest.details ?? "",
          liveRun.approvalRequest.warning ?? "",
        ].join("\u001d")
      : "",
    liveRun.elicitationRequest
      ? [
          liveRun.elicitationRequest.requestId,
          liveRun.elicitationRequest.mode,
          liveRun.elicitationRequest.message,
          liveRun.elicitationRequest.url ?? "",
        ].join("\u001d")
      : "",
    liveRun.usage
      ? [liveRun.usage.inputTokens, liveRun.usage.cachedInputTokens, liveRun.usage.outputTokens].join(":")
      : "",
    liveRun.steps
      .map((step) => [step.id, step.type, step.status, step.summary, step.details ?? ""].join("\u001d"))
      .join("\u001c"),
    liveRun.backgroundTasks
      .map((task) => [task.id, task.kind, task.status, task.title, task.details ?? "", task.updatedAt].join("\u001d"))
      .join("\u001c"),
  ].join("\u001b");
}

export default function AgentSessionWindowApp() {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const [sessions, setSessionsBase] = useState<Session[]>([]);
  const originSessionDetails = useMemo(() => sessions.map((session) => ({
    sessionId: session.id,
    taskTitle: session.taskTitle,
  })), [sessions]);
  const sessionMutationRevisionRef = useRef(new StateMutationRevision());
  const sessionProjectionRevisionRef = useRef(new StateMutationRevision());
  const setAuthoritativeSessions = useCallback((update: SetStateAction<Session[]>) => {
    sessionMutationRevisionRef.current.advance();
    setSessionsBase(update);
  }, []);
  const setSessionProjection = useCallback((update: SetStateAction<Session[]>) => {
    sessionProjectionRevisionRef.current.advance();
    setSessionsBase(update);
  }, []);
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [openCompanionReviewWindowIds, setOpenCompanionReviewWindowIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingSubmitSessionId, setPendingSubmitSessionId] = useState<string | null>(null);
  const [workspaceAvailability, setWorkspaceAvailability] = useState(
    INITIAL_SESSION_WORKSPACE_AVAILABILITY,
  );
  const [workspaceAvailabilityCheckRevision, setWorkspaceAvailabilityCheckRevision] = useState(0);
  const workspaceAvailabilityRequestIdRef = useRef(0);
  const [forceComposerBlockedFeedback, setForceComposerBlockedFeedback] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isSessionPinPending, setIsSessionPinPending] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [selectedFilePreview, setSelectedFilePreview] = useState<SessionFileRootResourceRequest | null>(null);
  const [isPromptTemplateWorkspaceOpen, setIsPromptTemplateWorkspaceOpen] = useState(false);
  const [selectedFileDiffScopes, setSelectedFileDiffScopes] = useState<FileRootGitChangeScope[]>([]);
  const [selectedFileDiffAvailabilityMessage, setSelectedFileDiffAvailabilityMessage] = useState("");
  const [fileExplorerTab, setFileExplorerTab] = useState<"files" | "changes">("files");
  const [fileRootChangesRefreshRevision, setFileRootChangesRefreshRevision] = useState(0);
  const [fileRootDiffPreview, setFileRootDiffPreview] = useState<{
    sessionId: string;
    rootId: string;
    relativePath: string;
    scope: FileRootGitChangeScope;
    generation: number;
    patch: string;
  } | null>(null);
  const [fileRootDiffPendingPreview, setFileRootDiffPendingPreview] = useState<
    (FileRootFileDiffRequest & { generation: number }) | null
  >(null);
  const [fileRootDiffLoadingScope, setFileRootDiffLoadingScope] = useState<FileRootGitChangeScope | null>(null);
  const [previewChatActivity, setPreviewChatActivity] = useState(() => endPreviewChatActivity());
  const [inlinePathError, setInlinePathError] = useState<{
    ownerSessionId: string;
    target: string;
    message: string;
  } | null>(null);
  const inlinePathOperationRevisionRef = useRef(new StateMutationRevision());
  const [liveRunState, setLiveRunStateBase] = useState<OwnedLiveSessionRunState>({ ownerSessionId: null, state: null });
  const liveRunRevisionRef = useRef(0);
  const setLiveRunState = useCallback((update: SetStateAction<OwnedLiveSessionRunState>) => {
    liveRunRevisionRef.current += 1;
    setLiveRunStateBase(update);
  }, []);
  const [liveAssistantBridge, setLiveAssistantBridge] = useState<LiveAssistantProjection | null>(null);
  const [providerQuotaTelemetryState, setProviderQuotaTelemetryState] = useState<ProviderOwnedQuotaTelemetry>({
    ownerProviderId: null,
    telemetry: null,
  });
  const [sessionContextTelemetryState, setSessionContextTelemetryState] = useState<SessionOwnedContextTelemetry>({
    ownerSessionId: null,
    telemetry: null,
  });
  const [activeContextPaneTab, setActiveContextPaneTab] = useState<ContextPaneTabKey>("latest-command");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [isAppSettingsLoaded, setIsAppSettingsLoaded] = useState(false);
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>(() => createEmptyComposerPreview());
  const [sessionTurnExecutions, setSessionTurnExecutions] = useState<SessionTurnExecutionProjection[]>([]);
  const sessionTurnExecutionsRef = useRef<SessionTurnExecutionProjection[]>([]);
  const [runningProjectionBarrier, setRunningProjectionBarrier] = useState<SessionRunningProjectionBarrier | null>(null);
  const runningProjectionBarrierRef = useRef<SessionRunningProjectionBarrier | null>(null);
  const runningProjectionReadyExecutionIdRef = useRef<string | null>(null);
  const hydrateSelectedSessionRef = useRef<() => Promise<boolean>>(async () => false);
  const refreshSessionTurnExecutionsRef = useRef<(sessionId: string) => Promise<void>>(async () => undefined);
  const [queueAdmissionError, setQueueAdmissionError] = useState<{
    sessionId: string;
    error: SessionTurnAdmissionError;
  } | null>(null);
  const [cancelingExecutionIds, setCancelingExecutionIds] = useState<Set<string>>(() => new Set());
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [availableCustomAgents, setAvailableCustomAgents] = useState<DiscoveredCustomAgent[]>([]);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [skillListError, setSkillListError] = useState<string | null>(null);
  const [isComposerImeComposing, setIsComposerImeComposing] = useState(false);
  const [isActivityMonitorFollowing, setIsActivityMonitorFollowing] = useState(true);
  const [hasActivityMonitorUnread, setHasActivityMonitorUnread] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
  const handleHeaderPreferenceChange = useCallback((value: "hidden" | "visible") => {
    void persistChatLayoutPreference(withmateApi, { target: "header", value });
  }, [withmateApi]);
  const handleActionDockPreferenceChange = useCallback((value: "compact" | "expanded") => {
    void persistChatLayoutPreference(withmateApi, { target: "actionDock", value });
  }, [withmateApi]);
  const handleLayoutPriorityPreferenceChange = useCallback((value: "side-pane-first" | "dock-first") => {
    void persistChatLayoutPreference(withmateApi, { target: "priority", value });
  }, [withmateApi]);
  const {
    isHeaderExpanded,
    setIsHeaderExpanded,
    isActionDockPinnedExpanded,
    setIsActionDockPinnedExpanded,
    layoutPriority,
    setLayoutPriority,
  } = useChatLayoutPresentation({
    initialHeader: isAppSettingsLoaded ? appSettings.chatLayoutPreference.header : null,
    initialActionDock: isAppSettingsLoaded ? appSettings.chatLayoutPreference.actionDock : null,
    initialPriority: isAppSettingsLoaded ? appSettings.chatLayoutPreference.priority : null,
    onHeaderChange: handleHeaderPreferenceChange,
    onActionDockChange: handleActionDockPreferenceChange,
    onPriorityChange: handleLayoutPriorityPreferenceChange,
  });
  const handleActivateSidePanePriority = useCallback(() => setLayoutPriority("side-pane-first"), [setLayoutPriority]);
  const handleActivateDockPriority = useCallback(() => setLayoutPriority("dock-first"), [setLayoutPriority]);
  const [activeAuxiliarySession, setActiveAuxiliarySession] = useState<AuxiliarySession | null>(null);
  const [closedAuxiliarySessions, setClosedAuxiliarySessions] = useState<AuxiliarySession[]>([]);
  const [isAuxiliaryActionPending, setIsAuxiliaryActionPending] = useState(false);
  const {
    auxiliaryLaunchDialogOpen,
    auxiliaryLaunchProviderId,
    auxiliaryLaunchFeedback,
    openAuxiliaryLaunchDialog,
    closeAuxiliaryLaunchDialog,
    selectAuxiliaryLaunchProvider,
    resetAuxiliaryLaunchFeedback,
    setAuxiliaryLaunchStartError,
  } = useAuxiliaryLaunchDialogState();
  const activityMonitorRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activityMonitorSignatureRef = useRef("");
  const activityMonitorSessionIdRef = useRef<string | null>(null);
  const activeAuxiliarySessionRef = useRef<AuxiliarySession | null>(null);
  const auxiliarySessionMutationRevisionRef = useRef(0);
  const auxiliaryDraftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const auxiliarySessionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const auxiliaryLoadRevisionRef = useRef(0);
  const mainComposerCaretRef = useRef(0);
  const promptTemplateSelectionRef = useRef({ start: 0, end: 0 });
  const fileRootDiffRequestRevisionRef = useRef(0);
  const sessionRefetchRevisionRef = useRef(new LatestRequestRevision());
  const sessionSubmitCoordinatorRef = useRef(new SessionSubmitCoordinator());
  const enqueueRetryRef = useRef<{
    sessionId: string;
    messageText: string;
    clientRequestId: string;
  } | null>(null);
  const selectedId = useMemo(() => getSessionIdFromLocation(), []);
  const [scheduleView, setScheduleView] = useState<"chat" | "list" | "create" | "edit">("chat");
  const [scheduleLoadState, setScheduleLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [sessionSchedules, setSessionSchedules] = useState<SessionScheduleSummary[]>([]);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraftProjection | null>(null);
  const [scheduleLoadError, setScheduleLoadError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const scheduleRefreshGenerationRef = useRef(0);
  const scheduleDraftRef = useRef<ScheduleDraftProjection | null>(null);
  const scheduleModeActive = scheduleView !== "chat";

  const refreshSessionSchedules = useCallback(async () => {
    if (!withmateApi || !selectedId) return;
    const generation = ++scheduleRefreshGenerationRef.current;
    setScheduleLoadState("loading");
    try {
      const next = await withmateApi.listSessionSchedules(selectedId);
      if (generation !== scheduleRefreshGenerationRef.current) return;
      setSessionSchedules(next);
      setScheduleLoadState("loaded");
      setScheduleLoadError(null);
    } catch (error) {
      if (generation !== scheduleRefreshGenerationRef.current) return;
      setScheduleLoadState("error");
      setScheduleLoadError(error instanceof Error ? error.message : "Schedule list could not be loaded.");
    }
  }, [selectedId, withmateApi]);

  useEffect(() => {
    if (scheduleModeActive) void refreshSessionSchedules();
    if (!withmateApi || !selectedId) return;
    return withmateApi.subscribeSessionSchedules((event) => {
      if (event.sessionId === selectedId) void refreshSessionSchedules();
    });
  }, [refreshSessionSchedules, scheduleModeActive, selectedId, withmateApi]);

  const openScheduleList = useCallback(() => {
    setScheduleDraft(null);
    scheduleDraftRef.current = null;
    setScheduleView("list");
    setScheduleError(null);
  }, []);
  const openScheduleChat = useCallback(() => {
    setScheduleDraft(null);
    scheduleDraftRef.current = null;
    setScheduleError(null);
    setScheduleView("chat");
  }, []);

  const createScheduleDraft = useCallback(() => {
    const currentSession = sessions.find((session) => session.id === selectedId);
    if (!currentSession) return;
    let timeZone: string;
    try {
      timeZone = resolveSystemScheduleTimeZone();
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : "PCのローカルタイムを取得できませんでした。");
      return;
    }
    const composerState = buildScheduleDraftComposerState(draft, composerPreview.attachments);
    const next: ScheduleDraftProjection = {
      sessionId: currentSession.id,
      name: "",
      trigger: { type: "cron", expression: "0 9 * * 1-5", timeZone },
      prompt: composerState.prompt,
      attachments: composerState.attachments,
      model: currentSession.model ?? "",
      reasoningEffort: currentSession.reasoningEffort ?? "",
      approvalMode: currentSession.approvalMode ?? "",
      sandboxMode: currentSession.codexSandboxMode ?? "",
      customAgent: currentSession.customAgentName ?? null,
    };
    setScheduleDraft(next);
    scheduleDraftRef.current = next;
    setScheduleView("create");
  }, [composerPreview.attachments, draft, selectedId, sessions]);

  const editSchedule = useCallback(async (summary: ScheduleSummaryProjection) => {
    if (!withmateApi || !selectedId) return;
    try {
      const schedule = await withmateApi.getSessionSchedule(selectedId, summary.id);
      if (!schedule) return;
      const next: ScheduleDraftProjection = {
        id: schedule.id,
        sessionId: schedule.sessionId,
        name: schedule.name,
        trigger: { ...schedule.trigger, timeZone: resolveSystemScheduleTimeZone() },
        prompt: schedule.turn.userMessage,
        attachments: schedule.turn.attachments?.map((attachment) => attachment.path) ?? [],
        model: schedule.turn.model ?? "",
        reasoningEffort: schedule.turn.reasoningEffort ?? "",
        approvalMode: schedule.turn.approvalMode ?? "",
        sandboxMode: schedule.turn.codexSandboxMode ?? "",
        customAgent: schedule.turn.customAgentName ?? null,
      };
      setScheduleDraft(next);
      scheduleDraftRef.current = next;
      setScheduleView("edit");
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : "Schedule could not be loaded.");
    }
  }, [selectedId, withmateApi]);

  const updateScheduleDraft = useCallback((next: ScheduleDraftProjection) => {
    scheduleDraftRef.current = next;
    setScheduleDraft(next);
    setScheduleError(null);
  }, []);

  const saveScheduleDraft = useCallback(async () => {
    const current = scheduleDraftRef.current;
    if (!withmateApi || !selectedId || !current) return;
    setScheduleError(null);
    const provider = (sessions.find((session) => session.id === selectedId)?.provider ?? "codex") as SessionScheduleTurn["provider"];
    const turn: SessionScheduleTurn = provider === "codex" ? {
      provider,
      userMessage: current.prompt,
      model: current.model,
      reasoningEffort: current.reasoningEffort as SessionScheduleTurn["reasoningEffort"],
      approvalMode: current.approvalMode as SessionScheduleTurn["approvalMode"],
      codexSandboxMode: current.sandboxMode as SessionScheduleTurn["codexSandboxMode"],
      attachments: current.attachments.map((path) => ({ path, source: "text" as const })),
    } : {
      provider,
      userMessage: current.prompt,
      model: current.model,
      reasoningEffort: current.reasoningEffort as SessionScheduleTurn["reasoningEffort"],
      approvalMode: current.approvalMode as SessionScheduleTurn["approvalMode"],
      customAgentName: current.customAgent ?? "",
      attachments: current.attachments.map((path) => ({ path, source: "text" as const })),
    };
    try {
      const trigger = { ...current.trigger, timeZone: resolveSystemScheduleTimeZone() } as SessionScheduleTrigger;
      if (current.id) {
        const previous = sessionSchedules.find((entry) => entry.id === current.id);
        await withmateApi.updateSessionSchedule(selectedId, { scheduleId: current.id, expectedRevision: previous?.revision ?? 1, name: current.name, trigger, turn });
      } else {
        await withmateApi.createSessionSchedule(selectedId, { name: current.name, trigger, turn });
      }
      await refreshSessionSchedules();
      setScheduleView("list");
      setScheduleDraft(null);
      scheduleDraftRef.current = null;
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : "Schedule could not be saved.");
    }
  }, [refreshSessionSchedules, selectedId, sessionSchedules, sessions, withmateApi]);

  const mutateSchedule = useCallback(async (summary: ScheduleSummaryProjection, action: "pause" | "resume" | "delete" | "run") => {
    if (!withmateApi || !selectedId) return;
    setScheduleError(null);
    try {
      const request = { scheduleId: summary.id, expectedRevision: summary.revision };
      if (action === "pause") await withmateApi.pauseSessionSchedule(selectedId, request);
      else if (action === "resume") await withmateApi.resumeSessionSchedule(selectedId, request);
      else if (action === "delete") await withmateApi.deleteSessionSchedule(selectedId, request);
      else await withmateApi.runSessionScheduleNow(selectedId, { scheduleId: summary.id, requestId: crypto.randomUUID() });
      await refreshSessionSchedules();
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : "Schedule operation failed.");
    }
  }, [refreshSessionSchedules, selectedId, withmateApi]);

  useEffect(() => {
    let active = true;

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    if (!selectedId) {
      setAuthoritativeSessions([]);
      return () => {
        active = false;
      };
    }

    const hydrateSelectedSession = async (): Promise<boolean> => {
      const projectionReadyExecutionId = runningProjectionReadyExecutionIdRef.current;
      const requestRevision = sessionRefetchRevisionRef.current.start();
      const mutationRevision = sessionMutationRevisionRef.current.capture();
      const projectionRevision = sessionProjectionRevisionRef.current.capture();
      withmateApi.reportRendererLog({
        level: "info",
        kind: "renderer.session-refetch.started",
        message: "Session refetch started",
        data: { sessionId: selectedId },
      });
      try {
        const session = await withmateApi.getSession(selectedId);
          if (
            !active
            || !sessionRefetchRevisionRef.current.isCurrent(requestRevision)
            || !sessionMutationRevisionRef.current.isCurrent(mutationRevision)
          ) {
            return false;
          }

          setAuthoritativeSessions((current) => session
            ? [mergeRefetchedSessionProjection(
              current.find((candidate) => candidate.id === session.id) ?? null,
              session,
              !sessionProjectionRevisionRef.current.isCurrent(projectionRevision),
            )]
            : []);
          withmateApi.reportRendererLog({
            level: "info",
            kind: "renderer.session-refetch.completed",
            message: "Session refetch completed",
            data: {
              sessionId: selectedId,
              found: !!session,
              runState: session?.runState ?? null,
              status: session?.status ?? null,
            },
          });
        if (
          projectionReadyExecutionId &&
          runningProjectionBarrierRef.current?.executionId === projectionReadyExecutionId
        ) {
          runningProjectionBarrierRef.current = null;
          runningProjectionReadyExecutionIdRef.current = null;
          setRunningProjectionBarrier(null);
        }
        return true;
      } catch (error) {
        withmateApi.reportRendererLog({
          level: "error",
          kind: "renderer.session-refetch.failed",
          message: "Session refetch failed",
          data: { sessionId: selectedId },
          error: {
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      }
    };
    hydrateSelectedSessionRef.current = hydrateSelectedSession;

    void hydrateSelectedSession();

    const unsubscribe = withmateApi.subscribeSessionInvalidation((sessionIds) => {
      if (!active || !sessionIds.includes(selectedId)) {
        return;
      }

      void hydrateSelectedSession();
    });

    return () => {
      active = false;
      hydrateSelectedSessionRef.current = async () => false;
      unsubscribe();
    };
  }, [selectedId, setAuthoritativeSessions, withmateApi]);

  useEffect(() => {
    return startCompanionSessionSummariesSubscription({
      api: withmateApi,
      applySummaries: setCompanionSessions,
    });
  }, [withmateApi]);

  useEffect(() => {
    return startOpenCompanionReviewWindowIdsSubscription({
      api: withmateApi,
      applyOpenWindowIds: setOpenCompanionReviewWindowIds,
    });
  }, [withmateApi]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!withmateApi || !sessionId) {
      sessionTurnExecutionsRef.current = [];
      runningProjectionBarrierRef.current = null;
      runningProjectionReadyExecutionIdRef.current = null;
      setSessionTurnExecutions([]);
      setRunningProjectionBarrier(null);
      return;
    }

    let active = true;
    let refreshRevision = 0;
    const refresh = async () => {
      const revision = ++refreshRevision;
      try {
        const executions = await withmateApi.listSessionTurnExecutions(sessionId);
        if (!active || revision !== refreshRevision) return;
        const next = mergeTurnExecutionRefreshWithBarrier(
          sessionTurnExecutionsRef.current,
          executions,
          runningProjectionBarrierRef.current,
        );
        sessionTurnExecutionsRef.current = next;
        setSessionTurnExecutions(next);
        setQueueAdmissionError((current) => (
          current?.sessionId === sessionId &&
            current.error.code === "QUEUE_FULL" &&
            executions.filter((execution) => execution.state === "queued").length < 10
            ? null
            : current
        ));
      } catch (error) {
        if (active) console.error(error);
      }
    };
    refreshSessionTurnExecutionsRef.current = refresh;

    sessionTurnExecutionsRef.current = [];
    runningProjectionBarrierRef.current = null;
    runningProjectionReadyExecutionIdRef.current = null;
    setSessionTurnExecutions([]);
    setRunningProjectionBarrier(null);
    setQueueAdmissionError((current) => current?.sessionId === sessionId ? current : null);
    void refresh();
    const unsubscribe = withmateApi.subscribeSessionExecutionsChanged((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === "user-message-persisted") {
        runningProjectionReadyExecutionIdRef.current = event.executionId;
        void hydrateSelectedSessionRef.current().then((applied) => {
          if (!applied || runningProjectionBarrierRef.current?.executionId === event.executionId) return;
          if (runningProjectionReadyExecutionIdRef.current === event.executionId) {
            runningProjectionReadyExecutionIdRef.current = null;
          }
          void refresh();
        });
        return;
      }
      const current = sessionTurnExecutionsRef.current;
      const barrier = createSessionRunningProjectionBarrier(event);
      const next = applySessionExecutionChangedEventWithBarrier(
        current,
        event,
        runningProjectionBarrierRef.current,
      );
      sessionTurnExecutionsRef.current = next;
      setSessionTurnExecutions(next);
      if (barrier) {
        runningProjectionBarrierRef.current = barrier;
        setRunningProjectionBarrier(barrier);
      }
      void refresh();
    });
    return () => {
      active = false;
      refreshRevision += 1;
      refreshSessionTurnExecutionsRef.current = async () => undefined;
      unsubscribe();
    };
  }, [selectedSession?.id, withmateApi]);
  const displayedSession = useMainAuxiliaryRuntimeSession(selectedSession, activeAuxiliarySession);
  const isAuxiliaryMode = activeAuxiliarySession?.status === "active";
  const selectedCompanionGroupMonitorEntries = useMemo(
    () => buildCompanionGroupMonitorEntries(
      companionSessions,
      openCompanionReviewWindowIds,
    ),
    [companionSessions, openCompanionReviewWindowIds],
  );
  const selectedSessionId = selectedSession?.id ?? null;
  const validateSessionWorkspace = useCallback(async (session: Session): Promise<boolean> => {
    if (!withmateApi) {
      return false;
    }
    const { id: sessionId, workspacePath } = session;
    const requestId = workspaceAvailabilityRequestIdRef.current + 1;
    workspaceAvailabilityRequestIdRef.current = requestId;
    setWorkspaceAvailability(beginSessionWorkspaceAvailabilityCheck(sessionId, workspacePath, requestId));
    const result = await withmateApi.validateSessionWorkspace(sessionId)
      .catch(() => ({ valid: false, reason: "unavailable" } as const));
    if (workspaceAvailabilityRequestIdRef.current !== requestId) {
      return false;
    }
    setWorkspaceAvailability((current) => applySessionWorkspaceAvailabilityResult(
      current,
      sessionId,
      workspacePath,
      requestId,
      result,
    ));
    return result.valid;
  }, [withmateApi]);
  useEffect(() => {
    if (!withmateApi || !selectedSession) {
      workspaceAvailabilityRequestIdRef.current += 1;
      setWorkspaceAvailability(INITIAL_SESSION_WORKSPACE_AVAILABILITY);
      return;
    }

    void validateSessionWorkspace(selectedSession);

    return () => {
      workspaceAvailabilityRequestIdRef.current += 1;
    };
  }, [selectedSession?.id, selectedSession?.workspacePath, validateSessionWorkspace, workspaceAvailabilityCheckRevision]);
  const handleSidePaneChange = useCallback((sidePane: SessionSidePane) => {
    void persistChatLayoutPreference(withmateApi, { target: "sidePane", value: sidePane });
  }, [withmateApi]);
  useEffect(() => {
    let active = true;
    const loadRevision = auxiliaryLoadRevisionRef.current + 1;
    auxiliaryLoadRevisionRef.current = loadRevision;
    const canApplyLoadResult = createAuxiliaryLoadRevisionGuard({
      loadRevision: auxiliaryLoadRevisionRef,
      expectedRevision: loadRevision,
      isActive: () => active,
    });

    if (!withmateApi || !selectedSessionId) {
      clearAuxiliarySessionsLoadState({
        setActiveSession: setActiveAuxiliarySession,
        setClosedSessions: setClosedAuxiliarySessions,
      });
      return () => {
        active = false;
      };
    }

    void runActiveAuxiliarySessionLoadAndApply({
      parentSessionId: selectedSessionId,
      getActiveAuxiliarySession: (sessionId) => withmateApi.getActiveAuxiliarySession(sessionId),
      isActive: canApplyLoadResult,
      setActiveSession: setActiveAuxiliarySession,
    });

    void runClosedAuxiliarySessionsLoadAndApply({
      parentSessionId: selectedSessionId,
      listAuxiliarySessions: (sessionId) => withmateApi.listAuxiliarySessions(sessionId),
      getAuxiliarySession: (sessionId) => withmateApi.getAuxiliarySession(sessionId),
      isActive: canApplyLoadResult,
      setClosedSessions: setClosedAuxiliarySessions,
    });

    return () => {
      active = false;
    };
  }, [selectedSessionId, withmateApi]);

  const {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailVisible,
    isFilesPaneVisible,
    isContextRailResizing,
    isFilesPaneResizing,
    handleStartContextRailResize,
    handleStartFilesPaneResize,
    handleToggleContextRailVisibility,
    handleToggleFilesPaneVisibility,
  } = useSessionSidePanes({
    ownerKey: selectedSessionId,
    initialSidePane: isAppSettingsLoaded ? appSettings.chatLayoutPreference.sidePane : null,
    onSidePaneChange: handleSidePaneChange,
  });
  const activeRunSessionId = activeAuxiliarySession?.id ?? selectedSessionId;
  const activeRunMessageCount = activeAuxiliarySession?.messages.length ?? selectedSession?.messages.length ?? 0;
  const isCentralPreviewActive = selectedFilePreview !== null
    || fileRootDiffPreview !== null
    || fileRootDiffPendingPreview !== null
    || isPromptTemplateWorkspaceOpen;
  const beginCentralPreviewIfNeeded = useCallback(() => {
    setIsPromptTemplateWorkspaceOpen(false);
    if (!isCentralPreviewActive && activeRunSessionId) {
      setPreviewChatActivity(beginPreviewChatActivity(activeRunSessionId, activeRunMessageCount));
    }
  }, [activeRunMessageCount, activeRunSessionId, isCentralPreviewActive]);
  const closeCentralPreview = useCallback(() => {
    fileRootDiffRequestRevisionRef.current += 1;
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(null);
    setIsPromptTemplateWorkspaceOpen(false);
    setPreviewChatActivity(endPreviewChatActivity());
  }, []);
  useEffect(() => {
    if (!isCentralPreviewActive || !activeRunSessionId) {
      setPreviewChatActivity((current) => (
        current.ownerSessionId === null ? current : endPreviewChatActivity()
      ));
      return;
    }

    setPreviewChatActivity((current) => observePreviewChatMessageCount(
      current,
      activeRunSessionId,
      activeRunMessageCount,
    ));
  }, [activeRunMessageCount, activeRunSessionId, isCentralPreviewActive]);
  useEffect(() => {
    fileRootDiffRequestRevisionRef.current += 1;
    setSelectedFilePreview((current) => current?.sessionId === activeRunSessionId ? current : null);
    setSelectedFileDiffScopes([]);
    setSelectedFileDiffAvailabilityMessage("");
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setFileRootDiffLoadingScope(null);
  }, [activeRunSessionId]);
  useEffect(() => {
    let active = true;
    setSelectedFileDiffScopes([]);
    setSelectedFileDiffAvailabilityMessage("");
    if (
      !withmateApi ||
      !activeRunSessionId ||
      !selectedFilePreview
    ) {
      return () => {
        active = false;
      };
    }
    void withmateApi.listFileRootChanges({
      sessionId: activeRunSessionId,
      rootId: selectedFilePreview.rootId,
    }).then((result) => {
      if (!active) {
        return;
      }
      const availability = projectFileRootDiffAvailability(result, selectedFilePreview.relativePath);
      setSelectedFileDiffScopes(availability.scopes);
      setSelectedFileDiffAvailabilityMessage(availability.message);
    }).catch(() => {
      if (active) {
        setSelectedFileDiffScopes([]);
        setSelectedFileDiffAvailabilityMessage("");
      }
    });
    return () => {
      active = false;
    };
  }, [activeRunSessionId, selectedFilePreview, withmateApi]);
  const handleOpenFileRootFile = useCallback(async (
    request: SessionFileRootResourceRequest,
    openInWindow = false,
  ): Promise<string | null> => {
    if (openInWindow) {
      if (!withmateApi) {
        return "The file preview could not be opened.";
      }
      try {
        const result = await withmateApi.openSessionFilePreviewWindow({ kind: "resource", resource: request });
        return result.status === "opened" ? null : result.message;
      } catch (error) {
        return error instanceof Error ? error.message : "The file preview could not be opened.";
      }
    }
    fileRootDiffRequestRevisionRef.current += 1;
    beginCentralPreviewIfNeeded();
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(request);
    return null;
  }, [beginCentralPreviewIfNeeded, withmateApi]);
  const handleShowFileRootDiff = useCallback((
    request: FileRootFileDiffRequest,
    openInWindow = false,
  ): Promise<string | null> => {
    if (!withmateApi || request.sessionId !== activeRunSessionId) {
      return Promise.resolve("Git diff is not available for this session.");
    }
    if (openInWindow) {
      return withmateApi.openSessionFilePreviewWindow(
        buildFileRootDiffPreviewWindowRequest(request),
      ).then((result) => result.status === "opened" ? null : result.message).catch((error) => (
        error instanceof Error ? error.message : "The Git diff preview could not be opened."
      ));
    }
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
    beginCentralPreviewIfNeeded();
    setFileRootDiffPendingPreview({ ...request, generation: revision });
    setFileRootDiffLoadingScope(request.scope);
    return withmateApi.getFileRootDiff(request).then((result) => {
      if (fileRootDiffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (result.status !== "ok") {
        return result.message;
      }
      setFileRootDiffPreview({
        sessionId: request.sessionId,
        rootId: request.rootId,
        relativePath: result.relativePath,
        scope: result.scope,
        generation: revision,
        patch: result.patch,
      });
      setFileRootDiffPendingPreview(null);
      return null;
    }).catch((error) => (
      fileRootDiffRequestRevisionRef.current === revision
        ? error instanceof Error ? error.message : "Git diff failed."
        : null
    )).finally(() => {
      if (fileRootDiffRequestRevisionRef.current === revision) {
        setFileRootDiffPendingPreview(null);
        setFileRootDiffLoadingScope(null);
      }
    });
  }, [activeRunSessionId, beginCentralPreviewIfNeeded, withmateApi]);
  const handleOpenSelectedFileDiff = useCallback(async (scope: FileRootGitChangeScope): Promise<string | null> => {
    if (!withmateApi || !activeRunSessionId || !selectedFilePreview) {
      return "Git Diff is not available for this file.";
    }
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
    const request = { ...selectedFilePreview };
    setFileRootDiffPendingPreview({ ...request, scope, generation: revision });
    setFileRootDiffLoadingScope(scope);
    try {
      const status = await withmateApi.listFileRootChanges({
        sessionId: activeRunSessionId,
        rootId: request.rootId,
      });
      if (fileRootDiffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (status.status !== "ok") {
        return status.message;
      }
      const change = status.entries.find((entry) => entry.relativePath === request.relativePath);
      if (!change) {
        return "This file has no Git changes.";
      }
      if (change.kinds[scope] === "untracked") {
        return "Untracked files do not have a Git diff yet.";
      }
      if (!change.scopes.includes(scope)) {
        return "This file is no longer changed in the selected Git scope.";
      }
      const result = await withmateApi.getFileRootDiff({
        sessionId: activeRunSessionId,
        rootId: request.rootId,
        relativePath: request.relativePath,
        scope,
      });
      if (fileRootDiffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (result.status !== "ok") {
        return result.message;
      }
      setFileRootDiffPreview({
        sessionId: activeRunSessionId,
        rootId: request.rootId,
        relativePath: result.relativePath,
        scope: result.scope,
        generation: revision,
        patch: result.patch,
      });
      setFileRootDiffPendingPreview(null);
      return null;
    } catch (error) {
      return fileRootDiffRequestRevisionRef.current === revision
        ? error instanceof Error ? error.message : "Git diff failed."
        : null;
    } finally {
      if (fileRootDiffRequestRevisionRef.current === revision) {
        setFileRootDiffPendingPreview(null);
        setFileRootDiffLoadingScope(null);
      }
    }
  }, [activeRunSessionId, selectedFilePreview, withmateApi]);
  const handleReloadFileRootDiff = useCallback(async (): Promise<string | null> => {
    if (!withmateApi || !fileRootDiffPreview || fileRootDiffPreview.sessionId !== activeRunSessionId) {
      return "Git diff is no longer available for this session.";
    }
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
    setFileRootDiffLoadingScope(fileRootDiffPreview.scope);
    try {
      const result = await withmateApi.getFileRootDiff({
        sessionId: fileRootDiffPreview.sessionId,
        rootId: fileRootDiffPreview.rootId,
        relativePath: fileRootDiffPreview.relativePath,
        scope: fileRootDiffPreview.scope,
      });
      if (fileRootDiffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (result.status !== "ok") {
        return result.message;
      }
      setFileRootDiffPreview({
        sessionId: fileRootDiffPreview.sessionId,
        rootId: fileRootDiffPreview.rootId,
        relativePath: result.relativePath,
        scope: result.scope,
        generation: revision,
        patch: result.patch,
      });
      return null;
    } catch (error) {
      return fileRootDiffRequestRevisionRef.current === revision
        ? error instanceof Error ? error.message : "Git diff failed."
        : null;
    } finally {
      if (fileRootDiffRequestRevisionRef.current === revision) {
        setFileRootDiffLoadingScope(null);
      }
    }
  }, [activeRunSessionId, withmateApi, fileRootDiffPreview]);
  const selectedSessionLiveRun = useMemo(
    () => (activeRunSessionId !== null && liveRunState.ownerSessionId === activeRunSessionId ? liveRunState.state : null),
    [activeRunSessionId, liveRunState.ownerSessionId, liveRunState.state],
  );
  const {
    session: auditLogSession,
    ownerSessionId: auditLogOwnerSessionId,
    sourceLabel: auditLogSourceLabel,
  } = resolveAuditLogOwner({
    parentSession: selectedSession,
    displayedSession,
    parentSourceLabel: "Main Session",
  });
  const {
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogDetails,
    auditLogOperationDetails,
    persistedEntries: selectedSessionAuditLogs,
    displayedEntries: displayedSessionAuditLogs,
    auditLogsHasMore,
    auditLogsLoading,
    auditLogsTotal,
    auditLogsErrorMessage,
    handleLoadMoreAuditLogs,
    handleLoadAuditLogDetail,
    handleLoadAuditLogOperationDetail,
  } = useSessionAuditLogs({
    withmateApi,
    selectedSession: auditLogSession,
    ownerSessionId: auditLogOwnerSessionId,
    cacheScopeKey: "session",
    liveRun: selectedSessionLiveRun,
  });
  const selectedProviderQuotaTelemetry = useMemo(
    () => resolveOwnedProviderQuotaTelemetry(providerQuotaTelemetryState, displayedSession?.provider),
    [displayedSession?.provider, providerQuotaTelemetryState.ownerProviderId, providerQuotaTelemetryState.telemetry],
  );
  const selectedSessionContextTelemetry = useMemo(
    () => resolveOwnedSessionContextTelemetry(sessionContextTelemetryState, activeRunSessionId),
    [activeRunSessionId, sessionContextTelemetryState.ownerSessionId, sessionContextTelemetryState.telemetry],
  );
  const selectedSessionRunState: Session["runState"] | null = resolveSelectedSessionRunState({
    runState: selectedSession?.runState,
    hasLiveRun: !!selectedSessionLiveRun,
  });
  const visibleSessionRunState: Session["runState"] | null = activeAuxiliarySession?.runState ?? selectedSessionRunState;
  const liveRunAssistantText = selectedSessionLiveRun?.assistantText ?? "";
  const liveApprovalRequest = selectedSessionLiveRun?.approvalRequest ?? null;
  const liveElicitationRequest = selectedSessionLiveRun?.elicitationRequest ?? null;
  const isApprovalRequestPending = !!liveApprovalRequest;
  const isElicitationRequestPending = !!liveElicitationRequest;
  const hasLiveRunAssistantText = liveRunAssistantText.length > 0;

  const selectedSessionCharacter = useMemo(
    () =>
      selectedSession
        ? {
            id: selectedSession.characterId,
            name: selectedSession.character.trim() || DEFAULT_SESSION_RUNTIME_NAME,
            iconPath: selectedSession.characterIconPath,
            description: "",
            roleMarkdown: "",
            notesMarkdown: "",
            updatedAt: selectedSession.updatedAt,
            themeColors: selectedSession.characterThemeColors,
            sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
          }
        : null,
    [selectedSession],
  );
  const isSelectedSessionReadOnly = selectedSession ? isReadOnlySession(selectedSession) : false;
  const sessionThemeStyle = useMemo(
    () => (selectedSession ? buildCharacterThemeStyle(selectedSession.characterThemeColors) : undefined),
    [selectedSession],
  );
  const selectedDiffThemeStyle = useMemo(
    () => (selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : {}),
    [selectedDiff],
  );
  const resolveSessionMicrocopy = (
    slot: MicrocopySlot,
    seedParts: Array<string | number | null | undefined>,
  ) => resolveMicrocopy({
    slot,
    userCatalog: appSettings.userMicrocopyCatalog,
    seedParts,
    replacements: { name: selectedSessionCharacter?.name || DEFAULT_SESSION_RUNTIME_NAME },
  });
  const getChangedFilesEmptyText = useCallback(
    (artifactKey: string, artifactHasSnapshotRisk: boolean) =>
      artifactHasSnapshotRisk
        ? "差分は見つからなかったけど、snapshot の上限や省略で取りこぼしがあるかもしれないよ。"
        : resolveMicrocopy({
            slot: "empty.changed_files",
            userCatalog: appSettings.userMicrocopyCatalog,
            seedParts: ["changed-files-empty", artifactKey],
            replacements: { name: selectedSessionCharacter?.name || DEFAULT_SESSION_RUNTIME_NAME },
          }),
    [appSettings.userMicrocopyCatalog, selectedSessionCharacter?.name],
  );
  const isSelectedProviderEnabled = useMemo(
    () => !!displayedSession && getProviderAppSettings(appSettings, displayedSession.provider).enabled,
    [appSettings, displayedSession],
  );
  const auxiliaryLaunchProviderItems = useMemo(
    () => buildAuxiliaryLaunchProviderItems(
      modelCatalog?.providers ?? [],
      (provider) => getProviderAppSettings(appSettings, provider.id).enabled,
    ),
    [appSettings, modelCatalog],
  );
  const sessionExecutionBlockedReason = useMemo(() => {
    if (!selectedSession) {
      return "";
    }

    if (isSelectedSessionReadOnly) {
      return "This session is read-only. Create a new session to send messages.";
    }

    if (!isSelectedProviderEnabled) {
      return "Provider is disabled. Enable it in Settings.";
    }

    const workspaceBlockedReason = resolveSessionWorkspaceBlockedReason(
      workspaceAvailability,
      selectedSession.id,
      selectedSession.workspacePath,
    );
    if (workspaceBlockedReason) {
      return workspaceBlockedReason;
    }

    return "";
  }, [isSelectedProviderEnabled, isSelectedSessionReadOnly, selectedSession, workspaceAvailability]);
  const composerBusyReason = pendingSubmitSessionId === selectedSession?.id
    ? "Message submission is in progress."
    : "";
  const composerBlockedReason = composerBusyReason || sessionExecutionBlockedReason;
  const isSelectedWorkspaceAvailable = selectedSession
    ? isSessionWorkspaceAvailable(
        workspaceAvailability,
        selectedSession.id,
        selectedSession.workspacePath,
      )
    : false;
  const workspaceAvailabilityMessage = selectedSession
    ? resolveSessionWorkspaceUnavailableMessage(
        workspaceAvailability,
        selectedSession.id,
        selectedSession.workspacePath,
      )
    : "";
  const isWorkspaceAvailabilityCheckPending = workspaceAvailability.status === "checking"
    && workspaceAvailability.sessionId === selectedSession?.id;

  useEffect(() => {
    if (!selectedSession || isEditingTitle) {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
  }, [isEditingTitle, selectedSession]);

  useEffect(() => {
    applySessionDocumentTitle(resolveAgentSessionDocumentTitle({
      sessionTitle: selectedSession?.taskTitle,
      sessionId: selectedId,
    }));
  }, [selectedId, selectedSession?.taskTitle]);

  useEffect(() => {
    let active = true;

    if (!withmateApi || !activeRunSessionId || displayedSession?.provider !== "copilot") {
      setAvailableCustomAgents([]);
      setIsCustomAgentListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsCustomAgentListLoading(true);
    void withmateApi.listSessionCustomAgents(activeRunSessionId).then((agents) => {
      if (active) {
        setAvailableCustomAgents(agents);
        setIsCustomAgentListLoading(false);
      }
    }).catch(() => {
      if (active) {
        setAvailableCustomAgents([]);
        setIsCustomAgentListLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [activeRunSessionId, displayedSession?.provider, withmateApi]);

  useEffect(() => {
    let active = true;
    const skillDiscoveryRequest = resolveSkillDiscoveryRequest({
      parentProviderId: selectedSession?.provider,
      parentWorkspacePath: selectedSession?.workspacePath,
      auxiliaryProviderId: activeAuxiliarySession?.provider,
    });

    if (!withmateApi || !skillDiscoveryRequest) {
      setAvailableSkills([]);
      setIsSkillListLoading(false);
      setSkillListError(null);
      return () => {
        active = false;
      };
    }

    setIsSkillListLoading(true);
    setSkillListError(null);
    void withmateApi.listWorkspaceSkills(
      skillDiscoveryRequest.providerId,
      skillDiscoveryRequest.workspacePath,
    ).then((skills) => {
      if (active) {
        setAvailableSkills(skills);
        setIsSkillListLoading(false);
        setSkillListError(null);
      }
    }).catch(() => {
      if (active) {
        setAvailableSkills([]);
        setIsSkillListLoading(false);
        setSkillListError("Skill候補を読み込めませんでした。Settingsまたはworkspaceを確認してください。");
      }
    });

    return () => {
      active = false;
    };
  }, [
    activeAuxiliarySession?.provider,
    appSettings,
    selectedSession?.provider,
    selectedSession?.workspacePath,
    withmateApi,
  ]);

  useEffect(() => {
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
  }, [selectedSessionId]);

  useEffect(() => {
    if (visibleSessionRunState === "running") {
      setIsAgentPickerOpen(false);
      setIsSkillPickerOpen(false);
    }
  }, [visibleSessionRunState]);

  useEffect(() => {
    return startModelCatalogSubscription({
      api: withmateApi,
      enabled: true,
      subscribe: true,
      applyModelCatalog: setModelCatalog,
    });
  }, [selectedSession?.id, withmateApi]);

  useEffect(() => {
    return startAppSettingsSubscription({
      api: withmateApi,
      loadInitial: true,
      applyAppSettings: (settings) => {
        setAppSettings(settings);
        setIsAppSettingsLoaded(true);
      },
    });
  }, [withmateApi]);

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];
  const projectedAuxiliarySessions = useMessageListAuxiliarySessions(
    closedAuxiliarySessions,
    activeAuxiliarySession,
  );
  const liveAssistantMessageIndex = useMemo(
    () =>
      activeRunSessionId
        ? resolveLiveAssistantMessageIndex(
          displayedMessages,
          projectedAuxiliarySessions,
          activeRunSessionId,
          selectedSession?.id,
          liveRunAssistantText,
        )
        : 0,
    [activeRunSessionId, displayedMessages, liveRunAssistantText, projectedAuxiliarySessions, selectedSession?.id],
  );
  const hasPersistedLiveAssistantBridge = useMemo(
    () =>
      liveAssistantBridge
        ? hasPersistedLiveAssistantMessage(
          displayedMessages,
          projectedAuxiliarySessions,
          liveAssistantBridge,
          selectedSession?.id,
        )
        : false,
    [displayedMessages, liveAssistantBridge, projectedAuxiliarySessions, selectedSession?.id],
  );
  const isLiveAssistantBridgeSettling = selectedSessionLiveRun === null && !hasPersistedLiveAssistantBridge;
  const projectedLiveAssistant = useMemo<LiveAssistantProjection | null>(() => {
    if (!activeRunSessionId) {
      return null;
    }

    const liveThreadId = selectedSessionLiveRun?.threadId ?? null;
    const bridgeMessageIndex =
      liveAssistantBridge?.sessionId === activeRunSessionId &&
      liveAssistantBridge.threadId === liveThreadId
        ? liveAssistantBridge.messageIndex
        : liveAssistantMessageIndex;
    if (liveRunAssistantText) {
      return {
        sessionId: activeRunSessionId,
        threadId: liveThreadId,
        messageIndex: bridgeMessageIndex,
        text: liveRunAssistantText,
      };
    }

    return shouldProjectLiveAssistantBridge({
      bridge: liveAssistantBridge,
      activeSessionId: activeRunSessionId,
      hasLiveRun: selectedSessionLiveRun !== null,
      hasPersistedAssistant: hasPersistedLiveAssistantBridge,
      isSettling: isLiveAssistantBridgeSettling,
    })
      ? liveAssistantBridge
      : null;
  }, [
    activeRunSessionId,
    hasPersistedLiveAssistantBridge,
    isLiveAssistantBridgeSettling,
    liveAssistantBridge,
    liveAssistantMessageIndex,
    liveRunAssistantText,
    selectedSessionLiveRun,
    selectedSessionLiveRun?.threadId,
  ]);
  const messageListProjection = useMemo(
    () => appendTurnExecutionsToMessageList(
      buildMessageListProjection(displayedMessages, projectedAuxiliarySessions, selectedSession?.id, {
        liveAssistant: projectedLiveAssistant,
      }),
      activeAuxiliarySession ? [] : sessionTurnExecutions,
      selectedSession?.runState ?? "idle",
      runningProjectionBarrier?.executionId ?? null,
    ),
    [
      activeAuxiliarySession,
      displayedMessages,
      projectedAuxiliarySessions,
      projectedLiveAssistant,
      sessionTurnExecutions,
      runningProjectionBarrier?.executionId,
      selectedSession?.id,
      selectedSession?.runState,
    ],
  );
  const messageListMessages = messageListProjection.messages;
  const messageListSources = messageListProjection.sources;
  const messageListKeys = messageListProjection.keys;
  const messageListGroups = messageListProjection.groups;
  const messageListTurnExecutions = messageListProjection.turnExecutions;
  useEffect(() => {
    if (!activeRunSessionId || !liveRunAssistantText) {
      return;
    }

    const liveThreadId = selectedSessionLiveRun?.threadId ?? null;
    setLiveAssistantBridge((current) => {
      if (current?.sessionId === activeRunSessionId && current.threadId === liveThreadId) {
        return {
          ...current,
          text: liveRunAssistantText,
        };
      }

      return {
        sessionId: activeRunSessionId,
        threadId: liveThreadId,
        messageIndex: liveAssistantMessageIndex,
        text: liveRunAssistantText,
      };
    });
  }, [activeRunSessionId, liveAssistantMessageIndex, liveRunAssistantText, selectedSessionLiveRun?.threadId]);
  useEffect(() => {
    if (!liveAssistantBridge) {
      return;
    }

    if (liveAssistantBridge.sessionId !== activeRunSessionId) {
      setLiveAssistantBridge(null);
      return;
    }

    if (!isLiveAssistantBridgeSettling) {
      return;
    }

    let secondFrameId: number | null = null;
    const firstFrameId = requestAnimationFrame(() => {
      secondFrameId = requestAnimationFrame(() => {
        setLiveAssistantBridge((current) =>
          current?.sessionId === liveAssistantBridge.sessionId &&
          current.threadId === liveAssistantBridge.threadId &&
          current.text === liveAssistantBridge.text
            ? null
            : current,
        );
      });
    });

    return () => {
      cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== null) {
        cancelAnimationFrame(secondFrameId);
      }
    };
  }, [activeRunSessionId, isLiveAssistantBridgeSettling, liveAssistantBridge]);
  useEffect(() => {
    if (!liveAssistantBridge) {
      return;
    }

    if (!hasPersistedLiveAssistantBridge) {
      return;
    }

    let secondFrameId: number | null = null;
    const firstFrameId = requestAnimationFrame(() => {
      secondFrameId = requestAnimationFrame(() => {
        setLiveAssistantBridge((current) =>
          current?.sessionId === liveAssistantBridge.sessionId &&
          current.threadId === liveAssistantBridge.threadId &&
          current.text === liveAssistantBridge.text
            ? null
            : current,
        );
      });
    });

    return () => {
      cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== null) {
        cancelAnimationFrame(secondFrameId);
      }
    };
  }, [hasPersistedLiveAssistantBridge, liveAssistantBridge]);
  const displayedMessagesScrollSignature = useMemo(
    () => buildDisplayedMessagesScrollSignature(messageListMessages),
    [messageListMessages],
  );
  const pendingBubbleScrollSignature = useMemo(
    () =>
      [
        selectedSessionRunState ?? "",
        selectedSessionLiveRun?.errorMessage ?? "",
        selectedSessionLiveRun?.approvalRequest
          ? [
              selectedSessionLiveRun.approvalRequest.requestId,
              selectedSessionLiveRun.approvalRequest.summary,
              selectedSessionLiveRun.approvalRequest.warning ?? "",
            ].join("\u001d")
          : "",
        selectedSessionLiveRun?.elicitationRequest
          ? [
              selectedSessionLiveRun.elicitationRequest.requestId,
              selectedSessionLiveRun.elicitationRequest.message,
              selectedSessionLiveRun.elicitationRequest.url ?? "",
            ].join("\u001d")
          : "",
      ].join("\u001b"),
    [
      selectedSessionRunState,
      selectedSessionLiveRun?.approvalRequest,
      selectedSessionLiveRun?.elicitationRequest,
      selectedSessionLiveRun?.errorMessage,
    ],
  );
  const activityMonitorScrollSignature = useMemo(
    () => buildLiveRunScrollSignature(selectedSessionLiveRun),
    [selectedSessionLiveRun],
  );
  const messageListScrollSignature = useMemo(
    () =>
      [
        activeRunSessionId ?? "",
        activeAuxiliarySession?.runState ?? selectedSessionRunState ?? "",
        displayedMessagesScrollSignature,
        pendingBubbleScrollSignature,
      ].join("\u001a"),
    [
      activeAuxiliarySession?.runState,
      activeRunSessionId,
      displayedMessagesScrollSignature,
      pendingBubbleScrollSignature,
      selectedSessionRunState,
    ],
  );
  const {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleMessageListSend,
    followMessageListLatest,
  } = useSessionMessageListFollowing({
    ownerKey: activeRunSessionId,
    scrollSignature: messageListScrollSignature,
    enabled: !isCentralPreviewActive,
  });

  useEffect(() => {
    syncActiveAuxiliarySessionRef({
      activeSession: activeAuxiliarySession,
      activeSessionRef: activeAuxiliarySessionRef,
    });
  }, [activeAuxiliarySession]);

  useEffect(() => {
    applyComposerDraftClearCommand({
      setDraft,
      setComposerCaret,
      syncMainComposerCaret: (selectionStart) => {
        mainComposerCaretRef.current = selectionStart;
      },
      nextCaret: 0,
    });
    setComposerPreview(createEmptyComposerPreview());
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setIsComposerImeComposing(false);
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    setLiveRunState({ ownerSessionId: selectedSessionId, state: null });
    setProviderQuotaTelemetryState((current) =>
      current.ownerProviderId === (selectedSession?.provider ?? null)
        ? current
        : {
            ownerProviderId: selectedSession?.provider ?? null,
            telemetry: null,
          },
    );
    setSessionContextTelemetryState({ ownerSessionId: selectedSessionId, telemetry: null });
    setIsRetryDraftReplacePending(false);
    setApprovalActionRequestId(null);
    setElicitationActionRequestId(null);
  }, [selectedSession?.provider, selectedSessionId]);

  useEffect(() => {
    setComposerPreview((current) => (
      current.attachments.length === 0 && current.errors.length === 0
        ? current
        : createEmptyComposerPreview()
    ));
  }, [activeAuxiliarySession?.composerDraft, draft]);

  useEffect(() => {
    setApprovalActionRequestId(null);
  }, [selectedSessionLiveRun?.approvalRequest?.requestId]);

  useEffect(() => {
    setElicitationActionRequestId(null);
  }, [selectedSessionLiveRun?.elicitationRequest?.requestId]);

  useEffect(() => {
    if (!draft.trim()) {
      setIsRetryDraftReplacePending(false);
    }
  }, [draft]);

  useLayoutEffect(() => {
    const isActivityMonitorVisible = visibleSessionRunState === "running";
    const activityMonitorElement = activityMonitorRef.current;
    const currentSignature = activityMonitorScrollSignature;
    const wasSameSession = activityMonitorSessionIdRef.current === selectedSessionId;
    const hasSignatureChanged = activityMonitorSignatureRef.current !== currentSignature;

    if (!isActivityMonitorVisible) {
      activityMonitorSessionIdRef.current = selectedSessionId;
      activityMonitorSignatureRef.current = currentSignature;
      setIsActivityMonitorFollowing(true);
      setHasActivityMonitorUnread(false);
      return;
    }

    if (!activityMonitorElement) {
      activityMonitorSessionIdRef.current = selectedSessionId;
      activityMonitorSignatureRef.current = currentSignature;
      return;
    }

    if (!wasSameSession) {
      activityMonitorSessionIdRef.current = selectedSessionId;
      activityMonitorSignatureRef.current = currentSignature;
      setIsActivityMonitorFollowing(true);
      setHasActivityMonitorUnread(false);
      activityMonitorElement.scrollTop = activityMonitorElement.scrollHeight;
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    activityMonitorSignatureRef.current = currentSignature;

    if (isActivityMonitorFollowing) {
      activityMonitorElement.scrollTop = activityMonitorElement.scrollHeight;
      return;
    }

    setHasActivityMonitorUnread(true);
  }, [activityMonitorScrollSignature, isActivityMonitorFollowing, visibleSessionRunState, selectedSessionId]);

  useEffect(() => {
    let active = true;

    if (!withmateApi || !selectedSession || !activeRunSessionId) {
      setLiveRunState({ ownerSessionId: null, state: null });
      return () => {
        active = false;
      };
    }

    const activeAuxiliarySessionId = activeAuxiliarySession?.id ?? null;
    const refreshCompletedAuxiliarySession = (sessionId: string) => {
      void runActiveAuxiliarySessionRefreshAndApply({
        sessionId,
        activeSessionId: activeAuxiliarySessionId,
        loadAuxiliarySession: (targetSessionId) => withmateApi.getAuxiliarySession(targetSessionId),
        isActive: () => active,
        setActiveSession: setActiveAuxiliarySession,
        activeSessionRef: activeAuxiliarySessionRef,
      }).catch((error) => {
        console.error(error);
      });
    };

    const unsubscribe = startLiveSessionRunSubscription({
      sessionId: activeRunSessionId,
      api: withmateApi,
      applyLiveRunState: setLiveRunState,
      onSessionRunUpdated: refreshCompletedAuxiliarySession,
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeAuxiliarySession?.id, activeRunSessionId, selectedSession, withmateApi]);

  useEffect(() => {
    const providerId = displayedSession?.provider ?? null;

    return startProviderQuotaTelemetrySubscription({
      api: withmateApi,
      providerId,
      enabled: providerId === "copilot",
      applyProviderQuotaTelemetry: setProviderQuotaTelemetryState,
    });
  }, [displayedSession?.provider, withmateApi]);

  useEffect(() => {
    const sessionId = activeRunSessionId;
    const providerId = displayedSession?.provider ?? null;

    return startSessionContextTelemetrySubscription({
      api: withmateApi,
      sessionId,
      enabled: providerId === "copilot",
      applySessionContextTelemetry: setSessionContextTelemetryState,
    });
  }, [activeRunSessionId, displayedSession?.provider, withmateApi]);

  const selectedProviderCatalog = useMemo(
    () => (modelCatalog && displayedSession ? getProviderCatalog(modelCatalog.providers, displayedSession.provider) : null),
    [displayedSession, modelCatalog],
  );
  const isCopilotSession = displayedSession?.provider === "copilot";
  const selectedCopilotQuotaProjection = useMemo(
    () => (isCopilotSession ? buildCopilotQuotaProjection(selectedProviderQuotaTelemetry) : null),
    [isCopilotSession, selectedProviderQuotaTelemetry],
  );
  const selectedCopilotRemainingPercentLabel = selectedCopilotQuotaProjection?.remainingPercentLabel ?? "unavailable";
  const selectedCopilotRemainingRequestsLabel = selectedCopilotQuotaProjection?.remainingRequestsLabel ?? "usage unavailable";
  const selectedCopilotQuotaResetLabel = selectedCopilotQuotaProjection?.resetLabel ?? "未確認";
  const selectedSessionContextTelemetryProjection = useMemo(
    () => buildSessionContextTelemetryProjection(selectedSessionContextTelemetry),
    [selectedSessionContextTelemetry],
  );
  const availableReasoningEfforts = useMemo(
    () =>
      selectedProviderCatalog && displayedSession
        ? getReasoningEffortOptionsForModel(selectedProviderCatalog, displayedSession.model)
        : [],
    [displayedSession, selectedProviderCatalog],
  );
  const modelOptions = useMemo(() => {
    if (!selectedProviderCatalog) {
      return [];
    }

    const options = [...selectedProviderCatalog.models];
    if (!displayedSession) {
      return options;
    }

    const hasSelectedModel = options.some((model) => model.id === displayedSession.model);
    if (!hasSelectedModel) {
      options.unshift({
        id: displayedSession.model,
        label: displayedSession.model,
        reasoningEfforts: availableReasoningEfforts.length > 0 ? [...availableReasoningEfforts] : [displayedSession.reasoningEffort],
      });
    }

    return options;
  }, [availableReasoningEfforts, displayedSession, selectedProviderCatalog]);
  const lastUserMessage = useMemo(
    () =>
      selectedSession
        ? [...selectedSession.messages].reverse().find((message) => message.role === "user") ?? null
        : null,
    [selectedSession],
  );
  const latestTerminalAuditLog = useMemo(
    () => selectedSessionAuditLogs.find((entry) =>
      entry.sessionId === activeRunSessionId && isTerminalAuditLogPhase(entry.phase)
    ) ?? null,
    [activeRunSessionId, selectedSessionAuditLogs],
  );
  const latestCommandProjection = useMemo(
    () => buildLatestCommandProjection({
      liveSteps: selectedSessionLiveRun?.steps ?? [],
      auditOperations: latestTerminalAuditLog?.operations ?? [],
      latestTerminalAuditPhase: latestTerminalAuditLog?.phase,
    }),
    [latestTerminalAuditLog?.operations, latestTerminalAuditLog?.phase, selectedSessionLiveRun?.steps],
  );
  const latestLiveCommandStep = latestCommandProjection.latestLiveCommandStep;
  const latestCommandView = latestCommandProjection.latestCommandView;
  const orderedLiveRunSteps = useMemo(
    () =>
      (selectedSessionLiveRun?.steps ?? [])
        .map((step, index) => ({ step, index }))
        .sort((left, right) => {
          const bucketDiff =
            liveRunStepBucketPriority(left.step.status) - liveRunStepBucketPriority(right.step.status);
          return bucketDiff !== 0 ? bucketDiff : left.index - right.index;
        })
        .map(({ step }) => step),
    [selectedSessionLiveRun?.steps],
  );
  const runningDetailsEntries = useMemo(
    () => buildRunningDetailsEntries({
      liveSteps: orderedLiveRunSteps,
      latestLiveCommandStepId: latestLiveCommandStep?.id ?? null,
    }),
    [latestLiveCommandStep?.id, orderedLiveRunSteps],
  );
  const selectedBackgroundTasks = useMemo(
    () => selectedSessionLiveRun?.backgroundTasks ?? [],
    [selectedSessionLiveRun?.backgroundTasks],
  );
  const liveRunReasoningText = selectedSessionLiveRun?.reasoningText ?? "";
  const hasLiveRunReasoningText = liveRunReasoningText.trim().length > 0;
  const hasReasoningCapability =
    availableReasoningEfforts.length > 0 || Boolean(selectedSession?.reasoningEffort);
  const availableContextPaneTabs = useMemo(
    () => resolveAvailableContextPaneTabs({
      isCopilotSession,
      hasCompanionGroupMonitor: selectedCompanionGroupMonitorEntries.length > 0,
      hasReasoningCapability,
      hasReasoningText: hasLiveRunReasoningText,
    }),
    [hasLiveRunReasoningText, hasReasoningCapability, isCopilotSession, selectedCompanionGroupMonitorEntries.length],
  );

  const hasInProgressLiveRunStep = useMemo(
    () => orderedLiveRunSteps.some((step) => step.status === "in_progress"),
    [orderedLiveRunSteps],
  );

  const selectedContextEmptyText = useMemo(
    () =>
      resolveSessionMicrocopy("empty.context", [
        "context-empty",
        selectedSession?.id,
        selectedSession?.updatedAt,
      ]),
    [
      appSettings.userMicrocopyCatalog,
      selectedSession?.id,
      selectedSession?.updatedAt,
      selectedSessionCharacter?.name,
    ],
  );
  const latestCommandEmptyText = useMemo(
    () => resolveSessionMicrocopy(
      visibleSessionRunState === "running" ? "empty.latest_command.waiting" : "empty.latest_command",
      [
        "latest-command-empty",
        selectedSession?.id,
        visibleSessionRunState,
        latestTerminalAuditLog?.id,
      ],
    ),
    [
      appSettings.userMicrocopyCatalog,
      latestTerminalAuditLog?.id,
      selectedSession?.id,
      selectedSessionCharacter?.name,
      visibleSessionRunState,
    ],
  );
  const retryBanner = useMemo<RetryBannerState | null>(() => {
    if (!selectedSession || !shouldShowRetryBanner({
      hasActiveAuxiliarySession: !!activeAuxiliarySession,
      hasLastUserMessage: !!lastUserMessage,
      isReadOnly: isSelectedSessionReadOnly,
      runState: selectedSessionRunState,
    })) {
      return null;
    }

    const source = resolveRetryBannerSource({
      sessionId: selectedSession.id,
      messages: selectedSession.messages,
      auditLogs: selectedSessionAuditLogs,
      runState: selectedSessionRunState,
    });
    if (!source) {
      return null;
    }

    const { kind, lastRequestText, terminalAuditLog } = source;

    switch (kind) {
      case "interrupted":
        return {
          kind,
          badge: "中断",
          title: resolveSessionMicrocopy("retry.interrupted.title", [
            "retry",
            "interrupted",
            selectedSession.id,
            lastRequestText,
          ]),
          lastRequestText,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: resolveSessionMicrocopy("retry.failed.title", [
            "retry",
            "failed",
            selectedSession.id,
            lastRequestText,
          ]),
          lastRequestText,
        };
      case "canceled":
        return {
          kind,
          badge: "キャンセル",
          title: resolveSessionMicrocopy("retry.canceled.title", [
            "retry",
            "canceled",
            selectedSession.id,
            lastRequestText,
            terminalAuditLog?.id,
          ]),
          lastRequestText,
        };
      default:
        return null;
    }
  }, [
    lastUserMessage,
    appSettings.userMicrocopyCatalog,
    selectedSession,
    selectedSessionAuditLogs,
    selectedSessionCharacter?.name,
    selectedSessionRunState,
    isSelectedSessionReadOnly,
    activeAuxiliarySession,
  ]);
  const shouldProtectDraftOnRetryEdit = shouldProtectRetryEditDraft({ retryBanner, draft });
  const queueAdmissionErrorMessage = queueAdmissionError && queueAdmissionError.sessionId === selectedSession?.id
    ? queueAdmissionError.error.message
    : "";
  const queueAdmissionBlockingMessage = queueAdmissionError?.error.code === "DELIVERY_UNKNOWN"
    ? ""
    : queueAdmissionErrorMessage;
  const composerInputErrors = queueAdmissionBlockingMessage
    ? [...composerPreview.errors, queueAdmissionBlockingMessage]
    : composerPreview.errors;
  const isComposerDisabled = !!composerBlockedReason || isSelectedSessionReadOnly;
  const composerSendability = useMemo(
    () =>
      resolveComposerSendabilityState({
        runState: selectedSessionRunState,
        allowSendWhileRunning: true,
        busyReason: composerBusyReason,
        blockedReason: sessionExecutionBlockedReason,
        inputErrors: composerInputErrors,
        draftText: draft,
        forceBlockedFeedback: forceComposerBlockedFeedback,
      }),
    [
      composerBusyReason,
      composerInputErrors,
      draft,
      forceComposerBlockedFeedback,
      selectedSessionRunState,
      sessionExecutionBlockedReason,
    ],
  );
  const isSendDisabled = composerSendability.isSendDisabled;
  const composerSendButtonTitle = getComposerSendButtonTitle(composerSendability);
  const isRetryActionDisabled = resolveRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: !!lastUserMessage,
    composerBlocked: !!composerBlockedReason,
    isReadOnly: isSelectedSessionReadOnly,
    runState: selectedSessionRunState,
  });
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const actionDockRuntimeState = buildActionDockRuntimeState({
    isActionDockPinnedExpanded,
    forceReasons: [
      isAgentPickerOpen,
      isSkillPickerOpen,
      isRetryDraftReplacePending,
    ],
  });
  const {
    isActionDockExpanded,
    canCollapseActionDock,
  } = actionDockRuntimeState;
  const renderedCustomAgentName = displayedSession?.customAgentName ?? "";
  const selectedCustomAgent = useMemo(() => {
    if (!renderedCustomAgentName.trim()) {
      return null;
    }

    const normalizedSelectedAgentName = renderedCustomAgentName.trim().toLowerCase();
    return availableCustomAgents.find((agent) => agent.name.trim().toLowerCase() === normalizedSelectedAgentName) ?? null;
  }, [availableCustomAgents, renderedCustomAgentName]);
  const selectedCustomAgentDisplay = useMemo(
    () => buildSelectedCustomAgentDisplay(displayedSession, selectedCustomAgent),
    [displayedSession, selectedCustomAgent],
  );
  const {
    approvalChoiceOptions,
    sandboxChoiceOptions,
    modelSelectOptions,
    selectedModelFallbackLabel,
    reasoningSelectOptions,
  } = useMemo(
    () => buildRuntimeSelectionOptions({
      providerId: displayedSession?.provider,
      providerCatalog: selectedProviderCatalog,
      models: modelOptions,
      selectedModel: displayedSession?.model ?? "",
      reasoningEfforts: availableReasoningEfforts,
      selectedApprovalMode: displayedSession?.approvalMode ?? "untrusted",
      selectedCodexSandboxMode: displayedSession?.codexSandboxMode ?? "workspace-write",
    }),
    [
      displayedSession?.provider,
      displayedSession?.approvalMode,
      displayedSession?.codexSandboxMode,
      displayedSession?.model,
      modelOptions,
      selectedProviderCatalog,
      availableReasoningEfforts,
    ],
  );
  const customAgentItems = useMemo(
    () => {
      const items: {
        key: string;
        value: string | null;
        primaryLabel: string;
        secondaryLabel: string;
        title: string;
        isSelected: boolean;
      }[] = [
        {
          key: "default",
          value: null,
          primaryLabel: "Default Agent",
          secondaryLabel: "Copilot の標準 agent を使う",
          title: "Custom Agent を使わない",
          isSelected: !renderedCustomAgentName,
        },
      ];

      return items.concat(
        availableCustomAgents.map((agent) => {
          const agentDisplay = buildCustomAgentMatchDisplay(agent);
          const isSelected = renderedCustomAgentName.trim().toLowerCase() === agent.name.trim().toLowerCase();
          return {
            key: agent.id,
            value: agent.name,
            primaryLabel: agentDisplay.primaryLabel,
            secondaryLabel: agentDisplay.secondaryLabel,
            title: agentDisplay.title,
            isSelected,
          };
        }),
      );
    },
    [availableCustomAgents, renderedCustomAgentName],
  );
  const skillItems = useMemo(
    () =>
      availableSkills.map((skill) => {
        const skillDisplay = buildSkillMatchDisplay(skill);
        return {
          key: skill.id,
          skillId: skill.id,
          primaryLabel: skillDisplay.primaryLabel,
          secondaryLabel: skillDisplay.secondaryLabel,
          title: skillDisplay.title,
          searchText: `${skill.name}\n${skill.description}`,
        };
      }),
    [availableSkills],
  );
  const composerAttachmentItems = useMemo(
    () =>
      buildComposerAttachmentItems(composerPreview.attachments, { trimRemoveTargets: true }),
    [composerPreview.attachments],
  );
  const additionalDirectoryItems = useMemo(
    () =>
      displayedSession
        ? buildAdditionalDirectoryItems(
            displayedSession.allowedAdditionalDirectories,
            displayedSession.provider === "codex",
          )
        : [],
    [displayedSession],
  );
  const isSessionHeaderExpanded = isHeaderExpanded || isEditingTitle;
  const {
    sessionDockLayoutRef,
    headerDockRef,
    actionDockRef,
    sessionDockLayoutStyle,
    isActionDockResizing,
    handleStartActionDockResize,
    handleHeaderSplitterClick,
    handleActionDockSplitterClick,
  } = useSessionVerticalDockResize({
    ownerKey: selectedSessionId,
    isHeaderExpanded: isSessionHeaderExpanded,
    isActionDockExpanded,
  });
  useEffect(() => {
    if (!retryBanner) {
      setIsRetryDraftReplacePending(false);
    }
  }, [retryBanner]);

  useEffect(() => {
    setForceComposerBlockedFeedback(false);
  }, [selectedSession?.id]);

  const triggerComposerBlockedFeedback = () => {
    if (!selectedSession) {
      return;
    }

    setForceComposerBlockedFeedback(true);
  };

  const sendMessage = async (
    messageText: string,
    options?: { clearDraft?: boolean; collapseActionDock?: boolean; submitSource?: "composer" | "retry" },
  ) => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    const sessionId = selectedSession.id;
    const submitLease = sessionSubmitCoordinatorRef.current.tryAcquire(sessionId);
    if (!submitLease) {
      setForceComposerBlockedFeedback(true);
      return;
    }
    setPendingSubmitSessionId(sessionId);

    const retryRequest = enqueueRetryRef.current;
    const clientRequestId = retryRequest?.sessionId === sessionId && retryRequest.messageText === messageText
      ? retryRequest.clientRequestId
      : createSessionTurnClientRequestId();
    const draftFingerprint = fingerprintSessionDraft(messageText);

    const investigationStartedAt = Date.now();
    logSessionRunStuckInvestigation("renderer.send.start", {
      sessionId,
      clientRequestId,
      submitSource: options?.submitSource ?? "composer",
      draftFingerprint,
      runState: selectedSession.runState,
      status: selectedSession.status,
      messageCount: selectedSession.messages.length,
      hasLiveRun: !!selectedSessionLiveRun,
      draftChars: messageText.length,
    });

    try {
      if (sessionExecutionBlockedReason || isSelectedSessionReadOnly) {
        setForceComposerBlockedFeedback(true);
        return;
      }

      if (!await validateSessionWorkspace(selectedSession)) {
        setForceComposerBlockedFeedback(true);
        return;
      }

      const previewRequest = createComposerPreviewRequest({
        api: withmateApi,
        mode: "session",
        sessionId,
      });
      if (!previewRequest) {
        return;
      }

      const nextMessage = messageText.trim();
      const preview = await previewRequest(messageText);
      const displayPreview = resolveComposerPreviewDisplay(preview, appSettings.userMicrocopyCatalog);
      logSessionRunStuckInvestigation("renderer.composer-preview.done", {
        sessionId,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        attachmentCount: preview.attachments.length,
        errorCount: preview.errors.length,
      });
      setComposerPreview(displayPreview);
      const { blockedMessage } = resolveComposerSendPreflight({
        runState: selectedSessionRunState,
        allowSendWhileRunning: true,
        blockedReason: sessionExecutionBlockedReason,
        inputErrors: displayPreview.errors,
        draftText: messageText,
      });
      if (blockedMessage) {
        setForceComposerBlockedFeedback(true);
        return;
      }

      const shouldClearDraft = options?.clearDraft ?? true;

      const request: RunSessionTurnRequest = {
        userMessage: messageText,
        clientRequestId,
        submitSource: options?.submitSource ?? "composer",
        model: selectedSession.model,
        reasoningEffort: selectedSession.reasoningEffort,
        approvalMode: selectedSession.approvalMode,
        ...(selectedSession.provider === "codex"
          ? { codexSandboxMode: selectedSession.codexSandboxMode }
          : { customAgentName: selectedSession.customAgentName }),
      };
      try {
        const result = await withmateApi.enqueueSessionTurn(sessionId, request);
        if (!result.ok) {
          enqueueRetryRef.current = result.error.retryable
            ? { sessionId, messageText, clientRequestId }
            : null;
          setQueueAdmissionError({ sessionId, error: result.error });
          return;
        }
        enqueueRetryRef.current = null;
        setQueueAdmissionError((current) => current?.sessionId === sessionId ? null : current);
        await refreshSessionTurnExecutionsRef.current(sessionId);
        if (shouldClearDraft) {
          setDraft((current) => current === messageText ? "" : current);
        }
        handleMessageListSend(appSettings.scrollToLatestOnSend);
        if (options?.collapseActionDock) {
          setIsActionDockPinnedExpanded(false);
        }
        logSessionRunStuckInvestigation("renderer.enqueue-session-turn.resolved", {
          sessionId,
          clientRequestId,
          elapsedMs: Date.now() - investigationStartedAt,
          executionId: result.execution?.executionId ?? null,
        });
      } catch (error) {
        logSessionRunStuckInvestigation("renderer.enqueue-session-turn.failed", {
          sessionId,
          clientRequestId,
          elapsedMs: Date.now() - investigationStartedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.error(error);
        enqueueRetryRef.current = { sessionId, messageText, clientRequestId };
        setQueueAdmissionError({
          sessionId,
          error: {
            code: "DELIVERY_UNKNOWN",
            message: "送信結果を確認できませんでした。同じ内容を再送すると登録結果を照合します。",
            retryable: true,
          },
        });
      }
    } finally {
      submitLease.release();
      setPendingSubmitSessionId((current) => current === sessionId ? null : current);
      setForceComposerBlockedFeedback(false);
    }
  };

  const handleSend = async () => {
    if (activeAuxiliarySession) {
      const auxiliaryDraft = activeAuxiliarySession.composerDraft;
      if (!auxiliaryDraft.trim() || activeAuxiliarySession.runState === "running") {
        triggerComposerBlockedFeedback();
        return;
      }

      try {
        setForceComposerBlockedFeedback(false);
        await sendAuxiliaryMessage(auxiliaryDraft);
      } catch (error) {
        window.alert(resolveSessionRunErrorMessage(error, "送信に失敗したよ。"));
      }
      return;
    }

    if (isSendDisabled) {
      triggerComposerBlockedFeedback();
      return;
    }

    try {
      setForceComposerBlockedFeedback(false);
      await sendMessage(draft, {
        clearDraft: true,
        collapseActionDock: appSettings.autoCollapseActionDockOnSend,
        submitSource: "composer",
      });
    } catch (error) {
      window.alert(resolveSessionRunErrorMessage(error, "送信に失敗したよ。"));
    }
  };

  const handleCancelRun = async () => {
    try {
      await runRunningSessionCancelOperation({
        target: buildRunningSessionCancelTarget({
          sessionId: selectedSession?.id,
          runState: selectedSessionRunState,
          isRunning: isSelectedSessionRunning,
        }),
        cancelRun: withmateApi ? (sessionId) => withmateApi.cancelSessionRun(sessionId) : null,
      });
    } catch (error) {
      window.alert(resolveSessionRunErrorMessage(error, "キャンセルに失敗したよ。"));
    }
  };

  const handleCancelQueuedTurn = async (execution: SessionQueuedTurn) => {
    if (!withmateApi || cancelingExecutionIds.has(execution.executionId)) return;
    setCancelingExecutionIds((current) => new Set(current).add(execution.executionId));
    try {
      const result = await withmateApi.cancelSessionExecution(execution.sessionId, {
        executionId: execution.executionId,
        clientRequestId: createSessionTurnClientRequestId(),
      });
      const latest = await withmateApi.listSessionTurnExecutions(execution.sessionId);
      sessionTurnExecutionsRef.current = latest;
      setSessionTurnExecutions(latest);
      if (!result.ok) {
        window.alert(result.error.message);
      }
    } catch (error) {
      try {
        const latest = await withmateApi.listSessionTurnExecutions(execution.sessionId);
        sessionTurnExecutionsRef.current = latest;
        setSessionTurnExecutions(latest);
      } catch (refreshError) {
        console.error(refreshError);
      }
      window.alert(resolveSessionRunErrorMessage(error, "待機中Turnのキャンセルに失敗しました。"));
    } finally {
      setCancelingExecutionIds((current) => {
        const next = new Set(current);
        next.delete(execution.executionId);
        return next;
      });
    }
  };

  const handleResolveLiveApproval = async (request: LiveApprovalRequest, decision: "approve" | "deny") => {
    if (!withmateApi || !activeRunSessionId || approvalActionRequestId === request.requestId) {
      return;
    }

    const sessionId = activeRunSessionId;
    setApprovalActionRequestId(request.requestId);
    try {
      await withmateApi.resolveLiveApproval(sessionId, request.requestId, decision);
      const latestLiveRun = await withmateApi.getLiveSessionRun(sessionId);
      setLiveRunState((current) => replaceLiveRunAfterResolvedRequest(current, {
        sessionId,
        requestId: request.requestId,
        requestKind: "approval",
        latestLiveRun,
      }));
      setApprovalActionRequestId(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "承認要求の処理に失敗したよ。");
      setApprovalActionRequestId(null);
    }
  };

  const handleResolveLiveElicitation = async (
    request: LiveElicitationRequest,
    response: LiveElicitationResponse,
  ) => {
    if (!withmateApi || !activeRunSessionId || elicitationActionRequestId === request.requestId) {
      return;
    }

    const sessionId = activeRunSessionId;
    setElicitationActionRequestId(request.requestId);
    try {
      await withmateApi.resolveLiveElicitation(sessionId, request.requestId, response);
      const latestLiveRun = await withmateApi.getLiveSessionRun(sessionId);
      setLiveRunState((current) => replaceLiveRunAfterResolvedRequest(current, {
        sessionId,
        requestId: request.requestId,
        requestKind: "elicitation",
        latestLiveRun,
      }));
      setElicitationActionRequestId(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "入力要求の処理に失敗したよ。");
      setElicitationActionRequestId(null);
    }
  };

  const handleComposerSubmitKey = createComposerSubmitKeyHandler({
    isSubmitDisabled: () => (
      activeAuxiliarySession
        ? activeAuxiliarySession.runState === "running"
        : false
    ),
    isSubmitBlocked: () => {
      const activeSendability = activeAuxiliarySession
        ? buildComposerSendabilityState({
            runState: activeAuxiliarySession.runState,
            busyReason: composerBusyReason,
            blockedReason: sessionExecutionBlockedReason,
            inputErrors: composerPreview.errors,
            draftText: activeAuxiliarySession.composerDraft,
          })
        : composerSendability;
      return activeAuxiliarySession
        ? activeSendability.isSendDisabled || isAuxiliaryActionPending
        : isSendDisabled;
    },
    notifySubmitBlocked: triggerComposerBlockedFeedback,
    submit: () => void handleSend(),
  });

  const handleComposerKeyDown = buildComposerDraftKeyDownHandler({
    submit: handleComposerSubmitKey,
  });

  const handleSelectSkill = createSkillPromptInsertionHandler<DiscoveredSkill>({
    getProvider: () => selectedSession?.provider,
    getDraft: () => draft,
    getTextarea: () => composerTextareaRef.current,
    setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
    setCaret: setComposerCaret,
    setSkillPickerOpen: setIsSkillPickerOpen,
    applyDraft: (nextDraft, nextCaret) => {
      applyComposerDraftChangeCommand({
        value: nextDraft,
        selectionStart: nextCaret,
        setDraft,
        syncMainComposerCaret: (selectionStart) => {
          mainComposerCaretRef.current = selectionStart;
        },
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  const closeAgentPicker = createAgentPickerCloseHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
  });

  const handleSelectCustomAgent = async (agent: DiscoveredCustomAgent | null) => {
    if (!selectedSession || isSelectedSessionReadOnly || selectedSession.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === selectedSession.customAgentName) {
      closeAgentPicker();
      return;
    }

    const nextSession: Session = applyCopilotCustomAgentSelection(
      selectedSession,
      nextCustomAgentName,
      currentTimestampLabel(),
    );

    await persistSession(nextSession);
    closeAgentPicker();
  };

  const persistSession = async (nextSession: Session) => {
    if (!withmateApi || isSelectedSessionReadOnly) {
      throw new Error(
        isSelectedSessionReadOnly
          ? "閲覧専用セッションは更新できないよ。新しいセッションを作成してください。"
          : "Session Window は Electron から開いてね。",
      );
    }

    const savedSession = await withmateApi.updateSession(nextSession);
    setAuthoritativeSessions([savedSession]);
    return savedSession;
  };

  const handleToggleSessionPin = async () => {
    if (!withmateApi || !selectedSession || isSessionPinPending) {
      return;
    }
    setIsSessionPinPending(true);
    try {
      const saved = await withmateApi.setSessionPinned({
        sessionId: selectedSession.id,
        isPinned: selectedSession.isPinned !== true,
      });
      setSessionProjection((current) => current.map((session) => (
        session.id === saved.id ? { ...session, isPinned: saved.isPinned } : session
      )));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "ピン止めの変更に失敗したよ。");
    } finally {
      setIsSessionPinPending(false);
    }
  };

  const handleChangeApproval = async (approvalMode: Session["approvalMode"]) => {
    if (
      !selectedSession ||
      isSelectedSessionReadOnly ||
      selectedSessionRunState === "running"
    ) {
      return;
    }

    const nextSession = buildSessionWithApprovalMode(
      selectedSession,
      approvalMode,
      currentTimestampLabel(),
    );
    if (!nextSession) {
      return;
    }

    await persistSession(nextSession);
  };

  const handleChangeCodexSandboxMode = async (codexSandboxMode: Session["codexSandboxMode"]) => {
    if (
      !selectedSession ||
      selectedSession.provider !== "codex" ||
      isSelectedSessionReadOnly ||
      selectedSessionRunState === "running"
    ) {
      return;
    }

    const nextSession = buildSessionWithCodexSandboxMode(
      selectedSession,
      codexSandboxMode,
      currentTimestampLabel(),
    );
    if (!nextSession) {
      return;
    }

    await persistSession(nextSession);
  };

  const handleStartTitleEdit = createStartTitleEditHandler({
    getTitle: () => selectedSession?.taskTitle,
    canStart: () => !!selectedSession && !isSelectedSessionReadOnly && selectedSessionRunState !== "running",
    setTitleDraft,
    setHeaderExpanded: () => {},
    setEditingTitle: setIsEditingTitle,
  });

  const handleCancelTitleEdit = createCancelTitleEditHandler({
    getTitle: () => selectedSession?.taskTitle,
    setTitleDraft,
    setEditingTitle: setIsEditingTitle,
  });

  const handleSaveTitle = async () => {
    if (!selectedSession || isSelectedSessionReadOnly) {
      return;
    }

    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleDraft(selectedSession.taskTitle);
      setIsEditingTitle(false);
      return;
    }

    if (nextTitle === selectedSession.taskTitle) {
      setIsEditingTitle(false);
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      taskTitle: nextTitle,
      updatedAt: currentTimestampLabel(),
    };

    await persistSession(nextSession);
    setIsEditingTitle(false);
  };

  const handleDeleteSession = async () => {
    if (!withmateApi || !selectedSession || selectedSessionRunState === "running") {
      return;
    }

    const confirmed = window.confirm(`セッション「${selectedSession.taskTitle}」を削除する？`);
    if (!confirmed) {
      return;
    }

    await withmateApi.deleteSession(selectedSession.id);
    handleCloseWindow();
  };

  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (!withmateApi) {
      return;
    }

    await withmateApi.openDiffWindow(diffPreview);
  };

  const handleChangeModel = async (model: string) => {
    if (!selectedSession || isSelectedSessionReadOnly || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const nextSession = buildSessionWithModelChange(
      selectedSession,
      selectedProviderCatalog,
      model,
      modelCatalog.revision,
      currentTimestampLabel(),
    );

    await persistSession(nextSession);
  };

  const handleChangeReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedSession || isSelectedSessionReadOnly || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const nextSession = buildSessionWithReasoningEffort(
      selectedSession,
      selectedProviderCatalog,
      reasoningEffort,
      modelCatalog.revision,
      currentTimestampLabel(),
    );

    await persistSession(nextSession);
  };

  const updateActiveAuxiliarySession = async (recipe: (current: AuxiliarySession) => AuxiliarySession) => {
    await createGuardedActiveAuxiliarySessionUpdater({
      activeSession: activeAuxiliarySession,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      getApi: () => withmateApi,
      activeSessionRef: activeAuxiliarySessionRef,
      setActiveSession: setActiveAuxiliarySession,
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
    })(recipe);
  };

  const handleChangeAuxiliaryApproval = async (approvalMode: Session["approvalMode"]) => {
    await runAuxiliaryApprovalModeChangeOperation({
      approvalMode,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleChangeAuxiliarySandboxMode = async (codexSandboxMode: Session["codexSandboxMode"]) => {
    await runAuxiliarySandboxModeChangeOperation({
      codexSandboxMode,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleChangeAuxiliaryModel = async (model: string) => {
    if (!selectedProviderCatalog || !modelCatalog) {
      return;
    }

    await runAuxiliaryModelChangeOperation({
      model,
      providerCatalog: selectedProviderCatalog,
      catalogRevision: modelCatalog.revision,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleChangeAuxiliaryReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedProviderCatalog || !modelCatalog || !activeAuxiliarySession) {
      return;
    }

    await runAuxiliaryReasoningEffortChangeOperation({
      reasoningEffort,
      providerCatalog: selectedProviderCatalog,
      catalogRevision: modelCatalog.revision,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleSelectAuxiliaryCustomAgent = async (agent: DiscoveredCustomAgent | null) => {
    const nextCustomAgentName = (agent?.name ?? "").trim();
    await runAuxiliaryCustomAgentSelectionOperation({
      activeSession: activeAuxiliarySession,
      customAgentName: nextCustomAgentName,
      updateCustomAgent: async (customAgentName) => {
        await runAuxiliaryCustomAgentPatchOperation({
          customAgentName,
          updateActiveAuxiliarySession,
          createTimestampLabel: currentTimestampLabel,
        });
      },
      closeAgentPicker,
    });
  };

  const handleSelectAuxiliarySkill = async (skill: DiscoveredSkill) => {
    const textarea = composerTextareaRef.current;
    await runAuxiliarySkillPromptInsertionOperation({
      activeSession: activeAuxiliarySession,
      skillName: skill.name,
      applyUiState: (nextState) => {
        applySkillPromptInsertionUiState({
          state: nextState,
          setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
          setCaret: setComposerCaret,
          setSkillPickerOpen: setIsSkillPickerOpen,
        });
      },
      updateDraft: async (draft) => {
        await runAuxiliaryDraftPatchOperation({
          draft,
          updateActiveAuxiliarySession,
          createTimestampLabel: currentTimestampLabel,
        });
      },
      afterDraftUpdated: (nextState) => {
        restoreComposerTextareaFocusAndCaret(textarea, nextState.caret);
      },
    });
  };

  const handleResendLastMessage = async () => {
    await runRetryResendCommand({
      isDisabled: !!composerBlockedReason || isSelectedSessionReadOnly,
      messageText: lastUserMessage?.text,
      resendMessage: (messageText) => sendMessage(messageText, { clearDraft: false, submitSource: "retry" }),
    });
  };

  const restoreLastUserMessageToDraft = (messageText: string) => {
    const textarea = composerTextareaRef.current;
    applyRetryDraftRestoreCommand({
      messageText,
      setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
      setDraft,
      setCaret: setComposerCaret,
      syncCaret: (caret) => {
        mainComposerCaretRef.current = caret;
      },
      setRetryDraftReplacePending: setIsRetryDraftReplacePending,
      focusComposer: (caret) => restoreComposerTextareaFocusAndCaret(textarea, caret),
    });
  };

  const handleEditLastMessage = createRetryEditHandler({
    isDisabled: !retryBanner || isRetryEditDisabled,
    messageText: lastUserMessage?.text,
    shouldProtectDraft: shouldProtectDraftOnRetryEdit,
    requestDraftReplaceConfirmation: () => setIsRetryDraftReplacePending(true),
    restoreDraft: restoreLastUserMessageToDraft,
  });

  const handleConfirmRetryDraftReplace = createRetryDraftReplaceConfirmationHandler({
    isDisabled: !retryBanner || isRetryEditDisabled,
    messageText: lastUserMessage?.text,
    restoreDraft: restoreLastUserMessageToDraft,
  });

  const handleCancelRetryDraftReplace = createCancelRetryDraftReplaceHandler({
    setRetryDraftReplacePending: setIsRetryDraftReplacePending,
  });

  const handleCloseWindow = () => {
    window.close();
  };

  const handleToggleHeaderExpanded = createHeaderExpandedToggleHandler({
    isEditingTitle,
    setHeaderExpanded: setIsHeaderExpanded,
  });

  const handleExpandActionDock = createActionDockExpandHandler({
    setPinnedExpanded: setIsActionDockPinnedExpanded,
    focusComposer: () => restoreCurrentComposerTextareaFocusToEnd(() => composerTextareaRef.current),
  });

  const handleCollapseActionDock = createActionDockCollapseHandler({
    canCollapse: canCollapseActionDock,
    setPinnedExpanded: setIsActionDockPinnedExpanded,
  });

  const handleToggleHeaderSplitter = () => {
    handleHeaderSplitterClick(handleToggleHeaderExpanded);
  };

  const handleToggleActionDock = () => {
    handleActionDockSplitterClick(
      isActionDockExpanded ? handleCollapseActionDock : handleExpandActionDock,
    );
  };

  const handleToggleAgentPicker = createAgentPickerToggleHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
    setSkillPickerOpen: setIsSkillPickerOpen,
  });

  const handleToggleSkillPicker = createSkillPickerToggleHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
    setSkillPickerOpen: setIsSkillPickerOpen,
  });

  const handleToggleAdditionalDirectoryList = createAdditionalDirectoryListToggleHandler({
    setAdditionalDirectoryListOpen: setIsAdditionalDirectoryListOpen,
  });

  const handleOpenInlinePath = async (target: string) => {
    if (!withmateApi || !activeRunSessionId) {
      return;
    }
    const ownerSessionId = activeRunSessionId;
    inlinePathOperationRevisionRef.current.advance();
    const operationRevision = inlinePathOperationRevisionRef.current.capture();
    try {
      const result = await withmateApi.openSessionFilePreviewWindow({
        kind: "link",
        sessionId: ownerSessionId,
        target,
      });
      if (!inlinePathOperationRevisionRef.current.isCurrent(operationRevision)) {
        return;
      }
      setInlinePathError(result.status === "opened"
        ? null
        : { ownerSessionId, target, message: result.message });
    } catch (error) {
      if (!inlinePathOperationRevisionRef.current.isCurrent(operationRevision)) {
        return;
      }
      setInlinePathError({
        ownerSessionId,
        target,
        message: error instanceof Error ? error.message : "The path could not be opened.",
      });
    }
  };

  const handleCancelAuxiliaryRun = async () => {
    try {
      await runRunningSessionCancelOperation({
        target: buildAuxiliarySessionCancelTarget({ session: activeAuxiliarySession }),
        cancelRun: withmateApi ? (sessionId) => withmateApi.cancelAuxiliarySessionRun(sessionId) : null,
      });
    } catch (error) {
      window.alert(resolveSessionRunErrorMessage(error, "キャンセルに失敗したよ。"));
    }
  };

  const handleOpenAuxiliaryLaunchDialog = createAuxiliaryLaunchDialogOpenHandler({
    canOpen: () => !!selectedSession && !isAuxiliaryActionPending,
    providers: auxiliaryLaunchProviderItems,
    getSelectedProviderId: () => selectedSession?.provider,
    openAuxiliaryLaunchDialog,
  });

  const handleCloseAuxiliaryLaunchDialog = createAuxiliaryLaunchDialogCloseHandler({
    canClose: () => !isAuxiliaryActionPending,
    closeAuxiliaryLaunchDialog,
  });

  const handleSelectAuxiliaryLaunchProvider = createAuxiliaryLaunchProviderSelectHandler({
    selectAuxiliaryLaunchProvider,
  });

  const handleStartAuxiliarySession = async () => {
    if (!withmateApi || !selectedSession || isAuxiliaryActionPending) {
      return;
    }
    const setAuxiliaryStartError = createAuxiliarySessionStartErrorHandler({
      setLaunchStartError: setAuxiliaryLaunchStartError,
    });
    const startProvider = resolveAuxiliaryLaunchStartProvider({
      providerId: auxiliaryLaunchProviderId,
    });
    if (startProvider.status === "blocked") {
      setAuxiliaryStartError(startProvider.error);
      return;
    }
    const launchProviderId = startProvider.providerId;

    const loadRevision = beginAuxiliarySessionStartOperation({
      loadRevision: auxiliaryLoadRevisionRef,
      resetLaunchFeedback: resetAuxiliaryLaunchFeedback,
      setActionPending: setIsAuxiliaryActionPending,
    });
    const parentSessionId = selectedSession.id;
    const canApplyLoadResult = createAuxiliaryLoadRevisionGuard({
      loadRevision: auxiliaryLoadRevisionRef,
      expectedRevision: loadRevision,
    });

    try {
      await runSessionWindowAuxiliarySessionStartOperation({
        parentSessionId,
        provider: launchProviderId,
        createAuxiliarySession: (request) => withmateApi.createAuxiliarySession(request),
        applyStartedSession: createActiveAuxiliarySessionStartResultApplier({
          mutationRevision: auxiliarySessionMutationRevisionRef,
          activeSessionRef: activeAuxiliarySessionRef,
          setActiveSession: setActiveAuxiliarySession,
          setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
          setForceComposerBlockedFeedback,
          closeLaunchDialog: closeAuxiliaryLaunchDialog,
        }),
      });
    } catch (error) {
      setAuxiliaryStartError(error);
    } finally {
      finishAuxiliarySessionStartClosedLoadWithApi({
        parentSessionId,
        api: withmateApi,
        isActive: canApplyLoadResult,
        setClosedSessions: setClosedAuxiliarySessions,
        setActionPending: setIsAuxiliaryActionPending,
      });
    }
  };

  const handleReturnToMainSession = async () => {
    await runGuardedAuxiliarySessionReturnToMainOperationWithApi({
      api: withmateApi,
      activeSession: activeAuxiliarySession,
      isActionPending: isAuxiliaryActionPending,
      alertError: (message) => window.alert(message),
      setActionPending: setIsAuxiliaryActionPending,
      loadRevision: auxiliaryLoadRevisionRef,
      setClosedSessions: setClosedAuxiliarySessions,
      mutationRevision: auxiliarySessionMutationRevisionRef,
      activeSessionRef: activeAuxiliarySessionRef,
      setActiveSession: setActiveAuxiliarySession,
      mainDraft: draft,
      mainCaret: mainComposerCaretRef.current,
      setComposerCaret,
      setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
      setForceComposerBlockedFeedback,
    });
  };

  const handleAuxiliaryDraftChange = async (value: string, selectionStart: number) => {
    await runAuxiliaryDraftChangeAndSaveOperation({
      draft: value,
      selectionStart,
      clearBlockedFeedback: () => setForceComposerBlockedFeedback(false),
      setComposerCaret,
      currentSession: activeAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
      draftSaveQueue: auxiliaryDraftSaveQueueRef.current,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      saveAuxiliarySession: withmateApi
        ? (request) => enqueueAuxiliarySessionSaveWithQueue(
            auxiliarySessionSaveQueueRef,
            () => withmateApi.updateAuxiliarySession(request),
          )
        : null,
      mutationRevision: auxiliarySessionMutationRevisionRef,
      activeSessionRef: activeAuxiliarySessionRef,
      draftSaveQueueRef: auxiliaryDraftSaveQueueRef,
      setActiveSession: setActiveAuxiliarySession,
      onError: (error) => {
        console.error(error);
      },
    });
  };

  const sendAuxiliaryMessage = async (messageText: string) => {
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    const result = await runAuxiliarySessionSendOperationWithApi({
      activeSession: activeAuxiliarySession,
      composerBlockedReason,
      messageText,
      parentMessageCount: selectedSession?.messages.length ?? null,
      updatedAt: currentTimestampLabel(),
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      beforeRunningSessionApplied: () => {
        setIsActionDockPinnedExpanded(false);
      },
      applyRunningSession: createAuxiliarySessionRunningApplier({
        activeSessionRef: activeAuxiliarySessionRef,
        setActiveSession: setActiveAuxiliarySession,
        updateLiveRunState: (update) => setLiveRunState(update),
        buildRuntimeSession: (runningSession) => buildMainAuxiliaryRuntimeSession(
          selectedSession!,
          runningSession,
        ),
      }),
      afterRunningSessionApplied: (runningSession) => {
        if (isCentralPreviewActive) {
          setPreviewChatActivity((current) => acknowledgePreviewChatMessageCount(
            current,
            runningSession.id,
            runningSession.messages.length,
          ));
        }
      },
      ...createAuxiliarySessionSendResultAppliers({
        activeSessionRef: activeAuxiliarySessionRef,
        setActiveSession: setActiveAuxiliarySession,
      }),
      clearPendingLiveRun: createAuxiliarySessionPendingLiveRunClearer({
        updateLiveRunState: (update) => setLiveRunState(update),
      }),
      api: withmateApi,
    });
    handleAuxiliarySessionSendOperationResult({
      result,
      onBlocked: (preflight) => {
        throw new Error(preflight.blockedMessage);
      },
      onRunningTargetBlocked: () => {
        throw new Error("Auxiliary Session はまだ実行中だよ。");
      },
      onError: (error) => {
        console.error(error);
        throw error;
      },
    });
  };

  const handleCopyMessageText = createCopyMessageTextHandler({
    writeText: (normalized) => navigator.clipboard.writeText(normalized),
    onFailure: (error) => {
      console.error(error);
      window.alert("コピーに失敗したよ。");
    },
  });

  const handleQuoteMessageText = createQuoteMessageTextHandler({
    isBlocked: () => (
      activeAuxiliarySession
        ? activeAuxiliarySession.runState === "running" || isAuxiliaryActionPending || !!composerBlockedReason
        : isComposerDisabled
    ),
    notifyBlocked: triggerComposerBlockedFeedback,
    getComposerState: () => ({
      draft: activeAuxiliarySession ? activeAuxiliarySession.composerDraft : draft,
      fallbackCaret: activeAuxiliarySession ? composerCaret : mainComposerCaretRef.current,
      textarea: composerTextareaRef.current,
    }),
    applyInsertion: ({ draft: nextDraft, caret: nextCaret }) => {
      if (activeAuxiliarySession) {
        void handleAuxiliaryDraftChange(nextDraft, nextCaret);
        return;
      }

      applyComposerDraftChangeCommand({
        value: nextDraft,
        selectionStart: nextCaret,
        setDraft,
        setComposerCaret,
        syncMainComposerCaret: (selectionStart) => {
          mainComposerCaretRef.current = selectionStart;
        },
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  const insertReferencePaths = (selectedPaths: string[]) => {
    const textarea = composerTextareaRef.current;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = targetAuxiliarySession ? targetAuxiliarySession.composerDraft : draft;
    applySelectedPathReferenceInsertionCommand({
      draft: currentDraft,
      fallbackCaret: composerCaret,
      selectedPaths,
      textarea,
      workspacePath: selectedSession?.workspacePath ?? null,
      applyInsertion: (insertionState) => {
        const { draft: nextDraft, caret: nextCaret } = insertionState;
        if (targetAuxiliarySession) {
          void handleAuxiliaryDraftChange(nextDraft, nextCaret);
          setComposerCaret(nextCaret);
        } else {
          applyComposerDraftChangeCommand({
            value: nextDraft,
            selectionStart: nextCaret,
            setDraft,
            setComposerCaret,
            syncMainComposerCaret: (selectionStart) => {
              mainComposerCaretRef.current = selectionStart;
            },
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  const insertReferencePath = (selectedPath: string) => {
    insertReferencePaths([selectedPath]);
  };

  const insertPastedAttachments = (references: ComposerReferenceInput[]) => {
    const textarea = composerTextareaRef.current;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = targetAuxiliarySession ? targetAuxiliarySession.composerDraft : draft;
    applyComposerReferenceInsertionCommand({
      draft: currentDraft,
      fallbackCaret: composerCaret,
      references,
      textarea,
      applyInsertion: ({ draft: nextDraft, caret: nextCaret }) => {
        if (targetAuxiliarySession) {
          void handleAuxiliaryDraftChange(nextDraft, nextCaret);
          setComposerCaret(nextCaret);
        } else {
          applyComposerDraftChangeCommand({
            value: nextDraft,
            selectionStart: nextCaret,
            setDraft,
            setComposerCaret,
            syncMainComposerCaret: (selectionStart) => {
              mainComposerCaretRef.current = selectionStart;
            },
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  };

  const handleRemoveAttachmentReference = createPathReferenceRemovalHandler({
    getDraft: () => activeAuxiliarySession ? activeAuxiliarySession.composerDraft : draft,
    applyRemoval: (nextState) => {
      const { draft: nextDraft, caret: nextCaret } = nextState;
      if (activeAuxiliarySession) {
        void handleAuxiliaryDraftChange(nextDraft, nextCaret);
        setComposerCaret(nextCaret);
      } else {
        applyComposerDraftChangeCommand({
          value: nextDraft,
          selectionStart: nextCaret,
          setDraft,
          setComposerCaret,
          syncMainComposerCaret: (selectionStart) => {
            mainComposerCaretRef.current = selectionStart;
          },
        });
      }
    },
  });

  const pickAndInsertPath = async (kind: ComposerPathPickerKind) => {
    if (!withmateApi || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await pickComposerReferencePath(
      kind,
      pickerBaseDirectory || selectedSession?.workspacePath || null,
      withmateApi,
    );
    applyPickedComposerReferencePathCommand({
      kind,
      selectedPath,
      setPickerBaseDirectory,
      insertReferencePath: (path) => insertReferencePath(path),
    });
  };

  const handleAddToSessionFiles = async () => {
    if (!withmateApi || !selectedSession || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickFiles(pickerBaseDirectory || selectedSession.workspacePath || null);
    if (selectedPaths.length === 0) {
      return;
    }

    const savedPaths = await withmateApi.copyFilesToSessionFiles(selectedSession.id, selectedPaths);
    if (savedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: savedPaths,
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handlePickSessionFiles = async () => {
    if (!withmateApi || !selectedSession || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickSessionFiles(selectedSession.id);
    if (selectedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: selectedPaths,
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handlePickSessionFolder = async () => {
    if (!withmateApi || !selectedSession || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionFolder(selectedSession.id);
    if (!selectedPath) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths: [selectedPath],
      referencePaths: [selectedPath],
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handlePickSessionImage = async () => {
    if (!withmateApi || !selectedSession || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionImageFile(selectedSession.id);
    if (!selectedPath) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths: [selectedPath],
      referencePaths: [selectedPath],
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  };

  const handleComposerPaste = createPastedSessionAttachmentHandler({
    alertError: (message) => window.alert(message),
    canPaste: () => {
      const targetAuxiliarySession = activeAuxiliarySession;
      return !!withmateApi &&
        !!selectedSession &&
        !isSelectedSessionReadOnly &&
        !(targetAuxiliarySession
          ? targetAuxiliarySession.runState === "running"
          : selectedSessionRunState === "running");
    },
    currentTimestampLabel,
    fallbackErrorMessage: "貼り付けたファイルの保存に失敗したよ。",
    getSavePastedSessionFile: () => {
      return withmateApi ? (request) => withmateApi.savePastedSessionFile(request) : null;
    },
    getSessionId: () => selectedSession?.id,
    insertAttachments: insertPastedAttachments,
  });

  const handleAddAdditionalDirectory = async () => {
    await runPickedAdditionalDirectoryOperation({
      canPickDirectory: () => !!withmateApi &&
        !!selectedSession &&
        !isSelectedSessionReadOnly &&
        selectedSessionRunState !== "running",
      getPickerBaseDirectory: () => resolveAdditionalDirectoryPickerBase(pickerBaseDirectory, selectedSession?.workspacePath),
      pickDirectory: (baseDirectory) => withmateApi?.pickDirectory(baseDirectory) ?? Promise.resolve(null),
      applyPickedDirectory: async (selectedPath) => {
        if (!selectedSession) {
          return;
        }
        const nextSession: Session = buildSessionWithAddedAdditionalDirectory(selectedSession, selectedPath);
        applyPickedAdditionalDirectoryUiStateCommand({
          selectedPath,
          setPickerBaseDirectory,
        });
        await persistSession(nextSession);
      },
    });
  };

  const handleRemoveAdditionalDirectory = async (directoryPath: string) => {
    await runAdditionalDirectoryRemovalOperation({
      directoryPath,
      canRemoveDirectory: () => !!selectedSession &&
        !isSelectedSessionReadOnly &&
        selectedSession.provider === "codex" &&
        selectedSessionRunState !== "running",
      removeDirectory: async (targetPath) => {
        if (!selectedSession) {
          return false;
        }
        const nextSession = buildSessionWithRemovedAdditionalDirectory(selectedSession, targetPath);
        if (!nextSession) {
          return false;
        }
        await persistSession(nextSession);
        return true;
      },
    });
  };

  const handleAddAuxiliaryAdditionalDirectory = async () => {
    await runAddAuxiliaryAdditionalDirectoryOperationWithApi({
      api: withmateApi,
      hasParentSession: !!selectedSession,
      activeAuxiliarySession,
      pickerBaseDirectory,
      workspacePath: selectedSession?.workspacePath,
      setPickerBaseDirectory,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleRemoveAuxiliaryAdditionalDirectory = async (directoryPath: string) => {
    await runRemoveAuxiliaryAdditionalDirectoryOperation({
      directoryPath,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleTitleInputKeyDown = createTitleInputKeyHandler({
    saveTitle: () => void handleSaveTitle(),
    cancelTitleEdit: handleCancelTitleEdit,
  });

  const toggleArtifact = createExpandedArtifactToggleHandler({
    setExpandedArtifacts,
  });

  const scrollActivityMonitorToBottom = () => {
    const activityMonitorElement = activityMonitorRef.current;
    if (!activityMonitorElement) {
      return;
    }

    activityMonitorElement.scrollTop = activityMonitorElement.scrollHeight;
  };

  const handleActivityMonitorScroll = () => {
    const activityMonitorElement = activityMonitorRef.current;
    if (!activityMonitorElement) {
      return;
    }

    const bottomGap = Math.max(
      0,
      activityMonitorElement.scrollHeight - activityMonitorElement.clientHeight - activityMonitorElement.scrollTop,
    );
    const nextFollowing = bottomGap <= 48;

    setIsActivityMonitorFollowing((current) => (current === nextFollowing ? current : nextFollowing));
    if (nextFollowing) {
      setHasActivityMonitorUnread(false);
    }
  };

  const handleOpenSessionTerminal = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    try {
      await withmateApi.openSessionTerminal(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "terminal の起動に失敗したよ。");
    }
  };

  const handleOpenSessionExplorer = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    showOpenPathFeedback(await resolveOpenPathFeedback(
      () => withmateApi.openPath(selectedSession.workspacePath),
      "Explorer を開けなかったよ。",
    ));
  };

  const handleOpenSessionFilesTerminal = createSessionFilesOpenHandler({
    getSessionId: () => selectedSession?.id,
    getOpenSessionFiles: () => (
      withmateApi ? (sessionId) => withmateApi.openSessionFilesTerminal(sessionId) : null
    ),
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "session files terminal の起動に失敗したよ。",
  });

  const handleOpenSessionFilesExplorer = createSessionFilesOpenHandler({
    getSessionId: () => selectedSession?.id,
    getOpenSessionFiles: () => (
      withmateApi ? (sessionId) => withmateApi.openSessionFilesDirectory(sessionId) : null
    ),
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "session files directory を開けなかったよ。",
  });

  const handleJumpToActivityMonitorBottom = () => {
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    scrollActivityMonitorToBottom();
  };

  const pendingRunIndicatorText = isApprovalRequestPending || isElicitationRequestPending
    ? resolveSessionMicrocopy("dock.status.approval", [
      "pending",
      "approval",
      selectedSession?.id,
      liveApprovalRequest?.requestId,
      liveElicitationRequest?.requestId,
    ])
    : hasInProgressLiveRunStep
      ? resolveSessionMicrocopy("dock.status.working", [
        "pending",
        "working",
        selectedSession?.id,
        selectedSessionLiveRun?.threadId,
        orderedLiveRunSteps.map((step) => `${step.id}:${step.status}`).join("|"),
      ])
      : hasLiveRunAssistantText
        ? resolveSessionMicrocopy("dock.status.responding", [
          "pending",
          "responding",
          selectedSession?.id,
          selectedSessionLiveRun?.threadId,
        ])
        : resolveSessionMicrocopy("dock.status.preparing", [
          "pending",
          "preparing",
          selectedSession?.id,
          selectedSessionLiveRun?.threadId,
        ]);
  const pendingRunIndicatorAnnouncement = pendingRunIndicatorText;
  const pendingMessageText = resolveSessionMicrocopy("chat.pending.response_waiting", [
    "chat",
    "pending",
    selectedSession?.id,
    selectedSessionLiveRun?.threadId,
  ]);
  const isSelectedSessionRunning = resolveSelectedSessionIsRunning({
    runState: selectedSessionRunState,
  });
  const renderedIsRunning = activeAuxiliarySession
    ? activeAuxiliarySession.runState === "running"
    : isSelectedSessionRunning;
  const contextPaneProjection = useMemo(
    () => buildContextPaneProjection({
      activeContextPaneTab,
      latestCommandView,
      backgroundTasks: selectedBackgroundTasks,
      companionGroupMonitorEntries: selectedCompanionGroupMonitorEntries,
      hasReasoningText: hasLiveRunReasoningText,
      isSelectedSessionRunning: renderedIsRunning,
    }),
    [
      activeContextPaneTab,
      hasLiveRunReasoningText,
      latestCommandView,
      renderedIsRunning,
      selectedBackgroundTasks,
      selectedCompanionGroupMonitorEntries,
    ],
  );

  useEffect(() => {
    applyUnavailableContextPaneTabFallbackCommand({
      activeTab: activeContextPaneTab,
      availableTabs: availableContextPaneTabs,
      setActiveTab: setActiveContextPaneTab,
    });
  }, [activeContextPaneTab, availableContextPaneTabs]);

  const handleCycleContextPaneTab = createContextPaneTabCycleHandler({
    availableTabs: availableContextPaneTabs,
    setActiveTab: setActiveContextPaneTab,
  });

  const auxiliaryComposerSendability = useMemo(
    () => buildComposerSendabilityState({
      runState: activeAuxiliarySession?.runState,
      busyReason: composerBusyReason,
      blockedReason: sessionExecutionBlockedReason,
      inputErrors: composerPreview.errors,
      draftText: activeAuxiliarySession?.composerDraft ?? "",
    }),
    [
      activeAuxiliarySession?.composerDraft,
      activeAuxiliarySession?.runState,
      composerBusyReason,
      composerPreview.errors,
      sessionExecutionBlockedReason,
    ],
  );
  const renderedSession = displayedSession;
  const renderedMessages = messageListMessages;
  const renderedDraft = activeAuxiliarySession ? activeAuxiliarySession.composerDraft : draft;
  const handleOpenPromptTemplates = () => {
    if (isPromptTemplateWorkspaceOpen) {
      closeCentralPreview();
      return;
    }
    const textarea = composerTextareaRef.current;
    const fallbackCaret = activeAuxiliarySession ? composerCaret : mainComposerCaretRef.current;
    promptTemplateSelectionRef.current = {
      start: textarea?.selectionStart ?? fallbackCaret,
      end: textarea?.selectionEnd ?? fallbackCaret,
    };
    fileRootDiffRequestRevisionRef.current += 1;
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(null);
    if (!isCentralPreviewActive && activeRunSessionId) {
      setPreviewChatActivity(beginPreviewChatActivity(activeRunSessionId, activeRunMessageCount));
    }
    setIsPromptTemplateWorkspaceOpen(true);
  };
  const handleInsertPromptTemplate = (prompt: string) => {
    if (scheduleDraftRef.current && scheduleModeActive) {
      const current = scheduleDraftRef.current;
      const nextPrompt = current.prompt.trim() ? `${current.prompt.trim()}\n\n${prompt}` : prompt;
      updateScheduleDraft({ ...current, prompt: nextPrompt });
      closeCentralPreview();
      return;
    }
    const insertion = insertComposerTextAtSelection(
      renderedDraft,
      prompt,
      promptTemplateSelectionRef.current.start,
      promptTemplateSelectionRef.current.end,
    );
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(insertion.draft, insertion.caret);
    } else {
      applyComposerDraftChangeCommand({
        value: insertion.draft,
        selectionStart: insertion.caret,
        setDraft,
        setComposerCaret,
        syncMainComposerCaret: (caret) => {
          mainComposerCaretRef.current = caret;
        },
        clearFeedback: () => setForceComposerBlockedFeedback(false),
      });
    }
    closeCentralPreview();
    window.requestAnimationFrame(() => {
      restoreComposerTextareaFocusAndCaret(composerTextareaRef.current, insertion.caret);
    });
  };
  const renderedComposerSendability = activeAuxiliarySession ? auxiliaryComposerSendability : composerSendability;
  const renderedIsSendDisabled = activeAuxiliarySession
    ? auxiliaryComposerSendability.isSendDisabled || isAuxiliaryActionPending
    : isSendDisabled;
  const renderedComposerButtonTitle = activeAuxiliarySession
    ? getComposerSendButtonTitle(auxiliaryComposerSendability)
    : composerSendButtonTitle;
  const auxiliaryHeaderActions = createAuxiliaryHeaderActions({
    ...resolveAuxiliaryHeaderActionState({
      isActive: !!activeAuxiliarySession,
      isActionPending: isAuxiliaryActionPending,
      isStartBlocked: isSelectedSessionRunning || isSelectedSessionReadOnly || !isSelectedWorkspaceAvailable,
      activeRunState: activeAuxiliarySession?.runState,
    }),
    onStart: handleOpenAuxiliaryLaunchDialog,
    onReturnToMain: () => void handleReturnToMainSession(),
  });

  if (!desktopRuntime) {
    return <ChatWindowStatusScreen message="Session Window は Electron から開いてね。" />;
  }

  if (!selectedSession || !renderedSession || !selectedSessionCharacter) {
    return <ChatWindowStatusScreen message="Session が選択されていません。Home Window から session を開いてね。" />;
  }

  const fileExplorerRootsRevision = [
    activeRunSessionId ?? "",
    ...(activeAuxiliarySession?.allowedAdditionalDirectories ?? selectedSession.allowedAdditionalDirectories),
  ].join("\u0000");
  const fileExplorerPane = (
    <SessionFileExplorerPane
      api={withmateApi}
      sessionId={activeRunSessionId}
      enabled={isFilesPaneVisible && isSelectedWorkspaceAvailable}
      rootsRevision={fileExplorerRootsRevision}
      selectedFile={selectedFilePreview}
      activeTab={fileExplorerTab}
      onActiveTabChange={setFileExplorerTab}
      onRefreshChanges={() => setFileRootChangesRefreshRevision((current) => current + 1)}
      onOpenFile={(request, openInWindow) => {
        void handleOpenFileRootFile(request, openInWindow).then((message) => {
          if (message) {
            window.alert(message);
          }
        });
      }}
      changesContent={(
        <FileRootChangesPane
          api={withmateApi}
          sessionId={activeRunSessionId}
          enabled={isFilesPaneVisible && isSelectedWorkspaceAvailable && fileExplorerTab === "changes"}
          rootsRevision={fileExplorerRootsRevision}
          refreshRevision={fileRootChangesRefreshRevision}
          onOpenFile={handleOpenFileRootFile}
          onOpenDiff={handleShowFileRootDiff}
        />
      )}
    />
  );
  const previewChatNotice = liveApprovalRequest
    ? "Approval required"
    : liveElicitationRequest
      ? "Input required"
      : renderedIsRunning
        ? "Running"
        : previewChatActivity.hasUnreadMessages && previewChatActivity.ownerSessionId === activeRunSessionId
          ? "New messages"
        : "";
  const scheduleSummaryProjections: ScheduleSummaryProjection[] = sessionSchedules.map((schedule) => ({
    id: schedule.id,
    sessionId: schedule.sessionId,
    sessionTitle: selectedSession.taskTitle,
    revision: schedule.revision,
    name: schedule.name,
    state: schedule.state,
    status: schedule.state,
    trigger: schedule.trigger,
    nextFireAt: schedule.nextFireAt,
    lastFireResult: schedule.latestFire?.errorMessage ?? schedule.latestFire?.state ?? null,
    lastExecutionId: schedule.latestFire?.executionId ?? null,
  }));
  const scheduleContent = scheduleModeActive ? (
    <ScheduleWorkspace
      mode={scheduleView}
      loadState={scheduleLoadState}
      schedules={scheduleSummaryProjections}
      draft={scheduleDraft}
      errorMessage={scheduleError ?? scheduleLoadError}
      onBack={() => scheduleView === "list" ? openScheduleChat() : openScheduleList()}
      onCreate={createScheduleDraft}
      onEdit={(summary) => void editSchedule(summary)}
      onPause={(summary) => void mutateSchedule(summary, "pause")}
      onResume={(summary) => void mutateSchedule(summary, "resume")}
      onDelete={(summary) => void mutateSchedule(summary, "delete")}
      onRunNow={(summary) => void mutateSchedule(summary, "run")}
      onDraftChange={updateScheduleDraft}
    />
  ) : null;
  const actionDockChatNotice = liveApprovalRequest
    ? "Approval required"
    : liveElicitationRequest
      ? "Input required"
      : previewChatActivity.hasUnreadMessages && previewChatActivity.ownerSessionId === activeRunSessionId
        ? "New messages"
        : "";
  const filePreviewContent = scheduleModeActive ? scheduleContent : isPromptTemplateWorkspaceOpen && withmateApi ? (
    <PromptTemplateWorkspace
      api={withmateApi}
      canInsert={activeAuxiliarySession
        ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason && !isAuxiliaryActionPending
        : !isComposerDisabled}
      onBack={closeCentralPreview}
      onInsert={handleInsertPromptTemplate}
    />
  ) : fileRootDiffPendingPreview ? (
    <SessionDiffPreview
      title={`${fileRootDiffPendingPreview.relativePath} · ${fileRootDiffPendingPreview.scope === "staged" ? "Staged" : "Working Tree"}`}
      previewRevision={fileRootDiffPendingPreview.generation}
      patch=""
      loading
      backNavigation={{ label: "Back to Chat", onBack: closeCentralPreview }}
      onCopyText={handleCopyMessageText}
      onQuoteText={handleQuoteMessageText}
      onOpenPreview={() => handleOpenFileRootFile({
        sessionId: fileRootDiffPendingPreview.sessionId,
        rootId: fileRootDiffPendingPreview.rootId,
        relativePath: fileRootDiffPendingPreview.relativePath,
      })}
      onReload={() => handleShowFileRootDiff(fileRootDiffPendingPreview)}
      reloadPending
      chatNotice={previewChatNotice}
    />
  ) : fileRootDiffPreview ? (
    <SessionDiffPreview
      title={`${fileRootDiffPreview.relativePath} · ${fileRootDiffPreview.scope === "staged" ? "Staged" : "Working Tree"}`}
      previewRevision={fileRootDiffPreview.generation}
      patch={fileRootDiffPreview.patch}
      backNavigation={{ label: "Back to Chat", onBack: closeCentralPreview }}
      onCopyText={handleCopyMessageText}
      onQuoteText={handleQuoteMessageText}
      onOpenPreview={() => handleOpenFileRootFile({
        sessionId: fileRootDiffPreview.sessionId,
        rootId: fileRootDiffPreview.rootId,
        relativePath: fileRootDiffPreview.relativePath,
      })}
      onReload={handleReloadFileRootDiff}
      reloadPending={fileRootDiffLoadingScope === fileRootDiffPreview.scope}
      chatNotice={previewChatNotice}
    />
  ) : selectedFilePreview ? (
    <SessionFilePreview
      api={withmateApi}
      request={selectedFilePreview}
      backNavigation={{ label: "Back to Chat", onBack: closeCentralPreview }}
      onCopyText={handleCopyMessageText}
      onQuoteText={handleQuoteMessageText}
      diffScopes={selectedFileDiffScopes}
      diffAvailabilityMessage={selectedFileDiffAvailabilityMessage}
      onOpenDiff={selectedFileDiffScopes.length > 0 ? handleOpenSelectedFileDiff : undefined}
      diffLoadingScope={fileRootDiffLoadingScope}
      chatNotice={previewChatNotice}
    />
  ) : undefined;

  const pickScheduleAttachment = async (kind: ComposerPathPickerKind) => {
    if (!withmateApi || !selectedSession || !scheduleDraft) return;
    const selectedPath = await pickComposerReferencePath(
      kind,
      pickerBaseDirectory || selectedSession.workspacePath || null,
      withmateApi,
    );
    if (!selectedPath) return;
    const prompt = scheduleDraft.attachments.includes(selectedPath)
      ? scheduleDraft.prompt
      : buildComposerReferenceInsertionState(
          scheduleDraft.prompt,
          scheduleDraft.prompt.length,
          [{
            path: selectedPath,
            presentation: kind === "image" ? "image" : "path",
          }],
        )?.draft ?? scheduleDraft.prompt;
    updateScheduleDraft({
      ...scheduleDraft,
      prompt,
      attachments: scheduleDraft.attachments.includes(selectedPath)
        ? scheduleDraft.attachments
        : [...scheduleDraft.attachments, selectedPath],
    });
  };

  const scheduleComposerProps: SessionComposerExpandedProps | undefined = scheduleDraft && scheduleModeActive ? {
    isRunning: false,
    composerBlocked: false,
    canSelectCustomAgent: selectedSession.provider === "copilot",
    showAttachmentControls: true,
    showCustomAgentPicker: selectedSession.provider === "copilot",
    showSkillPicker: false,
    showPromptTemplateButton: true,
    showAdditionalDirectoryControls: true,
    showExecutionModeControls: true,
    isAgentPickerOpen: false,
    isSkillPickerOpen: false,
    isPromptTemplateWorkspaceOpen: false,
    isAdditionalDirectoryListOpen,
    selectedCustomAgentLabel: scheduleDraft.customAgent ?? "Default Agent",
    selectedCustomAgentTitle: "Copilot custom agent を選択",
    additionalDirectoryCount: selectedSession.allowedAdditionalDirectories.length,
    showJumpToBottom: false,
    isCustomAgentListLoading: false,
    customAgentItems,
    attachmentItems: scheduleDraft.attachments.map((path) => ({
      key: path,
      kind: "file",
      kindLabel: "File",
      locationLabel: path,
      primaryLabel: path.split(/[\\/]/).pop() ?? path,
      secondaryLabel: "Schedule attachment",
      title: path,
      removeTargets: [path],
    })),
    draft: scheduleDraft.prompt,
    placeholder: "",
    composerTextareaLabel: "スケジュールのプロンプト",
    composerTextareaRef,
    isComposerDisabled: false,
    isSendDisabled: !scheduleDraft.name.trim() || !scheduleDraft.prompt.trim(),
    composerSendability: { isBusy: false, primaryFeedback: "", secondaryFeedback: [], feedbackTone: null, shouldShowFeedback: false },
    sendButtonTitle: "スケジュールを保存",
    sendButtonLabel: "スケジュールを保存",
    sendButtonIcon: "✓",
    isComposerBlockedFeedbackActive: false,
    approvalOptions: approvalChoiceOptions,
    selectedApprovalMode: scheduleDraft.approvalMode as Session["approvalMode"],
    sandboxOptions: sandboxChoiceOptions,
    selectedCodexSandboxMode: scheduleDraft.sandboxMode as Session["codexSandboxMode"],
    modelOptions: modelSelectOptions,
    selectedModel: scheduleDraft.model,
    selectedModelFallbackLabel: selectedSession.model,
    reasoningOptions: reasoningSelectOptions,
    selectedReasoningEffort: scheduleDraft.reasoningEffort,
    onPickFile: () => void pickScheduleAttachment("file"),
    onPickFolder: () => void pickScheduleAttachment("folder"),
    onPickImage: () => void pickScheduleAttachment("image"),
    onToggleAgentPicker: () => undefined,
    onToggleSkillPicker: () => undefined,
    onOpenPromptTemplates: handleOpenPromptTemplates,
    onAddAdditionalDirectory: () => void handleAddAdditionalDirectory(),
    onToggleAdditionalDirectoryList: handleToggleAdditionalDirectoryList,
    onJumpToBottom: () => undefined,
    onSelectCustomAgent: (value) => updateScheduleDraft({ ...scheduleDraft, customAgent: value }),
    onRemoveAttachment: (targets) => createPathReferenceRemovalHandler({
      getDraft: () => scheduleDraft.prompt,
      applyRemoval: ({ draft: prompt }, removed) => updateScheduleDraft({
        ...scheduleDraft,
        prompt,
        attachments: scheduleDraft.attachments.filter((path) => !removed.includes(path)),
      }),
    })(targets),
    onDraftChange: (value) => updateScheduleDraft({ ...scheduleDraft, prompt: value }),
    onDraftFocus: () => undefined,
    onDraftKeyDown: () => undefined,
    onDraftSelect: () => undefined,
    onDraftCompositionStart: () => undefined,
    onDraftCompositionEnd: () => undefined,
    onSendOrCancel: () => void saveScheduleDraft(),
    onChangeApprovalMode: (value) => updateScheduleDraft({ ...scheduleDraft, approvalMode: value }),
    onChangeCodexSandboxMode: (value) => updateScheduleDraft({ ...scheduleDraft, sandboxMode: value }),
    onChangeModel: (value) => updateScheduleDraft({ ...scheduleDraft, model: value }),
    onChangeReasoningEffort: (value) => updateScheduleDraft({ ...scheduleDraft, reasoningEffort: value }),
  } : undefined;

  return (
    <>
      <ChatWindow
      {...buildAgentSessionChatWindowProps({
        mainContent: filePreviewContent,
        hideActionDock: scheduleView === "list",
        composerPropsOverride: scheduleComposerProps,
        leftPane: fileExplorerPane,
        isFilesPaneVisible,
        selectedSession: renderedSession,
        selectedSessionCharacter,
        displayedMessages: renderedMessages,
        displayedMessageKeys: messageListKeys,
        displayedMessageGroups: messageListGroups,
        turnExecutions: messageListTurnExecutions,
        originSessionDetails,
        onOpenOriginSession: withmateApi
          ? (sessionId) => void withmateApi.openSession(sessionId)
          : undefined,
        cancelingExecutionIds,
        expandedArtifacts,
        sessionThemeStyle,
        sessionDockLayoutRef,
        headerDockRef,
        actionDockRef,
        sessionDockLayoutStyle,
        sessionWorkbenchRef,
        sessionWorkbenchStyle,
        layoutPriority,
        onActivateSidePanePriority: handleActivateSidePanePriority,
        onActivateDockPriority: handleActivateDockPriority,
        isSessionHeaderExpanded,
        isEditingTitle,
        isSessionPinPending,
        titleDraft,
        isSelectedSessionRunning: renderedIsRunning,
        isSelectedSessionReadOnly: activeAuxiliarySession ? true : isSelectedSessionReadOnly,
        isSelectedSessionPinned: selectedSession.isPinned === true,
        messageListRef,
        pendingRunIndicatorAnnouncement,
        pendingRunIndicatorText,
        pendingMessageText,
        liveApprovalRequest,
        approvalActionRequestId,
        liveElicitationRequest,
        elicitationActionRequestId,
        liveRunAssistantText,
        hasLiveRunAssistantText,
        liveRunErrorMessage: selectedSessionLiveRun?.errorMessage ?? "",
        inlinePathFeedback: inlinePathError?.ownerSessionId === renderedSession.id
          ? inlinePathError.message
          : "",
        workspaceAvailabilityMessage,
        queueAdmissionNotice: queueAdmissionErrorMessage,
        isWorkspaceAvailabilityCheckPending,
        isWorkspaceAvailable: isSelectedWorkspaceAvailable,
        pendingMessageGroupId: resolvePendingAuxiliaryMessageGroupId(activeAuxiliarySession),
        isMessageListFollowing,
        retryBanner: activeAuxiliarySession ? null : retryBanner,
        isRetryActionDisabled,
        isRetryEditDisabled,
        isRetryDraftReplacePending,
        composerBlocked: !!composerBlockedReason,
        isAgentPickerOpen,
        isSkillPickerOpen,
        isPromptTemplateWorkspaceOpen,
        isAdditionalDirectoryListOpen,
        selectedCustomAgentLabel: selectedCustomAgentDisplay.label,
        selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択",
        canCollapseActionDock,
        isCustomAgentListLoading,
        isSkillListLoading,
        skillListError,
        customAgentItems,
        skillItems,
        composerAttachmentItems,
        additionalDirectoryItems,
        draft: renderedDraft,
        composerTextareaRef,
        isComposerDisabled: activeAuxiliarySession
          ? activeAuxiliarySession.runState === "running" || !!composerBlockedReason || isAuxiliaryActionPending
          : isComposerDisabled,
        allowSendWhileRunning: !activeAuxiliarySession,
        isSendDisabled: renderedIsSendDisabled,
        composerSendability: renderedComposerSendability,
        composerSendButtonTitle: renderedComposerButtonTitle,
        isComposerBlockedFeedbackActive:
          forceComposerBlockedFeedback && renderedComposerSendability.feedbackTone === "blocked",
        approvalChoiceOptions,
        sandboxChoiceOptions,
        modelSelectOptions,
        selectedModelFallbackLabel,
        reasoningSelectOptions,
        chatNotice: isCentralPreviewActive ? actionDockChatNotice : "",
        attachmentCount: composerPreview.attachments.length,
        isActionDockExpanded,
        isActionDockResizing,
        isContextRailResizing,
        isFilesPaneResizing,
        isContextRailVisible,
        latestCommandView,
        runningDetailsEntries,
        liveRunReasoningText,
        activeContextPaneTab,
        availableContextPaneTabs,
        contextPaneProjection,
        selectedBackgroundTasks,
        selectedCompanionGroupMonitorEntries,
        isCopilotSession,
        selectedCopilotRemainingPercentLabel,
        selectedCopilotRemainingRequestsLabel,
        selectedCopilotQuotaResetLabel,
        selectedSessionContextTelemetry,
        selectedSessionContextTelemetryProjection,
        selectedContextEmptyText,
        latestCommandEmptyText,
        selectedDiff,
        selectedDiffThemeStyle,
        isAuxiliaryMode,
        auditLogsOpen,
        displayedSessionAuditLogs,
        auditLogSourceLabel,
        auditLogDetails,
        auditLogOperationDetails,
        auditLogsHasMore,
        auditLogsLoading,
        auditLogsTotal,
        auditLogsErrorMessage,
        onToggleHeaderSplitter: handleToggleHeaderSplitter,
        headerActions: (
          <>
            {auxiliaryHeaderActions}
            <button
              className="drawer-toggle compact secondary schedule-header-button"
              type="button"
              aria-label={scheduleModeActive ? "チャットへ戻る" : "スケジュールを開く"}
              title={scheduleModeActive ? "チャットへ戻る" : "スケジュールを開く"}
              onClick={scheduleModeActive ? openScheduleChat : openScheduleList}
            >
              <span aria-hidden="true">{scheduleModeActive ? "←" : "◷"}</span>
            </button>
          </>
        ),
        onOpenAuditLog: () => setAuditLogsOpen(true),
        onOpenSessionTerminal: () => void handleOpenSessionTerminal(),
        onOpenSessionFilesTerminal: () => void handleOpenSessionFilesTerminal(),
        onTitleDraftChange: setTitleDraft,
        onTitleInputKeyDown: handleTitleInputKeyDown,
        onSaveTitle: () => void handleSaveTitle(),
        onCancelTitleEdit: handleCancelTitleEdit,
        onStartTitleEdit: handleStartTitleEdit,
        onDeleteSession: () => void handleDeleteSession(),
        onToggleSessionPin: () => void handleToggleSessionPin(),
        onOpenSessionExplorer: () => void handleOpenSessionExplorer(),
        onOpenSessionFilesExplorer: () => void handleOpenSessionFilesExplorer(),
        onMessageListScroll: handleMessageListScroll,
        onToggleArtifact: toggleArtifact,
        onLoadArtifactDetail: (messageIndex) =>
          loadProjectedMessageArtifact({
            source: messageListSources[messageIndex],
            loadSessionArtifact: (sourceMessageIndex) =>
              withmateApi?.getSessionMessageArtifact(selectedSession.id, sourceMessageIndex) ?? null,
          }),
        onOpenDiff: (title, file) =>
          setSelectedDiff({
            title,
            file,
            themeColors: selectedSession.characterThemeColors,
          }),
        onResolveLiveApproval: (request, decision) => void handleResolveLiveApproval(request, decision),
        onResolveLiveElicitation: (request, response) => void handleResolveLiveElicitation(request, response),
        onOpenInlinePath: handleOpenInlinePath,
        onDismissInlinePathFeedback: () => {
          inlinePathOperationRevisionRef.current.advance();
          setInlinePathError((current) => current?.ownerSessionId === renderedSession.id ? null : current);
        },
        onRecheckWorkspaceAvailability: () => {
          setWorkspaceAvailabilityCheckRevision((current) => current + 1);
        },
        getChangedFilesEmptyText,
        onCopyMessageText: handleCopyMessageText,
        onQuoteMessageText: handleQuoteMessageText,
        onCancelQueuedTurn: (execution) => void handleCancelQueuedTurn(execution),
        onResendLastMessage: () => void handleResendLastMessage(),
        onEditLastMessage: handleEditLastMessage,
        onConfirmRetryDraftReplace: handleConfirmRetryDraftReplace,
        onCancelRetryDraftReplace: handleCancelRetryDraftReplace,
        onPickFile: () => void pickAndInsertPath("file"),
        onPickFolder: () => void pickAndInsertPath("folder"),
        onPickImage: () => void pickAndInsertPath("image"),
        onAddToSessionFiles: () => void handleAddToSessionFiles(),
        onPickSessionFiles: () => void handlePickSessionFiles(),
        onPickSessionFolder: () => void handlePickSessionFolder(),
        onPickSessionImage: () => void handlePickSessionImage(),
        onToggleAgentPicker: handleToggleAgentPicker,
        onToggleSkillPicker: handleToggleSkillPicker,
        onOpenPromptTemplates: handleOpenPromptTemplates,
        onAddAdditionalDirectory: () => void (activeAuxiliarySession ? handleAddAuxiliaryAdditionalDirectory() : handleAddAdditionalDirectory()),
        onToggleAdditionalDirectoryList: handleToggleAdditionalDirectoryList,
        onJumpToMessageListBottom: followMessageListLatest,
        onSelectCustomAgent: (value) => {
          const agent = value ? availableCustomAgents.find((entry) => entry.name === value) ?? null : null;
          if (activeAuxiliarySession) {
            void handleSelectAuxiliaryCustomAgent(agent);
            return;
          }

          void handleSelectCustomAgent(agent);
        },
        onSelectSkill: (skillId) => {
          const skill = availableSkills.find((entry) => entry.id === skillId);
          if (skill) {
            if (activeAuxiliarySession) {
              void handleSelectAuxiliarySkill(skill);
              return;
            }

            handleSelectSkill(skill);
          }
        },
        onRemoveAttachment: handleRemoveAttachmentReference,
        onRemoveAdditionalDirectory: (path) => void (activeAuxiliarySession ? handleRemoveAuxiliaryAdditionalDirectory(path) : handleRemoveAdditionalDirectory(path)),
        onDraftChange: (value, selectionStart) => {
          if (activeAuxiliarySession) {
            void handleAuxiliaryDraftChange(value, selectionStart);
            return;
          }
          applyComposerDraftChangeCommand({
            value,
            selectionStart,
            setDraft,
            setComposerCaret,
            syncMainComposerCaret: (caret) => {
              mainComposerCaretRef.current = caret;
            },
            clearFeedback: () => setForceComposerBlockedFeedback(false),
          });
          if (enqueueRetryRef.current?.messageText !== value) {
            enqueueRetryRef.current = null;
          }
          setQueueAdmissionError((current) => current?.sessionId === selectedSession.id ? null : current);
        },
        onDraftFocus: () => handleExpandActionDock({ focusComposer: false }),
        onDraftKeyDown: handleComposerKeyDown,
        onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void handleComposerPaste(event),
        onDraftSelect: buildOnDraftSelectHandler({
          setComposerCaret,
          syncMainComposerCaret: !activeAuxiliarySession
            ? (selectionStart) => {
                mainComposerCaretRef.current = selectionStart;
              }
            : undefined,
        }),
        ...buildOnDraftCompositionHandlers({
          setComposerCaret,
          setIsComposerImeComposing,
          getSelectionStart: () => composerTextareaRef.current?.selectionStart,
          getFallbackSelectionStart: () => renderedDraft.length,
          syncMainComposerCaret: !activeAuxiliarySession
            ? (selectionStart) => {
                mainComposerCaretRef.current = selectionStart;
              }
            : undefined,
        }),
        onSendOrCancel: activeAuxiliarySession
          ? buildAuxiliaryAwareSendOrCancelHandler({
              shouldSendAuxiliary: true,
              isAuxiliarySessionRunning: activeAuxiliarySession.runState === "running",
              isSelectedSessionRunning,
              preferAuxiliarySendOverSelectedCancel: true,
              onCancelAuxiliaryRun: handleCancelAuxiliaryRun,
              onSendAuxiliary: handleSend,
              onCancelSelectedSessionRun: handleCancelRun,
              onSendSelectedSession: handleSend,
            })
          : () => void handleSend(),
        onCancelRun: activeAuxiliarySession
          ? () => void handleCancelAuxiliaryRun()
          : () => void handleCancelRun(),
        onChangeApprovalMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["approvalMode"]>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliaryApproval,
          onSelectedSessionChange: handleChangeApproval,
        }),
        onChangeCodexSandboxMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["codexSandboxMode"]>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliarySandboxMode,
          onSelectedSessionChange: handleChangeCodexSandboxMode,
        }),
        onChangeModel: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliaryModel,
          onSelectedSessionChange: handleChangeModel,
        }),
        onChangeReasoningEffort: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: (value) => handleChangeAuxiliaryReasoningEffort(value as Session["reasoningEffort"]),
          onSelectedSessionChange: (value) => handleChangeReasoningEffort(value as Session["reasoningEffort"]),
        }),
        onStartContextRailResize: handleStartContextRailResize,
        onStartFilesPaneResize: handleStartFilesPaneResize,
        onStartActionDockResize: handleStartActionDockResize,
        onToggleActionDock: handleToggleActionDock,
        onToggleContextRailVisibility: handleToggleContextRailVisibility,
        onToggleFilesPaneVisibility: handleToggleFilesPaneVisibility,
        onCycleContextPaneTab: handleCycleContextPaneTab,
        onOpenCompanionReview: (sessionId) => void withmateApi?.openCompanionReviewWindow(sessionId),
        onCloseDiff: () => setSelectedDiff(null),
        onOpenDiffWindow: (payload) => void handleOpenDiffWindow(payload),
        onLoadMoreAuditLogs: handleLoadMoreAuditLogs,
        onLoadAuditLogDetail: handleLoadAuditLogDetail,
        onLoadAuditLogOperationDetail: handleLoadAuditLogOperationDetail,
        onCloseAuditLog: () => setAuditLogsOpen(false),
      })}
      />
      <AuxiliaryLaunchProviderDialog
        open={auxiliaryLaunchDialogOpen}
        providers={auxiliaryLaunchProviderItems}
        selectedProviderId={auxiliaryLaunchProviderId}
        feedback={auxiliaryLaunchFeedback}
        starting={isAuxiliaryActionPending}
        onClose={handleCloseAuxiliaryLaunchDialog}
        onSelectProvider={handleSelectAuxiliaryLaunchProvider}
        onStart={() => void handleStartAuxiliarySession()}
      />
    </>
  );
}
