import {
  DEFAULT_CATALOG_REVISION,
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  DEFAULT_REASONING_EFFORT,
  normalizeProviderId,
  type ModelReasoningEffort,
} from "./model-catalog.js";

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

export type AuditLogEntry = {
  id: number;
  sessionId: string;
  createdAt: string;
  phase: AuditLogPhase;
  provider: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  approvalMode: string;
  threadId: string;
  systemPromptText: string;
  inputPromptText: string;
  composedPromptText: string;
  assistantText: string;
  operations: AuditLogOperation[];
  rawItemsJson: string;
  usage: AuditLogUsage | null;
  errorMessage: string;
};

export type LiveRunStep = {
  id: string;
  type: string;
  summary: string;
  details?: string;
  status: "in_progress" | "completed" | "failed";
};

export type LiveSessionRunState = {
  sessionId: string;
  threadId: string;
  assistantText: string;
  steps: LiveRunStep[];
  usage: AuditLogUsage | null;
  errorMessage: string;
};

export type AppSettings = {
  systemPromptPrefix: string;
  providerSettings: Record<string, ProviderAppSettings>;
};

export type ProviderAppSettings = {
  enabled: boolean;
  apiKey: string;
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

export type CharacterCatalogItem = CharacterVisual & {
  id: string;
};

export type CharacterProfile = CharacterCatalogItem & {
  description: string;
  roleMarkdown: string;
  updatedAt: string;
  themeColors: CharacterThemeColors;
};

export type CreateCharacterInput = {
  name: string;
  iconPath: string;
  description: string;
  roleMarkdown: string;
  themeColors: CharacterThemeColors;
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
  approvalMode: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  threadId: string;
  messages: Message[];
  stream: StreamEntry[];
};

export type DiffPreviewPayload = {
  title: string;
  file: ChangedFile;
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
  approvalMode: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
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

export const DEFAULT_CHARACTER_THEME_COLORS: CharacterThemeColors = {
  main: "#6f8cff",
  sub: "#6fb8c7",
};

export const DEFAULT_PROVIDER_APP_SETTINGS: ProviderAppSettings = {
  enabled: false,
  apiKey: "",
};

export function createDefaultAppSettings(): AppSettings {
  return {
    systemPromptPrefix: "",
    providerSettings: {
      [DEFAULT_PROVIDER_ID]: {
        enabled: true,
        apiKey: "",
      },
    },
  };
}

function normalizeProviderAppSettings(value: unknown, defaultEnabled: boolean): ProviderAppSettings {
  if (!value || typeof value !== "object") {
    return {
      enabled: defaultEnabled,
      apiKey: "",
    };
  }

  const candidate = value as Partial<ProviderAppSettings>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaultEnabled,
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
  };
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const defaults = createDefaultAppSettings();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const candidate = value as Partial<AppSettings>;
  const providerSettings: Record<string, ProviderAppSettings> = {};
  if (candidate.providerSettings && typeof candidate.providerSettings === "object") {
    for (const [providerId, providerSettingsValue] of Object.entries(candidate.providerSettings)) {
      const normalizedProviderId = normalizeProviderId(providerId);
      providerSettings[normalizedProviderId] = normalizeProviderAppSettings(
        providerSettingsValue,
        normalizedProviderId === DEFAULT_PROVIDER_ID,
      );
    }
  }

  if (!providerSettings[DEFAULT_PROVIDER_ID]) {
    providerSettings[DEFAULT_PROVIDER_ID] = { ...defaults.providerSettings[DEFAULT_PROVIDER_ID] };
  }

  return {
    systemPromptPrefix: typeof candidate.systemPromptPrefix === "string" ? candidate.systemPromptPrefix : "",
    providerSettings,
  };
}

export function getProviderAppSettings(settings: AppSettings, providerId: string | null | undefined): ProviderAppSettings {
  const normalizedProviderId = normalizeProviderId(providerId);
  const resolvedSettings = normalizeAppSettings(settings);
  return normalizeProviderAppSettings(
    resolvedSettings.providerSettings[normalizedProviderId],
    normalizedProviderId === DEFAULT_PROVIDER_ID,
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
    approvalMode:
      typeof candidate.approvalMode === "string" && candidate.approvalMode.trim() ? candidate.approvalMode : "on-request",
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : DEFAULT_MODEL_ID,
    reasoningEffort:
      candidate.reasoningEffort === "minimal" ||
      candidate.reasoningEffort === "low" ||
      candidate.reasoningEffort === "medium" ||
      candidate.reasoningEffort === "high" ||
      candidate.reasoningEffort === "xhigh"
        ? candidate.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
    threadId:
      typeof candidate.threadId === "string"
        ? candidate.threadId
        : typeof (candidate as { threadLabel?: string }).threadLabel === "string"
          ? (candidate as { threadLabel?: string }).threadLabel ?? ""
          : "",
    messages: Array.isArray(candidate.messages) ? candidate.messages : [],
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
    approvalMode: input.approvalMode,
    model: input.model?.trim() || DEFAULT_MODEL_ID,
    reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
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
