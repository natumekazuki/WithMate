import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { ApprovalMode } from "./approval-mode.js";
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
  getProviderCatalog,
  resolveModelChangeSelection,
  resolveModelSelection,
  type ModelCatalogSnapshot,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCompanionGroupMonitorEntries } from "./home-session-projection.js";
import {
  SessionAuditLogModal,
  SessionContextPane,
  SessionDiffModal,
  SessionChatWindow,
  SessionHeader,
  SessionHeaderHandle,
  SessionPaneErrorBoundary,
} from "./session-components.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  withForcedComposerBlockedFeedback,
} from "./session-composer-feedback.js";
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
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandView,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  resolveAutoContextPaneTab,
  resolveAvailableContextPaneTabs,
  type ContextPaneTabKey,
} from "./session-ui-projection.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import { fileKindLabel, modelOptionLabel, reasoningDepthLabel } from "./ui-utils.js";
import {
  getApprovalOptionsForProvider,
  getSandboxOptionsForProvider,
} from "./provider-runtime-options.js";
import { extractTextReferenceCandidates } from "./path-reference.js";
import type { WorkspacePathCandidate } from "./workspace-path-candidate.js";

function pickInitialFile(files: ChangedFile[]): ChangedFile | null {
  return files[0] ?? null;
}

const EMPTY_COMPOSER_PREVIEW: ComposerPreview = { attachments: [], errors: [] };
const COMPOSER_PREVIEW_DEBOUNCE_MS = 120;
const COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS = 280;
const WORKSPACE_PATH_QUERY_MIN_LENGTH = 2;
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

export default function CompanionReviewApp() {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const viewMode = getCompanionWindowViewFromSearch(window.location.search);
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
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>(EMPTY_COMPOSER_PREVIEW);
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
    setComposerPreview(EMPTY_COMPOSER_PREVIEW);
    setPickerBaseDirectory(snapshot?.session.worktreePath ?? "");
    setComposerCaret(0);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    setIsComposerImeComposing(false);
  }, [snapshot?.session.id]);

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

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const sessionId = snapshot?.session.id ?? null;
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
      }
    });

    const unsubscribe = withmateApi.subscribeLiveSessionRun((nextSessionId, state) => {
      if (active && nextSessionId === sessionId) {
        setLiveRunState({ ownerSessionId: nextSessionId, state });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [isMergeView, snapshot?.session.id]);

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
    const session = snapshot?.session ?? null;
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
  }, [isMergeView, snapshot?.session.provider, snapshot?.session.worktreePath]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const session = snapshot?.session ?? null;
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
  }, [isMergeView, snapshot?.session.provider, snapshot?.session.worktreePath]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const providerId = snapshot?.session.provider ?? null;
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
  }, [isMergeView, snapshot?.session.provider]);

  useEffect(() => {
    let active = true;
    const withmateApi = getWithMateApi();
    const sessionId = snapshot?.session.id ?? null;
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
  }, [isMergeView, snapshot?.session.id]);

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
    snapshot && liveRunState.ownerSessionId === snapshot.session.id ? liveRunState.state : null;
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
  const selectedSessionRunState = selectedSessionLiveRun ? "running" : snapshot?.session.runState ?? null;
  const isSelectedSessionRunning = selectedSessionRunState === "running" || turnRunning;
  const activePathReference = useMemo(
    () => (snapshot ? getActivePathReference(composerText, composerCaret) : null),
    [composerCaret, composerText, snapshot],
  );
  const isEditingPathReference = activePathReference !== null;
  const normalizedActivePathQuery = activePathReference?.query.trim() ?? "";
  const previewDraft = useMemo(
    () => removeActivePathReference(composerText, activePathReference),
    [activePathReference, composerText],
  );
  const previewUserMessage = useMemo(
    () => (isEditingPathReference ? previewDraft : composerText),
    [composerText, isEditingPathReference, previewDraft],
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
    const sessionId = snapshot?.session.id ?? null;
    if (!withmateApi || !sessionId || isMergeView) {
      setComposerPreview(EMPTY_COMPOSER_PREVIEW);
      return () => {
        active = false;
      };
    }

    if (!hasPreviewPathReferenceCandidates) {
      setComposerPreview(EMPTY_COMPOSER_PREVIEW);
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
      void withmateApi.previewCompanionComposerInput(sessionId, previewUserMessage).then((preview) => {
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
    snapshot?.session.id,
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
    }, 100);

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
        snapshot?.session.id ?? "",
        snapshot?.session.runState ?? "",
        snapshot?.session.messages.map((message) => `${message.role}:${message.text.length}:${message.text}`).join("\u001d") ?? "",
        selectedSessionLiveRun?.assistantText ?? "",
        selectedSessionLiveRun?.errorMessage ?? "",
      ].join("\u001a"),
    [
      selectedSessionLiveRun?.assistantText,
      selectedSessionLiveRun?.errorMessage,
      snapshot?.session.id,
      snapshot?.session.messages,
      snapshot?.session.runState,
    ],
  );
  const {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
  } = useSessionMessageListFollowing({
    ownerKey: snapshot?.session.id ?? null,
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
  const selectedProviderCatalog = getProviderCatalog(modelCatalog?.providers ?? [], snapshot?.session.provider);
  const selectedModelEntry =
    selectedProviderCatalog?.models.find((model) => model.id === selectedModel) ??
    selectedProviderCatalog?.models.find((model) => model.id === selectedProviderCatalog.defaultModelId) ??
    selectedProviderCatalog?.models[0] ??
    null;
  const reasoningEffortOptions = selectedModelEntry?.reasoningEfforts ?? [];
  const modelSelectOptions = (selectedProviderCatalog?.models ?? []).map((model) => ({
    value: model.id,
    label: modelOptionLabel(model),
  }));
  const selectedModelFallbackLabel = selectedModelEntry ? modelOptionLabel(selectedModelEntry) : selectedModel;
  const reasoningSelectOptions = reasoningEffortOptions.map((reasoningEffort) => ({
    value: reasoningEffort,
    label: reasoningDepthLabel(reasoningEffort),
  }));
  const approvalSelectOptions = useMemo(
    () => {
      const options = getApprovalOptionsForProvider(snapshot?.session.provider);
      if (!snapshot || options.some((option) => option.value === selectedApprovalMode)) {
        return options;
      }

      return [{ value: selectedApprovalMode, label: selectedApprovalMode }, ...options];
    },
    [selectedApprovalMode, snapshot?.session.provider],
  );
  const sandboxSelectOptions = useMemo(
    () => {
      const options = getSandboxOptionsForProvider(snapshot?.session.provider);
      if (!snapshot || options.some((option) => option.value === selectedCodexSandboxMode)) {
        return options;
      }

      return [{ value: selectedCodexSandboxMode, label: selectedCodexSandboxMode }, ...options];
    },
    [selectedCodexSandboxMode, snapshot?.session.provider],
  );
  const companionComposerBlockedReason = snapshot?.session.status !== "active"
    ? "この Companion は active ではないよ。"
    : "";
  const companionComposerSendabilityBase = useMemo(
    () =>
      buildComposerSendabilityState({
        runState: selectedSessionRunState,
        blockedReason: companionComposerBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: composerText,
      }),
    [companionComposerBlockedReason, composerPreview.errors, composerText, selectedSessionRunState],
  );
  const companionComposerSendability = useMemo(
    () => withForcedComposerBlockedFeedback(companionComposerSendabilityBase, forceComposerBlockedFeedback),
    [companionComposerSendabilityBase, forceComposerBlockedFeedback],
  );
  const isCompanionSendDisabled = companionComposerSendability.isSendDisabled || operationRunning;
  const companionSendButtonTitle = getComposerSendButtonTitle(companionComposerSendability);
  const shouldForceActionDockExpanded =
    isAgentPickerOpen ||
    isSkillPickerOpen ||
    isAdditionalDirectoryListOpen ||
    workspacePathMatches.length > 0 ||
    companionComposerSendability.shouldShowFeedback;
  const isActionDockExpanded = isActionDockPinnedExpanded || shouldForceActionDockExpanded;
  const canCollapseActionDock = !shouldForceActionDockExpanded;
  const actionDockCompactPreview = useMemo(() => {
    const normalizedDraft = composerText.replace(/\s+/g, " ").trim();
    if (normalizedDraft) {
      return normalizedDraft.length > 84 ? `${normalizedDraft.slice(0, 84)}...` : normalizedDraft;
    }

    if (isSelectedSessionRunning) {
      return "実行中";
    }

    return "下書きなし";
  }, [composerText, isSelectedSessionRunning]);
  const companionCharacterProfile = snapshot ? buildCompanionCharacterProfile(snapshot.session) : null;
  const selectedCustomAgent = useMemo(() => {
    if (!snapshot?.session.customAgentName.trim()) {
      return null;
    }

    return availableCustomAgents.find((agent) => agent.name === snapshot.session.customAgentName) ?? null;
  }, [availableCustomAgents, snapshot?.session.customAgentName]);
  const selectedCustomAgentDisplay = useMemo(
    () => buildSelectedCustomAgentDisplay(snapshot?.session ?? null, selectedCustomAgent),
    [selectedCustomAgent, snapshot?.session],
  );
  const customAgentItems = useMemo(
    () => [
      {
        key: "default",
        value: null,
        primaryLabel: "Default Agent",
        secondaryLabel: "Copilot 標準 agent",
        title: "Copilot の標準 agent を使う",
        isSelected: !snapshot?.session.customAgentName.trim(),
      },
      ...availableCustomAgents.map((agent) => {
        const agentDisplay = buildCustomAgentMatchDisplay(agent);
        return {
          key: agent.id,
          value: agent.name,
          primaryLabel: agentDisplay.primaryLabel,
          secondaryLabel: agentDisplay.secondaryLabel,
          title: agentDisplay.title,
          isSelected: snapshot?.session.customAgentName === agent.name,
        };
      }),
    ],
    [availableCustomAgents, snapshot?.session.customAgentName],
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
      (snapshot?.session.allowedAdditionalDirectories ?? []).map((directoryPath) => {
        const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
        return {
          key: directoryPath,
          path: directoryPath,
          primaryLabel: directoryDisplay.primaryLabel,
          secondaryLabel: directoryDisplay.secondaryLabel,
          title: directoryDisplay.title,
          canRemove: snapshot?.session.provider === "codex",
        };
      }),
    [snapshot?.session.allowedAdditionalDirectories],
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
    snapshot?.session.provider && providerQuotaTelemetryState.ownerProviderId === snapshot.session.provider
      ? providerQuotaTelemetryState.telemetry
      : null;
  const selectedSessionContextTelemetry =
    snapshot && sessionContextTelemetryState.ownerSessionId === snapshot.session.id
      ? sessionContextTelemetryState.telemetry
      : null;
  const isCopilotSession = snapshot?.session.provider === "copilot";
  const selectedCopilotQuotaProjection = buildCopilotQuotaProjection(selectedProviderQuotaTelemetry);
  const selectedSessionContextTelemetryProjection =
    buildSessionContextTelemetryProjection(selectedSessionContextTelemetry);
  const latestLiveCommandStep = (() => {
    const steps = selectedSessionLiveRun?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index]?.type === "command_execution") {
        return steps[index] ?? null;
      }
    }
    return null;
  })();
  const latestCommandView = buildLatestCommandView({
    latestLiveCommandStep,
    latestAuditCommandOperation: null,
    latestTerminalAuditPhase: null,
  });
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
  });
  const availableContextPaneTabs = useMemo(
    () => resolveAvailableContextPaneTabs({
      isCopilotSession,
      hasCompanionGroupMonitor: companionGroupMonitorEntries.length > 0,
    }),
    [isCopilotSession, companionGroupMonitorEntries.length],
  );

  useEffect(() => {
    const nextTab = resolveAutoContextPaneTab({
      isSelectedSessionRunning,
      isCopilotSession,
      backgroundTasks: selectedBackgroundTasks,
      hasCompanionGroupMonitor: companionGroupMonitorEntries.length > 0,
    });
    if (nextTab) {
      setActiveContextPaneTab(nextTab);
    }
  }, [isSelectedSessionRunning, isCopilotSession, selectedBackgroundTasks, companionGroupMonitorEntries.length]);

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

  function insertReferencePath(selectedPath: string): void {
    const textarea = composerTextareaRef.current;
    const currentCaret = textarea?.selectionStart ?? composerCaret;
    const referencePath = snapshot
      ? toWorkspaceRelativeReference(snapshot.session.worktreePath, selectedPath) ?? normalizePathForReference(selectedPath)
      : normalizePathForReference(selectedPath);
    const referenceToken = formatPathReference(referencePath);
    const leadingSpacer = currentCaret > 0 && !/\s/.test(composerText[currentCaret - 1] ?? "") ? " " : "";
    const trailingSpacer = composerText.length > currentCaret && !/\s/.test(composerText[currentCaret] ?? "") ? " " : "";
    const insertion = `${leadingSpacer}${referenceToken}${trailingSpacer}`;
    const nextDraft = `${composerText.slice(0, currentCaret)}${insertion}${composerText.slice(currentCaret)}`;
    const nextCaret = currentCaret + insertion.length;

    setComposerText(nextDraft);
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
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
    const activeReference = getActivePathReference(composerText, composerCaret);
    if (!textarea || !activeReference) {
      return;
    }

    const replacement = formatPathReference(match);
    const nextDraft = `${composerText.slice(0, activeReference.start)}${replacement}${composerText.slice(activeReference.end)}`;
    const nextCaret = activeReference.start + replacement.length;
    setComposerText(nextDraft);
    setComposerCaret(nextCaret);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);

    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function handleRemoveAttachmentReference(attachmentPathCandidates: string[]): void {
    const escapedCandidates = attachmentPathCandidates
      .map((candidate) => formatPathReference(candidate))
      .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    let nextDraft = composerText;
    for (const escapedCandidate of escapedCandidates) {
      nextDraft = nextDraft.replace(
        new RegExp(`(^|[\\s(])${escapedCandidate}(?=\\s|$|[),.;:!?])`),
        (_match, leadingWhitespace: string) => leadingWhitespace || "",
      );
    }

    nextDraft = nextDraft
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");

    setComposerText(nextDraft);
    setComposerCaret(nextDraft.length);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
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

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
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

    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      const caret = textarea.value.length;
      textarea.setSelectionRange(caret, caret);
    });
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

  async function sendCompanionTurn(): Promise<void> {
    const withmateApi = getWithMateApi();
    const userMessage = composerText.trim();
    if (!snapshot || !withmateApi || isCompanionSendDisabled || !userMessage) {
      setForceComposerBlockedFeedback(true);
      return;
    }

    setTurnRunning(true);
    setForceComposerBlockedFeedback(false);
    setErrorMessage("");
    setOperationMessage("");
    try {
      const preview = await withmateApi.previewCompanionComposerInput(snapshot.session.id, composerText);
      setComposerPreview(preview);
      const sendability = buildComposerSendabilityState({
        runState: selectedSessionRunState,
        blockedReason: companionComposerBlockedReason,
        inputErrors: preview.errors,
        draftText: composerText,
      });
      if (sendability.isSendDisabled) {
        throw new Error(sendability.primaryFeedback || "送信できない状態だよ。");
      }

      const nextSession = await withmateApi.runCompanionSessionTurn(snapshot.session.id, {
        userMessage,
        model: selectedModel,
        reasoningEffort: selectedReasoningEffort,
        approvalMode: selectedApprovalMode,
        codexSandboxMode: selectedCodexSandboxMode,
      });
      setComposerText("");
      setSnapshot((current) => current ? { ...current, session: nextSession } : current);
      await reloadSnapshot();
    } catch (error) {
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

  async function handleResolveCompanionLiveApproval(
    request: LiveApprovalRequest,
    decision: "approve" | "deny",
  ): Promise<void> {
    const withmateApi = getWithMateApi();
    if (!snapshot || !withmateApi || approvalActionRequestId) {
      return;
    }

    setApprovalActionRequestId(request.requestId);
    try {
      await withmateApi.resolveLiveApproval(snapshot.session.id, request.requestId, decision);
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

    setElicitationActionRequestId(request.requestId);
    try {
      await withmateApi.resolveLiveElicitation(snapshot.session.id, request.requestId, response);
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
      void sendCompanionTurn();
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
    return (
      <div className="page-shell companion-review-page">
        <section className="panel empty-session-card rise-1">
          <p>Companion は Electron から開いてね。</p>
        </section>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="page-shell companion-review-page">
        <section className="panel empty-session-card rise-1">
          <h2>Companion</h2>
          <p>{errorMessage || "読み込み中..."}</p>
        </section>
      </div>
    );
  }

  if (!isMergeView) {
    return (
      <SessionChatWindow
        mode="companion"
        className={`theme-accent${isHeaderExpanded ? "" : " session-page-header-collapsed"}`}
        style={themeStyle}
        workbenchRef={sessionWorkbenchRef}
        workbenchStyle={sessionWorkbenchStyle}
        isHeaderExpanded={isHeaderExpanded}
        headerProps={{
          taskTitle: snapshot.session.taskTitle,
          isEditingTitle,
          titleDraft,
          isRunning: isSelectedSessionRunning,
          showRenameButton: true,
          showAuditLogButton: true,
          showTerminalButton: true,
          showDeleteButton: false,
          onToggleExpanded: handleToggleHeaderExpanded,
          onOpenAuditLog: () => setAuditLogsOpen(true),
          onOpenTerminal: () => void openCompanionTerminal(),
          onTitleDraftChange: setTitleDraft,
          onTitleInputKeyDown: handleTitleInputKeyDown,
          onSaveTitle: () => void handleSaveTitle(),
          onCancelTitleEdit: handleCancelTitleEdit,
          onStartTitleEdit: handleStartTitleEdit,
          onDeleteSession: () => {},
          workspaceActions: (
            <button
              className="drawer-toggle compact secondary"
              type="button"
              disabled={operationRunning || turnRunning}
              onClick={() => void openCompanionWorktree()}
            >
              Explorer
            </button>
          ),
          actions: (
            <button
              className="drawer-toggle compact secondary"
              type="button"
              disabled={operationRunning || turnRunning || snapshot.session.status !== "active"}
              onClick={() => void openCompanionMergeWindow()}
            >
              Merge
            </button>
          ),
        }}
        messageColumnProps={{
          sessionId: snapshot.session.id,
          character: companionCharacterProfile ?? buildCompanionCharacterProfile(snapshot.session),
          messages: snapshot.session.messages,
          expandedArtifacts,
          messageListRef,
          isRunning: isSelectedSessionRunning,
          pendingRunIndicatorAnnouncement: "Companion が実行中",
          pendingRunIndicatorText: "Companion が応答を生成中...",
          liveApprovalRequest: selectedSessionLiveRun?.approvalRequest ?? null,
          approvalActionRequestId,
          liveElicitationRequest: selectedSessionLiveRun?.elicitationRequest ?? null,
          elicitationActionRequestId,
          liveRunAssistantText: selectedSessionLiveRun?.assistantText ?? "",
          hasLiveRunAssistantText: (selectedSessionLiveRun?.assistantText ?? "").length > 0,
          liveRunErrorMessage: selectedSessionLiveRun?.errorMessage ?? "",
          isMessageListFollowing,
          onMessageListScroll: handleMessageListScroll,
          onToggleArtifact: toggleArtifact,
          onLoadArtifactDetail: (messageIndex) =>
            withmateApi?.getCompanionMessageArtifact(snapshot.session.id, messageIndex) ?? Promise.resolve(null),
          onOpenDiff: (title, file) =>
            setSelectedDiff({
              title,
              file,
              themeColors: snapshot.session.characterThemeColors,
            }),
          onResolveLiveApproval: (request, decision) => void handleResolveCompanionLiveApproval(request, decision),
          onResolveLiveElicitation: (request, response) => void handleResolveCompanionLiveElicitation(request, response),
          onOpenPath: (target) => void getWithMateApi()?.openPath(target),
          getChangedFilesEmptyText: () => "差分はまだないよ。",
        }}
        isActionDockExpanded={isActionDockExpanded}
        composerProps={{
          retryBanner: null,
          isRunning: isSelectedSessionRunning,
          composerBlocked: snapshot.session.status !== "active" || operationRunning,
          canSelectCustomAgent: snapshot.session.provider === "copilot",
          showCustomAgentPicker: true,
          showSkillPicker: true,
          showAdditionalDirectoryControls: true,
          isAgentPickerOpen,
          isSkillPickerOpen,
          isAdditionalDirectoryListOpen,
          selectedCustomAgentLabel: snapshot.session.provider === "copilot" ? selectedCustomAgentDisplay.label : "Agent",
          selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択",
          additionalDirectoryCount: (snapshot.session.allowedAdditionalDirectories ?? []).length,
          canCollapseActionDock,
          showJumpToBottom: !isMessageListFollowing,
          isCustomAgentListLoading,
          isSkillListLoading,
          customAgentItems,
          skillItems,
          attachmentItems: composerAttachmentItems,
          additionalDirectoryItems,
          workspacePathMatchItems,
          draft: composerText,
          composerTextareaRef,
          isComposerDisabled: runDisabled,
          isSendDisabled: isCompanionSendDisabled,
          composerSendability: companionComposerSendability,
          sendButtonTitle: isSelectedSessionRunning ? "Companion を停止" : companionSendButtonTitle,
          isComposerBlockedFeedbackActive: companionComposerSendability.shouldShowFeedback,
          approvalOptions: approvalSelectOptions,
          selectedApprovalMode,
          sandboxOptions: sandboxSelectOptions,
          selectedCodexSandboxMode,
          modelOptions: modelSelectOptions,
          selectedModel: selectedModelEntry?.id ?? selectedModel,
          selectedModelFallbackLabel,
          reasoningOptions: reasoningSelectOptions,
          selectedReasoningEffort,
          onPickFile: () => void pickAndInsertPath("file"),
          onPickFolder: () => void pickAndInsertPath("folder"),
          onPickImage: () => void pickAndInsertPath("image"),
          onToggleAgentPicker: () => {
            setIsSkillPickerOpen(false);
            setIsAgentPickerOpen((current) => !current);
          },
          onToggleSkillPicker: () => {
            setIsAgentPickerOpen(false);
            setIsSkillPickerOpen((current) => !current);
          },
          onAddAdditionalDirectory: () => void handleAddAdditionalDirectory(),
          onToggleAdditionalDirectoryList: () => setIsAdditionalDirectoryListOpen((current) => !current),
          onCollapse: handleCollapseActionDock,
          onJumpToBottom: handleJumpToMessageListBottom,
          onSelectCustomAgent: (value) => void handleSelectCustomAgent(
            value ? availableCustomAgents.find((agent) => agent.name === value) ?? null : null,
          ),
          onSelectSkill: (skillId) => {
            const skill = availableSkills.find((entry) => entry.id === skillId);
            if (skill) {
              handleSelectSkill(skill);
            }
          },
          onRemoveAttachment: handleRemoveAttachmentReference,
          onRemoveAdditionalDirectory: (path) => void handleRemoveAdditionalDirectory(path),
          onDraftChange: (value, selectionStart) => {
            setForceComposerBlockedFeedback(false);
            setComposerText(value);
            setComposerCaret(selectionStart);
          },
          onDraftFocus: () => setIsActionDockPinnedExpanded(true),
          onDraftKeyDown: handleCompanionDraftKeyDown,
          onDraftSelect: setComposerCaret,
          onDraftCompositionStart: () => setIsComposerImeComposing(true),
          onDraftCompositionEnd: () => {
            setIsComposerImeComposing(false);
            setComposerCaret(composerTextareaRef.current?.selectionStart ?? composerText.length);
          },
          onSendOrCancel: () => void (isSelectedSessionRunning ? cancelCompanionTurn() : sendCompanionTurn()),
          onSelectWorkspacePathMatch: handleSelectWorkspacePathMatch,
          onActivateWorkspacePathMatch: setActiveWorkspacePathMatchIndex,
          onChangeApprovalMode: (value) => void handleChangeApproval(value),
          onChangeCodexSandboxMode: (value) => void handleChangeCodexSandboxMode(value),
          onChangeModel: (value) => void handleChangeSelectedModel(value),
          onChangeReasoningEffort: (value) => void handleChangeReasoningEffort(value as ModelReasoningEffort),
        }}
        compactActionDockProps={{
          draft: composerText,
          actionDockCompactPreview,
          attachmentCount: composerPreview.attachments.length,
          isRunning: isSelectedSessionRunning,
          isSendDisabled: isCompanionSendDisabled,
          showJumpToBottom: !isMessageListFollowing,
          sendButtonTitle: isSelectedSessionRunning ? "Companion を停止" : companionSendButtonTitle,
          onExpand: () => handleExpandActionDock({ focusComposer: true }),
          onJumpToBottom: handleJumpToMessageListBottom,
          onSendOrCancel: () => void (isSelectedSessionRunning ? cancelCompanionTurn() : sendCompanionTurn()),
        }}
        splitter={(
          <button
            className={`session-workbench-splitter${isContextRailResizing ? " is-active" : ""}`}
            type="button"
            onPointerDown={handleStartContextRailResize}
            aria-label="会話と command pane の幅を調整"
            title="左右の幅をドラッグで調整"
          />
        )}
        rightPane={(
          <SessionPaneErrorBoundary>
            <SessionContextPane
              taskTitle={snapshot.session.taskTitle}
              isHeaderExpanded={isHeaderExpanded}
              activeContextPaneTab={activeContextPaneTab}
              availableContextPaneTabs={availableContextPaneTabs}
              contextPaneProjection={contextPaneProjection}
              latestCommandView={latestCommandView}
              runningDetailsEntries={runningDetailsEntries}
              backgroundTasks={selectedBackgroundTasks}
              companionGroupMonitorEntries={companionGroupMonitorEntries}
              selectedSessionLiveRunErrorMessage={selectedSessionLiveRun?.errorMessage ?? ""}
              isSelectedSessionRunning={isSelectedSessionRunning}
              isCopilotSession={isCopilotSession}
              selectedCopilotRemainingPercentLabel={selectedCopilotQuotaProjection.remainingPercentLabel}
              selectedCopilotRemainingRequestsLabel={selectedCopilotQuotaProjection.remainingRequestsLabel}
              selectedCopilotQuotaResetLabel={selectedCopilotQuotaProjection.resetLabel}
              selectedSessionContextTelemetry={selectedSessionContextTelemetry}
              selectedSessionContextTelemetryProjection={selectedSessionContextTelemetryProjection}
              contextEmptyText="context usage はまだありません。"
              onToggleHeaderExpanded={() => setIsHeaderExpanded((current) => !current)}
              onCycleContextPaneTab={handleCycleContextPaneTab}
              onOpenCompanionReview={(sessionId) => void getWithMateApi()?.openCompanionReviewWindow(sessionId)}
            />
          </SessionPaneErrorBoundary>
        )}
        modals={(
          <>
            <SessionDiffModal
              selectedDiff={selectedDiff}
              themeStyle={selectedDiffThemeStyle}
              onClose={() => setSelectedDiff(null)}
              onOpenDiffWindow={(payload) => void openDiffWindow(payload)}
            />
            <SessionAuditLogModal
              open={auditLogsOpen}
              entries={displayedSessionAuditLogs}
              details={auditLogDetails}
              operationDetails={auditLogOperationDetails}
              hasMore={auditLogsState.ownerSessionId === snapshot.session.id ? auditLogsState.hasMore : false}
              loadingMore={auditLogsState.ownerSessionId === snapshot.session.id ? auditLogsState.loading : false}
              total={auditLogsState.ownerSessionId === snapshot.session.id
                ? Math.max(auditLogsState.total, displayedSessionAuditLogs.length)
                : displayedSessionAuditLogs.length}
              errorMessage={auditLogsState.ownerSessionId === snapshot.session.id ? auditLogsState.errorMessage : null}
              onLoadMore={handleLoadMoreAuditLogs}
              onLoadDetail={handleLoadAuditLogDetail}
              onLoadOperationDetail={handleLoadAuditLogOperationDetail}
              onClose={() => setAuditLogsOpen(false)}
            />
            {errorMessage || operationMessage ? (
              <div className={`companion-session-toast ${errorMessage ? "error" : "success"}`}>
                {errorMessage || operationMessage}
              </div>
            ) : null}
          </>
        )}
      />
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
                  <SessionHeaderHandle taskTitle={snapshot.session.taskTitle} onClick={handleToggleHeaderExpanded} />
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
