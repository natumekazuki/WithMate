import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";

import {
  type AuditLogSummary,
  type ComposerPreview,
  currentTimestampLabel,
  type DiscoveredCustomAgent,
  type DiscoveredSkill,
  getSessionIdFromLocation,
  type LiveApprovalRequest,
  type LiveElicitationRequest,
  type LiveElicitationResponse,
  type LiveSessionRunState,
  type ProviderQuotaTelemetry,
  type RunSessionTurnRequest,
  type SessionContextTelemetry,
} from "./app-state.js";
import { DEFAULT_CHARACTER_SESSION_COPY, type CharacterProfile } from "./character-state.js";
import type { CompanionSessionSummary } from "./companion-state.js";
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
  applySessionModelMetadataUpdate,
  isLegacyReadOnlySession,
  type Session,
} from "./session-state.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  resolveModelChangeSelection,
  resolveModelSelection,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import {
  approvalModeLabel,
  modelDisplayLabel,
  modelOptionLabel,
} from "./ui-utils.js";
import {
  getApprovalOptionsForProvider,
  getSandboxOptionsForProvider,
  getSandboxOptionsForProviderSelection,
} from "./provider-runtime-options.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandView,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  type ContextPaneTabKey,
  resolveAvailableContextPaneTabs,
} from "./session-ui-projection.js";
import { ChatWindow, ChatWindowStatusScreen } from "./chat/chat-window.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  withForcedComposerBlockedFeedback,
  type ComposerSendabilityState,
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
import { buildAgentSessionChatWindowProps } from "./chat/session-chat-projection.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCompanionGroupMonitorEntries } from "./home/home-session-projection.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import { extractTextReferenceCandidates } from "./path-reference.js";
import type { WorkspacePathCandidate } from "./workspace-path-candidate.js";
import type { AuxiliarySession } from "./auxiliary-session-state.js";
import { formatMarkdownQuote, insertComposerTextAtCaret } from "./chat/message-text-actions.js";
import { buildMessageListProjection } from "./auxiliary-session-message-projection.js";

type RetryBannerKind = "interrupted" | "failed" | "canceled";

type RetryBannerState = {
  kind: RetryBannerKind;
  badge: string;
  title: string;
  stopSummary: string;
  lastRequestText: string;
};

type SessionOwnedLiveRun = {
  ownerSessionId: string | null;
  state: LiveSessionRunState | null;
};

type ProviderOwnedQuotaTelemetry = {
  ownerProviderId: string | null;
  telemetry: ProviderQuotaTelemetry | null;
};

type SessionOwnedContextTelemetry = {
  ownerSessionId: string | null;
  telemetry: SessionContextTelemetry | null;
};

const EMPTY_COMPOSER_PREVIEW: ComposerPreview = { attachments: [], errors: [] };
const COMPOSER_PREVIEW_DEBOUNCE_MS = 120;
const COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS = 280;
const WORKSPACE_PATH_QUERY_MIN_LENGTH = 2;
const DEFAULT_SESSION_RUNTIME_NAME = "Mate";

function buildAuxiliaryRuntimeSession(parent: Session, auxiliary: AuxiliarySession): Session {
  return {
    ...parent,
    id: auxiliary.id,
    taskTitle: parent.taskTitle,
    status: auxiliary.runState === "running" ? "running" : "idle",
    updatedAt: auxiliary.updatedAt,
    provider: auxiliary.provider,
    catalogRevision: auxiliary.catalogRevision,
    runState: auxiliary.runState,
    approvalMode: auxiliary.approvalMode,
    codexSandboxMode: auxiliary.codexSandboxMode,
    model: auxiliary.model,
    reasoningEffort: auxiliary.reasoningEffort,
    customAgentName: auxiliary.customAgentName,
    allowedAdditionalDirectories: auxiliary.allowedAdditionalDirectories,
    threadId: auxiliary.threadId,
    messages: auxiliary.messages,
    stream: [],
  };
}

function defaultRetryBannerDetailsOpen(kind: RetryBannerKind): boolean {
  return kind !== "canceled";
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

function isTerminalAuditLogPhase(phase: AuditLogSummary["phase"]): boolean {
  return (
    phase === "completed"
    || phase === "failed"
    || phase === "canceled"
    || phase === "background-completed"
    || phase === "background-failed"
    || phase === "background-canceled"
  );
}

function getLastNonEmptyValue(values: Array<string | null | undefined>): string {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values[index]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasSameAuxiliaryDraftSaveContext(current: AuxiliarySession, request: AuxiliarySession): boolean {
  return current.id === request.id
    && current.runState === request.runState
    && current.threadId === request.threadId
    && current.messages.length === request.messages.length
    && current.composerDraft === request.composerDraft
    && current.provider === request.provider
    && current.model === request.model
    && current.reasoningEffort === request.reasoningEffort
    && current.approvalMode === request.approvalMode
    && current.codexSandboxMode === request.codexSandboxMode
    && current.customAgentName === request.customAgentName
    && current.catalogRevision === request.catalogRevision
    && areStringArraysEqual(current.allowedAdditionalDirectories, request.allowedAdditionalDirectories);
}

function displayApprovalValue(value: string): string {
  return approvalModeLabel(value);
}

function buildRetryStopSummary(
  kind: RetryBannerKind,
  liveRun: LiveSessionRunState | null,
  latestTerminalAuditLog: AuditLogSummary | null,
  lastAssistantMessage: Message | null,
): string {
  const liveRunSummary = getLastNonEmptyValue((liveRun?.steps ?? []).map((step) => step.summary));
  if (liveRunSummary) {
    return liveRunSummary;
  }

  if (kind === "interrupted") {
    return "停止地点は復元できませんでした。";
  }

  const auditOperationSummary = getLastNonEmptyValue(
    (latestTerminalAuditLog?.operations ?? []).map((operation) => operation.summary),
  );
  if (auditOperationSummary) {
    return auditOperationSummary;
  }

  const artifactOperationSummary = getLastNonEmptyValue(
    (lastAssistantMessage?.artifact?.operationTimeline ?? []).map((operation) => operation.summary),
  );
  if (artifactOperationSummary) {
    return artifactOperationSummary;
  }

  const artifactActivitySummary = getLastNonEmptyValue(lastAssistantMessage?.artifact?.activitySummary ?? []);
  if (artifactActivitySummary) {
    return artifactActivitySummary;
  }

  if (kind === "failed") {
    const errorSummary = latestTerminalAuditLog?.errorMessage.trim() ?? "";
    if (errorSummary && errorSummary !== "ユーザーがキャンセルしたよ。") {
      return errorSummary;
    }
  }

  switch (kind) {
    case "failed":
      return "エラー箇所は復元できませんでした。";
    case "canceled":
      return "停止位置は記録されていません。";
    default:
      return "";
  }
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

function createPendingLiveSessionRunState(
  session: Pick<Session, "id" | "threadId">,
  previousState?: LiveSessionRunState | null,
): LiveSessionRunState {
  return {
    sessionId: session.id,
    threadId: session.threadId,
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: previousState?.backgroundTasks ?? [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

export default function AgentSessionWindowApp() {
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [companionSessions, setCompanionSessions] = useState<CompanionSessionSummary[]>([]);
  const [openCompanionReviewWindowIds, setOpenCompanionReviewWindowIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [forceComposerBlockedFeedback, setForceComposerBlockedFeedback] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [liveRunState, setLiveRunState] = useState<SessionOwnedLiveRun>({ ownerSessionId: null, state: null });
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
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>({ attachments: [], errors: [] });
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [workspacePathMatches, setWorkspacePathMatches] = useState<WorkspacePathCandidate[]>([]);
  const [activeWorkspacePathMatchIndex, setActiveWorkspacePathMatchIndex] = useState(-1);
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [availableCustomAgents, setAvailableCustomAgents] = useState<DiscoveredCustomAgent[]>([]);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [isComposerImeComposing, setIsComposerImeComposing] = useState(false);
  const [isActivityMonitorFollowing, setIsActivityMonitorFollowing] = useState(true);
  const [hasActivityMonitorUnread, setHasActivityMonitorUnread] = useState(false);
  const [isRetryDetailsOpen, setIsRetryDetailsOpen] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);
  const [isActionDockPinnedExpanded, setIsActionDockPinnedExpanded] = useState(false);
  const [activeAuxiliarySession, setActiveAuxiliarySession] = useState<AuxiliarySession | null>(null);
  const [closedAuxiliarySessions, setClosedAuxiliarySessions] = useState<AuxiliarySession[]>([]);
  const [isAuxiliaryActionPending, setIsAuxiliaryActionPending] = useState(false);
  const activityMonitorRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activityMonitorSignatureRef = useRef("");
  const activityMonitorSessionIdRef = useRef<string | null>(null);
  const activeAuxiliarySessionRef = useRef<AuxiliarySession | null>(null);
  const auxiliaryDraftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const auxiliaryLoadRevisionRef = useRef(0);
  const mainComposerCaretRef = useRef(0);
  const selectedId = useMemo(() => getSessionIdFromLocation(), []);

  useEffect(() => {
    let active = true;

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    if (!selectedId) {
      setSessions([]);
      return () => {
        active = false;
      };
    }

    const hydrateSelectedSession = () => {
      void withmateApi.getSession(selectedId).then((session) => {
        if (!active) {
          return;
        }

        setSessions(session ? [session] : []);
      });
    };

    hydrateSelectedSession();

    const unsubscribe = withmateApi.subscribeSessionInvalidation((sessionIds) => {
      if (!active || !sessionIds.includes(selectedId)) {
        return;
      }

      hydrateSelectedSession();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedId, withmateApi]);

  useEffect(() => {
    let active = true;

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
  }, [withmateApi]);

  useEffect(() => {
    let active = true;

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    void withmateApi.listOpenCompanionReviewWindowIds().then((nextSessionIds) => {
      if (active) {
        setOpenCompanionReviewWindowIds(nextSessionIds);
      }
    });

    const unsubscribe = withmateApi.subscribeOpenCompanionReviewWindowIds((nextSessionIds) => {
      if (active) {
        setOpenCompanionReviewWindowIds(nextSessionIds);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [withmateApi]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );
  const displayedSession = useMemo(
    () => (selectedSession && activeAuxiliarySession
      ? buildAuxiliaryRuntimeSession(selectedSession, activeAuxiliarySession)
      : selectedSession),
    [activeAuxiliarySession, selectedSession],
  );
  const isAuxiliaryMode = activeAuxiliarySession?.status === "active";
  const selectedCompanionGroupMonitorEntries = useMemo(
    () => buildCompanionGroupMonitorEntries(
      companionSessions,
      openCompanionReviewWindowIds,
    ),
    [companionSessions, openCompanionReviewWindowIds],
  );
  const selectedSessionId = selectedSession?.id ?? null;
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

    if (!withmateApi || !selectedSessionId) {
      setActiveAuxiliarySession(null);
      setClosedAuxiliarySessions([]);
      return () => {
        active = false;
      };
    }

    void withmateApi.getActiveAuxiliarySession(selectedSessionId).then((session) => {
      if (canApplyLoadResult()) {
        setActiveAuxiliarySession(session);
      }
    }).catch(() => {
      if (canApplyLoadResult()) {
        setActiveAuxiliarySession(null);
      }
    });

    void loadClosedAuxiliarySessions(selectedSessionId, canApplyLoadResult);

    return () => {
      active = false;
    };
  }, [selectedSessionId, withmateApi]);

  const {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailResizing,
    handleStartContextRailResize,
  } = useSessionContextRail({ ownerKey: selectedSessionId });
  const activeRunSessionId = activeAuxiliarySession?.id ?? selectedSessionId;
  const selectedSessionLiveRun = useMemo(
    () => (activeRunSessionId !== null && liveRunState.ownerSessionId === activeRunSessionId ? liveRunState.state : null),
    [activeRunSessionId, liveRunState.ownerSessionId, liveRunState.state],
  );
  const {
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogsState,
    auditLogDetails,
    auditLogOperationDetails,
    persistedEntries: selectedSessionAuditLogs,
    displayedEntries: displayedSessionAuditLogs,
    handleLoadMoreAuditLogs,
    handleLoadAuditLogDetail,
    handleLoadAuditLogOperationDetail,
  } = useSessionAuditLogs({
    withmateApi,
    selectedSession,
    liveRun: selectedSessionLiveRun,
  });
  const selectedProviderQuotaTelemetry = useMemo(
    () => (
      selectedSession?.provider
      && providerQuotaTelemetryState.ownerProviderId === selectedSession.provider
        ? providerQuotaTelemetryState.telemetry
        : null
    ),
    [providerQuotaTelemetryState.ownerProviderId, providerQuotaTelemetryState.telemetry, selectedSession?.provider],
  );
  const selectedSessionContextTelemetry = useMemo(
    () => (
      activeRunSessionId !== null && sessionContextTelemetryState.ownerSessionId === activeRunSessionId
        ? sessionContextTelemetryState.telemetry
        : null
    ),
    [activeRunSessionId, sessionContextTelemetryState.ownerSessionId, sessionContextTelemetryState.telemetry],
  );
  const activeComposerDraft = activeAuxiliarySession?.composerDraft ?? draft;
  const activePathReference = useMemo(
    () => (selectedSessionId ? getActivePathReference(activeComposerDraft, composerCaret) : null),
    [activeComposerDraft, composerCaret, selectedSessionId],
  );
  const isEditingPathReference = activePathReference !== null;
  const normalizedActivePathQuery = activePathReference?.query.trim() ?? "";
  const previewDraft = useMemo(
    () => removeActivePathReference(activeComposerDraft, activePathReference),
    [activeComposerDraft, activePathReference],
  );
  const previewUserMessage = useMemo(
    () => (isEditingPathReference ? previewDraft : activeComposerDraft),
    [activeComposerDraft, isEditingPathReference, previewDraft],
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
  const selectedSessionRunState: Session["runState"] | null = selectedSession?.runState
    ?? (selectedSessionLiveRun ? "running" : null);

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
  const isSelectedSessionReadOnly = selectedSession ? isLegacyReadOnlySession(selectedSession) : false;
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
  const isSelectedProviderEnabled = useMemo(
    () => !!selectedSession && getProviderAppSettings(appSettings, selectedSession.provider).enabled,
    [appSettings, selectedSession],
  );
  const sessionExecutionBlockedReason = useMemo(() => {
    if (!selectedSession) {
      return "";
    }

    if (isSelectedSessionReadOnly) {
      return "この session は旧バージョンから移行された閲覧専用だよ。";
    }

    if (!isSelectedProviderEnabled) {
      return "この provider は Settings の Coding Agent Providers で無効になっているよ。Home の Settings で有効化してね。";
    }

    return "";
  }, [isSelectedProviderEnabled, isSelectedSessionReadOnly, selectedSession]);
  const composerBlockedReason = sessionExecutionBlockedReason;

  useEffect(() => {
    if (!selectedSession || isEditingTitle) {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
  }, [isEditingTitle, selectedSession]);

  useEffect(() => {
    let active = true;

    if (!withmateApi || !selectedSession || selectedSession.provider !== "copilot") {
      setAvailableCustomAgents([]);
      setIsCustomAgentListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsCustomAgentListLoading(true);
    void withmateApi.listSessionCustomAgents(selectedSession.id).then((agents) => {
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
  }, [selectedSession]);

  useEffect(() => {
    let active = true;

    if (!withmateApi || !selectedSession) {
      setAvailableSkills([]);
      setIsSkillListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsSkillListLoading(true);
    void withmateApi.listSessionSkills(selectedSession.id).then((skills) => {
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
  }, [appSettings, selectedSession]);

  useEffect(() => {
    setIsAgentPickerOpen(false);
    setIsSkillPickerOpen(false);
  }, [selectedSessionId]);

  useEffect(() => {
    if (selectedSession?.runState === "running") {
      setIsAgentPickerOpen(false);
      setIsSkillPickerOpen(false);
    }
  }, [selectedSession?.runState]);

  useEffect(() => {
    let active = true;

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    void withmateApi.getModelCatalog(null).then((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });

    const unsubscribe = withmateApi.subscribeModelCatalog((snapshot) => {
      if (!active) {
        return;
      }
      setModelCatalog(snapshot);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    let active = true;
    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    void withmateApi.getAppSettings().then((settings) => {
      if (active) {
        setAppSettings(settings);
      }
    });

    const unsubscribe = withmateApi.subscribeAppSettings((settings) => {
      if (active) {
        setAppSettings(settings);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];
  const messageListProjection = useMemo(
    () =>
      buildMessageListProjection(displayedMessages, [
        ...closedAuxiliarySessions,
        ...(activeAuxiliarySession ? [activeAuxiliarySession] : []),
      ], selectedSession?.id),
    [activeAuxiliarySession, closedAuxiliarySessions, displayedMessages, selectedSession?.id],
  );
  const messageListMessages = messageListProjection.messages;
  const messageListSources = messageListProjection.sources;
  const messageListKeys = messageListProjection.keys;
  const messageListBoundaries = messageListProjection.boundaries;
  const displayedMessagesScrollSignature = useMemo(
    () => buildDisplayedMessagesScrollSignature(messageListMessages),
    [messageListMessages],
  );
  const pendingBubbleScrollSignature = useMemo(
    () =>
      [
        selectedSession?.runState ?? "",
        selectedSessionLiveRun?.assistantText ?? "",
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
      selectedSession?.runState,
      selectedSessionLiveRun?.approvalRequest,
      selectedSessionLiveRun?.elicitationRequest,
      selectedSessionLiveRun?.assistantText,
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
        activeAuxiliarySession?.runState ?? selectedSession?.runState ?? "",
        displayedMessagesScrollSignature,
        pendingBubbleScrollSignature,
      ].join("\u001a"),
    [
      activeAuxiliarySession?.runState,
      activeRunSessionId,
      displayedMessagesScrollSignature,
      pendingBubbleScrollSignature,
      selectedSession?.runState,
    ],
  );
  const {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
  } = useSessionMessageListFollowing({
    ownerKey: activeRunSessionId,
    scrollSignature: messageListScrollSignature,
  });

  useEffect(() => {
    activeAuxiliarySessionRef.current = activeAuxiliarySession;
  }, [activeAuxiliarySession]);

  useEffect(() => {
    setDraft("");
    setComposerPreview(EMPTY_COMPOSER_PREVIEW);
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setComposerCaret(0);
    mainComposerCaretRef.current = 0;
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
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
    setIsHeaderExpanded(false);
    setIsActionDockPinnedExpanded(false);
  }, [selectedSession?.provider, selectedSessionId]);

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
    const isActivityMonitorVisible = selectedSession?.runState === "running";
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
  }, [activityMonitorScrollSignature, isActivityMonitorFollowing, selectedSession?.runState, selectedSessionId]);

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
      if (activeAuxiliarySessionId !== sessionId) {
        return;
      }

      void withmateApi.getAuxiliarySession(sessionId).then((saved) => {
        if (!active) {
          return;
        }

        setActiveAuxiliarySession((current) => {
          if (current?.id !== sessionId) {
            return current;
          }

          if (!saved || saved.runState !== "running" || current.runState !== "running") {
            activeAuxiliarySessionRef.current = saved;
            return saved;
          }

          return current;
        });
      }).catch((error) => {
        console.error(error);
      });
    };

    setLiveRunState({ ownerSessionId: activeRunSessionId, state: null });
    void withmateApi.getLiveSessionRun(activeRunSessionId).then((state) => {
      if (active) {
        setLiveRunState({ ownerSessionId: activeRunSessionId, state });
        refreshCompletedAuxiliarySession(activeRunSessionId);
      }
    });

    const unsubscribe = withmateApi.subscribeLiveSessionRun((sessionId, state) => {
      if (!active || sessionId !== activeRunSessionId) {
        return;
      }

      setLiveRunState({ ownerSessionId: sessionId, state });
      refreshCompletedAuxiliarySession(sessionId);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeAuxiliarySession?.id, activeRunSessionId, selectedSession, withmateApi]);

  useEffect(() => {
    let active = true;
    const providerId = selectedSession?.provider ?? null;

    if (!withmateApi || providerId !== "copilot") {
      setProviderQuotaTelemetryState({ ownerProviderId: providerId, telemetry: null });
      return () => {
        active = false;
      };
    }

    setProviderQuotaTelemetryState((current) =>
      current.ownerProviderId === providerId
        ? current
        : { ownerProviderId: providerId, telemetry: null },
    );

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
      if (!active || nextProviderId !== providerId) {
        return;
      }

      setProviderQuotaTelemetryState({ ownerProviderId: nextProviderId, telemetry });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.provider]);

  useEffect(() => {
    let active = true;
    const sessionId = activeRunSessionId;
    const providerId = displayedSession?.provider ?? null;

    if (!withmateApi || !sessionId || providerId !== "copilot") {
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
      if (!active || nextSessionId !== sessionId) {
        return;
      }

      setSessionContextTelemetryState({ ownerSessionId: nextSessionId, telemetry });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [activeRunSessionId, displayedSession?.provider, withmateApi]);

  useEffect(() => {
    let active = true;
    if (!withmateApi || !activeRunSessionId) {
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
      void withmateApi.previewComposerInput(activeRunSessionId, previewUserMessage).then((preview) => {
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
    previewPathReferenceSignature,
    previewUserMessage,
    activeRunSessionId,
  ]);
  useEffect(() => {
    let active = true;

    if (
      !withmateApi
      || !selectedSessionId
      || selectedSessionRunState === "running"
      || !!composerBlockedReason
      || isComposerImeComposing
      || !isEditingPathReference
      || normalizedActivePathQuery.length < WORKSPACE_PATH_QUERY_MIN_LENGTH
    ) {
      setWorkspacePathMatches([]);
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      void withmateApi.searchWorkspaceFiles(selectedSessionId, normalizedActivePathQuery).then((matches) => {
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
    composerBlockedReason,
    isComposerImeComposing,
    isEditingPathReference,
    normalizedActivePathQuery,
    selectedSessionId,
    selectedSessionRunState,
  ]);
  const selectedProviderCatalog = useMemo(
    () => (modelCatalog && displayedSession ? getProviderCatalog(modelCatalog.providers, displayedSession.provider) : null),
    [displayedSession, modelCatalog],
  );
  const isCopilotSession = selectedSession?.provider === "copilot";
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
  const lastAssistantMessage = useMemo(
    () =>
      selectedSession
        ? [...selectedSession.messages].reverse().find((message) => message.role === "assistant") ?? null
        : null,
    [selectedSession],
  );
  const latestTerminalAuditLog = useMemo(
    () => selectedSessionAuditLogs.find((entry) => isTerminalAuditLogPhase(entry.phase)) ?? null,
    [selectedSessionAuditLogs],
  );
  const latestLiveCommandStep = useMemo(() => {
    const steps = selectedSessionLiveRun?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index]?.type === "command_execution") {
        return steps[index];
      }
    }

    return null;
  }, [selectedSessionLiveRun?.steps]);
  const latestAuditCommandOperation = useMemo(() => {
    const operations = latestTerminalAuditLog?.operations ?? [];
    for (let index = operations.length - 1; index >= 0; index -= 1) {
      if (operations[index]?.type === "command_execution") {
        return operations[index];
      }
    }

    return null;
  }, [latestTerminalAuditLog]);
  const latestCommandView = useMemo(
    () => buildLatestCommandView({
      latestLiveCommandStep,
      latestAuditCommandOperation,
      latestTerminalAuditPhase: latestTerminalAuditLog?.phase,
    }),
    [latestAuditCommandOperation, latestLiveCommandStep, latestTerminalAuditLog?.phase],
  );
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

  const liveRunAssistantText = selectedSessionLiveRun?.assistantText ?? "";
  const liveApprovalRequest = selectedSessionLiveRun?.approvalRequest ?? null;
  const liveElicitationRequest = selectedSessionLiveRun?.elicitationRequest ?? null;
  const isApprovalRequestPending = !!liveApprovalRequest;
  const isElicitationRequestPending = !!liveElicitationRequest;
  const hasLiveRunAssistantText = liveRunAssistantText.length > 0;
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
      selectedSessionRunState === "running" ? "empty.latest_command.waiting" : "empty.latest_command",
      [
        "latest-command-empty",
        selectedSession?.id,
        selectedSessionRunState,
        latestTerminalAuditLog?.id,
      ],
    ),
    [
      appSettings.userMicrocopyCatalog,
      latestTerminalAuditLog?.id,
      selectedSession?.id,
      selectedSessionCharacter?.name,
      selectedSessionRunState,
    ],
  );
  const retryBanner = useMemo<RetryBannerState | null>(() => {
    if (!selectedSession || selectedSession.runState === "running" || isSelectedSessionReadOnly || !lastUserMessage) {
      return null;
    }

    let kind: RetryBannerKind | null = null;
    if (selectedSession.runState === "interrupted") {
      kind = "interrupted";
    } else if (selectedSession.runState === "error") {
      kind = "failed";
    } else if (selectedSession.runState === "idle" && latestTerminalAuditLog?.phase === "canceled") {
      kind = "canceled";
    }

    if (!kind) {
      return null;
    }

    const stopSummary = buildRetryStopSummary(kind, selectedSessionLiveRun, latestTerminalAuditLog, lastAssistantMessage);
    switch (kind) {
      case "interrupted":
        return {
          kind,
          badge: "中断",
          title: resolveSessionMicrocopy("retry.interrupted.title", [
            "retry",
            "interrupted",
            selectedSession.id,
            lastUserMessage.text,
          ]),
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: resolveSessionMicrocopy("retry.failed.title", [
            "retry",
            "failed",
            selectedSession.id,
            lastUserMessage.text,
          ]),
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      case "canceled":
        return {
          kind,
          badge: "キャンセル",
          title: resolveSessionMicrocopy("retry.canceled.title", [
            "retry",
            "canceled",
            selectedSession.id,
            lastUserMessage.text,
            latestTerminalAuditLog?.id,
          ]),
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      default:
        return null;
    }
  }, [
    lastAssistantMessage,
    lastUserMessage,
    latestTerminalAuditLog,
    appSettings.userMicrocopyCatalog,
    selectedSession,
    selectedSessionCharacter?.name,
    isSelectedSessionReadOnly,
    selectedSessionLiveRun,
  ]);
  const hasDraftText = draft.trim().length > 0;
  const shouldProtectDraftOnRetryEdit = !!retryBanner && hasDraftText && draft !== retryBanner.lastRequestText;
  const isComposerDisabled = selectedSession?.runState === "running" || !!composerBlockedReason || isSelectedSessionReadOnly;
  const composerSendabilityBase = useMemo(
    () =>
      buildComposerSendabilityState({
        runState: selectedSession?.runState,
        blockedReason: composerBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: draft,
      }),
    [composerBlockedReason, composerPreview.errors, draft, selectedSession?.runState],
  );
  const composerSendability = useMemo(
    () => withForcedComposerBlockedFeedback(composerSendabilityBase, forceComposerBlockedFeedback),
    [composerSendabilityBase, forceComposerBlockedFeedback],
  );
  const isSendDisabled = composerSendability.isSendDisabled;
  const composerSendButtonTitle = getComposerSendButtonTitle(composerSendability);
  const isRetryActionDisabled =
    !retryBanner || !lastUserMessage || !!composerBlockedReason || isSelectedSessionReadOnly || selectedSession?.runState === "running";
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const shouldForceActionDockExpanded =
    isAgentPickerOpen
    || isSkillPickerOpen
    || workspacePathMatches.length > 0
    || isRetryDraftReplacePending
    || (!!retryBanner && !activeAuxiliarySession)
    || composerSendability.feedbackTone === "blocked";
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
  const approvalChoiceOptions = useMemo(
    () => {
      const options = getApprovalOptionsForProvider(selectedSession?.provider);
      if (!selectedSession || options.some((option) => option.value === selectedSession.approvalMode)) {
        return options;
      }

      return [{ value: selectedSession.approvalMode, label: selectedSession.approvalMode }, ...options];
    },
    [selectedSession?.approvalMode, selectedSession?.provider],
  );
  const sandboxChoiceOptions = useMemo(
    () => selectedSession
      ? getSandboxOptionsForProviderSelection(selectedSession.provider, selectedSession.codexSandboxMode)
      : getSandboxOptionsForProvider(undefined),
    [selectedSession?.codexSandboxMode, selectedSession?.provider],
  );
  const modelSelectOptions = useMemo(
    () => modelOptions.map((model) => ({ value: model.id, label: modelOptionLabel(model) })),
    [modelOptions],
  );
  const selectedModelFallbackLabel = useMemo(
    () => modelDisplayLabel(selectedProviderCatalog, displayedSession?.model ?? ""),
    [displayedSession?.model, selectedProviderCatalog],
  );
  const reasoningSelectOptions = useMemo(
    () => availableReasoningEfforts.map((reasoningEffort) => ({ value: reasoningEffort, label: reasoningEffort })),
    [availableReasoningEfforts],
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
        };
      }),
    [availableSkills],
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
          ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0),
        };
      }),
    [composerPreview.attachments],
  );
  const additionalDirectoryItems = useMemo(
    () =>
      displayedSession
        ? displayedSession.allowedAdditionalDirectories.map((directoryPath) => {
            const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
            return {
              key: directoryPath,
              path: directoryPath,
              primaryLabel: directoryDisplay.primaryLabel,
              secondaryLabel: directoryDisplay.secondaryLabel,
              title: directoryDisplay.title,
              canRemove: displayedSession.provider === "codex",
            };
          })
        : [],
    [displayedSession],
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
  const isActionDockExpanded = isActionDockPinnedExpanded || shouldForceActionDockExpanded;
  const canCollapseActionDock = !shouldForceActionDockExpanded;
  const isSessionHeaderExpanded = isHeaderExpanded || isEditingTitle;
  const actionDockCompactPreview = useMemo(() => {
    const normalizedDraft = draft.replace(/\s+/g, " ").trim();
    if (normalizedDraft) {
      return normalizedDraft.length > 84 ? `${normalizedDraft.slice(0, 84)}…` : normalizedDraft;
    }

    if (selectedSession?.runState === "running") {
      return "実行中";
    }

    return "下書きなし";
  }, [draft, selectedSession?.runState]);
  const retryBannerIdentity = useMemo(() => {
    if (!retryBanner || !selectedSession || !lastUserMessage) {
      return null;
    }

    const lastUserMessageIdentity = `${
      selectedSession.messages.filter((message) => message.role === "user").length
    }:${lastUserMessage.text}`;
    const canceledAuditLogIdentity =
      retryBanner.kind === "canceled" && latestTerminalAuditLog
        ? `${latestTerminalAuditLog.id}:${latestTerminalAuditLog.phase}:${latestTerminalAuditLog.createdAt}`
        : "";

    return [retryBanner.kind, lastUserMessageIdentity, canceledAuditLogIdentity].join("\u001f");
  }, [lastUserMessage, latestTerminalAuditLog, retryBanner, selectedSession]);

  useEffect(() => {
    if (!retryBanner) {
      setIsRetryDraftReplacePending(false);
    }
  }, [retryBanner]);

  useLayoutEffect(() => {
    if (!retryBanner) {
      setIsRetryDetailsOpen(false);
      return;
    }

    setIsRetryDetailsOpen(defaultRetryBannerDetailsOpen(retryBanner.kind));
  }, [retryBanner?.kind, retryBannerIdentity, selectedSession?.id]);

  useEffect(() => {
    setActiveWorkspacePathMatchIndex(workspacePathMatches.length > 0 ? 0 : -1);
  }, [workspacePathMatches]);

  useEffect(() => {
    setForceComposerBlockedFeedback(false);
  }, [selectedSession?.id]);

  const triggerComposerBlockedFeedback = () => {
    if (!selectedSession || selectedSession.runState === "running") {
      return;
    }

    setForceComposerBlockedFeedback(true);
  };

  const sendMessage = async (messageText: string, options?: { clearDraft?: boolean; collapseActionDock?: boolean }) => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    if (composerBlockedReason) {
      throw new Error(composerBlockedReason);
    }

    if (isSelectedSessionReadOnly) {
      throw new Error("旧バージョンから移行された閲覧専用セッションには送信できないよ。");
    }

    const nextMessage = messageText.trim();
    const preview = await withmateApi.previewComposerInput(selectedSession.id, messageText);
    setComposerPreview(preview);
    const sendability = buildComposerSendabilityState({
      runState: selectedSession.runState,
      blockedReason: composerBlockedReason,
      inputErrors: preview.errors,
      draftText: messageText,
    });
    if (sendability.isSendDisabled) {
      throw new Error(sendability.primaryFeedback || "送信できない状態だよ。");
    }

    if (options?.collapseActionDock) {
      setIsActionDockPinnedExpanded(false);
    }
    if (options?.clearDraft ?? true) {
      setDraft("");
    }
    const updatedSession: Session = {
      ...selectedSession,
      updatedAt: currentTimestampLabel(),
      status: "running",
      runState: "running",
      messages: [...selectedSession.messages, { role: "user", text: nextMessage }],
    };

    setLiveRunState((current) => (
      current.ownerSessionId === updatedSession.id
        ? { ownerSessionId: updatedSession.id, state: createPendingLiveSessionRunState(updatedSession, current.state) }
        : { ownerSessionId: updatedSession.id, state: createPendingLiveSessionRunState(updatedSession) }
    ));
    setSessions([updatedSession]);

    try {
      const request: RunSessionTurnRequest = {
        userMessage: messageText,
      };
      const savedSession = await withmateApi.runSessionTurn(selectedSession.id, request);
      setSessions([savedSession]);
    } catch (error) {
      console.error(error);
      setLiveRunState((current) => (
        current.ownerSessionId === updatedSession.id
          ? { ownerSessionId: updatedSession.id, state: null }
          : current
      ));
      setSessions([selectedSession]);
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
        window.alert(error instanceof Error ? error.message : "送信に失敗したよ。");
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
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "送信に失敗したよ。");
    }
  };

  const handleCancelRun = async () => {
    if (!withmateApi || !selectedSession || selectedSession.runState !== "running") {
      return;
    }

    try {
      await withmateApi.cancelSessionRun(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "キャンセルに失敗したよ。");
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
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const canNavigatePathMatches =
      workspacePathMatches.length > 0
      && !isComposerImeComposing
      && !event.nativeEvent.isComposing;

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

    if (
      event.key !== "Enter" ||
      (!event.ctrlKey && !event.metaKey) ||
      (activeAuxiliarySession ? activeAuxiliarySession.runState === "running" : composerSendability.isRunning)
    ) {
      return;
    }

    event.preventDefault();
    const activeSendability = activeAuxiliarySession
      ? buildComposerSendabilityState({
          runState: activeAuxiliarySession.runState,
          blockedReason: composerBlockedReason,
          inputErrors: composerPreview.errors,
          draftText: activeAuxiliarySession.composerDraft,
        })
      : composerSendability;
    const isActiveSendDisabled = activeAuxiliarySession
      ? activeSendability.isSendDisabled || isAuxiliaryActionPending
      : isSendDisabled;
    if (isActiveSendDisabled) {
      triggerComposerBlockedFeedback();
      return;
    }
    void handleSend();
  };

  const handleSelectWorkspacePathMatch = (match: string) => {
    const textarea = composerTextareaRef.current;
    const activeReference = getActivePathReference(activeComposerDraft, composerCaret);
    if (!textarea || !activeReference) {
      return;
    }

    const replacement = formatPathReference(match);
    const nextDraft = [
      activeComposerDraft.slice(0, activeReference.start),
      replacement,
      activeComposerDraft.slice(activeReference.end),
    ].join("");
    const nextCaret = activeReference.start + replacement.length;
    setComposerCaret(nextCaret);
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setDraft(nextDraft);
      mainComposerCaretRef.current = nextCaret;
    }
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);

    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleSelectSkill = (skill: DiscoveredSkill) => {
    const textarea = composerTextareaRef.current;
    if (!selectedSession) {
      return;
    }

    const snippet = buildSkillPromptSnippet(selectedSession.provider, skill.name);
    const trimmedDraft = draft.trimStart();
    const nextDraft = trimmedDraft ? `${snippet}\n\n${trimmedDraft}` : `${snippet}\n`;
    const nextCaret = nextDraft.length;

    setIsActionDockPinnedExpanded(true);
    setDraft(nextDraft);
    setComposerCaret(nextCaret);
    mainComposerCaretRef.current = nextCaret;
    setIsSkillPickerOpen(false);

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleSelectCustomAgent = async (agent: DiscoveredCustomAgent | null) => {
    if (!selectedSession || isSelectedSessionReadOnly || selectedSession.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = agent?.name ?? "";
    if (nextCustomAgentName === selectedSession.customAgentName) {
      setIsAgentPickerOpen(false);
      return;
    }

    const nextSession: Session = applyCopilotCustomAgentSelection(
      selectedSession,
      nextCustomAgentName,
      currentTimestampLabel(),
    );

    await persistSession(nextSession);
    setIsAgentPickerOpen(false);
  };

  const persistSession = async (nextSession: Session) => {
    if (!withmateApi || isSelectedSessionReadOnly) {
      throw new Error(
        isSelectedSessionReadOnly
          ? "旧バージョンから移行された閲覧専用セッションは更新できないよ。"
          : "Session Window は Electron から開いてね。",
      );
    }

    const savedSession = await withmateApi.updateSession(nextSession);
    setSessions([savedSession]);
    return savedSession;
  };

  const handleChangeApproval = async (approvalMode: Session["approvalMode"]) => {
    if (
      !selectedSession ||
      isSelectedSessionReadOnly ||
      selectedSession.runState === "running" ||
      approvalMode === selectedSession.approvalMode
    ) {
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      approvalMode,
      updatedAt: currentTimestampLabel(),
    };

    await persistSession(nextSession);
  };

  const handleChangeCodexSandboxMode = async (codexSandboxMode: Session["codexSandboxMode"]) => {
    if (
      !selectedSession ||
      selectedSession.provider !== "codex" ||
      isSelectedSessionReadOnly ||
      selectedSession.runState === "running" ||
      codexSandboxMode === selectedSession.codexSandboxMode
    ) {
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      codexSandboxMode,
      updatedAt: currentTimestampLabel(),
    };

    await persistSession(nextSession);
  };

  const handleStartTitleEdit = () => {
    if (!selectedSession || isSelectedSessionReadOnly || selectedSession.runState === "running") {
      return;
    }

    setTitleDraft(selectedSession.taskTitle);
    setIsHeaderExpanded(true);
    setIsEditingTitle(true);
  };

  const handleCancelTitleEdit = () => {
    setTitleDraft(selectedSession?.taskTitle ?? "");
    setIsEditingTitle(false);
  };

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
    if (!withmateApi || !selectedSession || selectedSession.runState === "running") {
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

    const selection = resolveModelChangeSelection(selectedProviderCatalog, model, selectedSession.reasoningEffort);
    const nextSession: Session = applySessionModelMetadataUpdate(
      selectedSession,
      selection,
      modelCatalog.revision,
      currentTimestampLabel(),
    );

    await persistSession(nextSession);
  };

  const handleChangeReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedSession || isSelectedSessionReadOnly || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, selectedSession.model, reasoningEffort);
    const nextSession: Session = applySessionModelMetadataUpdate(
      selectedSession,
      selection,
      modelCatalog.revision,
      currentTimestampLabel(),
    );

    await persistSession(nextSession);
  };

  const updateActiveAuxiliarySession = async (recipe: (current: AuxiliarySession) => AuxiliarySession) => {
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
  };

  const handleChangeAuxiliaryApproval = async (approvalMode: Session["approvalMode"]) => {
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      approvalMode,
      updatedAt: currentTimestampLabel(),
    }));
  };

  const handleChangeAuxiliarySandboxMode = async (codexSandboxMode: Session["codexSandboxMode"]) => {
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      codexSandboxMode,
      updatedAt: currentTimestampLabel(),
    }));
  };

  const handleChangeAuxiliaryModel = async (model: string) => {
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
  };

  const handleChangeAuxiliaryReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedProviderCatalog || !modelCatalog || !activeAuxiliarySession) {
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
  };

  const handleSelectAuxiliaryCustomAgent = async (agent: DiscoveredCustomAgent | null) => {
    if (!activeAuxiliarySession || activeAuxiliarySession.provider !== "copilot") {
      return;
    }

    const nextCustomAgentName = (agent?.name ?? "").trim();
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
  };

  const handleSelectAuxiliarySkill = async (skill: DiscoveredSkill) => {
    const textarea = composerTextareaRef.current;
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

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleResendLastMessage = async () => {
    if (!lastUserMessage || composerBlockedReason || isSelectedSessionReadOnly) {
      return;
    }

    await sendMessage(lastUserMessage.text, { clearDraft: false });
  };

  const restoreLastUserMessageToDraft = (messageText: string) => {
    const textarea = composerTextareaRef.current;
    const nextDraft = messageText;
    const nextCaret = nextDraft.length;
    setIsActionDockPinnedExpanded(true);
    setDraft(nextDraft);
    setComposerCaret(nextCaret);
    mainComposerCaretRef.current = nextCaret;
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    setIsRetryDraftReplacePending(false);

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleEditLastMessage = () => {
    if (!retryBanner || !lastUserMessage || isRetryEditDisabled) {
      return;
    }

    if (shouldProtectDraftOnRetryEdit) {
      setIsRetryDraftReplacePending(true);
      return;
    }

    restoreLastUserMessageToDraft(lastUserMessage.text);
  };

  const handleConfirmRetryDraftReplace = () => {
    if (!retryBanner || !lastUserMessage || isRetryEditDisabled) {
      return;
    }

    restoreLastUserMessageToDraft(lastUserMessage.text);
  };

  const handleCancelRetryDraftReplace = () => {
    setIsRetryDraftReplacePending(false);
  };

  const handleCloseWindow = () => {
    window.close();
  };

  const handleToggleHeaderExpanded = () => {
    if (isEditingTitle) {
      return;
    }

    setIsHeaderExpanded((current) => !current);
  };

  const handleExpandActionDock = (options?: { focusComposer?: boolean }) => {
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
  };

  const handleCollapseActionDock = () => {
    if (!canCollapseActionDock) {
      return;
    }

    setIsActionDockPinnedExpanded(false);
  };

  const handleOpenInlinePath = async (target: string) => {
    if (!withmateApi) {
      return;
    }

    try {
      await withmateApi.openPath(target, { baseDirectory: selectedSession?.workspacePath ?? null });
    } catch {
      // 読みやすさ改善が主目的なので、開けない場合は UI を壊さない
    }
  };

  const handleCancelAuxiliaryRun = async () => {
    if (!withmateApi || !activeAuxiliarySession || activeAuxiliarySession.runState !== "running") {
      return;
    }

    try {
      await withmateApi.cancelAuxiliarySessionRun(activeAuxiliarySession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "キャンセルに失敗したよ。");
    }
  };

  const handleStartAuxiliarySession = async () => {
    if (!withmateApi || !selectedSession || isAuxiliaryActionPending) {
      return;
    }

    const loadRevision = auxiliaryLoadRevisionRef.current + 1;
    auxiliaryLoadRevisionRef.current = loadRevision;
    const parentSessionId = selectedSession.id;
    const canApplyLoadResult = () => auxiliaryLoadRevisionRef.current === loadRevision;

    setIsAuxiliaryActionPending(true);
    try {
      const session = await withmateApi.createAuxiliarySession(parentSessionId);
      setActiveAuxiliarySession(session);
      setIsActionDockPinnedExpanded(true);
      setForceComposerBlockedFeedback(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Auxiliary Session の開始に失敗したよ。");
    } finally {
      void loadClosedAuxiliarySessions(parentSessionId, canApplyLoadResult);
      setIsAuxiliaryActionPending(false);
    }
  };

  const handleReturnToMainSession = async () => {
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
      setComposerCaret(Math.min(mainComposerCaretRef.current, draft.length));
      setIsActionDockPinnedExpanded(false);
      setForceComposerBlockedFeedback(false);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Auxiliary Session の終了に失敗したよ。");
    } finally {
      setIsAuxiliaryActionPending(false);
    }
  };

  const handleAuxiliaryDraftChange = async (value: string, selectionStart: number) => {
    setForceComposerBlockedFeedback(false);
    setComposerCaret(selectionStart);
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
    try {
      const saveOperation = auxiliaryDraftSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const current = activeAuxiliarySessionRef.current;
          if (!current || current.id !== nextSession.id) {
            return null;
          }
          if (current.composerDraft !== value) {
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
        if (!current || !hasSameAuxiliaryDraftSaveContext(current, request)) {
          return current;
        }

        activeAuxiliarySessionRef.current = saved;
        return saved;
      });
    } catch (error) {
      console.error(error);
    }
  };

  const sendAuxiliaryMessage = async (messageText: string) => {
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    const nextMessage = messageText.trim();
    if (!nextMessage) {
      throw new Error("送信するメッセージが空だよ。");
    }
    if (activeAuxiliarySession.runState === "running") {
      throw new Error("Auxiliary Session はまだ実行中だよ。");
    }
    if (composerBlockedReason) {
      throw new Error(composerBlockedReason);
    }

    setIsActionDockPinnedExpanded(false);
    const runningSession: AuxiliarySession = {
      ...activeAuxiliarySession,
      runState: "running",
      composerDraft: "",
      updatedAt: currentTimestampLabel(),
      messages: [...activeAuxiliarySession.messages, { role: "user", text: nextMessage }],
    };
    activeAuxiliarySessionRef.current = runningSession;
    setActiveAuxiliarySession(runningSession);
    setLiveRunState((current) => (
      current.ownerSessionId === runningSession.id
        ? { ownerSessionId: runningSession.id, state: createPendingLiveSessionRunState(buildAuxiliaryRuntimeSession(selectedSession!, runningSession), current.state) }
        : { ownerSessionId: runningSession.id, state: createPendingLiveSessionRunState(buildAuxiliaryRuntimeSession(selectedSession!, runningSession)) }
    ));

    try {
      const saved = await withmateApi.runAuxiliarySessionTurn(activeAuxiliarySession.id, { userMessage: nextMessage });
      activeAuxiliarySessionRef.current = saved;
      setActiveAuxiliarySession(saved);
    } catch (error) {
      console.error(error);
      setLiveRunState((current) => (
        current.ownerSessionId === runningSession.id ? { ownerSessionId: runningSession.id, state: null } : current
      ));
      activeAuxiliarySessionRef.current = activeAuxiliarySession;
      setActiveAuxiliarySession(activeAuxiliarySession);
      throw error;
    }
  };

  const handleCopyMessageText = (text: string) => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    void navigator.clipboard.writeText(normalized).catch((error) => {
      console.error(error);
      window.alert("コピーに失敗したよ。");
    });
  };

  const insertTextIntoMainComposer = (text: string) => {
    if (!text) {
      return;
    }

    const textarea = activeAuxiliarySession ? null : composerTextareaRef.current;
    const { draft: nextDraft, caret: nextCaret } = insertComposerTextAtCaret(
      draft,
      text,
      textarea?.selectionStart ?? mainComposerCaretRef.current,
    );

    setDraft(nextDraft);
    mainComposerCaretRef.current = nextCaret;
    if (!activeAuxiliarySession) {
      setComposerCaret(nextCaret);
    }
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);

    window.requestAnimationFrame(() => {
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const insertTextIntoAuxiliaryComposer = (text: string) => {
    if (!text || !activeAuxiliarySession) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const { draft: nextDraft, caret: nextCaret } = insertComposerTextAtCaret(
      activeAuxiliarySession.composerDraft,
      text,
      textarea?.selectionStart ?? composerCaret,
    );

    void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const handleQuoteMessageText = (text: string) => {
    const quote = formatMarkdownQuote(text);
    if (activeAuxiliarySession) {
      if (activeAuxiliarySession.runState === "running" || isAuxiliaryActionPending || composerBlockedReason) {
        triggerComposerBlockedFeedback();
        return;
      }

      insertTextIntoAuxiliaryComposer(quote);
      return;
    }

    if (isComposerDisabled) {
      triggerComposerBlockedFeedback();
      return;
    }

    insertTextIntoMainComposer(quote);
  };

  const insertReferencePaths = (selectedPaths: string[]) => {
    if (selectedPaths.length === 0) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = targetAuxiliarySession ? targetAuxiliarySession.composerDraft : draft;
    const referenceTokens = selectedPaths.map((selectedPath) => {
      const referencePath = selectedSession
        ? toWorkspaceRelativeReference(selectedSession.workspacePath, selectedPath) ?? normalizePathForReference(selectedPath)
        : normalizePathForReference(selectedPath);
      return formatPathReference(referencePath);
    });
    const currentCaret = textarea?.selectionStart ?? composerCaret;
    const leadingSpacer = currentCaret > 0 && !/\s/.test(currentDraft[currentCaret - 1] ?? "") ? " " : "";
    const trailingSpacer = currentDraft.length > currentCaret && !/\s/.test(currentDraft[currentCaret] ?? "") ? " " : "";
    const insertion = `${leadingSpacer}${referenceTokens.join(" ")}${trailingSpacer}`;
    const nextDraft = `${currentDraft.slice(0, currentCaret)}${insertion}${currentDraft.slice(currentCaret)}`;
    const nextCaret = currentCaret + insertion.length;

    if (targetAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setDraft(nextDraft);
      mainComposerCaretRef.current = nextCaret;
    }
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
  };

  const insertReferencePath = (selectedPath: string) => {
    insertReferencePaths([selectedPath]);
  };

  const handleRemoveAttachmentReference = (attachmentPathCandidates: string[]) => {
    const escapedCandidates = attachmentPathCandidates
      .map((candidate) => formatPathReference(candidate))
      .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    const targetAuxiliarySession = activeAuxiliarySession;
    let nextDraft = targetAuxiliarySession ? targetAuxiliarySession.composerDraft : draft;
    for (const escapedCandidate of escapedCandidates) {
      nextDraft = nextDraft.replace(
        new RegExp(`(^|[\\s(])${escapedCandidate}(?=\\s|$|[),.;:!?])`),
        (_match, leadingWhitespace: string) => leadingWhitespace || "",
      );
    }

    nextDraft = nextDraft
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");

    if (targetAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextDraft.length);
    } else {
      setDraft(nextDraft);
      mainComposerCaretRef.current = nextDraft.length;
    }
    setComposerCaret(nextDraft.length);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
  };

  const handlePickFile = async () => {
    if (!withmateApi || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickFile(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath);
  };

  const handlePickFolder = async () => {
    if (!withmateApi || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(selectedPath);
    insertReferencePath(selectedPath);
  };

  const handlePickImage = async () => {
    if (!withmateApi || isSelectedSessionReadOnly) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await withmateApi.pickImageFile(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath);
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

    setPickerBaseDirectory(toDirectoryPath(selectedPaths[0]));
    insertReferencePaths(savedPaths);
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

    setPickerBaseDirectory(toDirectoryPath(selectedPaths[0]));
    insertReferencePaths(selectedPaths);
  };

  const handleComposerPaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const targetAuxiliarySession = activeAuxiliarySession;
    if (
      !withmateApi ||
      !selectedSession ||
      isSelectedSessionReadOnly ||
      (targetAuxiliarySession ? targetAuxiliarySession.runState === "running" : selectedSession.runState === "running")
    ) {
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
        sessionId: selectedSession.id,
        fileName,
        data: buffer,
      });
      savedPaths.push(savedPath);
    }

    insertReferencePaths(savedPaths);
  };

  const handleAddAdditionalDirectory = async () => {
    if (!withmateApi || !selectedSession || isSelectedSessionReadOnly || selectedSession.runState === "running") {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || selectedSession.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    const nextDirectories = Array.from(new Set([...selectedSession.allowedAdditionalDirectories, selectedPath]));
    const nextSession: Session = {
      ...selectedSession,
      allowedAdditionalDirectories: nextDirectories,
    };
    setPickerBaseDirectory(selectedPath);
    await persistSession(nextSession);
  };

  const handleRemoveAdditionalDirectory = async (directoryPath: string) => {
    if (!selectedSession || isSelectedSessionReadOnly || selectedSession.provider !== "codex" || selectedSession.runState === "running") {
      return;
    }

    const nextDirectories = selectedSession.allowedAdditionalDirectories.filter((entry) => entry !== directoryPath);
    if (nextDirectories.length === selectedSession.allowedAdditionalDirectories.length) {
      return;
    }

    const nextSession: Session = {
      ...selectedSession,
      allowedAdditionalDirectories: nextDirectories,
    };
    await persistSession(nextSession);
  };

  const handleAddAuxiliaryAdditionalDirectory = async () => {
    if (!withmateApi || !selectedSession || !activeAuxiliarySession || activeAuxiliarySession.runState === "running") {
      return;
    }

    const selectedPath = await withmateApi.pickDirectory(pickerBaseDirectory || selectedSession.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(selectedPath);
    await updateActiveAuxiliarySession((current) => ({
      ...current,
      allowedAdditionalDirectories: Array.from(new Set([...current.allowedAdditionalDirectories, selectedPath])),
      updatedAt: currentTimestampLabel(),
    }));
  };

  const handleRemoveAuxiliaryAdditionalDirectory = async (directoryPath: string) => {
    await updateActiveAuxiliarySession((current) => {
      const nextDirectories = current.allowedAdditionalDirectories.filter((entry) => entry !== directoryPath);
      return {
        ...current,
        allowedAdditionalDirectories: nextDirectories,
        updatedAt: currentTimestampLabel(),
      };
    });
  };

  const handleTitleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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

  const toggleArtifact = (artifactKey: string) => {
    setExpandedArtifacts((current) => ({
      ...current,
      [artifactKey]: !current[artifactKey],
    }));
  };

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

    try {
      await withmateApi.openPath(selectedSession.workspacePath);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Explorer を開けなかったよ。");
    }
  };

  const handleOpenSessionFilesTerminal = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    try {
      await withmateApi.openSessionFilesTerminal(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "session files terminal の起動に失敗したよ。");
    }
  };

  const handleOpenSessionFilesExplorer = async () => {
    if (!withmateApi || !selectedSession) {
      return;
    }

    try {
      await withmateApi.openSessionFilesDirectory(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "session files directory を開けなかったよ。");
    }
  };

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
  const isSelectedSessionRunning = selectedSessionRunState === "running";
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
    if (!availableContextPaneTabs.includes(activeContextPaneTab)) {
      setActiveContextPaneTab(availableContextPaneTabs[0] ?? "latest-command");
    }
  }, [activeContextPaneTab, availableContextPaneTabs]);

  const handleCycleContextPaneTab = (direction: -1 | 1) => {
    setActiveContextPaneTab((current) => cycleContextPaneTab(current, direction, availableContextPaneTabs));
  };

  const auxiliaryComposerSendability = useMemo(
    () => buildComposerSendabilityState({
      runState: activeAuxiliarySession?.runState,
      blockedReason: composerBlockedReason,
      inputErrors: composerPreview.errors,
      draftText: activeAuxiliarySession?.composerDraft ?? "",
    }),
    [
      activeAuxiliarySession?.composerDraft,
      activeAuxiliarySession?.runState,
      composerBlockedReason,
      composerPreview.errors,
    ],
  );
  const renderedSession = displayedSession;
  const renderedMessages = messageListMessages;
  const renderedDraft = activeAuxiliarySession ? activeAuxiliarySession.composerDraft : draft;
  const renderedComposerSendability = activeAuxiliarySession ? auxiliaryComposerSendability : composerSendability;
  const renderedIsSendDisabled = activeAuxiliarySession
    ? auxiliaryComposerSendability.isSendDisabled || isAuxiliaryActionPending
    : isSendDisabled;
  const renderedComposerButtonTitle = activeAuxiliarySession
    ? getComposerSendButtonTitle(auxiliaryComposerSendability)
    : composerSendButtonTitle;
  const auxiliaryHeaderActions = activeAuxiliarySession ? (
    <div className="session-window-control-group auxiliary-session-control-group" role="group" aria-label="Auxiliary session actions">
      <span className="session-window-control-group-label">Auxiliary</span>
      <button
        className="drawer-toggle compact secondary"
        type="button"
        onClick={() => void handleReturnToMainSession()}
        disabled={isAuxiliaryActionPending || activeAuxiliarySession.runState === "running"}
      >
        Return to main
      </button>
    </div>
  ) : (
    <div className="session-window-control-group auxiliary-session-control-group" role="group" aria-label="Auxiliary session actions">
      <button
        className="drawer-toggle compact secondary"
        type="button"
        onClick={() => void handleStartAuxiliarySession()}
        disabled={isAuxiliaryActionPending || isSelectedSessionRunning || isSelectedSessionReadOnly}
      >
        Auxiliary
      </button>
    </div>
  );

  if (!desktopRuntime) {
    return <ChatWindowStatusScreen message="Session Window は Electron から開いてね。" />;
  }

  if (!selectedSession || !renderedSession || !selectedSessionCharacter) {
    return <ChatWindowStatusScreen message="Session が選択されていません。Home Window から session を開いてね。" />;
  }

  return (
    <>
      <ChatWindow
      {...buildAgentSessionChatWindowProps({
        selectedSession: renderedSession,
        selectedSessionCharacter,
        displayedMessages: renderedMessages,
        displayedMessageKeys: messageListKeys,
        displayedMessageBoundaries: messageListBoundaries,
        expandedArtifacts,
        sessionThemeStyle,
        sessionWorkbenchRef,
        sessionWorkbenchStyle,
        isSessionHeaderExpanded,
        isEditingTitle,
        titleDraft,
        isSelectedSessionRunning: renderedIsRunning,
        isSelectedSessionReadOnly: activeAuxiliarySession ? true : isSelectedSessionReadOnly,
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
        isMessageListFollowing,
        retryBanner: activeAuxiliarySession ? null : retryBanner,
        isRetryDetailsOpen,
        isRetryActionDisabled,
        isRetryEditDisabled,
        isRetryDraftReplacePending,
        composerBlocked: !!composerBlockedReason,
        isAgentPickerOpen,
        isSkillPickerOpen,
        isAdditionalDirectoryListOpen,
        selectedCustomAgentLabel: selectedCustomAgentDisplay.label,
        selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択",
        canCollapseActionDock,
        isCustomAgentListLoading,
        isSkillListLoading,
        customAgentItems,
        skillItems,
        composerAttachmentItems,
        additionalDirectoryItems,
        workspacePathMatchItems,
        draft: renderedDraft,
        composerTextareaRef,
        isComposerDisabled: activeAuxiliarySession
          ? activeAuxiliarySession.runState === "running" || !!composerBlockedReason || isAuxiliaryActionPending
          : isComposerDisabled,
        isSendDisabled: renderedIsSendDisabled,
        composerSendability: renderedComposerSendability,
        composerSendButtonTitle: renderedComposerButtonTitle,
        isComposerBlockedFeedbackActive: forceComposerBlockedFeedback && renderedComposerSendability.shouldShowFeedback,
        approvalChoiceOptions,
        sandboxChoiceOptions,
        modelSelectOptions,
        selectedModelFallbackLabel,
        reasoningSelectOptions,
        actionDockCompactPreview: activeAuxiliarySession
          ? (renderedDraft.trim() || (activeAuxiliarySession.runState === "running" ? "実行中" : "下書きなし"))
          : actionDockCompactPreview,
        attachmentCount: composerPreview.attachments.length,
        isActionDockExpanded,
        isContextRailResizing,
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
        auditLogSourceLabel: "Main Session",
        auditLogDetails,
        auditLogOperationDetails,
        auditLogsHasMore: auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.hasMore : false,
        auditLogsLoading: auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.loading : false,
        auditLogsTotal: auditLogsState.ownerSessionId === selectedSessionId
          ? Math.max(auditLogsState.total, displayedSessionAuditLogs.length)
          : displayedSessionAuditLogs.length,
        auditLogsErrorMessage: auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.errorMessage : null,
        onToggleHeaderExpanded: handleToggleHeaderExpanded,
        headerActions: auxiliaryHeaderActions,
        onOpenAuditLog: () => setAuditLogsOpen(true),
        onOpenSessionTerminal: () => void handleOpenSessionTerminal(),
        onOpenSessionFilesTerminal: () => void handleOpenSessionFilesTerminal(),
        onTitleDraftChange: setTitleDraft,
        onTitleInputKeyDown: handleTitleInputKeyDown,
        onSaveTitle: () => void handleSaveTitle(),
        onCancelTitleEdit: handleCancelTitleEdit,
        onStartTitleEdit: handleStartTitleEdit,
        onDeleteSession: () => void handleDeleteSession(),
        onOpenSessionExplorer: () => void handleOpenSessionExplorer(),
        onOpenSessionFilesExplorer: () => void handleOpenSessionFilesExplorer(),
        onMessageListScroll: handleMessageListScroll,
        onToggleArtifact: toggleArtifact,
        onLoadArtifactDetail: (messageIndex) => {
          const source = messageListSources[messageIndex];
          if (!source) {
            return Promise.resolve(null);
          }
          if (source.kind === "auxiliary") {
            return Promise.resolve(source.artifact ?? null);
          }

          return (
            withmateApi?.getSessionMessageArtifact(selectedSession.id, source.messageIndex) ??
            Promise.resolve(null)
          );
        },
        onOpenDiff: (title, file) =>
          setSelectedDiff({
            title,
            file,
            themeColors: selectedSession.characterThemeColors,
          }),
        onResolveLiveApproval: (request, decision) => void handleResolveLiveApproval(request, decision),
        onResolveLiveElicitation: (request, response) => void handleResolveLiveElicitation(request, response),
        onOpenInlinePath: handleOpenInlinePath,
        getChangedFilesEmptyText: (artifactKey, artifactHasSnapshotRisk) =>
          artifactHasSnapshotRisk
            ? "差分は見つからなかったけど、snapshot の上限や省略で取りこぼしがあるかもしれないよ。"
            : resolveSessionMicrocopy("empty.changed_files", ["changed-files-empty", artifactKey]),
        onCopyMessageText: handleCopyMessageText,
        onQuoteMessageText: handleQuoteMessageText,
        onToggleRetryDetails: () => setIsRetryDetailsOpen((current) => !current),
        onResendLastMessage: () => void handleResendLastMessage(),
        onEditLastMessage: handleEditLastMessage,
        onConfirmRetryDraftReplace: handleConfirmRetryDraftReplace,
        onCancelRetryDraftReplace: handleCancelRetryDraftReplace,
        onPickFile: () => void handlePickFile(),
        onPickFolder: () => void handlePickFolder(),
        onPickImage: () => void handlePickImage(),
        onAddToSessionFiles: () => void handleAddToSessionFiles(),
        onPickSessionFiles: () => void handlePickSessionFiles(),
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
          setDraft(value);
          setComposerCaret(selectionStart);
          mainComposerCaretRef.current = selectionStart;
        },
        onDraftFocus: () => setIsActionDockPinnedExpanded(true),
        onDraftKeyDown: handleComposerKeyDown,
        onDraftPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void handleComposerPaste(event),
        onDraftSelect: (selectionStart) => {
          setComposerCaret(selectionStart);
          if (!activeAuxiliarySession) {
            mainComposerCaretRef.current = selectionStart;
          }
        },
        onDraftCompositionStart: () => setIsComposerImeComposing(true),
        onDraftCompositionEnd: () => {
          setIsComposerImeComposing(false);
          const selectionStart = composerTextareaRef.current?.selectionStart ?? renderedDraft.length;
          setComposerCaret(selectionStart);
          if (!activeAuxiliarySession) {
            mainComposerCaretRef.current = selectionStart;
          }
        },
        onSendOrCancel: () => void (
          activeAuxiliarySession?.runState === "running"
            ? handleCancelAuxiliaryRun()
            : renderedSession.runState === "running"
              ? handleCancelRun()
              : handleSend()
        ),
        onExpandActionDock: () => handleExpandActionDock({ focusComposer: renderedSession.runState !== "running" }),
        onSelectWorkspacePathMatch: handleSelectWorkspacePathMatch,
        onActivateWorkspacePathMatch: setActiveWorkspacePathMatchIndex,
        onChangeApprovalMode: (value) => void (activeAuxiliarySession ? handleChangeAuxiliaryApproval(value) : handleChangeApproval(value)),
        onChangeCodexSandboxMode: (value) => void (activeAuxiliarySession ? handleChangeAuxiliarySandboxMode(value) : handleChangeCodexSandboxMode(value)),
        onChangeModel: (value) => void (activeAuxiliarySession ? handleChangeAuxiliaryModel(value) : handleChangeModel(value)),
        onChangeReasoningEffort: (value) => void (activeAuxiliarySession ? handleChangeAuxiliaryReasoningEffort(value as Session["reasoningEffort"]) : handleChangeReasoningEffort(value as Session["reasoningEffort"])),
        onStartContextRailResize: handleStartContextRailResize,
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
    </>
  );
}
