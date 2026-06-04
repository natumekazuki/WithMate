import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";

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
  addAllowedAdditionalDirectory,
  removeAllowedAdditionalDirectory,
} from "./additional-directory-state.js";
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
import { buildAuxiliaryAwareSendOrCancelHandler } from "./chat/send-or-cancel.js";
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
  cycleContextPaneTab,
  type ContextPaneTabKey,
  resolveAvailableContextPaneTabs,
} from "./session-ui-projection.js";
import { buildMainAuxiliaryRuntimeSession } from "./auxiliary-runtime-projection.js";
import { ChatWindow, ChatWindowStatusScreen } from "./chat/chat-window.js";
import {
  buildCreateAuxiliarySessionInput,
  buildAuxiliaryLaunchProviderItems,
  resolveAuxiliaryLaunchStartError,
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
  withForcedComposerBlockedFeedback,
  type ComposerSendabilityState,
} from "./session-composer-feedback.js";
import { buildActionDockCompactPreview } from "./action-dock-preview.js";
import {
  buildActionDockCollapseState,
  buildActionDockExpandState,
  buildActionDockRuntimeState,
} from "./action-dock-state.js";
import {
  buildExclusiveComposerPickerToggleState,
  buildCustomAgentMatchDisplay,
  buildSelectedCustomAgentDisplay,
  buildSkillMatchDisplay,
  buildSkillPromptInsertionState,
} from "./session-composer-selection.js";
import {
  buildAdditionalDirectoryItems,
  buildClosedWorkspacePathMatchState,
  buildComposerAttachmentItems,
  buildPathReferenceRemovalWithClosedWorkspaceMatchesState,
  buildSelectedPathReferenceInsertionState,
  buildWorkspacePathMatchSelectionState,
  pickComposerReferencePath,
  resolvePickedPathBaseDirectory,
  type ComposerPathPickerKind,
  toDirectoryPath,
} from "./session-composer-paths.js";
import {
  buildOnDraftCompositionEndHandler,
  buildOnDraftCompositionStartHandler,
  buildOnDraftSelectHandler,
} from "./chat/composer-draft-handlers.js";
import {
  createEmptyComposerPreview,
} from "./composer-preview-config.js";
import {
  useSessionContextRail,
  useSessionMessageListFollowing,
} from "./session-chat-layout-hooks.js";
import {
  clearOwnedLiveSessionRunState,
  createOptimisticRunningSessionState,
  createOwnedPendingLiveSessionRunState,
  replaceLiveRunAfterResolvedRequest,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
import { buildAgentSessionChatWindowProps } from "./chat/session-chat-projection.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCompanionGroupMonitorEntries } from "./home/home-session-projection.js";
import { resolveLastUsedSessionSelection } from "./home/home-launch-state.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import {
  addAuxiliarySessionAdditionalDirectory,
  applyAuxiliarySessionComposerDraftPatch,
  applyAuxiliarySessionCustomAgentPatch,
  applyAuxiliarySessionModelSelectionPatch,
  applyAuxiliarySessionRuntimeOptionsPatch,
  buildAuxiliarySessionRunningTransition,
  loadClosedAuxiliarySessionDetails,
  removeAuxiliarySessionAdditionalDirectory,
  resolveActiveAuxiliarySessionRefreshResult,
  resolveAuxiliarySessionSendPreflight,
  resolveAuxiliarySessionSendTarget,
  resolveClosedAuxiliarySessionsAfterReturn,
  type AuxiliarySession,
} from "./auxiliary-session-state.js";
import { useComposerPreviewResolution } from "./chat/use-composer-preview-resolution.js";
import { useComposerPathReferencePreview } from "./chat/use-composer-path-reference-preview.js";
import { useWorkspacePathMatchSearchFlow } from "./chat/use-workspace-path-match-search-flow.js";
import { useWorkspacePathMatchState } from "./chat/use-workspace-path-match-state.js";
import { handleWorkspacePathMatchKeyboardNavigation } from "./chat/workspace-path-match-keyboard.js";
import {
  resolveOwnedProviderQuotaTelemetry,
  resolveOwnedSessionContextTelemetry,
  type ProviderOwnedQuotaTelemetry,
  type SessionOwnedContextTelemetry,
} from "./session-telemetry-state.js";
import {
  copyMessageTextToClipboardWithFailureHandler,
  createQuotedMessageInsertionFromComposer,
} from "./chat/message-text-actions.js";
import { isTerminalAuditLogPhase } from "./audit-log-phase.js";
import {
  buildRetryDraftRestoreState,
  buildRetryStopSummary,
  defaultRetryBannerDetailsOpen,
  isRetryActionDisabled as resolveRetryActionDisabled,
  resolveRetryBannerKind,
  shouldProtectRetryEditDraft,
  shouldShowRetryBanner,
  type RetryBannerKind,
  type RetryBannerState,
} from "./chat/retry-state.js";
import {
  buildMessageListProjection,
  loadProjectedMessageArtifact,
  resolvePendingAuxiliaryMessageGroupId,
} from "./auxiliary-session-message-projection.js";
import {
  resolveAuxiliaryDraftSaveOperationResult,
  scheduleAuxiliaryDraftSaveOperation,
} from "./auxiliary-draft-save-context.js";
import {
  enqueueAuxiliarySessionSaveOperation,
  resolveAuxiliarySessionRollbackSession,
  runAuxiliarySessionUpdateOperation,
} from "./auxiliary-session-update-operation.js";

const DEFAULT_SESSION_RUNTIME_NAME = "Mate";

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
  const [liveRunState, setLiveRunState] = useState<OwnedLiveSessionRunState>({ ownerSessionId: null, state: null });
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
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>(() => createEmptyComposerPreview());
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const {
    workspacePathMatches,
    activeWorkspacePathMatchIndex,
    setActiveWorkspacePathMatchIndex,
    applyWorkspacePathMatchState,
    workspacePathMatchItems,
  } = useWorkspacePathMatchState();
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
      ? buildMainAuxiliaryRuntimeSession(selectedSession, activeAuxiliarySession)
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
      const sessions = await loadClosedAuxiliarySessionDetails({
        parentSessionId,
        listAuxiliarySessions: (sessionId) => withmateApi.listAuxiliarySessions(sessionId),
        getAuxiliarySession: (sessionId) => withmateApi.getAuxiliarySession(sessionId),
      });
      if (canApplyLoadResult()) {
        setClosedAuxiliarySessions(sessions);
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
    () => resolveOwnedProviderQuotaTelemetry(providerQuotaTelemetryState, displayedSession?.provider),
    [displayedSession?.provider, providerQuotaTelemetryState.ownerProviderId, providerQuotaTelemetryState.telemetry],
  );
  const selectedSessionContextTelemetry = useMemo(
    () => resolveOwnedSessionContextTelemetry(sessionContextTelemetryState, activeRunSessionId),
    [activeRunSessionId, sessionContextTelemetryState.ownerSessionId, sessionContextTelemetryState.telemetry],
  );
  const activeComposerDraft = activeAuxiliarySession?.composerDraft ?? draft;
  const {
    activePathReference,
    hasPreviewPathReferenceCandidates,
    isEditingPathReference,
    normalizedActivePathQuery,
    previewPathReferenceCandidates,
    previewPathReferenceSignature,
    previewDraft,
    previewUserMessage,
  } = useComposerPathReferencePreview({
    draft: activeComposerDraft,
    caret: composerCaret,
    isEnabled: Boolean(selectedSessionId),
  });
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

    if (!withmateApi || !activeRunSessionId) {
      setAvailableSkills([]);
      setIsSkillListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsSkillListLoading(true);
    void withmateApi.listSessionSkills(activeRunSessionId).then((skills) => {
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
  }, [activeRunSessionId, appSettings, withmateApi]);

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
  const messageListGroups = messageListProjection.groups;
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
    setComposerPreview(createEmptyComposerPreview());
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setComposerCaret(0);
    mainComposerCaretRef.current = 0;
    applyWorkspacePathMatchState(buildClosedWorkspacePathMatchState());
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
  }, [applyWorkspacePathMatchState, selectedSession?.provider, selectedSessionId]);

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
          const nextSession = resolveActiveAuxiliarySessionRefreshResult({
            currentSession: current,
            savedSession: saved,
            sessionId,
          });
          if (nextSession !== current) {
            activeAuxiliarySessionRef.current = nextSession;
          }

          return nextSession;
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
    const providerId = displayedSession?.provider ?? null;

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
  }, [displayedSession?.provider, withmateApi]);

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

  const previewComposerInput = useMemo(() => {
    if (!withmateApi || !activeRunSessionId) {
      return null;
    }
    return (message: string) => withmateApi.previewComposerInput(activeRunSessionId, message);
  }, [activeRunSessionId, withmateApi]);
  useComposerPreviewResolution({
    hasPreviewPathReferenceCandidates,
    isComposerImeComposing,
    isEditingPathReference,
    isPreviewBlocked: false,
    onComposerPreviewChange: setComposerPreview,
    previewRequest: previewComposerInput,
    previewPathReferenceSignature,
    previewUserMessage,
  });
  useWorkspacePathMatchSearchFlow({
    searchSource: "session",
    sessionId: selectedSessionId,
    withmateApi,
    isSearchBlocked: selectedSessionRunState === "running" || !!composerBlockedReason,
    isComposerImeComposing,
    isEditingPathReference,
    normalizedActivePathQuery,
    onWorkspacePathMatchStateChange: applyWorkspacePathMatchState,
  });
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
    if (!selectedSession || !shouldShowRetryBanner({
      hasActiveAuxiliarySession: !!activeAuxiliarySession,
      hasLastUserMessage: !!lastUserMessage,
      isReadOnly: isSelectedSessionReadOnly,
      runState: selectedSession.runState,
    })) {
      return null;
    }

    const retryLastUserMessage = lastUserMessage;
    if (!retryLastUserMessage) {
      return null;
    }

    const kind = resolveRetryBannerKind({
      runState: selectedSession.runState,
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
          title: resolveSessionMicrocopy("retry.interrupted.title", [
            "retry",
            "interrupted",
            selectedSession.id,
            retryLastUserMessage.text,
          ]),
          stopSummary,
          lastRequestText: retryLastUserMessage.text,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: resolveSessionMicrocopy("retry.failed.title", [
            "retry",
            "failed",
            selectedSession.id,
            retryLastUserMessage.text,
          ]),
          stopSummary,
          lastRequestText: retryLastUserMessage.text,
        };
      case "canceled":
        return {
          kind,
          badge: "キャンセル",
          title: resolveSessionMicrocopy("retry.canceled.title", [
            "retry",
            "canceled",
            selectedSession.id,
            retryLastUserMessage.text,
            latestTerminalAuditLog?.id,
          ]),
          stopSummary,
          lastRequestText: retryLastUserMessage.text,
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
    activeAuxiliarySession,
  ]);
  const shouldProtectDraftOnRetryEdit = shouldProtectRetryEditDraft({ retryBanner, draft });
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
  const isRetryActionDisabled = resolveRetryActionDisabled({
    retryBanner,
    hasLastUserMessage: !!lastUserMessage,
    composerBlocked: !!composerBlockedReason,
    isReadOnly: isSelectedSessionReadOnly,
    runState: selectedSession?.runState,
  });
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const actionDockRuntimeState = buildActionDockRuntimeState({
    isActionDockPinnedExpanded,
    forceReasons: [
      isAgentPickerOpen,
      isSkillPickerOpen,
      workspacePathMatches.length > 0,
      isRetryDraftReplacePending,
      !!retryBanner && !activeAuxiliarySession,
      composerSendability.feedbackTone === "blocked",
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
  const actionDockCompactPreview = useMemo(
    () =>
      buildActionDockCompactPreview(draft, selectedSession?.runState === "running", {
        truncationSuffix: "…",
      }),
    [draft, selectedSession?.runState],
  );
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
    const updatedSession = createOptimisticRunningSessionState(selectedSession, nextMessage, currentTimestampLabel(), {
      status: "running",
    });

    setLiveRunState((current) => createOwnedPendingLiveSessionRunState(updatedSession, current));
    setSessions([updatedSession]);

    try {
      const request: RunSessionTurnRequest = {
        userMessage: messageText,
      };
      const savedSession = await withmateApi.runSessionTurn(selectedSession.id, request);
      setSessions([savedSession]);
    } catch (error) {
      console.error(error);
      setLiveRunState((current) => clearOwnedLiveSessionRunState(current, updatedSession.id));
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

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleWorkspacePathMatchKeyboardNavigation({
      event,
      pathMatches: workspacePathMatches,
      activeIndex: activeWorkspacePathMatchIndex,
      isComposerImeComposing,
      onActiveIndexChange: setActiveWorkspacePathMatchIndex,
      onWorkspacePathMatchStateChange: applyWorkspacePathMatchState,
      onSelectWorkspacePathMatch: handleSelectWorkspacePathMatch,
    })) {
      return;
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
    if (!textarea) {
      return;
    }

    const nextState = buildWorkspacePathMatchSelectionState(
      activeComposerDraft,
      composerCaret,
      match,
    );
    if (!nextState) {
      return;
    }

    const { draft: nextDraft, caret: nextCaret } = nextState;
    setComposerCaret(nextCaret);
    if (activeAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setDraft(nextDraft);
      mainComposerCaretRef.current = nextCaret;
    }
    applyWorkspacePathMatchState(nextState);

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  };

  const handleSelectSkill = (skill: DiscoveredSkill) => {
    const textarea = composerTextareaRef.current;
    if (!selectedSession) {
      return;
    }

    const nextState = buildSkillPromptInsertionState(selectedSession.provider, skill.name, draft);

    setIsActionDockPinnedExpanded(nextState.isActionDockPinnedExpanded);
    setDraft(nextState.draft);
    setComposerCaret(nextState.caret);
    mainComposerCaretRef.current = nextState.caret;
    setIsSkillPickerOpen(nextState.isSkillPickerOpen);

    restoreComposerTextareaFocusAndCaret(textarea, nextState.caret);
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
    let operationRevision = auxiliarySessionMutationRevisionRef.current;
    const result = await runAuxiliarySessionUpdateOperation({
      activeSession: activeAuxiliarySession,
      currentSession: activeAuxiliarySessionRef.current,
      recipe,
      applyPendingSession: (session) => {
        operationRevision = auxiliarySessionMutationRevisionRef.current + 1;
        auxiliarySessionMutationRevisionRef.current = operationRevision;
        activeAuxiliarySessionRef.current = session;
        setActiveAuxiliarySession(session);
      },
      rollbackPendingSession: async ({ pendingSession, previousSession }) => {
        if (
          auxiliarySessionMutationRevisionRef.current !== operationRevision
          || activeAuxiliarySessionRef.current?.id !== pendingSession.id
        ) {
          return;
        }
        const rollbackSession = await resolveAuxiliarySessionRollbackSession({
          pendingSession,
          previousSession,
          getAuxiliarySession: (sessionId) => withmateApi.getAuxiliarySession(sessionId),
        });
        if (
          auxiliarySessionMutationRevisionRef.current !== operationRevision
          || activeAuxiliarySessionRef.current?.id !== pendingSession.id
        ) {
          return;
        }
        activeAuxiliarySessionRef.current = rollbackSession;
        setActiveAuxiliarySession(rollbackSession);
      },
      saveAuxiliarySession: (session) => {
        const saveOperation = enqueueAuxiliarySessionSaveOperation(
          auxiliarySessionSaveQueueRef.current,
          () => withmateApi.updateAuxiliarySession(session),
        );
        auxiliarySessionSaveQueueRef.current = saveOperation.queue;
        return saveOperation.operation;
      },
    });
    if (!result) {
      return;
    }

    if (
      auxiliarySessionMutationRevisionRef.current !== operationRevision
      || activeAuxiliarySessionRef.current?.id !== result.saved.id
    ) {
      return;
    }
    activeAuxiliarySessionRef.current = result.saved;
    setActiveAuxiliarySession(result.saved);
  };

  const handleChangeAuxiliaryApproval = async (approvalMode: Session["approvalMode"]) => {
    await updateActiveAuxiliarySession((current) => (
      applyAuxiliarySessionRuntimeOptionsPatch(current, { approvalMode }, currentTimestampLabel())
    ));
  };

  const handleChangeAuxiliarySandboxMode = async (codexSandboxMode: Session["codexSandboxMode"]) => {
    await updateActiveAuxiliarySession((current) => (
      applyAuxiliarySessionRuntimeOptionsPatch(current, { codexSandboxMode }, currentTimestampLabel())
    ));
  };

  const handleChangeAuxiliaryModel = async (model: string) => {
    if (!selectedProviderCatalog || !modelCatalog) {
      return;
    }

    await updateActiveAuxiliarySession((current) => {
      const selection = resolveModelChangeSelection(selectedProviderCatalog, model, current.reasoningEffort);
      return applyAuxiliarySessionModelSelectionPatch(
        current,
        {
          catalogRevision: modelCatalog.revision,
          model: selection.resolvedModel,
          reasoningEffort: selection.resolvedReasoningEffort,
        },
        currentTimestampLabel(),
      );
    });
  };

  const handleChangeAuxiliaryReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedProviderCatalog || !modelCatalog || !activeAuxiliarySession) {
      return;
    }

    await updateActiveAuxiliarySession((current) => {
      const selection = resolveModelSelection(selectedProviderCatalog, current.model, reasoningEffort);
      return applyAuxiliarySessionModelSelectionPatch(
        current,
        {
          catalogRevision: modelCatalog.revision,
          model: selection.resolvedModel,
          reasoningEffort: selection.resolvedReasoningEffort,
        },
        currentTimestampLabel(),
      );
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

    await updateActiveAuxiliarySession((current) => (
      applyAuxiliarySessionCustomAgentPatch(current, nextCustomAgentName, currentTimestampLabel())
    ));
    setIsAgentPickerOpen(false);
  };

  const handleSelectAuxiliarySkill = async (skill: DiscoveredSkill) => {
    const textarea = composerTextareaRef.current;
    if (!activeAuxiliarySession) {
      return;
    }

    const nextState = buildSkillPromptInsertionState(
      activeAuxiliarySession.provider,
      skill.name,
      activeAuxiliarySession.composerDraft,
    );

    setIsActionDockPinnedExpanded(nextState.isActionDockPinnedExpanded);
    setComposerCaret(nextState.caret);
    setIsSkillPickerOpen(nextState.isSkillPickerOpen);
    await updateActiveAuxiliarySession((current) => (
      applyAuxiliarySessionComposerDraftPatch(current, nextState.draft, currentTimestampLabel())
    ));

    restoreComposerTextareaFocusAndCaret(textarea, nextState.caret);
  };

  const handleResendLastMessage = async () => {
    if (!lastUserMessage || composerBlockedReason || isSelectedSessionReadOnly) {
      return;
    }

    await sendMessage(lastUserMessage.text, { clearDraft: false });
  };

  const restoreLastUserMessageToDraft = (messageText: string) => {
    const textarea = composerTextareaRef.current;
    const nextRestoreState = buildRetryDraftRestoreState(messageText);
    setIsActionDockPinnedExpanded(nextRestoreState.isActionDockPinnedExpanded);
    setDraft(nextRestoreState.draft);
    setComposerCaret(nextRestoreState.caret);
    mainComposerCaretRef.current = nextRestoreState.caret;
    applyWorkspacePathMatchState(nextRestoreState);
    setIsRetryDraftReplacePending(nextRestoreState.isRetryDraftReplacePending);

    restoreComposerTextareaFocusAndCaret(textarea, nextRestoreState.caret);
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
    const nextState = buildActionDockExpandState(options);
    setIsActionDockPinnedExpanded(nextState.isActionDockPinnedExpanded);

    if (!nextState.shouldFocusComposer) {
      return;
    }

    restoreCurrentComposerTextareaFocusToEnd(() => composerTextareaRef.current);
  };

  const handleCollapseActionDock = () => {
    const nextState = buildActionDockCollapseState(canCollapseActionDock);
    if (!nextState) {
      return;
    }

    setIsActionDockPinnedExpanded(nextState.isActionDockPinnedExpanded);
  };

  const handleToggleAgentPicker = () => {
    setIsSkillPickerOpen(buildExclusiveComposerPickerToggleState("agent", false).isSkillPickerOpen);
    setIsAgentPickerOpen((current) => (
      buildExclusiveComposerPickerToggleState("agent", current).isAgentPickerOpen
    ));
  };

  const handleToggleSkillPicker = () => {
    setIsAgentPickerOpen(buildExclusiveComposerPickerToggleState("skill", false).isAgentPickerOpen);
    setIsSkillPickerOpen((current) => (
      buildExclusiveComposerPickerToggleState("skill", current).isSkillPickerOpen
    ));
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

  const handleOpenAuxiliaryLaunchDialog = () => {
    if (!selectedSession || isAuxiliaryActionPending) {
      return;
    }

    openAuxiliaryLaunchDialog({
      providers: auxiliaryLaunchProviderItems,
      selectedProviderId: selectedSession.provider,
    });
  };

  const handleCloseAuxiliaryLaunchDialog = () => {
    if (isAuxiliaryActionPending) {
      return;
    }

    closeAuxiliaryLaunchDialog();
  };

  const handleSelectAuxiliaryLaunchProvider = (providerId: string) => {
    selectAuxiliaryLaunchProvider(providerId);
  };

  const handleStartAuxiliarySession = async () => {
    if (!withmateApi || !selectedSession || isAuxiliaryActionPending) {
      return;
    }
    const startError = resolveAuxiliaryLaunchStartError({
      providerId: auxiliaryLaunchProviderId,
    });
    if (startError) {
      setAuxiliaryLaunchStartError(startError);
      return;
    }
    const launchProviderId = auxiliaryLaunchProviderId;
    if (!launchProviderId) {
      return;
    }

    resetAuxiliaryLaunchFeedback();

    const loadRevision = auxiliaryLoadRevisionRef.current + 1;
    auxiliaryLoadRevisionRef.current = loadRevision;
    const parentSessionId = selectedSession.id;
    const canApplyLoadResult = () => auxiliaryLoadRevisionRef.current === loadRevision;

    setIsAuxiliaryActionPending(true);
    try {
      const launchSelectionSessions = await withmateApi.listSessionSummaries().catch(() => sessions);
      const lastUsedSelection = resolveLastUsedSessionSelection(launchSelectionSessions, launchProviderId);
      const session = await withmateApi.createAuxiliarySession(buildCreateAuxiliarySessionInput({
        parentSessionId,
        provider: launchProviderId,
        defaults: lastUsedSelection,
      }));
      auxiliarySessionMutationRevisionRef.current += 1;
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
  };

  const handleReturnToMainSession = async () => {
    if (!withmateApi || !activeAuxiliarySession || isAuxiliaryActionPending) {
      return;
    }

    setIsAuxiliaryActionPending(true);
    try {
      auxiliaryLoadRevisionRef.current += 1;
      const closedSession = await withmateApi.closeAuxiliarySession(activeAuxiliarySession.id);
      setClosedAuxiliarySessions((current) => resolveClosedAuxiliarySessionsAfterReturn(current, closedSession));
      auxiliarySessionMutationRevisionRef.current += 1;
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

    const draftSave = scheduleAuxiliaryDraftSaveOperation({
      currentSession: activeAuxiliarySession,
      draft: value,
      createTimestampLabel: currentTimestampLabel,
      draftSaveQueue: auxiliaryDraftSaveQueueRef.current,
      getCurrentSession: () => activeAuxiliarySessionRef.current,
      saveAuxiliarySession: (request) => {
        const draftSaveOperation = enqueueAuxiliarySessionSaveOperation(
          auxiliarySessionSaveQueueRef.current,
          () => withmateApi.updateAuxiliarySession(request),
        );
        auxiliarySessionSaveQueueRef.current = draftSaveOperation.queue;
        return draftSaveOperation.operation;
      },
    });
    const { nextSession, saveOperation } = draftSave;
    auxiliarySessionMutationRevisionRef.current += 1;
    activeAuxiliarySessionRef.current = nextSession;
    setActiveAuxiliarySession(nextSession);
    auxiliaryDraftSaveQueueRef.current = draftSave.draftSaveQueue;
    try {
      const result = await saveOperation;
      setActiveAuxiliarySession((current) => {
        const nextSession = resolveAuxiliaryDraftSaveOperationResult(current, result);
        if (result && nextSession === result.saved) {
          activeAuxiliarySessionRef.current = result.saved;
        }
        return nextSession;
      });
    } catch (error) {
      console.error(error);
    }
  };

  const sendAuxiliaryMessage = async (messageText: string) => {
    if (!withmateApi || !activeAuxiliarySession) {
      return;
    }

    const preflight = resolveAuxiliarySessionSendPreflight({
      activeSession: activeAuxiliarySession,
      composerBlockedReason,
      messageText,
    });
    if (preflight.blockedReason) {
      throw new Error(preflight.blockedMessage);
    }
    const nextMessage = preflight.userMessage;
    const sendStartRevision = auxiliarySessionMutationRevisionRef.current;

    await auxiliaryDraftSaveQueueRef.current.catch(() => undefined);
    await auxiliarySessionSaveQueueRef.current.catch(() => undefined);
    if (auxiliarySessionMutationRevisionRef.current !== sendStartRevision) {
      return;
    }
    const sendTarget = resolveAuxiliarySessionSendTarget({
      activeSession: activeAuxiliarySession,
      currentSession: activeAuxiliarySessionRef.current,
    });
    if (!sendTarget.session) {
      if (sendTarget.blockedReason === "running") {
        throw new Error("Auxiliary Session はまだ実行中だよ。");
      }
      return;
    }
    const currentAuxiliarySession = sendTarget.session;

    setIsActionDockPinnedExpanded(false);
    const { anchorUpdateSession, runningSession } = buildAuxiliarySessionRunningTransition({
      session: currentAuxiliarySession,
      userMessage: nextMessage,
      parentMessageCount: selectedSession?.messages.length ?? null,
      updatedAt: currentTimestampLabel(),
    });
    auxiliarySessionMutationRevisionRef.current += 1;
    const runOperationRevision = auxiliarySessionMutationRevisionRef.current;
    activeAuxiliarySessionRef.current = runningSession;
    setActiveAuxiliarySession(runningSession);
    setLiveRunState((current) => createOwnedPendingLiveSessionRunState(
      buildMainAuxiliaryRuntimeSession(selectedSession!, runningSession),
      current,
    ));

    try {
      if (anchorUpdateSession) {
        const anchorSaveOperation = enqueueAuxiliarySessionSaveOperation(
          auxiliarySessionSaveQueueRef.current,
          () => withmateApi.updateAuxiliarySession(anchorUpdateSession),
        );
        auxiliarySessionSaveQueueRef.current = anchorSaveOperation.queue;
        await anchorSaveOperation.operation;
      }
      const saved = await withmateApi.runAuxiliarySessionTurn(currentAuxiliarySession.id, { userMessage: nextMessage });
      if (
        auxiliarySessionMutationRevisionRef.current !== runOperationRevision
        || activeAuxiliarySessionRef.current?.id !== saved.id
      ) {
        return;
      }
      activeAuxiliarySessionRef.current = saved;
      setActiveAuxiliarySession(saved);
    } catch (error) {
      if (
        auxiliarySessionMutationRevisionRef.current !== runOperationRevision
        || activeAuxiliarySessionRef.current?.id !== currentAuxiliarySession.id
      ) {
        return;
      }
      console.error(error);
      setLiveRunState((current) => clearOwnedLiveSessionRunState(current, runningSession.id));
      activeAuxiliarySessionRef.current = currentAuxiliarySession;
      setActiveAuxiliarySession(currentAuxiliarySession);
      throw error;
    }
  };

  const handleCopyMessageText = (text: string) => {
    void copyMessageTextToClipboardWithFailureHandler({
      text,
      writeText: (normalized) => navigator.clipboard.writeText(normalized),
      onFailure: (error) => {
        console.error(error);
        window.alert("コピーに失敗したよ。");
      },
    });
  };

  const insertQuoteIntoMainComposer = (messageText: string) => {
    if (!messageText) {
      return;
    }

    const textarea = activeAuxiliarySession ? null : composerTextareaRef.current;
    const insertion = createQuotedMessageInsertionFromComposer({
      messageText,
      draft,
      fallbackCaret: mainComposerCaretRef.current,
      textarea,
    });
    if (!insertion) {
      return;
    }
    const { draft: nextDraft, caret: nextCaret } = insertion;

    setDraft(nextDraft);
    mainComposerCaretRef.current = nextCaret;
    if (!activeAuxiliarySession) {
      setComposerCaret(nextCaret);
    }
    applyWorkspacePathMatchState(buildClosedWorkspacePathMatchState());

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  };

  const insertQuoteIntoAuxiliaryComposer = (messageText: string) => {
    if (!messageText || !activeAuxiliarySession) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const insertion = createQuotedMessageInsertionFromComposer({
      messageText,
      draft: activeAuxiliarySession.composerDraft,
      fallbackCaret: composerCaret,
      textarea,
    });
    if (!insertion) {
      return;
    }
    const { draft: nextDraft, caret: nextCaret } = insertion;

    void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  };

  const handleQuoteMessageText = (text: string) => {
    if (activeAuxiliarySession) {
      if (activeAuxiliarySession.runState === "running" || isAuxiliaryActionPending || composerBlockedReason) {
        triggerComposerBlockedFeedback();
        return;
      }

      insertQuoteIntoAuxiliaryComposer(text);
      return;
    }

    if (isComposerDisabled) {
      triggerComposerBlockedFeedback();
      return;
    }

    insertQuoteIntoMainComposer(text);
  };

  const insertReferencePaths = (selectedPaths: string[]) => {
    if (selectedPaths.length === 0) {
      return;
    }

    const textarea = composerTextareaRef.current;
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = targetAuxiliarySession ? targetAuxiliarySession.composerDraft : draft;
    const currentCaret = textarea?.selectionStart ?? composerCaret;
    const insertionState = buildSelectedPathReferenceInsertionState({
      draft: currentDraft,
      caret: currentCaret,
      selectedPaths,
      workspacePath: selectedSession?.workspacePath ?? null,
    });
    if (!insertionState) {
      return;
    }
    const { draft: nextDraft, caret: nextCaret } = insertionState;

    if (targetAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setDraft(nextDraft);
      mainComposerCaretRef.current = nextCaret;
    }
    setComposerCaret(nextCaret);
    applyWorkspacePathMatchState(insertionState);

    restoreComposerTextareaFocusAndCaret(textarea, nextCaret);
  };

  const insertReferencePath = (selectedPath: string) => {
    insertReferencePaths([selectedPath]);
  };

  const handleRemoveAttachmentReference = (attachmentPathCandidates: string[]) => {
    const targetAuxiliarySession = activeAuxiliarySession;
    const currentDraft = targetAuxiliarySession ? targetAuxiliarySession.composerDraft : draft;
    const nextState = buildPathReferenceRemovalWithClosedWorkspaceMatchesState(
      currentDraft,
      attachmentPathCandidates,
    );
    const { draft: nextDraft, caret: nextCaret } = nextState;

    if (targetAuxiliarySession) {
      void handleAuxiliaryDraftChange(nextDraft, nextCaret);
    } else {
      setDraft(nextDraft);
      mainComposerCaretRef.current = nextCaret;
    }
    setComposerCaret(nextCaret);
    applyWorkspacePathMatchState(nextState);
  };

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
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(resolvePickedPathBaseDirectory(kind, selectedPath));
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

    const nextDirectories = addAllowedAdditionalDirectory(selectedSession.allowedAdditionalDirectories, selectedPath);
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

    const nextDirectories = removeAllowedAdditionalDirectory(selectedSession.allowedAdditionalDirectories, directoryPath);
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
    await updateActiveAuxiliarySession((current) => (
      addAuxiliarySessionAdditionalDirectory(current, selectedPath, currentTimestampLabel())
    ));
  };

  const handleRemoveAuxiliaryAdditionalDirectory = async (directoryPath: string) => {
    await updateActiveAuxiliarySession((current) => (
      removeAuxiliarySessionAdditionalDirectory(current, directoryPath, currentTimestampLabel())
    ));
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
  const auxiliaryHeaderActions = createAuxiliaryHeaderActions({
    ...resolveAuxiliaryHeaderActionState({
      isActive: !!activeAuxiliarySession,
      isActionPending: isAuxiliaryActionPending,
      isStartBlocked: isSelectedSessionRunning || isSelectedSessionReadOnly,
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

  return (
    <>
      <ChatWindow
      {...buildAgentSessionChatWindowProps({
        selectedSession: renderedSession,
        selectedSessionCharacter,
        displayedMessages: renderedMessages,
        displayedMessageKeys: messageListKeys,
        displayedMessageGroups: messageListGroups,
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
        pendingMessageGroupId: resolvePendingAuxiliaryMessageGroupId(activeAuxiliarySession),
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
        onPickFile: () => void pickAndInsertPath("file"),
        onPickFolder: () => void pickAndInsertPath("folder"),
        onPickImage: () => void pickAndInsertPath("image"),
        onAddToSessionFiles: () => void handleAddToSessionFiles(),
        onPickSessionFiles: () => void handlePickSessionFiles(),
        onToggleAgentPicker: handleToggleAgentPicker,
        onToggleSkillPicker: handleToggleSkillPicker,
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
        onDraftSelect: buildOnDraftSelectHandler({
          setComposerCaret,
          syncMainComposerCaret: !activeAuxiliarySession
            ? (selectionStart) => {
                mainComposerCaretRef.current = selectionStart;
              }
            : undefined,
        }),
        onDraftCompositionStart: buildOnDraftCompositionStartHandler({
          setIsComposerImeComposing,
        }),
        onDraftCompositionEnd: buildOnDraftCompositionEndHandler({
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
        onExpandActionDock: () => handleExpandActionDock({ focusComposer: renderedSession.runState !== "running" }),
        onSelectWorkspacePathMatch: handleSelectWorkspacePathMatch,
        onActivateWorkspacePathMatch: setActiveWorkspacePathMatchIndex,
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
