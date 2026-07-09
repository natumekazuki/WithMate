import { currentIsoTimestamp } from "../time-state.js";
import type { Session } from "../session-state.js";

export type SessionBackgroundActivityKind = "memory-generation" | "monologue";

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

export type ManagedSessionMemoryItem = {
  sessionId: string;
  taskTitle: string;
  character: string;
  provider: string;
  workspaceLabel: string;
  workspacePath: string;
  status: Session["status"];
  runState: Session["runState"];
  updatedAt: string;
  memory: SessionMemory;
};

export type ManagedProjectMemoryGroup = {
  scope: ProjectScope;
  entries: ProjectMemoryEntry[];
};

export type MemoryPageDomain = "all" | "session" | "project";

export type MemoryPageRequest = {
  domain?: MemoryPageDomain;
  cursor?: number;
  limit?: number;
  searchText?: string;
  sort?: "updated-desc" | "updated-asc";
  sessionStatus?: "all" | "running" | "idle" | "saved";
  projectCategory?: "all" | ProjectMemoryCategory;
};

type CreateDefaultSessionMemoryInput = {
  id: string;
  workspacePath: string;
  threadId: string;
  taskTitle: string;
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
  const goal = input.taskTitle.trim();
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

export function cloneProjectScopes(scopes: ProjectScope[]): ProjectScope[] {
  return JSON.parse(JSON.stringify(scopes)) as ProjectScope[];
}

export function cloneProjectMemoryEntries(entries: ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  return JSON.parse(JSON.stringify(entries)) as ProjectMemoryEntry[];
}
