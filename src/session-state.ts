import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "./approval-mode.js";
import {
  DEFAULT_CODEX_SANDBOX_MODE,
  normalizeCodexSandboxMode,
  type CodexSandboxMode,
} from "./codex-sandbox-mode.js";
import { normalizeCharacterThemeColors, type CharacterThemeColors } from "./character-state.js";
import {
  DEFAULT_CATALOG_REVISION,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
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

export type SessionKind = "default" | "character-update";

export type Session = {
  id: string;
  taskTitle: string;
  taskSummary: string;
  status: "running" | "idle" | "saved";
  updatedAt: string;
  provider: string;
  catalogRevision: number;
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  sessionKind: SessionKind;
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
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

export type SessionSummary = Omit<Session, "messages" | "stream">;
export type SessionDetail = Session;

export type DiffPreviewPayload = {
  title: string;
  file: ChangedFile;
  themeColors: CharacterThemeColors;
};

export type CreateSessionInput = {
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
  approvalMode: ApprovalMode;
  codexSandboxMode?: CodexSandboxMode;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  customAgentName?: string;
  allowedAdditionalDirectories?: string[];
};

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
  };
}

function normalizeMessage(value: unknown): Message | null {
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

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : `legacy-${Date.now()}`,
    taskTitle:
      typeof candidate.taskTitle === "string" && candidate.taskTitle.trim()
        ? candidate.taskTitle
        : typeof candidate.taskSummary === "string" && candidate.taskSummary.trim()
          ? candidate.taskSummary
          : "既存セッション",
    taskSummary: typeof candidate.taskSummary === "string" ? candidate.taskSummary : "",
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
    sessionKind: candidate.sessionKind === "character-update" ? "character-update" : "default",
    characterId:
      typeof candidate.characterId === "string" && candidate.characterId.trim()
        ? candidate.characterId
        : typeof candidate.character === "string" && candidate.character.trim()
          ? candidate.character.trim()
          : "unknown-character",
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
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
    customAgentName: typeof candidate.customAgentName === "string" ? candidate.customAgentName.trim() : "",
    allowedAdditionalDirectories: Array.isArray((candidate as { allowedAdditionalDirectories?: unknown[] }).allowedAdditionalDirectories)
      ? (candidate as { allowedAdditionalDirectories?: unknown[] }).allowedAdditionalDirectories
          ?.filter((directory): directory is string => typeof directory === "string")
          .map((directory) => directory.trim())
          .filter((directory) => directory.length > 0) ?? []
      : [],
    threadId:
      typeof candidate.threadId === "string"
        ? candidate.threadId
        : typeof (candidate as { threadLabel?: string }).threadLabel === "string"
          ? (candidate as { threadLabel?: string }).threadLabel ?? ""
          : "",
  };
}

export function normalizeSessionSummary(value: unknown): SessionSummary | null {
  return normalizeSessionSummaryShape(value);
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
  return {
    ...summary,
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

export function buildNewSession(input: CreateSessionInput): Session {
  const normalizedTaskTitle = input.taskTitle.trim() || `${input.workspaceLabel} で新規作業を開始する`;
  return {
    id: `launch-${Date.now()}`,
    taskTitle: normalizedTaskTitle,
    taskSummary: `${input.workspaceLabel} で新規セッションを開始。${input.character} のロールを保ったまま、ここから最初の指示を待つ。`,
    status: "idle",
    updatedAt: currentTimestampLabel(),
    provider: normalizeProviderId(input.provider ?? DEFAULT_PROVIDER_ID),
    catalogRevision:
      typeof input.catalogRevision === "number" && Number.isInteger(input.catalogRevision) && input.catalogRevision > 0
        ? input.catalogRevision
        : DEFAULT_CATALOG_REVISION,
    workspaceLabel: input.workspaceLabel,
    workspacePath: input.workspacePath,
    branch: input.branch,
    sessionKind: input.sessionKind ?? "default",
    characterId: input.characterId,
    character: input.character,
    characterIconPath: input.characterIconPath,
    characterThemeColors: normalizeCharacterThemeColors(input.characterThemeColors),
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
    summary.status,
    summary.runState,
    summary.taskTitle,
    summary.taskSummary,
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
