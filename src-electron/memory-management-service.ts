import type { SessionSummary } from "../src/app-state.js";
import {
  cloneMemoryManagementSnapshot,
  type ManagedCharacterMemoryGroup,
  type ManagedProjectMemoryGroup,
  type ManagedSessionMemoryItem,
  type MemoryManagementDomain,
  type MemoryManagementDomainPageInfo,
  type MemoryManagementPageRequest,
  type MemoryManagementPageResult,
  type MemoryManagementSnapshot,
} from "../src/memory-management-state.js";
import type { CharacterMemoryEntry, CharacterScope, ProjectMemoryEntry, ProjectScope, SessionMemory } from "../src/memory-state.js";

const DEFAULT_MEMORY_MANAGEMENT_PAGE_LIMIT = 50;
const MAX_MEMORY_MANAGEMENT_PAGE_LIMIT = 200;

type MemoryManagementServiceDeps = {
  listSessionSummaries(): SessionSummary[];
  listSessionMemories(): SessionMemory[];
  deleteSessionMemory(sessionId: string): void;
  listProjectScopes(): ProjectScope[];
  listProjectMemoryEntries(projectScopeId: string): ProjectMemoryEntry[];
  deleteProjectMemoryEntry(entryId: string): void;
  listCharacterScopes(): CharacterScope[];
  listCharacterMemoryEntries(characterScopeId: string): CharacterMemoryEntry[];
  deleteCharacterMemoryEntry(entryId: string): void;
};

export class MemoryManagementService {
  constructor(private readonly deps: MemoryManagementServiceDeps) {}

  getSnapshot(): MemoryManagementSnapshot {
    const sessions = this.deps.listSessionSummaries();
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    const sessionMemories = this.deps.listSessionMemories().map((memory): ManagedSessionMemoryItem => {
      const session = sessionMap.get(memory.sessionId);
      return {
        sessionId: memory.sessionId,
        taskTitle: session?.taskTitle || "削除済み Session",
        character: session?.character || "Unknown",
        provider: session?.provider || "",
        workspaceLabel: session?.workspaceLabel || memory.workspacePath || "workspace 未設定",
        workspacePath: memory.workspacePath || session?.workspacePath || "",
        status: session?.status || "saved",
        runState: session?.runState || "idle",
        updatedAt: memory.updatedAt,
        memory,
      };
    });

    const projectMemories = this.deps.listProjectScopes()
      .map((scope): ManagedProjectMemoryGroup => ({
        scope,
        entries: this.deps.listProjectMemoryEntries(scope.id),
      }))
      .filter((group) => group.entries.length > 0);

    const characterMemories = this.deps.listCharacterScopes()
      .map((scope): ManagedCharacterMemoryGroup => ({
        scope,
        entries: this.deps.listCharacterMemoryEntries(scope.id),
      }))
      .filter((group) => group.entries.length > 0);

    return cloneMemoryManagementSnapshot({
      sessionMemories,
      projectMemories,
      characterMemories,
    });
  }

  getPage(request: MemoryManagementPageRequest = {}): MemoryManagementPageResult {
    const domain = normalizeDomain(request.domain);
    const cursor = normalizeCursor(request.cursor);
    const limit = normalizeLimit(request.limit);
    const fullSnapshot = this.getSnapshot();
    const includeSession = domain === "all" || domain === "session";
    const includeProject = domain === "all" || domain === "project";
    const includeCharacter = domain === "all" || domain === "character";

    const sessionPage = includeSession
      ? sliceItems(filterSessionMemories(fullSnapshot.sessionMemories, request), cursor, limit)
      : emptyPage(fullSnapshot.sessionMemories.length);
    const projectPage = includeProject
      ? sliceGroupedEntries(filterProjectMemories(fullSnapshot.projectMemories, request), cursor, limit, request)
      : emptyGroupedPage(fullSnapshot.projectMemories);
    const characterPage = includeCharacter
      ? sliceGroupedEntries(filterCharacterMemories(fullSnapshot.characterMemories, request), cursor, limit, request)
      : emptyGroupedPage(fullSnapshot.characterMemories);

    return {
      snapshot: cloneMemoryManagementSnapshot({
        sessionMemories: sessionPage.items,
        projectMemories: projectPage.groups,
        characterMemories: characterPage.groups,
      }),
      pages: {
        session: sessionPage.page,
        project: projectPage.page,
        character: characterPage.page,
      },
    };
  }

  deleteSessionMemory(sessionId: string): void {
    this.deps.deleteSessionMemory(sessionId);
  }

  deleteProjectMemoryEntry(entryId: string): void {
    this.deps.deleteProjectMemoryEntry(entryId);
  }

  deleteCharacterMemoryEntry(entryId: string): void {
    this.deps.deleteCharacterMemoryEntry(entryId);
  }
}

function normalizeDomain(domain: MemoryManagementPageRequest["domain"]): MemoryManagementDomain {
  return domain === "session" || domain === "project" || domain === "character" ? domain : "all";
}

function normalizeCursor(cursor: MemoryManagementPageRequest["cursor"]): number {
  return typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

function normalizeLimit(limit: MemoryManagementPageRequest["limit"]): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_MEMORY_MANAGEMENT_PAGE_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MEMORY_MANAGEMENT_PAGE_LIMIT, Math.floor(limit)));
}

function buildPageInfo(cursor: number, limit: number, total: number): MemoryManagementDomainPageInfo {
  const nextCursor = cursor + limit;
  return {
    nextCursor: nextCursor < total ? nextCursor : null,
    hasMore: nextCursor < total,
    total,
  };
}

function normalizeSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function matchesSearch(values: Array<string | null | undefined>, searchText: string): boolean {
  if (!searchText) {
    return true;
  }

  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase()
    .includes(searchText);
}

function getUpdatedAtMs(updatedAt: string): number {
  const value = new Date(updatedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function compareUpdatedAt(left: string, right: string, sort: MemoryManagementPageRequest["sort"]): number {
  const delta = getUpdatedAtMs(left) - getUpdatedAtMs(right);
  if (delta !== 0) {
    return sort === "updated-asc" ? delta : -delta;
  }
  return 0;
}

function isSessionStatusMatch(
  item: ManagedSessionMemoryItem,
  sessionStatus: MemoryManagementPageRequest["sessionStatus"],
): boolean {
  if (!sessionStatus || sessionStatus === "all") {
    return true;
  }
  if (sessionStatus === "running") {
    return item.status === "running" || item.runState === "running";
  }
  return item.status === sessionStatus;
}

function filterSessionMemories(
  items: ManagedSessionMemoryItem[],
  request: MemoryManagementPageRequest,
): ManagedSessionMemoryItem[] {
  const searchText = normalizeSearchText(request.searchText);
  return items
    .filter((item) => isSessionStatusMatch(item, request.sessionStatus))
    .filter((item) => matchesSearch([
      item.taskTitle,
      item.character,
      item.provider,
      item.workspaceLabel,
      item.workspacePath,
      item.memory.goal,
      ...item.memory.decisions,
      ...item.memory.openQuestions,
      ...item.memory.nextActions,
      ...item.memory.notes,
    ], searchText))
    .sort((left, right) => compareUpdatedAt(left.updatedAt, right.updatedAt, request.sort) || left.sessionId.localeCompare(right.sessionId));
}

function filterProjectMemories(
  groups: ManagedProjectMemoryGroup[],
  request: MemoryManagementPageRequest,
): ManagedProjectMemoryGroup[] {
  const searchText = normalizeSearchText(request.searchText);
  const category = request.projectCategory;
  return groups
    .map((group): ManagedProjectMemoryGroup => ({
      scope: group.scope,
      entries: group.entries.filter((entry) => {
        if (category && category !== "all" && entry.category !== category) {
          return false;
        }
        return matchesSearch([
          group.scope.displayName,
          group.scope.projectKey,
          group.scope.workspacePath,
          group.scope.gitRoot,
          group.scope.gitRemoteUrl,
          entry.title,
          entry.detail,
          entry.category,
          ...entry.keywords,
          ...entry.evidence,
        ], searchText);
      }),
    }))
    .filter((group) => group.entries.length > 0);
}

function filterCharacterMemories(
  groups: ManagedCharacterMemoryGroup[],
  request: MemoryManagementPageRequest,
): ManagedCharacterMemoryGroup[] {
  const searchText = normalizeSearchText(request.searchText);
  const category = request.characterCategory;
  return groups
    .map((group): ManagedCharacterMemoryGroup => ({
      scope: group.scope,
      entries: group.entries.filter((entry) => {
        if (category && category !== "all" && entry.category !== category) {
          return false;
        }
        return matchesSearch([
          group.scope.displayName,
          group.scope.characterId,
          entry.title,
          entry.detail,
          entry.category,
          ...entry.keywords,
          ...entry.evidence,
        ], searchText);
      }),
    }))
    .filter((group) => group.entries.length > 0);
}

function emptyPage(total: number): { items: []; page: MemoryManagementDomainPageInfo } {
  return {
    items: [],
    page: {
      nextCursor: null,
      hasMore: false,
      total,
    },
  };
}

function sliceItems<TItem>(
  items: TItem[],
  cursor: number,
  limit: number,
): { items: TItem[]; page: MemoryManagementDomainPageInfo } {
  return {
    items: items.slice(cursor, cursor + limit),
    page: buildPageInfo(cursor, limit, items.length),
  };
}

function emptyGroupedPage<TGroup extends { entries: unknown[] }>(
  groups: TGroup[],
): { groups: []; page: MemoryManagementDomainPageInfo } {
  return {
    groups: [],
    page: {
      nextCursor: null,
      hasMore: false,
      total: groups.reduce((count, group) => count + group.entries.length, 0),
    },
  };
}

function sliceGroupedEntries<TGroup extends ManagedProjectMemoryGroup | ManagedCharacterMemoryGroup>(
  groups: TGroup[],
  cursor: number,
  limit: number,
  request: MemoryManagementPageRequest,
): { groups: TGroup[]; page: MemoryManagementDomainPageInfo } {
  const flattened = groups
    .flatMap((group) => group.entries.map((entry) => ({ scope: group.scope, entry })))
    .sort((left, right) =>
      compareUpdatedAt(left.entry.updatedAt, right.entry.updatedAt, request.sort) || left.entry.id.localeCompare(right.entry.id));
  const pageEntries = flattened.slice(cursor, cursor + limit);
  const grouped = new Map<string, TGroup>();

  for (const { scope, entry } of pageEntries) {
    const existing = grouped.get(scope.id);
    if (existing) {
      existing.entries.push(entry as never);
      continue;
    }

    grouped.set(scope.id, { scope, entries: [entry] } as TGroup);
  }

  return {
    groups: [...grouped.values()],
    page: buildPageInfo(cursor, limit, flattened.length),
  };
}
