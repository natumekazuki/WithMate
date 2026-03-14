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

export type MessageArtifact = {
  title: string;
  activitySummary: string[];
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

export type CharacterCatalogItem = CharacterVisual & {
  id: string;
};

export type CharacterProfile = CharacterCatalogItem & {
  description: string;
  roleMarkdown: string;
  updatedAt: string;
};

export type CreateCharacterInput = {
  name: string;
  iconPath: string;
  description: string;
  roleMarkdown: string;
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
  workspaceLabel: string;
  workspacePath: string;
  branch: string;
  characterId: string;
  character: string;
  characterIconPath: string;
  approvalMode: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

type BrowserRuntimeWindow = {
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  location: {
    search: string;
  };
};

export const MOCK_SESSION_STORAGE_KEY = "withmate.mock.sessions.v1";
export const MOCK_CHARACTER_STORAGE_KEY = "withmate.mock.characters.v1";
export const MOCK_DIFF_PREVIEW_STORAGE_KEY = "withmate.mock.diff-previews.v1";
const LEGACY_SAMPLE_SESSION_IDS = new Set(["melt-main", "ishigami-adapter", "subaru-stream"]);
const LEGACY_SAMPLE_CHARACTER_IDS = new Set(["kuramochi-melto", "ishigami-nozomi", "ozora-subaru", "inui-toko"]);

function getBrowserWindow(): BrowserRuntimeWindow | null {
  if (typeof globalThis === "undefined" || !("window" in globalThis)) {
    return null;
  }

  return (globalThis as typeof globalThis & { window?: BrowserRuntimeWindow }).window ?? null;
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

export const initialCharacterProfiles: CharacterProfile[] = [];

export const characterCatalog: CharacterCatalogItem[] = initialCharacterProfiles.map(toCharacterCatalogItem);

function toCharacterCatalogItem(character: CharacterProfile): CharacterCatalogItem {
  return {
    id: character.id,
    name: character.name,
    iconPath: character.iconPath,
  };
}

export const initialSessions: Session[] = [];

function normalizeCharacterProfile(value: unknown): CharacterProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterProfile>;
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : "新規キャラクター";
  const idBase = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : name;

  return {
    id: idBase,
    name,
    iconPath: typeof candidate.iconPath === "string" ? candidate.iconPath : "",
    description: typeof candidate.description === "string" ? candidate.description : "",
    roleMarkdown:
      typeof candidate.roleMarkdown === "string"
        ? candidate.roleMarkdown
        : typeof (candidate as { promptNotes?: string }).promptNotes === "string"
          ? (candidate as { promptNotes?: string }).promptNotes ?? ""
          : "",
    updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt.trim() ? candidate.updatedAt : "just now",
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
    updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt.trim() ? candidate.updatedAt : "just now",
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

export function loadBrowserMockSessions(): Session[] {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return cloneSessions(initialSessions);
  }

  const stored = browserWindow.localStorage.getItem(MOCK_SESSION_STORAGE_KEY);
  if (!stored) {
    return cloneSessions(initialSessions);
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) {
      return cloneSessions(initialSessions);
    }

    const normalized = parsed
      .map(normalizeSession)
      .filter((session): session is Session => session !== null)
      .filter((session) => !LEGACY_SAMPLE_SESSION_IDS.has(session.id));
    return normalized.length > 0 ? normalized : cloneSessions(initialSessions);
  } catch {
    return cloneSessions(initialSessions);
  }
}

export function saveBrowserMockSessions(sessions: Session[]): void {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return;
  }

  browserWindow.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

export function ensureBrowserMockSessions(): Session[] {
  const browserWindow = getBrowserWindow();
  const sessions = loadBrowserMockSessions();
  if (browserWindow && !browserWindow.localStorage.getItem(MOCK_SESSION_STORAGE_KEY)) {
    saveBrowserMockSessions(sessions);
  }
  return sessions;
}

export function loadBrowserMockCharacters(): CharacterProfile[] {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return cloneCharacterProfiles(initialCharacterProfiles);
  }

  const stored = browserWindow.localStorage.getItem(MOCK_CHARACTER_STORAGE_KEY);
  if (!stored) {
    return cloneCharacterProfiles(initialCharacterProfiles);
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) {
      return cloneCharacterProfiles(initialCharacterProfiles);
    }

    const normalized = parsed
      .map(normalizeCharacterProfile)
      .filter((character): character is CharacterProfile => character !== null)
      .filter((character) => !LEGACY_SAMPLE_CHARACTER_IDS.has(character.id));
    return normalized.length > 0 ? normalized : cloneCharacterProfiles(initialCharacterProfiles);
  } catch {
    return cloneCharacterProfiles(initialCharacterProfiles);
  }
}

export function saveBrowserMockCharacters(characters: CharacterProfile[]): void {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return;
  }

  browserWindow.localStorage.setItem(MOCK_CHARACTER_STORAGE_KEY, JSON.stringify(characters));
}

export function ensureBrowserMockCharacters(): CharacterProfile[] {
  const browserWindow = getBrowserWindow();
  const characters = loadBrowserMockCharacters();
  if (browserWindow && !browserWindow.localStorage.getItem(MOCK_CHARACTER_STORAGE_KEY)) {
    saveBrowserMockCharacters(characters);
  }
  return characters;
}

function findCharacterByName(name: string, characters: CharacterProfile[]): CharacterProfile {
  const matched = characters.find((character) => character.name === name);
  if (matched) {
    return matched;
  }

  return (
    characters[0] ?? {
      id: "unknown-character",
      name,
      iconPath: "",
      description: "",
      roleMarkdown: "",
      updatedAt: "just now",
    }
  );
}

export function getCharacterCatalogItem(name: string): CharacterCatalogItem {
  return toCharacterCatalogItem(findCharacterByName(name, ensureBrowserMockCharacters()));
}

export function getCharacterProfile(characterId: string, characters: CharacterProfile[]): CharacterProfile | null {
  return cloneCharacterProfiles(characters).find((character) => character.id === characterId) ?? null;
}

export function buildNewCharacter(input: CreateCharacterInput): CharacterProfile {
  const slug = input.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "") || `character-${Date.now()}`;

  return {
    id: `${slug}-${Date.now()}`,
    name: input.name.trim() || "新規キャラクター",
    iconPath: input.iconPath.trim(),
    description: input.description.trim(),
    roleMarkdown: input.roleMarkdown.trim(),
    updatedAt: "just now",
  };
}

export function buildNewSession(input: CreateSessionInput): Session {
  return {
    id: `launch-${Date.now()}`,
    taskTitle: `${input.workspaceLabel} で新規作業を開始する`,
    taskSummary: `${input.workspaceLabel} で新規セッションを開始。${input.character} のロールを保ったまま、ここから最初の指示を待つ。`,
    status: "idle",
    updatedAt: "just now",
    provider: normalizeProviderId(input.provider),
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
    runState: "idle",
    approvalMode: input.approvalMode,
    model: input.model?.trim() || DEFAULT_MODEL_ID,
    reasoningEffort: input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    threadId: "",
    messages: [],
    stream: [],
  };
}

export function buildSessionUrl(sessionId: string): string {
  return `./session.html?sessionId=${encodeURIComponent(sessionId)}`;
}

export function buildCharacterEditorUrl(characterId?: string | null): string {
  if (!characterId) {
    return "./character.html?mode=create";
  }

  return `./character.html?characterId=${encodeURIComponent(characterId)}`;
}

export function buildDiffWindowUrl(token: string): string {
  return `./diff.html?token=${encodeURIComponent(token)}`;
}

export function getSessionIdFromLocation(): string | null {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return null;
  }

  return new URLSearchParams(browserWindow.location.search).get("sessionId");
}

export function getCharacterIdFromLocation(): string | null {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return null;
  }

  return new URLSearchParams(browserWindow.location.search).get("characterId");
}

export function getDiffTokenFromLocation(): string | null {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return null;
  }

  return new URLSearchParams(browserWindow.location.search).get("token");
}

function loadBrowserDiffPreviewMap(): Record<string, DiffPreviewPayload> {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return {};
  }

  const stored = browserWindow.localStorage.getItem(MOCK_DIFF_PREVIEW_STORAGE_KEY);
  if (!stored) {
    return {};
  }

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    return parsed as Record<string, DiffPreviewPayload>;
  } catch {
    return {};
  }
}

function saveBrowserDiffPreviewMap(previews: Record<string, DiffPreviewPayload>): void {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return;
  }

  browserWindow.localStorage.setItem(MOCK_DIFF_PREVIEW_STORAGE_KEY, JSON.stringify(previews));
}

export function saveBrowserDiffPreview(token: string, payload: DiffPreviewPayload): void {
  const previews = loadBrowserDiffPreviewMap();
  previews[token] = payload;
  saveBrowserDiffPreviewMap(previews);
}

export function loadBrowserDiffPreview(token: string): DiffPreviewPayload | null {
  const previews = loadBrowserDiffPreviewMap();
  return previews[token] ?? null;
}

export function isCharacterCreateMode(): boolean {
  const browserWindow = getBrowserWindow();
  if (!browserWindow) {
    return false;
  }

  return new URLSearchParams(browserWindow.location.search).get("mode") === "create";
}
