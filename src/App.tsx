import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import {
  type AuditLogEntry,
  type ComposerAttachment,
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
  type SessionBackgroundActivityKind,
  type SessionBackgroundActivityState,
  type SessionContextTelemetry,
} from "./app-state.js";
import { DEFAULT_CHARACTER_SESSION_COPY, type CharacterProfile } from "./character-state.js";
import type { CharacterUpdateMemoryExtract } from "./character-update-state.js";
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
  resolveModelSelection,
  type ModelCatalogSnapshot,
} from "./model-catalog.js";
import { buildAuditLogRefreshSignature } from "./audit-log-refresh.js";
import { buildCharacterThemeStyle } from "./theme-utils.js";
import {
  approvalModeOptions,
  approvalModeLabel,
  modelDisplayLabel,
  modelOptionLabel,
  reasoningDepthLabel,
} from "./ui-utils.js";
import {
  buildContextPaneProjection,
  buildCopilotQuotaProjection,
  buildLatestCommandView,
  buildRunningDetailsEntries,
  buildSessionContextTelemetryProjection,
  cycleContextPaneTab,
  type ContextPaneTabKey,
  resolveAutoContextPaneTab,
} from "./session-ui-projection.js";
import {
  SessionComposerExpanded,
  SessionActionDockCompactRow,
  SessionAuditLogModal,
  CharacterUpdateContextPane,
  SessionPaneErrorBoundary,
  SessionContextPane,
  SessionDiffModal,
  SessionHeader,
  SessionMessageColumn,
  SessionRetryBanner,
} from "./session-components.js";
import {
  buildComposerSendabilityState,
  getComposerSendButtonTitle,
  withForcedComposerBlockedFeedback,
  type ComposerSendabilityState,
} from "./session-composer-feedback.js";
import { getWithMateApi, isDesktopRuntime } from "./renderer-withmate-api.js";

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

type ProviderOwnedQuotaTelemetry = {
  ownerProviderId: string | null;
  telemetry: ProviderQuotaTelemetry | null;
};

type SessionOwnedContextTelemetry = {
  ownerSessionId: string | null;
  telemetry: SessionContextTelemetry | null;
};

type SessionOwnedBackgroundActivity = {
  ownerSessionId: string | null;
  kind: SessionBackgroundActivityKind;
  state: SessionBackgroundActivityState | null;
};

type CharacterOwnedMemoryExtract = {
  ownerCharacterId: string | null;
  extract: CharacterUpdateMemoryExtract | null;
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

type AdditionalDirectoryDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

type SkillMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

type CustomAgentMatchDisplay = {
  primaryLabel: string;
  secondaryLabel: string;
  title: string;
};

type SelectedCustomAgentDisplay = {
  label: string;
  title?: string;
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

function buildAdditionalDirectoryDisplay(directoryPath: string): AdditionalDirectoryDisplay {
  const normalizedPath = normalizePathForReference(directoryPath).replace(/\/+$/, "");
  const { basename, parentPath } = splitPathForDisplay(normalizedPath);
  return {
    primaryLabel: basename || normalizedPath,
    secondaryLabel: parentPath ? compactPathForDisplay(parentPath, 52) : "ルート",
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

function buildCustomAgentMatchDisplay(agent: DiscoveredCustomAgent): CustomAgentMatchDisplay {
  return {
    primaryLabel: agent.displayName || agent.name,
    secondaryLabel: `${agent.sourceLabel}${agent.description ? ` · ${agent.description}` : ""}`,
    title: `${agent.displayName || agent.name}\n${agent.sourcePath}`,
  };
}

function buildSelectedCustomAgentDisplay(
  session: Session | null,
  selectedAgent: DiscoveredCustomAgent | null,
): SelectedCustomAgentDisplay {
  if (!session || session.provider !== "copilot") {
    return {
      label: "",
    };
  }

  if (!session.customAgentName.trim()) {
    return {
      label: "Default Agent",
      title: "Copilot の標準 agent を使う",
    };
  }

  if (selectedAgent) {
    return {
      label: selectedAgent.displayName || selectedAgent.name,
      title: `${selectedAgent.displayName || selectedAgent.name}\n${selectedAgent.sourcePath}`,
    };
  }

  return {
    label: session.customAgentName.trim(),
    title: session.customAgentName.trim(),
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

function isTerminalAuditLogPhase(phase: AuditLogEntry["phase"]): boolean {
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
  ].join("\u001b");
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
  const desktopRuntime = isDesktopRuntime();
  const withmateApi = getWithMateApi();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [draft, setDraft] = useState("");
  const [forceComposerBlockedFeedback, setForceComposerBlockedFeedback] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSnapshot | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [selectedDiff, setSelectedDiff] = useState<DiffPreviewPayload | null>(null);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);
  const [auditLogsState, setAuditLogsState] = useState<SessionOwnedAuditLogs>({ ownerSessionId: null, entries: [] });
  const [liveRunState, setLiveRunState] = useState<SessionOwnedLiveRun>({ ownerSessionId: null, state: null });
  const [providerQuotaTelemetryState, setProviderQuotaTelemetryState] = useState<ProviderOwnedQuotaTelemetry>({
    ownerProviderId: null,
    telemetry: null,
  });
  const [sessionContextTelemetryState, setSessionContextTelemetryState] = useState<SessionOwnedContextTelemetry>({
    ownerSessionId: null,
    telemetry: null,
  });
  const [memoryGenerationActivityState, setMemoryGenerationActivityState] = useState<SessionOwnedBackgroundActivity>({
    ownerSessionId: null,
    kind: "memory-generation",
    state: null,
  });
  const [characterMemoryGenerationActivityState, setCharacterMemoryGenerationActivityState] = useState<SessionOwnedBackgroundActivity>({
    ownerSessionId: null,
    kind: "character-memory-generation",
    state: null,
  });
  const [monologueActivityState, setMonologueActivityState] = useState<SessionOwnedBackgroundActivity>({
    ownerSessionId: null,
    kind: "monologue",
    state: null,
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
  const [workspacePathMatches, setWorkspacePathMatches] = useState<string[]>([]);
  const [activeWorkspacePathMatchIndex, setActiveWorkspacePathMatchIndex] = useState(-1);
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [availableCustomAgents, setAvailableCustomAgents] = useState<DiscoveredCustomAgent[]>([]);
  const [isAgentPickerOpen, setIsAgentPickerOpen] = useState(false);
  const [isCustomAgentListLoading, setIsCustomAgentListLoading] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [isAdditionalDirectoryListOpen, setIsAdditionalDirectoryListOpen] = useState(false);
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
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
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

    if (!withmateApi) {
      return () => {
        active = false;
      };
    }

    if (selectedId) {
      void withmateApi.getSession(selectedId).then((session) => {
        if (active && session) {
          setSessions([session]);
        }
      });
    } else {
      void withmateApi.listSessions().then((nextSessions) => {
        if (active) {
          setSessions(nextSessions);
        }
      });
    }

    const unsubscribe = withmateApi.subscribeSessions((nextSessions) => {
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
  const selectedMemoryGenerationActivity = useMemo(
    () => (
      selectedSessionId !== null && memoryGenerationActivityState.ownerSessionId === selectedSessionId
        ? memoryGenerationActivityState.state
        : null
    ),
    [memoryGenerationActivityState.ownerSessionId, memoryGenerationActivityState.state, selectedSessionId],
  );
  const selectedCharacterMemoryGenerationActivity = useMemo(
    () => (
      selectedSessionId !== null && characterMemoryGenerationActivityState.ownerSessionId === selectedSessionId
        ? characterMemoryGenerationActivityState.state
        : null
    ),
    [characterMemoryGenerationActivityState.ownerSessionId, characterMemoryGenerationActivityState.state, selectedSessionId],
  );
  const selectedMonologueActivity = useMemo(
    () => (
      selectedSessionId !== null && monologueActivityState.ownerSessionId === selectedSessionId
        ? monologueActivityState.state
        : null
    ),
    [monologueActivityState.ownerSessionId, monologueActivityState.state, selectedSessionId],
  );
  const auditLogRefreshSignature = useMemo(
    () =>
      buildAuditLogRefreshSignature({
        selectedSession,
        displayedMessagesLength: selectedSession?.messages.length ?? 0,
        selectedMemoryGenerationActivity,
        selectedCharacterMemoryGenerationActivity,
        selectedMonologueActivity,
      }),
    [
      selectedCharacterMemoryGenerationActivity,
      selectedMemoryGenerationActivity,
      selectedMonologueActivity,
      selectedSession,
    ],
  );
  const selectedMonologueEntries = useMemo(
    () => (selectedSession ? selectedSession.stream.slice(-6) : []),
    [selectedSession],
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
  const isCharacterUpdateSession = selectedSession?.sessionKind === "character-update";
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

    if (!withmateApi || !selectedSession) {
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
    void withmateApi.listSessionAuditLogs(selectedSession.id).then((nextAuditLogs) => {
      if (active) {
        setAuditLogsState({ ownerSessionId: selectedSession.id, entries: nextAuditLogs });
      }
    });

    return () => {
      active = false;
    };
  }, [auditLogRefreshSignature, selectedSessionId]);

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
    const sessionId = selectedSession?.id ?? null;

    if (!withmateApi || !sessionId) {
      setMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "memory-generation", state: null });
      return () => {
        active = false;
      };
    }

    setMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "memory-generation", state: null });
    void withmateApi.getSessionBackgroundActivity(sessionId, "memory-generation").then((state) => {
      if (active) {
        setMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "memory-generation", state });
      }
    }).catch(() => {
      if (active) {
        setMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "memory-generation", state: null });
      }
    });

    const unsubscribe = withmateApi.subscribeSessionBackgroundActivity((nextSessionId, kind, state) => {
      if (!active || nextSessionId !== sessionId || kind !== "memory-generation") {
        return;
      }

      setMemoryGenerationActivityState({ ownerSessionId: nextSessionId, kind, state });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    let active = true;
    const sessionId = selectedSession?.id ?? null;

    if (!withmateApi || !sessionId) {
      setCharacterMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "character-memory-generation", state: null });
      return () => {
        active = false;
      };
    }

    setCharacterMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "character-memory-generation", state: null });
    void withmateApi.getSessionBackgroundActivity(sessionId, "character-memory-generation").then((state) => {
      if (active) {
        setCharacterMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "character-memory-generation", state });
      }
    }).catch(() => {
      if (active) {
        setCharacterMemoryGenerationActivityState({ ownerSessionId: sessionId, kind: "character-memory-generation", state: null });
      }
    });

    const unsubscribe = withmateApi.subscribeSessionBackgroundActivity((nextSessionId, kind, state) => {
      if (!active || nextSessionId !== sessionId || kind !== "character-memory-generation") {
        return;
      }

      setCharacterMemoryGenerationActivityState({ ownerSessionId: nextSessionId, kind, state });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    let active = true;
    const sessionId = selectedSession?.id ?? null;

    if (!withmateApi || !sessionId) {
      setMonologueActivityState({ ownerSessionId: sessionId, kind: "monologue", state: null });
      return () => {
        active = false;
      };
    }

    setMonologueActivityState({ ownerSessionId: sessionId, kind: "monologue", state: null });
    void withmateApi.getSessionBackgroundActivity(sessionId, "monologue").then((state) => {
      if (active) {
        setMonologueActivityState({ ownerSessionId: sessionId, kind: "monologue", state });
      }
    }).catch(() => {
      if (active) {
        setMonologueActivityState({ ownerSessionId: sessionId, kind: "monologue", state: null });
      }
    });

    const unsubscribe = withmateApi.subscribeSessionBackgroundActivity((nextSessionId, kind, state) => {
      if (!active || nextSessionId !== sessionId || kind !== "monologue") {
        return;
      }

      setMonologueActivityState({ ownerSessionId: nextSessionId, kind, state });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    let active = true;
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
    () => approvalModeOptions.map((approval) => ({ value: approval.id, label: approval.label })),
    [],
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
    () => availableReasoningEfforts.map((reasoningEffort) => ({ value: reasoningEffort, label: reasoningDepthLabel(reasoningEffort) })),
    [availableReasoningEfforts],
  );
  const customAgentItems = useMemo(
    () => {
      const items = [
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
          key: match,
          path: match,
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

    setSessions([updatedSession]);

    try {
      const request: RunSessionTurnRequest = {
        userMessage: messageText,
      };
      const savedSession = await withmateApi.runSessionTurn(selectedSession.id, request);
      setSessions([savedSession]);
    } catch (error) {
      console.error(error);
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

    const selection = resolveModelSelection(selectedProviderCatalog, model, selectedSession.reasoningEffort);
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
  const isSelectedSessionRunning = selectedSession?.runState === "running";
  const contextPaneProjection = useMemo(
    () => buildContextPaneProjection({
      activeContextPaneTab,
      latestCommandView,
      selectedMemoryGenerationActivity,
      selectedCharacterMemoryGenerationActivity,
      selectedMonologueActivity,
    }),
    [activeContextPaneTab, latestCommandView, selectedMemoryGenerationActivity, selectedCharacterMemoryGenerationActivity, selectedMonologueActivity],
  );

  useEffect(() => {
    const nextTab = resolveAutoContextPaneTab({
      isSelectedSessionRunning,
      selectedMemoryGenerationActivity,
      selectedCharacterMemoryGenerationActivity,
      selectedMonologueActivity,
    });
    if (nextTab) {
      setActiveContextPaneTab(nextTab);
    }
  }, [isSelectedSessionRunning, selectedMemoryGenerationActivity?.status, selectedCharacterMemoryGenerationActivity?.status, selectedMonologueActivity?.status]);
  const handleCycleContextPaneTab = (direction: -1 | 1) => {
    setActiveContextPaneTab((current) => cycleContextPaneTab(current, direction));
  };

  const handleRunSessionMemoryExtraction = async () => {
    if (!withmateApi || !selectedSession || isSelectedSessionRunning || selectedMemoryGenerationActivity?.status === "running") {
      return;
    }

    setActiveContextPaneTab("memory-generation");
    await withmateApi.runSessionMemoryExtraction(selectedSession.id);
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
  const sessionWorkbenchStyle = useMemo(
    () =>
      ({
        ["--session-context-rail-width" as string]: `${contextRailWidth}px`,
      }) as CSSProperties,
    [contextRailWidth],
  );

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
    <div className="page-shell session-page" style={sessionThemeStyle}>
      {isSessionHeaderExpanded ? (
        <SessionHeader
          taskTitle={selectedSession.taskTitle}
          isEditingTitle={isEditingTitle}
          titleDraft={titleDraft}
          isRunning={selectedSession.runState === "running"}
          showTerminalButton={!isCharacterUpdateSession}
          onToggleExpanded={handleToggleHeaderExpanded}
          onClose={handleCloseWindow}
          onOpenAuditLog={() => setAuditLogsOpen(true)}
          onOpenTerminal={() => void handleOpenSessionTerminal()}
          onTitleDraftChange={setTitleDraft}
          onTitleInputKeyDown={handleTitleInputKeyDown}
          onSaveTitle={() => void handleSaveTitle()}
          onCancelTitleEdit={handleCancelTitleEdit}
          onStartTitleEdit={handleStartTitleEdit}
          onDeleteSession={() => void handleDeleteSession()}
        />
      ) : null}

      <section className="content-grid session-content-grid">
        <section className="chat-panel session-work-surface rise-3">
          <div className="session-workbench" ref={sessionWorkbenchRef} style={sessionWorkbenchStyle}>
            <div className="session-main-grid">
              <div className="session-message-stack">
                <SessionMessageColumn
                  sessionId={selectedSession.id}
                  character={selectedSessionCharacter}
                  messages={displayedMessages}
                  expandedArtifacts={expandedArtifacts}
                  messageListRef={messageListRef}
                  isRunning={selectedSession.runState === "running"}
                  pendingRunIndicatorAnnouncement={pendingRunIndicatorAnnouncement}
                  pendingRunIndicatorText={pendingRunIndicatorText}
                  liveApprovalRequest={liveApprovalRequest}
                  approvalActionRequestId={approvalActionRequestId}
                  liveElicitationRequest={liveElicitationRequest}
                  elicitationActionRequestId={elicitationActionRequestId}
                  liveRunAssistantText={liveRunAssistantText}
                  hasLiveRunAssistantText={hasLiveRunAssistantText}
                  liveRunErrorMessage={selectedSessionLiveRun?.errorMessage ?? ""}
                  isMessageListFollowing={isMessageListFollowing}
                  hasMessageListUnread={hasMessageListUnread}
                  onMessageListScroll={handleMessageListScroll}
                  onToggleArtifact={toggleArtifact}
                  onOpenDiff={(title, file) =>
                    setSelectedDiff({
                      title,
                      file,
                      themeColors: selectedSession.characterThemeColors,
                    })}
                  onResolveLiveApproval={(request, decision) => void handleResolveLiveApproval(request, decision)}
                  onResolveLiveElicitation={(request, response) => void handleResolveLiveElicitation(request, response)}
                  onJumpToBottom={handleJumpToMessageListBottom}
                  onOpenPath={handleOpenInlinePath}
                  getChangedFilesEmptyText={(artifactKey, artifactHasSnapshotRisk) =>
                    artifactHasSnapshotRisk
                      ? "差分は見つからなかったけど、snapshot の上限や省略で取りこぼしがあるかもしれないよ。"
                      : renderCharacterSessionCopy(
                        selectedSessionCopy.changedFilesEmpty,
                        pendingIndicatorCharacterName,
                        `changed-files-empty:${artifactKey}`,
                      )}
                />

                <div className={`session-action-dock${isActionDockExpanded ? "" : " compact"}`}>
                  {isActionDockExpanded ? (
                    <>
                      <SessionComposerExpanded
                        retryBanner={(
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
                        )}
                        isRunning={selectedSession.runState === "running"}
                        composerBlocked={!!composerBlockedReason}
                        canSelectCustomAgent={!isCharacterUpdateSession && selectedSession.provider === "copilot"}
                        showCustomAgentPicker={!isCharacterUpdateSession}
                        showSkillPicker={!isCharacterUpdateSession}
                        isAgentPickerOpen={isAgentPickerOpen}
                        isSkillPickerOpen={isSkillPickerOpen}
                        isAdditionalDirectoryListOpen={isAdditionalDirectoryListOpen}
                        selectedCustomAgentLabel={selectedSession.provider === "copilot" ? selectedCustomAgentDisplay.label : "Agent"}
                        selectedCustomAgentTitle={selectedCustomAgentDisplay.title ?? "Copilot custom agent を選択"}
                        additionalDirectoryCount={selectedSession.allowedAdditionalDirectories.length}
                        canCollapseActionDock={canCollapseActionDock}
                        isCustomAgentListLoading={isCustomAgentListLoading}
                        isSkillListLoading={isSkillListLoading}
                        customAgentItems={customAgentItems}
                        skillItems={skillItems}
                        attachmentItems={composerAttachmentItems}
                        additionalDirectoryItems={additionalDirectoryItems}
                        workspacePathMatchItems={workspacePathMatchItems}
                        draft={draft}
                        composerTextareaRef={composerTextareaRef}
                        isComposerDisabled={isComposerDisabled}
                        isSendDisabled={isSendDisabled}
                        composerSendability={composerSendability}
                        sendButtonTitle={composerSendButtonTitle}
                        isComposerBlockedFeedbackActive={forceComposerBlockedFeedback && composerSendability.shouldShowFeedback}
                        approvalOptions={approvalChoiceOptions}
                        selectedApprovalMode={selectedSession.approvalMode}
                        modelOptions={modelSelectOptions}
                        selectedModel={selectedSession.model}
                        selectedModelFallbackLabel={selectedModelFallbackLabel}
                        reasoningOptions={reasoningSelectOptions}
                        selectedReasoningEffort={selectedSession.reasoningEffort}
                        onPickFile={() => void handlePickFile()}
                        onPickFolder={() => void handlePickFolder()}
                        onPickImage={() => void handlePickImage()}
                        onToggleAgentPicker={() => {
                          setIsSkillPickerOpen(false);
                          setIsAgentPickerOpen((current) => !current);
                        }}
                        onToggleSkillPicker={() => {
                          setIsAgentPickerOpen(false);
                          setIsSkillPickerOpen((current) => !current);
                        }}
                        onAddAdditionalDirectory={() => void handleAddAdditionalDirectory()}
                        onToggleAdditionalDirectoryList={() => setIsAdditionalDirectoryListOpen((current) => !current)}
                        onCollapse={handleCollapseActionDock}
                        onSelectCustomAgent={(value) => void handleSelectCustomAgent(
                          value ? availableCustomAgents.find((agent) => agent.name === value) ?? null : null,
                        )}
                        onSelectSkill={(skillId) => {
                          const skill = availableSkills.find((entry) => entry.id === skillId);
                          if (skill) {
                            handleSelectSkill(skill);
                          }
                        }}
                        onRemoveAttachment={handleRemoveAttachmentReference}
                        onRemoveAdditionalDirectory={(path) => void handleRemoveAdditionalDirectory(path)}
                        onDraftChange={(value, selectionStart) => {
                          setForceComposerBlockedFeedback(false);
                          setDraft(value);
                          setComposerCaret(selectionStart);
                        }}
                        onDraftFocus={() => setIsActionDockPinnedExpanded(true)}
                        onDraftKeyDown={handleComposerKeyDown}
                        onDraftSelect={setComposerCaret}
                        onDraftCompositionStart={() => setIsComposerImeComposing(true)}
                        onDraftCompositionEnd={() => setIsComposerImeComposing(false)}
                        onSendOrCancel={() => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend())}
                        onSelectWorkspacePathMatch={handleSelectWorkspacePathMatch}
                        onActivateWorkspacePathMatch={setActiveWorkspacePathMatchIndex}
                        onChangeApprovalMode={(value) => void handleChangeApproval(value)}
                        onChangeModel={(value) => void handleChangeModel(value)}
                        onChangeReasoningEffort={(value) => void handleChangeReasoningEffort(value as Session["reasoningEffort"])}
                      />
                    </>
                  ) : (
                    <SessionActionDockCompactRow
                      draft={draft}
                      actionDockCompactPreview={actionDockCompactPreview}
                      attachmentCount={composerPreview.attachments.length}
                      isRunning={selectedSession.runState === "running"}
                      isSendDisabled={isSendDisabled}
                      sendButtonTitle={composerSendButtonTitle}
                      onExpand={() => handleExpandActionDock({ focusComposer: true })}
                      onSendOrCancel={() => void (selectedSession.runState === "running" ? handleCancelRun() : handleSend())}
                    />
                  )}
                </div>
              </div>

              <button
                className={`session-workbench-splitter${isContextRailResizing ? " is-active" : ""}`}
                type="button"
                onPointerDown={handleStartContextRailResize}
                aria-label="会話と command pane の幅を調整"
                title="左右の幅をドラッグで調整"
              />

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
                    contextPaneProjection={contextPaneProjection}
                    latestCommandView={latestCommandView}
                    runningDetailsEntries={runningDetailsEntries}
                    selectedSessionLiveRunErrorMessage={selectedSessionLiveRun?.errorMessage ?? ""}
                    isSelectedSessionRunning={isSelectedSessionRunning}
                    selectedSessionCharacter={selectedSessionCharacter}
                    selectedMemoryGenerationActivity={selectedMemoryGenerationActivity}
                    selectedCharacterMemoryGenerationActivity={selectedCharacterMemoryGenerationActivity}
                    selectedMonologueActivity={selectedMonologueActivity}
                    selectedMonologueEntries={selectedMonologueEntries}
                    isCopilotSession={isCopilotSession}
                    selectedCopilotRemainingPercentLabel={selectedCopilotRemainingPercentLabel}
                    selectedCopilotRemainingRequestsLabel={selectedCopilotRemainingRequestsLabel}
                    selectedCopilotQuotaResetLabel={selectedCopilotQuotaResetLabel}
                    selectedSessionContextTelemetry={selectedSessionContextTelemetry}
                    selectedSessionContextTelemetryProjection={selectedSessionContextTelemetryProjection}
                    contextEmptyText={selectedContextEmptyText}
                    canRunSessionMemoryGeneration={!!withmateApi && !isSelectedSessionRunning}
                    onToggleHeaderExpanded={handleToggleHeaderExpanded}
                    isSessionMemoryGenerationRunning={selectedMemoryGenerationActivity?.status === "running"}
                    onCycleContextPaneTab={handleCycleContextPaneTab}
                    onRunSessionMemoryGeneration={() => void handleRunSessionMemoryExtraction()}
                  />
                )}
              </SessionPaneErrorBoundary>
            </div>
          </div>
        </section>
      </section>

      <SessionDiffModal
        selectedDiff={selectedDiff}
        themeStyle={selectedDiffThemeStyle}
        onClose={() => setSelectedDiff(null)}
        onOpenDiffWindow={(payload) => void handleOpenDiffWindow(payload)}
      />

      <SessionAuditLogModal
        open={auditLogsOpen}
        entries={selectedSessionAuditLogs}
        onClose={() => setAuditLogsOpen(false)}
      />
    </div>
  );
}

