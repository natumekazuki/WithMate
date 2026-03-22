import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import {
  type AuditLogEntry,
  createDefaultAppSettings,
  type ComposerAttachment,
  type ComposerPreview,
  currentTimestampLabel,
  DEFAULT_CHARACTER_THEME_COLORS,
  type DiscoveredSkill,
  getProviderAppSettings,
  getSessionIdFromLocation,
  type ChangedFile,
  type CharacterProfile,
  type DiffPreviewPayload,
  type LiveSessionRunState,
  type Message,
  type RunSessionTurnRequest,
  type Session,
  type AppSettings,
} from "./app-state.js";
import { DiffViewer, DiffViewerSubbar } from "./DiffViewer.js";
import {
  getProviderCatalog,
  getReasoningEffortOptionsForModel,
  resolveModelSelection,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import {
  approvalModeOptions,
  approvalModeLabel,
  CharacterAvatar,
  fileKindLabel,
  liveRunStepDetailsLabel,
  liveRunStepStatusLabel,
  modelDisplayLabel,
  modelOptionLabel,
  operationTypeLabel,
  reasoningDepthLabel,
} from "./ui-utils.js";
import { MessageRichText } from "./MessageRichText.js";

type ActivePathReference = {
  query: string;
  start: number;
  end: number;
};

type RetryBannerKind = "interrupted" | "failed" | "canceled";

type RetryBannerState = {
  kind: RetryBannerKind;
  badge: string;
  title: string;
  stopSummary: string;
  lastRequestText: string;
};

type SessionOwnedAuditLogs = {
  ownerSessionId: string | null;
  entries: AuditLogEntry[];
};

type SessionOwnedLiveRun = {
  ownerSessionId: string | null;
  state: LiveSessionRunState | null;
};

type ComposerSendabilityState = {
  isRunning: boolean;
  isBlankDraft: boolean;
  blockedReason: string;
  inputErrors: string[];
  primaryFeedback: string;
  secondaryFeedback: string[];
  feedbackTone: "blocked" | "helper" | null;
  shouldShowFeedback: boolean;
  isSendDisabled: boolean;
};

type ComposerAttachmentDisplay = {
  kindLabel: string;
  locationLabel: string;
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

type WorkspacePathMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

type SkillMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

function defaultRetryBannerDetailsOpen(kind: RetryBannerKind): boolean {
  return kind !== "canceled";
}

function getActivePathReference(value: string, caret: number): ActivePathReference | null {
  const prefix = value.slice(0, caret);
  const match = /(^|[\s(])@(?:"([^"\r\n]*)|([^\s@"\r\n]*))$/.exec(prefix);
  if (!match) {
    return null;
  }

  const query = (match[2] ?? match[3] ?? "").replace(/\\/g, "/");
  const start = (match.index ?? 0) + match[1].length;

  return {
    query,
    start,
    end: caret,
  };
}

function buildSkillPromptSnippet(providerId: string, skillName: string): string {
  return providerId === "codex"
    ? `$${skillName}`
    : `Use the skill "${skillName}" for this task.`;
}

function formatPathReference(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function normalizePathForReference(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function splitPathForDisplay(filePath: string): { basename: string; parentPath: string } {
  const normalized = normalizePathForReference(filePath).replace(/\/+$/, "");
  if (!normalized) {
    return { basename: "", parentPath: "" };
  }

  const lastSlashIndex = normalized.lastIndexOf("/");
  if (lastSlashIndex < 0) {
    return {
      basename: normalized,
      parentPath: "",
    };
  }

  return {
    basename: normalized.slice(lastSlashIndex + 1),
    parentPath: normalized.slice(0, lastSlashIndex),
  };
}

function compactPathForDisplay(filePath: string, maxLength = 40): string {
  if (filePath.length <= maxLength) {
    return filePath;
  }

  const headLength = Math.max(10, Math.floor((maxLength - 1) * 0.4));
  const tailLength = Math.max(14, maxLength - headLength - 1);
  return `${filePath.slice(0, headLength)}…${filePath.slice(-tailLength)}`;
}

function attachmentKindLabel(kind: ComposerAttachment["kind"]): string {
  switch (kind) {
    case "folder":
      return "フォルダ";
    case "image":
      return "画像";
    case "file":
    default:
      return "ファイル";
  }
}

function buildComposerAttachmentDisplay(attachment: ComposerAttachment): ComposerAttachmentDisplay {
  const preferredPath = attachment.workspaceRelativePath ?? attachment.displayPath ?? normalizePathForReference(attachment.absolutePath);
  const title = attachment.isOutsideWorkspace
    ? normalizePathForReference(attachment.absolutePath)
    : preferredPath;
  const { basename, parentPath } = splitPathForDisplay(title);
  const secondaryPath = attachment.isOutsideWorkspace
    ? parentPath
      ? compactPathForDisplay(parentPath, 48)
      : compactPathForDisplay(title, 48)
    : parentPath
      ? compactPathForDisplay(parentPath, 42)
      : "ワークスペース直下";

  return {
    kindLabel: attachmentKindLabel(attachment.kind),
    locationLabel: attachment.isOutsideWorkspace ? "ワークスペース外" : "ワークスペース内",
    primaryLabel: basename || title,
    secondaryLabel: secondaryPath,
    title,
  };
}

function buildWorkspacePathMatchDisplay(pathMatch: string): WorkspacePathMatchDisplay {
  const normalizedPath = normalizePathForReference(pathMatch);
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 42) : "ワークスペース直下",
    title: normalizedPath,
  };
}

function buildSkillMatchDisplay(skill: DiscoveredSkill): SkillMatchDisplay {
  return {
    primaryLabel: skill.name,
    secondaryLabel: `${skill.sourceLabel}${skill.description ? ` · ${skill.description}` : ""}`,
    title: `${skill.name}\n${skill.sourcePath}`,
  };
}

function buildComposerSendabilityState({
  runState,
  blockedReason,
  inputErrors,
  draftText,
}: {
  runState: string | null | undefined;
  blockedReason: string;
  inputErrors: string[];
  draftText: string;
}): ComposerSendabilityState {
  const normalizedBlockedReason = blockedReason.trim();
  const normalizedInputErrors = inputErrors.map((error) => error.trim()).filter(Boolean);
  const isRunning = runState === "running";
  const isBlankDraft = draftText.trim().length === 0;

  if (isRunning) {
    return {
      isRunning,
      isBlankDraft,
      blockedReason: normalizedBlockedReason,
      inputErrors: normalizedInputErrors,
      primaryFeedback: "",
      secondaryFeedback: [],
      feedbackTone: null,
      shouldShowFeedback: false,
      isSendDisabled: true,
    };
  }

  const primaryFeedback =
    normalizedBlockedReason
    || normalizedInputErrors[0];
  const secondaryFeedback = normalizedBlockedReason ? normalizedInputErrors : normalizedInputErrors.slice(1);
  const feedbackTone = primaryFeedback
    ? normalizedBlockedReason || normalizedInputErrors.length > 0
      ? "blocked"
      : null
    : null;

  return {
    isRunning,
    isBlankDraft,
    blockedReason: normalizedBlockedReason,
    inputErrors: normalizedInputErrors,
    primaryFeedback,
    secondaryFeedback,
    feedbackTone,
    shouldShowFeedback: !!primaryFeedback || secondaryFeedback.length > 0,
    isSendDisabled: !!normalizedBlockedReason || normalizedInputErrors.length > 0 || isBlankDraft,
  };
}

function toWorkspaceRelativeReference(workspacePath: string, selectedPath: string): string | null {
  const normalizedWorkspacePath = normalizePathForReference(workspacePath).replace(/\/+$/, "");
  const normalizedSelectedPath = normalizePathForReference(selectedPath);
  const workspacePrefix = `${normalizedWorkspacePath}/`;
  if (!normalizedSelectedPath.toLocaleLowerCase().startsWith(workspacePrefix.toLocaleLowerCase())) {
    return null;
  }

  return normalizedSelectedPath.slice(workspacePrefix.length);
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

function liveRunStepToneClassName(status: string): string {
  switch (status) {
    case "in_progress":
    case "completed":
    case "failed":
    case "canceled":
    case "pending":
      return status;
    default:
      return "unknown";
  }
}

type ParsedFileChangeSummaryLine = {
  actionLabel: string;
  toneClassName: "add" | "edit" | "delete" | "rename";
  path: string;
};

type LatestCommandView = {
  status: string;
  summary: string;
  details?: string;
  sourceLabel: string;
  riskLabels: string[];
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

function buildCommandRiskLabels(command: string): string[] {
  const normalizedCommand = command.toLowerCase();
  const labels: string[] = [];

  if (
    /\b(rm|del|rmdir|rd|truncate)\b/.test(normalizedCommand)
    || /\b(remove-item|remove-itemproperty)\b/.test(normalizedCommand)
  ) {
    labels.push("DELETE");
  }

  if (
    /\b(mv|move|cp|copy|mkdir|md|touch|tee)\b/.test(normalizedCommand)
    || /\b(new-item|set-content|add-content|out-file|rename-item|move-item|copy-item)\b/.test(normalizedCommand)
    || /\b(git apply|git checkout|git restore|git clean)\b/.test(normalizedCommand)
  ) {
    labels.push("WRITE");
  }

  if (
    /\b(curl|wget)\b/.test(normalizedCommand)
    || /\b(invoke-webrequest|invoke-restmethod|iwr|irm)\b/.test(normalizedCommand)
    || /\b(npm|pnpm|yarn|pip|uv|cargo|go)\s+(install|add|get)\b/.test(normalizedCommand)
  ) {
    labels.push("NETWORK");
  }

  return labels;
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

function isTerminalAuditLogPhase(phase: AuditLogEntry["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled";
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

function displayRunCheckValue(check: { label: string; value: string }): string {
  return check.label.trim().toLowerCase() === "approval" ? displayApprovalValue(check.value) : check.value;
}

function buildRetryStopSummary(
  kind: RetryBannerKind,
  liveRun: LiveSessionRunState | null,
  latestTerminalAuditLog: AuditLogEntry | null,
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
    liveRun.usage
      ? [liveRun.usage.inputTokens, liveRun.usage.cachedInputTokens, liveRun.usage.outputTokens].join(":")
      : "",
    liveRun.steps
      .map((step) => [step.id, step.type, step.status, step.summary, step.details ?? ""].join("\u001d"))
      .join("\u001c"),
  ].join("\u001b");
}

const SESSION_CONTEXT_RAIL_DEFAULT_WIDTH = 420;
const SESSION_CONTEXT_RAIL_MIN_WIDTH = 360;
const SESSION_CONTEXT_RAIL_MAX_WIDTH = 620;
const SESSION_CONVERSATION_MIN_WIDTH = 760;
const SESSION_LAYOUT_BREAKPOINT = 1400;

function clampContextRailWidth(requestedWidth: number, workbenchWidth: number): number {
  const maxWidth = Math.min(
    SESSION_CONTEXT_RAIL_MAX_WIDTH,
    Math.max(SESSION_CONTEXT_RAIL_MIN_WIDTH, workbenchWidth - SESSION_CONVERSATION_MIN_WIDTH),
  );

  return Math.min(maxWidth, Math.max(SESSION_CONTEXT_RAIL_MIN_WIDTH, requestedWidth));
}

export default function App() {
  const isDesktopRuntime = typeof window !== "undefined" && !!window.withmate;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("");
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogsState, setAuditLogsState] = useState<SessionOwnedAuditLogs>({ ownerSessionId: null, entries: [] });
  const [liveRunState, setLiveRunState] = useState<SessionOwnedLiveRun>({ ownerSessionId: null, state: null });
  const [appSettings, setAppSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [resolvedCharacter, setResolvedCharacter] = useState<CharacterProfile | null | undefined>(undefined);
  const [composerPreview, setComposerPreview] = useState<ComposerPreview>({ attachments: [], errors: [] });
  const [pickerBaseDirectory, setPickerBaseDirectory] = useState("");
  const [composerCaret, setComposerCaret] = useState(0);
  const [workspacePathMatches, setWorkspacePathMatches] = useState<string[]>([]);
  const [activeWorkspacePathMatchIndex, setActiveWorkspacePathMatchIndex] = useState(-1);
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isSkillListLoading, setIsSkillListLoading] = useState(false);
  const [isComposerImeComposing, setIsComposerImeComposing] = useState(false);
  const [isMessageListFollowing, setIsMessageListFollowing] = useState(true);
  const [hasMessageListUnread, setHasMessageListUnread] = useState(false);
  const [isActivityMonitorFollowing, setIsActivityMonitorFollowing] = useState(true);
  const [hasActivityMonitorUnread, setHasActivityMonitorUnread] = useState(false);
  const [contextRailWidth, setContextRailWidth] = useState(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);
  const [isContextRailResizing, setIsContextRailResizing] = useState(false);
  const [isRetryDetailsOpen, setIsRetryDetailsOpen] = useState(false);
  const [isRetryDraftReplacePending, setIsRetryDraftReplacePending] = useState(false);
  const [isHeaderExpanded, setIsHeaderExpanded] = useState(false);
  const [isActionDockPinnedExpanded, setIsActionDockPinnedExpanded] = useState(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const activityMonitorRef = useRef<HTMLDivElement | null>(null);
  const sessionWorkbenchRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageListSignatureRef = useRef("");
  const messageListSessionIdRef = useRef<string | null>(null);
  const activityMonitorSignatureRef = useRef("");
  const activityMonitorSessionIdRef = useRef<string | null>(null);
  const contextRailWidthRef = useRef(SESSION_CONTEXT_RAIL_DEFAULT_WIDTH);

  const selectedId = useMemo(() => getSessionIdFromLocation(), []);

  useEffect(() => {
    let active = true;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    if (selectedId) {
      void window.withmate.getSession(selectedId).then((session) => {
        if (active && session) {
          setSessions([session]);
        }
      });
    } else {
      void window.withmate.listSessions().then((nextSessions) => {
        if (active) {
          setSessions(nextSessions);
        }
      });
    }

    const unsubscribe = window.withmate.subscribeSessions((nextSessions) => {
      if (!active) {
        return;
      }

      if (selectedId) {
        const matched = nextSessions.find((session) => session.id === selectedId);
        setSessions(matched ? [matched] : []);
        return;
      }

      setSessions(nextSessions);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedId]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [selectedId, sessions],
  );
  const selectedSessionId = selectedSession?.id ?? null;
  const selectedSessionAuditLogs = useMemo(
    () => (selectedSessionId !== null && auditLogsState.ownerSessionId === selectedSessionId ? auditLogsState.entries : []),
    [auditLogsState.entries, auditLogsState.ownerSessionId, selectedSessionId],
  );
  const selectedSessionLiveRun = useMemo(
    () => (selectedSessionId !== null && liveRunState.ownerSessionId === selectedSessionId ? liveRunState.state : null),
    [liveRunState.ownerSessionId, liveRunState.state, selectedSessionId],
  );
  const activePathReference = useMemo(
    () => (selectedSession ? getActivePathReference(draft, composerCaret) : null),
    [composerCaret, draft, selectedSession],
  );

  const selectedSessionCharacter = useMemo(
    () =>
      selectedSession
        ? { name: selectedSession.character, iconPath: selectedSession.characterIconPath }
        : null,
    [selectedSession],
  );
  const sessionThemeStyle = useMemo(
    () => (selectedSession ? buildCharacterThemeStyle(selectedSession.characterThemeColors) : undefined),
    [selectedSession],
  );
  const selectedDiffThemeStyle = useMemo(
    () => (selectedDiff ? buildCharacterThemeStyle(selectedDiff.themeColors) : undefined),
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

    if (!window.withmate || !selectedSession) {
      setAvailableSkills([]);
      setIsSkillListLoading(false);
      return () => {
        active = false;
      };
    }

    setIsSkillListLoading(true);
    void window.withmate.listSessionSkills(selectedSession.id).then((skills) => {
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
    setIsSkillPickerOpen(false);
  }, [selectedSessionId]);

  useEffect(() => {
    if (selectedSession?.runState === "running") {
      setIsSkillPickerOpen(false);
    }
  }, [selectedSession?.runState]);

  useEffect(() => {
    contextRailWidthRef.current = contextRailWidth;
  }, [contextRailWidth]);

  useLayoutEffect(() => {
    const syncContextRailWidth = () => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }

      const nextWidth = clampContextRailWidth(
        contextRailWidthRef.current,
        workbenchElement.getBoundingClientRect().width,
      );
      contextRailWidthRef.current = nextWidth;
      setContextRailWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    syncContextRailWidth();
    window.addEventListener("resize", syncContextRailWidth);
    return () => window.removeEventListener("resize", syncContextRailWidth);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!isContextRailResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const workbenchElement = sessionWorkbenchRef.current;
      if (!workbenchElement) {
        return;
      }

      const bounds = workbenchElement.getBoundingClientRect();
      if (bounds.width < SESSION_LAYOUT_BREAKPOINT) {
        return;
      }

      const requestedWidth = bounds.right - event.clientX;
      const nextWidth = clampContextRailWidth(requestedWidth, bounds.width);
      contextRailWidthRef.current = nextWidth;
      setContextRailWidth(nextWidth);
    };

    const handlePointerEnd = () => {
      setIsContextRailResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isContextRailResizing]);

  useEffect(() => {
    let active = true;

    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    void window.withmate.getModelCatalog(null).then((snapshot) => {
      if (active) {
        setModelCatalog(snapshot);
      }
    });

    const unsubscribe = window.withmate.subscribeModelCatalog((snapshot) => {
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
    if (!window.withmate) {
      return () => {
        active = false;
      };
    }

    void window.withmate.getAppSettings().then((settings) => {
      if (active) {
        setAppSettings(settings);
      }
    });

    const unsubscribe = window.withmate.subscribeAppSettings((settings) => {
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
    const withmateApi = window.withmate;
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
      ].join("\u001b"),
    [selectedSession?.runState, selectedSessionLiveRun?.assistantText, selectedSessionLiveRun?.errorMessage],
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

  useEffect(() => {
    setDraft("");
    setComposerPreview({ attachments: [], errors: [] });
    setPickerBaseDirectory(selectedSession?.workspacePath ?? "");
    setComposerCaret(0);
    setWorkspacePathMatches([]);
    setActiveWorkspacePathMatchIndex(-1);
    setIsComposerImeComposing(false);
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    setAuditLogsState({ ownerSessionId: selectedSessionId, entries: [] });
    setLiveRunState({ ownerSessionId: selectedSessionId, state: null });
    setIsRetryDraftReplacePending(false);
    setIsHeaderExpanded(false);
    setIsActionDockPinnedExpanded(false);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!draft.trim()) {
      setIsRetryDraftReplacePending(false);
    }
  }, [draft]);

  useLayoutEffect(() => {
    const messageListElement = messageListRef.current;
    const currentSignature = messageListScrollSignature;
    const wasSameSession = messageListSessionIdRef.current === selectedSessionId;
    const hasSignatureChanged = messageListSignatureRef.current !== currentSignature;

    if (!messageListElement) {
      messageListSessionIdRef.current = selectedSessionId;
      messageListSignatureRef.current = currentSignature;
      return;
    }

    if (!wasSameSession) {
      messageListSessionIdRef.current = selectedSessionId;
      messageListSignatureRef.current = currentSignature;
      setIsMessageListFollowing(true);
      setHasMessageListUnread(false);
      messageListElement.scrollTop = messageListElement.scrollHeight;
      return;
    }

    if (!hasSignatureChanged) {
      return;
    }

    messageListSignatureRef.current = currentSignature;

    if (isMessageListFollowing) {
      messageListElement.scrollTop = messageListElement.scrollHeight;
      return;
    }

    setHasMessageListUnread(true);
  }, [isMessageListFollowing, messageListScrollSignature, selectedSessionId]);

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

    if (!window.withmate || !selectedSession) {
      if (active) {
        setAuditLogsState({ ownerSessionId: null, entries: [] });
      }
      return () => {
        active = false;
      };
    }

    setAuditLogsState((current) =>
      current.ownerSessionId === selectedSession.id
        ? current
        : { ownerSessionId: selectedSession.id, entries: [] },
    );
    void window.withmate.listSessionAuditLogs(selectedSession.id).then((nextAuditLogs) => {
      if (active) {
        setAuditLogsState({ ownerSessionId: selectedSession.id, entries: nextAuditLogs });
      }
    });

    return () => {
      active = false;
    };
  }, [displayedMessages.length, selectedSession?.runState, selectedSession?.updatedAt, selectedSessionId]);

  useEffect(() => {
    let active = true;

    if (!window.withmate || !selectedSession) {
      setLiveRunState({ ownerSessionId: null, state: null });
      return () => {
        active = false;
      };
    }

    setLiveRunState({ ownerSessionId: selectedSession.id, state: null });
    void window.withmate.getLiveSessionRun(selectedSession.id).then((state) => {
      if (active) {
        setLiveRunState({ ownerSessionId: selectedSession.id, state });
      }
    });

    const unsubscribe = window.withmate.subscribeLiveSessionRun((sessionId, state) => {
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
    const withmateApi = window.withmate;
    if (!withmateApi || !selectedSession) {
      setComposerPreview({ attachments: [], errors: [] });
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      void withmateApi.previewComposerInput(selectedSession.id, draft).then((preview) => {
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
    }, 120);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [draft, selectedSession]);
  useEffect(() => {
    let active = true;
    const withmateApi = window.withmate;

    if (
      !withmateApi
      || !selectedSession
      || selectedSession.runState === "running"
      || !!composerBlockedReason
      || !activePathReference
      || !activePathReference.query.trim()
    ) {
      setWorkspacePathMatches([]);
      return () => {
        active = false;
      };
    }

    const timeoutId = window.setTimeout(() => {
      void withmateApi.searchWorkspaceFiles(selectedSession.id, activePathReference.query).then((matches) => {
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
  }, [activePathReference, composerBlockedReason, selectedSession]);
  const selectedProviderCatalog = useMemo(
    () => (modelCatalog && selectedSession ? getProviderCatalog(modelCatalog.providers, selectedSession.provider) : null),
    [modelCatalog, selectedSession],
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
  const latestCommandView = useMemo<LatestCommandView | null>(() => {
    if (latestLiveCommandStep) {
      return {
        status: latestLiveCommandStep.status,
        summary: latestLiveCommandStep.summary,
        details: latestLiveCommandStep.details,
        sourceLabel: "live",
        riskLabels: buildCommandRiskLabels(latestLiveCommandStep.summary),
      };
    }

    if (latestAuditCommandOperation) {
      return {
        status: latestTerminalAuditLog?.phase === "failed"
          ? "failed"
          : latestTerminalAuditLog?.phase === "canceled"
            ? "canceled"
            : "completed",
        summary: latestAuditCommandOperation.summary,
        details: latestAuditCommandOperation.details,
        sourceLabel: "latest run",
        riskLabels: buildCommandRiskLabels(latestAuditCommandOperation.summary),
      };
    }

    return null;
  }, [latestAuditCommandOperation, latestLiveCommandStep, latestTerminalAuditLog?.phase]);
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
          title: "前回の依頼は中断されたままです",
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      case "failed":
        return {
          kind,
          badge: "失敗",
          title: "前回の依頼はエラーで完了できませんでした",
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      case "canceled":
        return {
          kind,
          badge: "キャンセル",
          title: "この依頼はあなたが途中で停止しました",
          stopSummary,
          lastRequestText: lastUserMessage.text,
        };
      default:
        return null;
    }
  }, [lastAssistantMessage, lastUserMessage, latestTerminalAuditLog, selectedSession, selectedSessionLiveRun]);
  const hasDraftText = draft.trim().length > 0;
  const shouldProtectDraftOnRetryEdit = !!retryBanner && hasDraftText && draft !== retryBanner.lastRequestText;
  const isComposerDisabled = selectedSession?.runState === "running" || !!composerBlockedReason;
  const composerSendability = useMemo(
    () =>
      buildComposerSendabilityState({
        runState: selectedSession?.runState,
        blockedReason: composerBlockedReason,
        inputErrors: composerPreview.errors,
        draftText: draft,
      }),
    [composerBlockedReason, composerPreview.errors, draft, selectedSession?.runState],
  );
  const isSendDisabled = composerSendability.isSendDisabled;
  const isRetryActionDisabled =
    !retryBanner || !lastUserMessage || !!composerBlockedReason || selectedSession?.runState === "running";
  const isRetryEditDisabled = isRetryActionDisabled || isComposerDisabled;
  const shouldForceActionDockExpanded =
    isSkillPickerOpen
    || workspacePathMatches.length > 0
    || isRetryDraftReplacePending
    || !!retryBanner
    || composerSendability.feedbackTone === "blocked";
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

  const sendMessage = async (messageText: string, options?: { clearDraft?: boolean }) => {
    if (!window.withmate || !selectedSession) {
      return;
    }

    if (composerBlockedReason) {
      throw new Error(composerBlockedReason);
    }

    const nextMessage = messageText.trim();
    const preview = await window.withmate.previewComposerInput(selectedSession.id, messageText);
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

    setSessions([updatedSession]);

    try {
      const request: RunSessionTurnRequest = {
        userMessage: messageText,
      };
      const savedSession = await window.withmate.runSessionTurn(selectedSession.id, request);
      setSessions([savedSession]);
    } catch (error) {
      console.error(error);
      setSessions([selectedSession]);
    }
  };

  const handleSend = async () => {
    if (isSendDisabled) {
      return;
    }

    try {
      await sendMessage(draft, { clearDraft: true });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "送信に失敗したよ。");
    }
  };

  const handleCancelRun = async () => {
    if (!window.withmate || !selectedSession || selectedSession.runState !== "running") {
      return;
    }

    try {
      await window.withmate.cancelSessionRun(selectedSession.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "キャンセルに失敗したよ。");
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

      if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || (event.key === "Tab" && !event.shiftKey)) {
        const activeMatch =
          workspacePathMatches[activeWorkspacePathMatchIndex] ?? workspacePathMatches[0] ?? null;
        if (activeMatch) {
          event.preventDefault();
          handleSelectWorkspacePathMatch(activeMatch);
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

  const persistSession = async (nextSession: Session) => {
    if (!window.withmate) {
      throw new Error("Session Window は Electron から開いてね。");
    }

    const savedSession = await window.withmate.updateSession(nextSession);
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
    if (!window.withmate || !selectedSession || selectedSession.runState === "running") {
      return;
    }

    const confirmed = window.confirm(`セッション「${selectedSession.taskTitle}」を削除する？`);
    if (!confirmed) {
      return;
    }

    await window.withmate.deleteSession(selectedSession.id);
    handleCloseWindow();
  };

  const handleOpenDiffWindow = async (diffPreview: DiffPreviewPayload) => {
    if (!window.withmate) {
      return;
    }

    await window.withmate.openDiffWindow(diffPreview);
  };

  const handleChangeModel = async (model: string) => {
    if (!selectedSession || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, model, selectedSession.reasoningEffort);
    const nextSession: Session = {
      ...selectedSession,
      catalogRevision: modelCatalog.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      threadId: "",
      updatedAt: currentTimestampLabel(),
    };

    await persistSession(nextSession);
  };

  const handleChangeReasoningEffort = async (reasoningEffort: Session["reasoningEffort"]) => {
    if (!selectedSession || !selectedProviderCatalog || !modelCatalog) {
      return;
    }

    const selection = resolveModelSelection(selectedProviderCatalog, selectedSession.model, reasoningEffort);
    const nextSession: Session = {
      ...selectedSession,
      catalogRevision: modelCatalog.revision,
      model: selection.resolvedModel,
      reasoningEffort: selection.resolvedReasoningEffort,
      threadId: "",
      updatedAt: currentTimestampLabel(),
    };

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
    if (!window.withmate) {
      return;
    }

    try {
      await window.withmate.openPath(target, { baseDirectory: selectedSession?.workspacePath ?? null });
    } catch {
      // 読みやすさ改善が主目的なので、開けない場合は UI を壊さない
    }
  };

  const toDirectoryPath = (selectedPath: string) => {
    const normalized = selectedPath.replace(/[\\/]+$/, "");
    const lastSlashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (lastSlashIndex < 0) {
      return normalized;
    }

    return normalized.slice(0, lastSlashIndex);
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
    if (!window.withmate) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await window.withmate.pickFile(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath);
  };

  const handlePickFolder = async () => {
    if (!window.withmate) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await window.withmate.pickDirectory(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(selectedPath);
    insertReferencePath(selectedPath);
  };

  const handlePickImage = async () => {
    if (!window.withmate) {
      return;
    }

    setIsSkillPickerOpen(false);
    const selectedPath = await window.withmate.pickImageFile(pickerBaseDirectory || selectedSession?.workspacePath || null);
    if (!selectedPath) {
      return;
    }

    setPickerBaseDirectory(toDirectoryPath(selectedPath));
    insertReferencePath(selectedPath);
  };

  const auditPhaseLabel = (phase: AuditLogEntry["phase"]) => {
    switch (phase) {
      case "running":
      case "started":
        return "RUNNING";
      case "completed":
        return "DONE";
      case "canceled":
        return "CANCELED";
      case "failed":
        return "FAIL";
      default:
        return phase;
    }
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

  const scrollMessageListToBottom = () => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    messageListElement.scrollTop = messageListElement.scrollHeight;
  };

  const handleMessageListScroll = () => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }

    const bottomGap = Math.max(0, messageListElement.scrollHeight - messageListElement.clientHeight - messageListElement.scrollTop);
    const nextFollowing = bottomGap <= 80;

    setIsMessageListFollowing((current) => (current === nextFollowing ? current : nextFollowing));
    if (nextFollowing) {
      setHasMessageListUnread(false);
    }
  };

  const handleJumpToMessageListBottom = () => {
    setIsMessageListFollowing(true);
    setHasMessageListUnread(false);
    scrollMessageListToBottom();
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

  const handleJumpToActivityMonitorBottom = () => {
    setIsActivityMonitorFollowing(true);
    setHasActivityMonitorUnread(false);
    scrollActivityMonitorToBottom();
  };

  const handleStartContextRailResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    setIsContextRailResizing(true);
  };

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

  const hasInProgressLiveRunStep = useMemo(
    () => orderedLiveRunSteps.some((step) => step.status === "in_progress"),
    [orderedLiveRunSteps],
  );

  const liveRunAssistantText = selectedSessionLiveRun?.assistantText ?? "";
  const hasLiveRunAssistantText = liveRunAssistantText.length > 0;
  const pendingIndicatorCharacterName = useMemo(() => {
    const candidateNames = [selectedSessionCharacter?.name, resolvedCharacter?.name]
      .map((name) => name?.trim() ?? "")
      .filter(Boolean);

    return candidateNames[0] ?? "";
  }, [resolvedCharacter?.name, selectedSessionCharacter?.name]);
  const pendingRunIndicatorText = hasInProgressLiveRunStep
    ? pendingIndicatorCharacterName
      ? `${pendingIndicatorCharacterName}が作業を進めています`
      : "作業を進めています"
    : hasLiveRunAssistantText
      ? pendingIndicatorCharacterName
        ? `${pendingIndicatorCharacterName}が返答を続けています`
        : "返答を続けています"
      : pendingIndicatorCharacterName
        ? `${pendingIndicatorCharacterName}が返答を準備しています`
        : "返答を準備しています";
  const pendingRunIndicatorAnnouncement = pendingRunIndicatorText;
  const isSelectedSessionRunning = selectedSession?.runState === "running";
  const latestCommandToneClassName = latestCommandView ? liveRunStepToneClassName(latestCommandView.status) : "unknown";
  const latestCommandStatusLabel = latestCommandView ? liveRunStepStatusLabel(latestCommandView.status) : "待機";
  const latestCommandSourceCopy = latestCommandView?.sourceLabel === "live" ? "RUN LIVE" : "LAST RUN";
  const sessionWorkbenchStyle = useMemo(
    () =>
      ({
        ["--session-context-rail-width" as string]: `${contextRailWidth}px`,
      }) as CSSProperties,
    [contextRailWidth],
  );

  if (!isDesktopRuntime) {
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
    <div className="page-shell session-page" style={sessionThemeStyle}>
      <header className={`session-window-bar session-top-bar rise-1${isSessionHeaderExpanded ? " is-expanded" : ""}`}>
        <div className="session-top-bar-row">
          <div className="session-title-shell">
            <span className="session-window-title session-title-accent">{selectedSession.taskTitle}</span>
          </div>
          <div className="session-window-controls">
            <button className="drawer-toggle compact secondary" type="button" onClick={() => setAuditLogsOpen(true)}>
              Audit Log
            </button>
            {!isEditingTitle ? (
              <button
                className="drawer-toggle compact secondary"
                type="button"
                onClick={handleToggleHeaderExpanded}
                aria-expanded={isSessionHeaderExpanded}
              >
                {isSessionHeaderExpanded ? "Hide" : "More"}
              </button>
            ) : null}
            <button className="drawer-toggle compact" type="button" onClick={handleCloseWindow}>
              Close
            </button>
          </div>
        </div>

        {isSessionHeaderExpanded ? (
          <div className="session-top-bar-drawer">
            {isEditingTitle ? (
              <label className="session-title-editor">
                <input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={handleTitleInputKeyDown} />
                <div className="session-title-actions">
                  <button className="drawer-toggle compact" type="button" onClick={() => void handleSaveTitle()}>
                    Save
                  </button>
                  <button className="drawer-toggle compact secondary" type="button" onClick={handleCancelTitleEdit}>
                    Cancel
                  </button>
                </div>
              </label>
            ) : (
              <div className="session-top-bar-manage">
                <button className="drawer-toggle compact secondary" type="button" onClick={handleStartTitleEdit} disabled={selectedSession.runState === "running"}>
                  Rename
                </button>
                <button className="drawer-toggle compact danger" type="button" onClick={() => void handleDeleteSession()} disabled={selectedSession.runState === "running"}>
                  Delete
                </button>
              </div>
            )}
          </div>
        ) : null}
      </header>

      <section className="content-grid session-content-grid">
        <section className="chat-panel session-work-surface rise-3">
          <div className="session-workbench" ref={sessionWorkbenchRef} style={sessionWorkbenchStyle}>
            <div className="session-main-grid">
              <div className="session-message-column">
                <div className="message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
            {displayedMessages.length > 0 ? (
              displayedMessages.map((message, index) => {
                const artifactKey = `${selectedSession.id}-${index}`;
                const artifactExpanded = expandedArtifacts[artifactKey] ?? false;
                const isAssistant = message.role === "assistant";
                const artifactHasSnapshotRisk =
                  message.artifact?.runChecks.some((check) => check.label.startsWith("snapshot ")) ?? false;
                const artifactOperations =
                  message.artifact?.operationTimeline ??
                  message.artifact?.activitySummary.map((item) => ({
                    type: "summary",
                    summary: item,
                    details: undefined,
                  })) ??
                  [];

                return (
                  <article
                    key={`${message.role}-${index}`}
                    className={`message-row ${message.role}${message.accent ? " accent" : ""}`}
                  >
                    {isAssistant ? <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" /> : null}
                    <div className={`message-card ${message.role}${message.accent ? " accent" : ""}`}>
                      <MessageRichText text={message.text} onOpenPath={handleOpenInlinePath} />

                      {message.artifact ? (
                        <section className="artifact-shell">
                          <div className="artifact-toolbar">
                            <button className="artifact-toggle" type="button" onClick={() => toggleArtifact(artifactKey)}>
                              {artifactExpanded ? "Hide" : "Details"}
                            </button>
                          </div>

                          {artifactExpanded ? (
                            <div className="artifact-block">
                              <div className="artifact-grid">
                                <section className="artifact-section">
                                  <div className="artifact-file-list">
                                    {message.artifact.changedFiles.length > 0 ? (
                                      message.artifact.changedFiles.map((file) => (
                                        <article key={`${file.kind}-${file.path}`} className="artifact-file-item">
                                          <div className="artifact-file-meta">
                                            <span className={`file-kind ${file.kind}`}>{fileKindLabel(file.kind)}</span>
                                            <code>{file.path}</code>
                                          </div>
                                          <p>{file.summary}</p>
                                          {file.diffRows.length > 0 ? (
                                            <button
                                              className="diff-button"
                                              type="button"
                                              onClick={() =>
                                                setSelectedDiff({
                                                  title: message.artifact!.title,
                                                  file,
                                                  themeColors:
                                                    selectedSession?.characterThemeColors ?? DEFAULT_CHARACTER_THEME_COLORS,
                                                })
                                              }
                                            >
                                              Open Diff
                                            </button>
                                          ) : null}
                                        </article>
                                      ))
                                    ) : (
                                      <article className="artifact-file-item empty-state-card">
                                        <p>
                                          {artifactHasSnapshotRisk
                                            ? "差分は見つからなかったけど、snapshot の上限や省略で取りこぼしがあるかもしれないよ。"
                                            : "まだファイル変更はないよ。"}
                                        </p>
                                      </article>
                                    )}
                                  </div>
                                </section>

                                <section className="artifact-section compact">
                                  <div className="check-list">
                                    {message.artifact.runChecks.map((check) => (
                                      <div key={check.label} className="check-item">
                                        <span>{check.label}</span>
                                        <strong>{displayRunCheckValue(check)}</strong>
                                      </div>
                                    ))}
                                  </div>
                                </section>
                              </div>

                              <section className="artifact-section compact">
                                <ul className="artifact-operation-list">
                                  {artifactOperations.map((operation, operationIndex) => (
                                    <li key={`${operation.type}-${operationIndex}`} className={`artifact-operation-item ${operation.type}`}>
                                      <div className="artifact-operation-head">
                                        <span className={`artifact-operation-type ${operation.type}`}>{operationTypeLabel(operation.type)}</span>
                                      </div>
                                      {operation.type === "agent_message" ? (
                                        <div className="artifact-operation-message">
                                          <MessageRichText text={operation.summary} onOpenPath={handleOpenInlinePath} />
                                        </div>
                                      ) : (
                                        <p>{operation.summary}</p>
                                      )}
                                      {operation.details ? <pre>{operation.details}</pre> : null}
                                    </li>
                                  ))}
                                </ul>
                              </section>
                            </div>
                          ) : null}
                        </section>
                      ) : null}
                    </div>
                  </article>
                );
              })
            ) : null}

            {selectedSession.runState === "running" ? (
              <article className="message-row assistant pending-row">
                <CharacterAvatar character={selectedSessionCharacter} size="small" className="message-avatar" />
                <div className="message-card assistant pending-message-card">
                  <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
                    {pendingRunIndicatorAnnouncement}
                  </span>
                  <div className="live-run-shell-status pending-run-indicator" aria-hidden="true">
                    <span className="live-run-shell-status-badge">実行中</span>
                    <span className="live-run-shell-status-text">{pendingRunIndicatorText}</span>
                    <span className="typing-dots pending-run-indicator-dots">
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                  {hasLiveRunAssistantText ? <MessageRichText text={liveRunAssistantText} onOpenPath={handleOpenInlinePath} /> : null}
                  {selectedSessionLiveRun?.errorMessage ? (
                    <p className="pending-run-error-note" role="alert">{selectedSessionLiveRun.errorMessage}</p>
                  ) : null}
                </div>
              </article>
            ) : null}

          </div>

          {!isMessageListFollowing ? (
            <aside className={`message-follow-banner ${hasMessageListUnread ? "has-unread" : "idle"}`} aria-live="polite">
              <div className="message-follow-banner-copy">
                <span className="message-follow-banner-badge">{hasMessageListUnread ? "新着あり" : "読み返し中"}</span>
                <p>{hasMessageListUnread ? "追従を止めている間に新しい表示が来たよ。" : "今は読み返し位置を維持しているよ。"}</p>
              </div>
              <button type="button" className="message-follow-banner-button" onClick={handleJumpToMessageListBottom}>
                末尾へ移動
              </button>
            </aside>
          ) : null}
              </div>

              <button
                className={`session-workbench-splitter${isContextRailResizing ? " is-active" : ""}`}
                type="button"
                onPointerDown={handleStartContextRailResize}
                aria-label="会話と command pane の幅を調整"
                title="左右の幅をドラッグで調整"
              />

              <aside className="session-context-pane">
                <section className="command-monitor-shell" aria-label="最新 command">
                  <div className="command-monitor-head">
                    <div className="command-monitor-head-copy">
                      <span className={`command-monitor-badge ${latestCommandToneClassName}`}>
                        {isSelectedSessionRunning ? "LIVE COMMAND" : "LATEST COMMAND"}
                      </span>
                    </div>
                  </div>

                  {latestCommandView ? (
                    <div className="command-monitor-card">
                      <div className="command-monitor-card-head">
                        <div className="command-monitor-meta">
                          <span className={`live-run-step-status ${latestCommandToneClassName}`}>{latestCommandStatusLabel}</span>
                          <span className="live-run-step-type">Command</span>
                          <span className="command-monitor-source">{latestCommandSourceCopy}</span>
                        </div>
                        {latestCommandView.riskLabels.length > 0 ? (
                          <div className="command-monitor-risk-list" aria-label="command risk">
                            {latestCommandView.riskLabels.map((label) => (
                              <span key={label} className={`command-monitor-risk ${label.toLowerCase()}`}>
                                {label}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <div className="live-run-command-summary" aria-label="実行コマンド">
                        <span className="live-run-command-prefix" aria-hidden="true">
                          $
                        </span>
                        <code className="live-run-command-text">{latestCommandView.summary}</code>
                      </div>

                      {latestCommandView.details ? (
                        <details className="command-monitor-details live-run-step-details">
                          <summary>{liveRunStepDetailsLabel("command_execution")}</summary>
                          <pre>{latestCommandView.details}</pre>
                        </details>
                      ) : null}

                      {selectedSessionLiveRun?.errorMessage && isSelectedSessionRunning ? (
                        <div className="live-run-error-block" role="alert">
                          <strong>実行エラー</strong>
                          <p className="live-run-error">{selectedSessionLiveRun.errorMessage}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="command-monitor-empty-shell">
                      <p className="command-monitor-empty">
                        {isSelectedSessionRunning
                          ? "最初の command を待っています。"
                          : "直近 run に記録された command はまだないよ。"}
                      </p>
                      {selectedSessionLiveRun?.errorMessage ? (
                        <div className="live-run-error-block" role="alert">
                          <strong>実行エラー</strong>
                          <p className="live-run-error">{selectedSessionLiveRun.errorMessage}</p>
                        </div>
                      ) : null}
                    </div>
                  )}
                </section>
              </aside>
            </div>

            <div className={`session-action-dock${isActionDockExpanded ? "" : " compact"}`}>
              {isActionDockExpanded ? (
                <>
                  <div className="composer">
            {retryBanner ? (
              <div className={`resume-banner retry-banner ${retryBanner.kind}`}>
                <div className="resume-banner-head">
                  <div className="resume-banner-copy">
                    <span className={`resume-banner-badge ${retryBanner.kind}`}>{retryBanner.badge}</span>
                    <p className="resume-banner-title">{retryBanner.title}</p>
                  </div>
                  <button
                    className="artifact-toggle resume-banner-details-toggle"
                    type="button"
                    onClick={() => setIsRetryDetailsOpen((current) => !current)}
                    aria-expanded={isRetryDetailsOpen}
                  >
                    {isRetryDetailsOpen ? "Hide" : "Details"}
                  </button>
                </div>
                <div className="resume-banner-actions">
                  <button type="button" onClick={() => void handleResendLastMessage()} disabled={isRetryActionDisabled}>
                    同じ依頼を再送
                  </button>
                  <button
                    className="drawer-toggle secondary"
                    type="button"
                    onClick={handleEditLastMessage}
                    disabled={isRetryEditDisabled}
                  >
                    編集して再送
                  </button>
                </div>
                {isRetryDraftReplacePending ? (
                  <div className="resume-banner-conflict" role="status" aria-live="polite">
                    <p>今の下書きは残しています。</p>
                    <div className="resume-banner-conflict-actions">
                      <button type="button" onClick={handleConfirmRetryDraftReplace} disabled={isRetryEditDisabled}>
                        前回の依頼で置き換える
                      </button>
                      <button className="drawer-toggle secondary" type="button" onClick={handleCancelRetryDraftReplace}>
                        今の下書きを続ける
                      </button>
                    </div>
                  </div>
                ) : null}
                {isRetryDetailsOpen ? (
                  <div className="resume-banner-details">
                    <p className="resume-banner-summary">
                      <strong>停止地点</strong>
                      <span>{retryBanner.stopSummary}</span>
                    </p>
                    <div className="resume-banner-request">
                      <span>前回の依頼</span>
                      <MessageRichText text={retryBanner.lastRequestText} onOpenPath={handleOpenInlinePath} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="composer-attachments-toolbar">
              <div className="composer-attachment-button-group" role="group" aria-label="添付">
                <button className="drawer-toggle compact secondary" type="button" onClick={() => void handlePickFile()} disabled={selectedSession.runState === "running" || !!composerBlockedReason}>
                  File
                </button>
                <button className="drawer-toggle compact secondary" type="button" onClick={() => void handlePickFolder()} disabled={selectedSession.runState === "running" || !!composerBlockedReason}>
                  Folder
                </button>
                <button className="drawer-toggle compact secondary" type="button" onClick={() => void handlePickImage()} disabled={selectedSession.runState === "running" || !!composerBlockedReason}>
                  Image
                </button>
              </div>
              <button
                className={`drawer-toggle compact secondary composer-skill-button${isSkillPickerOpen ? " is-open" : ""}`}
                type="button"
                onClick={() => setIsSkillPickerOpen((current) => !current)}
                disabled={selectedSession.runState === "running" || !!composerBlockedReason}
                aria-expanded={isSkillPickerOpen}
                aria-haspopup="listbox"
              >
                Skill
              </button>
              {canCollapseActionDock ? (
                <button className="drawer-toggle compact secondary composer-hide-button" type="button" onClick={handleCollapseActionDock}>
                  Hide
                </button>
              ) : null}
            </div>
            {isSkillPickerOpen ? (
              <div
                className="composer-path-match-list composer-skill-picker-list"
                role={availableSkills.length > 0 ? "listbox" : "status"}
                aria-label="Skill 候補"
              >
                {isSkillListLoading ? (
                  <p className="composer-skill-empty">Skill を読み込み中だよ。</p>
                ) : availableSkills.length > 0 ? (
                  availableSkills.map((skill) => {
                    const skillDisplay = buildSkillMatchDisplay(skill);

                    return (
                      <button
                        key={skill.id}
                        type="button"
                        role="option"
                        className="composer-path-match"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleSelectSkill(skill)}
                        title={skillDisplay.title}
                      >
                        <span className="composer-path-match-primary">{skillDisplay.primaryLabel}</span>
                        <span className="composer-path-match-secondary">{skillDisplay.secondaryLabel}</span>
                      </button>
                    );
                  })
                ) : (
                  <p className="composer-skill-empty">
                    使える skill がまだないよ。Home の Settings で Skill Root を設定するか、workspace 配下に
                    `SKILL.md` を配置してね。
                  </p>
                )}
              </div>
            ) : null}
            {composerPreview.attachments.length > 0 ? (
              <div className="composer-attachment-list">
                {composerPreview.attachments.map((attachment) => {
                  const attachmentDisplay = buildComposerAttachmentDisplay(attachment);
                  return (
                    <div
                      key={attachment.id}
                      className={`composer-attachment-chip ${attachment.kind}`}
                      title={attachmentDisplay.title}
                    >
                      <span className="composer-attachment-kind">{attachmentDisplay.kindLabel}</span>
                      <span className="composer-attachment-copy">
                        <span className="composer-attachment-primary">{attachmentDisplay.primaryLabel}</span>
                        <span className="composer-attachment-meta">
                          <span className="composer-attachment-location">{attachmentDisplay.locationLabel}</span>
                          <span className="composer-attachment-secondary">{attachmentDisplay.secondaryLabel}</span>
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          handleRemoveAttachmentReference(
                            [
                              attachment.workspaceRelativePath,
                              attachment.displayPath,
                              normalizePathForReference(attachment.absolutePath),
                            ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="composer-box">
              <textarea
                ref={composerTextareaRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setComposerCaret(event.target.selectionStart ?? event.target.value.length);
                }}
                onFocus={() => setIsActionDockPinnedExpanded(true)}
                onKeyDown={handleComposerKeyDown}
                onSelect={(event) => setComposerCaret(event.currentTarget.selectionStart ?? 0)}
                onCompositionStart={() => setIsComposerImeComposing(true)}
                onCompositionEnd={() => setIsComposerImeComposing(false)}
                disabled={isComposerDisabled}
                aria-describedby={composerSendability.shouldShowFeedback ? "composer-sendability-feedback" : undefined}
              />
              <button
                className={selectedSession.runState === "running" ? "danger session-send-button" : "session-send-button"}
                type="button"
                onClick={() => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend())}
                disabled={selectedSession.runState !== "running" && isSendDisabled}
              >
                {selectedSession.runState === "running" ? "Cancel" : "Send"}
              </button>
              {composerSendability.shouldShowFeedback ? (
                <div
                  id="composer-sendability-feedback"
                  className={`composer-sendability-feedback ${composerSendability.feedbackTone ?? "helper"}`}
                  role={composerSendability.feedbackTone === "blocked" ? "alert" : "status"}
                  aria-live={composerSendability.feedbackTone === "blocked" ? "assertive" : "polite"}
                >
                  {composerSendability.primaryFeedback ? <p>{composerSendability.primaryFeedback}</p> : null}
                  {composerSendability.secondaryFeedback.length > 0 ? (
                    <ul>
                      {composerSendability.secondaryFeedback.map((feedback) => (
                        <li key={feedback}>{feedback}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
            {workspacePathMatches.length > 0 ? (
              <div className="composer-path-match-list" role="listbox" aria-label="@path 候補">
                {workspacePathMatches.map((match, index) => {
                  const matchDisplay = buildWorkspacePathMatchDisplay(match);
                  const isActive = index === activeWorkspacePathMatchIndex;

                  return (
                    <button
                      key={match}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`composer-path-match${isActive ? " active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveWorkspacePathMatchIndex(index)}
                      onFocus={() => setActiveWorkspacePathMatchIndex(index)}
                      onClick={() => handleSelectWorkspacePathMatch(match)}
                      title={matchDisplay.title}
                    >
                      <span className="composer-path-match-primary">{matchDisplay.primaryLabel}</span>
                      <span className="composer-path-match-secondary">{matchDisplay.secondaryLabel}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className="composer-settings">
              <div className="composer-setting-field composer-setting-approval">
                <span>Approval</span>
                <div className="choice-list session-approval-list" role="group" aria-label="承認モード">
                  {approvalModeOptions.map((approval) => (
                    <button
                      key={approval.id}
                      className={`choice-chip${approval.id === selectedSession.approvalMode ? " active" : ""}`}
                      type="button"
                      onClick={() => void handleChangeApproval(approval.id)}
                      disabled={selectedSession.runState === "running"}
                    >
                      {approval.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="composer-setting-field">
                <span>Model</span>
                <select
                  value={selectedSession.model}
                  onChange={(event) => void handleChangeModel(event.target.value)}
                  disabled={selectedSession.runState === "running"}
                >
                  {modelOptions.length > 0 ? (
                    modelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {modelOptionLabel(model)}
                      </option>
                    ))
                  ) : (
                    <option value={selectedSession.model}>{modelDisplayLabel(selectedProviderCatalog, selectedSession.model)}</option>
                  )}
                </select>
              </div>

              <div className="composer-setting-field">
                <span>Depth</span>
                <select
                  value={selectedSession.reasoningEffort}
                  onChange={(event) => void handleChangeReasoningEffort(event.target.value as Session["reasoningEffort"])}
                  disabled={selectedSession.runState === "running"}
                  aria-label="推論の深さ"
                >
                  {availableReasoningEfforts.map((reasoningEffort) => (
                    <option key={reasoningEffort} value={reasoningEffort}>
                      {reasoningDepthLabel(reasoningEffort)}
                    </option>
                  ))}
                </select>
              </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="session-action-dock-compact-row">
                  <button
                    className="session-action-dock-compact-preview"
                    type="button"
                    onClick={() => handleExpandActionDock({ focusComposer: true })}
                    title={draft.trim() ? draft : "下書きなし"}
                  >
                    <span className="session-action-dock-compact-label">Draft</span>
                    <span className={`session-action-dock-compact-text${draft.trim() ? " has-draft" : ""}`}>
                      {actionDockCompactPreview}
                    </span>
                  </button>
                  <div className="session-action-dock-compact-meta" aria-label="draft summary">
                    {composerPreview.attachments.length > 0 ? (
                      <span className="session-action-dock-compact-badge">{`添付 ${composerPreview.attachments.length}`}</span>
                    ) : null}
                    {selectedSession.runState === "running" ? (
                      <span className="session-action-dock-compact-badge running">RUN</span>
                    ) : null}
                  </div>
                  <div className="session-action-dock-compact-actions">
                    <button
                      className={selectedSession.runState === "running" ? "danger session-send-button" : "session-send-button"}
                      type="button"
                      onClick={() => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend())}
                      disabled={selectedSession.runState !== "running" && isSendDisabled}
                    >
                      {selectedSession.runState === "running" ? "Cancel" : "Send"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </section>

      {selectedDiff ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setSelectedDiff(null)}>
          <section
            className="diff-editor panel theme-accent"
            style={selectedDiffThemeStyle}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="diff-titlebar">
              <h2>{selectedDiff.file.path}</h2>
              <div className="diff-titlebar-actions">
                <button className="diff-close diff-popout" type="button" onClick={() => void handleOpenDiffWindow(selectedDiff)}>
                  Open In Window
                </button>
                <button className="diff-close" type="button" onClick={() => setSelectedDiff(null)}>
                  Close
                </button>
              </div>
            </div>

            <DiffViewerSubbar file={selectedDiff.file} />
            <DiffViewer file={selectedDiff.file} />
          </section>
        </div>
      ) : null}

      {auditLogsOpen ? (
        <div className="diff-modal" role="dialog" aria-modal="true" onClick={() => setAuditLogsOpen(false)}>
          <section className="audit-log-panel panel" onClick={(event) => event.stopPropagation()}>
            <div className="diff-titlebar">
              <h2>Audit Log</h2>
              <div className="diff-titlebar-actions">
                <button className="diff-close" type="button" onClick={() => setAuditLogsOpen(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="audit-log-list">
              {selectedSessionAuditLogs.length > 0 ? (
                selectedSessionAuditLogs.map((entry) => (
                  <article key={entry.id} className={`audit-log-card ${entry.phase}`}>
                    <div className="audit-log-head">
                      <span className={`file-kind ${
                        entry.phase === "completed"
                          ? "add"
                          : entry.phase === "failed"
                            ? "delete"
                            : entry.phase === "canceled"
                              ? "edit"
                              : "edit"
                      }`}>
                        {auditPhaseLabel(entry.phase)}
                      </span>
                      <span className="audit-log-time">{entry.createdAt}</span>
                    </div>

                    <div className="audit-log-meta">
                      <span>{entry.provider}</span>
                      <span>{entry.model}</span>
                      <span>{entry.reasoningEffort}</span>
                      <span>{displayApprovalValue(entry.approvalMode)}</span>
                    </div>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>System Prompt</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.systemPromptText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold" open>
                      <summary>
                        <strong>Input Prompt</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.inputPromptText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>Composed Prompt</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.composedPromptText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>Response</strong>
                      </summary>
                      <section className="audit-log-section">
                        <pre>{entry.assistantText || "-"}</pre>
                      </section>
                    </details>

                    <details className="audit-log-fold">
                      <summary>
                        <strong>Operations</strong>
                      </summary>
                      <section className="audit-log-section">
                        {entry.operations.length > 0 ? (
                          <ul className="audit-log-operations">
                            {entry.operations.map((operation, index) => (
                              <li key={`${entry.id}-${operation.type}-${index}`}>
                                <div className="audit-log-operation-head">
                                  <span>{operation.type}</span>
                                  <strong>{operation.summary}</strong>
                                </div>
                                {operation.details ? <pre>{operation.details}</pre> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="audit-log-empty">記録された操作はまだないよ。</p>
                        )}
                      </section>
                    </details>

                    {entry.usage ? (
                      <details className="audit-log-fold compact">
                        <summary>
                          <strong>Usage</strong>
                        </summary>
                        <section className="audit-log-section compact">
                          <div className="audit-log-meta">
                            <span>input {entry.usage.inputTokens}</span>
                            <span>cached {entry.usage.cachedInputTokens}</span>
                            <span>output {entry.usage.outputTokens}</span>
                          </div>
                        </section>
                      </details>
                    ) : null}

                    {entry.errorMessage ? (
                      <details className="audit-log-fold compact">
                        <summary>
                          <strong>Error</strong>
                        </summary>
                        <section className="audit-log-section compact">
                          <pre>{entry.errorMessage}</pre>
                        </section>
                      </details>
                    ) : null}

                    <details className="audit-log-fold audit-log-raw">
                      <summary>
                        <strong>Raw Items</strong>
                      </summary>
                      <pre>{entry.rawItemsJson}</pre>
                    </details>
                  </article>
                ))
              ) : (
                <article className="empty-list-card compact">
                  <p>まだ監査ログはないよ。</p>
                </article>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

