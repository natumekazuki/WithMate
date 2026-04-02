import type {
  CharacterMemoryCategory,
  ProjectMemoryCategory,
} from "./memory-state.js";
import type {
  ManagedCharacterMemoryGroup,
  ManagedProjectMemoryGroup,
  ManagedSessionMemoryItem,
  MemoryManagementSnapshot,
} from "./memory-management-state.js";

export type MemoryManagementDomainFilter = "all" | "session" | "project" | "character";
export type MemoryManagementSort = "updated-desc" | "updated-asc";
export type SessionMemoryStatusFilter = "all" | "running" | "idle" | "saved";
export type ProjectMemoryCategoryFilter = "all" | ProjectMemoryCategory;
export type CharacterMemoryCategoryFilter = "all" | CharacterMemoryCategory;

export type MemoryManagementViewFilters = {
  searchText: string;
  domain: MemoryManagementDomainFilter;
  sort: MemoryManagementSort;
  sessionStatus: SessionMemoryStatusFilter;
  projectCategory: ProjectMemoryCategoryFilter;
  characterCategory: CharacterMemoryCategoryFilter;
};

export const DEFAULT_MEMORY_MANAGEMENT_VIEW_FILTERS: MemoryManagementViewFilters = {
  searchText: "",
  domain: "all",
  sort: "updated-desc",
  sessionStatus: "all",
  projectCategory: "all",
  characterCategory: "all",
};

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function includesSearch(haystacks: Array<string | null | undefined>, searchText: string): boolean {
  if (!searchText) {
    return true;
  }

  return haystacks.some((value) => value?.toLowerCase().includes(searchText));
}

function sortByUpdatedAt<T extends { updatedAt: string }>(items: T[], sort: MemoryManagementSort): T[] {
  return [...items].sort((left, right) => {
    const delta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
    return sort === "updated-asc" ? delta : -delta;
  });
}

function isSessionStatusMatch(item: ManagedSessionMemoryItem, filter: SessionMemoryStatusFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "running") {
    return item.status === "running" || item.runState === "running";
  }
  return item.status === filter;
}

function filterSessionMemories(
  items: ManagedSessionMemoryItem[],
  { searchText, sessionStatus, sort }: Pick<MemoryManagementViewFilters, "searchText" | "sessionStatus" | "sort">,
): ManagedSessionMemoryItem[] {
  return sortByUpdatedAt(
    items.filter((item) => {
      if (!isSessionStatusMatch(item, sessionStatus)) {
        return false;
      }

      return includesSearch([
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
      ], searchText);
    }),
    sort,
  );
}

function filterProjectMemories(
  groups: ManagedProjectMemoryGroup[],
  { searchText, projectCategory, sort }: Pick<MemoryManagementViewFilters, "searchText" | "projectCategory" | "sort">,
): ManagedProjectMemoryGroup[] {
  const filtered = groups.map((group) => ({
    scope: group.scope,
    entries: sortByUpdatedAt(
      group.entries.filter((entry) => {
        if (projectCategory !== "all" && entry.category !== projectCategory) {
          return false;
        }

        return includesSearch([
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
      sort,
    ),
  }));

  return filtered
    .filter((group) => group.entries.length > 0)
    .sort((left, right) => {
      const leftUpdatedAt = left.entries[0]?.updatedAt ?? left.scope.updatedAt;
      const rightUpdatedAt = right.entries[0]?.updatedAt ?? right.scope.updatedAt;
      const delta = new Date(leftUpdatedAt).getTime() - new Date(rightUpdatedAt).getTime();
      return sort === "updated-asc" ? delta : -delta;
    });
}

function filterCharacterMemories(
  groups: ManagedCharacterMemoryGroup[],
  { searchText, characterCategory, sort }: Pick<MemoryManagementViewFilters, "searchText" | "characterCategory" | "sort">,
): ManagedCharacterMemoryGroup[] {
  const filtered = groups.map((group) => ({
    scope: group.scope,
    entries: sortByUpdatedAt(
      group.entries.filter((entry) => {
        if (characterCategory !== "all" && entry.category !== characterCategory) {
          return false;
        }

        return includesSearch([
          group.scope.displayName,
          group.scope.characterId,
          entry.title,
          entry.detail,
          entry.category,
          ...entry.keywords,
          ...entry.evidence,
        ], searchText);
      }),
      sort,
    ),
  }));

  return filtered
    .filter((group) => group.entries.length > 0)
    .sort((left, right) => {
      const leftUpdatedAt = left.entries[0]?.updatedAt ?? left.scope.updatedAt;
      const rightUpdatedAt = right.entries[0]?.updatedAt ?? right.scope.updatedAt;
      const delta = new Date(leftUpdatedAt).getTime() - new Date(rightUpdatedAt).getTime();
      return sort === "updated-asc" ? delta : -delta;
    });
}

export function buildFilteredMemoryManagementSnapshot(
  snapshot: MemoryManagementSnapshot | null,
  filters: MemoryManagementViewFilters,
): MemoryManagementSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const searchText = normalizeSearchText(filters.searchText);
  const includeSession = filters.domain === "all" || filters.domain === "session";
  const includeProject = filters.domain === "all" || filters.domain === "project";
  const includeCharacter = filters.domain === "all" || filters.domain === "character";

  return {
    sessionMemories: includeSession
      ? filterSessionMemories(snapshot.sessionMemories, {
          searchText,
          sessionStatus: filters.sessionStatus,
          sort: filters.sort,
        })
      : [],
    projectMemories: includeProject
      ? filterProjectMemories(snapshot.projectMemories, {
          searchText,
          projectCategory: filters.projectCategory,
          sort: filters.sort,
        })
      : [],
    characterMemories: includeCharacter
      ? filterCharacterMemories(snapshot.characterMemories, {
          searchText,
          characterCategory: filters.characterCategory,
          sort: filters.sort,
        })
      : [],
  };
}
