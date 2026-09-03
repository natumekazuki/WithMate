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
  buildSessionWithCodexSpeed,
  buildSessionWithCodexReviewer,
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
  isGlossarySearchRevisionCurrent,
  type ContextPaneTabKey,
  resolveAvailableContextPaneTabs,
  shouldIncludeGlossaryContextPane,
} from "./session-ui-projection.js";
import { buildMainAuxiliaryRuntimeSession } from "./auxiliary-runtime-projection.js";
import {
  useMainAuxiliaryRuntimeSession,
  useMessageListAuxiliarySessions,
} from "./auxiliary-render-projections.js";
import { ChatWindow, ChatWindowStatusScreen } from "./chat/chat-window.js";
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
  createMessageCollapseHeaderAction,
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
  pickComposerReferencePath,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "./session-composer-paths.js";
import {
  applyComposerDraftClearCommand,
  applyComposerDraftChangeCommand,
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
import { FileRootGitHistoryPane } from "./file-explorer/FileRootGitHistoryPane.js";
import type {
  FileRootFileDiffRequest,
  FileRootGitDiffScope,
  FileRootGitHistoryDiffRequest,
  SessionFileGitCommitResourceRequest,
  SessionFileRootResourceRequest,
} from "./file-explorer/file-explorer-contract.js";
import {
  GLOSSARY_RELATIVE_PATH,
  type GlossaryEntry,
  type SessionGlossaryProjection,
} from "./glossary-contract.js";
import { createGlossaryAnnotationMatcher } from "./glossary/glossary-annotation-projection.js";
import {
  buildFileRootDiffPreviewWindowRequest,
  buildSessionFileExplorerRootsRevision,
} from "./file-explorer/file-explorer-contract.js";
import { projectFileRootDiffAvailability } from "./file-explorer/file-preview-utils.js";
import {
  acknowledgePreviewChatMessageCount,
  beginPreviewChatActivity,
  endPreviewChatActivity,
  observePreviewChatMessageCount,
} from "./file-explorer/preview-chat-activity.js";
import {
  applyOptimisticSessionRunUpdate,
  createOwnedPendingLiveSessionRunState,
  replaceLiveRunAfterResolvedRequest,
  resolveSessionRunErrorMessage,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
import {
  LatestRequestRevision,
  SessionSubmitCoordinator,
  StateMutationRevision,
  convergeRejectedLiveRunState,
  convergeRejectedSessionSnapshot,
  convergeResolvedSessionProjection,
  createSessionTurnClientRequestId,
  fingerprintSessionDraft,
  mergeRefetchedSessionProjection,
  mergeRejectedSessionDraft,
  recoverRejectedSessionSnapshot,
} from "./session-submit-coordinator.js";
import { buildAgentSessionChatWindowProps } from "./chat/session-chat-projection.js";
import {
  buildMessageCollapseTargets,
  buildMessageNavigatorEntries,
  reconcileMessageCollapseState,
  toggleAllMessageCollapseState,
  toggleMessageCollapseState,
  type MessageCollapseState,
  type MessageCollapseTarget,
  type MessageJumpRequest,
} from "./session-message-collapse.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { ShortcutSettingsProvider } from "./shortcut-settings-context.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "./open-path-result.js";
import { buildCompanionGroupMonitorEntries } from "./home/home-session-projection.js";
import {
  INITIAL_SESSION_WORKSPACE_AVAILABILITY,
  applySessionWorkspaceAvailabilityResult,
  beginSessionWorkspaceAvailabilityCheck,
  isSessionWorkspaceAvailable,
  resolveSessionWorkspaceExecutionGate,
  resolveSessionWorkspaceUnavailableMessage,
} from "./session-workspace-availability.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import {
  type AuxiliarySession,
} from "./auxiliary-session-state.js";
import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryCodexSpeedChangeOperation,
  runAuxiliaryCodexReviewerChangeOperation,
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
  applyComposerSubmitCommand,
  applyPickedAdditionalDirectoryUiStateCommand,
  applyPickedComposerReferencePathCommand,
  applyComposerReferenceInsertionCommand,
  applyCentralSurfaceOpenCommand,
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
import {
  SHORTCUT_COMMAND_IDS,
  useShortcutCommandHandler,
  useShortcutDispatcherSettings,
  useShortcutScope,
} from "./shortcut-registry.js";

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
  const promptTemplateCloseGuardRef = useRef<(() => boolean) | null>(null);
  const registerPromptTemplateCloseGuard = useCallback((guard: (() => boolean) | null) => {
    promptTemplateCloseGuardRef.current = guard;
  }, []);
  const [selectedFileDiffScopes, setSelectedFileDiffScopes] = useState<FileRootGitDiffScope[]>([]);
  const [selectedFileDiffAvailabilityMessage, setSelectedFileDiffAvailabilityMessage] = useState("");
  const [fileExplorerTab, setFileExplorerTab] = useState<"files" | "changes" | "history">("files");
  const [fileRootChangesRefreshRevision, setFileRootChangesRefreshRevision] = useState(0);
  const [fileRootGitHistoryRefreshRevision, setFileRootGitHistoryRefreshRevision] = useState(0);
  const [fileRootDiffPreview, setFileRootDiffPreview] = useState<{
    sessionId: string;
    rootId: string;
    relativePath: string;
    scope: FileRootGitDiffScope;
    generation: number;
    patch: string;
  } | null>(null);
  const [fileRootDiffPendingPreview, setFileRootDiffPendingPreview] = useState<
    (FileRootFileDiffRequest & { generation: number }) | null
  >(null);
  const [fileRootDiffLoadingScope, setFileRootDiffLoadingScope] = useState<FileRootGitDiffScope | null>(null);
  const [fileRootGitHistoryDiffPreview, setFileRootGitHistoryDiffPreview] = useState<{
    request: FileRootGitHistoryDiffRequest;
    generation: number;
    patch: string;
    previewResource: SessionFileGitCommitResourceRequest | null;
  } | null>(null);
  const [fileRootGitHistoryDiffPendingPreview, setFileRootGitHistoryDiffPendingPreview] = useState<{
    request: FileRootGitHistoryDiffRequest;
    generation: number;
  } | null>(null);
  const [fileRootGitHistoryDiffLoading, setFileRootGitHistoryDiffLoading] = useState(false);
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
  const [messageCollapseWindowState, setMessageCollapseWindowState] = useState<{
    sessionId: string | null;
    entries: MessageCollapseState;
  }>({
    sessionId: null,
    entries: new Map(),
  });
  const messageCollapseTargetsRef = useRef<readonly MessageCollapseTarget[]>([]);
  const [messageJumpRequest, setMessageJumpRequest] = useState<MessageJumpRequest | null>(null);
  const messageJumpRequestIdRef = useRef(0);
  const [activeContextPaneTab, setActiveContextPaneTab] = useState<ContextPaneTabKey>("latest-command");
  const [sessionGlossaryProjection, setSessionGlossaryProjection] = useState<SessionGlossaryProjection | null>(null);
  const [glossarySearchQuery, setGlossarySearchQuery] = useState("");
  const [glossarySearchEntries, setGlossarySearchEntries] = useState<GlossaryEntry[]>([]);
  const [glossarySearchTotal, setGlossarySearchTotal] = useState(0);
  const [isGlossarySearchLoading, setIsGlossarySearchLoading] = useState(false);
  const [glossarySearchError, setGlossarySearchError] = useState("");
  const [selectedGlossaryTerm, setSelectedGlossaryTerm] = useState<string | null>(null);
  const glossarySearchRequestIdRef = useRef(0);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [isAppSettingsLoaded, setIsAppSettingsLoaded] = useState(false);
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>(() => createEmptyComposerPreview());
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
  const fileRootGitHistoryDiffRequestRevisionRef = useRef(0);
  const sessionRefetchRevisionRef = useRef(new LatestRequestRevision());
  const sessionSubmitCoordinatorRef = useRef(new SessionSubmitCoordinator());
  const selectedId = useMemo(() => getSessionIdFromLocation(), []);

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

    const hydrateSelectedSession = () => {
      const requestRevision = sessionRefetchRevisionRef.current.start();
      const mutationRevision = sessionMutationRevisionRef.current.capture();
      const projectionRevision = sessionProjectionRevisionRef.current.capture();
      withmateApi.reportRendererLog({
        level: "info",
        kind: "renderer.session-refetch.started",
        message: "Session refetch started",
        data: { sessionId: selectedId },
      });
      void withmateApi.getSession(selectedId)
        .then((session) => {
          if (
            !active
            || !sessionRefetchRevisionRef.current.isCurrent(requestRevision)
            || !sessionMutationRevisionRef.current.isCurrent(mutationRevision)
          ) {
            return;
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
        })
        .catch((error) => {
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
        });
    };

    hydrateSelectedSession();

    const unsubscribe = withmateApi.subscribeSessionInvalidation((payload) => {
      if (!active || (payload.scope === "ids" && !payload.sessionIds.includes(selectedId))) {
        return;
      }

      hydrateSelectedSession();
    });

    return () => {
      active = false;
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
    handleShowContextRail,
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
    || fileRootGitHistoryDiffPreview !== null
    || fileRootGitHistoryDiffPendingPreview !== null
    || isPromptTemplateWorkspaceOpen;
  const clearHistoryDiffPreview = useCallback(() => {
    fileRootGitHistoryDiffRequestRevisionRef.current += 1;
    setFileRootGitHistoryDiffPendingPreview(null);
    setFileRootGitHistoryDiffPreview(null);
    setFileRootGitHistoryDiffLoading(false);
  }, []);
  const closeCentralPreview = useCallback(() => {
    fileRootDiffRequestRevisionRef.current += 1;
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(null);
    clearHistoryDiffPreview();
    setIsPromptTemplateWorkspaceOpen(false);
    setIsSkillPickerOpen(false);
    setPreviewChatActivity(endPreviewChatActivity());
  }, [clearHistoryDiffPreview]);
  const canClosePromptTemplate = useCallback(
    () => promptTemplateCloseGuardRef.current?.() ?? true,
    [],
  );
  const prepareCentralSurfaceOpen = useCallback((): boolean => {
    const shouldBeginPreviewActivity = !isCentralPreviewActive && activeRunSessionId !== null;
    const canOpen = applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen,
      canClosePromptTemplate,
      closeCentralSurface: () => {
        setIsPromptTemplateWorkspaceOpen(false);
        setIsSkillPickerOpen(false);
      },
    });
    if (!canOpen) {
      return false;
    }
    if (shouldBeginPreviewActivity) {
      setPreviewChatActivity(beginPreviewChatActivity(activeRunSessionId, activeRunMessageCount));
    }
    return true;
  }, [
    activeRunMessageCount,
    activeRunSessionId,
    canClosePromptTemplate,
    isCentralPreviewActive,
    isPromptTemplateWorkspaceOpen,
  ]);
  const requestCentralSurfaceClose = useCallback(
    () => applyCentralSurfaceOpenCommand({
      isPromptTemplateWorkspaceOpen,
      canClosePromptTemplate,
      closeCentralSurface: closeCentralPreview,
    }),
    [canClosePromptTemplate, closeCentralPreview, isPromptTemplateWorkspaceOpen],
  );
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
    clearHistoryDiffPreview();
  }, [activeRunSessionId, clearHistoryDiffPreview]);
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
    if (!prepareCentralSurfaceOpen()) {
      return null;
    }
    fileRootDiffRequestRevisionRef.current += 1;
    setFileRootDiffLoadingScope(null);
    setFileRootDiffPendingPreview(null);
    setFileRootDiffPreview(null);
    setSelectedFileDiffAvailabilityMessage("");
    setSelectedFilePreview(request);
    return null;
  }, [prepareCentralSurfaceOpen, withmateApi]);
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
    if (!prepareCentralSurfaceOpen()) {
      return Promise.resolve(null);
    }
    const revision = fileRootDiffRequestRevisionRef.current + 1;
    fileRootDiffRequestRevisionRef.current = revision;
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
  }, [activeRunSessionId, prepareCentralSurfaceOpen, withmateApi]);
  const handleOpenSelectedFileDiff = useCallback(async (scope: FileRootGitDiffScope): Promise<string | null> => {
    if (!withmateApi || !activeRunSessionId || !selectedFilePreview) {
      return "Git Diff is not available for this file.";
    }
    if (!prepareCentralSurfaceOpen()) {
      return null;
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
  }, [activeRunSessionId, prepareCentralSurfaceOpen, selectedFilePreview, withmateApi]);
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
  const handleShowFileRootGitHistoryDiff = useCallback((
    request: FileRootGitHistoryDiffRequest,
    _openInWindow = false,
  ): Promise<string | null> => {
    if (!withmateApi || request.sessionId !== activeRunSessionId) {
      return Promise.resolve("Git history diff is not available for this session.");
    }
    if (!prepareCentralSurfaceOpen()) {
      return Promise.resolve(null);
    }
    const revision = fileRootGitHistoryDiffRequestRevisionRef.current + 1;
    fileRootGitHistoryDiffRequestRevisionRef.current = revision;
    setFileRootGitHistoryDiffPendingPreview({ request, generation: revision });
    setFileRootGitHistoryDiffLoading(true);
    return withmateApi.getFileRootGitHistoryDiff(request).then((result) => {
      if (fileRootGitHistoryDiffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (result.status !== "ok") {
        return result.message;
      }
      setFileRootGitHistoryDiffPreview({
        request,
        generation: revision,
        patch: result.patch,
        previewResource: result.previewResource,
      });
      setFileRootGitHistoryDiffPendingPreview(null);
      return null;
    }).catch((error) => (
      fileRootGitHistoryDiffRequestRevisionRef.current === revision
        ? error instanceof Error ? error.message : "Git history diff failed."
        : null
    )).finally(() => {
      if (fileRootGitHistoryDiffRequestRevisionRef.current === revision) {
        setFileRootGitHistoryDiffPendingPreview(null);
        setFileRootGitHistoryDiffLoading(false);
      }
    });
  }, [activeRunSessionId, prepareCentralSurfaceOpen, withmateApi]);
  const handleReloadFileRootGitHistoryDiff = useCallback(async (): Promise<string | null> => {
    const preview = fileRootGitHistoryDiffPreview;
    if (!withmateApi || !preview || preview.request.sessionId !== activeRunSessionId) {
      return "Git history diff is no longer available for this session.";
    }
    const revision = fileRootGitHistoryDiffRequestRevisionRef.current + 1;
    fileRootGitHistoryDiffRequestRevisionRef.current = revision;
    setFileRootGitHistoryDiffLoading(true);
    try {
      const result = await withmateApi.getFileRootGitHistoryDiff(preview.request);
      if (fileRootGitHistoryDiffRequestRevisionRef.current !== revision) {
        return null;
      }
      if (result.status !== "ok") {
        return result.message;
      }
      setFileRootGitHistoryDiffPreview({
        request: preview.request,
        generation: revision,
        patch: result.patch,
        previewResource: result.previewResource,
      });
      return null;
    } catch (error) {
      return fileRootGitHistoryDiffRequestRevisionRef.current === revision
        ? error instanceof Error ? error.message : "Git history diff failed."
        : null;
    } finally {
      if (fileRootGitHistoryDiffRequestRevisionRef.current === revision) {
        setFileRootGitHistoryDiffLoading(false);
      }
    }
  }, [activeRunSessionId, fileRootGitHistoryDiffPreview, withmateApi]);
  const handleOpenFileRootGitHistoryPreview = useCallback(async (
    resource: SessionFileGitCommitResourceRequest,
  ): Promise<string | null> => {
    if (!withmateApi || resource.sessionId !== activeRunSessionId) {
      return "Git history file preview is not available for this session.";
    }
    try {
      const result = await withmateApi.openSessionFilePreviewWindow({ kind: "resource", resource });
      return result.status === "opened" ? null : result.message;
    } catch (error) {
      return error instanceof Error ? error.message : "The Git history file preview could not be opened.";
    }
  }, [activeRunSessionId, withmateApi]);
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
  const workspaceExecutionGate = useMemo(
    () => selectedSession
      ? resolveSessionWorkspaceExecutionGate(
          workspaceAvailability,
          selectedSession.id,
          selectedSession.workspacePath,
        )
      : { isPending: false, blockedReason: "" },
    [selectedSession, workspaceAvailability],
  );
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

    if (workspaceExecutionGate.blockedReason) {
      return workspaceExecutionGate.blockedReason;
    }

    return "";
  }, [isSelectedProviderEnabled, isSelectedSessionReadOnly, selectedSession, workspaceExecutionGate]);
  const composerBusyReason = pendingSubmitSessionId === selectedSession?.id
    ? "Message submission is in progress."
    : workspaceExecutionGate.isPending
      ? "Workspace availability is being checked."
      : "";
  const composerBlockedReason = composerBusyReason || sessionExecutionBlockedReason;

  useEffect(() => {
    if (!selectedSession || isEditingTitle) {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
  }, [isEditingTitle, selectedSession]);

  useEffect(() => {
    let active = true;
    let highestSequence = 0;
    setSessionGlossaryProjection(null);
    setGlossarySearchQuery("");
    setGlossarySearchEntries([]);
    setGlossarySearchTotal(0);
    setGlossarySearchError("");
    setSelectedGlossaryTerm(null);

    if (!withmateApi || !selectedSession) {
      return () => {
        active = false;
      };
    }

    const applyProjection = (projection: SessionGlossaryProjection) => {
      if (!active || projection.sessionId !== selectedSession.id || projection.sequence < highestSequence) {
        return;
      }
      highestSequence = projection.sequence;
      setSessionGlossaryProjection(projection);
    };
    const unsubscribe = withmateApi.subscribeSessionGlossary(applyProjection);
    void withmateApi.getSessionGlossaryProjection(selectedSession.id)
      .then(applyProjection)
      .catch((error) => {
        if (!active) {
          return;
        }
        setSessionGlossaryProjection({
          sessionId: selectedSession.id,
          scopeRevision: "renderer-load-error",
          sequence: highestSequence + 1,
          checkout: {
            repositoryName: selectedSession.workspaceLabel || "Repository",
            branch: selectedSession.branch || "unavailable",
            pathLabel: selectedSession.workspaceLabel || "Repository",
          },
          state: {
            status: "watch-error",
            relativePath: GLOSSARY_RELATIVE_PATH,
            revision: null,
            message: error instanceof Error ? error.message : "用語集を読み込めませんでした。",
          },
        });
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id, withmateApi]);

  useEffect(() => {
    let active = true;
    const requestId = ++glossarySearchRequestIdRef.current;
    const query = glossarySearchQuery.trim();
    if (
      !withmateApi
      || !selectedSession
      || sessionGlossaryProjection?.state.status !== "valid"
      || !query
    ) {
      setGlossarySearchEntries([]);
      setGlossarySearchTotal(0);
      setIsGlossarySearchLoading(false);
      setGlossarySearchError("");
      return () => {
        active = false;
      };
    }

    setIsGlossarySearchLoading(true);
    setGlossarySearchError("");
    setGlossarySearchEntries([]);
    setGlossarySearchTotal(0);
    void withmateApi.searchSessionGlossary(selectedSession.id, {
      query,
      offset: 0,
      pageSize: 100,
    }).then((result) => {
      if (!active || glossarySearchRequestIdRef.current !== requestId) {
        return;
      }
      if (!result.ok) {
        setGlossarySearchEntries([]);
        setGlossarySearchTotal(0);
        setGlossarySearchError(result.message);
      } else if (isGlossarySearchRevisionCurrent(
        result.revision,
        sessionGlossaryProjection.state.revision,
      )) {
        setGlossarySearchEntries(result.entries);
        setGlossarySearchTotal(result.total);
      }
      setIsGlossarySearchLoading(false);
    }).catch((error) => {
      if (active && glossarySearchRequestIdRef.current === requestId) {
        setGlossarySearchEntries([]);
        setGlossarySearchTotal(0);
        setGlossarySearchError(error instanceof Error ? error.message : "用語集を検索できませんでした。");
        setIsGlossarySearchLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [glossarySearchQuery, selectedSession?.id, sessionGlossaryProjection?.state.status, sessionGlossaryProjection?.state.revision, withmateApi]);

  useEffect(() => {
    if (
      selectedGlossaryTerm
      && sessionGlossaryProjection?.state.status === "valid"
      && !sessionGlossaryProjection.state.entries.some((entry) => entry.term === selectedGlossaryTerm)
    ) {
      setSelectedGlossaryTerm(null);
    }
  }, [selectedGlossaryTerm, sessionGlossaryProjection]);

  const glossaryAnnotationMatcher = useMemo(
    () => sessionGlossaryProjection?.state.status === "valid"
      ? createGlossaryAnnotationMatcher(
        sessionGlossaryProjection.state.entries,
        sessionGlossaryProjection.state.revision,
      )
      : undefined,
    [sessionGlossaryProjection],
  );
  const handleActivateGlossaryEntry = useCallback((canonicalTerm: string) => {
    if (
      sessionGlossaryProjection?.state.status !== "valid"
      || !sessionGlossaryProjection.state.entries.some((entry) => entry.term === canonicalTerm)
    ) {
      return;
    }
    setSelectedGlossaryTerm(canonicalTerm);
    setActiveContextPaneTab("glossary");
    handleShowContextRail();
  }, [handleShowContextRail, sessionGlossaryProjection]);

  const handleLoadMoreGlossarySearchResults = useCallback(() => {
    const query = glossarySearchQuery.trim();
    if (
      !withmateApi
      || !selectedSession
      || !query
      || isGlossarySearchLoading
      || glossarySearchEntries.length >= glossarySearchTotal
    ) {
      return;
    }
    setIsGlossarySearchLoading(true);
    setGlossarySearchError("");
    const requestId = ++glossarySearchRequestIdRef.current;
    void withmateApi.searchSessionGlossary(selectedSession.id, {
      query,
      offset: glossarySearchEntries.length,
      pageSize: 100,
    }).then((result) => {
      if (glossarySearchRequestIdRef.current !== requestId) {
        return;
      }
      if (!result.ok) {
        setGlossarySearchError(result.message);
      } else if (isGlossarySearchRevisionCurrent(
        result.revision,
        sessionGlossaryProjection?.state.revision,
      )) {
        setGlossarySearchEntries((current) => [...current, ...result.entries]);
        setGlossarySearchTotal(result.total);
      }
      setIsGlossarySearchLoading(false);
    }).catch((error) => {
      if (glossarySearchRequestIdRef.current !== requestId) {
        return;
      }
      setGlossarySearchError(error instanceof Error ? error.message : "用語集を検索できませんでした。");
      setIsGlossarySearchLoading(false);
    });
  }, [
    glossarySearchEntries.length,
    glossarySearchQuery,
    glossarySearchTotal,
    isGlossarySearchLoading,
    selectedSession,
    sessionGlossaryProjection?.state.revision,
    withmateApi,
  ]);

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
    () =>
      buildMessageListProjection(displayedMessages, projectedAuxiliarySessions, selectedSession?.id, {
        liveAssistant: projectedLiveAssistant,
      }),
    [displayedMessages, projectedAuxiliarySessions, projectedLiveAssistant, selectedSession?.id],
  );
  const messageListMessages = messageListProjection.messages;
  const messageListSources = messageListProjection.sources;
  const messageListKeys = messageListProjection.keys;
  const messageListGroups = messageListProjection.groups;
  const messageCollapseTargets = useMemo(
    () => buildMessageCollapseTargets(
      messageListMessages,
      messageListSources,
      messageListKeys,
      messageCollapseTargetsRef.current,
    ),
    [messageListKeys, messageListMessages, messageListSources],
  );
  useLayoutEffect(() => {
    messageCollapseTargetsRef.current = messageCollapseTargets;
  }, [messageCollapseTargets]);
  const reconciledMessageCollapseState = useMemo(
    () => messageCollapseWindowState.sessionId === selectedSessionId
      ? reconcileMessageCollapseState(messageCollapseWindowState.entries, messageCollapseTargets)
      : new Map(),
    [messageCollapseTargets, messageCollapseWindowState.entries, messageCollapseWindowState.sessionId, selectedSessionId],
  );
  const collapsedMessageKeys = useMemo(
    () => new Set(reconciledMessageCollapseState.keys()),
    [reconciledMessageCollapseState],
  );
  const messageNavigatorEntries = useMemo(
    () => buildMessageNavigatorEntries(messageCollapseTargets, reconciledMessageCollapseState),
    [messageCollapseTargets, reconciledMessageCollapseState],
  );
  useEffect(() => {
    setMessageCollapseWindowState((current) => {
      const nextEntries = current.sessionId === selectedSessionId
        ? reconcileMessageCollapseState(current.entries, messageCollapseTargets)
        : new Map();
      if (current.sessionId === selectedSessionId
        && current.entries.size === nextEntries.size
        && Array.from(nextEntries).every(([key, entry]) => current.entries.get(key) === entry)) {
        return current;
      }
      return { sessionId: selectedSessionId, entries: nextEntries };
    });
  }, [messageCollapseTargets, selectedSessionId]);
  useEffect(() => {
    setMessageJumpRequest(null);
  }, [selectedSessionId]);
  const handleToggleMessageCollapse = useCallback((key: string) => {
    setMessageCollapseWindowState((current) => {
      const state = current.sessionId === selectedSessionId
        ? reconcileMessageCollapseState(current.entries, messageCollapseTargets)
        : new Map();
      const target = messageCollapseTargets.find((candidate) => candidate.key === key);
      return target
        ? { sessionId: selectedSessionId, entries: toggleMessageCollapseState(state, target) }
        : { sessionId: selectedSessionId, entries: state };
    });
  }, [messageCollapseTargets, selectedSessionId]);
  const handleToggleAllMessageCollapse = useCallback(() => {
    setMessageCollapseWindowState((current) => {
      const state = current.sessionId === selectedSessionId
        ? reconcileMessageCollapseState(current.entries, messageCollapseTargets)
        : new Map();
      return {
        sessionId: selectedSessionId,
        entries: toggleAllMessageCollapseState(state, messageCollapseTargets),
      };
    });
  }, [messageCollapseTargets, selectedSessionId]);
  const handleJumpToMessage = useCallback((key: string) => {
    if (!selectedSessionId) {
      return;
    }
    messageJumpRequestIdRef.current += 1;
    setMessageJumpRequest({
      sessionId: selectedSessionId,
      key,
      requestId: messageJumpRequestIdRef.current,
    });
  }, [selectedSessionId]);
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
  const includeGlossaryContextPane = shouldIncludeGlossaryContextPane(sessionGlossaryProjection);
  const availableContextPaneTabs = useMemo(
    () => resolveAvailableContextPaneTabs({
      isCopilotSession,
      includeMessages: true,
      includeGlossary: includeGlossaryContextPane,
      hasCompanionGroupMonitor: selectedCompanionGroupMonitorEntries.length > 0,
      hasReasoningCapability,
      hasReasoningText: hasLiveRunReasoningText,
    }),
    [
      hasLiveRunReasoningText,
      hasReasoningCapability,
      isCopilotSession,
      selectedCompanionGroupMonitorEntries.length,
      includeGlossaryContextPane,
    ],
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
  const isComposerDisabled = selectedSessionRunState === "running" || !!composerBlockedReason || isSelectedSessionReadOnly;
  const composerSendability = useMemo(
    () =>
      resolveComposerSendabilityState({
        runState: selectedSessionRunState,
        busyReason: composerBusyReason,
        blockedReason: sessionExecutionBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: draft,
        forceBlockedFeedback: forceComposerBlockedFeedback,
      }),
    [
      composerBusyReason,
      composerPreview.errors,
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
    speedSelectOptions,
    reviewerSelectOptions,
  } = useMemo(
    () => buildRuntimeSelectionOptions({
      providerId: displayedSession?.provider,
      providerCatalog: selectedProviderCatalog,
      models: modelOptions,
      selectedModel: displayedSession?.model ?? "",
      reasoningEfforts: availableReasoningEfforts,
      selectedApprovalMode: displayedSession?.approvalMode ?? "untrusted",
      selectedCodexSandboxMode: displayedSession?.codexSandboxMode ?? "workspace-write",
      selectedCodexSpeed: displayedSession?.codexSpeed ?? "standard",
      selectedCodexReviewer: displayedSession?.codexReviewer ?? "user",
    }),
    [
      displayedSession?.provider,
      displayedSession?.approvalMode,
      displayedSession?.codexSandboxMode,
      displayedSession?.codexSpeed,
      displayedSession?.codexReviewer,
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
    if (!selectedSession || selectedSessionRunState === "running") {
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

    const clientRequestId = createSessionTurnClientRequestId();
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
        blockedReason: sessionExecutionBlockedReason,
        inputErrors: displayPreview.errors,
        draftText: messageText,
      });
      if (blockedMessage) {
        setForceComposerBlockedFeedback(true);
        return;
      }

      handleMessageListSend(appSettings.scrollToLatestOnSend);
      if (options?.collapseActionDock) {
        setIsActionDockPinnedExpanded(false);
      }
      const shouldClearDraft = options?.clearDraft ?? true;
      if (shouldClearDraft) {
        setDraft((current) => current === messageText ? "" : current);
      }
      const updatedSession = applyOptimisticSessionRunUpdate({
        session: selectedSession,
        userMessage: nextMessage,
        updatedAt: currentTimestampLabel(),
        status: "running",
        updateLiveRunState: (update) => setLiveRunState(update),
        applyRunningSession: (runningSession) => setAuthoritativeSessions([runningSession]),
      });
      const optimisticSessionMutationRevision = sessionMutationRevisionRef.current.capture();
      const optimisticSessionProjectionRevision = sessionProjectionRevisionRef.current.capture();
      const optimisticLiveRunRevision = liveRunRevisionRef.current;
      if (isCentralPreviewActive) {
        setPreviewChatActivity((current) => acknowledgePreviewChatMessageCount(
          current,
          updatedSession.id,
          updatedSession.messages.length,
        ));
      }
      logSessionRunStuckInvestigation("renderer.optimistic-running-applied", {
        sessionId: updatedSession.id,
        clientRequestId,
        elapsedMs: Date.now() - investigationStartedAt,
        messageCount: updatedSession.messages.length,
        runState: updatedSession.runState,
        status: updatedSession.status,
      });

      const request: RunSessionTurnRequest = {
        userMessage: messageText,
        clientRequestId,
        submitSource: options?.submitSource ?? "composer",
        codexReviewer: updatedSession.codexReviewer,
      };
      try {
        const savedSession = await withmateApi.runSessionTurn(sessionId, request);
        logSessionRunStuckInvestigation("renderer.run-session-turn.resolved", {
          sessionId: savedSession.id,
          clientRequestId,
          elapsedMs: Date.now() - investigationStartedAt,
          messageCount: savedSession.messages.length,
          runState: savedSession.runState,
          status: savedSession.status,
          hasLiveRun: !!selectedSessionLiveRun,
        });
        const preserveCurrentPin = !sessionProjectionRevisionRef.current.isCurrent(
          optimisticSessionProjectionRevision,
        );
        setAuthoritativeSessions((current) => [convergeResolvedSessionProjection(
          current.find((session) => session.id === savedSession.id) ?? null,
          savedSession,
          preserveCurrentPin,
        )]);
      } catch (error) {
        logSessionRunStuckInvestigation("renderer.run-session-turn.failed", {
          sessionId: updatedSession.id,
          clientRequestId,
          elapsedMs: Date.now() - investigationStartedAt,
          messageCount: updatedSession.messages.length,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.error(error);
        if (shouldClearDraft) {
          setDraft((current) => mergeRejectedSessionDraft(messageText, current));
        }

        const [refreshedSessionResult, refreshedLiveRunResult] = await Promise.allSettled([
          withmateApi.getSession(sessionId),
          withmateApi.getLiveSessionRun(sessionId),
          validateSessionWorkspace(selectedSession),
        ]);
        const canReplaceOptimisticBody = sessionMutationRevisionRef.current.isCurrent(
          optimisticSessionMutationRevision,
        );
        const preserveCurrentPin = !sessionProjectionRevisionRef.current.isCurrent(
          optimisticSessionProjectionRevision,
        );
        if (refreshedSessionResult.status === "fulfilled" && canReplaceOptimisticBody) {
          setAuthoritativeSessions((current) => {
            const currentSession = current.find((session) => session.id === sessionId) ?? null;
            const converged = convergeRejectedSessionSnapshot(
              currentSession,
              updatedSession,
              refreshedSessionResult.value,
              true,
              preserveCurrentPin,
            );
            return converged ? [converged] : [];
          });
        } else if (
          canReplaceOptimisticBody
          && (
            refreshedLiveRunResult.status === "rejected"
            || refreshedLiveRunResult.value === null
          )
        ) {
          setAuthoritativeSessions((current) => {
            const currentSession = current.find((session) => session.id === sessionId) ?? null;
            const recovered = recoverRejectedSessionSnapshot(currentSession, updatedSession, true);
            return recovered ? [recovered] : current;
          });
        }
        if (liveRunRevisionRef.current === optimisticLiveRunRevision) {
          setLiveRunState((current) => convergeRejectedLiveRunState(
            current,
            sessionId,
            refreshedLiveRunResult.status === "fulfilled" ? refreshedLiveRunResult.value : null,
            optimisticLiveRunRevision,
            optimisticLiveRunRevision,
          ));
        }
        throw error;
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

  const handleComposerSubmitShortcut = () => applyComposerSubmitCommand({
    isSubmitDisabled: () => (
      activeAuxiliarySession
        ? activeAuxiliarySession.runState === "running"
        : composerSendability.isRunning
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

  useShortcutDispatcherSettings(appSettings.keyboardShortcuts);
  useShortcutScope("composer");
  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.composerSubmit, handleComposerSubmitShortcut);

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

  const handleChangeCodexSpeed = async (codexSpeed: Session["codexSpeed"]) => {
    if (
      !selectedSession ||
      selectedSession.provider !== "codex" ||
      isSelectedSessionReadOnly ||
      selectedSessionRunState === "running"
    ) {
      return;
    }

    const nextSession = buildSessionWithCodexSpeed(selectedSession, codexSpeed, currentTimestampLabel());
    if (nextSession) {
      await persistSession(nextSession);
    }
  };

  const handleChangeCodexReviewer = async (codexReviewer: Session["codexReviewer"]) => {
    if (
      !selectedSession ||
      selectedSession.provider !== "codex" ||
      selectedSession.approvalMode === "never" ||
      isSelectedSessionReadOnly ||
      selectedSessionRunState === "running"
    ) {
      return;
    }

    const nextSession = buildSessionWithCodexReviewer(selectedSession, codexReviewer, currentTimestampLabel());
    if (nextSession) {
      await persistSession(nextSession);
    }
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

  const handleChangeAuxiliaryCodexSpeed = async (codexSpeed: Session["codexSpeed"]) => {
    await runAuxiliaryCodexSpeedChangeOperation({
      codexSpeed,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleChangeAuxiliaryCodexReviewer = async (codexReviewer: Session["codexReviewer"]) => {
    if (activeAuxiliarySession?.approvalMode === "never") {
      return;
    }
    await runAuxiliaryCodexReviewerChangeOperation({
      codexReviewer,
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

  const toggleSkillPicker = createSkillPickerToggleHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
    setSkillPickerOpen: setIsSkillPickerOpen,
  });

  const handleToggleSkillPicker = () => {
    if (!isSkillPickerOpen && !requestCentralSurfaceClose()) {
      return;
    }
    toggleSkillPicker();
  };

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
      fallbackCaret: targetAuxiliarySession ? composerCaret : mainComposerCaretRef.current,
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
    clearHistoryDiffPreview();
    if (isPromptTemplateWorkspaceOpen) {
      requestCentralSurfaceClose();
      return;
    }
    if (!prepareCentralSurfaceOpen()) {
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
    setIsPromptTemplateWorkspaceOpen(true);
  };
  const handleInsertPromptTemplate = (prompt: string) => {
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
  const sessionHeaderActions = (
    <>
      {messageCollapseTargets.length > 0 ? (
        createMessageCollapseHeaderAction({
          allMessagesCollapsed: messageCollapseTargets.every((target) => collapsedMessageKeys.has(target.key)),
          onToggle: handleToggleAllMessageCollapse,
          keyboardShortcuts: appSettings.keyboardShortcuts,
        })
      ) : null}
      {auxiliaryHeaderActions}
    </>
  );

  if (!desktopRuntime) {
    return <ChatWindowStatusScreen message="Session Window は Electron から開いてね。" />;
  }

  if (!selectedSession || !renderedSession || !selectedSessionCharacter) {
    return <ChatWindowStatusScreen message="Session が選択されていません。Home Window から session を開いてね。" />;
  }

  const fileExplorerRootsRevision = buildSessionFileExplorerRootsRevision({
    sessionId: activeRunSessionId,
    workspacePath: selectedSession.workspacePath,
    additionalDirectories:
      activeAuxiliarySession?.allowedAdditionalDirectories ?? selectedSession.allowedAdditionalDirectories,
  });
  const canInsertFileTreePathReference = activeAuxiliarySession
    ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason && !isAuxiliaryActionPending
    : !isComposerDisabled;
  const fileExplorerPane = (
    <SessionFileExplorerPane
      api={withmateApi}
      sessionId={activeRunSessionId}
      enabled={isSelectedWorkspaceAvailable}
      rootsRevision={fileExplorerRootsRevision}
      selectedFile={selectedFilePreview}
      activeTab={fileExplorerTab}
      onActiveTabChange={(tab) => {
        if (tab !== "history") {
          clearHistoryDiffPreview();
        }
        setFileExplorerTab(tab);
      }}
      onRefreshChanges={() => setFileRootChangesRefreshRevision((current) => current + 1)}
      onRefreshHistory={() => setFileRootGitHistoryRefreshRevision((current) => current + 1)}
      onOpenFile={(request, openInWindow) => {
        void handleOpenFileRootFile(request, openInWindow).then((message) => {
          if (message) {
            window.alert(message);
          }
        });
      }}
      canInsertPathReference={canInsertFileTreePathReference}
      onInsertPathReference={(ownerSessionId, absolutePath) => {
        if (ownerSessionId !== activeRunSessionId || !canInsertFileTreePathReference) {
          return;
        }
        insertReferencePaths([absolutePath]);
      }}
      renderChangesContent={(roots) => (
        <FileRootChangesPane
          api={withmateApi}
          sessionId={activeRunSessionId}
          enabled={isSelectedWorkspaceAvailable}
          roots={roots}
          rootsRevision={fileExplorerRootsRevision}
          refreshRevision={fileRootChangesRefreshRevision}
          onOpenFile={handleOpenFileRootFile}
          onOpenDiff={handleShowFileRootDiff}
        />
      )}
      historyContent={(
        <FileRootGitHistoryPane
          api={withmateApi}
          sessionId={activeRunSessionId}
          enabled={isSelectedWorkspaceAvailable}
          rootsRevision={fileExplorerRootsRevision}
          refreshRevision={fileRootGitHistoryRefreshRevision}
          onOpenDiff={handleShowFileRootGitHistoryDiff}
          onRepositoryChange={clearHistoryDiffPreview}
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
  const actionDockChatNotice = liveApprovalRequest
    ? "Approval required"
    : liveElicitationRequest
      ? "Input required"
      : previewChatActivity.hasUnreadMessages && previewChatActivity.ownerSessionId === activeRunSessionId
        ? "New messages"
        : "";
  const filePreviewContent = isPromptTemplateWorkspaceOpen && withmateApi ? (
    <PromptTemplateWorkspace
      api={withmateApi}
      canInsert={activeAuxiliarySession
        ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason && !isAuxiliaryActionPending
        : !isComposerDisabled}
      onRegisterCloseGuard={registerPromptTemplateCloseGuard}
      onBack={closeCentralPreview}
      onInsert={handleInsertPromptTemplate}
    />
  ) : fileRootGitHistoryDiffPendingPreview ? (
    <SessionDiffPreview
      title={fileRootGitHistoryDiffPendingPreview.request.relativePath
        ?? `Commit ${fileRootGitHistoryDiffPendingPreview.request.commitId.slice(0, 7)}`}
      previewRevision={fileRootGitHistoryDiffPendingPreview.generation}
      patch=""
      loading
      backNavigation={{ label: "Back to Chat", onBack: closeCentralPreview }}
      onCopyText={handleCopyMessageText}
      onQuoteText={handleQuoteMessageText}
      onReload={() => handleShowFileRootGitHistoryDiff(fileRootGitHistoryDiffPendingPreview.request)}
      reloadPending
      chatNotice={previewChatNotice}
    />
  ) : fileRootGitHistoryDiffPreview ? (
    <SessionDiffPreview
      title={fileRootGitHistoryDiffPreview.request.relativePath
        ?? `Commit ${fileRootGitHistoryDiffPreview.request.commitId.slice(0, 7)}`}
      previewRevision={fileRootGitHistoryDiffPreview.generation}
      patch={fileRootGitHistoryDiffPreview.patch}
      backNavigation={{ label: "Back to Chat", onBack: closeCentralPreview }}
      onCopyText={handleCopyMessageText}
      onQuoteText={handleQuoteMessageText}
      onOpenPreview={fileRootGitHistoryDiffPreview.previewResource
        ? () => handleOpenFileRootGitHistoryPreview(fileRootGitHistoryDiffPreview.previewResource!)
        : undefined}
      onReload={handleReloadFileRootGitHistoryDiff}
      reloadPending={fileRootGitHistoryDiffLoading}
      chatNotice={previewChatNotice}
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

  return (
    <ShortcutSettingsProvider settings={appSettings.keyboardShortcuts}>
      <>
      <ChatWindow
      {...buildAgentSessionChatWindowProps({
        mainContent: filePreviewContent,
        leftPane: fileExplorerPane,
        isFilesPaneVisible,
        selectedSession: renderedSession,
        selectedSessionCharacter,
        displayedMessages: renderedMessages,
        displayedMessageKeys: messageListKeys,
        displayedMessageGroups: messageListGroups,
        messageCollapseTargets,
        collapsedMessageKeys,
        messageJumpRequest,
        messageNavigatorEntries,
        messageNavigatorCharacter: selectedSessionCharacter,
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
        isSendDisabled: renderedIsSendDisabled,
        composerSendability: renderedComposerSendability,
        composerSendButtonTitle: renderedComposerButtonTitle,
        isComposerBlockedFeedbackActive:
          forceComposerBlockedFeedback && renderedComposerSendability.feedbackTone === "blocked",
        approvalChoiceOptions,
        sandboxChoiceOptions,
        speedChoiceOptions: speedSelectOptions,
        reviewerChoiceOptions: reviewerSelectOptions,
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
        glossaryPaneProps: includeGlossaryContextPane ? {
          projection: sessionGlossaryProjection,
          searchQuery: glossarySearchQuery,
          searchEntries: glossarySearchEntries,
          searchTotal: glossarySearchTotal,
          searchLoading: isGlossarySearchLoading,
          searchError: glossarySearchError,
          selectedTerm: selectedGlossaryTerm,
          onSearchQueryChange: setGlossarySearchQuery,
          onLoadMoreSearchResults: handleLoadMoreGlossarySearchResults,
          onSelectTerm: setSelectedGlossaryTerm,
          onBackToList: () => setSelectedGlossaryTerm(null),
        } : undefined,
        glossaryAnnotationMatcher,
        onActivateGlossaryEntry: handleActivateGlossaryEntry,
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
        headerActions: sessionHeaderActions,
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
        onToggleMessageCollapse: handleToggleMessageCollapse,
        onToggleAllMessageCollapse: handleToggleAllMessageCollapse,
        onJumpToMessage: handleJumpToMessage,
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
        },
        onDraftFocus: () => handleExpandActionDock({ focusComposer: false }),
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
        onSendOrCancel: buildAuxiliaryAwareSendOrCancelHandler({
          shouldSendAuxiliary: !!activeAuxiliarySession,
          isAuxiliarySessionRunning: activeAuxiliarySession?.runState === "running",
          isSelectedSessionRunning,
          preferAuxiliarySendOverSelectedCancel: true,
          onCancelAuxiliaryRun: handleCancelAuxiliaryRun,
          onSendAuxiliary: handleSend,
          onCancelSelectedSessionRun: handleCancelRun,
          onSendSelectedSession: handleSend,
        }),
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
        onChangeCodexSpeed: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["codexSpeed"]>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliaryCodexSpeed,
          onSelectedSessionChange: handleChangeCodexSpeed,
        }),
        onChangeCodexReviewer: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["codexReviewer"]>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliaryCodexReviewer,
          onSelectedSessionChange: handleChangeCodexReviewer,
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
    </ShortcutSettingsProvider>
  );
}
