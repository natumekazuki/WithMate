import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";

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
import type { ApprovalMode } from "./approval-mode.js";
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
import type {
  DiffPreviewPayload,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
} from "./app-state.js";
import { currentTimestampLabel } from "./app-state.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { CodexSpeed } from "./codex-speed.js";
import type { CodexReviewer } from "./codex-reviewer.js";
import type { CompanionMergeRunSummary, CompanionSession, CompanionSessionSummary } from "./companion-state.js";
import { createCompanionSessionSummary } from "./companion-state.js";
import {
  COMPANION_PROVIDER_EXECUTION_RETIRED_MESSAGE,
} from "./companion-retirement.js";
import { startCompanionSessionSummariesSubscription } from "./companion-session-summary-subscription.js";
import {
  buildCompanionChatSnapshot,
  type CompanionSessionWindowView,
  getCompanionWindowViewFromSearch,
} from "./companion-session-mode-adapter.js";
import { useCompanionCharacterProfile } from "./companion-character-profile.js";
import type { ChangedFile, DiscoveredCustomAgent, DiscoveredSkill } from "./runtime-state.js";
import type {
  CompanionMergeReadinessIssue,
  CompanionReviewSnapshot,
  CompanionSiblingCheckWarning,
} from "./companion-review-state.js";
import { getCompanionSessionIdFromLocation } from "./companion-review-state.js";
import { DiffViewer } from "./DiffViewer.js";
import {
  restoreComposerTextareaFocusAndCaret,
  restoreCurrentComposerTextareaFocusToEnd,
} from "./composer-textarea-focus.js";
import {
  getProviderCatalog,
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import { startModelCatalogSubscription } from "./model-catalog-subscription.js";
import { startAppSettingsSubscription } from "./app-settings-subscription.js";
import {
  createDefaultAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { ShortcutSettingsProvider } from "./shortcut-settings-context.js";
import { resolveOpenPathFeedback, showOpenPathFeedback } from "./open-path-result.js";
import { buildCompanionGroupMonitorEntries } from "./home/home-session-projection.js";
import { SessionHeader } from "./session-components.js";
import { ChatHeaderHandle, ChatWindow, ChatWindowStatusScreen } from "./chat/chat-window.js";
import { resolveSkillDiscoveryRequest } from "./skill-discovery-request.js";
import { applySessionDocumentTitle, resolveCompanionDocumentTitle } from "./chat/window-title.js";
import { resolveAuditLogOwner } from "./chat/audit-log-owner.js";
import { buildCompanionChatWindowProps } from "./chat/companion-chat-projection.js";
import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  handleAuxiliarySessionSendOperationResult,
  runAuxiliarySessionSendOperationWithApi,
} from "./auxiliary-session-send-operation.js";
import { openCompanionInlinePath } from "./chat/companion-inline-path.js";
import { COMPANION_PENDING_MESSAGE_TEXT } from "./chat/pending-run-indicator.js";
import {
  applyRetryDraftRestoreCommand,
  createCancelRetryDraftReplaceHandler,
  createRetryDraftReplaceConfirmationHandler,
  createRetryEditHandler,
  isRetryActionDisabled as resolveRetryActionDisabled,
  resolveRetryBannerKind,
  runRetryResendCommand,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
  type RetryBannerState,
} from "./chat/retry-state.js";
import {
  createCopyMessageTextHandler,
} from "./chat/message-text-actions.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  resolveComposerSendabilityState,
  resolveComposerSendPreflight,
} from "./session-composer-feedback.js";
import {
  buildActionDockRuntimeState,
  shouldFocusComposerForActionDockExpand,
} from "./action-dock-state.js";
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
  useChatLayoutPresentation,
  useSessionSidePanes,
  useSessionVerticalDockResize,
} from "./session-chat-layout-hooks.js";
import { persistChatLayoutPreference } from "./chat/chat-layout-preference.js";
import type { SessionSidePane } from "./session-side-pane.js";
import {
  applyOptimisticSessionRunUpdate,
  applyResolvedSessionRunUpdate,
  createOwnedPendingLiveSessionRunState,
  replaceLiveRunAfterResolvedRequest,
  rollbackOptimisticSessionRunUpdate,
  resolveSessionRunErrorMessage,
  resolveSessionTurnStartPreflight,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
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
import { resolvePendingAuxiliaryMessageGroupId } from "./auxiliary-session-message-projection.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandProjection,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  resolveAvailableContextPaneTabs,
  type ContextPaneTabKey,
} from "./session-ui-projection.js";
import { buildCompanionAuxiliaryRuntimeSession } from "./auxiliary-runtime-projection.js";
import {
  useCompanionAuxiliaryRuntimeSession,
} from "./auxiliary-render-projections.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import { CharacterAvatar, fileKindLabel } from "./ui-utils.js";
import { buildRuntimeSelectionOptions } from "./runtime-selection-options.js";
import { useAuxiliaryWorkspace } from "./chat/use-auxiliary-workspace.js";
import { useConversationComposerState } from "./chat/use-conversation-composer-state.js";
import {
  applyComposerDraftClearCommand,
  applyComposerDraftChangeCommand,
  buildOnDraftCompositionHandlers,
} from "./chat/composer-draft-handlers.js";
import {
  resolveComposerPreviewDisplay,
} from "./composer-preview-config.js";
import {
  createComposerPreviewRequest,
} from "./chat/use-composer-preview-resolution.js";
import { createPastedSessionAttachmentHandler } from "./chat/composer-paste-handlers.js";
import {
  runAuxiliaryDraftChangeAndSaveOperation,
  runAuxiliaryDraftPatchOperation,
} from "./auxiliary-draft-save-context.js";
import {
  createGuardedActiveAuxiliarySessionUpdater,
  enqueueAuxiliarySessionSaveWithQueue,
} from "./auxiliary-session-update-operation.js";
import {
  runAddAuxiliaryAdditionalDirectoryOperationWithApi,
  runRemoveAuxiliaryAdditionalDirectoryOperation,
} from "./auxiliary-additional-directory-operation.js";
import {
  applyComposerSubmitCommand,
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
import { isTerminalAuditLogPhase } from "./audit-log-phase.js";
import {
  SHORTCUT_COMMAND_IDS,
  useShortcutCommandHandler,
  useShortcutDispatcherSettings,
  useShortcutScope,
} from "./shortcut-registry.js";

function pickInitialFile(files: ChangedFile[]): ChangedFile | null {
  return files[0] ?? null;
}

const MERGE_FILE_LIST_DEFAULT_PERCENT = 32;
const MERGE_STAGE_DEFAULT_PERCENT = 50;
const MERGE_PANE_MIN_PERCENT = 30;
const MERGE_PANE_MAX_PERCENT = 70;

type ChangedFileTreeAction = "stage" | "unstage";

type ChangedFileTreeNode =
  | {
    kind: "directory";
    name: string;
    path: string;
    children: ChangedFileTreeNode[];
  }
  | {
    kind: "file";
    name: string;
    path: string;
    file: ChangedFile;
  };

type MutableChangedFileDirectory = {
  name: string;
  path: string;
  directories: Map<string, MutableChangedFileDirectory>;
  files: ChangedFile[];
};

function clampMergePanePercent(value: number): number {
  return Math.min(MERGE_PANE_MAX_PERCENT, Math.max(MERGE_PANE_MIN_PERCENT, value));
}

function createMutableChangedFileDirectory(name = "", pathValue = ""): MutableChangedFileDirectory {
  return {
    name,
    path: pathValue,
    directories: new Map(),
    files: [],
  };
}

function basenameFromPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? pathValue;
}

function mutableDirectoryToTree(directory: MutableChangedFileDirectory): ChangedFileTreeNode[] {
  const directoryNodes = [...directory.directories.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child): ChangedFileTreeNode => ({
      kind: "directory",
      name: child.name,
      path: child.path,
      children: mutableDirectoryToTree(child),
    }));
  const fileNodes = directory.files
    .sort((left, right) => basenameFromPath(left.path).localeCompare(basenameFromPath(right.path)))
    .map((file): ChangedFileTreeNode => ({
      kind: "file",
      name: basenameFromPath(file.path),
      path: file.path,
      file,
    }));
  return [...directoryNodes, ...fileNodes];
}

function buildChangedFileTree(files: ChangedFile[]): ChangedFileTreeNode[] {
  const root = createMutableChangedFileDirectory();
  for (const file of files) {
    const parts = file.path.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length <= 1) {
      root.files.push(file);
      continue;
    }

    let current = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index] as string;
      const childPath = current.path ? `${current.path}/${part}` : part;
      let child = current.directories.get(part);
      if (!child) {
        child = createMutableChangedFileDirectory(part, childPath);
        current.directories.set(part, child);
      }
      current = child;
    }
    current.files.push(file);
  }
  return mutableDirectoryToTree(root);
}

function summarizeMergeRunPaths(paths: string[]): string {
  if (paths.length === 0) {
    return "none";
  }
  const visiblePaths = paths.slice(0, 2);
  const suffix = paths.length > visiblePaths.length ? ` / +${paths.length - visiblePaths.length}` : "";
  return `${visiblePaths.join(", ")}${suffix}`;
}

function summarizeMergeRunChangedFiles(run: CompanionMergeRunSummary): string {
  if (run.changedFiles.length === 0) {
    return "none";
  }
  const visibleFiles = run.changedFiles.slice(0, 2).map((file) => `${file.kind}: ${file.path}`);
  const suffix = run.changedFiles.length > visibleFiles.length ? ` / +${run.changedFiles.length - visibleFiles.length}` : "";
  return `${visibleFiles.join(", ")}${suffix}`;
}

function summarizeMergeReadinessIssue(issue: CompanionMergeReadinessIssue): string {
  switch (issue.kind) {
    case "lifecycle":
      return "Session inactive";
    case "target-branch-drift":
      return "Sync Target required";
    case "target-branch-mismatch":
      return "Wrong branch";
    case "target-worktree-dirty":
      return "Target changed";
    case "merge-simulation":
      return "No files selected";
    default:
      return issue.message;
  }
}

function summarizeIssuePaths(paths: string[] | undefined): string | null {
  if (!paths || paths.length === 0) {
    return null;
  }
  if (paths.length === 1) {
    return paths[0];
  }
  return `${paths.length} files`;
}

type CompanionReviewAppProps = {
  viewMode?: CompanionSessionWindowView;
};

export default function CompanionReviewApp({ viewMode: forcedViewMode }: CompanionReviewAppProps = {}) {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const viewMode = forcedViewMode ?? getCompanionWindowViewFromSearch(window.location.search);
  const isMergeView = viewMode === "merge";
  const companionSessionId = useMemo(() => getCompanionSessionIdFromLocation(), []);
  const [snapshot, setSnapshot] = useState<CompanionReviewSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [operationMessage, setOperationMessage] = useState("");
  const [siblingWarnings, setSiblingWarnings] = useState<CompanionSiblingCheckWarning[]>([]);
  const [operationRunning, setOperationRunning] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [forceComposerBlockedFeedback, setForceComposerBlockedFeedback] = useState(false);
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [isAppSettingsLoaded, setIsAppSettingsLoaded] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ModelReasoningEffort>("high");
  const [selectedApprovalMode, setSelectedApprovalMode] = useState<ApprovalMode>("untrusted");
  const [selectedCodexSandboxMode, setSelectedCodexSandboxMode] = useState<CodexSandboxMode>("workspace-write");
  const [selectedCodexSpeed, setSelectedCodexSpeed] = useState<CodexSpeed>("standard");
  const [selectedCodexReviewer, setSelectedCodexReviewer] = useState<CodexReviewer>("user");
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const handleHeaderPreferenceChange = useCallback((value: "hidden" | "visible") => {
    if (!isMergeView) {
      void persistChatLayoutPreference(withmateApi, { target: "header", value });
    }
  }, [isMergeView, withmateApi]);
  const handleActionDockPreferenceChange = useCallback((value: "compact" | "expanded") => {
    if (!isMergeView) {
      void persistChatLayoutPreference(withmateApi, { target: "actionDock", value });
    }
  }, [isMergeView, withmateApi]);
  const handleLayoutPriorityPreferenceChange = useCallback((value: "side-pane-first" | "dock-first") => {
    if (!isMergeView) {
      void persistChatLayoutPreference(withmateApi, { target: "priority", value });
    }
  }, [isMergeView, withmateApi]);
  const {
    isHeaderExpanded,
    setIsHeaderExpanded,
    isActionDockPinnedExpanded,
    setIsActionDockPinnedExpanded,
    layoutPriority,
    setLayoutPriority,
  } = useChatLayoutPresentation({
    initialHeader: isMergeView
      ? "visible"
      : (isAppSettingsLoaded ? appSettings.chatLayoutPreference.header : null),
    initialActionDock: isAppSettingsLoaded ? appSettings.chatLayoutPreference.actionDock : null,
    initialPriority: isAppSettingsLoaded ? appSettings.chatLayoutPreference.priority : null,
    onHeaderChange: handleHeaderPreferenceChange,
    onActionDockChange: handleActionDockPreferenceChange,
    onPriorityChange: handleLayoutPriorityPreferenceChange,
  });
  const handleActivateSidePanePriority = useCallback(() => setLayoutPriority("side-pane-first"), [setLayoutPriority]);
  const handleActivateDockPriority = useCallback(() => setLayoutPriority("dock-first"), [setLayoutPriority]);
  const [mergeFileListPercent, setMergeFileListPercent] = useState(MERGE_FILE_LIST_DEFAULT_PERCENT);
  const [mergeStagePanePercent, setMergeStagePanePercent] = useState(MERGE_STAGE_DEFAULT_PERCENT);
  const [isMergePaneResizing, setIsMergePaneResizing] = useState(false);
  const [isMergeStagePaneResizing, setIsMergeStagePaneResizing] = useState(false);
  const [collapsedMergeTreeDirectories, setCollapsedMergeTreeDirectories] = useState<Set<string>>(() => new Set());
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [availableCustomAgents, setAvailableCustomAgents] = useState<DiscoveredCustomAgent[]>([]);
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [skillListError, setSkillListError] = useState<string | null>(null);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] = useState(false);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
  const [isComposerImeComposing, setIsComposerImeComposing] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
  const auxiliaryWorkspace = useAuxiliaryWorkspace({
    parentSessionId: snapshot?.session.id ?? null,
    api: withmateApi,
  });
  const isAuxiliaryTarget = auxiliaryWorkspace.target === "auxiliary";
  const isAuxiliaryDetailLoading = isAuxiliaryTarget && auxiliaryWorkspace.detailLoading;
  const activeAuxiliarySession = auxiliaryWorkspace.target === "auxiliary"
    ? auxiliaryWorkspace.selectedSession
    : null;
  const auxiliaryBinding = auxiliaryWorkspace.getBinding(auxiliaryWorkspace.selectedId);
  const setActiveAuxiliarySession = auxiliaryBinding.setSession;
  const [isAuxiliaryActionPending, setIsAuxiliaryActionPending] = useState(false);
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
  const [liveRunStates, setLiveRunStates] = useState<Record<string, OwnedLiveSessionRunState>>({});
  const [providerQuotaTelemetryState, setProviderQuotaTelemetryState] =
    useState<ProviderOwnedQuotaTelemetry>({ ownerProviderId: null, telemetry: null });
  const [sessionContextTelemetryState, setSessionContextTelemetryState] =
    useState<SessionOwnedContextTelemetry>({ ownerSessionId: null, telemetry: null });
  const [activeContextPaneTab, setActiveContextPaneTab] = useState<ContextPaneTabKey>("latest-command");
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeAuxiliarySessionRef = auxiliaryBinding.sessionRef;
  const auxiliarySessionMutationRevisionRef = auxiliaryBinding.mutationRevision;
  const auxiliaryDraftSaveQueueRef = auxiliaryBinding.draftSaveQueue;
  const auxiliarySessionSaveQueueRef = auxiliaryBinding.sessionSaveQueue;
  const mergeDiffLayoutRef = useRef<HTMLDivElement | null>(null);
  const mergeFileSelectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    const sessionId = companionSessionId;
    const withmateApi = getWithMateApi();

    if (!withmateApi || !sessionId) {
      setSnapshot(null);
      setErrorMessage("表示できる Companion がないよ。");
      return () => {
        active = false;
      };
    }

    const loadSnapshot = viewMode === "merge"
      ? withmateApi.getCompanionReviewSnapshot(sessionId)
      : withmateApi.getCompanionSession(sessionId).then((session) => session ? buildCompanionChatSnapshot(session) : null);

    void loadSnapshot
      .then((payload) => {
        if (!active) {
          return;
        }
        setSnapshot(payload);
        if (payload) {
          setSelectedModel(payload.session.model);
          setSelectedReasoningEffort(payload.session.reasoningEffort);
          setSelectedApprovalMode(payload.session.approvalMode);
          setSelectedCodexSandboxMode(payload.session.codexSandboxMode);
          setSelectedCodexSpeed(payload.session.codexSpeed);
          setSelectedCodexReviewer(payload.session.codexReviewer);
          setTitleDraft(payload.session.taskTitle);
          setPickerBaseDirectory(payload.session.worktreePath);
        }
        setSelectedPath(pickInitialFile(payload?.changedFiles ?? [])?.path ?? "");
        setSelectedPaths([]);
        setErrorMessage(payload ? "" : "対象 CompanionSession が見つからないよ。");
      })
      .catch((error) => {
        if (active) {
          setSnapshot(null);
          setErrorMessage(error instanceof Error ? error.message : "Companion の読み込みに失敗したよ。");
        }
      });

    return () => {
      active = false;
    };
  }, [companionSessionId, viewMode]);

  useEffect(() => {
    applyComposerDraftClearCommand({
      setDraft: setComposerText,
      setComposerCaret,
      nextCaret: 0,
    });
    setPickerBaseDirectory(snapshot?.session.worktreePath ?? "");
    setIsComposerImeComposing(false);
    setIsRetryDraftReplacePending(false);
  }, [snapshot?.session.id]);

  useEffect(() => {
    const withmateApi = getWithMateApi();

    return startCompanionSessionSummariesSubscription({
      api: withmateApi,
      applySummaries: setCompanionSessions,
    });
  }, []);

  useEffect(() => {
    if (!snapshot || isEditingTitle) {
      return;
    }

    setTitleDraft(snapshot.session.taskTitle);
  }, [isEditingTitle, snapshot?.session.taskTitle]);

  useEffect(() => {
    applySessionDocumentTitle(resolveCompanionDocumentTitle({
      mode: isMergeView ? "merge" : "chat",
      sessionTitle: snapshot?.session.taskTitle,
      sessionId: companionSessionId,
    }));
  }, [companionSessionId, isMergeView, snapshot?.session.taskTitle]);

  useEffect(() => {
    const withmateApi = getWithMateApi();
    return startModelCatalogSubscription({
      api: withmateApi,
      enabled: !isMergeView,
      subscribe: false,
      applyModelCatalog: setModelCatalog,
      onInitialLoadError: () => setModelCatalog(null),
    });
  }, [isMergeView]);

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

  const activeRunSessionId = auxiliaryWorkspace.target === "auxiliary"
    ? auxiliaryWorkspace.selectedId
    : snapshot?.session.id ?? null;
  const composerOwnerRef = useRef<string | null>(null);
  composerOwnerRef.current = activeRunSessionId;
  const setLiveRunState = useCallback((update: SetStateAction<OwnedLiveSessionRunState>) => {
    if (!activeRunSessionId) return;
    setLiveRunStates((current) => ({
      ...current,
      [activeRunSessionId]: typeof update === "function"
        ? update(current[activeRunSessionId] ?? { ownerSessionId: activeRunSessionId, state: null })
        : update,
    }));
  }, [activeRunSessionId]);
  const displayedSession = useCompanionAuxiliaryRuntimeSession(
    snapshot?.session ?? null,
    activeAuxiliarySession,
  );
  const selectedAuxiliaryRuntimeSession = useCompanionAuxiliaryRuntimeSession(
    snapshot?.session ?? null,
    auxiliaryWorkspace.selectedSession,
  );
  const auxiliaryDisplayedSession = auxiliaryWorkspace.selectedSession ? selectedAuxiliaryRuntimeSession : null;
  const isAuxiliaryMode = isAuxiliaryTarget && !!activeAuxiliarySession;
  const activeComposerText = auxiliaryWorkspace.target === "auxiliary"
    ? activeAuxiliarySession?.composerDraft ?? ""
    : composerText;
  const composerState = useConversationComposerState(activeRunSessionId, activeComposerText);
  const composerPreview = composerState.preview;
  const setComposerPreview = composerState.setPreview;
  const composerCaret = composerState.selection.start;
  const setComposerCaret = useCallback((caret: SetStateAction<number>) => {
    composerState.setSelection((current) => {
      const next = typeof caret === "function" ? caret(current.start) : caret;
      return { start: next, end: next };
    });
  }, [composerState]);
  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(composerState.selection.start, composerState.selection.end);
    setIsComposerImeComposing(false);
  }, [activeRunSessionId]);
  const selectedSessionLiveRun =
    activeRunSessionId !== null ? liveRunStates[activeRunSessionId]?.state ?? null : null;
  const liveRunAssistantText = selectedSessionLiveRun?.assistantText ?? "";
  useEffect(() => {
    if (!withmateApi || !activeRunSessionId || isMergeView) {
      return;
    }
    return startLiveSessionRunSubscription({
      sessionId: activeRunSessionId,
      api: withmateApi,
      applyLiveRunState: setLiveRunState,
    });
  }, [activeRunSessionId, isMergeView, setLiveRunState, withmateApi]);

  useEffect(() => {
    if (!isMergePaneResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const layout = mergeDiffLayoutRef.current;
      if (!layout) {
        return;
      }
      const bounds = layout.getBoundingClientRect();
      if (bounds.width <= 0) {
        return;
      }
      const nextPercent = ((event.clientX - bounds.left) / bounds.width) * 100;
      setMergeFileListPercent(clampMergePanePercent(nextPercent));
    };
    const handlePointerUp = () => {
      setIsMergePaneResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isMergePaneResizing]);

  useEffect(() => {
    if (!snapshot || (!errorMessage && !operationMessage)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setErrorMessage("");
      setOperationMessage("");
    }, errorMessage ? 8000 : 4200);
    return () => window.clearTimeout(timeoutId);
  }, [errorMessage, operationMessage, snapshot?.session.id]);

  useEffect(() => {
    if (!isMergeStagePaneResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const layout = mergeFileSelectionRef.current;
      if (!layout) {
        return;
      }
      const bounds = layout.getBoundingClientRect();
      if (bounds.height <= 0) {
        return;
      }
      const nextPercent = ((event.clientY - bounds.top) / bounds.height) * 100;
      setMergeStagePanePercent(clampMergePanePercent(nextPercent));
    };
    const handlePointerUp = () => {
      setIsMergeStagePaneResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isMergeStagePaneResizing]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const skillDiscoveryRequest = resolveSkillDiscoveryRequest({
      parentProviderId: snapshot?.session.provider,
      parentWorkspacePath: snapshot?.session.worktreePath,
      auxiliaryProviderId: activeAuxiliarySession?.provider,
    });
    if (!withmateApi || !skillDiscoveryRequest || isMergeView) {
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
    isMergeView,
    snapshot?.session.provider,
    snapshot?.session.worktreePath,
  ]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const session = displayedSession;
    if (!withmateApi || !session || session.provider !== "copilot" || isMergeView) {
      setAvailableCustomAgents([]);
      setIsCustomAgentListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsCustomAgentListLoading(true);
    void withmateApi.listWorkspaceCustomAgents(session.provider, session.worktreePath).then((agents) => {
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
  }, [displayedSession, isMergeView]);

  useEffect(() => {
    const withmateApi = getWithMateApi();
    const providerId = displayedSession?.provider ?? null;

    return startProviderQuotaTelemetrySubscription({
      api: withmateApi,
      providerId,
      enabled: !isMergeView,
      applyProviderQuotaTelemetry: setProviderQuotaTelemetryState,
    });
  }, [displayedSession?.provider, isMergeView]);

  useEffect(() => {
    const withmateApi = getWithMateApi();
    const sessionId = activeRunSessionId;

    return startSessionContextTelemetrySubscription({
      api: withmateApi,
      sessionId,
      enabled: !isMergeView,
      applySessionContextTelemetry: setSessionContextTelemetryState,
    });
  }, [activeRunSessionId, isMergeView]);

  const themeStyle = useMemo(
    () => (snapshot ? buildCharacterThemeStyle(snapshot.session.characterThemeColors) : undefined),
    [snapshot],
  );
  const selectedDiffThemeStyle = useMemo(
    () => (selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : {}),
    [selectedDiff],
  );
  const selectedFile = useMemo(
    () => snapshot?.changedFiles.find((file) => file.path === selectedPath) ?? pickInitialFile(snapshot?.changedFiles ?? []),
    [selectedPath, snapshot],
  );
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const unstagedChangedFiles = useMemo(
    () => snapshot?.changedFiles.filter((file) => !selectedPathSet.has(file.path)) ?? [],
    [selectedPathSet, snapshot?.changedFiles],
  );
  const stagedChangedFiles = useMemo(
    () => snapshot?.changedFiles.filter((file) => selectedPathSet.has(file.path)) ?? [],
    [selectedPathSet, snapshot?.changedFiles],
  );
  const unstagedFileTree = useMemo(() => buildChangedFileTree(unstagedChangedFiles), [unstagedChangedFiles]);
  const stagedFileTree = useMemo(() => buildChangedFileTree(stagedChangedFiles), [stagedChangedFiles]);
  useEffect(() => {
    setApprovalActionRequestId(null);
  }, [selectedSessionLiveRun?.approvalRequest?.requestId]);
  useEffect(() => {
    setElicitationActionRequestId(null);
  }, [selectedSessionLiveRun?.elicitationRequest?.requestId]);
  const companionAuditLogApi = useMemo(() => withmateApi ? ({
    listSessionAuditLogSummaryPage: withmateApi.listCompanionAuditLogSummaryPage,
    getSessionAuditLogDetailSection: withmateApi.getCompanionAuditLogDetailSection,
    getSessionAuditLogOperationDetail: withmateApi.getCompanionAuditLogOperationDetail,
  }) : null, [withmateApi]);
  const {
    session: auditLogSession,
    ownerSessionId: auditLogOwnerSessionId,
    sourceLabel: auditLogSourceLabel,
  } = resolveAuditLogOwner({
    parentSession: snapshot?.session ?? null,
    displayedSession,
    parentSourceLabel: "Companion",
  });
  const auditLogApi = isAuxiliaryMode ? withmateApi : companionAuditLogApi;
  const {
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogDetails,
    auditLogOperationDetails,
    persistedEntries: companionSessionAuditLogs,
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
    auditLogApi,
    selectedSession: auditLogSession,
    ownerSessionId: auditLogOwnerSessionId,
    cacheScopeKey: isAuxiliaryMode ? "session-auxiliary" : "companion",
    liveRun: selectedSessionLiveRun,
    enabled: !isMergeView,
  });
  useEffect(() => {
    if (isAuxiliaryMode) {
      setAuditLogsOpen(false);
    }
  }, [isAuxiliaryMode, setAuditLogsOpen]);
  const selectedSessionRunState = activeAuxiliarySession
    ? activeAuxiliarySession.runState
    : resolveSelectedSessionRunState({
      runState: snapshot?.session.runState,
      isTurnRunning: turnRunning,
      hasLiveRun: !!selectedSessionLiveRun,
    });
  const isSelectedSessionRunning = resolveSelectedSessionIsRunning({
    runState: selectedSessionRunState,
    isTurnRunning: turnRunning,
  });
  const lastUserMessage = useMemo(
    () => displayedSession ? [...displayedSession.messages].reverse().find((message) => message.role === "user") ?? null : null,
    [displayedSession],
  );
  const lastAssistantMessage = useMemo(
    () =>
      displayedSession
        ? [...displayedSession.messages].reverse().find((message) => message.role === "assistant") ?? null
        : null,
    [displayedSession],
  );
  const latestTerminalAuditLog = useMemo(
    () => companionSessionAuditLogs.find((entry) => isTerminalAuditLogPhase(entry.phase)) ?? null,
    [companionSessionAuditLogs],
  );
  const handleSidePaneChange = useCallback((sidePane: SessionSidePane) => {
    void persistChatLayoutPreference(withmateApi, { target: "sidePane", value: sidePane });
  }, [withmateApi]);
  const {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailVisible,
    isContextRailResizing,
    handleStartContextRailResize,
    handleToggleContextRailVisibility,
    handleKeyDownContextRailResize,
  } = useSessionSidePanes({
    ownerKey: snapshot?.session.id ?? null,
    enabled: !isMergeView,
    filesPaneEnabled: false,
    initialSidePane: isAppSettingsLoaded ? appSettings.chatLayoutPreference.sidePane : null,
    onSidePaneChange: handleSidePaneChange,
  });
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const isMessageListFollowing = true;
  const handleMessageListScroll = useCallback(() => {}, []);
  const followMessageListLatest = useCallback(() => {}, []);
  const operationDisabled = operationRunning || isSelectedSessionRunning || !snapshot || snapshot.session.status !== "active";
  const targetStashBlocked = Boolean(snapshot?.targetStash);
  const mergeBlocked = (snapshot?.mergeReadiness.blockers.length ?? 0) > 0 || targetStashBlocked;
  const targetBranchDriftBlocked =
    snapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-branch-drift") ?? false;
  const targetWorkspaceDirtyBlocked =
    snapshot?.mergeReadiness.blockers.some((blocker) => blocker.kind === "target-worktree-dirty") ?? false;
  const visibleMergeBlockers =
    snapshot?.mergeReadiness.blockers.filter((blocker) => blocker.kind !== "target-branch-drift") ?? [];
  const visibleMergeWarnings =
    snapshot?.mergeReadiness.warnings.filter((warning) => warning.kind !== "merge-simulation") ?? [];
  const runDisabled = true;
  const selectedProviderCatalog = getProviderCatalog(modelCatalog?.providers ?? [], displayedSession?.provider);
  const selectedRuntimeModel = activeAuxiliarySession?.model ?? selectedModel;
  const selectedRuntimeReasoningEffort = activeAuxiliarySession?.reasoningEffort ?? selectedReasoningEffort;
  const selectedRuntimeApprovalMode = activeAuxiliarySession?.approvalMode ?? selectedApprovalMode;
  const selectedRuntimeCodexSandboxMode = activeAuxiliarySession?.codexSandboxMode ?? selectedCodexSandboxMode;
  const selectedRuntimeCodexSpeed = activeAuxiliarySession?.codexSpeed ?? selectedCodexSpeed;
  const selectedRuntimeCodexReviewer = activeAuxiliarySession?.codexReviewer ?? selectedCodexReviewer;
  const selectedModelEntry =
    selectedProviderCatalog?.models.find((model) => model.id === selectedRuntimeModel) ??
    selectedProviderCatalog?.models.find((model) => model.id === selectedProviderCatalog.defaultModelId) ??
    selectedProviderCatalog?.models[0] ??
    null;
  const reasoningEffortOptions = selectedModelEntry?.reasoningEfforts ?? [];
  const {
    approvalChoiceOptions: approvalSelectOptions,
    sandboxChoiceOptions: sandboxSelectOptions,
    modelSelectOptions,
    selectedModelFallbackLabel,
    reasoningSelectOptions,
    speedSelectOptions,
    reviewerSelectOptions,
  } = useMemo(
    () => buildRuntimeSelectionOptions({
      providerId: displayedSession?.provider,
      providerCatalog: selectedProviderCatalog,
      models: selectedProviderCatalog?.models ?? [],
      selectedModel: selectedRuntimeModel,
      reasoningEfforts: reasoningEffortOptions,
      selectedApprovalMode: selectedRuntimeApprovalMode,
      selectedCodexSandboxMode: selectedRuntimeCodexSandboxMode,
      selectedCodexSpeed: selectedRuntimeCodexSpeed,
      selectedCodexReviewer: selectedRuntimeCodexReviewer,
    }),
    [
      displayedSession?.provider,
      selectedRuntimeModel,
      selectedProviderCatalog,
      reasoningEffortOptions,
      selectedRuntimeApprovalMode,
      selectedRuntimeCodexSandboxMode,
      selectedRuntimeCodexSpeed,
      selectedRuntimeCodexReviewer,
    ],
  );
  const companionComposerBlockedReason = isAuxiliaryDetailLoading
    ? "Auxiliary Session を読み込み中だよ。"
    : (auxiliaryWorkspace.error || auxiliaryWorkspace.detailError) && isAuxiliaryTarget
      ? `Auxiliary Session の読み込みに失敗したよ: ${(auxiliaryWorkspace.detailError ?? auxiliaryWorkspace.error)?.message}`
      : COMPANION_PROVIDER_EXECUTION_RETIRED_MESSAGE;
  const retryBanner = useMemo<RetryBannerState | null>(() => {
    if (!snapshot || !shouldShowRetryBanner({
      hasActiveAuxiliarySession: !!activeAuxiliarySession,
      hasLastUserMessage: !!lastUserMessage,
      isReadOnly: snapshot.session.status !== "active",
      runState: selectedSessionRunState,
    })) {
      return null;
    }

    const retryLastUserMessage = lastUserMessage;
    if (!retryLastUserMessage) {
      return null;
    }

    const kind = resolveRetryBannerKind({
      runState: selectedSessionRunState,
      latestTerminalAuditLogPhase: latestTerminalAuditLog?.phase,
    });
    if (!kind) {
      return null;
    }

    switch (kind) {
      case "interrupted":
        return {
          kind,
          badge: "中断",
          title: "前回の依頼は中断されたままです",
          lastRequestText: retryLastUserMessage.text,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: "前回の依頼は完了できませんでした",
          lastRequestText: retryLastUserMessage.text,
        };
      case "canceled":
        return {
          kind,
          badge: "停止",
          title: "この依頼は途中で停止しました",
          lastRequestText: retryLastUserMessage.text,
        };
      default:
        return null;
    }
  }, [
    activeAuxiliarySession,
    lastAssistantMessage,
    lastUserMessage,
    latestTerminalAuditLog,
    selectedSessionLiveRun,
    selectedSessionRunState,
    snapshot,
  ]);
  const shouldProtectDraftOnRetryEdit = shouldProtectRetryEditDraft({ retryBanner, draft: composerText });
  const isRetryActionDisabled = resolveRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: !!lastUserMessage,
    composerBlocked: !!companionComposerBlockedReason || operationRunning || turnRunning,
    isReadOnly: snapshot?.session.status !== "active",
    runState: selectedSessionRunState,
  });
  const isRetryEditDisabled = isRetryActionDisabled || runDisabled;
  const companionComposerSendability = useMemo(
    () =>
      resolveComposerSendabilityState({
        runState: selectedSessionRunState,
        blockedReason: companionComposerBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: activeComposerText,
        forceBlockedFeedback: forceComposerBlockedFeedback,
      }),
    [
      activeComposerText,
      companionComposerBlockedReason,
      composerPreview.errors,
      forceComposerBlockedFeedback,
      selectedSessionRunState,
    ],
  );
  const isCompanionSendDisabled = companionComposerSendability.isSendDisabled || operationRunning || isAuxiliaryActionPending;
  const companionSendButtonTitle = getComposerSendButtonTitle(companionComposerSendability);
  const actionDockRuntimeState = buildActionDockRuntimeState({
    isActionDockPinnedExpanded,
    forceReasons: [
      isAgentPickerOpen,
      isSkillPickerOpen,
      isAdditionalDirectoryListOpen,
      isRetryDraftReplacePending,
    ],
  });
  const {
    isActionDockExpanded,
    canCollapseActionDock,
  } = actionDockRuntimeState;
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
    ownerKey: snapshot?.session.id ?? null,
    isHeaderExpanded: isSessionHeaderExpanded,
    isActionDockExpanded,
  });
  useEffect(() => {
    if (!composerText.trim() || !retryBanner) {
      setIsRetryDraftReplacePending(false);
    }
  }, [composerText, retryBanner]);
  const companionCharacterProfile = useCompanionCharacterProfile(displayedSession ?? snapshot?.session ?? null);
  const selectedCustomAgent = useMemo(() => {
    if (!displayedSession?.customAgentName.trim()) {
      return null;
    }

    return availableCustomAgents.find((agent) => agent.name === displayedSession.customAgentName) ?? null;
  }, [availableCustomAgents, displayedSession]);
  const selectedCustomAgentDisplay = useMemo(
    () => buildSelectedCustomAgentDisplay(displayedSession, selectedCustomAgent),
    [displayedSession, selectedCustomAgent],
  );
  const customAgentItems = useMemo(
    () => [
      {
        key: "default",
        value: null,
        primaryLabel: "Default Agent",
        secondaryLabel: "Copilot 標準 agent",
        title: "Copilot の標準 agent を使う",
        isSelected: !displayedSession?.customAgentName.trim(),
      },
      ...availableCustomAgents.map((agent) => {
        const agentDisplay = buildCustomAgentMatchDisplay(agent);
        return {
          key: agent.id,
          value: agent.name,
          primaryLabel: agentDisplay.primaryLabel,
          secondaryLabel: agentDisplay.secondaryLabel,
          title: agentDisplay.title,
          isSelected: displayedSession?.customAgentName === agent.name,
        };
      }),
    ],
    [availableCustomAgents, displayedSession],
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
  const additionalDirectoryItems = useMemo(
    () =>
      buildAdditionalDirectoryItems(
        displayedSession?.allowedAdditionalDirectories ?? [],
        displayedSession?.provider === "codex",
      ),
    [displayedSession],
  );
  const composerAttachmentItems = useMemo(
    () =>
      buildComposerAttachmentItems(composerPreview.attachments, { trimRemoveTargets: false }),
    [composerPreview.attachments],
  );
  const selectedProviderQuotaTelemetry =
    resolveOwnedProviderQuotaTelemetry(providerQuotaTelemetryState, displayedSession?.provider);
  const selectedSessionContextTelemetry =
    resolveOwnedSessionContextTelemetry(sessionContextTelemetryState, displayedSession?.id);
  const isCopilotSession = displayedSession?.provider === "copilot";
  const selectedCopilotQuotaProjection = buildCopilotQuotaProjection(selectedProviderQuotaTelemetry);
  const selectedSessionContextTelemetryProjection =
    buildSessionContextTelemetryProjection(selectedSessionContextTelemetry);
  const latestCommandProjection = buildLatestCommandProjection({
    liveSteps: selectedSessionLiveRun?.steps ?? [],
    auditOperations: latestTerminalAuditLog?.operations ?? [],
    latestTerminalAuditPhase: latestTerminalAuditLog?.phase,
    auditFallbackEnabled: !activeAuxiliarySession,
  });
  const latestLiveCommandStep = latestCommandProjection.latestLiveCommandStep;
  const latestCommandView = latestCommandProjection.latestCommandView;
  const orderedLiveRunSteps = useMemo(
    () => (selectedSessionLiveRun?.steps ?? [])
      .map((step, index) => ({ step, index }))
      .sort((left, right) => left.index - right.index)
      .map(({ step }) => step),
    [selectedSessionLiveRun?.steps],
  );
  const runningDetailsEntries = buildRunningDetailsEntries({
    liveSteps: orderedLiveRunSteps,
    latestLiveCommandStepId: latestLiveCommandStep?.id ?? null,
  });
  const selectedBackgroundTasks = useMemo(
    () => selectedSessionLiveRun?.backgroundTasks ?? [],
    [selectedSessionLiveRun?.backgroundTasks],
  );
  const liveRunReasoningText = selectedSessionLiveRun?.reasoningText ?? "";
  const hasLiveRunReasoningText = liveRunReasoningText.trim().length > 0;
  const hasReasoningCapability =
    reasoningEffortOptions.length > 0 || Boolean(snapshot?.session.reasoningEffort);
  const companionGroupMonitorEntries = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    const sessionById = new Map(companionSessions.map((session) => [session.id, session]));
    sessionById.set(snapshot.session.id, createCompanionSessionSummary(snapshot.session));
    return buildCompanionGroupMonitorEntries([...sessionById.values()], [snapshot.session.id]);
  }, [companionSessions, snapshot]);
  const contextPaneProjection = buildContextPaneProjection({
    activeContextPaneTab,
    latestCommandView,
    backgroundTasks: selectedBackgroundTasks,
    companionGroupMonitorEntries,
    hasReasoningText: hasLiveRunReasoningText,
    isSelectedSessionRunning,
  });
  const availableContextPaneTabs = useMemo(
    () => resolveAvailableContextPaneTabs({
      isCopilotSession,
      hasCompanionGroupMonitor: companionGroupMonitorEntries.length > 0,
      hasReasoningCapability,
      hasReasoningText: hasLiveRunReasoningText,
    }),
    [hasLiveRunReasoningText, hasReasoningCapability, isCopilotSession, companionGroupMonitorEntries.length],
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

  const toggleArtifact = createExpandedArtifactToggleHandler({
    setExpandedArtifacts,
  });

  async function openDiffWindow(payload: DiffPreviewPayload): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    await withmateApi.openDiffWindow(payload);
  }

  const handleCopyMessageText = createCopyMessageTextHandler({
    writeText: (normalized) => navigator.clipboard.writeText(normalized),
    onFailure: (error) => {
      console.error(error);
      setErrorMessage("コピーに失敗したよ。");
    },
  });

  const handleQuoteMessageText = createQuoteMessageTextHandler({
    isBlocked: () => runDisabled,
    notifyBlocked: () => {
      setForceComposerBlockedFeedback(true);
      composerTextareaRef.current?.focus();
    },
    getComposerState: () => ({
      draft: activeComposerText,
      fallbackCaret: composerCaret,
      textarea: composerTextareaRef.current,
    }),
    applyInsertion: ({ draft: nextDraft, caret: nextCaret }) => {
      if (activeAuxiliarySession) {
        setComposerCaret(nextCaret);
        void handleAuxiliaryDraftChange(nextDraft, nextCaret);
        return;
      }

      applyComposerDraftChangeCommand({
        value: nextDraft,
        selectionStart: nextCaret,
        setDraft: setComposerText,
        setComposerCaret,
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  function insertReferencePaths(selectedPaths: string[]): void {
    const textarea = composerTextareaRef.current;
    applySelectedPathReferenceInsertionCommand({
      draft: activeComposerText,
      fallbackCaret: composerCaret,
      selectedPaths,
      textarea,
      workspacePath: snapshot?.session.worktreePath ?? null,
      applyInsertion: (insertionState) => {
        const { draft: nextDraft, caret: nextCaret } = insertionState;
        if (activeAuxiliarySession) {
          setComposerCaret(nextCaret);
          void handleAuxiliaryDraftChange(nextDraft, nextCaret);
        } else {
          applyComposerDraftChangeCommand({
            value: nextDraft,
            selectionStart: nextCaret,
            setDraft: setComposerText,
            setComposerCaret,
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  }

  function insertReferencePath(selectedPath: string): void {
    insertReferencePaths([selectedPath]);
  }

  function insertPastedAttachments(references: ComposerReferenceInput[]): void {
    const textarea = composerTextareaRef.current;
    applyComposerReferenceInsertionCommand({
      draft: activeComposerText,
      fallbackCaret: composerCaret,
      references,
      textarea,
      applyInsertion: ({ draft: nextDraft, caret: nextCaret }) => {
        if (activeAuxiliarySession) {
          setComposerCaret(nextCaret);
          void handleAuxiliaryDraftChange(nextDraft, nextCaret);
        } else {
          applyComposerDraftChangeCommand({
            value: nextDraft,
            selectionStart: nextCaret,
            setDraft: setComposerText,
            setComposerCaret,
          });
        }
      },
      restoreComposerTextareaFocusAndCaret,
    });
  }

  async function pickAndInsertPath(kind: ComposerPathPickerKind): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }
    const basePath = pickerBaseDirectory || snapshot.session.worktreePath || snapshot.session.repoRoot;
    const selectedPath = await pickComposerReferencePath(kind, basePath, withmateApi);
    applyPickedComposerReferencePathCommand({
      kind,
      selectedPath,
      setPickerBaseDirectory,
      insertReferencePath: (path) => insertReferencePath(path),
    });
  }

  async function addToSessionFiles(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }

    const basePath = pickerBaseDirectory || snapshot.session.worktreePath || snapshot.session.repoRoot;
    const selectedPaths = await withmateApi.pickFiles(basePath);
    if (selectedPaths.length === 0) {
      return;
    }

    const savedPaths = await withmateApi.copyFilesToSessionFiles(snapshot.session.id, selectedPaths);
    if (savedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: savedPaths,
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  }

  async function pickSessionFiles(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }

    const selectedPaths = await withmateApi.pickSessionFiles(snapshot.session.id);
    if (selectedPaths.length === 0) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths,
      referencePaths: selectedPaths,
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  }

  async function pickSessionFolder(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }

    const selectedPath = await withmateApi.pickSessionFolder(snapshot.session.id);
    if (!selectedPath) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths: [selectedPath],
      referencePaths: [selectedPath],
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  }

  async function pickSessionImage(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }

    const selectedPath = await withmateApi.pickSessionImageFile(snapshot.session.id);
    if (!selectedPath) {
      return;
    }

    applySessionFilesReferencePathsCommand({
      selectedPaths: [selectedPath],
      referencePaths: [selectedPath],
      setPickerBaseDirectory,
      insertReferencePaths,
    });
  }

  const handleComposerPaste = createPastedSessionAttachmentHandler({
    alertError: (message) => window.alert(message),
    canPaste: () => !!getWithMateApi() && !!snapshot && !runDisabled,
    currentTimestampLabel,
    fallbackErrorMessage: "貼り付けたファイルの保存に失敗したよ。",
    getSavePastedSessionFile: () => {
      const withmateApi = getWithMateApi();
      return withmateApi ? (request) => withmateApi.savePastedSessionFile(request) : null;
    },
    getSessionId: () => snapshot?.session.id,
    insertAttachments: insertPastedAttachments,
  });

  async function handleAddAdditionalDirectory(): Promise<void> {
    await runPickedAdditionalDirectoryOperation({
      canPickDirectory: () => !!getWithMateApi() && !!snapshot && !isSelectedSessionRunning,
      getPickerBaseDirectory: () => (
        resolveAdditionalDirectoryPickerBase(
          pickerBaseDirectory,
          snapshot?.session.worktreePath,
          snapshot?.session.repoRoot,
        )
      ),
      pickDirectory: (baseDirectory) => getWithMateApi()?.pickDirectory(baseDirectory) ?? Promise.resolve(null),
      applyPickedDirectory: async (selectedPath) => {
        if (!snapshot) {
          return;
        }
        const nextSession = buildSessionWithAddedAdditionalDirectory(snapshot.session, selectedPath);
        await persistCompanionSession({
          ...nextSession,
          updatedAt: currentTimestampLabel(),
        });
        applyPickedAdditionalDirectoryUiStateCommand({
          selectedPath,
          setPickerBaseDirectory,
        });
      },
    });
  }

  async function handleRemoveAdditionalDirectory(directoryPath: string): Promise<void> {
    await runAdditionalDirectoryRemovalOperation({
      directoryPath,
      canRemoveDirectory: () => !!snapshot && snapshot.session.provider === "codex" && !isSelectedSessionRunning,
      removeDirectory: async (targetPath) => {
        if (!snapshot) {
          return false;
        }
        const nextSession = buildSessionWithRemovedAdditionalDirectory(snapshot.session, targetPath);
        if (!nextSession) {
          return false;
        }

        await persistCompanionSession({
          ...nextSession,
          updatedAt: currentTimestampLabel(),
        });
        return true;
      },
    });
  }

  const handleRemoveAttachmentReference = createPathReferenceRemovalHandler({
    getDraft: () => activeComposerText,
    applyRemoval: (nextState) => {
      const { draft: nextDraft, caret: nextCaret } = nextState;
      if (activeAuxiliarySession) {
        setComposerCaret(nextCaret);
        void handleAuxiliaryDraftChange(nextDraft, nextCaret);
      } else {
        applyComposerDraftChangeCommand({
          value: nextDraft,
          selectionStart: nextCaret,
          setDraft: setComposerText,
          setComposerCaret,
        });
      }
    },
  });

  const handleSelectSkill = createSkillPromptInsertionHandler<DiscoveredSkill>({
    getProvider: () => snapshot?.session.provider,
    getDraft: () => composerText,
    getTextarea: () => composerTextareaRef.current,
    setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
    setCaret: setComposerCaret,
    setSkillPickerOpen: setIsSkillPickerOpen,
    applyDraft: (nextDraft) => {
      applyComposerDraftChangeCommand({
        value: nextDraft,
        setDraft: setComposerText,
      });
    },
    restoreComposerTextareaFocusAndCaret,
  });

  const closeAgentPicker = createAgentPickerCloseHandler({
    setAgentPickerOpen: setIsAgentPickerOpen,
  });

  async function handleSelectCustomAgent(agent: DiscoveredCustomAgent | null): Promise<void> {
    if (!snapshot || snapshot.session.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === snapshot.session.customAgentName) {
      closeAgentPicker();
      return;
    }

    await persistCompanionSession({
      ...snapshot.session,
      customAgentName: nextCustomAgentName,
      updatedAt: currentTimestampLabel(),
    });
    closeAgentPicker();
  }

  async function handleChangeApproval(approvalMode: ApprovalMode): Promise<void> {
    if (!snapshot || isSelectedSessionRunning) {
      return;
    }

    const nextSession = buildSessionWithApprovalMode(
      snapshot.session,
      approvalMode,
      currentTimestampLabel(),
    );
    if (!nextSession) {
      return;
    }

    await persistCompanionSession(nextSession);
  }

  async function handleChangeCodexSandboxMode(codexSandboxMode: CodexSandboxMode): Promise<void> {
    if (
      !snapshot ||
      snapshot.session.provider !== "codex" ||
      isSelectedSessionRunning
    ) {
      return;
    }

    const nextSession = buildSessionWithCodexSandboxMode(
      snapshot.session,
      codexSandboxMode,
      currentTimestampLabel(),
    );
    if (!nextSession) {
      return;
    }

    await persistCompanionSession(nextSession);
  }

  async function handleChangeCodexSpeed(codexSpeed: CodexSpeed): Promise<void> {
    if (!snapshot || snapshot.session.provider !== "codex" || isSelectedSessionRunning) {
      return;
    }

    const nextSession = buildSessionWithCodexSpeed(snapshot.session, codexSpeed, currentTimestampLabel());
    if (nextSession) {
      await persistCompanionSession(nextSession);
    }
  }

  async function handleChangeCodexReviewer(codexReviewer: CodexReviewer): Promise<void> {
    if (
      !snapshot ||
      snapshot.session.provider !== "codex" ||
      snapshot.session.approvalMode === "never" ||
      isSelectedSessionRunning
    ) {
      return;
    }

    const nextSession = buildSessionWithCodexReviewer(snapshot.session, codexReviewer, currentTimestampLabel());
    if (nextSession) {
      await persistCompanionSession(nextSession);
    }
  }

  async function handleChangeSelectedModel(model: string): Promise<void> {
    if (!snapshot || !selectedProviderCatalog || !modelCatalog || isSelectedSessionRunning) {
      return;
    }

    const nextSession = buildSessionWithModelChange(
      snapshot.session,
      selectedProviderCatalog,
      model,
      modelCatalog.revision,
      currentTimestampLabel(),
    );
    await persistCompanionSession(nextSession);
  }

  async function handleChangeReasoningEffort(reasoningEffort: ModelReasoningEffort): Promise<void> {
    if (!snapshot || !selectedProviderCatalog || !modelCatalog || isSelectedSessionRunning) {
      return;
    }

    const nextSession = buildSessionWithReasoningEffort(
      snapshot.session,
      selectedProviderCatalog,
      reasoningEffort,
      modelCatalog.revision,
      currentTimestampLabel(),
    );
    await persistCompanionSession(nextSession);
  }

  async function persistCompanionSession(nextSession: CompanionSession): Promise<CompanionSession> {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      throw new Error("Companion Window は Electron から開いてね。");
    }

    const savedSession = await withmateApi.updateCompanionSession(nextSession);
    setSnapshot((current) => current ? { ...current, session: savedSession } : current);
    setSelectedModel(savedSession.model);
    setSelectedReasoningEffort(savedSession.reasoningEffort);
    setSelectedApprovalMode(savedSession.approvalMode);
    setSelectedCodexSandboxMode(savedSession.codexSandboxMode);
    setSelectedCodexSpeed(savedSession.codexSpeed);
    setSelectedCodexReviewer(savedSession.codexReviewer);
    return savedSession;
  }

  async function updateActiveAuxiliarySession(recipe: (current: AuxiliarySession) => AuxiliarySession): Promise<void> {
    await createGuardedActiveAuxiliarySessionUpdater({
      activeSession: activeAuxiliarySession,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      getApi: () => getWithMateApi(),
      activeSessionRef: activeAuxiliarySessionRef,
      setActiveSession: setActiveAuxiliarySession,
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
    })(recipe);
  }


  async function handleAuxiliaryDraftChange(value: string, selectionStart: number): Promise<void> {
    const withmateApi = getWithMateApi();
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
      compareStatus: true,
      onError: (error) => {
        console.error(error);
      },
    });
  }

  async function sendAuxiliaryMessage(messageText: string): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || !activeAuxiliarySession) {
      setForceComposerBlockedFeedback(true);
      return;
    }

    const result = await runAuxiliarySessionSendOperationWithApi({
      activeSession: activeAuxiliarySession,
      messageText,
      parentMessageCount: snapshot.session.messages.length,
      updatedAt: currentTimestampLabel(),
      draftSaveQueue: auxiliaryDraftSaveQueueRef,
      sessionSaveQueue: auxiliarySessionSaveQueueRef,
      mutationRevision: auxiliarySessionMutationRevisionRef,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      applyRunningSession: createAuxiliarySessionRunningApplier({
        activeSessionRef: activeAuxiliarySessionRef,
        setActiveSession: setActiveAuxiliarySession,
        updateLiveRunState: (update) => setLiveRunState(update),
        buildRuntimeSession: (runningSession) => buildCompanionAuxiliaryRuntimeSession(
          snapshot.session,
          runningSession,
        ),
      }),
      afterRunningSessionApplied: () => {
        setForceComposerBlockedFeedback(false);
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
      onBlocked: () => {
        setForceComposerBlockedFeedback(true);
      },
      onError: (error) => {
        console.error(error);
        setErrorMessage(resolveSessionRunErrorMessage(error, "Auxiliary Session の実行に失敗したよ。"));
      },
    });
  }

  async function cancelAuxiliaryRun(): Promise<void> {
    const withmateApi = getWithMateApi();
    await runRunningSessionCancelOperation({
      target: buildAuxiliarySessionCancelTarget({ session: activeAuxiliarySession }),
      cancelRun: withmateApi ? (sessionId) => withmateApi.cancelAuxiliarySessionRun(sessionId) : null,
    });
  }

  async function handleChangeAuxiliaryApproval(approvalMode: ApprovalMode): Promise<void> {
    await runAuxiliaryApprovalModeChangeOperation({
      approvalMode,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  async function handleChangeAuxiliarySandboxMode(codexSandboxMode: CodexSandboxMode): Promise<void> {
    await runAuxiliarySandboxModeChangeOperation({
      codexSandboxMode,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  async function handleChangeAuxiliaryCodexSpeed(codexSpeed: CodexSpeed): Promise<void> {
    await runAuxiliaryCodexSpeedChangeOperation({
      codexSpeed,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  async function handleChangeAuxiliaryCodexReviewer(codexReviewer: CodexReviewer): Promise<void> {
    if (activeAuxiliarySession?.approvalMode === "never") {
      return;
    }
    await runAuxiliaryCodexReviewerChangeOperation({
      codexReviewer,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  async function handleChangeAuxiliaryModel(model: string): Promise<void> {
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
  }

  async function handleChangeAuxiliaryReasoningEffort(reasoningEffort: ModelReasoningEffort): Promise<void> {
    if (!selectedProviderCatalog || !modelCatalog) {
      return;
    }

    await runAuxiliaryReasoningEffortChangeOperation({
      reasoningEffort,
      providerCatalog: selectedProviderCatalog,
      catalogRevision: modelCatalog.revision,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  async function handleSelectAuxiliaryCustomAgent(agent: DiscoveredCustomAgent | null): Promise<void> {
    const nextCustomAgentName = agent?.name ?? "";
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
  }

  async function handleSelectAuxiliarySkill(skill: DiscoveredSkill): Promise<void> {
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
    });
  }

  async function handleAddAuxiliaryAdditionalDirectory(): Promise<void> {
    const withmateApi = getWithMateApi();
    await runAddAuxiliaryAdditionalDirectoryOperationWithApi({
      api: withmateApi,
      hasParentSession: !!snapshot,
      activeAuxiliarySession,
      pickerBaseDirectory,
      workspacePath: snapshot?.session.worktreePath,
      fallbackPath: snapshot?.session.repoRoot,
      setPickerBaseDirectory,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  async function handleRemoveAuxiliaryAdditionalDirectory(directoryPath: string): Promise<void> {
    await runRemoveAuxiliaryAdditionalDirectoryOperation({
      directoryPath,
      updateActiveAuxiliarySession,
      createTimestampLabel: currentTimestampLabel,
    });
  }

  const handleStartTitleEdit = createStartTitleEditHandler({
    getTitle: () => snapshot?.session.taskTitle,
    canStart: () => !!snapshot && !isSelectedSessionRunning,
    setTitleDraft,
    setHeaderExpanded: () => {},
    setEditingTitle: setIsEditingTitle,
  });

  const handleCancelTitleEdit = createCancelTitleEditHandler({
    getTitle: () => snapshot?.session.taskTitle,
    setTitleDraft,
    setEditingTitle: setIsEditingTitle,
  });

  async function handleSaveTitle(): Promise<void> {
    if (!snapshot) {
      return;
    }

    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleDraft(snapshot.session.taskTitle);
      setIsEditingTitle(false);
      return;
    }

    const nextSession: CompanionSession = {
      ...snapshot.session,
      taskTitle: nextTitle,
      updatedAt: currentTimestampLabel(),
    };
    await persistCompanionSession(nextSession);
    setTitleDraft(nextTitle);
    setIsEditingTitle(false);
  }

  const handleTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement> = createTitleInputKeyHandler({
    saveTitle: () => void handleSaveTitle(),
    cancelTitleEdit: handleCancelTitleEdit,
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

  async function reloadSnapshot(preferredPath = selectedPath, options: { preserveSelectionOnly?: boolean } = {}): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    if (!isMergeView) {
      const nextSession = await withmateApi.getCompanionSession(snapshot.session.id);
      if (!nextSession) {
        setSnapshot(null);
        setErrorMessage("対象 CompanionSession が見つからないよ。");
        return;
      }
      setSnapshot(buildCompanionChatSnapshot(nextSession));
      setSelectedModel(nextSession.model);
      setSelectedReasoningEffort(nextSession.reasoningEffort);
      setSelectedApprovalMode(nextSession.approvalMode);
      setSelectedCodexSandboxMode(nextSession.codexSandboxMode);
      setSelectedCodexSpeed(nextSession.codexSpeed);
      setSelectedCodexReviewer(nextSession.codexReviewer);
      return;
    }

    const nextSnapshot = await withmateApi.getCompanionReviewSnapshot(snapshot.session.id);
    if (!nextSnapshot) {
      setSnapshot(null);
      setErrorMessage("対象 CompanionSession が見つからないよ。");
      return;
    }
    setSnapshot(nextSnapshot);
    const nextSelectedPath =
      nextSnapshot.changedFiles.some((file) => file.path === preferredPath)
        ? preferredPath
        : pickInitialFile(nextSnapshot.changedFiles)?.path ?? "";
    setSelectedPath(nextSelectedPath);
    setSelectedPaths((current) => {
      const changedPathSet = new Set(nextSnapshot.changedFiles.map((file) => file.path));
      const preserved = current.filter((path) => changedPathSet.has(path));
      if (options.preserveSelectionOnly) {
        return preserved;
      }
      return preserved;
    });
  }

  useEffect(() => {
    if (!isMergeView || !snapshot || snapshot.session.status !== "active") {
      return;
    }

    let disposed = false;
    const refreshMergeSnapshot = () => {
      if (disposed || operationRunning || turnRunning || isMergePaneResizing || isMergeStagePaneResizing) {
        return;
      }
      void reloadSnapshot(selectedPath, { preserveSelectionOnly: true }).catch((error) => {
        if (!disposed) {
          setErrorMessage(error instanceof Error ? error.message : "Companion merge の更新に失敗したよ。");
        }
      });
    };
    const handleFocus = () => refreshMergeSnapshot();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshMergeSnapshot();
      }
    };

    const intervalId = window.setInterval(refreshMergeSnapshot, 2000);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    isMergePaneResizing,
    isMergeStagePaneResizing,
    isMergeView,
    operationRunning,
    selectedPath,
    snapshot?.session.id,
    snapshot?.session.status,
    turnRunning,
  ]);

  function stageChangedFile(filePath: string): void {
    setSelectedPaths((current) => current.includes(filePath) ? current : [...current, filePath]);
  }

  function unstageChangedFile(filePath: string): void {
    setSelectedPaths((current) => current.filter((candidate) => candidate !== filePath));
  }

  function stageAllChangedFiles(): void {
    setSelectedPaths(snapshot?.changedFiles.map((file) => file.path) ?? []);
  }

  function unstageAllChangedFiles(): void {
    setSelectedPaths([]);
  }

  function treeDirectoryKey(action: ChangedFileTreeAction, pathValue: string): string {
    return `${action}:${pathValue}`;
  }

  function toggleMergeTreeDirectory(action: ChangedFileTreeAction, pathValue: string): void {
    const key = treeDirectoryKey(action, pathValue);
    setCollapsedMergeTreeDirectories((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleStartMergePaneResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsMergePaneResizing(true);
  }

  function handleStartMergeStagePaneResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsMergeStagePaneResizing(true);
  }

  function handleMergePaneResizeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setMergeFileListPercent((current) => clampMergePanePercent(current + direction * 2));
  }

  function handleMergeStagePaneResizeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    setMergeStagePanePercent((current) => clampMergePanePercent(current + direction * 2));
  }

  function renderChangedFileTree(nodes: ChangedFileTreeNode[], action: ChangedFileTreeAction, depth = 0) {
    return nodes.map((node) => {
      const depthStyle = { "--tree-indent": `${depth * 14}px` } as CSSProperties;
      if (node.kind === "directory") {
        const directoryKey = treeDirectoryKey(action, node.path);
        const isCollapsed = collapsedMergeTreeDirectories.has(directoryKey);
        return (
          <div className="companion-review-tree-directory" key={`dir:${node.path}`}>
            <button
              className={`companion-review-tree-directory-label${isCollapsed ? " collapsed" : ""}`}
              type="button"
              style={depthStyle}
              title={node.path}
              aria-expanded={!isCollapsed}
              onClick={() => toggleMergeTreeDirectory(action, node.path)}
            >
              {node.name}
            </button>
            {isCollapsed ? null : renderChangedFileTree(node.children, action, depth + 1)}
          </div>
        );
      }

      const isStageAction = action === "stage";
      return (
        <div
          key={node.file.path}
          className={`companion-review-file${selectedFile?.path === node.file.path ? " active" : ""}`}
          style={depthStyle}
        >
          <span className={`file-kind ${node.file.kind}`}>{fileKindLabel(node.file.kind)}</span>
          <button
            className="companion-review-file-path"
            type="button"
            title={node.file.path}
            onClick={() => setSelectedPath(node.file.path)}
          >
            {node.name}
          </button>
          <button
            className="companion-review-file-stage-action"
            type="button"
            aria-label={`${isStageAction ? "stage" : "unstage"} ${node.file.path}`}
            disabled={snapshot?.session.status !== "active"}
            title={isStageAction ? "Stage" : "Unstage"}
            onClick={() => {
              if (isStageAction) {
                stageChangedFile(node.file.path);
              } else {
                unstageChangedFile(node.file.path);
              }
            }}
          >
            {isStageAction ? "+" : "-"}
          </button>
        </div>
      );
    });
  }

  async function mergeSelectedFiles(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || selectedPaths.length === 0 || operationDisabled) {
      return;
    }

    setOperationRunning(true);
    setErrorMessage("");
    setOperationMessage("");
    setSiblingWarnings([]);
    try {
      await withmateApi.mergeCompanionSelectedFiles({
        sessionId: snapshot.session.id,
        selectedPaths,
      });
      window.close();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "selected files の merge に失敗したよ。");
    } finally {
      setOperationRunning(false);
    }
  }

  async function syncCompanionTarget(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || operationDisabled) {
      return;
    }

    setOperationRunning(true);
    setErrorMessage("");
    setOperationMessage("");
    setSiblingWarnings([]);
    try {
      const result = await withmateApi.syncCompanionTarget(snapshot.session.id);
      const baseSnapshotChanged = result.session.baseSnapshotCommit !== snapshot.session.baseSnapshotCommit;
      setSnapshot((current) => current ? { ...current, session: result.session } : current);
      await reloadSnapshot(selectedPath, { preserveSelectionOnly: true });
      setOperationMessage(baseSnapshotChanged
        ? "target branch を Companion worktree に同期しました。"
        : "target branch は最新です。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Sync Target に失敗しました。");
    } finally {
      setOperationRunning(false);
    }
  }

  async function stashCompanionTargetChanges(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || operationDisabled) {
      return;
    }

    setOperationRunning(true);
    setErrorMessage("");
    setOperationMessage("");
    setSiblingWarnings([]);
    try {
      await withmateApi.stashCompanionTargetChanges(snapshot.session.id);
      await reloadSnapshot(selectedPath, { preserveSelectionOnly: true });
      setOperationMessage("target workspace の変更を stash しました。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "target changes の stash に失敗しました。");
    } finally {
      setOperationRunning(false);
    }
  }

  async function restoreCompanionTargetStash(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || operationDisabled) {
      return;
    }

    setOperationRunning(true);
    setErrorMessage("");
    setOperationMessage("");
    setSiblingWarnings([]);
    try {
      await withmateApi.restoreCompanionTargetStash(snapshot.session.id);
      await reloadSnapshot(selectedPath, { preserveSelectionOnly: true });
      setOperationMessage("target stash を workspace に戻しました。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "target stash の復元に失敗しました。");
    } finally {
      setOperationRunning(false);
    }
  }

  async function dropCompanionTargetStash(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || operationDisabled) {
      return;
    }

    setOperationRunning(true);
    setErrorMessage("");
    setOperationMessage("");
    setSiblingWarnings([]);
    try {
      await withmateApi.dropCompanionTargetStash(snapshot.session.id);
      await reloadSnapshot(selectedPath, { preserveSelectionOnly: true });
      setOperationMessage("target stash を破棄しました。");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "target stash の破棄に失敗しました。");
    } finally {
      setOperationRunning(false);
    }
  }

  async function sendCompanionTurn(
    messageText = composerText,
    options: { clearDraft?: boolean } = {},
  ): Promise<void> {
    const withmateApi = getWithMateApi();
    const shouldClearDraft = options.clearDraft ?? true;
    const preflight = resolveSessionTurnStartPreflight({
      hasSession: !!snapshot,
      hasApi: !!withmateApi,
      operationRunning,
      turnRunning,
      runState: selectedSessionRunState,
      sessionStatus: snapshot?.session.status,
      messageText,
    });
    if (preflight.status === "blocked") {
      setForceComposerBlockedFeedback(true);
      return;
    }
    if (!snapshot || !withmateApi) {
      return;
    }
    const userMessage = preflight.userMessage;

    const previousSnapshot = snapshot;
    let appliedOptimisticState = false;
    setTurnRunning(true);
    setForceComposerBlockedFeedback(false);
    setErrorMessage("");
    setOperationMessage("");
    try {
      const previewRequest = createComposerPreviewRequest({
        api: withmateApi,
        mode: "companion",
        sessionId: snapshot.session.id,
      });
      if (!previewRequest) {
        return;
      }

      const preview = await previewRequest(messageText);
      const displayPreview = resolveComposerPreviewDisplay(preview, appSettings.userMicrocopyCatalog);
      if (shouldClearDraft || messageText === composerText) {
        setComposerPreview(displayPreview);
      }
      const { blockedMessage } = resolveComposerSendPreflight({
        runState: selectedSessionRunState,
        blockedReason: companionComposerBlockedReason,
        inputErrors: displayPreview.errors,
        draftText: messageText,
      });
      if (blockedMessage) {
        throw new Error(blockedMessage);
      }

      applyOptimisticSessionRunUpdate({
        session: snapshot.session,
        userMessage,
        updatedAt: currentTimestampLabel(),
        updateLiveRunState: (update) => setLiveRunState(update),
        applyRunningSession: (nextSession) =>
          setSnapshot((current) => current ? { ...current, session: nextSession } : current),
      });
      if (shouldClearDraft) {
        applyComposerDraftClearCommand({
          setDraft: setComposerText,
        });
      }
      appliedOptimisticState = true;

      const nextSession = await withmateApi.runCompanionSessionTurn(snapshot.session.id, {
        userMessage,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        approvalMode: selectedApprovalMode,
        codexSandboxMode: selectedCodexSandboxMode,
        codexSpeed: selectedCodexSpeed,
        codexReviewer: selectedCodexReviewer,
      });
      applyResolvedSessionRunUpdate({
        savedSession: nextSession,
        applySavedSession: (savedSession) =>
          setSnapshot((current) => current ? { ...current, session: savedSession } : current),
      });
      try {
        await reloadSnapshot();
      } catch (error) {
        setErrorMessage(resolveSessionRunErrorMessage(error, "Companion の再読み込みに失敗したよ。"));
      }
    } catch (error) {
      if (appliedOptimisticState) {
        if (shouldClearDraft) {
          applyComposerDraftChangeCommand({
            value: userMessage,
            setDraft: setComposerText,
          });
        }
        rollbackOptimisticSessionRunUpdate({
          sessionId: previousSnapshot.session.id,
          updateLiveRunState: (update) => setLiveRunState(update),
          restoreSession: () =>
            setSnapshot((current) => current?.session.id === previousSnapshot.session.id ? previousSnapshot : current),
        });
      }
      setErrorMessage(resolveSessionRunErrorMessage(error, "Companion の実行に失敗したよ。"));
    } finally {
      setTurnRunning(false);
    }
  }

  async function cancelCompanionTurn(): Promise<void> {
    const withmateApi = getWithMateApi();
    await runRunningSessionCancelOperation({
      target: buildRunningSessionCancelTarget({
        sessionId: snapshot?.session.id,
        runState: selectedSessionRunState,
        isRunning: isSelectedSessionRunning,
      }),
      cancelRun: withmateApi ? (sessionId) => withmateApi.cancelCompanionSessionRun(sessionId) : null,
    });
  }

  async function handleResendLastMessage(): Promise<void> {
    await runRetryResendCommand({
      isDisabled: isRetryActionDisabled,
      messageText: lastUserMessage?.text,
      resendMessage: (messageText) => sendCompanionTurn(messageText, { clearDraft: false }),
    });
  }

  function restoreLastUserMessageToDraft(messageText: string): void {
    const textarea = composerTextareaRef.current;
    applyRetryDraftRestoreCommand({
      messageText,
      setActionDockPinnedExpanded: setIsActionDockPinnedExpanded,
      setDraft: setComposerText,
      setCaret: setComposerCaret,
      setRetryDraftReplacePending: setIsRetryDraftReplacePending,
      focusComposer: (caret) => restoreComposerTextareaFocusAndCaret(textarea, caret),
    });
  }

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

  async function handleResolveCompanionLiveApproval(
    request: LiveApprovalRequest,
    decision: "approve" | "deny",
  ): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || approvalActionRequestId) {
      return;
    }

    const sessionId = activeRunSessionId ?? snapshot.session.id;
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
  }

  async function handleResolveCompanionLiveElicitation(
    request: LiveElicitationRequest,
    response: LiveElicitationResponse,
  ): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || elicitationActionRequestId) {
      return;
    }

    const sessionId = activeRunSessionId ?? snapshot.session.id;
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
  }

  const handleCompanionSubmitShortcut = () => applyComposerSubmitCommand({
    submit: () => {
      void (
        activeAuxiliarySession
          ? sendAuxiliaryMessage(activeAuxiliarySession.composerDraft)
          : sendCompanionTurn()
      );
    },
  });

  useShortcutDispatcherSettings(appSettings.keyboardShortcuts);
  useShortcutScope("composer");
  useShortcutCommandHandler(SHORTCUT_COMMAND_IDS.composerSubmit, handleCompanionSubmitShortcut);

  async function openCompanionWorktree(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    showOpenPathFeedback(await resolveOpenPathFeedback(
      () => withmateApi.openPath(snapshot.session.worktreePath),
      "Explorer を開けなかったよ。",
    ));
  }

  async function openCompanionTerminal(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    try {
      await withmateApi.openTerminalAtPath(snapshot.session.worktreePath);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Terminal を開けなかったよ。");
    }
  }

  const openCompanionSessionFilesDirectory = createSessionFilesOpenHandler({
    getSessionId: () => snapshot?.session.id,
    getOpenSessionFiles: () => {
      const withmateApi = getWithMateApi();
      return withmateApi
        ? (sessionId) => withmateApi.openSessionFilesDirectory(sessionId)
        : null;
    },
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "session files directory を開けなかったよ。",
  });

  const openCompanionSessionFilesTerminal = createSessionFilesOpenHandler({
    getSessionId: () => snapshot?.session.id,
    getOpenSessionFiles: () => {
      const withmateApi = getWithMateApi();
      return withmateApi
        ? (sessionId) => withmateApi.openSessionFilesTerminal(sessionId)
        : null;
    },
    alertError: (message) => window.alert(message),
    fallbackErrorMessage: "session files terminal を開けなかったよ。",
  });

  async function openCompanionMergeWindow(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    await withmateApi.openCompanionMergeWindow(snapshot.session.id);
  }

  async function discardCompanion(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || operationDisabled || !window.confirm("Companion を discard する？")) {
      return;
    }

    setOperationRunning(true);
    setErrorMessage("");
    setOperationMessage("");
    setSiblingWarnings([]);
    try {
      await withmateApi.discardCompanionSession(snapshot.session.id);
      window.close();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Companion の discard に失敗したよ。");
    } finally {
      setOperationRunning(false);
    }
  }


  if (!desktopRuntime) {
    return isMergeView ? (
      <div className="page-shell companion-review-page">
        <section className="panel empty-session-card rise-1">
          <p>Companion は Electron から開いてね。</p>
        </section>
      </div>
    ) : (
      <ChatWindowStatusScreen message="Companion は Electron から開いてね。" />
    );
  }

  if (!snapshot) {
    return isMergeView ? (
      <div className="page-shell companion-review-page">
        <section className="panel empty-session-card rise-1">
          <h2>Companion</h2>
          <p>{errorMessage || "読み込み中..."}</p>
        </section>
      </div>
    ) : (
      <ChatWindowStatusScreen message={errorMessage || "Companion を読み込み中..."} />
    );
  }

  if (!isMergeView) {
    return (
      <ShortcutSettingsProvider settings={appSettings.keyboardShortcuts}>
        <>
        <ChatWindow {...buildCompanionChatWindowProps({
        session: snapshot.session,
        character: companionCharacterProfile!,
        displayedMessages: displayedSession?.messages ?? [],
        expandedArtifacts,
        themeStyle,
        layoutRef: sessionDockLayoutRef,
        headerDockRef,
        actionDockRef,
        dockLayoutStyle: sessionDockLayoutStyle,
        workbenchRef: sessionWorkbenchRef,
        workbenchStyle: sessionWorkbenchStyle,
        layoutPriority,
        onActivateSidePanePriority: handleActivateSidePanePriority,
        onActivateDockPriority: handleActivateDockPriority,
        isHeaderExpanded: isSessionHeaderExpanded,
        isEditingTitle,
        titleDraft,
        isSelectedSessionRunning,
        isHeaderActionDisabled: operationRunning || turnRunning || isAuxiliaryActionPending,
        messageListRef,
        liveApprovalRequest: selectedSessionLiveRun?.approvalRequest ?? null,
        approvalActionRequestId,
        liveElicitationRequest: selectedSessionLiveRun?.elicitationRequest ?? null,
        elicitationActionRequestId,
        liveRunAssistantText: selectedSessionLiveRun?.assistantText ?? "",
        liveRunErrorMessage: selectedSessionLiveRun?.errorMessage ?? "",
        pendingMessageText: COMPANION_PENDING_MESSAGE_TEXT,
        pendingMessageGroupId: resolvePendingAuxiliaryMessageGroupId(activeAuxiliarySession),
        isMessageListFollowing,
        retryBanner,
        isRetryActionDisabled,
        isRetryEditDisabled,
        isRetryDraftReplacePending,
        isActionDockExpanded,
        isActionDockResizing,
        composerBlocked: snapshot.session.status !== "active" || operationRunning,
        isAgentPickerOpen,
        isSkillPickerOpen,
        isAdditionalDirectoryListOpen,
        selectedCustomAgentLabel: displayedSession?.provider === "copilot" ? selectedCustomAgentDisplay.label : "Agent",
        selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択",
        canCollapseActionDock,
        isCustomAgentListLoading,
        isSkillListLoading,
        skillListError,
        customAgentItems,
        skillItems,
        attachmentItems: composerAttachmentItems,
        additionalDirectoryItems,
        draft: activeComposerText,
        composerTextareaRef,
        isComposerDisabled: runDisabled,
        isSendDisabled: isCompanionSendDisabled,
        composerSendability: companionComposerSendability,
        sendButtonTitle: isSelectedSessionRunning
          ? (activeAuxiliarySession ? "Auxiliary を停止" : "Companion を停止")
          : companionSendButtonTitle,
        isComposerBlockedFeedbackActive: companionComposerSendability.shouldShowFeedback,
        approvalOptions: approvalSelectOptions,
        selectedApprovalMode: selectedRuntimeApprovalMode,
        sandboxOptions: sandboxSelectOptions,
        selectedCodexSandboxMode: selectedRuntimeCodexSandboxMode,
        speedOptions: speedSelectOptions,
        selectedCodexSpeed: selectedRuntimeCodexSpeed,
        reviewerOptions: reviewerSelectOptions,
        selectedCodexReviewer: selectedRuntimeCodexReviewer,
        modelOptions: modelSelectOptions,
        selectedModel: selectedRuntimeModel,
        selectedModelFallbackLabel,
        reasoningOptions: reasoningSelectOptions,
        selectedReasoningEffort: selectedRuntimeReasoningEffort,
        attachmentCount: composerPreview.attachments.length,
        isContextRailResizing,
        isContextRailVisible,
        activeContextPaneTab,
        availableContextPaneTabs,
        contextPaneProjection,
        latestCommandView,
        runningDetailsEntries,
        liveRunReasoningText,
        backgroundTasks: selectedBackgroundTasks,
        companionGroupMonitorEntries,
        isCopilotSession,
        selectedCopilotRemainingPercentLabel: selectedCopilotQuotaProjection.remainingPercentLabel,
        selectedCopilotRemainingRequestsLabel: selectedCopilotQuotaProjection.remainingRequestsLabel,
        selectedCopilotQuotaResetLabel: selectedCopilotQuotaProjection.resetLabel,
        selectedSessionContextTelemetry,
        selectedSessionContextTelemetryProjection,
        selectedDiff,
        selectedDiffThemeStyle,
        auditLogsOpen,
        displayedSessionAuditLogs,
        auditLogSourceLabel,
        auditLogDetails,
        auditLogOperationDetails,
        auditLogsHasMore,
        auditLogsLoading,
        auditLogsTotal,
        auditLogsErrorMessage,
        toastMessage: errorMessage || operationMessage,
        toastTone: errorMessage ? "error" : "success",
        isAuxiliaryMode,
        concurrentChats: {
          mainSession: snapshot.session,
          auxiliarySession: auxiliaryDisplayedSession,
          auxiliaryProps: auxiliaryWorkspace.selectedSession ? {
            onLoadArtifactDetail: async (messageIndex) => auxiliaryWorkspace.selectedSession?.messages[messageIndex]?.artifact ?? null,
            onOpenPath: (target: string) => void openCompanionInlinePath(
              getWithMateApi(),
              target,
              snapshot.session.worktreePath,
            ).then(showOpenPathFeedback),
          } : undefined,
          selectedAuxiliaryId: auxiliaryWorkspace.selectedId,
          auxiliaryItems: auxiliaryWorkspace.summaries.map((summary) => ({
            id: summary.id,
            label: summary.preview ?? "新しい会話",
            searchText: summary.preview ?? "新しい会話",
            icon: <CharacterAvatar key={summary.id} character={{ name: "", iconPath: summary.characterIconPath ?? "" }} size="tiny" />,
          })),
          target: auxiliaryWorkspace.target,
          widthRatio: auxiliaryWorkspace.widthRatio,
          scrollToLatestOnSend: appSettings.scrollToLatestOnSend,
          onSelectAuxiliary: auxiliaryWorkspace.selectSession,
          onTargetChange: (target) => auxiliaryWorkspace.setTarget(target),
          onWidthRatioChange: auxiliaryWorkspace.setWidthRatio,
          loading: auxiliaryWorkspace.loading || auxiliaryWorkspace.detailLoading,
          error: auxiliaryWorkspace.error?.message ?? auxiliaryWorkspace.detailError?.message ?? null,
          api: withmateApi ?? undefined,
          mainLiveRun: activeAuxiliarySession ? undefined : selectedSessionLiveRun,
          auxiliaryLiveRun: activeAuxiliarySession ? selectedSessionLiveRun : undefined,
        },
        onToggleHeaderSplitter: handleToggleHeaderSplitter,
        onOpenAuditLog: () => setAuditLogsOpen(true),
        onOpenTerminal: () => void openCompanionTerminal(),
        onOpenSessionFilesTerminal: () => void openCompanionSessionFilesTerminal(),
        onTitleDraftChange: setTitleDraft,
        onTitleInputKeyDown: handleTitleInputKeyDown,
        onSaveTitle: () => void handleSaveTitle(),
        onCancelTitleEdit: handleCancelTitleEdit,
        onStartTitleEdit: handleStartTitleEdit,
        onOpenWorktree: () => void openCompanionWorktree(),
        onOpenSessionFilesExplorer: () => void openCompanionSessionFilesDirectory(),
        onOpenMergeWindow: () => void openCompanionMergeWindow(),
        onMessageListScroll: handleMessageListScroll,
        onToggleArtifact: toggleArtifact,
        onLoadArtifactDetail: (messageIndex) =>
          Promise.resolve(withmateApi?.getCompanionMessageArtifact(snapshot.session.id, messageIndex) ?? null),
        onOpenDiff: (title, file) =>
          setSelectedDiff({
            title,
            file,
            themeColors: snapshot.session.characterThemeColors,
          }),
        onResolveLiveApproval: (request, decision) => void handleResolveCompanionLiveApproval(request, decision),
        onResolveLiveElicitation: (request, response) => void handleResolveCompanionLiveElicitation(request, response),
        onOpenInlinePath: (target) => void openCompanionInlinePath(
          getWithMateApi(),
          target,
          snapshot.session.worktreePath,
        ).then(showOpenPathFeedback),
        onCopyMessageText: handleCopyMessageText,
        onQuoteMessageText: handleQuoteMessageText,
        onResendLastMessage: () => void handleResendLastMessage(),
        onEditLastMessage: handleEditLastMessage,
        onConfirmRetryDraftReplace: handleConfirmRetryDraftReplace,
        onCancelRetryDraftReplace: handleCancelRetryDraftReplace,
        onPickFile: () => void pickAndInsertPath("file"),
        onPickFolder: () => void pickAndInsertPath("folder"),
        onPickImage: () => void pickAndInsertPath("image"),
        onAddToSessionFiles: () => void addToSessionFiles(),
        onPickSessionFiles: () => void pickSessionFiles(),
        onPickSessionFolder: () => void pickSessionFolder(),
        onPickSessionImage: () => void pickSessionImage(),
        onToggleAgentPicker: handleToggleAgentPicker,
        onToggleSkillPicker: handleToggleSkillPicker,
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
            setDraft: setComposerText,
            setComposerCaret,
            clearFeedback: () => setForceComposerBlockedFeedback(false),
          });
        },
        onDraftFocus: () => handleExpandActionDock({ focusComposer: false }),
        onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void handleComposerPaste(event),
        onDraftSelect: (start) => composerState.setSelection({
          start, end: composerTextareaRef.current?.selectionEnd ?? start,
        }),
        ...buildOnDraftCompositionHandlers({
          setComposerCaret,
          setIsComposerImeComposing: (value) => {
            if (composerOwnerRef.current === activeRunSessionId) setIsComposerImeComposing(value);
          },
          getSelectionStart: () => composerOwnerRef.current === activeRunSessionId
            ? composerTextareaRef.current?.selectionStart : composerCaret,
          getFallbackSelectionStart: () => activeComposerText.length,
        }),
        onSendOrCancel: buildAuxiliaryAwareSendOrCancelHandler({
          shouldSendAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          isAuxiliarySessionRunning: activeAuxiliarySession?.runState === "running",
          isSelectedSessionRunning,
          onCancelAuxiliaryRun: cancelAuxiliaryRun,
          onSendAuxiliary: () => sendAuxiliaryMessage(activeAuxiliarySession?.composerDraft ?? ""),
          onCancelSelectedSessionRun: cancelCompanionTurn,
          onSendSelectedSession: sendCompanionTurn,
        }),
        onChangeApprovalMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<ApprovalMode>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryApproval,
          onSelectedSessionChange: handleChangeApproval,
        }),
        onChangeCodexSandboxMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<CodexSandboxMode>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliarySandboxMode,
          onSelectedSessionChange: handleChangeCodexSandboxMode,
        }),
        onChangeCodexSpeed: buildAuxiliaryAwareRuntimeOptionChangeHandler<CodexSpeed>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryCodexSpeed,
          onSelectedSessionChange: handleChangeCodexSpeed,
        }),
        onChangeCodexReviewer: buildAuxiliaryAwareRuntimeOptionChangeHandler<CodexReviewer>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryCodexReviewer,
          onSelectedSessionChange: handleChangeCodexReviewer,
        }),
        onChangeModel: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: handleChangeAuxiliaryModel,
          onSelectedSessionChange: handleChangeSelectedModel,
        }),
        onChangeReasoningEffort: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: auxiliaryWorkspace.target === "auxiliary",
          onAuxiliaryChange: (value) => handleChangeAuxiliaryReasoningEffort(value as ModelReasoningEffort),
          onSelectedSessionChange: (value) => handleChangeReasoningEffort(value as ModelReasoningEffort),
        }),
        onStartContextRailResize: handleStartContextRailResize,
        onStartActionDockResize: handleStartActionDockResize,
        onToggleActionDock: handleToggleActionDock,
        onToggleContextRailVisibility: handleToggleContextRailVisibility,
        onKeyDownContextRailResize: handleKeyDownContextRailResize,
        onCycleContextPaneTab: handleCycleContextPaneTab,
        onSelectContextPaneTab: setActiveContextPaneTab,
        onOpenCompanionReview: (sessionId) => void getWithMateApi()?.openCompanionReviewWindow(sessionId),
        onCloseDiff: () => setSelectedDiff(null),
        onOpenDiffWindow: (payload) => void openDiffWindow(payload),
        onLoadMoreAuditLogs: handleLoadMoreAuditLogs,
        onLoadAuditLogDetail: handleLoadAuditLogDetail,
        onLoadAuditLogOperationDetail: handleLoadAuditLogOperationDetail,
        onCloseAuditLog: () => setAuditLogsOpen(false),
        })} />
        </>
      </ShortcutSettingsProvider>
    );
  }

  return (
    <ShortcutSettingsProvider settings={appSettings.keyboardShortcuts}>
      <div
        className={`page-shell companion-review-page theme-accent${isHeaderExpanded ? "" : " companion-review-page-header-collapsed"}`}
        style={themeStyle}
      >
      <section className="companion-review-shell panel rise-1">
        {isHeaderExpanded ? (
          <SessionHeader
            taskTitle={snapshot.session.taskTitle}
            isEditingTitle={isEditingTitle}
            titleDraft={titleDraft}
            isRunning={turnRunning}
            showRenameButton={false}
            showAuditLogButton={false}
            showTerminalButton
            showDeleteButton={false}
            onOpenAuditLog={() => setAuditLogsOpen(true)}
            onOpenTerminal={() => void openCompanionTerminal()}
            onTitleDraftChange={setTitleDraft}
            onTitleInputKeyDown={handleTitleInputKeyDown}
            onSaveTitle={() => void handleSaveTitle()}
            onCancelTitleEdit={handleCancelTitleEdit}
            onStartTitleEdit={handleStartTitleEdit}
            onDeleteSession={() => {}}
            workspaceActions={(
              <>
                <button
                  className="drawer-toggle compact secondary"
                  type="button"
                  disabled={operationDisabled || targetWorkspaceDirtyBlocked}
                  title={targetWorkspaceDirtyBlocked
                    ? "target workspace の変更を stash してから Sync Target してください。"
                    : targetBranchDriftBlocked
                      ? "target branch の変更を Companion worktree に取り込みます。"
                      : "target branch の変更を確認します。"}
                  onClick={() => void syncCompanionTarget()}
                >
                  Sync Target
                </button>
                <button
                  className="drawer-toggle compact"
                  type="button"
                  disabled={operationDisabled || mergeBlocked || selectedPaths.length === 0}
                  title={targetStashBlocked
                    ? "target stash を Restore または Drop してから merge してください。"
                    : targetBranchDriftBlocked
                      ? "target branch drift を解消するには先に Sync Target してください。"
                      : undefined}
                  onClick={() => void mergeSelectedFiles()}
                >
                  {`Merge Selected Files${selectedPaths.length > 0 ? ` (${selectedPaths.length})` : ""}`}
                </button>
                <button
                  className="drawer-toggle compact secondary"
                  type="button"
                  disabled={operationRunning || turnRunning}
                  onClick={() => void openCompanionWorktree()}
                >
                  Open Worktree
                </button>
              </>
            )}
            actions={(
              <button
                className="drawer-toggle compact danger"
                type="button"
                disabled={operationDisabled}
                onClick={() => void discardCompanion()}
              >
                Discard Companion
              </button>
            )}
          />
        ) : null}
        {(errorMessage || operationMessage) && (
          <div className={`companion-session-toast companion-review-toast ${errorMessage ? "error" : "success"}`}>
            {errorMessage || operationMessage}
          </div>
        )}
        {siblingWarnings.length > 0 && (
          <section className="companion-review-sibling-warnings">
            <p className="eyebrow">Sibling Check</p>
            <ul>
              {siblingWarnings.map((warning) => (
                <li key={warning.sessionId}>
                  <strong>{warning.taskTitle}</strong>
                  <span>{warning.message}</span>
                  <small>{warning.paths.join(", ")}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
        {snapshot.mergeRuns.length > 0 && (
          <section className="companion-review-timeline" aria-label="Merge run timeline">
            <div className="companion-review-timeline-head">
              <p className="eyebrow">Merge Runs</p>
              <span>{`${snapshot.mergeRuns.length} history`}</span>
            </div>
            <ol>
              {snapshot.mergeRuns.map((run) => (
                <li key={run.id}>
                  <div className="companion-review-timeline-topline">
                    <strong>{run.operation}</strong>
                    <span>{run.createdAt}</span>
                  </div>
                  <div className="companion-review-timeline-meta">
                    <span>{`selected: ${summarizeMergeRunPaths(run.selectedPaths)}`}</span>
                    <span>{`changed: ${summarizeMergeRunChangedFiles(run)}`}</span>
                    <span>{`sibling warnings: ${run.siblingWarnings.length}`}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="companion-review-layout merge-only">
          <section className="companion-review-workspace" aria-label="Companion review workspace">
            <div
              className={`companion-review-diff-layout${isMergePaneResizing ? " is-resizing" : ""}`}
              ref={mergeDiffLayoutRef}
              style={{ "--merge-file-list-percent": `${mergeFileListPercent}%` } as CSSProperties}
            >
              <aside className="companion-review-file-list" aria-label="Changed files">
                {!isHeaderExpanded ? (
                  <ChatHeaderHandle taskTitle={snapshot.session.taskTitle} onClick={handleToggleHeaderExpanded} />
                ) : null}
                {(visibleMergeBlockers.length > 0 || visibleMergeWarnings.length > 0) && (
                  <section className="companion-review-readiness compact">
                    {visibleMergeBlockers.length > 0 && (
                      <div className="companion-review-issues" aria-label="Merge blockers">
                        {visibleMergeBlockers.map((issue) => {
                          const pathSummary = summarizeIssuePaths(issue.paths);
                          return (
                            <span
                              className="companion-review-issue"
                              key={`${issue.kind}:${issue.message}`}
                              title={issue.paths ? `${issue.message}\n${issue.paths.join("\n")}` : issue.message}
                            >
                              {summarizeMergeReadinessIssue(issue)}
                              {pathSummary && <small>{pathSummary}</small>}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {visibleMergeWarnings.length > 0 && (
                      <div className="companion-review-issues warning" aria-label="Merge warnings">
                        {visibleMergeWarnings.map((issue) => (
                          <span className="companion-review-issue" key={`${issue.kind}:${issue.message}`} title={issue.message}>
                            {summarizeMergeReadinessIssue(issue)}
                          </span>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                {(targetWorkspaceDirtyBlocked || snapshot.targetStash) && (
                  <section className="companion-review-target-actions">
                    <div>
                      <strong>{snapshot.targetStash && targetWorkspaceDirtyBlocked
                        ? "Target stash still exists"
                        : snapshot.targetStash
                          ? "Target changes stashed"
                          : "Target has local changes"}</strong>
                      <span>{snapshot.targetStash && targetWorkspaceDirtyBlocked
                        ? "Drop it if you already applied it outside WithMate."
                        : snapshot.targetStash
                          ? `${snapshot.targetStash.ref} · ${snapshot.targetStash.id.slice(0, 8)}`
                          : "Stash them before syncing or merging."}</span>
                    </div>
                    {snapshot.targetStash && targetWorkspaceDirtyBlocked ? (
                      <button
                        type="button"
                        disabled={operationDisabled}
                        onClick={() => void dropCompanionTargetStash()}
                      >
                        Drop Stash
                      </button>
                    ) : snapshot.targetStash ? (
                      <button
                        type="button"
                        disabled={operationDisabled}
                        onClick={() => void restoreCompanionTargetStash()}
                      >
                        Restore Stash
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={operationDisabled}
                        onClick={() => void stashCompanionTargetChanges()}
                      >
                        Stash Target Changes
                      </button>
                    )}
                  </section>
                )}
                <div
                  className={`companion-review-file-selection${isMergeStagePaneResizing ? " is-resizing" : ""}`}
                  ref={mergeFileSelectionRef}
                  style={{ "--merge-stage-pane-percent": `${mergeStagePanePercent}%` } as CSSProperties}
                >
                  <section className="companion-review-file-section" aria-label="Staged changes">
                    <div className="companion-review-file-section-head">
                      <span>Stage</span>
                      <div className="companion-review-file-section-actions">
                        <span>{stagedChangedFiles.length}</span>
                        {stagedChangedFiles.length > 0 && (
                          <button
                            type="button"
                            aria-label="unstage all changes"
                            disabled={snapshot.session.status !== "active"}
                            title="Unstage All"
                            onClick={unstageAllChangedFiles}
                          >
                            -
                          </button>
                        )}
                      </div>
                    </div>
                    {stagedFileTree.length > 0 ? (
                      <div className="companion-review-file-tree">
                        {renderChangedFileTree(stagedFileTree, "unstage")}
                      </div>
                    ) : (
                      <span className="companion-review-tree-empty">Empty</span>
                    )}
                  </section>
                  <div
                    className="companion-review-stage-resizer"
                    role="separator"
                    aria-label="Resize stage and changes"
                    aria-orientation="horizontal"
                    aria-valuemin={MERGE_PANE_MIN_PERCENT}
                    aria-valuemax={MERGE_PANE_MAX_PERCENT}
                    aria-valuenow={Math.round(mergeStagePanePercent)}
                    tabIndex={0}
                    onKeyDown={handleMergeStagePaneResizeKeyDown}
                    onPointerDown={handleStartMergeStagePaneResize}
                  />
                  <section className="companion-review-file-section" aria-label="Changes">
                    <div className="companion-review-file-section-head">
                      <span>Changes</span>
                      <div className="companion-review-file-section-actions">
                        <span>{unstagedChangedFiles.length}</span>
                        {unstagedChangedFiles.length > 0 && (
                          <button
                            type="button"
                            aria-label="stage all changes"
                            disabled={snapshot.session.status !== "active"}
                            title="Stage All"
                            onClick={stageAllChangedFiles}
                          >
                            +
                          </button>
                        )}
                      </div>
                    </div>
                    {unstagedFileTree.length > 0 ? (
                      <div className="companion-review-file-tree">
                        {renderChangedFileTree(unstagedFileTree, "stage")}
                      </div>
                    ) : (
                      <span className="companion-review-tree-empty">Clean</span>
                    )}
                  </section>
                </div>
              </aside>
              <div
                className="companion-review-pane-resizer"
                role="separator"
                aria-label="Resize file list"
                aria-orientation="vertical"
                aria-valuemin={MERGE_PANE_MIN_PERCENT}
                aria-valuemax={MERGE_PANE_MAX_PERCENT}
                aria-valuenow={Math.round(mergeFileListPercent)}
                tabIndex={0}
                onKeyDown={handleMergePaneResizeKeyDown}
                onPointerDown={handleStartMergePaneResize}
              />

              <main className="companion-review-diff" aria-label="Selected file diff">
                {selectedFile ? (
                  <>
                    <div className="diff-titlebar companion-review-diff-title">
                      <h2>{selectedFile.path}</h2>
                    </div>
                    <DiffViewer file={selectedFile} />
                  </>
                ) : (
                  <div className="companion-review-empty-state clean">
                    <span className="companion-review-empty-mark" aria-hidden="true" />
                    <strong>Clean</strong>
                  </div>
                )}
              </main>
            </div>
          </section>
        </div>
      </section>
      </div>
    </ShortcutSettingsProvider>
  );
}
