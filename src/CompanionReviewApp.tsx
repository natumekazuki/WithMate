import {
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
} from "react";

import type { ApprovalMode } from "./approval-mode.js";
import type { AuxiliarySession } from "./auxiliary-session-state.js";
import type {
  ComposerPreview,
  DiffPreviewPayload,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionContextTelemetry,
} from "./app-state.js";
import { currentTimestampLabel } from "./app-state.js";
import type { CodexSandboxMode } from "./codex-sandbox-mode.js";
import type { CompanionMergeRunSummary, CompanionSession, CompanionSessionSummary } from "./companion-state.js";
import { createCompanionSessionSummary } from "./companion-state.js";
import {
  buildCompanionCharacterProfile,
  buildCompanionChatSnapshot,
  type CompanionSessionWindowView,
  getCompanionWindowViewFromSearch,
} from "./companion-session-mode-adapter.js";
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
  resolveModelChangeSelection,
  resolveModelSelection,
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCompanionGroupMonitorEntries } from "./home/home-session-projection.js";
import { SessionHeader } from "./session-components.js";
import { ChatHeaderHandle, ChatWindow, ChatWindowStatusScreen } from "./chat/chat-window.js";
import { AuxiliaryLaunchProviderDialog } from "./chat/AuxiliaryLaunchProviderDialog.js";
import { createAuxiliaryHeaderActions } from "./chat/chat-header-actions.js";
import { buildCompanionChatWindowProps } from "./chat/companion-chat-projection.js";
import { openCompanionInlinePath } from "./chat/companion-inline-path.js";
import { COMPANION_PENDING_MESSAGE_TEXT } from "./chat/pending-run-indicator.js";
import {
  buildRetryStopSummary,
  defaultRetryBannerDetailsOpen,
  isRetryActionDisabled as resolveRetryActionDisabled,
  resolveRetryBannerKind,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
  type RetryBannerState,
} from "./chat/retry-state.js";
import {
  copyMessageTextToClipboard,
  createQuotedMessageInsertion,
  insertComposerTextAtCaret,
} from "./chat/message-text-actions.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  withForcedComposerBlockedFeedback,
} from "./session-composer-feedback.js";
import { buildActionDockCompactPreview } from "./action-dock-preview.js";
import {
  AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK,
  buildAuxiliaryLaunchProviderItems,
} from "./chat/auxiliary-launch-state.js";
import { buildAuxiliaryAwareSendOrCancelHandler } from "./chat/send-or-cancel.js";
import { buildAuxiliaryAwareRuntimeOptionChangeHandler } from "./chat/auxiliary-runtime-option-routing.js";
import { useAuxiliaryLaunchDialogState } from "./chat/use-auxiliary-launch-dialog-state.js";
import {
  buildCustomAgentMatchDisplay,
  buildSelectedCustomAgentDisplay,
  buildSkillMatchDisplay,
  buildSkillPromptSnippet,
} from "./session-composer-selection.js";
import {
  buildAdditionalDirectoryDisplay,
  buildComposerAttachmentDisplay,
  buildWorkspacePathMatchDisplay,
  formatPathReference,
  getActivePathReference,
  normalizePathForReference,
  removeActivePathReference,
  toDirectoryPath,
  toWorkspaceRelativeReference,
} from "./session-composer-paths.js";
import {
  useSessionContextRail,
  useSessionMessageListFollowing,
} from "./session-chat-layout-hooks.js";
import {
  createOptimisticRunningSessionState,
  createOwnedPendingLiveSessionRunState,
} from "./session-live-run-state.js";
import {
  buildMessageListProjection,
  loadProjectedMessageArtifact,
  resolvePendingAuxiliaryMessageGroupId,
} from "./auxiliary-session-message-projection.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandProjection,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  resolveAvailableContextPaneTabs,
  type ContextPaneTabKey,
} from "./session-ui-projection.js";
import { buildCompanionAuxiliaryRuntimeSession } from "./auxiliary-runtime-projection.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import { fileKindLabel } from "./ui-utils.js";
import { buildRuntimeSelectionOptions } from "./runtime-selection-options.js";
import {
  buildOnDraftCompositionEndHandler,
  buildOnDraftCompositionStartHandler,
  buildOnDraftSelectHandler,
} from "./chat/composer-draft-handlers.js";
import {
  COMPOSER_PREVIEW_DEBOUNCE_MS,
  COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS,
  createEmptyComposerPreview,
  WORKSPACE_PATH_QUERY_MIN_LENGTH,
  WORKSPACE_PATH_SEARCH_DEBOUNCE_MS,
} from "./composer-preview-config.js";
import { extractTextReferenceCandidates } from "./path-reference.js";
import { hasSameAuxiliaryDraftSaveContext } from "./auxiliary-draft-save-context.js";
import type { WorkspacePathCandidate } from "./workspace-path-candidate.js";
import { isTerminalAuditLogPhase } from "./audit-log-phase.js";

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
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>(() => createEmptyComposerPreview());
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ModelReasoningEffort>("high");
  const [selectedApprovalMode, setSelectedApprovalMode] = useState<ApprovalMode>("untrusted");
  const [selectedCodexSandboxMode, setSelectedCodexSandboxMode] = useState<CodexSandboxMode>("workspace-write");
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(isMergeView);
  const [mergeFileListPercent, setMergeFileListPercent] = useState(MERGE_FILE_LIST_DEFAULT_PERCENT);
  const [mergeStagePanePercent, setMergeStagePanePercent] = useState(MERGE_STAGE_DEFAULT_PERCENT);
  const [isMergePaneResizing, setIsMergePaneResizing] = useState(false);
  const [isMergeStagePaneResizing, setIsMergeStagePaneResizing] = useState(false);
  const [collapsedMergeTreeDirectories, setCollapsedMergeTreeDirectories] = useState<Set<string>>(() => new Set());
  const [isActionDockPinnedExpanded, setIsActionDockPinnedExpanded] = useState(false);
  const [composerCaret, setComposerCaret] = useState(0);
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [availableCustomAgents, setAvailableCustomAgents] = useState<DiscoveredCustomAgent[]>([]);
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] = useState(false);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
  const [workspacePathMatches, setWorkspacePathMatches] = useState<WorkspacePathCandidate[]>([]);
  const [activeWorkspacePathMatchIndex, setActiveWorkspacePathMatchIndex] = useState(-1);
  const [isComposerImeComposing, setIsComposerImeComposing] = useState(false);
  const [isRetryDetailsOpen, setIsRetryDetailsOpen] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
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
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
  const [liveRunState, setLiveRunState] = useState<{ ownerSessionId: string | null; state: LiveSessionRunState | null }>({
    ownerSessionId: null,
    state: null,
  });
  const [providerQuotaTelemetryState, setProviderQuotaTelemetryState] = useState<{
    ownerProviderId: string | null;
    telemetry: ProviderQuotaTelemetry | null;
  }>({ ownerProviderId: null, telemetry: null });
  const [sessionContextTelemetryState, setSessionContextTelemetryState] = useState<{
    ownerSessionId: string | null;
    telemetry: SessionContextTelemetry | null;
  }>({ ownerSessionId: null, telemetry: null });
  const [activeContextPaneTab, setActiveContextPaneTab] = useState<ContextPaneTabKey>("latest-command");
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeAuxiliarySessionRef = useRef<AuxiliarySession | null>(null);
  const auxiliaryDraftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const auxiliaryLoadRevisionRef = useRef(0);
  const mergeDiffLayoutRef = useRef<HTMLDivElement | null>(null);
  const mergeFileSelectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    const sessionId = getCompanionSessionIdFromLocation();
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
  }, [viewMode]);

  useEffect(() => {
    setComposerText("");
    setComposerPreview(createEmptyComposerPreview());
    setPickerBaseDirectory(snapshot?.session.worktreePath ?? "");
    setComposerCaret(0);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    setIsComposerImeComposing(false);
    setIsRetryDraftReplacePending(false);
  }, [snapshot?.session.id]);

  useEffect(() => {
    activeAuxiliarySessionRef.current = activeAuxiliarySession;
  }, [activeAuxiliarySession]);

  const loadClosedAuxiliarySessions = async (
    parentSessionId: string,
    canApplyLoadResult: () => boolean,
  ) => {
    if (!withmateApi) {
      return;
    }

    try {
      const summaries = await withmateApi.listAuxiliarySessions(parentSessionId);
      const closedSummaries = summaries
        .filter((summary) => summary.status === "closed")
        .reverse();
      const sessions = await Promise.all(
        closedSummaries.map((summary) => withmateApi.getAuxiliarySession(summary.id)),
      );
      if (canApplyLoadResult()) {
        setClosedAuxiliarySessions(sessions.filter((session): session is AuxiliarySession => session !== null));
      }
    } catch {
      if (canApplyLoadResult()) {
        setClosedAuxiliarySessions([]);
      }
    }
  };

  useEffect(() => {
    let active = true;
    const loadRevision = auxiliaryLoadRevisionRef.current + 1;
    auxiliaryLoadRevisionRef.current = loadRevision;
    const canApplyLoadResult = () => active && auxiliaryLoadRevisionRef.current === loadRevision;
    const sessionId = snapshot?.session.id ?? null;
    if (!withmateApi || !sessionId || isMergeView) {
      setActiveAuxiliarySession(null);
      setClosedAuxiliarySessions([]);
      return () => {
        active = false;
      };
    }

    void withmateApi.getActiveAuxiliarySession(sessionId).then((session) => {
      if (canApplyLoadResult()) {
        setActiveAuxiliarySession(session);
      }
    }).catch(() => {
      if (canApplyLoadResult()) {
        setActiveAuxiliarySession(null);
      }
    });

    void loadClosedAuxiliarySessions(sessionId, canApplyLoadResult);

    return () => {
      active = false;
    };
  }, [isMergeView, snapshot?.session.id, withmateApi]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    void withmateApi.listCompanionSessionSummaries().then((nextSessions) => {
      if (active) {
        setCompanionSessions(nextSessions);
      }
    });

    const unsubscribe = withmateApi.subscribeCompanionSessionSummaries((nextSessions) => {
      if (active) {
        setCompanionSessions(nextSessions);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!snapshot || isEditingTitle) {
      return;
    }

    setTitleDraft(snapshot.session.taskTitle);
  }, [isEditingTitle, snapshot?.session.taskTitle]);

  useEffect(() => {
    const withmateApi = getWithMateApi();
    if (!withmateApi || isMergeView) {
      return;
    }
    void withmateApi.getModelCatalog(null).then(setModelCatalog).catch(() => setModelCatalog(null));
  }, [isMergeView]);

  const activeRunSessionId = activeAuxiliarySession?.id ?? snapshot?.session.id ?? null;
  const displayedSession = useMemo(
    () => snapshot
      ? (activeAuxiliarySession
        ? buildCompanionAuxiliaryRuntimeSession(snapshot.session, activeAuxiliarySession)
        : snapshot.session)
      : null,
    [activeAuxiliarySession, snapshot],
  );
  const isAuxiliaryMode = activeAuxiliarySession?.status === "active";
  const activeComposerText = activeAuxiliarySession?.composerDraft ?? composerText;
  const messageListProjection = useMemo(
    () => buildMessageListProjection(snapshot?.session.messages ?? [], [
      ...closedAuxiliarySessions,
      ...(activeAuxiliarySession ? [activeAuxiliarySession] : []),
    ], snapshot?.session.id),
    [activeAuxiliarySession, closedAuxiliarySessions, snapshot?.session.id, snapshot?.session.messages],
  );
  const messageListMessages = messageListProjection.messages;
  const messageListSources = messageListProjection.sources;
  const messageListKeys = messageListProjection.keys;
  const messageListGroups = messageListProjection.groups;

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const sessionId = activeRunSessionId;
    const activeAuxiliarySessionId = activeAuxiliarySession?.id ?? null;
    const refreshCompletedAuxiliarySession = (updatedSessionId: string) => {
      if (!withmateApi || activeAuxiliarySessionId !== updatedSessionId) {
        return;
      }

      void withmateApi.getAuxiliarySession(updatedSessionId).then((saved) => {
        if (!active) {
          return;
        }

        setActiveAuxiliarySession((current) => {
          if (current?.id !== updatedSessionId) {
            return current;
          }
          if (!saved || saved.runState !== "running" || current.runState !== "running") {
            activeAuxiliarySessionRef.current = saved;
            return saved;
          }

          return current;
        });
      }).catch(() => undefined);
    };
    if (!withmateApi || !sessionId || isMergeView) {
      setLiveRunState({ ownerSessionId: sessionId, state: null });
      return () => {
        active = false;
      };
    }

    setLiveRunState({ ownerSessionId: sessionId, state: null });
    void withmateApi.getLiveSessionRun(sessionId).then((state) => {
      if (active) {
        setLiveRunState({ ownerSessionId: sessionId, state });
        refreshCompletedAuxiliarySession(sessionId);
      }
    });

    const unsubscribe = withmateApi.subscribeLiveSessionRun((nextSessionId, state) => {
      if (active && nextSessionId === sessionId) {
        setLiveRunState({ ownerSessionId: nextSessionId, state });
        refreshCompletedAuxiliarySession(nextSessionId);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeAuxiliarySession?.id, activeRunSessionId, isMergeView]);

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
    const session = displayedSession;
    if (!withmateApi || !session || isMergeView) {
      setAvailableSkills([]);
      setIsSkillListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsSkillListLoading(true);
    void withmateApi.listWorkspaceSkills(session.provider, session.worktreePath).then((skills) => {
      if (active) {
        setAvailableSkills(skills);
        setIsSkillListLoading(false);
      }
    }).catch(() => {
      if (active) {
        setAvailableSkills([]);
        setIsSkillListLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [displayedSession, isMergeView]);

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
    let active = true;
    const withmateApi = getWithMateApi();
    const providerId = displayedSession?.provider ?? null;
    if (!withmateApi || !providerId || isMergeView) {
      setProviderQuotaTelemetryState({ ownerProviderId: providerId, telemetry: null });
      return () => {
        active = false;
      };
    }

    setProviderQuotaTelemetryState({ ownerProviderId: providerId, telemetry: null });
    void withmateApi.getProviderQuotaTelemetry(providerId).then((telemetry) => {
      if (active) {
        setProviderQuotaTelemetryState({ ownerProviderId: providerId, telemetry });
      }
    }).catch(() => {
      if (active) {
        setProviderQuotaTelemetryState({ ownerProviderId: providerId, telemetry: null });
      }
    });

    const unsubscribe = withmateApi.subscribeProviderQuotaTelemetry((nextProviderId, telemetry) => {
      if (active && nextProviderId === providerId) {
        setProviderQuotaTelemetryState({ ownerProviderId: nextProviderId, telemetry });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [displayedSession?.provider, isMergeView]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const sessionId = activeRunSessionId;
    if (!withmateApi || !sessionId || isMergeView) {
      setSessionContextTelemetryState({ ownerSessionId: sessionId, telemetry: null });
      return () => {
        active = false;
      };
    }

    setSessionContextTelemetryState({ ownerSessionId: sessionId, telemetry: null });
    void withmateApi.getSessionContextTelemetry(sessionId).then((telemetry) => {
      if (active) {
        setSessionContextTelemetryState({ ownerSessionId: sessionId, telemetry });
      }
    }).catch(() => {
      if (active) {
        setSessionContextTelemetryState({ ownerSessionId: sessionId, telemetry: null });
      }
    });

    const unsubscribe = withmateApi.subscribeSessionContextTelemetry((nextSessionId, telemetry) => {
      if (active && nextSessionId === sessionId) {
        setSessionContextTelemetryState({ ownerSessionId: nextSessionId, telemetry });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
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
  const selectedSessionLiveRun =
    activeRunSessionId !== null && liveRunState.ownerSessionId === activeRunSessionId ? liveRunState.state : null;
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
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogsState,
    auditLogDetails,
    auditLogOperationDetails,
    persistedEntries: companionSessionAuditLogs,
    displayedEntries: displayedSessionAuditLogs,
    handleLoadMoreAuditLogs,
    handleLoadAuditLogDetail,
    handleLoadAuditLogOperationDetail,
  } = useSessionAuditLogs({
    withmateApi,
    auditLogApi: companionAuditLogApi,
    selectedSession: snapshot?.session ?? null,
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
    : (snapshot?.session.runState ?? (turnRunning || selectedSessionLiveRun ? "running" : null));
  const isSelectedSessionRunning = selectedSessionRunState === "running" || turnRunning;
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
  const activePathReference = useMemo(
    () => (snapshot ? getActivePathReference(activeComposerText, composerCaret) : null),
    [activeComposerText, composerCaret, snapshot],
  );
  const isEditingPathReference = activePathReference !== null;
  const normalizedActivePathQuery = activePathReference?.query.trim() ?? "";
  const previewDraft = useMemo(
    () => removeActivePathReference(activeComposerText, activePathReference),
    [activeComposerText, activePathReference],
  );
  const previewUserMessage = useMemo(
    () => (isEditingPathReference ? previewDraft : activeComposerText),
    [activeComposerText, isEditingPathReference, previewDraft],
  );
  const previewPathReferenceCandidates = useMemo(
    () => extractTextReferenceCandidates(previewDraft),
    [previewDraft],
  );
  const hasPreviewPathReferenceCandidates = previewPathReferenceCandidates.length > 0;
  const previewPathReferenceSignature = useMemo(
    () => previewPathReferenceCandidates.join("\u001f"),
    [previewPathReferenceCandidates],
  );
  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const sessionId = activeRunSessionId;
    if (!withmateApi || !sessionId || isMergeView) {
      setComposerPreview(createEmptyComposerPreview());
      return () => {
        active = false;
      };
    }

    if (!hasPreviewPathReferenceCandidates) {
      setComposerPreview(createEmptyComposerPreview());
      return () => {
        active = false;
      };
    }

    if (isComposerImeComposing) {
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      const previewRequest = activeAuxiliarySession
        ? withmateApi.previewComposerInput(sessionId, previewUserMessage)
        : withmateApi.previewCompanionComposerInput(sessionId, previewUserMessage);
      void previewRequest.then((preview) => {
        if (active) {
          setComposerPreview(preview);
        }
      }).catch((error) => {
        if (active) {
          setComposerPreview({
            attachments: [],
            errors: [error instanceof Error ? error.message : "添付の解決に失敗したよ。"],
          });
        }
      });
    }, isEditingPathReference ? COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS : COMPOSER_PREVIEW_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    hasPreviewPathReferenceCandidates,
    isComposerImeComposing,
    isEditingPathReference,
    isMergeView,
    previewPathReferenceSignature,
    previewUserMessage,
    activeAuxiliarySession,
    activeRunSessionId,
  ]);
  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const sessionId = snapshot?.session.id ?? null;

    if (
      !withmateApi ||
      !sessionId ||
      isMergeView ||
      selectedSessionRunState === "running" ||
      snapshot?.session.status !== "active" ||
      isComposerImeComposing ||
      !isEditingPathReference ||
      normalizedActivePathQuery.length < WORKSPACE_PATH_QUERY_MIN_LENGTH
    ) {
      setWorkspacePathMatches([]);
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      void withmateApi.searchCompanionWorkspaceFiles(sessionId, normalizedActivePathQuery).then((matches) => {
        if (active) {
          setWorkspacePathMatches(matches);
        }
      }).catch(() => {
        if (active) {
          setWorkspacePathMatches([]);
        }
      });
    }, WORKSPACE_PATH_SEARCH_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    isComposerImeComposing,
    isEditingPathReference,
    isMergeView,
    normalizedActivePathQuery,
    selectedSessionRunState,
    snapshot?.session.id,
    snapshot?.session.status,
  ]);
  useEffect(() => {
    setActiveWorkspacePathMatchIndex(workspacePathMatches.length > 0 ? 0 : -1);
  }, [workspacePathMatches]);
  const {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailResizing,
    handleStartContextRailResize,
  } = useSessionContextRail({
    ownerKey: snapshot?.session.id ?? null,
    enabled: !isMergeView,
  });
  const companionMessageListScrollSignature = useMemo(
    () =>
      [
        displayedSession?.id ?? "",
        displayedSession?.runState ?? "",
        messageListMessages.map((message) => `${message.role}:${message.text.length}:${message.text}`).join("\u001d"),
        selectedSessionLiveRun?.assistantText ?? "",
        selectedSessionLiveRun?.reasoningText ?? "",
        selectedSessionLiveRun?.errorMessage ?? "",
      ].join("\u001a"),
    [
      selectedSessionLiveRun?.assistantText,
      selectedSessionLiveRun?.reasoningText,
      selectedSessionLiveRun?.errorMessage,
      displayedSession?.id,
      displayedSession?.runState,
      messageListMessages,
    ],
  );
  const {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
  } = useSessionMessageListFollowing({
    ownerKey: activeRunSessionId,
    scrollSignature: companionMessageListScrollSignature,
    enabled: !isMergeView,
  });
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
  const runDisabled = isSelectedSessionRunning || operationRunning || !snapshot || snapshot.session.status !== "active";
  const selectedProviderCatalog = getProviderCatalog(modelCatalog?.providers ?? [], displayedSession?.provider);
  const selectedRuntimeModel = activeAuxiliarySession?.model ?? selectedModel;
  const selectedRuntimeReasoningEffort = activeAuxiliarySession?.reasoningEffort ?? selectedReasoningEffort;
  const selectedRuntimeApprovalMode = activeAuxiliarySession?.approvalMode ?? selectedApprovalMode;
  const selectedRuntimeCodexSandboxMode = activeAuxiliarySession?.codexSandboxMode ?? selectedCodexSandboxMode;
  const selectedModelEntry =
    selectedProviderCatalog?.models.find((model) => model.id === selectedRuntimeModel) ??
    selectedProviderCatalog?.models.find((model) => model.id === selectedProviderCatalog.defaultModelId) ??
    selectedProviderCatalog?.models[0] ??
    null;
  const reasoningEffortOptions = selectedModelEntry?.reasoningEfforts ?? [];
  const auxiliaryLaunchProviderItems = useMemo(
    () => buildAuxiliaryLaunchProviderItems(
      modelCatalog?.providers ?? [],
      (provider) => provider.models.length > 0,
    ),
    [modelCatalog],
  );
  const {
    approvalChoiceOptions: approvalSelectOptions,
    sandboxChoiceOptions: sandboxSelectOptions,
    modelSelectOptions,
    selectedModelFallbackLabel,
    reasoningSelectOptions,
  } = useMemo(
    () => buildRuntimeSelectionOptions({
      providerId: displayedSession?.provider,
      providerCatalog: selectedProviderCatalog,
      models: selectedProviderCatalog?.models ?? [],
      selectedModel: selectedRuntimeModel,
      reasoningEfforts: reasoningEffortOptions,
      selectedApprovalMode: selectedRuntimeApprovalMode,
      selectedCodexSandboxMode: selectedRuntimeCodexSandboxMode,
    }),
    [
      displayedSession?.provider,
      selectedRuntimeModel,
      selectedProviderCatalog,
      reasoningEffortOptions,
      selectedRuntimeApprovalMode,
      selectedRuntimeCodexSandboxMode,
    ],
  );
  const companionComposerBlockedReason = snapshot?.session.status !== "active"
    ? "この Companion は active ではないよ。"
    : "";
  const retryBanner = useMemo<RetryBannerState | null>(() => {
    if (!snapshot || !shouldShowRetryBanner({
      hasActiveAuxiliarySession: !!activeAuxiliarySession,
      hasLastUserMessage: !!lastUserMessage,
      isReadOnly: snapshot.session.status !== "active",
      runState: snapshot.session.runState,
    })) {
      return null;
    }

    const retryLastUserMessage = lastUserMessage;
    if (!retryLastUserMessage) {
      return null;
    }

    const kind = resolveRetryBannerKind({
      runState: snapshot.session.runState,
      latestTerminalAuditLogPhase: latestTerminalAuditLog?.phase,
    });
    if (!kind) {
      return null;
    }

    const stopSummary = buildRetryStopSummary(kind, selectedSessionLiveRun, latestTerminalAuditLog, lastAssistantMessage);
    switch (kind) {
      case "interrupted":
        return {
          kind,
          badge: "中断",
          title: "前回の依頼は中断されたままです",
          stopSummary,
          lastRequestText: retryLastUserMessage.text,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: "前回の依頼は完了できませんでした",
          stopSummary,
          lastRequestText: retryLastUserMessage.text,
        };
      case "canceled":
        return {
          kind,
          badge: "停止",
          title: "この依頼は途中で停止しました",
          stopSummary,
          lastRequestText: retryLastUserMessage.text,
        };
      default:
        return null;
    }
  }, [activeAuxiliarySession, lastAssistantMessage, lastUserMessage, latestTerminalAuditLog, selectedSessionLiveRun, snapshot]);
  const shouldProtectDraftOnRetryEdit = shouldProtectRetryEditDraft({ retryBanner, draft: composerText });
  const isRetryActionDisabled = resolveRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: !!lastUserMessage,
    composerBlocked: !!companionComposerBlockedReason || operationRunning || turnRunning,
    isReadOnly: snapshot?.session.status !== "active",
    runState: selectedSessionRunState,
  });
  const isRetryEditDisabled = isRetryActionDisabled || runDisabled;
  const companionComposerSendabilityBase = useMemo(
    () =>
      buildComposerSendabilityState({
        runState: selectedSessionRunState,
        blockedReason: companionComposerBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: activeComposerText,
      }),
    [activeComposerText, companionComposerBlockedReason, composerPreview.errors, selectedSessionRunState],
  );
  const companionComposerSendability = useMemo(
    () => withForcedComposerBlockedFeedback(companionComposerSendabilityBase, forceComposerBlockedFeedback),
    [companionComposerSendabilityBase, forceComposerBlockedFeedback],
  );
  const isCompanionSendDisabled = companionComposerSendability.isSendDisabled || operationRunning || isAuxiliaryActionPending;
  const companionSendButtonTitle = getComposerSendButtonTitle(companionComposerSendability);
  const shouldForceActionDockExpanded =
    isAgentPickerOpen ||
    isSkillPickerOpen ||
    isAdditionalDirectoryListOpen ||
    workspacePathMatches.length > 0 ||
    isRetryDraftReplacePending ||
    !!retryBanner ||
    companionComposerSendability.shouldShowFeedback;
  const isActionDockExpanded = isActionDockPinnedExpanded || shouldForceActionDockExpanded;
  const canCollapseActionDock = !shouldForceActionDockExpanded;
  const retryBannerIdentity = useMemo(() => {
    if (!retryBanner || !snapshot || !lastUserMessage) {
      return null;
    }

    const lastUserMessageIdentity = `${
      snapshot.session.messages.filter((message) => message.role === "user").length
    }:${lastUserMessage.text}`;
    const canceledAuditLogIdentity =
      retryBanner.kind === "canceled" && latestTerminalAuditLog
        ? `${latestTerminalAuditLog.id}:${latestTerminalAuditLog.phase}:${latestTerminalAuditLog.createdAt}`
        : "";

    return [retryBanner.kind, lastUserMessageIdentity, canceledAuditLogIdentity].join("\u001f");
  }, [lastUserMessage, latestTerminalAuditLog, retryBanner, snapshot]);
  useEffect(() => {
    if (!composerText.trim() || !retryBanner) {
      setIsRetryDraftReplacePending(false);
    }
  }, [composerText, retryBanner]);
  useLayoutEffect(() => {
    if (!retryBanner) {
      setIsRetryDetailsOpen(false);
      return;
    }

    setIsRetryDetailsOpen(defaultRetryBannerDetailsOpen(retryBanner.kind));
  }, [retryBanner?.kind, retryBannerIdentity, snapshot?.session.id]);
  const actionDockCompactPreview = useMemo(
    () =>
      buildActionDockCompactPreview(activeComposerText, isSelectedSessionRunning, {
        truncationSuffix: "...",
      }),
    [activeComposerText, isSelectedSessionRunning],
  );
  const companionCharacterProfile = displayedSession ? buildCompanionCharacterProfile(displayedSession) : null;
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
        };
      }),
    [availableSkills],
  );
  const additionalDirectoryItems = useMemo(
    () =>
      (displayedSession?.allowedAdditionalDirectories ?? []).map((directoryPath) => {
        const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
        return {
          key: directoryPath,
          path: directoryPath,
          primaryLabel: directoryDisplay.primaryLabel,
          secondaryLabel: directoryDisplay.secondaryLabel,
          title: directoryDisplay.title,
          canRemove: displayedSession?.provider === "codex",
        };
      }),
    [displayedSession],
  );
  const composerAttachmentItems = useMemo(
    () =>
      composerPreview.attachments.map((attachment) => {
        const attachmentDisplay = buildComposerAttachmentDisplay(attachment);
        return {
          key: attachment.id,
          kind: attachment.kind,
          kindLabel: attachmentDisplay.kindLabel,
          locationLabel: attachmentDisplay.locationLabel,
          primaryLabel: attachmentDisplay.primaryLabel,
          secondaryLabel: attachmentDisplay.secondaryLabel,
          title: attachmentDisplay.title,
          removeTargets: [
            attachment.workspaceRelativePath,
            attachment.displayPath,
            normalizePathForReference(attachment.absolutePath),
          ].filter((value): value is string => !!value),
        };
      }),
    [composerPreview.attachments],
  );
  const workspacePathMatchItems = useMemo(
    () =>
      workspacePathMatches.map((match, index) => {
        const matchDisplay = buildWorkspacePathMatchDisplay(match);
        return {
          key: `${match.kind}:${match.path}`,
          path: match.path,
          kind: match.kind,
          kindLabel: matchDisplay.kindLabel,
          primaryLabel: matchDisplay.primaryLabel,
          secondaryLabel: matchDisplay.secondaryLabel,
          title: matchDisplay.title,
          isActive: index === activeWorkspacePathMatchIndex,
        };
      }),
    [activeWorkspacePathMatchIndex, workspacePathMatches],
  );
  const selectedProviderQuotaTelemetry =
    displayedSession?.provider && providerQuotaTelemetryState.ownerProviderId === displayedSession.provider
      ? providerQuotaTelemetryState.telemetry
      : null;
  const selectedSessionContextTelemetry =
    displayedSession && sessionContextTelemetryState.ownerSessionId === displayedSession.id
      ? sessionContextTelemetryState.telemetry
      : null;
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
    if (!availableContextPaneTabs.includes(activeContextPaneTab)) {
      setActiveContextPaneTab(availableContextPaneTabs[0] ?? "latest-command");
    }
  }, [activeContextPaneTab, availableContextPaneTabs]);

  function handleCycleContextPaneTab(direction: -1 | 1): void {
    setActiveContextPaneTab((current) => cycleContextPaneTab(current, direction, availableContextPaneTabs));
  }

  function toggleArtifact(artifactKey: string): void {
    setExpandedArtifacts((current) => ({
      ...current,
      [artifactKey]: !current[artifactKey],
    }));
  }

  async function openDiffWindow(payload: DiffPreviewPayload): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi) {
      return;
    }

    await withmateApi.openDiffWindow(payload);
  }

  function handleCopyMessageText(text: string): void {
    void copyMessageTextToClipboard(
      text,
      (normalized) => navigator.clipboard.writeText(normalized),
    ).catch((error) => {
      console.error(error);
      setErrorMessage("コピーに失敗したよ。");
    });
  }

  function handleQuoteMessageText(text: string): void {
    if (runDisabled) {
      setForceComposerBlockedFeedback(true);
      composerTextareaRef.current?.focus();
      return;
    }

    const textarea = composerTextareaRef.current;
    const insertion = createQuotedMessageInsertion(
      text,
      activeComposerText,
      textarea?.selectionStart ?? composerCaret,
    );
    if (!insertion) {
      return;
    }
    const { draft: nextDraft, caret: nextCaret } = insertion;
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setComposerText(nextDraft);
    }

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  }

  function insertReferencePaths(selectedPaths: string[]): void {
    if (selectedPaths.length === 0) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const currentCaret = textarea?.selectionStart ?? composerCaret;
    const referenceTokens = selectedPaths.map((selectedPath) => {
      const referencePath = snapshot
        ? toWorkspaceRelativeReference(snapshot.session.worktreePath, selectedPath) ?? normalizePathForReference(selectedPath)
        : normalizePathForReference(selectedPath);
      return formatPathReference(referencePath);
    });
    const leadingSpacer = currentCaret > 0 && !/\s/.test(activeComposerText[currentCaret - 1] ?? "") ? " " : "";
    const trailingSpacer = activeComposerText.length > currentCaret && !/\s/.test(activeComposerText[currentCaret] ?? "") ? " " : "";
    const insertion = `${leadingSpacer}${referenceTokens.join(" ")}${trailingSpacer}`;
    const nextDraft = `${activeComposerText.slice(0, currentCaret)}${insertion}${activeComposerText.slice(currentCaret)}`;
    const nextCaret = currentCaret + insertion.length;

    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setComposerText(nextDraft);
    }

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  }

  function insertReferencePath(selectedPath: string): void {
    insertReferencePaths([selectedPath]);
  }

  async function pickAndInsertPath(kind: "file" | "folder" | "image"): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }
    const basePath = pickerBaseDirectory || snapshot.session.worktreePath || snapshot.session.repoRoot;
    const selectedPath = kind === "folder"
      ? await withmateApi.pickDirectory(basePath)
      : kind === "image"
        ? await withmateApi.pickImageFile(basePath)
        : await withmateApi.pickFile(basePath);
    if (selectedPath) {
      setPickerBaseDirectory(kind === "folder" ? selectedPath : toDirectoryPath(selectedPath));
      insertReferencePath(selectedPath);
    }
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

    setPickerBaseDirectory(toDirectoryPath(selectedPaths[0]));
    insertReferencePaths(savedPaths);
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

    setPickerBaseDirectory(toDirectoryPath(selectedPaths[0]));
    insertReferencePaths(selectedPaths);
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || runDisabled) {
      return;
    }

    const files = Array.from(event.clipboardData.files);
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const pastedFiles = files.length > 0 ? files : itemFiles;
    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const savedPaths: string[] = [];
    for (const file of pastedFiles) {
      const buffer = await file.arrayBuffer();
      const fileName = file.name.trim() || `pasted-${currentTimestampLabel().replace(/[:/\\\s]+/g, "-")}.png`;
      const savedPath = await withmateApi.savePastedSessionFile({
        sessionId: snapshot.session.id,
        fileName,
        data: buffer,
      });
      savedPaths.push(savedPath);
    }

    insertReferencePaths(savedPaths);
  }

  async function handleAddAdditionalDirectory(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || isSelectedSessionRunning) {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || snapshot.session.worktreePath || snapshot.session.repoRoot);
    if (!selectedPath) {
      return;
    }

    const currentDirectories = snapshot.session.allowedAdditionalDirectories ?? [];
    const nextDirectories = Array.from(new Set([...currentDirectories, selectedPath]));
    await persistCompanionSession({
      ...snapshot.session,
      allowedAdditionalDirectories: nextDirectories,
      updatedAt: currentTimestampLabel(),
    });
    setPickerBaseDirectory(selectedPath);
  }

  async function handleRemoveAdditionalDirectory(directoryPath: string): Promise<void> {
    if (!snapshot || snapshot.session.provider !== "codex" || isSelectedSessionRunning) {
      return;
    }

    const currentDirectories = snapshot.session.allowedAdditionalDirectories ?? [];
    const nextDirectories = currentDirectories.filter((entry) => entry !== directoryPath);
    if (nextDirectories.length === currentDirectories.length) {
      return;
    }

    await persistCompanionSession({
      ...snapshot.session,
      allowedAdditionalDirectories: nextDirectories,
      updatedAt: currentTimestampLabel(),
    });
  }

  function handleSelectWorkspacePathMatch(match: string): void {
    const textarea = composerTextareaRef.current;
    const activeReference = getActivePathReference(activeComposerText, composerCaret);
    if (!textarea || !activeReference) {
      return;
    }

    const replacement = formatPathReference(match);
    const nextDraft = `${activeComposerText.slice(0, activeReference.start)}${replacement}${activeComposerText.slice(activeReference.end)}`;
    const nextCaret = activeReference.start + replacement.length;
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setComposerText(nextDraft);
    }

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  }

  function handleRemoveAttachmentReference(attachmentPathCandidates: string[]): void {
    const escapedCandidates = attachmentPathCandidates
      .map((candidate) => formatPathReference(candidate))
      .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    let nextDraft = activeComposerText;
    for (const escapedCandidate of escapedCandidates) {
      nextDraft = nextDraft.replace(
        new RegExp(`(^|[\\s(])${escapedCandidate}(?=\\s|$|[),.;:!?])`),
        (_match, leadingWhitespace: string) => leadingWhitespace || "",
      );
    }

    nextDraft = nextDraft
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");

    setComposerCaret(nextDraft.length);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextDraft.length);
    } else {
      setComposerText(nextDraft);
    }
  }

  function handleSelectSkill(skill: DiscoveredSkill): void {
    const textarea = composerTextareaRef.current;
    if (!snapshot) {
      return;
    }

    const snippet = buildSkillPromptSnippet(snapshot.session.provider, skill.name);
    const trimmedDraft = composerText.trimStart();
    const nextDraft = trimmedDraft ? `${snippet}\n\n${trimmedDraft}` : `${snippet}\n`;
    const nextCaret = nextDraft.length;

    setIsActionDockPinnedExpanded(true);
    setComposerText(nextDraft);
    setComposerCaret(nextCaret);
    setIsSkillPickerOpen(false);

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  }

  async function handleSelectCustomAgent(agent: DiscoveredCustomAgent | null): Promise<void> {
    if (!snapshot || snapshot.session.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === snapshot.session.customAgentName) {
      setIsAgentPickerOpen(false);
      return;
    }

    await persistCompanionSession({
      ...snapshot.session,
      customAgentName: nextCustomAgentName,
      updatedAt: currentTimestampLabel(),
    });
    setIsAgentPickerOpen(false);
  }

  async function handleChangeApproval(approvalMode: ApprovalMode): Promise<void> {
    if (!snapshot || isSelectedSessionRunning || approvalMode === snapshot.session.approvalMode) {
      return;
    }

    await persistCompanionSession({
      ...snapshot.session,
      approvalMode,
      updatedAt: currentTimestampLabel(),
    });
  }

  async function handleChangeCodexSandboxMode(codexSandboxMode: CodexSandboxMode): Promise<void> {
    if (
      !snapshot ||
      snapshot.session.provider !== "codex" ||
      isSelectedSessionRunning ||
      codexSandboxMode === snapshot.session.codexSandboxMode
    ) {
      return;
    }

    await persistCompanionSession({
      ...snapshot.session,
      codexSandboxMode,
      updatedAt: currentTimestampLabel(),
    });
  }

  async function handleChangeSelectedModel(model: string): Promise<void> {
    if (!snapshot || !selectedProviderCatalog || !modelCatalog || isSelectedSessionRunning) {
      return;
    }

    const selection = resolveModelChangeSelection(selectedProviderCatalog, model, snapshot.session.reasoningEffort);
    await persistCompanionSession({
      ...snapshot.session,
      catalogRevision: modelCatalog.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      updatedAt: currentTimestampLabel(),
    });
  }

  async function handleChangeReasoningEffort(reasoningEffort: ModelReasoningEffort): Promise<void> {
    if (!snapshot || !selectedProviderCatalog || !modelCatalog || isSelectedSessionRunning) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, snapshot.session.model, reasoningEffort);
    await persistCompanionSession({
      ...snapshot.session,
      catalogRevision: modelCatalog.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      updatedAt: currentTimestampLabel(),
    });
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
    return savedSession;
  }

  async function updateActiveAuxiliarySession(recipe: (current: AuxiliarySession) => AuxiliarySession): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    await auxiliaryDraftSaveQueueRef.current.catch(() => undefined);
    const currentSession = activeAuxiliarySessionRef.current ?? activeAuxiliarySession;
    if (currentSession.id !== activeAuxiliarySession.id || currentSession.runState === "running") {
      return;
    }

    const nextSession = recipe(currentSession);
    activeAuxiliarySessionRef.current = nextSession;
    setActiveAuxiliarySession(nextSession);
    const saved = await withmateApi.updateAuxiliarySession(nextSession);
    activeAuxiliarySessionRef.current = saved;
    setActiveAuxiliarySession(saved);
  }

  function handleOpenAuxiliaryLaunchDialog(): void {
    if (!snapshot || isAuxiliaryActionPending || operationRunning || isSelectedSessionRunning) {
      return;
    }

    openAuxiliaryLaunchDialog({
      providers: auxiliaryLaunchProviderItems,
      selectedProviderId: snapshot.session.provider,
    });
  }

  function handleCloseAuxiliaryLaunchDialog(): void {
    if (isAuxiliaryActionPending) {
      return;
    }

    closeAuxiliaryLaunchDialog();
  }

  function handleSelectAuxiliaryLaunchProvider(providerId: string): void {
    selectAuxiliaryLaunchProvider(providerId);
  }

  async function handleStartAuxiliarySession(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || isAuxiliaryActionPending) {
      return;
    }
    if (operationRunning || isSelectedSessionRunning || snapshot.session.status !== "active") {
      setAuxiliaryLaunchStartError(new Error("Companion が操作中のため Auxiliary Session を開始できないよ。"));
      return;
    }
    if (!auxiliaryLaunchProviderId) {
      setAuxiliaryLaunchStartError(new Error(AUXILIARY_LAUNCH_NO_SELECTION_FEEDBACK));
      return;
    }

    resetAuxiliaryLaunchFeedback();

    const loadRevision = auxiliaryLoadRevisionRef.current + 1;
    auxiliaryLoadRevisionRef.current = loadRevision;
    const parentSessionId = snapshot.session.id;
    const canApplyLoadResult = () => auxiliaryLoadRevisionRef.current === loadRevision;
    setIsAuxiliaryActionPending(true);
    try {
      const session = await withmateApi.createAuxiliarySession({
        parentSessionId,
        provider: auxiliaryLaunchProviderId,
        model: auxiliaryLaunchProviderId === snapshot.session.provider ? selectedModel : undefined,
        reasoningEffort: auxiliaryLaunchProviderId === snapshot.session.provider ? selectedReasoningEffort : undefined,
        customAgentName: auxiliaryLaunchProviderId === snapshot.session.provider ? snapshot.session.customAgentName : undefined,
      });
      activeAuxiliarySessionRef.current = session;
      setActiveAuxiliarySession(session);
      setIsActionDockPinnedExpanded(true);
      setForceComposerBlockedFeedback(false);
      closeAuxiliaryLaunchDialog();
    } catch (error) {
      setAuxiliaryLaunchStartError(error);
    } finally {
      void loadClosedAuxiliarySessions(parentSessionId, canApplyLoadResult);
      setIsAuxiliaryActionPending(false);
    }
  }

  async function handleReturnToMainSession(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !activeAuxiliarySession || isAuxiliaryActionPending) {
      return;
    }

    setIsAuxiliaryActionPending(true);
    try {
      auxiliaryLoadRevisionRef.current += 1;
      const closedSession = await withmateApi.closeAuxiliarySession(activeAuxiliarySession.id);
      setClosedAuxiliarySessions((current) => [
        ...current.filter((session) => session.id !== closedSession.id),
        closedSession,
      ]);
      activeAuxiliarySessionRef.current = null;
      setActiveAuxiliarySession(null);
      setComposerCaret(Math.min(composerCaret, composerText.length));
      setIsActionDockPinnedExpanded(false);
      setForceComposerBlockedFeedback(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Auxiliary Session の終了に失敗したよ。");
    } finally {
      setIsAuxiliaryActionPending(false);
    }
  }

  async function handleAuxiliaryDraftChange(value: string, selectionStart: number): Promise<void> {
    setForceComposerBlockedFeedback(false);
    setComposerCaret(selectionStart);
    const withmateApi = getWithMateApi();
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    const nextSession = {
      ...activeAuxiliarySession,
      composerDraft: value,
      updatedAt: currentTimestampLabel(),
    };
    activeAuxiliarySessionRef.current = nextSession;
    setActiveAuxiliarySession(nextSession);
    const saveOperation = auxiliaryDraftSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const current = activeAuxiliarySessionRef.current;
        if (!current || current.id !== nextSession.id || current.composerDraft !== value) {
          return null;
        }

        const request = {
          ...current,
          composerDraft: value,
          updatedAt: currentTimestampLabel(),
        };
        const saved = await withmateApi.updateAuxiliarySession(request);
        return { request, saved };
      });
    auxiliaryDraftSaveQueueRef.current = saveOperation.then(() => undefined, () => undefined);
    const result = await saveOperation;
    if (!result) {
      return;
    }

    const { request, saved } = result;
    setActiveAuxiliarySession((current) => {
      if (!current || !hasSameAuxiliaryDraftSaveContext(current, request, { compareStatus: true })) {
        return current;
      }

      activeAuxiliarySessionRef.current = saved;
      return saved;
    });
  }

  async function sendAuxiliaryMessage(messageText: string): Promise<void> {
    const withmateApi = getWithMateApi();
    const userMessage = messageText.trim();
    if (!withmateApi || !snapshot || !activeAuxiliarySession || !userMessage) {
      setForceComposerBlockedFeedback(true);
      return;
    }
    if (activeAuxiliarySession.runState === "running") {
      setForceComposerBlockedFeedback(true);
      return;
    }

    await auxiliaryDraftSaveQueueRef.current.catch(() => undefined);
    const currentAuxiliarySession = activeAuxiliarySessionRef.current ?? activeAuxiliarySession;
    if (currentAuxiliarySession.id !== activeAuxiliarySession.id || currentAuxiliarySession.runState === "running") {
      return;
    }

    const displayAfterMessageIndex =
      currentAuxiliarySession.messages.length === 0
        ? snapshot.session.messages.length - 1
        : currentAuxiliarySession.displayAfterMessageIndex;
    const runningSession: AuxiliarySession = {
      ...currentAuxiliarySession,
      runState: "running",
      composerDraft: "",
      updatedAt: currentTimestampLabel(),
      messages: [...currentAuxiliarySession.messages, { role: "user", text: userMessage }],
      displayAfterMessageIndex,
    };
    activeAuxiliarySessionRef.current = runningSession;
    setActiveAuxiliarySession(runningSession);
    setLiveRunState((current) => createOwnedPendingLiveSessionRunState(
      buildCompanionAuxiliaryRuntimeSession(snapshot.session, runningSession),
      current,
    ));
    setForceComposerBlockedFeedback(false);

    try {
      if (displayAfterMessageIndex !== currentAuxiliarySession.displayAfterMessageIndex) {
        await withmateApi.updateAuxiliarySession({
          ...currentAuxiliarySession,
          displayAfterMessageIndex,
        });
      }
      const saved = await withmateApi.runAuxiliarySessionTurn(currentAuxiliarySession.id, { userMessage });
      activeAuxiliarySessionRef.current = saved;
      setActiveAuxiliarySession(saved);
    } catch (error) {
      console.error(error);
      setLiveRunState((current) => (
        current.ownerSessionId === currentAuxiliarySession.id
          ? { ownerSessionId: currentAuxiliarySession.id, state: null }
          : current
      ));
      activeAuxiliarySessionRef.current = currentAuxiliarySession;
      setActiveAuxiliarySession(currentAuxiliarySession);
      setErrorMessage(error instanceof Error ? error.message : "Auxiliary Session の実行に失敗したよ。");
    }
  }

  async function cancelAuxiliaryRun(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !activeAuxiliarySession || activeAuxiliarySession.runState !== "running") {
      return;
    }

    await withmateApi.cancelAuxiliarySessionRun(activeAuxiliarySession.id);
  }

  async function handleChangeAuxiliaryApproval(approvalMode: ApprovalMode): Promise<void> {
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      approvalMode,
      updatedAt: currentTimestampLabel(),
    }));
  }

  async function handleChangeAuxiliarySandboxMode(codexSandboxMode: CodexSandboxMode): Promise<void> {
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      codexSandboxMode,
      updatedAt: currentTimestampLabel(),
    }));
  }

  async function handleChangeAuxiliaryModel(model: string): Promise<void> {
    if (!selectedProviderCatalog || !modelCatalog) {
      return;
    }

    await updateActiveAuxiliarySession((current) => {
      const selection = resolveModelChangeSelection(selectedProviderCatalog, model, current.reasoningEffort);
      return {
        ...current,
        catalogRevision: modelCatalog.revision,
        model: selection.resolvedModel,
        reasoningEffort: selection.resolvedReasoningEffort,
        updatedAt: currentTimestampLabel(),
      };
    });
  }

  async function handleChangeAuxiliaryReasoningEffort(reasoningEffort: ModelReasoningEffort): Promise<void> {
    if (!selectedProviderCatalog || !modelCatalog) {
      return;
    }

    await updateActiveAuxiliarySession((current) => {
      const selection = resolveModelSelection(selectedProviderCatalog, current.model, reasoningEffort);
      return {
        ...current,
        catalogRevision: modelCatalog.revision,
        model: selection.resolvedModel,
        reasoningEffort: selection.resolvedReasoningEffort,
        updatedAt: currentTimestampLabel(),
      };
    });
  }

  async function handleSelectAuxiliaryCustomAgent(agent: DiscoveredCustomAgent | null): Promise<void> {
    if (!activeAuxiliarySession || activeAuxiliarySession.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === activeAuxiliarySession.customAgentName) {
      setIsAgentPickerOpen(false);
      return;
    }

    await updateActiveAuxiliarySession((current) => ({
      ...current,
      customAgentName: nextCustomAgentName,
      updatedAt: currentTimestampLabel(),
    }));
    setIsAgentPickerOpen(false);
  }

  async function handleSelectAuxiliarySkill(skill: DiscoveredSkill): Promise<void> {
    if (!activeAuxiliarySession) {
      return;
    }

    const snippet = buildSkillPromptSnippet(activeAuxiliarySession.provider, skill.name);
    const trimmedDraft = activeAuxiliarySession.composerDraft.trimStart();
    const nextDraft = trimmedDraft ? `${snippet}\n\n${trimmedDraft}` : `${snippet}\n`;
    const nextCaret = nextDraft.length;

    setIsActionDockPinnedExpanded(true);
    setComposerCaret(nextCaret);
    setIsSkillPickerOpen(false);
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      composerDraft: nextDraft,
      updatedAt: currentTimestampLabel(),
    }));
  }

  async function handleAddAuxiliaryAdditionalDirectory(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!withmateApi || !snapshot || !activeAuxiliarySession || activeAuxiliarySession.runState === "running") {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || snapshot.session.worktreePath || snapshot.session.repoRoot);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(selectedPath);
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      allowedAdditionalDirectories: Array.from(new Set([...current.allowedAdditionalDirectories, selectedPath])),
      updatedAt: currentTimestampLabel(),
    }));
  }

  async function handleRemoveAuxiliaryAdditionalDirectory(directoryPath: string): Promise<void> {
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      allowedAdditionalDirectories: current.allowedAdditionalDirectories.filter((entry) => entry !== directoryPath),
      updatedAt: currentTimestampLabel(),
    }));
  }

  function handleStartTitleEdit(): void {
    if (!snapshot || isSelectedSessionRunning) {
      return;
    }

    setTitleDraft(snapshot.session.taskTitle);
    setIsHeaderExpanded(true);
    setIsEditingTitle(true);
  }

  function handleCancelTitleEdit(): void {
    setTitleDraft(snapshot?.session.taskTitle ?? "");
    setIsEditingTitle(false);
  }

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

  const handleTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSaveTitle();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      handleCancelTitleEdit();
    }
  };

  function handleToggleHeaderExpanded(): void {
    if (isEditingTitle) {
      return;
    }

    setIsHeaderExpanded((current) => !current);
  }

  function handleExpandActionDock(options?: { focusComposer?: boolean }): void {
    setIsActionDockPinnedExpanded(true);

    if (!options?.focusComposer) {
      return;
    }

    restoreCurrentComposerTextareaFocusToEnd(() => composerTextareaRef.current);
  }

  function handleCollapseActionDock(): void {
    if (!canCollapseActionDock) {
      return;
    }

    setIsActionDockPinnedExpanded(false);
  }

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
    const userMessage = messageText.trim();
    if (
      !snapshot
      || !withmateApi
      || operationRunning
      || turnRunning
      || selectedSessionRunState === "running"
      || snapshot.session.status !== "active"
      || !userMessage
    ) {
      setForceComposerBlockedFeedback(true);
      return;
    }

    const previousSnapshot = snapshot;
    let appliedOptimisticState = false;
    setTurnRunning(true);
    setForceComposerBlockedFeedback(false);
    setErrorMessage("");
    setOperationMessage("");
    try {
      const preview = await withmateApi.previewCompanionComposerInput(snapshot.session.id, messageText);
      if (shouldClearDraft || messageText === composerText) {
        setComposerPreview(preview);
      }
      const sendability = buildComposerSendabilityState({
        runState: selectedSessionRunState,
        blockedReason: companionComposerBlockedReason,
        inputErrors: preview.errors,
        draftText: messageText,
      });
      if (sendability.isSendDisabled) {
        throw new Error(sendability.primaryFeedback || "送信できない状態だよ。");
      }

      const runningSession = createOptimisticRunningSessionState(
        snapshot.session,
        userMessage,
        currentTimestampLabel(),
      );
      if (shouldClearDraft) {
        setComposerText("");
      }
      setLiveRunState((current) => createOwnedPendingLiveSessionRunState(runningSession, current));
      setSnapshot((current) => current ? { ...current, session: runningSession } : current);
      appliedOptimisticState = true;

      const nextSession = await withmateApi.runCompanionSessionTurn(snapshot.session.id, {
        userMessage,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        approvalMode: selectedApprovalMode,
        codexSandboxMode: selectedCodexSandboxMode,
      });
      setSnapshot((current) => current ? { ...current, session: nextSession } : current);
      try {
        await reloadSnapshot();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Companion の再読み込みに失敗したよ。");
      }
    } catch (error) {
      if (appliedOptimisticState) {
        if (shouldClearDraft) {
          setComposerText(userMessage);
        }
        setLiveRunState((current) => (
          current.ownerSessionId === previousSnapshot.session.id
            ? { ownerSessionId: previousSnapshot.session.id, state: null }
            : current
        ));
        setSnapshot((current) => current?.session.id === previousSnapshot.session.id ? previousSnapshot : current);
      }
      setErrorMessage(error instanceof Error ? error.message : "Companion の実行に失敗したよ。");
    } finally {
      setTurnRunning(false);
    }
  }

  async function cancelCompanionTurn(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || !isSelectedSessionRunning) {
      return;
    }
    await withmateApi.cancelCompanionSessionRun(snapshot.session.id);
  }

  async function handleResendLastMessage(): Promise<void> {
    if (!lastUserMessage || isRetryActionDisabled) {
      return;
    }

    await sendCompanionTurn(lastUserMessage.text, { clearDraft: false });
  }

  function restoreLastUserMessageToDraft(messageText: string): void {
    const textarea = composerTextareaRef.current;
    const nextDraft = messageText;
    const nextCaret = nextDraft.length;

    setIsActionDockPinnedExpanded(true);
    setComposerText(nextDraft);
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    setIsRetryDraftReplacePending(false);

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  }

  function handleEditLastMessage(): void {
    if (!retryBanner || !lastUserMessage || isRetryEditDisabled) {
      return;
    }

    if (shouldProtectDraftOnRetryEdit) {
      setIsRetryDraftReplacePending(true);
      return;
    }

    restoreLastUserMessageToDraft(lastUserMessage.text);
  }

  function handleConfirmRetryDraftReplace(): void {
    if (!retryBanner || !lastUserMessage || isRetryEditDisabled) {
      return;
    }

    restoreLastUserMessageToDraft(lastUserMessage.text);
  }

  function handleCancelRetryDraftReplace(): void {
    setIsRetryDraftReplacePending(false);
  }

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
      setLiveRunState((current) => {
        if (
          current.ownerSessionId !== sessionId
          || current.state?.approvalRequest?.requestId !== request.requestId
        ) {
          return current;
        }

        return { ownerSessionId: sessionId, state: latestLiveRun };
      });
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
      setLiveRunState((current) => {
        if (
          current.ownerSessionId !== sessionId
          || current.state?.elicitationRequest?.requestId !== request.requestId
        ) {
          return current;
        }

        return { ownerSessionId: sessionId, state: latestLiveRun };
      });
      setElicitationActionRequestId(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "入力要求の処理に失敗したよ。");
      setElicitationActionRequestId(null);
    }
  }

  const handleCompanionDraftKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    const canNavigatePathMatches =
      workspacePathMatches.length > 0 &&
      !isComposerImeComposing &&
      !event.nativeEvent.isComposing;

    if (canNavigatePathMatches) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveWorkspacePathMatchIndex((current) => Math.min(current + 1, workspacePathMatches.length - 1));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveWorkspacePathMatchIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setWorkspacePathMatches([]);
        setActiveWorkspacePathMatchIndex(-1);
        return;
      }

      if (event.key === "Tab") {
        setWorkspacePathMatches([]);
        setActiveWorkspacePathMatchIndex(-1);
        return;
      }

      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
        const activeMatch =
          workspacePathMatches[activeWorkspacePathMatchIndex] ?? workspacePathMatches[0] ?? null;
        if (activeMatch) {
          event.preventDefault();
          handleSelectWorkspacePathMatch(activeMatch.path);
          return;
        }
      }
    }

    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void (activeAuxiliarySession ? sendAuxiliaryMessage(activeAuxiliarySession.composerDraft) : sendCompanionTurn());
    }
  };

  async function openCompanionWorktree(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    try {
      await withmateApi.openPath(snapshot.session.worktreePath);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Explorer を開けなかったよ。");
    }
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

  async function openCompanionSessionFilesDirectory(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    try {
      await withmateApi.openSessionFilesDirectory(snapshot.session.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "session files directory を開けなかったよ。");
    }
  }

  async function openCompanionSessionFilesTerminal(): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi) {
      return;
    }
    try {
      await withmateApi.openSessionFilesTerminal(snapshot.session.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "session files terminal を開けなかったよ。");
    }
  }

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

  const auxiliaryHeaderActions = snapshot
    ? createAuxiliaryHeaderActions({
        isActive: !!activeAuxiliarySession,
        showIdleLabel: true,
        startDisabled: isAuxiliaryActionPending || operationRunning || isSelectedSessionRunning || snapshot.session.status !== "active",
        returnDisabled: isAuxiliaryActionPending || activeAuxiliarySession?.runState === "running",
        onStart: handleOpenAuxiliaryLaunchDialog,
        onReturnToMain: () => void handleReturnToMainSession(),
      })
    : null;

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
      <>
      <ChatWindow {...buildCompanionChatWindowProps({
        session: displayedSession ?? snapshot.session,
        character: companionCharacterProfile ?? buildCompanionCharacterProfile(displayedSession ?? snapshot.session),
        displayedMessages: messageListMessages,
        displayedMessageKeys: messageListKeys,
        displayedMessageGroups: messageListGroups,
        expandedArtifacts,
        themeStyle,
        workbenchRef: sessionWorkbenchRef,
        workbenchStyle: sessionWorkbenchStyle,
        isHeaderExpanded,
        isEditingTitle,
        titleDraft,
        isRunning: isSelectedSessionRunning,
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
        isRetryDetailsOpen,
        isRetryActionDisabled,
        isRetryEditDisabled,
        isRetryDraftReplacePending,
        isActionDockExpanded,
        composerBlocked: snapshot.session.status !== "active" || operationRunning,
        isAgentPickerOpen,
        isSkillPickerOpen,
        isAdditionalDirectoryListOpen,
        selectedCustomAgentLabel: displayedSession?.provider === "copilot" ? selectedCustomAgentDisplay.label : "Agent",
        selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択",
        canCollapseActionDock,
        isCustomAgentListLoading,
        isSkillListLoading,
        customAgentItems,
        skillItems,
        attachmentItems: composerAttachmentItems,
        additionalDirectoryItems,
        workspacePathMatchItems,
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
        modelOptions: modelSelectOptions,
        selectedModel: selectedRuntimeModel,
        selectedModelFallbackLabel,
        reasoningOptions: reasoningSelectOptions,
        selectedReasoningEffort: selectedRuntimeReasoningEffort,
        actionDockCompactPreview,
        attachmentCount: composerPreview.attachments.length,
        isContextRailResizing,
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
        auditLogSourceLabel: "Companion",
        auditLogDetails,
        auditLogOperationDetails,
        auditLogsHasMore: auditLogsState.ownerSessionId === snapshot.session.id ? auditLogsState.hasMore : false,
        auditLogsLoading: auditLogsState.ownerSessionId === snapshot.session.id ? auditLogsState.loading : false,
        auditLogsTotal: auditLogsState.ownerSessionId === snapshot.session.id
          ? Math.max(auditLogsState.total, displayedSessionAuditLogs.length)
          : displayedSessionAuditLogs.length,
        auditLogsErrorMessage: auditLogsState.ownerSessionId === snapshot.session.id ? auditLogsState.errorMessage : null,
        toastMessage: errorMessage || operationMessage,
        toastTone: errorMessage ? "error" : "success",
        headerActions: auxiliaryHeaderActions,
        isAuxiliaryMode,
        onToggleHeaderExpanded: handleToggleHeaderExpanded,
        onToggleContextPaneHeaderExpanded: () => setIsHeaderExpanded((current) => !current),
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
          loadProjectedMessageArtifact({
            source: messageListSources[messageIndex],
            loadSessionArtifact: (sourceMessageIndex) =>
              withmateApi?.getCompanionMessageArtifact(snapshot.session.id, sourceMessageIndex) ?? null,
          }),
        onOpenDiff: (title, file) =>
          setSelectedDiff({
            title,
            file,
            themeColors: snapshot.session.characterThemeColors,
          }),
        onResolveLiveApproval: (request, decision) => void handleResolveCompanionLiveApproval(request, decision),
        onResolveLiveElicitation: (request, response) => void handleResolveCompanionLiveElicitation(request, response),
        onOpenInlinePath: (target) => openCompanionInlinePath(getWithMateApi(), target, snapshot.session.worktreePath),
        onCopyMessageText: handleCopyMessageText,
        onQuoteMessageText: handleQuoteMessageText,
        onToggleRetryDetails: () => setIsRetryDetailsOpen((current) => !current),
        onResendLastMessage: () => void handleResendLastMessage(),
        onEditLastMessage: handleEditLastMessage,
        onConfirmRetryDraftReplace: handleConfirmRetryDraftReplace,
        onCancelRetryDraftReplace: handleCancelRetryDraftReplace,
        onPickFile: () => void pickAndInsertPath("file"),
        onPickFolder: () => void pickAndInsertPath("folder"),
        onPickImage: () => void pickAndInsertPath("image"),
        onAddToSessionFiles: () => void addToSessionFiles(),
        onPickSessionFiles: () => void pickSessionFiles(),
        onToggleAgentPicker: () => {
          setIsSkillPickerOpen(false);
          setIsAgentPickerOpen((current) => !current);
        },
        onToggleSkillPicker: () => {
          setIsAgentPickerOpen(false);
          setIsSkillPickerOpen((current) => !current);
        },
        onAddAdditionalDirectory: () => void (activeAuxiliarySession ? handleAddAuxiliaryAdditionalDirectory() : handleAddAdditionalDirectory()),
        onToggleAdditionalDirectoryList: () => setIsAdditionalDirectoryListOpen((current) => !current),
        onCollapseActionDock: handleCollapseActionDock,
        onJumpToMessageListBottom: handleJumpToMessageListBottom,
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
          setForceComposerBlockedFeedback(false);
          setComposerText(value);
          setComposerCaret(selectionStart);
        },
        onDraftFocus: () => setIsActionDockPinnedExpanded(true),
        onDraftKeyDown: handleCompanionDraftKeyDown,
        onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void handleComposerPaste(event),
        onDraftSelect: buildOnDraftSelectHandler({
          setComposerCaret,
        }),
        onDraftCompositionStart: buildOnDraftCompositionStartHandler({
          setIsComposerImeComposing,
        }),
        onDraftCompositionEnd: buildOnDraftCompositionEndHandler({
          setComposerCaret,
          setIsComposerImeComposing,
          getSelectionStart: () => composerTextareaRef.current?.selectionStart,
          getFallbackSelectionStart: () => activeComposerText.length,
        }),
        onSendOrCancel: buildAuxiliaryAwareSendOrCancelHandler({
          shouldSendAuxiliary: !!activeAuxiliarySession,
          isAuxiliarySessionRunning: activeAuxiliarySession?.runState === "running",
          isSelectedSessionRunning,
          onCancelAuxiliaryRun: cancelAuxiliaryRun,
          onSendAuxiliary: () => sendAuxiliaryMessage(activeAuxiliarySession?.composerDraft ?? ""),
          onCancelSelectedSessionRun: cancelCompanionTurn,
          onSendSelectedSession: sendCompanionTurn,
        }),
        onExpandActionDock: () => handleExpandActionDock({ focusComposer: !isSelectedSessionRunning }),
        onSelectWorkspacePathMatch: handleSelectWorkspacePathMatch,
        onActivateWorkspacePathMatch: setActiveWorkspacePathMatchIndex,
        onChangeApprovalMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<ApprovalMode>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliaryApproval,
          onSelectedSessionChange: handleChangeApproval,
        }),
        onChangeCodexSandboxMode: buildAuxiliaryAwareRuntimeOptionChangeHandler<CodexSandboxMode>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliarySandboxMode,
          onSelectedSessionChange: handleChangeCodexSandboxMode,
        }),
        onChangeModel: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: handleChangeAuxiliaryModel,
          onSelectedSessionChange: handleChangeSelectedModel,
        }),
        onChangeReasoningEffort: buildAuxiliaryAwareRuntimeOptionChangeHandler<string>({
          shouldUseAuxiliary: !!activeAuxiliarySession,
          onAuxiliaryChange: (value) => handleChangeAuxiliaryReasoningEffort(value as ModelReasoningEffort),
          onSelectedSessionChange: (value) => handleChangeReasoningEffort(value as ModelReasoningEffort),
        }),
        onStartContextRailResize: handleStartContextRailResize,
        onCycleContextPaneTab: handleCycleContextPaneTab,
        onOpenCompanionReview: (sessionId) => void getWithMateApi()?.openCompanionReviewWindow(sessionId),
        onCloseDiff: () => setSelectedDiff(null),
        onOpenDiffWindow: (payload) => void openDiffWindow(payload),
        onLoadMoreAuditLogs: handleLoadMoreAuditLogs,
        onLoadAuditLogDetail: handleLoadAuditLogDetail,
        onLoadAuditLogOperationDetail: handleLoadAuditLogOperationDetail,
        onCloseAuditLog: () => setAuditLogsOpen(false),
      })} />
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

  return (
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
            onToggleExpanded={handleToggleHeaderExpanded}
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
  );
}
