import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import type { CharacterUpdateMemoryExtract } from "./character-update-state.js";
import type { CompanionSessionSummary } from "./companion-state.js";
import {
  createDefaultAppSettings,
  getProviderAppSettings,
  type AppSettings,
} from "./provider-settings-state.js";
import {
  type DiffPreviewPayload,
  type Message,
  applyCopilotCustomAgentSelection,
  applySessionModelMetadataUpdate,
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
  resolveAutoContextPaneTab,
} from "./session-ui-projection.js";
import {
  SessionAuditLogModal,
  CharacterUpdateContextPane,
  SessionPaneErrorBoundary,
  SessionContextPane,
  SessionDiffModal,
  SessionChatWindow,
  SessionRetryBanner,
} from "./session-components.js";
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
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";
import { buildCompanionGroupMonitorEntries } from "./home-session-projection.js";
import { useSessionAuditLogs } from "./session-audit-log-state.js";
import { extractTextReferenceCandidates } from "./path-reference.js";
import type { WorkspacePathCandidate } from "./workspace-path-candidate.js";
import CompanionReviewApp from "./CompanionReviewApp.js";
import { resolveSessionWindowModeFromSearch } from "./session-window-mode.js";

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

type CharacterOwnedMemoryExtract = {
  ownerCharacterId: string | null;
  extract: CharacterUpdateMemoryExtract | null;
};

const EMPTY_COMPOSER_PREVIEW: ComposerPreview = { attachments: [], errors: [] };
const COMPOSER_PREVIEW_DEBOUNCE_MS = 120;
const COMPOSER_PREVIEW_PATH_EDIT_DEBOUNCE_MS = 280;
const WORKSPACE_PATH_QUERY_MIN_LENGTH = 2;

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
                  .map((operation) => `${operation.type}:${operation.summary}:${operation.details ?? ""}`)
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
    steps: [],
    backgroundTasks: previousState?.backgroundTasks ?? [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

function hashStringToPositiveInt(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash);
}

function renderCharacterSessionCopy(
  templates: string[],
  characterName?: string | null,
  seed = "",
): string {
  const normalizedTemplates = templates
    .map((template) => template.trim())
    .filter((template) => template.length > 0);
  if (normalizedTemplates.length === 0) {
    return "";
  }

  const selectedTemplate = normalizedTemplates[hashStringToPositiveInt(seed || normalizedTemplates.join("\u001f")) % normalizedTemplates.length];
  return selectedTemplate.replaceAll("{name}", characterName?.trim() || "キャラクター");
}

export default function App() {
  const sessionWindowMode = useMemo(() => resolveSessionWindowModeFromSearch(window.location.search), []);
  if (sessionWindowMode.kind === "companion") {
    return <CompanionReviewApp />;
  }

  return <AgentSessionWindowApp />;
}

function AgentSessionWindowApp() {
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
  const [activeCharacterUpdatePaneTab, setActiveCharacterUpdatePaneTab] = useState<"latest-command" | "memory-extract">("latest-command");
  const [characterUpdateMemoryExtractState, setCharacterUpdateMemoryExtractState] = useState<CharacterOwnedMemoryExtract>({
    ownerCharacterId: null,
    extract: null,
  });
  const [isCharacterUpdateMemoryExtractLoading, setIsCharacterUpdateMemoryExtractLoading] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [resolvedCharacter, setResolvedCharacter] = useState<CharacterProfile | null | undefined>(undefined);
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
  const activityMonitorRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activityMonitorSignatureRef = useRef("");
  const activityMonitorSessionIdRef = useRef<string | null>(null);
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
  const selectedCompanionGroupMonitorEntries = useMemo(
    () => buildCompanionGroupMonitorEntries(
      companionSessions,
      openCompanionReviewWindowIds,
    ),
    [companionSessions, openCompanionReviewWindowIds],
  );
  const selectedSessionId = selectedSession?.id ?? null;
  const {
    sessionWorkbenchRef,
    sessionWorkbenchStyle,
    isContextRailResizing,
    handleStartContextRailResize,
  } = useSessionContextRail({ ownerKey: selectedSessionId });
  const selectedSessionLiveRun = useMemo(
    () => (selectedSessionId !== null && liveRunState.ownerSessionId === selectedSessionId ? liveRunState.state : null),
    [liveRunState.ownerSessionId, liveRunState.state, selectedSessionId],
  );
  const {
    auditLogsOpen,
    setAuditLogsOpen,
    auditLogsState,
    auditLogDetails,
    persistedEntries: selectedSessionAuditLogs,
    displayedEntries: displayedSessionAuditLogs,
    handleLoadMoreAuditLogs,
    handleLoadAuditLogDetail,
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
      selectedSessionId !== null && sessionContextTelemetryState.ownerSessionId === selectedSessionId
        ? sessionContextTelemetryState.telemetry
        : null
    ),
    [selectedSessionId, sessionContextTelemetryState.ownerSessionId, sessionContextTelemetryState.telemetry],
  );
  const activePathReference = useMemo(
    () => (selectedSessionId ? getActivePathReference(draft, composerCaret) : null),
    [composerCaret, draft, selectedSessionId],
  );
  const isEditingPathReference = activePathReference !== null;
  const normalizedActivePathQuery = activePathReference?.query.trim() ?? "";
  const previewDraft = useMemo(
    () => removeActivePathReference(draft, activePathReference),
    [activePathReference, draft],
  );
  const previewUserMessage = useMemo(
    () => (isEditingPathReference ? previewDraft : draft),
    [draft, isEditingPathReference, previewDraft],
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
  const selectedSessionRunState: Session["runState"] | null = selectedSessionLiveRun
    ? "running"
    : selectedSession?.runState ?? null;

  const selectedSessionCharacter = useMemo(
    () =>
      selectedSession
        ? {
            id: resolvedCharacter?.id ?? selectedSession.characterId,
            name: resolvedCharacter?.name ?? selectedSession.character,
            iconPath: resolvedCharacter?.iconPath ?? selectedSession.characterIconPath,
            description: resolvedCharacter?.description ?? "",
            roleMarkdown: resolvedCharacter?.roleMarkdown ?? "",
            notesMarkdown: resolvedCharacter?.notesMarkdown ?? "",
            updatedAt: resolvedCharacter?.updatedAt ?? selectedSession.updatedAt,
            themeColors: resolvedCharacter?.themeColors ?? selectedSession.characterThemeColors,
            sessionCopy: resolvedCharacter?.sessionCopy ?? DEFAULT_CHARACTER_SESSION_COPY,
          }
        : null,
    [resolvedCharacter, selectedSession],
  );
  const isCharacterUpdateSession = selectedSession?.sessionKind === "character-update";
  const sessionThemeStyle = useMemo(
    () => (selectedSession ? buildCharacterThemeStyle(selectedSession.characterThemeColors) : undefined),
    [selectedSession],
  );
  const selectedDiffThemeStyle = useMemo(
    () => (selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : {}),
    [selectedDiff],
  );
  const isSelectedCharacterMissing = useMemo(
    () => !!selectedSession && !!selectedSession.characterId && resolvedCharacter === null,
    [resolvedCharacter, selectedSession],
  );
  const isCharacterResolutionPending = useMemo(
    () => !!selectedSession && !!selectedSession.characterId && resolvedCharacter === undefined,
    [resolvedCharacter, selectedSession],
  );
  const selectedSessionCopy = useMemo(
    () => resolvedCharacter?.sessionCopy ?? DEFAULT_CHARACTER_SESSION_COPY,
    [resolvedCharacter],
  );
  const selectedCharacterUpdateMemoryExtract = useMemo(
    () => (
      selectedSession?.characterId
      && characterUpdateMemoryExtractState.ownerCharacterId === selectedSession.characterId
        ? characterUpdateMemoryExtractState.extract
        : null
    ),
    [characterUpdateMemoryExtractState.extract, characterUpdateMemoryExtractState.ownerCharacterId, selectedSession?.characterId],
  );
  const isSelectedProviderEnabled = useMemo(
    () => !!selectedSession && getProviderAppSettings(appSettings, selectedSession.provider).enabled,
    [appSettings, selectedSession],
  );
  const sessionExecutionBlockedReason = useMemo(() => {
    if (!selectedSession) {
      return "";
    }

    if (isCharacterResolutionPending) {
      return "この session の character 状態を確認しているよ。少し待ってね。";
    }

    if (isSelectedCharacterMissing) {
      return "この session は元の character が見つからないため、過去ログの閲覧のみできるよ。";
    }

    if (!isSelectedProviderEnabled) {
      return "この provider は Settings の Coding Agent Providers で無効になっているよ。Home の Settings で有効化してね。";
    }

    return "";
  }, [isCharacterResolutionPending, isSelectedCharacterMissing, isSelectedProviderEnabled, selectedSession]);
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
    let active = true;

    if (!withmateApi || !selectedSession?.characterId || !isCharacterUpdateSession) {
      setCharacterUpdateMemoryExtractState({ ownerCharacterId: null, extract: null });
      setIsCharacterUpdateMemoryExtractLoading(false);
      return () => {
        active = false;
      };
    }

    setIsCharacterUpdateMemoryExtractLoading(true);
    void withmateApi.extractCharacterUpdateMemory(selectedSession.characterId).then((extract) => {
      if (!active) {
        return;
      }
      setCharacterUpdateMemoryExtractState({
        ownerCharacterId: selectedSession.characterId,
        extract,
      });
      setIsCharacterUpdateMemoryExtractLoading(false);
    }).catch(() => {
      if (!active) {
        return;
      }
      setCharacterUpdateMemoryExtractState({
        ownerCharacterId: selectedSession.characterId,
        extract: null,
      });
      setIsCharacterUpdateMemoryExtractLoading(false);
    });

    return () => {
      active = false;
    };
  }, [isCharacterUpdateSession, selectedSession?.characterId, withmateApi]);

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
    if (isCharacterUpdateSession && selectedSession?.runState === "running") {
      setActiveCharacterUpdatePaneTab("latest-command");
    }
  }, [isCharacterUpdateSession, selectedSession?.runState]);

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

  useEffect(() => {
    let active = true;
    if (!withmateApi || !selectedSession?.characterId) {
      setResolvedCharacter(selectedSession ? null : undefined);
      return () => {
        active = false;
      };
    }

    setResolvedCharacter(undefined);
    const refreshCharacterResolution = () => {
      void withmateApi.getCharacter(selectedSession.characterId).then((character) => {
        if (active) {
          setResolvedCharacter(character);
        }
      });
    };

    refreshCharacterResolution();
    const unsubscribe = withmateApi.subscribeCharacters(() => {
      refreshCharacterResolution();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.characterId, selectedSession?.id]);

  const displayedMessages: Message[] = selectedSession ? selectedSession.messages : [];
  const displayedMessagesScrollSignature = useMemo(
    () => buildDisplayedMessagesScrollSignature(displayedMessages),
    [displayedMessages],
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
        selectedSession?.id ?? "",
        selectedSession?.runState ?? "",
        displayedMessagesScrollSignature,
        pendingBubbleScrollSignature,
      ].join("\u001a"),
    [displayedMessagesScrollSignature, pendingBubbleScrollSignature, selectedSession?.id, selectedSession?.runState],
  );
  const {
    messageListRef,
    isMessageListFollowing,
    handleMessageListScroll,
    handleJumpToMessageListBottom,
  } = useSessionMessageListFollowing({
    ownerKey: selectedSessionId,
    scrollSignature: messageListScrollSignature,
  });

  useEffect(() => {
    setDraft("");
    setComposerPreview(EMPTY_COMPOSER_PREVIEW);
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setComposerCaret(0);
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

    if (!withmateApi || !selectedSession) {
      setLiveRunState({ ownerSessionId: null, state: null });
      return () => {
        active = false;
      };
    }

    setLiveRunState({ ownerSessionId: selectedSession.id, state: null });
    void withmateApi.getLiveSessionRun(selectedSession.id).then((state) => {
      if (active) {
        setLiveRunState({ ownerSessionId: selectedSession.id, state });
      }
    });

    const unsubscribe = withmateApi.subscribeLiveSessionRun((sessionId, state) => {
      if (!active || sessionId !== selectedSession.id) {
        return;
      }

      setLiveRunState({ ownerSessionId: sessionId, state });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSessionId]);

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
    const sessionId = selectedSession?.id ?? null;

    if (!withmateApi || !sessionId || selectedSession?.provider !== "copilot") {
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
  }, [selectedSession?.id, selectedSession?.provider]);

  useEffect(() => {
    let active = true;
    if (!withmateApi || !selectedSessionId) {
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
      void withmateApi.previewComposerInput(selectedSessionId, previewUserMessage).then((preview) => {
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
    selectedSessionId,
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
    () => (modelCatalog && selectedSession ? getProviderCatalog(modelCatalog.providers, selectedSession.provider) : null),
    [modelCatalog, selectedSession],
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
      selectedProviderCatalog && selectedSession
        ? getReasoningEffortOptionsForModel(selectedProviderCatalog, selectedSession.model)
        : [],
    [selectedProviderCatalog, selectedSession],
  );
  const modelOptions = useMemo(() => {
    if (!selectedProviderCatalog) {
      return [];
    }

    const options = [...selectedProviderCatalog.models];
    if (!selectedSession) {
      return options;
    }

    const hasSelectedModel = options.some((model) => model.id === selectedSession.model);
    if (!hasSelectedModel) {
      options.unshift({
        id: selectedSession.model,
        label: selectedSession.model,
        reasoningEfforts: availableReasoningEfforts.length > 0 ? [...availableReasoningEfforts] : [selectedSession.reasoningEffort],
      });
    }

    return options;
  }, [availableReasoningEfforts, selectedProviderCatalog, selectedSession]);
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
  const availableContextPaneTabs = useMemo(
    () => resolveAvailableContextPaneTabs({
      isCopilotSession,
      hasCompanionGroupMonitor: selectedCompanionGroupMonitorEntries.length > 0,
    }),
    [isCopilotSession, selectedCompanionGroupMonitorEntries.length],
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
  const pendingIndicatorCharacterName = useMemo(() => {
    const candidateNames = [selectedSessionCharacter?.name, resolvedCharacter?.name]
      .map((name) => name?.trim() ?? "")
      .filter(Boolean);

    return candidateNames[0] ?? "";
  }, [resolvedCharacter?.name, selectedSessionCharacter?.name]);
  const selectedContextEmptyText = useMemo(
    () =>
      renderCharacterSessionCopy(
        selectedSessionCopy.contextEmpty,
        pendingIndicatorCharacterName,
        `context-empty:${selectedSession?.id ?? ""}:${selectedSession?.updatedAt ?? ""}`,
      ),
    [
      pendingIndicatorCharacterName,
      selectedSession?.id,
      selectedSession?.updatedAt,
      selectedSessionCopy.contextEmpty,
    ],
  );
  const retryBanner = useMemo<RetryBannerState | null>(() => {
    if (!selectedSession || selectedSession.runState === "running" || !lastUserMessage) {
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
          title: renderCharacterSessionCopy(
            selectedSessionCopy.retryInterruptedTitle,
            pendingIndicatorCharacterName,
            `retry:interrupted:${selectedSession.id}:${lastUserMessage.text}`,
          ),
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: renderCharacterSessionCopy(
            selectedSessionCopy.retryFailedTitle,
            pendingIndicatorCharacterName,
            `retry:failed:${selectedSession.id}:${lastUserMessage.text}`,
          ),
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      case "canceled":
        return {
          kind,
          badge: "キャンセル",
          title: renderCharacterSessionCopy(
            selectedSessionCopy.retryCanceledTitle,
            pendingIndicatorCharacterName,
            `retry:canceled:${selectedSession.id}:${lastUserMessage.text}:${latestTerminalAuditLog?.id ?? ""}`,
          ),
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
    pendingIndicatorCharacterName,
    selectedSession,
    selectedSessionCopy.retryCanceledTitle,
    selectedSessionCopy.retryFailedTitle,
    selectedSessionCopy.retryInterruptedTitle,
    selectedSessionLiveRun,
  ]);
  const hasDraftText = draft.trim().length > 0;
  const shouldProtectDraftOnRetryEdit = !!retryBanner && hasDraftText && draft !== retryBanner.lastRequestText;
  const isComposerDisabled = selectedSession?.runState === "running" || !!composerBlockedReason;
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
    !retryBanner || !lastUserMessage || !!composerBlockedReason || selectedSession?.runState === "running";
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const shouldForceActionDockExpanded =
    isAgentPickerOpen
    || isSkillPickerOpen
    || workspacePathMatches.length > 0
    || isRetryDraftReplacePending
    || !!retryBanner
    || composerSendability.feedbackTone === "blocked";
  const selectedCustomAgent = useMemo(() => {
    if (!selectedSession?.customAgentName.trim()) {
      return null;
    }

    const normalizedSelectedAgentName = selectedSession.customAgentName.trim().toLowerCase();
    return availableCustomAgents.find((agent) => agent.name.trim().toLowerCase() === normalizedSelectedAgentName) ?? null;
  }, [availableCustomAgents, selectedSession?.customAgentName]);
  const selectedCustomAgentDisplay = useMemo(
    () => buildSelectedCustomAgentDisplay(selectedSession, selectedCustomAgent),
    [selectedCustomAgent, selectedSession],
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
    () => {
      const options = getSandboxOptionsForProvider(selectedSession?.provider);
      if (!selectedSession || options.some((option) => option.value === selectedSession.codexSandboxMode)) {
        return options;
      }

      return [{ value: selectedSession.codexSandboxMode, label: selectedSession.codexSandboxMode }, ...options];
    },
    [selectedSession?.codexSandboxMode, selectedSession?.provider],
  );
  const modelSelectOptions = useMemo(
    () => modelOptions.map((model) => ({ value: model.id, label: modelOptionLabel(model) })),
    [modelOptions],
  );
  const selectedModelFallbackLabel = useMemo(
    () => modelDisplayLabel(selectedProviderCatalog, selectedSession?.model ?? ""),
    [selectedProviderCatalog, selectedSession?.model],
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
          isSelected: !selectedSession?.customAgentName,
        },
      ];

      return items.concat(
        availableCustomAgents.map((agent) => {
          const agentDisplay = buildCustomAgentMatchDisplay(agent);
          const isSelected = selectedSession?.customAgentName.trim().toLowerCase() === agent.name.trim().toLowerCase();
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
    [availableCustomAgents, selectedSession?.customAgentName],
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
      selectedSession
        ? selectedSession.allowedAdditionalDirectories.map((directoryPath) => {
            const directoryDisplay = buildAdditionalDirectoryDisplay(directoryPath);
            return {
              key: directoryPath,
              path: directoryPath,
              primaryLabel: directoryDisplay.primaryLabel,
              secondaryLabel: directoryDisplay.secondaryLabel,
              title: directoryDisplay.title,
              canRemove: selectedSession.provider === "codex",
            };
          })
        : [],
    [selectedSession],
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
    if (!withmateApi || !selectedSession || approvalActionRequestId === request.requestId) {
      return;
    }

    setApprovalActionRequestId(request.requestId);
    try {
      await withmateApi.resolveLiveApproval(selectedSession.id, request.requestId, decision);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "承認要求の処理に失敗したよ。");
      setApprovalActionRequestId(null);
    }
  };

  const handleResolveLiveElicitation = async (
    request: LiveElicitationRequest,
    response: LiveElicitationResponse,
  ) => {
    if (!withmateApi || !selectedSession || elicitationActionRequestId === request.requestId) {
      return;
    }

    setElicitationActionRequestId(request.requestId);
    try {
      await withmateApi.resolveLiveElicitation(selectedSession.id, request.requestId, response);
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
      composerSendability.isRunning
    ) {
      return;
    }

    event.preventDefault();
    if (isSendDisabled) {
      triggerComposerBlockedFeedback();
      return;
    }
    void handleSend();
  };

  const handleSelectWorkspacePathMatch = (match: string) => {
    const textarea = composerTextareaRef.current;
    const activeReference = getActivePathReference(draft, composerCaret);
    if (!textarea || !activeReference) {
      return;
    }

    const replacement = formatPathReference(match);
    const nextDraft = `${draft.slice(0, activeReference.start)}${replacement}${draft.slice(activeReference.end)}`;
    const nextCaret = activeReference.start + replacement.length;
    setDraft(nextDraft);
    setComposerCaret(nextCaret);
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
    if (!selectedSession || selectedSession.provider !== "copilot") {
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
    if (!withmateApi) {
      throw new Error("Session Window は Electron から開いてね。");
    }

    const savedSession = await withmateApi.updateSession(nextSession);
    setSessions([savedSession]);
    return savedSession;
  };

  const handleChangeApproval = async (approvalMode: Session["approvalMode"]) => {
    if (!selectedSession || selectedSession.runState === "running" || approvalMode === selectedSession.approvalMode) {
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
    if (!selectedSession || selectedSession.runState === "running") {
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
    if (!selectedSession) {
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
    if (!selectedSession || !selectedProviderCatalog || !modelCatalog) {
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
    if (!selectedSession || !selectedProviderCatalog || !modelCatalog) {
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

  const handleResendLastMessage = async () => {
    if (!lastUserMessage || composerBlockedReason) {
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

  const insertReferencePath = (selectedPath: string) => {
    const textarea = composerTextareaRef.current;
    const referencePath = selectedSession
      ? toWorkspaceRelativeReference(selectedSession.workspacePath, selectedPath) ?? normalizePathForReference(selectedPath)
      : normalizePathForReference(selectedPath);
    const referenceToken = formatPathReference(referencePath);
    const currentCaret = textarea?.selectionStart ?? composerCaret;
    const leadingSpacer = currentCaret > 0 && !/\s/.test(draft[currentCaret - 1] ?? "") ? " " : "";
    const trailingSpacer = draft.length > currentCaret && !/\s/.test(draft[currentCaret] ?? "") ? " " : "";
    const insertion = `${leadingSpacer}${referenceToken}${trailingSpacer}`;
    const nextDraft = `${draft.slice(0, currentCaret)}${insertion}${draft.slice(currentCaret)}`;
    const nextCaret = currentCaret + insertion.length;

    setDraft(nextDraft);
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

  const handleRemoveAttachmentReference = (attachmentPathCandidates: string[]) => {
    const escapedCandidates = attachmentPathCandidates
      .map((candidate) => formatPathReference(candidate))
      .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    let nextDraft = draft;
    for (const escapedCandidate of escapedCandidates) {
      nextDraft = nextDraft.replace(
        new RegExp(`(^|[\\s(])${escapedCandidate}(?=\\s|$|[),.;:!?])`),
        (_match, leadingWhitespace: string) => leadingWhitespace || "",
      );
    }

    nextDraft = nextDraft
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");

    setDraft(nextDraft);
    setComposerCaret(nextDraft.length);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
  };

  const handlePickFile = async () => {
    if (!withmateApi) {
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
    if (!withmateApi) {
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
    if (!withmateApi) {
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

  const handleAddAdditionalDirectory = async () => {
    if (!withmateApi || !selectedSession || selectedSession.runState === "running") {
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
    if (!selectedSession || selectedSession.provider !== "codex" || selectedSession.runState === "running") {
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

  const handleJumpToActivityMonitorBottom = () => {
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    scrollActivityMonitorToBottom();
  };

  const pendingRunIndicatorText = isApprovalRequestPending || isElicitationRequestPending
    ? renderCharacterSessionCopy(
      selectedSessionCopy.pendingApproval,
      pendingIndicatorCharacterName,
      [
        `pending:approval:${selectedSession?.id ?? ""}:${liveApprovalRequest?.requestId ?? ""}`,
        `pending:elicitation:${selectedSession?.id ?? ""}:${liveElicitationRequest?.requestId ?? ""}`,
      ].join("|"),
    )
    : hasInProgressLiveRunStep
      ? renderCharacterSessionCopy(
        selectedSessionCopy.pendingWorking,
        pendingIndicatorCharacterName,
        `pending:working:${selectedSession?.id ?? ""}:${selectedSessionLiveRun?.threadId ?? ""}:${orderedLiveRunSteps.map((step) => `${step.id}:${step.status}`).join("|")}`,
      )
      : hasLiveRunAssistantText
        ? renderCharacterSessionCopy(
          selectedSessionCopy.pendingResponding,
          pendingIndicatorCharacterName,
          `pending:responding:${selectedSession?.id ?? ""}:${selectedSessionLiveRun?.threadId ?? ""}:${liveRunAssistantText.length}`,
        )
        : renderCharacterSessionCopy(
          selectedSessionCopy.pendingPreparing,
          pendingIndicatorCharacterName,
          `pending:preparing:${selectedSession?.id ?? ""}:${selectedSessionLiveRun?.threadId ?? ""}`,
        );
  const pendingRunIndicatorAnnouncement = pendingRunIndicatorText;
  const isSelectedSessionRunning = selectedSessionRunState === "running";
  const contextPaneProjection = useMemo(
    () => buildContextPaneProjection({
      activeContextPaneTab,
      latestCommandView,
      backgroundTasks: selectedBackgroundTasks,
      companionGroupMonitorEntries: selectedCompanionGroupMonitorEntries,
    }),
    [activeContextPaneTab, latestCommandView, selectedBackgroundTasks, selectedCompanionGroupMonitorEntries],
  );

  useEffect(() => {
    const nextTab = resolveAutoContextPaneTab({
      isSelectedSessionRunning,
      isCopilotSession,
      backgroundTasks: selectedBackgroundTasks,
      hasCompanionGroupMonitor: selectedCompanionGroupMonitorEntries.length > 0,
    });
    if (nextTab) {
      setActiveContextPaneTab(nextTab);
    }
  }, [isSelectedSessionRunning, isCopilotSession, selectedBackgroundTasks, selectedCompanionGroupMonitorEntries.length]);

  useEffect(() => {
    if (!availableContextPaneTabs.includes(activeContextPaneTab)) {
      setActiveContextPaneTab(availableContextPaneTabs[0] ?? "latest-command");
    }
  }, [activeContextPaneTab, availableContextPaneTabs]);

  const handleCycleContextPaneTab = (direction: -1 | 1) => {
    setActiveContextPaneTab((current) => cycleContextPaneTab(current, direction, availableContextPaneTabs));
  };

  const handleRefreshCharacterUpdateMemoryExtract = async () => {
    if (!withmateApi || !selectedSession?.characterId || !isCharacterUpdateSession || isCharacterUpdateMemoryExtractLoading) {
      return;
    }

    setIsCharacterUpdateMemoryExtractLoading(true);
    try {
      const extract = await withmateApi.extractCharacterUpdateMemory(selectedSession.characterId);
      setCharacterUpdateMemoryExtractState({
        ownerCharacterId: selectedSession.characterId,
        extract,
      });
    } finally {
      setIsCharacterUpdateMemoryExtractLoading(false);
    }
  };
  const handleCopyCharacterUpdateMemoryExtract = async () => {
    if (!selectedCharacterUpdateMemoryExtract?.text) {
      return;
    }

    await navigator.clipboard.writeText(selectedCharacterUpdateMemoryExtract.text);
  };

  if (!desktopRuntime) {
    return (
      <div className="page-shell session-page">
        <section className="panel empty-session-card rise-2">
          <p>Session Window は Electron から開いてね。</p>
        </section>
      </div>
    );
  }

  if (!selectedSession || !selectedSessionCharacter) {
    return (
      <div className="page-shell session-page">
        <section className="panel session-window-bar rise-1">
          <span className="session-window-title">No Session Selected</span>
        </section>
        <section className="panel empty-session-card rise-2">
          <h2>Home Window から session を開いてね</h2>
          <p>`/session.html?sessionId=...` で対象 session を受け取る形になってるよ。</p>
        </section>
      </div>
    );
  }

  return (
    <SessionChatWindow
      mode="agent"
      className={isSessionHeaderExpanded ? "" : "session-page-header-collapsed"}
      style={sessionThemeStyle}
      workbenchRef={sessionWorkbenchRef}
      workbenchStyle={sessionWorkbenchStyle}
      isHeaderExpanded={isSessionHeaderExpanded}
      headerProps={{
        taskTitle: selectedSession.taskTitle,
        isEditingTitle,
        titleDraft,
        isRunning: isSelectedSessionRunning,
        showTerminalButton: !isCharacterUpdateSession,
        onToggleExpanded: handleToggleHeaderExpanded,
        onOpenAuditLog: () => setAuditLogsOpen(true),
        onOpenTerminal: () => void handleOpenSessionTerminal(),
        onTitleDraftChange: setTitleDraft,
        onTitleInputKeyDown: handleTitleInputKeyDown,
        onSaveTitle: () => void handleSaveTitle(),
        onCancelTitleEdit: handleCancelTitleEdit,
        onStartTitleEdit: handleStartTitleEdit,
        onDeleteSession: () => void handleDeleteSession(),
        workspaceActions: !isCharacterUpdateSession ? (
          <button
            className="drawer-toggle compact secondary"
            type="button"
            onClick={() => void handleOpenSessionExplorer()}
          >
            Explorer
          </button>
        ) : null,
      }}
      messageColumnProps={{
        sessionId: selectedSession.id,
        character: selectedSessionCharacter,
        messages: displayedMessages,
        expandedArtifacts,
        messageListRef,
        isRunning: isSelectedSessionRunning,
        pendingRunIndicatorAnnouncement,
        pendingRunIndicatorText,
        liveApprovalRequest,
        approvalActionRequestId,
        liveElicitationRequest,
        elicitationActionRequestId,
        liveRunAssistantText,
        hasLiveRunAssistantText,
        liveRunErrorMessage: selectedSessionLiveRun?.errorMessage ?? "",
        isMessageListFollowing,
        onMessageListScroll: handleMessageListScroll,
        onToggleArtifact: toggleArtifact,
        onLoadArtifactDetail: (messageIndex) =>
          withmateApi?.getSessionMessageArtifact(selectedSession.id, messageIndex) ?? Promise.resolve(null),
        onOpenDiff: (title, file) =>
          setSelectedDiff({
            title,
            file,
            themeColors: selectedSession.characterThemeColors,
          }),
        onResolveLiveApproval: (request, decision) => void handleResolveLiveApproval(request, decision),
        onResolveLiveElicitation: (request, response) => void handleResolveLiveElicitation(request, response),
        onOpenPath: handleOpenInlinePath,
        getChangedFilesEmptyText: (artifactKey, artifactHasSnapshotRisk) =>
          artifactHasSnapshotRisk
            ? "差分は見つからなかったけど、snapshot の上限や省略で取りこぼしがあるかもしれないよ。"
            : renderCharacterSessionCopy(
              selectedSessionCopy.changedFilesEmpty,
              pendingIndicatorCharacterName,
              `changed-files-empty:${artifactKey}`,
            ),
      }}
      isActionDockExpanded={isActionDockExpanded}
      composerProps={{
        retryBanner: (
          <SessionRetryBanner
            retryBanner={retryBanner}
            isRetryDetailsOpen={isRetryDetailsOpen}
            isRetryActionDisabled={isRetryActionDisabled}
            isRetryEditDisabled={isRetryEditDisabled}
            isRetryDraftReplacePending={isRetryDraftReplacePending}
            onToggleDetails={() => setIsRetryDetailsOpen((current) => !current)}
            onResendLastMessage={() => void handleResendLastMessage()}
            onEditLastMessage={handleEditLastMessage}
            onConfirmRetryDraftReplace={handleConfirmRetryDraftReplace}
            onCancelRetryDraftReplace={handleCancelRetryDraftReplace}
            onOpenPath={handleOpenInlinePath}
          />
        ),
        isRunning: selectedSession.runState === "running",
        composerBlocked: !!composerBlockedReason,
        canSelectCustomAgent: !isCharacterUpdateSession && selectedSession.provider === "copilot",
        showCustomAgentPicker: !isCharacterUpdateSession,
        showSkillPicker: !isCharacterUpdateSession,
        isAgentPickerOpen,
        isSkillPickerOpen,
        isAdditionalDirectoryListOpen,
        selectedCustomAgentLabel: selectedSession.provider === "copilot" ? selectedCustomAgentDisplay.label : "Agent",
        selectedCustomAgentTitle: selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択",
        additionalDirectoryCount: selectedSession.allowedAdditionalDirectories.length,
        canCollapseActionDock,
        showJumpToBottom: !isMessageListFollowing,
        isCustomAgentListLoading,
        isSkillListLoading,
        customAgentItems,
        skillItems,
        attachmentItems: composerAttachmentItems,
        additionalDirectoryItems,
        workspacePathMatchItems,
        draft,
        composerTextareaRef,
        isComposerDisabled,
        isSendDisabled,
        composerSendability,
        sendButtonTitle: composerSendButtonTitle,
        isComposerBlockedFeedbackActive: forceComposerBlockedFeedback && composerSendability.shouldShowFeedback,
        approvalOptions: approvalChoiceOptions,
        selectedApprovalMode: selectedSession.approvalMode,
        sandboxOptions: sandboxChoiceOptions,
        selectedCodexSandboxMode: selectedSession.codexSandboxMode,
        modelOptions: modelSelectOptions,
        selectedModel: selectedSession.model,
        selectedModelFallbackLabel,
        reasoningOptions: reasoningSelectOptions,
        selectedReasoningEffort: selectedSession.reasoningEffort,
        onPickFile: () => void handlePickFile(),
        onPickFolder: () => void handlePickFolder(),
        onPickImage: () => void handlePickImage(),
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
          setDraft(value);
          setComposerCaret(selectionStart);
        },
        onDraftFocus: () => setIsActionDockPinnedExpanded(true),
        onDraftKeyDown: handleComposerKeyDown,
        onDraftSelect: setComposerCaret,
        onDraftCompositionStart: () => setIsComposerImeComposing(true),
        onDraftCompositionEnd: () => {
          setIsComposerImeComposing(false);
          setComposerCaret(composerTextareaRef.current?.selectionStart ?? draft.length);
        },
        onSendOrCancel: () => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend()),
        onSelectWorkspacePathMatch: handleSelectWorkspacePathMatch,
        onActivateWorkspacePathMatch: setActiveWorkspacePathMatchIndex,
        onChangeApprovalMode: (value) => void handleChangeApproval(value),
        onChangeCodexSandboxMode: (value) => void handleChangeCodexSandboxMode(value),
        onChangeModel: (value) => void handleChangeModel(value),
        onChangeReasoningEffort: (value) => void handleChangeReasoningEffort(value as Session["reasoningEffort"]),
      }}
      compactActionDockProps={{
        draft,
        actionDockCompactPreview,
        attachmentCount: composerPreview.attachments.length,
        isRunning: selectedSession.runState === "running",
        isSendDisabled,
        showJumpToBottom: !isMessageListFollowing,
        sendButtonTitle: composerSendButtonTitle,
        onExpand: () => handleExpandActionDock({ focusComposer: true }),
        onJumpToBottom: handleJumpToMessageListBottom,
        onSendOrCancel: () => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend()),
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
          {isCharacterUpdateSession ? (
            <CharacterUpdateContextPane
              taskTitle={selectedSession.taskTitle}
              isHeaderExpanded={isSessionHeaderExpanded}
              activePaneTab={activeCharacterUpdatePaneTab}
              latestCommandView={latestCommandView}
              runningDetailsEntries={runningDetailsEntries}
              selectedSessionLiveRunErrorMessage={selectedSessionLiveRun?.errorMessage ?? ""}
              memoryExtract={selectedCharacterUpdateMemoryExtract}
              isLoadingMemoryExtract={isCharacterUpdateMemoryExtractLoading}
              onToggleHeaderExpanded={handleToggleHeaderExpanded}
              onSelectPaneTab={setActiveCharacterUpdatePaneTab}
              onRefreshMemoryExtract={() => void handleRefreshCharacterUpdateMemoryExtract()}
              onCopyMemoryExtract={() => void handleCopyCharacterUpdateMemoryExtract()}
            />
          ) : (
            <SessionContextPane
              taskTitle={selectedSession.taskTitle}
              isHeaderExpanded={isSessionHeaderExpanded}
              activeContextPaneTab={activeContextPaneTab}
              availableContextPaneTabs={availableContextPaneTabs}
              contextPaneProjection={contextPaneProjection}
              latestCommandView={latestCommandView}
              runningDetailsEntries={runningDetailsEntries}
              backgroundTasks={selectedBackgroundTasks}
              companionGroupMonitorEntries={selectedCompanionGroupMonitorEntries}
              selectedSessionLiveRunErrorMessage={selectedSessionLiveRun?.errorMessage ?? ""}
              isSelectedSessionRunning={isSelectedSessionRunning}
              isCopilotSession={isCopilotSession}
              selectedCopilotRemainingPercentLabel={selectedCopilotRemainingPercentLabel}
              selectedCopilotRemainingRequestsLabel={selectedCopilotRemainingRequestsLabel}
              selectedCopilotQuotaResetLabel={selectedCopilotQuotaResetLabel}
              selectedSessionContextTelemetry={selectedSessionContextTelemetry}
              selectedSessionContextTelemetryProjection={selectedSessionContextTelemetryProjection}
              contextEmptyText={selectedContextEmptyText}
              onToggleHeaderExpanded={handleToggleHeaderExpanded}
              onCycleContextPaneTab={handleCycleContextPaneTab}
              onOpenCompanionReview={(sessionId) => void withmateApi?.openCompanionReviewWindow(sessionId)}
            />
          )}
        </SessionPaneErrorBoundary>
      )}
      modals={(
        <>
          <SessionDiffModal
            selectedDiff={selectedDiff}
            themeStyle={selectedDiffThemeStyle}
            onClose={() => setSelectedDiff(null)}
            onOpenDiffWindow={(payload) => void handleOpenDiffWindow(payload)}
          />

          <SessionAuditLogModal
            open={auditLogsOpen}
            entries={displayedSessionAuditLogs}
            details={auditLogDetails}
            hasMore={auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.hasMore : false}
            loadingMore={auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.loading : false}
            total={auditLogsState.ownerSessionId === selectedSessionId
              ? Math.max(auditLogsState.total, displayedSessionAuditLogs.length)
              : displayedSessionAuditLogs.length}
            errorMessage={auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.errorMessage : null}
            onLoadMore={handleLoadMoreAuditLogs}
            onLoadDetail={handleLoadAuditLogDetail}
            onClose={() => setAuditLogsOpen(false)}
          />
        </>
      )}
    />
  );
}

