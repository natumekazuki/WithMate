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

export function getCharacterProfile(characterId: string, characters: CharacterProfile[]): CharacterProfile | null {
  return cloneCharacterProfiles(characters).find((character) => character.id === characterId) ?? null;
}

export function buildNewSession(input: CreateSessionInput): Session {
  return {
    id: `launch-${Date.now()}`,
    taskTitle: `${input.workspaceLabel} で新規作業を開始する`,
    taskSummary: `${input.workspaceLabel} で新規セッションを開始。${input.character} のロールを保ったまま、ここから最初の指示を待つ。`,
    status: "idle",
    updatedAt: "just now",
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
