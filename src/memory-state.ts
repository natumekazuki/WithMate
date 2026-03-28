import { currentIsoTimestamp } from "./time-state.js";

export type SessionBackgroundActivityKind = "memory-generation" | "character-memory-generation" | "monologue";

export type SessionBackgroundActivityStatus = "running" | "completed" | "failed" | "canceled";

export type SessionBackgroundActivityState = {
  sessionId: string;
  kind: SessionBackgroundActivityKind;
  status: SessionBackgroundActivityStatus;
  title: string;
  summary: string;
  details?: string;
  errorMessage: string;
  updatedAt: string;
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

export type ProjectScopeType = "git" | "directory";

export type ProjectMemoryCategory = "decision" | "constraint" | "convention" | "context" | "deferred";

export type ProjectScope = {
  id: string;
  projectType: ProjectScopeType;
  projectKey: string;
  workspacePath: string;
  gitRoot: string | null;
  gitRemoteUrl: string | null;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMemoryEntry = {
  id: string;
  projectScopeId: string;
  sourceSessionId: string | null;
  category: ProjectMemoryCategory;
  title: string;
  detail: string;
  keywords: string[];
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type CharacterMemoryCategory = "preference" | "relationship" | "shared_moment" | "tone" | "boundary";

export type CharacterScope = {
  id: string;
  characterId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterMemoryEntry = {
  id: string;
  characterScopeId: string;
  sourceSessionId: string | null;
  category: CharacterMemoryCategory;
  title: string;
  detail: string;
  keywords: string[];
  evidence: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type CharacterMemoryDeltaEntry = {
  category: CharacterMemoryCategory;
  title: string;
  detail: string;
  keywords: string[];
  evidence: string[];
};

export type CharacterMemoryDelta = {
  entries: CharacterMemoryDeltaEntry[];
};

export type CharacterReflectionMonologueMood = "spark" | "calm" | "warm";

export type CharacterReflectionMonologue = {
  text: string;
  mood: CharacterReflectionMonologueMood;
};

export type CharacterReflectionOutput = {
  memoryDelta: CharacterMemoryDelta | null;
  monologue: CharacterReflectionMonologue | null;
};

type CreateDefaultSessionMemoryInput = {
  id: string;
  workspacePath: string;
  threadId: string;
  taskTitle: string;
  taskSummary: string;
};

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

export function createDefaultSessionMemory(input: CreateDefaultSessionMemoryInput): SessionMemory {
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

function normalizeProjectMemoryCategory(value: unknown): ProjectMemoryCategory | null {
  return value === "decision" ||
    value === "constraint" ||
    value === "convention" ||
    value === "context" ||
    value === "deferred"
    ? value
    : null;
}

function normalizeCharacterMemoryCategory(value: unknown): CharacterMemoryCategory | null {
  return value === "preference" ||
    value === "relationship" ||
    value === "shared_moment" ||
    value === "tone" ||
    value === "boundary"
    ? value
    : null;
}

function normalizeStreamMood(value: unknown): CharacterReflectionMonologueMood {
  return value === "spark" || value === "warm" || value === "calm" ? value : "calm";
}

export function normalizeProjectScope(value: unknown): ProjectScope | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectScope>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  const projectType = candidate.projectType === "git" || candidate.projectType === "directory"
    ? candidate.projectType
    : null;
  if (!projectType) {
    return null;
  }

  if (typeof candidate.projectKey !== "string" || !candidate.projectKey.trim()) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    projectType,
    projectKey: candidate.projectKey.trim(),
    workspacePath: typeof candidate.workspacePath === "string" ? candidate.workspacePath.trim() : "",
    gitRoot:
      typeof candidate.gitRoot === "string" && candidate.gitRoot.trim()
        ? candidate.gitRoot.trim()
        : null,
    gitRemoteUrl:
      typeof candidate.gitRemoteUrl === "string" && candidate.gitRemoteUrl.trim()
        ? candidate.gitRemoteUrl.trim()
        : null,
    displayName: typeof candidate.displayName === "string" ? candidate.displayName.trim() : "",
    createdAt:
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : currentIsoTimestamp(),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
  };
}

export function normalizeProjectMemoryEntry(value: unknown): ProjectMemoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectMemoryEntry>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  if (typeof candidate.projectScopeId !== "string" || !candidate.projectScopeId.trim()) {
    return null;
  }

  const category = normalizeProjectMemoryCategory(candidate.category);
  if (!category) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    projectScopeId: candidate.projectScopeId.trim(),
    sourceSessionId:
      typeof candidate.sourceSessionId === "string" && candidate.sourceSessionId.trim()
        ? candidate.sourceSessionId.trim()
        : null,
    category,
    title: typeof candidate.title === "string" ? candidate.title.trim() : "",
    detail: typeof candidate.detail === "string" ? candidate.detail.trim() : "",
    keywords: normalizeStringList(candidate.keywords),
    evidence: normalizeStringList(candidate.evidence),
    createdAt:
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : currentIsoTimestamp(),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
    lastUsedAt:
      typeof candidate.lastUsedAt === "string" && candidate.lastUsedAt.trim()
        ? candidate.lastUsedAt
        : null,
  };
}

export function normalizeCharacterScope(value: unknown): CharacterScope | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterScope>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  if (typeof candidate.characterId !== "string" || !candidate.characterId.trim()) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    characterId: candidate.characterId.trim(),
    displayName: typeof candidate.displayName === "string" ? candidate.displayName.trim() : "",
    createdAt:
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : currentIsoTimestamp(),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
  };
}

export function normalizeCharacterMemoryEntry(value: unknown): CharacterMemoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterMemoryEntry>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) {
    return null;
  }

  if (typeof candidate.characterScopeId !== "string" || !candidate.characterScopeId.trim()) {
    return null;
  }

  const category = normalizeCharacterMemoryCategory(candidate.category);
  if (!category) {
    return null;
  }

  return {
    id: candidate.id.trim(),
    characterScopeId: candidate.characterScopeId.trim(),
    sourceSessionId:
      typeof candidate.sourceSessionId === "string" && candidate.sourceSessionId.trim()
        ? candidate.sourceSessionId.trim()
        : null,
    category,
    title: typeof candidate.title === "string" ? candidate.title.trim() : "",
    detail: typeof candidate.detail === "string" ? candidate.detail.trim() : "",
    keywords: normalizeStringList(candidate.keywords),
    evidence: normalizeStringList(candidate.evidence),
    createdAt:
      typeof candidate.createdAt === "string" && candidate.createdAt.trim()
        ? candidate.createdAt
        : currentIsoTimestamp(),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt
        : currentIsoTimestamp(),
    lastUsedAt:
      typeof candidate.lastUsedAt === "string" && candidate.lastUsedAt.trim()
        ? candidate.lastUsedAt
        : null,
  };
}

export function normalizeCharacterMemoryDeltaEntry(value: unknown): CharacterMemoryDeltaEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterMemoryDeltaEntry>;
  const category = normalizeCharacterMemoryCategory(candidate.category);
  if (!category) {
    return null;
  }

  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const detail = typeof candidate.detail === "string" ? candidate.detail.trim() : "";
  if (!title || !detail) {
    return null;
  }

  return {
    category,
    title,
    detail,
    keywords: normalizeStringList(candidate.keywords),
    evidence: normalizeStringList(candidate.evidence),
  };
}

export function normalizeCharacterMemoryDelta(value: unknown): CharacterMemoryDelta | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterMemoryDelta>;
  const entries = Array.isArray(candidate.entries)
    ? candidate.entries
        .map((entry) => normalizeCharacterMemoryDeltaEntry(entry))
        .filter((entry): entry is CharacterMemoryDeltaEntry => entry !== null)
    : [];

  return {
    entries,
  };
}

export function normalizeCharacterReflectionMonologue(value: unknown): CharacterReflectionMonologue | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterReflectionMonologue>;
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (!text) {
    return null;
  }

  return {
    text,
    mood: normalizeStreamMood(candidate.mood),
  };
}

export function normalizeCharacterReflectionOutput(value: unknown): CharacterReflectionOutput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CharacterReflectionOutput> & { monologueText?: unknown };
  const memoryDelta = candidate.memoryDelta === null
    ? null
    : normalizeCharacterMemoryDelta(candidate.memoryDelta) ?? { entries: [] };
  const monologue = candidate.monologue === null
    ? null
    : normalizeCharacterReflectionMonologue(candidate.monologue)
      ?? (typeof candidate.monologueText === "string"
        ? normalizeCharacterReflectionMonologue({ text: candidate.monologueText, mood: "calm" })
        : null);

  return {
    memoryDelta,
    monologue,
  };
}

export function cloneProjectScopes(scopes: ProjectScope[]): ProjectScope[] {
  return JSON.parse(JSON.stringify(scopes)) as ProjectScope[];
}

export function cloneProjectMemoryEntries(entries: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as ProjectMemoryEntry[];
}

export function cloneCharacterScopes(scopes: CharacterScope[]): CharacterScope[] {
  return JSON.parse(JSON.stringify(scopes)) as CharacterScope[];
}

export function cloneCharacterMemoryEntries(entries: CharacterMemoryEntry[]): CharacterMemoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as CharacterMemoryEntry[];
}
