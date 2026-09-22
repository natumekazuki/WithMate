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

import { currentTimestampLabel } from "../../src-shared/time-state.js";
import type { DiscoveredCustomAgent, DiscoveredSkill, LiveSessionRunState, RunSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import { getAuxiliarySessionIdFromLocation, getSessionIdFromLocation } from "./session-location.js";
import {
  buildSessionWithAddedAdditionalDirectory,
  buildSessionWithRemovedAdditionalDirectory,
  resolveAdditionalDirectoryPickerBase,
  runAdditionalDirectoryRemovalOperation,
  runPickedAdditionalDirectoryOperation,
} from "../../src-shared/settings/additional-directory-state.js";
import { DEFAULT_CHARACTER_SESSION_COPY, type CharacterProfile } from "../../src-shared/character/character-state.js";
import { startAppSettingsSubscription } from "../settings/app-settings-subscription.js";
import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import { resolveMicrocopy, type MicrocopySlot } from "../../src-shared/settings/microcopy-state.js";
import {
  type DiffPreviewPayload,
  type Message,
  isReadOnlySession,
  setMessageBookmarked,
  type Session,
} from "../../src-shared/session/session-state.js";
import type { MessageCollapseTarget } from "../chat/conversation/session-message-collapse.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  type ModelCatalogSnapshot,
} from "../../src-shared/settings/model-catalog.js";
import { startModelCatalogSubscription } from "../settings/model-catalog-subscription.js";
import { buildCharacterThemeStyle } from "../ui/theme-utils.js";
import {
  buildAuxiliaryAwareSendOrCancelHandler,
  buildAuxiliarySessionCancelTarget,
  buildRunningSessionCancelTarget,
  resolveSelectedSessionIsRunning,
  resolveSelectedSessionRunState,
  runRunningSessionCancelOperation,
} from "../chat/send-or-cancel.js";
import { buildAuxiliaryAwareRuntimeOptionChangeHandler } from "../chat/auxiliary-runtime-option-routing.js";
import {
  approvalModeLabel,
  CharacterAvatar,
} from "../ui/ui-utils.js";
import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "../chat/composer/composer-textarea-focus.js";
import { buildRuntimeSelectionOptions } from "../settings/runtime-selection-options.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandProjection,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  type ContextPaneTabKey,
  resolveAvailableContextPaneTabs,
  shouldIncludeGlossaryContextPane,
} from "../chat/runtime/session-ui-projection.js";
import { buildMainAuxiliaryRuntimeSession } from "../chat/auxiliary/auxiliary-runtime-projection.js";
import {
  useMainAuxiliaryRuntimeSession,
} from "../chat/auxiliary/auxiliary-render-projections.js";
import { ChatWindow, ChatWindowStatusScreen } from "../chat/chat-window.js";
import { useResourceDiscovery } from "../chat/use-resource-discovery.js";
import { applySessionDocumentTitle, resolveAgentSessionDocumentTitle } from "../chat/window-title.js";
import { resolveAuditLogOwner } from "../chat/audit-log-owner.js";
import {
  buildAuxiliaryLaunchProviderItems,
  createAuxiliaryLaunchDialogCloseHandler,
  createAuxiliaryLaunchDialogOpenHandler,
  createAuxiliaryLaunchProviderSelectHandler,
  canCancelAuxiliaryLaunchCreation,
  resolveAuxiliaryLaunchCreationFeedback,
  resolveAuxiliaryLaunchStartProvider,
} from "../chat/auxiliary-launch-state.js";
import { AuxiliaryLaunchProviderDialog } from "../chat/AuxiliaryLaunchProviderDialog.js";
import { useAuxiliaryCreation } from "../chat/use-auxiliary-creation.js";
import { useAuxiliaryLaunchDialogState } from "../chat/use-auxiliary-launch-dialog-state.js";
import { useAuxiliaryWorkspace } from "../chat/use-auxiliary-workspace.js";
import {
  ComposerControllerRegistry,
  type ComposerOwner,
  type ComposerSaveState,
  type ComposerSelection,
} from "../chat/composer-controller.js";
import { useAuxiliaryDraftPersistence } from "../chat/auxiliary/use-auxiliary-draft-persistence.js";
import { useSessionDraftFlushLifecycle } from "../chat/runtime/use-session-draft-flush-lifecycle.js";
import {
  runMainRuntimeOptionOperation,
  type MainRuntimeOption,
} from "../chat/runtime/main-session-mutation-operations.js";
import { useMainSessionRuntime } from "../chat/runtime/use-main-session-runtime.js";
import { useSessionHeaderOperations } from "../chat/shell/use-session-header-operations.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
  type ComposerSendabilityState,
} from "../chat/composer/session-composer-feedback.js";
import {
  buildActionDockRuntimeState,
  shouldFocusComposerForActionDockExpand,
} from "../chat/approval/action-dock-state.js";
import {
  buildCustomAgentMatchDisplay,
  buildSelectedCustomAgentDisplay,
  buildSkillMatchDisplay,
} from "../chat/composer/session-composer-selection.js";
import {
  runAuxiliaryCustomAgentPatchOperation,
  runAuxiliaryCustomAgentSelectionOperation,
} from "../chat/auxiliary/auxiliary-custom-agent-operation.js";
import { runAuxiliarySkillPromptInsertionOperation } from "../chat/auxiliary/auxiliary-skill-prompt-operation.js";
import {
  buildAdditionalDirectoryItems,
  buildComposerAttachmentItems,
  pickComposerReferencePath,
  type ComposerPathPickerKind,
  type ComposerReferenceInput,
} from "../chat/composer/session-composer-paths.js";
import {
  applyComposerDraftClearCommand,
  applyComposerDraftChangeCommand,
  buildOnDraftCompositionHandlers,
} from "../chat/composer-draft-handlers.js";
import {
  createEmptyComposerPreview,
} from "../chat/composer/composer-preview-config.js";
import {
  useChatLayoutPresentation,
  useSessionSidePanes,
  useSessionVerticalDockResize,
} from "../chat/shell/session-chat-layout-hooks.js";
import { persistChatLayoutPreference } from "../chat/chat-layout-preference.js";
import type { SessionSidePane } from "../../src-shared/settings/session-side-pane.js";
import { SessionFileExplorerPane } from "../file-explorer/SessionFileExplorerPane.js";
import { SessionDiffPreview, SessionFilePreview } from "../file-explorer/SessionFilePreview.js";
import { PromptTemplateWorkspace } from "../prompt-templates/PromptTemplateWorkspace.js";
import { insertComposerTextAtSelection } from "../chat/message-text-actions.js";
import { FileRootChangesPane } from "../file-explorer/FileRootChangesPane.js";
import { FileRootGitHistoryPane } from "../file-explorer/FileRootGitHistoryPane.js";
import type {
  FileRootGitHistoryComparison,
  FileRootGitHistoryDiffRequest,
  SessionFileGitCommitResourceRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { useSessionGlossary } from "../glossary/use-session-glossary.js";
import {
  buildSessionFileExplorerRootsRevision,
  isFileRootGitHistoryComparisonDiffRequest,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { useFileRootPreviewController } from "../file-explorer/use-file-root-preview-controller.js";
import {
  acknowledgePreviewChatMessageCount,
  beginPreviewChatActivity,
  endPreviewChatActivity,
  observePreviewChatMessageCount,
} from "../file-explorer/preview-chat-activity.js";
import {
  createOwnedPendingLiveSessionRunState,
  resolveSessionRunErrorMessage,
} from "../chat/runtime/session-live-run-state.js";
import {
  StateMutationRevision,
  createSessionTurnClientRequestId,
} from "../chat/runtime/session-submit-coordinator.js";
import { buildAgentSessionChatWindowProps } from "../chat/session-chat-projection.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { ShortcutSettingsProvider } from "../settings/shortcut-settings-context.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "../file-explorer/open-path-result.js";
import {
  isSessionWorkspaceAvailable,
  resolveSessionWorkspaceExecutionGate,
  resolveSessionWorkspaceUnavailableMessage,
} from "../chat/runtime/session-workspace-availability.js";
import { useSessionWorkspaceAvailability } from "../chat/runtime/session-window-workspace-hooks.js";
import { useActiveSessionLiveRun } from "../chat/runtime/session-window-live-run-hooks.js";
import { useSessionRunActions } from "../chat/runtime/session-run-actions.js";
import { useSessionAuditLogs } from "../chat/runtime/session-audit-log-state.js";
import {
  type AuxiliarySession,
} from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  runAuxiliaryApprovalModeChangeOperation,
  runAuxiliaryCodexSpeedChangeOperation,
  runAuxiliaryCodexReviewerChangeOperation,
  runAuxiliaryModelChangeOperation,
  runAuxiliaryReasoningEffortChangeOperation,
  runAuxiliarySandboxModeChangeOperation,
} from "../chat/auxiliary/auxiliary-runtime-option-operation.js";
import { createPastedSessionAttachmentHandler } from "../chat/composer-paste-handlers.js";
import { useSessionTelemetry } from "../chat/runtime/session-window-telemetry-hooks.js";
import {
  createCopyMessageTextHandler,
} from "../chat/message-text-actions.js";
import { isTerminalAuditLogPhase } from "../chat/runtime/audit-log-phase.js";
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
} from "../chat/retry-state.js";
import { resolvePendingAuxiliaryMessageGroupId } from "../chat/auxiliary/auxiliary-session-message-projection.js";
import {
  createGuardedActiveAuxiliarySessionUpdater,
  enqueueAuxiliarySessionSaveWithQueue,
} from "../chat/auxiliary/auxiliary-session-update-operation.js";
import {
  runAddAuxiliaryAdditionalDirectoryOperationWithApi,
  runRemoveAuxiliaryAdditionalDirectoryOperation,
} from "../chat/auxiliary/auxiliary-additional-directory-operation.js";
import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  handleAuxiliarySessionSendOperationResult,
  runAuxiliarySessionSendOperationWithApi,
} from "../chat/auxiliary/auxiliary-session-send-operation.js";
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
  createContextPaneTabCycleHandler,
  createExpandedArtifactToggleHandler,
  createHeaderExpandedToggleHandler,
  createPathReferenceRemovalHandler,
  createQuoteMessageTextHandler,
  createSessionFilesOpenHandler,
  createSkillPickerToggleHandler,
  createSkillPromptInsertionHandler,
  createTitleInputKeyHandler,
} from "../chat/session-shell-handlers.js";
import {
  SHORTCUT_COMMAND_IDS,
  useShortcutCommandHandler,
  useShortcutDispatcherSettings,
  useShortcutScope,
} from "../settings/shortcut-registry.js";

function formatGitHistoryComparisonSelector(
  selector: FileRootGitHistoryComparison["base"],
): string {
  if (selector.kind === "head") {
    return "HEAD";
  }
  if (selector.kind === "commit") {
    return `Commit ${selector.objectId.slice(0, 7)}`;
  }
  return selector.name;
}

function formatGitHistoryDiffTitle(request: FileRootGitHistoryDiffRequest): string {
  if (isFileRootGitHistoryComparisonDiffRequest(request)) {
    return request.relativePath
      ?? `${formatGitHistoryComparisonSelector(request.comparison.base)} → ${formatGitHistoryComparisonSelector(request.comparison.target)}`;
  }
  return request.relativePath ?? `Commit ${request.commitId.slice(0, 7)}`;
}

function formatGitHistoryDiffContext(request: FileRootGitHistoryDiffRequest): string | undefined {
  if (!isFileRootGitHistoryComparisonDiffRequest(request)) {
    return undefined;
  }
  const mergeBase = request.comparison.mergeBaseCommitId
    ? ` · merge-base ${request.comparison.mergeBaseCommitId.slice(0, 7)}`
    : "";
  return `${request.comparison.mode === "branch" ? "Branch changes" : "Direct comparison"} · ${request.comparison.baseCommitId.slice(0, 7)} → ${request.comparison.targetCommitId.slice(0, 7)}${mergeBase}`;
}

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
  const composerRegistryRef = useRef<ComposerControllerRegistry | null>(null);
  if (!composerRegistryRef.current) {
    composerRegistryRef.current = new ComposerControllerRegistry();
  }
  const composerRegistry = composerRegistryRef.current;
  const selectedId = useMemo(() => getSessionIdFromLocation(), []);
  const mainSessionRuntime = useMainSessionRuntime({ api: withmateApi, selectedId, composerRegistry });
  const {
    sessions,
    pendingSubmitSessionId,
    forceComposerBlockedFeedback,
    setForceComposerBlockedFeedback,
    persistSession: persistMainSessionState,
    toggleSessionPin,
    isSessionPinPending,
    runMainSessionTurn: runMainSessionTurnFromRuntime,
  } = mainSessionRuntime;
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [isPromptTemplateWorkspaceOpen, setIsPromptTemplateWorkspaceOpen] = useState(false);
  const promptTemplateCloseGuardRef = useRef<(() => boolean) | null>(null);
  const registerPromptTemplateCloseGuard = useCallback((guard: (() => boolean) | null) => {
    promptTemplateCloseGuardRef.current = guard;
  }, []);
  const [fileExplorerTab, setFileExplorerTab] = useState<"files" | "changes" | "history">("files");
  const [fileRootChangesRefreshRevision, setFileRootChangesRefreshRevision] = useState(0);
  const [fileRootGitHistoryRefreshRevision, setFileRootGitHistoryRefreshRevision] = useState(0);
  const [previewChatActivity, setPreviewChatActivity] = useState(() => endPreviewChatActivity());
  const [inlinePathError, setInlinePathError] = useState<{
    ownerSessionId: string;
    target: string;
    message: string;
  } | null>(null);
  const inlinePathOperationRevisionRef = useRef(new StateMutationRevision());
  const [activeContextPaneTab, setActiveContextPaneTab] = useState<ContextPaneTabKey>("latest-command");
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [isAppSettingsLoaded, setIsAppSettingsLoaded] = useState(false);
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const composerOwnerRef = useRef<string | null>(null);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
  const [isActivityMonitorFollowing, setIsActivityMonitorFollowing] = useState(true);
  const [hasActivityMonitorUnread, setHasActivityMonitorUnread] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
  const handleHeaderPreferenceChange = useCallback((value: "hidden" | "visible") => {
    void persistChatLayoutPreference(withmateApi, { target: "header", value });
  }, [withmateApi]);
  const handleActionDockPreferenceChange = useCallback((value: "compact" | "expanded") => {
    void persistChatLayoutPreference(withmateApi, { target: "actionDock", value });
  }, [withmateApi]);
  const {
    isHeaderExpanded,
    setIsHeaderExpanded,
    isActionDockPinnedExpanded,
    setIsActionDockPinnedExpanded,
  } = useChatLayoutPresentation({
    initialHeader: isAppSettingsLoaded ? appSettings.chatLayoutPreference.header : null,
    initialActionDock: isAppSettingsLoaded ? appSettings.chatLayoutPreference.actionDock : null,
    onHeaderChange: handleHeaderPreferenceChange,
    onActionDockChange: handleActionDockPreferenceChange,
  });
  const initialAuxiliarySessionId = useMemo(() => getAuxiliarySessionIdFromLocation(), []);
  const auxiliaryWorkspace = useAuxiliaryWorkspace({
    parentSessionId: selectedId,
    api: withmateApi,
    initialSelectedId: initialAuxiliarySessionId,
  });
  useEffect(() => {
    if (!withmateApi || !selectedId) {
      return;
    }
    return withmateApi.subscribeAuxiliarySessionNavigation((payload) => {
      if (payload.parentSessionId !== selectedId) {
        return;
      }
      auxiliaryWorkspace.selectSession(payload.auxiliarySessionId);
    });
  }, [auxiliaryWorkspace.selectSession, selectedId, withmateApi]);
  const activeAuxiliarySession = auxiliaryWorkspace.target === "auxiliary" ? auxiliaryWorkspace.selectedSession : null;
  const auxiliaryBinding = auxiliaryWorkspace.getBinding(auxiliaryWorkspace.selectedId);
  const setActiveAuxiliarySession = auxiliaryBinding.setSession;
  const auxiliaryDraftPersistence = useAuxiliaryDraftPersistence({
    api: withmateApi,
    composerRegistry,
    touchRecency: auxiliaryWorkspace.touchRecency,
    isFrozen: () => composerRegistry.isFrozen,
  });
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
  const auxiliaryCreation = useAuxiliaryCreation({
    parentSessionId: selectedId,
    api: withmateApi,
    onCommitted: (session) => {
      auxiliaryWorkspace.addSession(session);
      setIsActionDockPinnedExpanded(true);
      setForceComposerBlockedFeedback(false);
      closeAuxiliaryLaunchDialog();
    },
    onFeedback: (message) => {
      if (message) setAuxiliaryLaunchStartError(new Error(message));
      else resetAuxiliaryLaunchFeedback();
    },
    onDiagnostic: (request, stage) => {
      withmateApi?.reportRendererLog({
        level: stage === "stale-drop" ? "warn" : "info",
        kind: "renderer.auxiliary-launch",
        message: "Auxiliary creation projection",
        correlationId: request.clientRequestId,
        data: { stage },
      });
    },
  });
  const { starting: auxiliaryCreationStarting, cancelling: auxiliaryCreationCancelling, status: auxiliaryCreationStatus } = auxiliaryCreation;
  const activityMonitorRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activityMonitorSignatureRef = useRef("");
  const activityMonitorSessionIdRef = useRef<string | null>(null);
  const activeAuxiliarySessionRef = auxiliaryBinding.sessionRef;
  const auxiliarySessionMutationRevisionRef = auxiliaryBinding.mutationRevision;
  const auxiliaryDraftSaveQueueRef = auxiliaryBinding.draftSaveQueue;
  const auxiliarySessionSaveQueueRef = auxiliaryBinding.sessionSaveQueue;
  const mainComposerCaretRef = useRef(0);
  const promptTemplateSelectionRef = useRef({ start: 0, end: 0 });
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );
  const {
    workspaceAvailability,
    workspaceAvailabilityCheckRevision,
    setWorkspaceAvailabilityCheckRevision,
    validateSessionWorkspace,
  } = useSessionWorkspaceAvailability(withmateApi, selectedSession);
  const displayedSession = useMainAuxiliaryRuntimeSession(selectedSession, activeAuxiliarySession);
  const selectedAuxiliaryRuntimeSession = useMainAuxiliaryRuntimeSession(selectedSession, auxiliaryWorkspace.selectedSession);
  const isAuxiliaryMode = activeAuxiliarySession !== null;
  const selectedSessionId = selectedSession?.id ?? null;
  const handleSidePaneChange = useCallback((sidePane: SessionSidePane) => {
    void persistChatLayoutPreference(withmateApi, { target: "sidePane", value: sidePane });
  }, [withmateApi]);
  const {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailVisible,
    isFilesPaneVisible,
    isContextRailResizing,
    isFilesPaneResizing,
    handleStartContextRailResize,
    handleToggleContextRailVisibility,
    handleKeyDownContextRailResize,
    handleStartFilesPaneResize,
    handleToggleFilesPaneVisibility,
    handleKeyDownFilesPaneResize,
    handleShowContextRail,
  } = useSessionSidePanes({
    ownerKey: selectedSessionId,
    initialSidePane: isAppSettingsLoaded ? appSettings.chatLayoutPreference.sidePane : null,
    onSidePaneChange: handleSidePaneChange,
  });
  const activeRunSessionId = auxiliaryWorkspace.target === "auxiliary"
    ? auxiliaryWorkspace.selectedId
    : selectedSessionId;
  const {
    getLiveRunRevision,
    hasSelectedSessionLiveRun,
    selectedSessionLiveRun,
    setLiveRunState,
  } = useActiveSessionLiveRun(withmateApi, selectedSession, activeRunSessionId);
  const {
    approvalActionRequestId,
    elicitationActionRequestId,
    resolveLiveApproval,
    resolveLiveElicitation,
    cancelRun,
  } = useSessionRunActions({
    api: withmateApi,
    activeRunSessionId,
    setLiveRunState,
    onError: (message) => window.alert(message),
  });
  const {
    selectedProviderQuotaTelemetry,
    selectedSessionContextTelemetry,
  } = useSessionTelemetry(withmateApi, displayedSession?.provider, activeRunSessionId);
  const composerOwner = useMemo<ComposerOwner>(
    () => ({
      kind: auxiliaryWorkspace.target === "auxiliary" ? "auxiliary" : "main",
      id: activeRunSessionId ?? "__none__",
    }),
    [activeRunSessionId, auxiliaryWorkspace.target],
  );
  composerOwnerRef.current = activeRunSessionId;
  const composerDraft = auxiliaryWorkspace.target === "auxiliary" ? activeAuxiliarySession?.composerDraft ?? "" : "";
  const isAuxiliaryTargetUnavailable = auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession;
  const composerSnapshot = composerRegistry.get(composerOwner, composerDraft);
  useLayoutEffect(() => {
    composerRegistry.hydrateIfUnedited(composerOwner, composerDraft);
  }, [composerRegistry, composerOwner, composerDraft]);
  const getComposerDraft = () => composerRegistry.get(composerOwner).draft;
  const composerState = {
    ...composerSnapshot,
    setDraft: (value: string, selection?: ComposerSelection) => composerRegistry.setDraft(composerOwner, value, selection),
    setSelection: (value: SetStateAction<ComposerSelection>) => composerRegistry.setSelection(composerOwner, value),
    setPreview: composerRegistry.setPreview.bind(composerRegistry, composerOwner),
    setImeComposing: (value: boolean) => composerRegistry.setImeComposing(composerOwner, value),
    setSaveState: (value: ComposerSaveState, error?: string | null) => composerRegistry.setSaveState(composerOwner, value, error),
    capture: () => composerRegistry.capture(composerOwner),
  };
  const isComposerFrozen = useSessionDraftFlushLifecycle({
    api: withmateApi,
    composerRegistry,
    persistence: auxiliaryDraftPersistence,
  });
  const draft = composerState.draft;
  const setDraft = useCallback((update: SetStateAction<string>) => {
    const current = composerRegistryRef.current?.get(composerOwner).draft ?? "";
    const next = typeof update === "function" ? update(current) : update;
    composerState.setDraft(next);
  }, [composerOwner, composerState.setDraft]);
  const { preview: composerPreview, setPreview: setComposerPreview } = composerState;
  const composerCaret = composerState.selection.start;
  const setComposerCaret = (caret: number) => {
    composerState.setSelection({ start: caret, end: caret });
  };
  useLayoutEffect(() => {
    const selection = composerState.selection;
    composerTextareaRef.current?.setSelectionRange(selection.start, selection.end);
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
    setIsAdditionalDirectoryListOpen(false);
    setForceComposerBlockedFeedback(false);
    composerState.setImeComposing(false);
  }, [activeRunSessionId]);
  const activeRunMessageCount = activeAuxiliarySession?.messages.length ?? selectedSession?.messages.length ?? 0;
  const prepareCentralSurfaceOpenRef = useRef<() => boolean>(() => false);
  const fileRootPreview = useFileRootPreviewController({
    api: withmateApi,
    activeRunSessionId,
    prepareCentralSurfaceOpen: () => prepareCentralSurfaceOpenRef.current(),
  });
  const {
    view: {
      selectedFilePreview,
      selectedFileDiffScopes,
      selectedFileDiffAvailabilityMessage,
      fileRootDiffPreview,
      fileRootDiffPendingPreview,
      fileRootDiffLoadingScope,
      fileRootGitHistoryDiffPreview,
      fileRootGitHistoryDiffPendingPreview,
      fileRootGitHistoryDiffLoading,
    },
    actions: {
      closeFilePreviews,
      clearHistoryDiffPreview,
      handleOpenFileRootFile,
      handleShowFileRootDiff,
      handleOpenSelectedFileDiff,
      handleReloadFileRootDiff,
      handleShowFileRootGitHistoryDiff,
      handleReloadFileRootGitHistoryDiff,
    },
  } = fileRootPreview;
  const isCentralPreviewActive = selectedFilePreview !== null
    || fileRootDiffPreview !== null
    || fileRootDiffPendingPreview !== null
    || fileRootGitHistoryDiffPreview !== null
    || fileRootGitHistoryDiffPendingPreview !== null
    || isPromptTemplateWorkspaceOpen;
  const closeCentralPreview = useCallback(() => {
    closeFilePreviews();
    setIsPromptTemplateWorkspaceOpen(false);
    setIsSkillPickerOpen(false);
    setPreviewChatActivity(endPreviewChatActivity());
  }, [closeFilePreviews]);
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
  prepareCentralSurfaceOpenRef.current = prepareCentralSurfaceOpen;
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
  const selectedSessionRunState: Session["runState"] | null = resolveSelectedSessionRunState({
    runState: selectedSession?.runState,
    hasLiveRun: hasSelectedSessionLiveRun,
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
      displayedSession
        ? {
            id: displayedSession.characterId,
            name: displayedSession.character.trim() || DEFAULT_SESSION_RUNTIME_NAME,
            iconPath: displayedSession.characterIconPath,
            description: "",
            roleMarkdown: "",
            notesMarkdown: "",
            updatedAt: displayedSession.updatedAt,
            themeColors: displayedSession.characterThemeColors,
            sessionCopy: DEFAULT_CHARACTER_SESSION_COPY,
          }
        : null,
    [displayedSession],
  );
  const isSelectedSessionReadOnly = selectedSession ? isReadOnlySession(selectedSession) : false;
  const persistSession = useCallback(async (nextSession: Session) => {
    return persistMainSessionState(nextSession, isSelectedSessionReadOnly);
  }, [isSelectedSessionReadOnly, persistMainSessionState]);
  const sessionHeader = useSessionHeaderOperations({
    api: withmateApi,
    selectedSession,
    isReadOnly: isSelectedSessionReadOnly,
    runState: selectedSessionRunState,
    persistSession,
    closeWindow: () => window.close(),
  });
  const {
    titleDraft,
    setTitleDraft,
    isEditingTitle,
    startTitleEdit: handleStartTitleEdit,
    cancelTitleEdit: handleCancelTitleEdit,
    saveTitle: handleSaveTitle,
    deleteSession: handleDeleteSession,
  } = sessionHeader;
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

    if (auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession) {
      return auxiliaryWorkspace.detailError?.message ?? auxiliaryWorkspace.error?.message ?? "Auxiliary の会話を読み込んでいます。";
    }

    if (!isSelectedProviderEnabled) {
      return "Provider is disabled. Enable it in Settings.";
    }

    if (workspaceExecutionGate.blockedReason) {
      return workspaceExecutionGate.blockedReason;
    }

    return "";
  }, [activeAuxiliarySession, auxiliaryWorkspace.detailError, auxiliaryWorkspace.error, auxiliaryWorkspace.target, isSelectedProviderEnabled, isSelectedSessionReadOnly, selectedSession, workspaceExecutionGate]);
  const composerBusyReason = pendingSubmitSessionId !== null && pendingSubmitSessionId === activeRunSessionId
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

  const glossary = useSessionGlossary({
    api: withmateApi,
    selectedSession: selectedSession ? {
      id: selectedSession.id,
      revision: selectedSession.updatedAt,
      workspaceLabel: selectedSession.workspaceLabel,
      branch: selectedSession.branch,
    } : null,
    onActivatePane: () => {
      setActiveContextPaneTab("glossary");
      handleShowContextRail();
    },
  });
  const {
    view: {
      projection: sessionGlossaryProjection,
      searchQuery: glossarySearchQuery,
      searchEntries: glossarySearchEntries,
      searchTotal: glossarySearchTotal,
      searchLoading: isGlossarySearchLoading,
      searchError: glossarySearchError,
      selectedTerm: selectedGlossaryTerm,
    },
    actions: {
      onSearchQueryChange: setGlossarySearchQuery,
      onLoadMoreSearchResults: handleLoadMoreGlossarySearchResults,
      onSelectTerm: setSelectedGlossaryTerm,
      onBackToList: handleGlossaryBackToList,
      onActivateGlossaryEntry: handleActivateGlossaryEntry,
    },
    annotationMatcher: glossaryAnnotationMatcher,
  } = glossary;

  useEffect(() => {
    applySessionDocumentTitle(resolveAgentSessionDocumentTitle({
      sessionTitle: selectedSession?.taskTitle,
      sessionId: selectedId,
    }));
  }, [selectedId, selectedSession?.taskTitle]);

  const {
    availableSkills,
    availableCustomAgents,
    isCustomAgentListLoading,
    isSkillListLoading,
    skillListError,
  } = useResourceDiscovery({
    api: withmateApi,
    activeRunSessionId,
    displayedProvider: displayedSession?.provider,
    selectedProvider: selectedSession?.provider,
    selectedWorkspacePath: selectedSession?.workspacePath,
    auxiliaryProvider: activeAuxiliarySession?.provider,
    appSettingsRevision: appSettings,
  });

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

  const displayedMessages: Message[] = displayedSession?.messages ?? [];
  const activityMonitorScrollSignature = useMemo(
    () => buildLiveRunScrollSignature(selectedSessionLiveRun),
    [selectedSessionLiveRun],
  );
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const isMessageListFollowing = true;
  const handleMessageListScroll = useCallback(() => {}, []);
  const followMessageListLatest = useCallback(() => {}, []);

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
    composerState.setImeComposing(false);
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    setIsRetryDraftReplacePending(false);
  }, [selectedSession?.provider, selectedSessionId]);

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
      hasReasoningCapability,
      hasReasoningText: hasLiveRunReasoningText,
    }),
    [
      hasLiveRunReasoningText,
      hasReasoningCapability,
      isCopilotSession,
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
  const shouldProtectDraftOnRetryEdit = () => shouldProtectRetryEditDraft({
    retryBanner,
    draft: getComposerDraft(),
  });
  const isComposerDisabled = selectedSessionRunState === "running" || !!composerBlockedReason || isSelectedSessionReadOnly;
  const composerSendability = useMemo(
    () =>
      resolveComposerSendabilityState({
        runState: selectedSessionRunState,
        busyReason: composerBusyReason,
        blockedReason: sessionExecutionBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: getComposerDraft(),
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
    const clientRequestId = createSessionTurnClientRequestId();
    const request: RunSessionTurnRequest = {
      userMessage: messageText,
      clientRequestId,
      submitSource: options?.submitSource ?? "composer",
      codexReviewer: selectedSession.codexReviewer,
    };
    await runMainSessionTurnFromRuntime({
      sessionId,
      selectedSession,
      request,
      composerOwner,
      clearDraft: options?.clearDraft ?? true,
      shouldCollapseActionDock: options?.collapseActionDock ?? false,
      isCentralPreviewActive,
      hasLiveRun: !!selectedSessionLiveRun,
      selectedSessionRunState,
      blockedReason: sessionExecutionBlockedReason,
      isReadOnly: isSelectedSessionReadOnly,
      userMicrocopyCatalog: appSettings.userMicrocopyCatalog,
      currentTimestamp: currentTimestampLabel(),
      validateWorkspace: () => validateSessionWorkspace(selectedSession, true),
      liveRun: { getRevision: getLiveRunRevision, setState: setLiveRunState },
      acknowledgePreviewChatMessageCount: (id, count) => setPreviewChatActivity((current) => acknowledgePreviewChatMessageCount(current, id, count)),
      collapseActionDock: () => setIsActionDockPinnedExpanded(false),
      log: logSessionRunStuckInvestigation,
    });
  };

  const handleSend = async () => {
    if (composerRegistry.isFrozen) return;
    if (auxiliaryWorkspace.target === "auxiliary" && !activeAuxiliarySession) {
      triggerComposerBlockedFeedback();
      return;
    }
    if (activeAuxiliarySession) {
      const auxiliaryDraft = composerState.capture().draft;
      if (composerRegistry.get(composerOwner).saveState === "error") {
        triggerComposerBlockedFeedback();
        return;
      }
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

    if (isComposerDisabled || !getComposerDraft().trim()) {
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
    await cancelRun(buildRunningSessionCancelTarget({
      sessionId: selectedSession?.id,
      runState: selectedSessionRunState,
      isRunning: isSelectedSessionRunning,
    }));
  };

  const handleComposerSubmitShortcut = () => applyComposerSubmitCommand({
    isSubmitDisabled: () => {
      const current = composerRegistry.get(composerOwner);
      return composerRegistry.isFrozen
        || current.isImeComposing
        || current.saveState === "error"
        || (activeAuxiliarySession
          ? activeAuxiliarySession.runState === "running"
          : current.preview.errors.length > 0 || selectedSessionRunState === "running");
    },
    isSubmitBlocked: () => {
      const current = composerRegistry.get(composerOwner);
      const activeSendability = activeAuxiliarySession
        ? buildComposerSendabilityState({
            runState: activeAuxiliarySession.runState,
            busyReason: composerBusyReason,
            blockedReason: sessionExecutionBlockedReason,
            inputErrors: current.preview.errors,
            draftText: current.draft,
          })
        : resolveComposerSendabilityState({
            runState: selectedSessionRunState,
            busyReason: composerBusyReason,
            blockedReason: sessionExecutionBlockedReason,
            inputErrors: current.preview.errors,
            draftText: current.draft,
            forceBlockedFeedback: forceComposerBlockedFeedback,
          });
      return current.saveState === "error" || activeSendability.isSendDisabled;
    },
    notifySubmitBlocked: triggerComposerBlockedFeedback,
    submit: () => void handleSend(),
  });

  useShortcutDispatcherSettings(appSettings.keyboardShortcuts);
  useShortcutScope("composer");
  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.composerSubmit, handleComposerSubmitShortcut);

  const handleSelectSkill = createSkillPromptInsertionHandler<DiscoveredSkill>({
    getProvider: () => selectedSession?.provider,
    getDraft: () => getComposerDraft(),
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
    if (composerRegistry.isFrozen || !selectedSession || isSelectedSessionReadOnly || selectedSession.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === selectedSession.customAgentName) {
      closeAgentPicker();
      return;
    }

    await runMainRuntimeOption({ kind: "custom-agent", value: nextCustomAgentName });
    closeAgentPicker();
  };

  const handleToggleSessionPin = async () => {
    if (!withmateApi || !selectedSession || isSessionPinPending) {
      return;
    }
    try {
      await toggleSessionPin(selectedSession);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "ピン止めの変更に失敗したよ。");
    }
  };

  const runMainRuntimeOption = async (option: MainRuntimeOption) => {
    if (!withmateApi) return;
    await runMainRuntimeOptionOperation({
      session: selectedSession,
      isReadOnly: isSelectedSessionReadOnly,
      runState: selectedSessionRunState,
      providerCatalog: selectedProviderCatalog,
      catalogRevision: modelCatalog?.revision ?? null,
      option,
      persist: persistSession,
      createTimestampLabel: currentTimestampLabel,
    });
  };

  const handleChangeApproval = (approvalMode: Session["approvalMode"]) => runMainRuntimeOption({ kind: "approval-mode", value: approvalMode });
  const handleChangeCodexSandboxMode = (value: Session["codexSandboxMode"]) => runMainRuntimeOption({ kind: "codex-sandbox-mode", value });
  const handleChangeCodexSpeed = (value: Session["codexSpeed"]) => runMainRuntimeOption({ kind: "codex-speed", value });
  const handleChangeCodexReviewer = (value: Session["codexReviewer"]) => runMainRuntimeOption({ kind: "codex-reviewer", value });

  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (!withmateApi) {
      return;
    }

    await withmateApi.openDiffWindow(diffPreview);
  };

  const handleChangeModel = (model: string) => runMainRuntimeOption({ kind: "model", value: model });
  const handleChangeReasoningEffort = (value: Session["reasoningEffort"]) => runMainRuntimeOption({ kind: "reasoning-effort", value });

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

  const handleToggleMessageBookmark = async (target: MessageCollapseTarget): Promise<void> => {
    const nextIsBookmarked = !target.isBookmarked;
    if (target.source.kind === "auxiliary") {
      if (
        isSelectedSessionReadOnly
        || !activeAuxiliarySession
        || activeAuxiliarySession.runState === "running"
        || activeAuxiliarySession.id !== target.source.sessionId
      ) {
        return;
      }

      await updateActiveAuxiliarySession((current) => {
        const message = current.messages[target.source.messageIndex];
        if (!message) {
          return current;
        }

        return {
          ...current,
          updatedAt: currentTimestampLabel(),
          messages: current.messages.map((currentMessage, index) => (
            index === target.source.messageIndex
              ? setMessageBookmarked(currentMessage, nextIsBookmarked)
              : currentMessage
          )),
        };
      });
      return;
    }

    if (!selectedSession || isSelectedSessionReadOnly || selectedSessionRunState === "running") {
      return;
    }

    const message = selectedSession.messages[target.source.messageIndex];
    if (!message) {
      return;
    }

    await persistSession({
      ...selectedSession,
      updatedAt: currentTimestampLabel(),
      messages: selectedSession.messages.map((currentMessage, index) => (
        index === target.source.messageIndex
          ? setMessageBookmarked(currentMessage, nextIsBookmarked)
          : currentMessage
      )),
    });
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
    if (composerRegistry.isFrozen) return;
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
    if (composerRegistry.isFrozen) return;
    const textarea = composerTextareaRef.current;
    await runAuxiliarySkillPromptInsertionOperation({
      activeSession: activeAuxiliarySession
        ? { ...activeAuxiliarySession, composerDraft: getComposerDraft() }
        : null,
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
        await handleAuxiliaryDraftChange(draft, draft.length);
      },
      afterDraftUpdated: (nextState) => {
        if (composerOwnerRef.current === activeRunSessionId) {
          restoreComposerTextareaFocusAndCaret(textarea, nextState.caret);
        }
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
    if (composerRegistry.isFrozen) return;
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

  const toggleAgentPicker = createAgentPickerToggleHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
    setSkillPickerOpen: setIsSkillPickerOpen,
  });

  const handleToggleAgentPicker = () => {
    if (!composerRegistry.isFrozen) toggleAgentPicker();
  };

  const toggleSkillPicker = createSkillPickerToggleHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
    setSkillPickerOpen: setIsSkillPickerOpen,
  });

  const handleToggleSkillPicker = () => {
    if (composerRegistry.isFrozen) return;
    if (!isSkillPickerOpen && !requestCentralSurfaceClose()) {
      return;
    }
    toggleSkillPicker();
  };

  const toggleAdditionalDirectoryList = createAdditionalDirectoryListToggleHandler({
    setAdditionalDirectoryListOpen: setIsAdditionalDirectoryListOpen,
  });

  const handleToggleAdditionalDirectoryList = () => {
    if (!composerRegistry.isFrozen) toggleAdditionalDirectoryList();
  };

  const handleOpenInlinePath = async (target: string, ownerSessionId = activeRunSessionId) => {
    if (!withmateApi || !ownerSessionId) {
      return;
    }
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
    canOpen: () => !!selectedSession,
    providers: auxiliaryLaunchProviderItems,
    getSelectedProviderId: () => selectedSession?.provider,
    openAuxiliaryLaunchDialog: (params) => {
      openAuxiliaryLaunchDialog(params);
      const feedback = resolveAuxiliaryLaunchCreationFeedback({ status: auxiliaryCreationStatus ?? "not-found" });
      if (feedback) setAuxiliaryLaunchStartError(new Error(feedback));
    },
  });

  const handleCloseAuxiliaryLaunchDialog = createAuxiliaryLaunchDialogCloseHandler({
    closeAuxiliaryLaunchDialog,
  });

  const handleSelectAuxiliaryLaunchProvider = createAuxiliaryLaunchProviderSelectHandler({
    selectAuxiliaryLaunchProvider,
  });

  const handleStartAuxiliarySession = async () => {
    if (!selectedSession || isSelectedSessionReadOnly || !isSelectedWorkspaceAvailable) return;
    const startProvider = resolveAuxiliaryLaunchStartProvider({ providerId: auxiliaryLaunchProviderId });
    if (startProvider.status === "blocked") {
      setAuxiliaryLaunchStartError(startProvider.error);
      return;
    }
    await auxiliaryCreation.start(startProvider.providerId);
  };

  const handleCancelAuxiliaryCreation = () => auxiliaryCreation.cancel();

  const handleChangeConversationTarget = (target: "main" | "auxiliary") => {
    auxiliaryWorkspace.setTarget(target);
  };

  const handleAuxiliaryDraftChange = async (value: string, selectionStart: number) => {
    const session = activeAuxiliarySession;
    if (!session || composerRegistry.isFrozen) return;
    setForceComposerBlockedFeedback(false);
    await auxiliaryDraftPersistence.changeDraft(session, value, selectionStart);
  };

  const handleRetryAuxiliaryDraftSave = () => {
    if (!activeAuxiliarySession || composerRegistry.isFrozen) return;
    auxiliaryDraftPersistence.retrySave(activeAuxiliarySession);
  };

  const sendAuxiliaryMessage = (messageText: string): Promise<void> => {
    if (composerRegistry.isFrozen) return Promise.resolve();
    return auxiliaryDraftPersistence.trackSend(performAuxiliarySend(messageText));
  };

  const performAuxiliarySend = async (messageText: string) => {
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    const sendCapture = composerRegistry.capture(composerOwner);
    messageText = sendCapture.draft;
    const draftOwner = auxiliaryDraftPersistence.getOwner(activeAuxiliarySession);
    try {
      await draftOwner?.flush();
      await draftOwner?.ensureLoaded();
    } catch {
      composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
      return;
    }
    if (composerRegistry.isFrozen) return;
    const durableDraft = draftOwner?.durableRecord;
    const latestCapture = composerRegistry.capture(composerOwner);
    if (!draftOwner || !durableDraft || latestCapture.revision !== sendCapture.revision || latestCapture.draft !== sendCapture.draft || durableDraft.text !== sendCapture.draft) {
      // A newer local revision is a normal send-capture invalidation, not a save failure.
      // Keep it editable and let the next explicit Send capture that revision.
      if (latestCapture.revision !== sendCapture.revision || latestCapture.draft !== sendCapture.draft) {
        composerRegistry.setSaveState(composerOwner, "saved");
      } else {
        composerRegistry.setSaveState(composerOwner, "error", "Draft could not be saved.");
      }
      return;
    }

    let clearedRevision: number | null = null;
    const result = await runAuxiliarySessionSendOperationWithApi({
      activeSession: activeAuxiliarySession,
      composerBlockedReason,
      messageText,
      auxiliaryDraftIncarnation: durableDraft.incarnation,
      auxiliaryDraftDurableRevision: durableDraft.durableRevision,
      parentMessageCount: selectedSession?.messages.length ?? null,
      updatedAt: currentTimestampLabel(),
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      canStartRun: () => !composerRegistry.isFrozen,
      beforeRunningSessionApplied: () => {
        clearedRevision = composerRegistry.clearIfRevision(composerOwner, sendCapture.revision);
        setIsActionDockPinnedExpanded(false);
      },
      onRunError: () => {
        if (clearedRevision !== null) {
          const restoredRevision = composerRegistry.restoreIfRevision(composerOwner, clearedRevision, () => sendCapture.draft);
          if (restoredRevision !== null) {
            void auxiliaryDraftPersistence.observeSave(activeAuxiliarySession.id, restoredRevision, draftOwner.enqueue(sendCapture.draft, durableDraft));
          }
        }
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
    await draftOwner?.reload().catch(() => undefined);
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
      composerRegistry.isFrozen || (activeAuxiliarySession
        ? activeAuxiliarySession.runState === "running" || !!composerBlockedReason
        : isComposerDisabled)
    ),
    notifyBlocked: triggerComposerBlockedFeedback,
    getComposerState: () => ({
      draft: getComposerDraft(),
      fallbackCaret: composerRegistry.get(composerOwner).selection.start,
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
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const textarea = composerOwnerRef.current === activeRunSessionId ? composerTextareaRef.current : null;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = getComposerDraft();
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
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const textarea = composerOwnerRef.current === activeRunSessionId ? composerTextareaRef.current : null;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = getComposerDraft();
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
    getDraft: () => getComposerDraft(),
    applyRemoval: (nextState) => {
      if (composerRegistry.isFrozen) return;
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
    if (composerRegistry.isFrozen || !withmateApi || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await pickComposerReferencePath(
      kind,
      pickerBaseDirectory || selectedSession?.workspacePath || null,
      withmateApi,
    );
    if (composerRegistry.isFrozen) return;
    applyPickedComposerReferencePathCommand({
      kind,
      selectedPath,
      setPickerBaseDirectory,
      insertReferencePath: (path) => insertReferencePath(path),
    });
  };

  const handleAddToSessionFiles = async () => {
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickFiles(pickerBaseDirectory || selectedSession.workspacePath || null);
    if (composerRegistry.isFrozen || selectedPaths.length === 0) {
      return;
    }

    const savedPaths = await withmateApi.copyFilesToSessionFiles(selectedSession.id, selectedPaths);
    if (composerRegistry.isFrozen || savedPaths.length === 0) {
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
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPaths = await withmateApi.pickSessionFiles(selectedSession.id);
    if (composerRegistry.isFrozen || selectedPaths.length === 0) {
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
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionFolder(selectedSession.id);
    if (composerRegistry.isFrozen || !selectedPath) {
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
    if (composerRegistry.isFrozen || !withmateApi || !selectedSession || isSelectedSessionReadOnly || isAuxiliaryTargetUnavailable) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickSessionImageFile(selectedSession.id);
    if (composerRegistry.isFrozen || !selectedPath) {
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
        !composerRegistry.isFrozen &&
        !!selectedSession &&
        !isAuxiliaryTargetUnavailable &&
        !isSelectedSessionReadOnly &&
        !(targetAuxiliarySession
          ? targetAuxiliarySession.runState === "running"
          : selectedSessionRunState === "running");
    },
    currentTimestampLabel,
    fallbackErrorMessage: "貼り付けたファイルの保存に失敗したよ。",
    getSavePastedSessionFile: () => {
      return withmateApi ? (request) => {
        if (composerRegistry.isFrozen) throw new Error("Attachments cannot be added while the window is closing.");
        return withmateApi.savePastedSessionFile(request);
      } : null;
    },
    getSessionId: () => selectedSession?.id,
    insertAttachments: insertPastedAttachments,
  });

  const handleAddAdditionalDirectory = async () => {
    await runPickedAdditionalDirectoryOperation({
      canPickDirectory: () => !!withmateApi &&
        !composerRegistry.isFrozen &&
        !!selectedSession &&
        !isSelectedSessionReadOnly &&
        selectedSessionRunState !== "running",
      getPickerBaseDirectory: () => resolveAdditionalDirectoryPickerBase(pickerBaseDirectory, selectedSession?.workspacePath),
      pickDirectory: (baseDirectory) => withmateApi?.pickDirectory(baseDirectory) ?? Promise.resolve(null),
      applyPickedDirectory: async (selectedPath) => {
        if (composerRegistry.isFrozen || !selectedSession) {
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
        !composerRegistry.isFrozen &&
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
    if (composerRegistry.isFrozen || !withmateApi) return;
    await runAddAuxiliaryAdditionalDirectoryOperationWithApi({
      api: {
        pickDirectory: async (basePath) => {
          const selectedPath = await withmateApi.pickDirectory(basePath);
          return composerRegistry.isFrozen ? null : selectedPath;
        },
      },
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
    if (composerRegistry.isFrozen) return;
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
      hasReasoningText: hasLiveRunReasoningText,
      isSelectedSessionRunning: renderedIsRunning,
    }),
    [
      activeContextPaneTab,
      hasLiveRunReasoningText,
      latestCommandView,
      renderedIsRunning,
      selectedBackgroundTasks,
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
      draftText: getComposerDraft(),
    }),
    [
      draft,
      activeAuxiliarySession?.runState,
      composerBusyReason,
      composerPreview.errors,
      sessionExecutionBlockedReason,
    ],
  );
  const renderedSession = displayedSession;
  const renderedMessages = displayedMessages;
  const renderedDraft = draft;
  const handleOpenPromptTemplates = () => {
    if (composerRegistry.isFrozen) return;
    closeFilePreviews();
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
    closeFilePreviews();
    setIsPromptTemplateWorkspaceOpen(true);
  };
  const handleInsertPromptTemplate = (prompt: string) => {
    if (composerRegistry.isFrozen || isAuxiliaryTargetUnavailable) return;
    const insertion = insertComposerTextAtSelection(
      getComposerDraft(),
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
      if (composerOwnerRef.current === activeRunSessionId) {
        restoreComposerTextareaFocusAndCaret(composerTextareaRef.current, insertion.caret);
      }
    });
  };
  const renderedComposerSendability = activeAuxiliarySession ? auxiliaryComposerSendability : composerSendability;
  const renderedIsSendDisabled = activeAuxiliarySession
    ? auxiliaryComposerSendability.isSendDisabled
    : isSendDisabled;
  const renderedComposerButtonTitle = activeAuxiliarySession
    ? getComposerSendButtonTitle(auxiliaryComposerSendability)
    : composerSendButtonTitle;
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
    ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason
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
      canInsert={!isComposerFrozen && (activeAuxiliarySession
        ? activeAuxiliarySession.runState !== "running" && !composerBlockedReason
        : !isComposerDisabled)}
      onRegisterCloseGuard={registerPromptTemplateCloseGuard}
      onBack={closeCentralPreview}
      onInsert={handleInsertPromptTemplate}
    />
  ) : fileRootGitHistoryDiffPendingPreview ? (
    <SessionDiffPreview
      title={formatGitHistoryDiffTitle(fileRootGitHistoryDiffPendingPreview.request)}
      contextLabel={formatGitHistoryDiffContext(fileRootGitHistoryDiffPendingPreview.request)}
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
      title={formatGitHistoryDiffTitle(fileRootGitHistoryDiffPreview.request)}
      contextLabel={formatGitHistoryDiffContext(fileRootGitHistoryDiffPreview.request)}
      previewRevision={fileRootGitHistoryDiffPreview.generation}
      patch={fileRootGitHistoryDiffPreview.patch}
      backNavigation={{ label: "Back to Chat", onBack: closeCentralPreview }}
      onCopyText={handleCopyMessageText}
      onQuoteText={handleQuoteMessageText}
      onOpenPreview={fileRootGitHistoryDiffPreview.previewResource && !fileRootGitHistoryDiffPreview.comparison
        ? () => handleOpenFileRootGitHistoryPreview(fileRootGitHistoryDiffPreview.previewResource!)
        : undefined}
      onOpenBeforePreview={fileRootGitHistoryDiffPreview.previewBeforeResource
        ? () => handleOpenFileRootGitHistoryPreview(fileRootGitHistoryDiffPreview.previewBeforeResource!)
        : undefined}
      onOpenAfterPreview={fileRootGitHistoryDiffPreview.previewAfterResource
        ? () => handleOpenFileRootGitHistoryPreview(fileRootGitHistoryDiffPreview.previewAfterResource!)
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

  const chatWindowProps = buildAgentSessionChatWindowProps({
        mainContent: filePreviewContent,
        leftPane: fileExplorerPane,
        isFilesPaneVisible,
        selectedSession: renderedSession,
        selectedSessionCharacter,
        displayedMessages: renderedMessages,
        displayedMessageKeys: undefined,
        displayedMessageGroups: undefined,
        messageNavigatorCharacter: selectedSessionCharacter,
        expandedArtifacts,
        sessionThemeStyle,
        sessionDockLayoutRef,
        headerDockRef,
        actionDockRef,
        sessionDockLayoutStyle,
        sessionWorkbenchRef,
        sessionWorkbenchStyle,
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
        composerController: {
          owner: composerOwner,
          registry: composerRegistryRef.current!,
          initialDraft: composerDraft,
        },
        onRetryComposerSave: activeAuxiliarySession
          ? handleRetryAuxiliaryDraftSave
          : undefined,
        additionalDirectoryItems,
        draft: renderedDraft,
        composerTextareaRef,
        isComposerDisabled: activeAuxiliarySession
          ? activeAuxiliarySession.runState === "running" || !!composerBlockedReason
          : isComposerDisabled,
        isSendDisabled: renderedIsSendDisabled,
        composerSendability: renderedComposerSendability,
        forceComposerBlockedFeedback,
        isComposerFrozen,
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
          onBackToList: handleGlossaryBackToList,
        } : undefined,
        glossaryAnnotationMatcher,
        onActivateGlossaryEntry: handleActivateGlossaryEntry,
        selectedBackgroundTasks,
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
        onToggleMessageBookmark: handleToggleMessageBookmark,
        onToggleArtifact: toggleArtifact,
        onLoadArtifactDetail: (messageIndex) =>
          Promise.resolve(withmateApi?.getSessionMessageArtifact(selectedSession.id, messageIndex) ?? null),
        onOpenDiff: (title, file) =>
          setSelectedDiff({
            title,
            file,
            themeColors: selectedSession.characterThemeColors,
          }),
        onResolveLiveApproval: (request, decision) => void resolveLiveApproval(request, decision),
        onResolveLiveElicitation: (request, response) => void resolveLiveElicitation(request, response),
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
          if (composerRegistry.isFrozen) return;
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
        onDraftSelect: (selectionStart) => {
          if (!activeRunSessionId) return;
          const selectionEnd = composerTextareaRef.current?.selectionEnd ?? selectionStart;
          composerState.setSelection({ start: selectionStart, end: selectionEnd });
          if (!activeAuxiliarySession) mainComposerCaretRef.current = selectionStart;
        },
        ...buildOnDraftCompositionHandlers({
          setComposerCaret,
          setIsComposerImeComposing: (value) => composerState.setImeComposing(value),
          getSelectionStart: () => composerOwnerRef.current === activeRunSessionId
            ? composerTextareaRef.current?.selectionStart : composerCaret,
          getFallbackSelectionStart: () => renderedDraft.length,
          syncMainComposerCaret: !activeAuxiliarySession
            ? (selectionStart) => {
                mainComposerCaretRef.current = selectionStart;
              }
            : undefined,
        }),
        onSendOrCancel: buildAuxiliaryAwareSendOrCancelHandler({
          shouldSendAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          isAuxiliarySessionRunning: activeAuxiliarySession?.runState === "running",
          isSelectedSessionRunning,
          preferAuxiliarySendOverSelectedCancel: true,
          onCancelAuxiliaryRun: handleCancelAuxiliaryRun,
          onSendAuxiliary: handleSend,
          onCancelSelectedSessionRun: handleCancelRun,
          onSendSelectedSession: handleSend,
        }),
        onChangeApprovalMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["approvalMode"]>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryApproval,
          onSelectedSessionChange: handleChangeApproval,
        }),
        onChangeCodexSandboxMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["codexSandboxMode"]>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliarySandboxMode,
          onSelectedSessionChange: handleChangeCodexSandboxMode,
        }),
        onChangeCodexSpeed: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["codexSpeed"]>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryCodexSpeed,
          onSelectedSessionChange: handleChangeCodexSpeed,
        }),
        onChangeCodexReviewer: buildAuxiliaryAwareRuntimeOptionChangeHandler<Session["codexReviewer"]>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryCodexReviewer,
          onSelectedSessionChange: handleChangeCodexReviewer,
        }),
        onChangeModel: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryModel,
          onSelectedSessionChange: handleChangeModel,
        }),
        onChangeReasoningEffort: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: (value) => handleChangeAuxiliaryReasoningEffort(value as Session["reasoningEffort"]),
          onSelectedSessionChange: (value) => handleChangeReasoningEffort(value as Session["reasoningEffort"]),
        }),
        onStartContextRailResize: handleStartContextRailResize,
        onStartFilesPaneResize: handleStartFilesPaneResize,
        onStartActionDockResize: handleStartActionDockResize,
        onToggleActionDock: handleToggleActionDock,
        onToggleContextRailVisibility: handleToggleContextRailVisibility,
        onKeyDownContextRailResize: handleKeyDownContextRailResize,
        onToggleFilesPaneVisibility: handleToggleFilesPaneVisibility,
        onKeyDownFilesPaneResize: handleKeyDownFilesPaneResize,
        onCycleContextPaneTab: handleCycleContextPaneTab,
        onSelectContextPaneTab: setActiveContextPaneTab,
        onCloseDiff: () => setSelectedDiff(null),
        onOpenDiffWindow: (payload) => void handleOpenDiffWindow(payload),
        onLoadMoreAuditLogs: handleLoadMoreAuditLogs,
        onLoadAuditLogDetail: handleLoadAuditLogDetail,
        onLoadAuditLogOperationDetail: handleLoadAuditLogOperationDetail,
        onCloseAuditLog: () => setAuditLogsOpen(false),
      });

  return (
    <ShortcutSettingsProvider settings={appSettings.keyboardShortcuts}>
      <>
      <ChatWindow
        {...chatWindowProps}
        rightPane={isAuxiliaryTargetUnavailable
          ? <div className="concurrent-chat-state" role="status">{sessionExecutionBlockedReason}</div>
          : chatWindowProps.rightPane}
        headerProps={{
          ...chatWindowProps.headerProps,
          taskTitle: selectedSession.taskTitle,
          isRunning: isSelectedSessionRunning,
          isReadOnly: isSelectedSessionReadOnly,
          showRenameButton: true,
          showDeleteButton: true,
        }}
        concurrentChats={{
          mainSession: selectedSession,
          auxiliarySession: auxiliaryWorkspace.selectedSession ? selectedAuxiliaryRuntimeSession : null,
          api: withmateApi ?? undefined,
          mainLiveRun: auxiliaryWorkspace.target === "auxiliary" ? undefined : selectedSessionLiveRun,
          auxiliaryLiveRun: auxiliaryWorkspace.target === "auxiliary" ? selectedSessionLiveRun : undefined,
          main: {
            ...chatWindowProps.messageColumnProps,
            sessionId: selectedSession.id,
            messages: selectedSession.messages,
            onToggleMessageBookmark: auxiliaryWorkspace.target === "main"
              && !isSelectedSessionReadOnly
              && !isSelectedSessionRunning
              ? handleToggleMessageBookmark
              : undefined,
            onLoadArtifactDetail: (index) => withmateApi?.getSessionMessageArtifact(selectedSession.id, index) ?? Promise.resolve(null),
            onOpenPath: (target) => handleOpenInlinePath(target, selectedSession.id),
          },
          auxiliary: auxiliaryWorkspace.selectedSession ? {
            ...chatWindowProps.messageColumnProps,
            sessionId: auxiliaryWorkspace.selectedSession.id,
            messages: auxiliaryWorkspace.selectedSession.messages,
            onToggleMessageBookmark: auxiliaryWorkspace.target === "auxiliary"
              && !isSelectedSessionReadOnly
              && auxiliaryWorkspace.selectedSession.runState !== "running"
              ? handleToggleMessageBookmark
              : undefined,
            onLoadArtifactDetail: (index) => Promise.resolve(auxiliaryWorkspace.selectedSession?.messages[index]?.artifact ?? null),
            onOpenPath: (target) => handleOpenInlinePath(target, auxiliaryWorkspace.selectedId),
          } : null,
          selectedAuxiliaryId: auxiliaryWorkspace.selectedId,
          auxiliaryItems: auxiliaryWorkspace.summaries.map((summary) => ({
            id: summary.id,
            label: summary.preview?.trim() || "New conversation",
            searchText: summary.preview?.trim() || "New conversation",
            icon: <CharacterAvatar key={summary.id} character={{ name: "", iconPath: summary.characterIconPath ?? "" }} size="tiny" />,
            isProcessing: summary.runState === "running",
          })),
          onAddAuxiliary: handleOpenAuxiliaryLaunchDialog,
          isAddAuxiliaryDisabled: isSelectedSessionReadOnly || !isSelectedWorkspaceAvailable,
          target: auxiliaryWorkspace.target,
          widthRatio: auxiliaryWorkspace.widthRatio,
          scrollToLatestOnSend: appSettings.scrollToLatestOnSend,
          onSelectAuxiliary: auxiliaryWorkspace.selectSession,
          onTargetChange: handleChangeConversationTarget,
          onWidthRatioChange: auxiliaryWorkspace.setWidthRatio,
          loading: auxiliaryWorkspace.loading || auxiliaryWorkspace.detailLoading,
          error: auxiliaryWorkspace.detailError?.message ?? auxiliaryWorkspace.error?.message,
        }}
      />
      <AuxiliaryLaunchProviderDialog
        open={auxiliaryLaunchDialogOpen}
        providers={auxiliaryLaunchProviderItems}
        selectedProviderId={auxiliaryLaunchProviderId}
        feedback={auxiliaryLaunchFeedback}
        starting={auxiliaryCreationStarting}
        creationInFlight={auxiliaryCreation.inFlight}
        cancelling={auxiliaryCreationCancelling}
        canCancelCreation={canCancelAuxiliaryLaunchCreation(auxiliaryCreationStatus)}
        onClose={handleCloseAuxiliaryLaunchDialog}
        onCancelCreation={() => void handleCancelAuxiliaryCreation()}
        onSelectProvider={handleSelectAuxiliaryLaunchProvider}
        onStart={() => void handleStartAuxiliarySession()}
      />
      </>
    </ShortcutSettingsProvider>
  );
}
