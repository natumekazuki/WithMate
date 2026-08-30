import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "./approval-mode.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  normalizeCodexSandboxMode,
  type CodexSandboxMode,
} from "./codex-sandbox-mode.js";
import { normalizeCharacterThemeColors, type CharacterThemeColors } from "./character-state.js";
import type { CharacterRuntimeSnapshot } from "./character/character-catalog.js";
import {
  isUnknownCharacterOwnerId,
  recoverStoredCharacterOwnerId,
  requireCharacterOwnerId,
} from "./character/character-owner.js";
import {
  normalizeCharacterRuntimeSnapshot,
} from "./character/character-runtime-snapshot.js";
import {
  DEFAULT_CATALOG_REVISION,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  isModelReasoningEffort,
  normalizeProviderId,
  type ModelReasoningEffort,
  type ResolvedModelSelection,
} from "./model-catalog.js";
import {
  type AuditLogOperation,
  type ChangedFile,
  type DiffRow,
  type RunCheck,
} from "./runtime-state.js";
import { currentTimestampLabel } from "./time-state.js";

export type MessageArtifact = {
  title: string;
  activitySummary: string[];
  operationTimeline?: AuditLogOperation[];
  changedFiles: ChangedFile[];
  runChecks: RunCheck[];
  detailAvailable?: boolean;
};

export type Message = {
  role: "user" | "assistant";
  text: string;
  accent?: boolean;
  artifact?: MessageArtifact;
};

export type StreamEntry = {
  mood: "spark" | "calm" | "warm";
  time: string;
  text: string;
};

export const CURRENT_SESSION_SCHEMA_VERSION = 5;

export type SessionKind = "default" | "character-authoring";
export const SESSION_ACCESS_MODE_VALUES = ["active", "legacy_readonly"] as const;
export type SessionAccessMode = typeof SESSION_ACCESS_MODE_VALUES[number];

export type Session = {
  id: string;
  taskTitle: string;
  status: "running" | "idle" | "saved";
  updatedAt: string;
  isPinned: boolean;
  provider: string;
  catalogRevision: number;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  sessionKind: SessionKind;
  accessMode: SessionAccessMode;
  sourceSchemaVersion: number;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  characterRuntimeSnapshot: CharacterRuntimeSnapshot | null;
  runState: string;
  approvalMode: ApprovalMode;
  codexSandboxMode: CodexSandboxMode;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  messages: Message[];
  stream: StreamEntry[];
};

export type SessionSummary = Omit<Session, "messages" | "stream" | "characterRuntimeSnapshot" | "isPinned"> & {
  isPinned: boolean;
};
export type SessionDetail = Session;

export type HomeSessionSummary = {
  id: string;
  taskTitle: string;
  status: Session["status"];
  updatedAt: string;
  isPinned: boolean;
  workspaceLabel: string;
  workspacePath: string;
  sessionKind: SessionKind;
  accessMode: SessionAccessMode;
  sourceSchemaVersion: number;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  runState: string;
};

export const SESSION_SUMMARY_PAGE_SCOPES = ["recent", "pinned", "open"] as const;
export type SessionSummaryPageScope = (typeof SESSION_SUMMARY_PAGE_SCOPES)[number];

export type SessionSummaryPageRequest = {
  scope?: SessionSummaryPageScope;
  cursor?: string | null;
  limit?: number | null;
  searchText?: string | null;
  sessionIds?: readonly string[] | null;
};

export type HomeSessionSummaryPageResult = {
  entries: HomeSessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};
export type SessionSummaryPageResult = HomeSessionSummaryPageResult;

export type SessionCharacterUsage = {
  characterId: string;
  sessionKind: "default";
};

export type SessionSummaryInvalidation =
  | { scope: "ids"; sessionIds: string[] }
  | { scope: "all" };

export type DiffPreviewPayload = {
  title: string;
  file: ChangedFile;
  themeColors: CharacterThemeColors;
};

export type CreateSessionInput = {
  id?: string;
  provider?: string;
  catalogRevision?: number;
  taskTitle: string;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  sessionKind?: SessionKind;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  characterRuntimeSnapshot?: CharacterRuntimeSnapshot | null;
  approvalMode: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  customAgentName?: string;
  allowedAdditionalDirectories?: string[];
};

export type CreateSessionWorkspaceRequest =
  | {
      kind: "directory";
      label: string;
      path: string;
      branch: string;
    }
  | {
      kind: "session-folder";
    };

export type CreateSessionRequest = Omit<
  CreateSessionInput,
  | "id"
  | "workspaceLabel"
  | "workspacePath"
  | "branch"
  | "approvalMode"
  | "codexSandboxMode"
  | "model"
  | "reasoningEffort"
  | "customAgentName"
> & {
  workspace: CreateSessionWorkspaceRequest;
};

export type SetSessionPinnedRequest = {
  sessionId: string;
  isPinned: boolean;
};

export function parseSetSessionPinnedRequest(value: unknown): SetSessionPinnedRequest {
  if (!value || typeof value !== "object") {
    throw new Error("ピン止めするセッションの指定が正しくないよ。");
  }
  const candidate = value as Partial<SetSessionPinnedRequest>;
  const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId.trim() : "";
  if (!sessionId || typeof candidate.isPinned !== "boolean") {
    throw new Error("ピン止めするセッションの指定が正しくないよ。");
  }
  return { sessionId, isPinned: candidate.isPinned };
}

export function normalizeSessionAccessMode(value: unknown, fallback: SessionAccessMode = "active"): SessionAccessMode {
  return SESSION_ACCESS_MODE_VALUES.includes(value as SessionAccessMode) ? value as SessionAccessMode : fallback;
}

export function isLegacyReadOnlySession(session: Pick<Session, "accessMode"> | Pick<SessionSummary, "accessMode">): boolean {
  return session.accessMode === "legacy_readonly";
}

export function isReadOnlySession(
  session: Pick<Session, "accessMode" | "sourceSchemaVersion"> | Pick<SessionSummary, "accessMode" | "sourceSchemaVersion">,
): boolean {
  return isLegacyReadOnlySession(session) || session.sourceSchemaVersion < CURRENT_SESSION_SCHEMA_VERSION;
}

function getLocationSearch(): string {
  const browserWindow = (globalThis as typeof globalThis & { window?: { location?: { search?: string } } }).window;
  if (!browserWindow?.location?.search) {
    return "";
  }

  return browserWindow.location.search;
}

function normalizeDiffRow(value: unknown): DiffRow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<DiffRow>;
  if (candidate.kind !== "context" && candidate.kind !== "add" && candidate.kind !== "delete" && candidate.kind !== "modify") {
    return null;
  }

  return {
    kind: candidate.kind,
    leftNumber: typeof candidate.leftNumber === "number" ? candidate.leftNumber : undefined,
    rightNumber: typeof candidate.rightNumber === "number" ? candidate.rightNumber : undefined,
    leftText: typeof candidate.leftText === "string" ? candidate.leftText : undefined,
    rightText: typeof candidate.rightText === "string" ? candidate.rightText : undefined,
  };
}

function normalizeChangedFile(value: unknown): ChangedFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ChangedFile>;
  if (candidate.kind !== "add" && candidate.kind !== "edit" && candidate.kind !== "delete") {
    return null;
  }

  return {
    kind: candidate.kind,
    path: typeof candidate.path === "string" ? candidate.path : "",
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    diffRows: Array.isArray(candidate.diffRows)
      ? candidate.diffRows
          .map((row) => normalizeDiffRow(row))
          .filter((row): row is DiffRow => row !== null)
      : [],
  };
}

function normalizeAuditLogOperation(value: unknown): AuditLogOperation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<AuditLogOperation>;
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    return null;
  }

  return {
    type: candidate.type,
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
    details: typeof candidate.details === "string" ? candidate.details : undefined,
  };
}

function normalizeRunCheckValue(label: string, value: unknown): string {
  const normalizedValue = typeof value === "string" ? value : "";
  return label.trim().toLowerCase() === "approval"
    ? normalizeApprovalMode(normalizedValue, DEFAULT_APPROVAL_MODE)
    : normalizedValue;
}

function normalizeRunCheck(value: unknown): RunCheck | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<RunCheck>;
  if (typeof candidate.label !== "string" || !candidate.label.trim()) {
    return null;
  }

  return {
    label: candidate.label,
    value: normalizeRunCheckValue(candidate.label, candidate.value),
  };
}

function normalizeMessageArtifact(value: unknown): MessageArtifact | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Partial<MessageArtifact>;
  const operationTimeline = Array.isArray(candidate.operationTimeline)
    ? candidate.operationTimeline
        .map((operation) => normalizeAuditLogOperation(operation))
        .filter((operation): operation is AuditLogOperation => operation !== null)
    : undefined;

  return {
    title: typeof candidate.title === "string" ? candidate.title : "",
    activitySummary: Array.isArray(candidate.activitySummary)
      ? candidate.activitySummary.filter((item): item is string => typeof item === "string")
      : [],
    operationTimeline,
    changedFiles: Array.isArray(candidate.changedFiles)
      ? candidate.changedFiles
          .map((file) => normalizeChangedFile(file))
          .filter((file): file is ChangedFile => file !== null)
      : [],
    runChecks: Array.isArray(candidate.runChecks)
      ? candidate.runChecks
          .map((check) => normalizeRunCheck(check))
          .filter((check): check is RunCheck => check !== null)
      : [],
    detailAvailable: typeof candidate.detailAvailable === "boolean" ? candidate.detailAvailable : undefined,
  };
}

export function normalizeMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Message>;
  if (candidate.role !== "user" && candidate.role !== "assistant") {
    return null;
  }

  return {
    role: candidate.role,
    text: typeof candidate.text === "string" ? candidate.text : "",
    accent: typeof candidate.accent === "boolean" ? candidate.accent : undefined,
    artifact: normalizeMessageArtifact(candidate.artifact),
  };
}

function normalizeSessionSummaryShape(value: unknown): SessionSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Session>;
  const characterName = typeof candidate.character === "string" && candidate.character.trim() ? candidate.character : "キャラクター";
  const characterId = recoverStoredCharacterOwnerId(candidate.characterId);

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : `legacy-${Date.now()}`,
    taskTitle:
      typeof candidate.taskTitle === "string" && candidate.taskTitle.trim()
        ? candidate.taskTitle
        : "既存セッション",
    status:
      candidate.status === "running" || candidate.status === "idle" || candidate.status === "saved"
        ? candidate.status
        : "idle",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt === "just now"
          ? currentTimestampLabel()
          : candidate.updatedAt
        : currentTimestampLabel(),
    isPinned: candidate.isPinned === true,
    provider: normalizeProviderId(candidate.provider),
    catalogRevision:
      typeof candidate.catalogRevision === "number" && Number.isInteger(candidate.catalogRevision) && candidate.catalogRevision > 0
        ? candidate.catalogRevision
        : DEFAULT_CATALOG_REVISION,
    workspaceLabel:
      typeof candidate.workspaceLabel === "string" && candidate.workspaceLabel.trim()
        ? candidate.workspaceLabel
        : "workspace",
    workspacePath: typeof candidate.workspacePath === "string" ? candidate.workspacePath : "",
    branch: typeof candidate.branch === "string" && candidate.branch.trim() ? candidate.branch : "main",
    sessionKind: candidate.sessionKind === "character-authoring" ? candidate.sessionKind : "default",
    accessMode: normalizeSessionAccessMode((candidate as { accessMode?: unknown }).accessMode),
    sourceSchemaVersion:
      typeof candidate.sourceSchemaVersion === "number" &&
      Number.isInteger(candidate.sourceSchemaVersion) &&
      candidate.sourceSchemaVersion > 0
        ? candidate.sourceSchemaVersion
        : CURRENT_SESSION_SCHEMA_VERSION - 1,
    characterId,
    character: characterName,
    characterIconPath:
      typeof candidate.characterIconPath === "string" && candidate.characterIconPath.trim()
        ? candidate.characterIconPath
        : "",
    characterThemeColors: normalizeCharacterThemeColors(candidate.characterThemeColors),
    runState: typeof candidate.runState === "string" && candidate.runState.trim() ? candidate.runState : "idle",
    approvalMode: normalizeApprovalMode(candidate.approvalMode, DEFAULT_APPROVAL_MODE),
    codexSandboxMode: normalizeCodexSandboxMode(
      (candidate as { codexSandboxMode?: unknown }).codexSandboxMode,
      DEFAULT_CODEX_SANDBOX_MODE,
    ),
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort: isModelReasoningEffort(candidate.reasoningEffort)
      ? candidate.reasoningEffort
      : DEFAULT_REASONING_EFFORT,
    customAgentName: typeof candidate.customAgentName === "string" ? candidate.customAgentName.trim() : "",
    allowedAdditionalDirectories: Array.isArray((candidate as { allowedAdditionalDirectories?: unknown[] }).allowedAdditionalDirectories)
      ? (candidate as { allowedAdditionalDirectories?: unknown[] }).allowedAdditionalDirectories
          ?.filter((directory): directory is string => typeof directory === "string")
          .map((directory) => directory.trim())
          .filter((directory) => directory.length > 0) ?? []
      : [],
    threadId: isUnknownCharacterOwnerId(characterId)
      ? ""
      : typeof candidate.threadId === "string"
        ? candidate.threadId
        : typeof (candidate as { threadLabel?: string }).threadLabel === "string"
          ? (candidate as { threadLabel?: string }).threadLabel ?? ""
          : "",
  };
}

export function normalizeSessionSummary(value: unknown): SessionSummary | null {
  return normalizeSessionSummaryShape(value);
}

function normalizeHomeSessionSummaryShape(value: unknown): HomeSessionSummary | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<HomeSessionSummary>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!id) {
    return null;
  }

  const characterName = typeof candidate.character === "string" && candidate.character.trim()
    ? candidate.character
    : "キャラクター";
  return {
    id,
    taskTitle:
      typeof candidate.taskTitle === "string" && candidate.taskTitle.trim()
        ? candidate.taskTitle
        : "既存セッション",
    status:
      candidate.status === "running" || candidate.status === "idle" || candidate.status === "saved"
        ? candidate.status
        : "idle",
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt === "just now"
          ? currentTimestampLabel()
          : candidate.updatedAt
        : currentTimestampLabel(),
    isPinned: candidate.isPinned === true,
    workspaceLabel:
      typeof candidate.workspaceLabel === "string" && candidate.workspaceLabel.trim()
        ? candidate.workspaceLabel
        : "workspace",
    workspacePath: typeof candidate.workspacePath === "string" ? candidate.workspacePath : "",
    sessionKind: candidate.sessionKind === "character-authoring" ? candidate.sessionKind : "default",
    accessMode: normalizeSessionAccessMode(candidate.accessMode),
    sourceSchemaVersion:
      typeof candidate.sourceSchemaVersion === "number" &&
      Number.isInteger(candidate.sourceSchemaVersion) &&
      candidate.sourceSchemaVersion > 0
        ? candidate.sourceSchemaVersion
        : CURRENT_SESSION_SCHEMA_VERSION - 1,
    characterId: recoverStoredCharacterOwnerId(candidate.characterId),
    character: characterName,
    characterIconPath:
      typeof candidate.characterIconPath === "string" && candidate.characterIconPath.trim()
        ? candidate.characterIconPath
        : "",
    characterThemeColors: normalizeCharacterThemeColors(candidate.characterThemeColors),
    runState: typeof candidate.runState === "string" && candidate.runState.trim() ? candidate.runState : "idle",
  };
}

export function normalizeHomeSessionSummary(value: unknown): HomeSessionSummary | null {
  return normalizeHomeSessionSummaryShape(value);
}

export function projectHomeSessionSummary(session: Session | SessionSummary | HomeSessionSummary): HomeSessionSummary {
  const summary = normalizeHomeSessionSummaryShape(session);
  if (!summary) {
    throw new Error("Home session summary へ変換できない session 形式だよ。");
  }

  return summary;
}

export function projectSessionSummary(session: Session | SessionSummary): SessionSummary {
  const summary = normalizeSessionSummaryShape(session);
  if (!summary) {
    throw new Error("session summary へ変換できない session 形式だよ。");
  }

  return summary;
}

export function normalizeSession(value: unknown): Session | null {
  const summary = normalizeSessionSummaryShape(value);
  if (!summary || !value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<Session>;
  const storedSnapshot = (candidate as { characterRuntimeSnapshot?: unknown }).characterRuntimeSnapshot;
  const normalizedSnapshot = normalizeCharacterRuntimeSnapshot(storedSnapshot);
  const rejectedStoredSnapshot = storedSnapshot !== undefined
    && storedSnapshot !== null
    && (!normalizedSnapshot || normalizedSnapshot.characterId !== summary.characterId);
  const characterRuntimeSnapshot = rejectedStoredSnapshot ? null : normalizedSnapshot;

  return {
    ...summary,
    threadId: rejectedStoredSnapshot ? "" : summary.threadId,
    characterRuntimeSnapshot,
    messages: Array.isArray(candidate.messages)
      ? candidate.messages
          .map((message) => normalizeMessage(message))
          .filter((message): message is Message => message !== null)
      : [],
    stream: Array.isArray(candidate.stream) ? candidate.stream : [],
  };
}

export function cloneSessions(sessions: Session[]): Session[] {
  return JSON.parse(JSON.stringify(sessions)) as Session[];
}

export function cloneSessionSummaries(sessions: SessionSummary[]): SessionSummary[] {
  return JSON.parse(JSON.stringify(sessions)) as SessionSummary[];
}

export function cloneHomeSessionSummaries(sessions: HomeSessionSummary[]): HomeSessionSummary[] {
  return JSON.parse(JSON.stringify(sessions.map((session) => projectHomeSessionSummary(session)))) as HomeSessionSummary[];
}

function artifactSummaryText(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value;
}

export function summarizeMessageArtifact(artifact: MessageArtifact): MessageArtifact {
  return {
    title: artifactSummaryText(artifact.title),
    activitySummary: artifact.activitySummary.map(artifactSummaryText),
    operationTimeline: artifact.operationTimeline?.map((operation) => ({
      type: operation.type,
      summary: artifactSummaryText(operation.summary),
    })),
    changedFiles: artifact.changedFiles.map((file) => ({
      kind: file.kind,
      path: artifactSummaryText(file.path),
      summary: artifactSummaryText(file.summary),
      diffRows: [],
    })),
    runChecks: artifact.runChecks.map((check) => ({ ...check })),
    detailAvailable: true,
  };
}

export function buildNewSession(input: CreateSessionInput): Session {
  const normalizedTaskTitle = input.taskTitle.trim() || `${input.workspaceLabel} で新規作業を開始する`;
  const characterId = requireCharacterOwnerId(input.characterId);
  const characterRuntimeSnapshot = input.characterRuntimeSnapshot == null
    ? null
    : normalizeCharacterRuntimeSnapshot(input.characterRuntimeSnapshot);
  if (input.characterRuntimeSnapshot != null && !characterRuntimeSnapshot) {
    throw new Error("characterRuntimeSnapshot の形式が正しくないよ。");
  }
  if (characterRuntimeSnapshot && characterRuntimeSnapshot.characterId !== characterId) {
    throw new Error("characterRuntimeSnapshot.characterId が characterId と一致しないよ。");
  }
  return {
    id: input.id?.trim() || `launch-${Date.now()}`,
    taskTitle: normalizedTaskTitle,
    status: "idle",
    updatedAt: currentTimestampLabel(),
    isPinned: false,
    provider: normalizeProviderId(input.provider ?? DEFAULT_PROVIDER_ID),
    catalogRevision:
      typeof input.catalogRevision === "number" && Number.isInteger(input.catalogRevision) && input.catalogRevision > 0
        ? input.catalogRevision
        : DEFAULT_CATALOG_REVISION,
    workspaceLabel: input.workspaceLabel,
    workspacePath: input.workspacePath,
    branch: input.branch,
    sessionKind: input.sessionKind ?? "default",
    accessMode: "active",
    sourceSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    characterId,
    character: input.character,
    characterIconPath: input.characterIconPath,
    characterThemeColors: normalizeCharacterThemeColors(input.characterThemeColors),
    characterRuntimeSnapshot,
    runState: "idle",
    approvalMode: normalizeApprovalMode(input.approvalMode, DEFAULT_APPROVAL_MODE),
    codexSandboxMode: normalizeCodexSandboxMode(input.codexSandboxMode, DEFAULT_CODEX_SANDBOX_MODE),
    model: input.model?.trim() || DEFAULT_MODEL_ID,
    reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    customAgentName: input.customAgentName?.trim() || "",
    allowedAdditionalDirectories: Array.isArray(input.allowedAdditionalDirectories)
      ? input.allowedAdditionalDirectories.map((directory) => directory.trim()).filter((directory) => directory.length > 0)
      : [],
    threadId: "",
    messages: [],
    stream: [],
  };
}

export function applySessionModelMetadataUpdate(
  session: Session,
  selection: ResolvedModelSelection,
  catalogRevision: number,
  updatedAt: string,
): Session {
  return {
    ...session,
    catalogRevision,
    model: selection.resolvedModel,
    reasoningEffort: selection.resolvedReasoningEffort,
    threadId: session.threadId,
    updatedAt,
  };
}

export function applySessionModelSelection(
  session: Session,
  selection: ResolvedModelSelection,
  catalogRevision: number,
  updatedAt: string,
): Session {
  return applySessionModelMetadataUpdate(session, selection, catalogRevision, updatedAt);
}

export function applyCopilotCustomAgentSelection(
  session: Session,
  customAgentName: string,
  updatedAt: string,
): Session {
  return {
    ...session,
    customAgentName: customAgentName.trim(),
    threadId: session.threadId,
    updatedAt,
  };
}

export function getSessionIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("sessionId");
}

export function getDiffTokenFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("token");
}

/**
 * Summary フィールドすべてを連結した文字列を返す。
 * 同一 session でも何らかのフィールドが変われば異なる値になる。
 * `Session` の detail フィールド（messages / stream）は含まない。
 */
export function buildSessionSummarySignature(summary: SessionSummary): string {
  return [
    summary.id,
    summary.updatedAt,
    String(summary.isPinned),
    summary.status,
    summary.runState,
    summary.taskTitle,
    summary.threadId,
    summary.provider,
    String(summary.catalogRevision),
    summary.model,
    summary.reasoningEffort,
    summary.approvalMode,
    summary.codexSandboxMode,
    summary.workspacePath,
    summary.branch,
    summary.sessionKind,
    summary.accessMode,
    String(summary.sourceSchemaVersion),
    summary.characterId,
    summary.character,
    summary.characterIconPath,
    summary.characterThemeColors.main,
    summary.characterThemeColors.sub,
    summary.workspaceLabel,
    summary.customAgentName,
    summary.allowedAdditionalDirectories.join("\u001f"),
  ].join("\u001e");
}

/**
 * 次の summary 一覧・対象 ID・直前の signature を受け取り、
 * detail hydrate が必要かどうかを判定する純粋ヘルパー。
 *
 * - `targetSessionId` が null または一覧に存在しない → null（hydrate 不要）
 * - `lastSummarySignature` が null（初回）→ hydrate 対象を返す
 * - summary が変わっていない → null（hydrate 不要）
 * - summary が変わった → hydrate 対象を返す
 */
export type HydrationTarget = {
  sessionId: string;
  summarySignature: string;
};

export function selectHydrationTarget(
  nextSummaries: SessionSummary[],
  targetSessionId: string | null,
  lastSummarySignature: string | null,
): HydrationTarget | null {
  if (!targetSessionId) {
    return null;
  }

  const matchedSummary = nextSummaries.find((s) => s.id === targetSessionId);
  if (!matchedSummary) {
    return null;
  }

  const nextSignature = buildSessionSummarySignature(matchedSummary);
  if (lastSummarySignature !== null && nextSignature === lastSummarySignature) {
    return null;
  }

  return { sessionId: targetSessionId, summarySignature: nextSignature };
}
