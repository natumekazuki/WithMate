import {
  DEFAULT_CATALOG_REVISION,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  normalizeProviderId,
  type ModelReasoningEffort,
} from "./model-catalog.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "./approval-mode.js";

export type DiffRow = {
  kind: "context" | "add" | "delete" | "modify";
  leftNumber?: number;
  rightNumber?: number;
  leftText?: string;
  rightText?: string;
};

export type ChangedFile = {
  kind: "add" | "edit" | "delete";
  path: string;
  summary: string;
  diffRows: DiffRow[];
};

export type RunCheck = {
  label: string;
  value: string;
};

export type AuditLogPhase = "running" | "completed" | "failed" | "canceled" | "started";

export type AuditLogOperation = {
  type: string;
  summary: string;
  details?: string;
};

export type AuditLogUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AuditLogicalPrompt = {
  systemText: string;
  inputText: string;
  composedText: string;
};

export type AuditTransportField = {
  label: string;
  value: string;
};

export type AuditTransportPayload = {
  summary: string;
  fields: AuditTransportField[];
};

export type AuditLogEntry = {
  id: number;
  sessionId: string;
  createdAt: string;
  phase: AuditLogPhase;
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: ApprovalMode;
  threadId: string;
  logicalPrompt: AuditLogicalPrompt;
  transportPayload: AuditTransportPayload | null;
  assistantText: string;
  operations: AuditLogOperation[];
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  errorMessage: string;
};

export type LiveRunStepStatus = "in_progress" | "completed" | "failed" | "canceled" | "pending" | (string & {});

export type LiveRunStep = {
  id: string;
  type: string;
  summary: string;
  details?: string;
  status: LiveRunStepStatus;
};

export type LiveApprovalDecision = "approve" | "deny";

export type LiveApprovalDecisionMode = "direct-decision" | "retry-with-policy-change";

export type LiveApprovalRequest = {
  requestId: string;
  provider: string;
  kind: string;
  title: string;
  summary: string;
  details?: string;
  warning?: string;
  decisionMode: LiveApprovalDecisionMode;
};

export type LiveSessionRunState = {
  sessionId: string;
  threadId: string;
  assistantText: string;
  steps: LiveRunStep[];
  usage: AuditLogUsage | null;
  errorMessage: string;
  approvalRequest: LiveApprovalRequest | null;
};

export type ProviderQuotaSnapshot = {
  quotaKey: string;
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
};

export type ProviderQuotaTelemetry = {
  provider: string;
  updatedAt: string;
  snapshots: ProviderQuotaSnapshot[];
};

export type SessionContextTelemetry = {
  provider: string;
  sessionId: string;
  updatedAt: string;
  tokenLimit: number;
  currentTokens: number;
  messagesLength: number;
  systemTokens?: number;
  conversationTokens?: number;
  toolDefinitionsTokens?: number;
};

export type AppSettings = {
  systemPromptPrefix: string;
  codingProviderSettings: Record<string, ProviderAppSettings>;
  memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings>;
};

export type ProviderAppSettings = {
  enabled: boolean;
  apiKey: string;
  skillRootPath: string;
};

export type MemoryExtractionProviderSettings = {
  model: string;
  reasoningEffort: ModelReasoningEffort;
  outputTokensThreshold: number;
};

export type DiscoveredSkillSource = "workspace" | "provider";

export type DiscoveredSkill = {
  id: string;
  name: string;
  description: string;
  source: DiscoveredSkillSource;
  sourcePath: string;
  sourceLabel: string;
};

export type DiscoveredCustomAgentSource = "workspace" | "global";

export type DiscoveredCustomAgent = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  source: DiscoveredCustomAgentSource;
  sourcePath: string;
  sourceLabel: string;
};

export type ComposerAttachmentKind = "file" | "folder" | "image";

export type ComposerAttachmentSource = "text";

export type ComposerAttachmentInput = {
  path: string;
  source: ComposerAttachmentSource;
  kind?: ComposerAttachmentKind;
};

export type ComposerAttachment = {
  id: string;
  kind: ComposerAttachmentKind;
  source: ComposerAttachmentSource;
  absolutePath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  isOutsideWorkspace: boolean;
};

export type ComposerPreview = {
  attachments: ComposerAttachment[];
  errors: string[];
};

export type RunSessionTurnRequest = {
  userMessage: string;
};

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

export type CharacterVisual = {
  name: string;
  iconPath: string;
};

export type CharacterThemeColors = {
  main: string;
  sub: string;
};

export type CharacterSessionCopy = {
  pendingApproval: string[];
  pendingWorking: string[];
  pendingResponding: string[];
  pendingPreparing: string[];
  retryInterruptedTitle: string[];
  retryFailedTitle: string[];
  retryCanceledTitle: string[];
  latestCommandWaiting: string[];
  latestCommandEmpty: string[];
  changedFilesEmpty: string[];
  contextEmpty: string[];
};

export type CharacterCatalogItem = CharacterVisual & {
  id: string;
};

export type CharacterProfile = CharacterCatalogItem & {
  description: string;
  roleMarkdown: string;
  updatedAt: string;
  themeColors: CharacterThemeColors;
  sessionCopy: CharacterSessionCopy;
};

export type CreateCharacterInput = {
  name: string;
  iconPath: string;
  description: string;
  roleMarkdown: string;
  themeColors: CharacterThemeColors;
  sessionCopy: CharacterSessionCopy;
};

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
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  runState: string;
  approvalMode: ApprovalMode;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  customAgentName: string;
  allowedAdditionalDirectories: string[];
  threadId: string;
  messages: Message[];
  stream: StreamEntry[];
};

export type SessionMemory = {
  sessionId: string;
  workspacePath: string;
  threadId: string;
  schemaVersion: 1;
  goal: string;
  decisions: string[];
  openQuestions: string[];
  nextActions: string[];
  notes: string[];
  updatedAt: string;
};

export type SessionMemoryDelta = {
  goal?: string | null;
  decisions?: string[];
  openQuestions?: string[];
  nextActions?: string[];
  notes?: string[];
};

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
  characterId: string;
  character: string;
  characterIconPath: string;
  characterThemeColors: CharacterThemeColors;
  approvalMode: ApprovalMode;
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

export function makeDiffRows(
  rows: Array<[DiffRow["kind"], number | undefined, string | undefined, number | undefined, string | undefined]>,
): DiffRow[] {
  return rows.map(([kind, leftNumber, leftText, rightNumber, rightText]) => ({
    kind,
    leftNumber,
    leftText,
    rightNumber,
    rightText,
  }));
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimestampLabel(value: Date | string | number): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return typeof value === "string" && value.trim() ? value : "";
  }

  const year = timestamp.getFullYear();
  const month = padDatePart(timestamp.getMonth() + 1);
  const day = padDatePart(timestamp.getDate());
  const hours = padDatePart(timestamp.getHours());
  const minutes = padDatePart(timestamp.getMinutes());
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

export function currentTimestampLabel(): string {
  return formatTimestampLabel(new Date());
}

export function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

export const DEFAULT_CHARACTER_THEME_COLORS: CharacterThemeColors = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

export const DEFAULT_CHARACTER_SESSION_COPY: CharacterSessionCopy = {
  pendingApproval: ["承認を待機中"],
  pendingWorking: ["処理を実行中"],
  pendingResponding: ["応答を生成中"],
  pendingPreparing: ["応答を準備中"],
  retryInterruptedTitle: ["前回の依頼は中断されたままです"],
  retryFailedTitle: ["前回の依頼は完了できませんでした"],
  retryCanceledTitle: ["この依頼は途中で停止しました"],
  latestCommandWaiting: ["最初の command を待機中"],
  latestCommandEmpty: ["直近 run の command 記録はありません"],
  changedFilesEmpty: ["ファイル変更はありません"],
  contextEmpty: ["context usage はまだありません"],
};

export function cloneCharacterSessionCopy(copy: CharacterSessionCopy): CharacterSessionCopy {
  return {
    pendingApproval: [...copy.pendingApproval],
    pendingWorking: [...copy.pendingWorking],
    pendingResponding: [...copy.pendingResponding],
    pendingPreparing: [...copy.pendingPreparing],
    retryInterruptedTitle: [...copy.retryInterruptedTitle],
    retryFailedTitle: [...copy.retryFailedTitle],
    retryCanceledTitle: [...copy.retryCanceledTitle],
    latestCommandWaiting: [...copy.latestCommandWaiting],
    latestCommandEmpty: [...copy.latestCommandEmpty],
    changedFilesEmpty: [...copy.changedFilesEmpty],
    contextEmpty: [...copy.contextEmpty],
  };
}

export const DEFAULT_PROVIDER_APP_SETTINGS: ProviderAppSettings = {
  enabled: false,
  apiKey: "",
  skillRootPath: "",
};

export const DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD = 200;

export const DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS: MemoryExtractionProviderSettings = {
  model: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  outputTokensThreshold: DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
};

export function createDefaultAppSettings(): AppSettings {
  return {
    systemPromptPrefix: "",
    codingProviderSettings: {
      [DEFAULT_PROVIDER_ID]: {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
      },
    },
    memoryExtractionProviderSettings: {
      [DEFAULT_PROVIDER_ID]: { ...DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS },
    },
  };
}

function normalizeProviderAppSettings(value: unknown, defaultEnabled: boolean): ProviderAppSettings {
  if (!value || typeof value !== "object") {
    return {
      enabled: defaultEnabled,
      apiKey: "",
      skillRootPath: "",
    };
  }

  const candidate = value as Partial<ProviderAppSettings>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaultEnabled,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    skillRootPath: typeof candidate.skillRootPath === "string" ? candidate.skillRootPath : "",
  };
}

function normalizeOutputTokensThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1) {
    return 1;
  }

  if (normalized > 100_000) {
    return 100_000;
  }

  return normalized;
}

function normalizeMemoryExtractionProviderSettings(value: unknown): MemoryExtractionProviderSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_MEMORY_EXTRACTION_PROVIDER_SETTINGS };
  }

  const candidate = value as Partial<MemoryExtractionProviderSettings>;
  return {
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
    outputTokensThreshold: normalizeOutputTokensThreshold(candidate.outputTokensThreshold),
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const defaults = createDefaultAppSettings();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const candidate = value as Partial<AppSettings>;
  const rawCodingProviderSettings =
    candidate.codingProviderSettings && typeof candidate.codingProviderSettings === "object"
      ? candidate.codingProviderSettings
      : null;
  const rawMemoryExtractionProviderSettings =
    candidate.memoryExtractionProviderSettings && typeof candidate.memoryExtractionProviderSettings === "object"
      ? candidate.memoryExtractionProviderSettings
      : null;
  const codingProviderSettings: Record<string, ProviderAppSettings> = {};
  const memoryExtractionProviderSettings: Record<string, MemoryExtractionProviderSettings> = {};
  if (rawCodingProviderSettings) {
    for (const [providerId, providerSettingsValue] of Object.entries(rawCodingProviderSettings)) {
      const normalizedProviderId = normalizeProviderId(providerId);
      codingProviderSettings[normalizedProviderId] = normalizeProviderAppSettings(
        providerSettingsValue,
        normalizedProviderId === DEFAULT_PROVIDER_ID,
      );
    }
  }
  if (rawMemoryExtractionProviderSettings) {
    for (const [providerId, providerSettingsValue] of Object.entries(rawMemoryExtractionProviderSettings)) {
      const normalizedProviderId = normalizeProviderId(providerId);
      memoryExtractionProviderSettings[normalizedProviderId] = normalizeMemoryExtractionProviderSettings(providerSettingsValue);
    }
  }

  if (!codingProviderSettings[DEFAULT_PROVIDER_ID]) {
    codingProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.codingProviderSettings[DEFAULT_PROVIDER_ID] };
  }
  if (!memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID]) {
    memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID] = { ...defaults.memoryExtractionProviderSettings[DEFAULT_PROVIDER_ID] };
  }

  return {
    systemPromptPrefix: typeof candidate.systemPromptPrefix === "string" ? candidate.systemPromptPrefix : "",
    codingProviderSettings,
    memoryExtractionProviderSettings,
  };
}

export function getProviderAppSettings(settings: AppSettings, providerId: string | null | undefined): ProviderAppSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeProviderAppSettings(
    resolvedSettings.codingProviderSettings[normalizedProviderId],
    normalizedProviderId === DEFAULT_PROVIDER_ID,
  );
}

export function getMemoryExtractionProviderSettings(
  settings: AppSettings,
  providerId: string | null | undefined,
): MemoryExtractionProviderSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeMemoryExtractionProviderSettings(
    resolvedSettings.memoryExtractionProviderSettings[normalizedProviderId],
  );
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return fallback;
  }

  return normalized.toLowerCase();
}

export function normalizeCharacterThemeColors(value: unknown): CharacterThemeColors {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CHARACTER_THEME_COLORS };
  }

  const candidate = value as Partial<CharacterThemeColors>;
  return {
    main: normalizeHexColor(candidate.main, DEFAULT_CHARACTER_THEME_COLORS.main),
    sub: normalizeHexColor(candidate.sub, DEFAULT_CHARACTER_THEME_COLORS.sub),
  };
}

function normalizeCharacterSessionCopyValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : [...fallback];
  }

  if (typeof value === "string") {
    const normalized = value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : [...fallback];
  }

  return [...fallback];
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

export function normalizeCharacterSessionCopy(value: unknown): CharacterSessionCopy {
  if (!value || typeof value !== "object") {
    return cloneCharacterSessionCopy(DEFAULT_CHARACTER_SESSION_COPY);
  }

  const candidate = value as Partial<CharacterSessionCopy>;
  return {
    pendingApproval: normalizeCharacterSessionCopyValue(candidate.pendingApproval, DEFAULT_CHARACTER_SESSION_COPY.pendingApproval),
    pendingWorking: normalizeCharacterSessionCopyValue(candidate.pendingWorking, DEFAULT_CHARACTER_SESSION_COPY.pendingWorking),
    pendingResponding: normalizeCharacterSessionCopyValue(candidate.pendingResponding, DEFAULT_CHARACTER_SESSION_COPY.pendingResponding),
    pendingPreparing: normalizeCharacterSessionCopyValue(candidate.pendingPreparing, DEFAULT_CHARACTER_SESSION_COPY.pendingPreparing),
    retryInterruptedTitle: normalizeCharacterSessionCopyValue(candidate.retryInterruptedTitle, DEFAULT_CHARACTER_SESSION_COPY.retryInterruptedTitle),
    retryFailedTitle: normalizeCharacterSessionCopyValue(candidate.retryFailedTitle, DEFAULT_CHARACTER_SESSION_COPY.retryFailedTitle),
    retryCanceledTitle: normalizeCharacterSessionCopyValue(candidate.retryCanceledTitle, DEFAULT_CHARACTER_SESSION_COPY.retryCanceledTitle),
    latestCommandWaiting: normalizeCharacterSessionCopyValue(candidate.latestCommandWaiting, DEFAULT_CHARACTER_SESSION_COPY.latestCommandWaiting),
    latestCommandEmpty: normalizeCharacterSessionCopyValue(candidate.latestCommandEmpty, DEFAULT_CHARACTER_SESSION_COPY.latestCommandEmpty),
    changedFilesEmpty: normalizeCharacterSessionCopyValue(candidate.changedFilesEmpty, DEFAULT_CHARACTER_SESSION_COPY.changedFilesEmpty),
    contextEmpty: normalizeCharacterSessionCopyValue(candidate.contextEmpty, DEFAULT_CHARACTER_SESSION_COPY.contextEmpty),
  };
}

export function createDefaultSessionMemory(input: Pick<Session, "id" | "workspacePath" | "threadId" | "taskTitle" | "taskSummary">): SessionMemory {
  const goal = input.taskTitle.trim() || input.taskSummary.trim();
  return {
    sessionId: input.id,
    workspacePath: input.workspacePath,
    threadId: input.threadId,
    schemaVersion: 1,
    goal,
    decisions: [],
    openQuestions: [],
    nextActions: [],
    notes: [],
    updatedAt: currentIsoTimestamp(),
  };
}

export function normalizeSessionMemory(value: unknown): SessionMemory | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<SessionMemory>;
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim()) {
    return null;
  }

  return {
    sessionId: candidate.sessionId.trim(),
    workspacePath: typeof candidate.workspacePath === "string" ? candidate.workspacePath : "",
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
    schemaVersion: 1,
    goal: typeof candidate.goal === "string" ? candidate.goal.trim() : "",
    decisions: normalizeStringList(candidate.decisions),
    openQuestions: normalizeStringList(candidate.openQuestions),
    nextActions: normalizeStringList(candidate.nextActions),
    notes: normalizeStringList(candidate.notes),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
  };
}

export function normalizeSessionMemoryDelta(value: unknown): SessionMemoryDelta {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = value as Partial<SessionMemoryDelta>;
  return {
    goal:
      typeof candidate.goal === "string"
        ? candidate.goal.trim()
        : candidate.goal === null
          ? null
          : undefined,
    decisions: Array.isArray(candidate.decisions) ? normalizeStringList(candidate.decisions) : undefined,
    openQuestions: Array.isArray(candidate.openQuestions) ? normalizeStringList(candidate.openQuestions) : undefined,
    nextActions: Array.isArray(candidate.nextActions) ? normalizeStringList(candidate.nextActions) : undefined,
    notes: Array.isArray(candidate.notes) ? normalizeStringList(candidate.notes) : undefined,
  };
}

export function mergeSessionMemory(current: SessionMemory, delta: SessionMemoryDelta): SessionMemory {
  const normalizedDelta = normalizeSessionMemoryDelta(delta);
  return {
    ...current,
    goal: normalizedDelta.goal === undefined ? current.goal : normalizedDelta.goal ?? "",
    decisions: normalizedDelta.decisions ?? current.decisions,
    openQuestions: normalizedDelta.openQuestions ?? current.openQuestions,
    nextActions: normalizedDelta.nextActions ?? current.nextActions,
    notes: normalizedDelta.notes ?? current.notes,
    updatedAt: currentIsoTimestamp(),
  };
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

export function normalizeSession(value: unknown): Session | null {
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

export function cloneCharacterProfiles(characters: CharacterProfile[]): CharacterProfile[] {
  return JSON.parse(JSON.stringify(characters)) as CharacterProfile[];
}

export function getCharacterProfile(characterId: string, characters: CharacterProfile[]): CharacterProfile | null {
  return cloneCharacterProfiles(characters).find((character) => character.id === characterId) ?? null;
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
    characterId: input.characterId,
    character: input.character,
    characterIconPath: input.characterIconPath,
    characterThemeColors: normalizeCharacterThemeColors(input.characterThemeColors),
    runState: "idle",
    approvalMode: normalizeApprovalMode(input.approvalMode, DEFAULT_APPROVAL_MODE),
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

export function buildCharacterEditorUrl(characterId?: string | null): string {
  if (!characterId) {
    return "./character.html?mode=create";
  }

  return `./character.html?characterId=${encodeURIComponent(characterId)}`;
}

export function getSessionIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("sessionId");
}

export function getCharacterIdFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("characterId");
}

export function getDiffTokenFromLocation(): string | null {
  return new URLSearchParams(getLocationSearch()).get("token");
}

export function isCharacterCreateMode(): boolean {
  return new URLSearchParams(getLocationSearch()).get("mode") === "create";
}
