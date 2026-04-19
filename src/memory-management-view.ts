import type {
  CharacterMemoryEntry,
  CharacterMemoryCategory,
  ProjectMemoryEntry,
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

function buildSearchKey(values: Array<string | null | undefined>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

function matchesSearch(searchKey: string, searchText: string): boolean {
  return !searchText || searchKey.includes(searchText);
}

function getUpdatedAtMs(updatedAt: string): number {
  return new Date(updatedAt).getTime();
}

type SortedItems<T> = {
  "updated-desc": T[];
  "updated-asc": T[];
};

type PreparedSessionMemoryItem = {
  item: ManagedSessionMemoryItem;
  searchKey: string;
  updatedAtMs: number;
};

type PreparedGroupEntry<TEntry> = {
  entry: TEntry;
  searchKey: string;
  updatedAtMs: number;
};

type PreparedGroup<TScope, TEntry extends { category: TCategory }, TCategory extends string> = {
  scope: TScope;
  entries: SortedItems<PreparedGroupEntry<TEntry>>;
  entriesByCategory: Map<TCategory, SortedItems<PreparedGroupEntry<TEntry>>>;
};

type MaterializedGroup<TScope, TEntry> = {
  scope: TScope;
  entries: TEntry[];
};

type PreparedGroupCollection<TScope, TEntry extends { category: TCategory }, TCategory extends string> = {
  groups: PreparedGroup<TScope, TEntry, TCategory>[];
  groupsBySort: SortedItems<MaterializedGroup<TScope, TEntry>>;
  groupsByCategory: Map<TCategory, SortedItems<MaterializedGroup<TScope, TEntry>>>;
};

type PreparedMemoryManagementSnapshot = {
  sessionMemoriesByStatus: Record<SessionMemoryStatusFilter, SortedItems<PreparedSessionMemoryItem>>;
  projectMemories: PreparedGroupCollection<ManagedProjectMemoryGroup["scope"], ProjectMemoryEntry, ProjectMemoryCategory>;
  characterMemories: PreparedGroupCollection<ManagedCharacterMemoryGroup["scope"], CharacterMemoryEntry, CharacterMemoryCategory>;
};

const preparedSnapshotCache = new WeakMap<MemoryManagementSnapshot, PreparedMemoryManagementSnapshot>();

function buildSortedItems<T extends { updatedAtMs: number }>(items: T[]): SortedItems<T> {
  const ascending = [...items].sort((left, right) => left.updatedAtMs - right.updatedAtMs);
  return {
    "updated-asc": ascending,
    "updated-desc": [...ascending].reverse(),
  };
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

function buildSessionStatusSelectors(
  sortedItems: SortedItems<PreparedSessionMemoryItem>,
): Record<SessionMemoryStatusFilter, SortedItems<PreparedSessionMemoryItem>> {
  const runningAscending = sortedItems["updated-asc"].filter((item) => isSessionStatusMatch(item.item, "running"));
  const idleAscending = sortedItems["updated-asc"].filter((item) => isSessionStatusMatch(item.item, "idle"));
  const savedAscending = sortedItems["updated-asc"].filter((item) => isSessionStatusMatch(item.item, "saved"));

  return {
    all: sortedItems,
    running: {
      "updated-asc": runningAscending,
      "updated-desc": [...runningAscending].reverse(),
    },
    idle: {
      "updated-asc": idleAscending,
      "updated-desc": [...idleAscending].reverse(),
    },
    saved: {
      "updated-asc": savedAscending,
      "updated-desc": [...savedAscending].reverse(),
    },
  };
}

function buildMaterializedGroupSorts<TScope, TEntry extends { category: TCategory }, TCategory extends string>(
  groups: PreparedGroup<TScope, TEntry, TCategory>[],
  category?: TCategory,
): SortedItems<MaterializedGroup<TScope, TEntry>> {
  const buildGroupsForSort = (sort: MemoryManagementSort) => groups
    .flatMap((group) => {
      const entries = category
        ? (group.entriesByCategory.get(category)?.[sort] ?? [])
        : group.entries[sort];
      if (entries.length === 0) {
        return [];
      }

      return [{
        scope: group.scope,
        entries: entries.map((item) => item.entry),
        updatedAtMs: entries[0].updatedAtMs,
      }];
    })
    .sort((left, right) => {
      const delta = left.updatedAtMs - right.updatedAtMs;
      return sort === "updated-asc" ? delta : -delta;
    })
    .map(({ scope, entries }) => ({ scope, entries }));

  return {
    "updated-asc": buildGroupsForSort("updated-asc"),
    "updated-desc": buildGroupsForSort("updated-desc"),
  };
}

function buildPreparedGroupCollection<TScope, TEntry extends { category: TCategory; updatedAt: string }, TCategory extends string>(
  groups: Array<{ scope: TScope; entries: TEntry[] }>,
  buildEntrySearchKey: (scope: TScope, entry: TEntry) => string,
): PreparedGroupCollection<TScope, TEntry, TCategory> {
  const categories = new Set<TCategory>();
  const preparedGroups = groups.map((group) => {
    const preparedEntries = buildSortedItems(
      group.entries.map((entry) => {
        categories.add(entry.category);
        return {
          entry,
          searchKey: buildEntrySearchKey(group.scope, entry),
          updatedAtMs: getUpdatedAtMs(entry.updatedAt),
        };
      }),
    );
    const entriesByCategory = new Map<TCategory, SortedItems<PreparedGroupEntry<TEntry>>>();

    for (const preparedEntry of preparedEntries["updated-asc"]) {
      const existing = entriesByCategory.get(preparedEntry.entry.category);
      if (existing) {
        existing["updated-asc"].push(preparedEntry);
        continue;
      }

      entriesByCategory.set(preparedEntry.entry.category, {
        "updated-asc": [preparedEntry],
        "updated-desc": [],
      });
    }

    for (const [category, items] of entriesByCategory) {
      entriesByCategory.set(category, {
        "updated-asc": items["updated-asc"],
        "updated-desc": [...items["updated-asc"]].reverse(),
      });
    }

    return {
      scope: group.scope,
      entries: preparedEntries,
      entriesByCategory,
    };
  });

  const groupsByCategory = new Map<TCategory, SortedItems<MaterializedGroup<TScope, TEntry>>>();
  for (const category of categories) {
    groupsByCategory.set(category, buildMaterializedGroupSorts(preparedGroups, category));
  }

  return {
    groups: preparedGroups,
    groupsBySort: buildMaterializedGroupSorts(preparedGroups),
    groupsByCategory,
  };
}

function getPreparedSnapshot(snapshot: MemoryManagementSnapshot): PreparedMemoryManagementSnapshot {
  const cached = preparedSnapshotCache.get(snapshot);
  if (cached) {
    return cached;
  }

  const preparedSnapshot: PreparedMemoryManagementSnapshot = {
    sessionMemoriesByStatus: buildSessionStatusSelectors(
      buildSortedItems(
        snapshot.sessionMemories.map((item) => ({
          item,
          searchKey: buildSearchKey([
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
          ]),
          updatedAtMs: getUpdatedAtMs(item.updatedAt),
        })),
      ),
    ),
    projectMemories: buildPreparedGroupCollection(snapshot.projectMemories, (scope, entry) =>
      buildSearchKey([
        scope.displayName,
        scope.projectKey,
        scope.workspacePath,
        scope.gitRoot,
        scope.gitRemoteUrl,
        entry.title,
        entry.detail,
        entry.category,
        ...entry.keywords,
        ...entry.evidence,
      ])),
    characterMemories: buildPreparedGroupCollection(snapshot.characterMemories, (scope, entry) =>
      buildSearchKey([
        scope.displayName,
        scope.characterId,
        entry.title,
        entry.detail,
        entry.category,
        ...entry.keywords,
        ...entry.evidence,
      ])),
  };

  preparedSnapshotCache.set(snapshot, preparedSnapshot);
  return preparedSnapshot;
}

function filterSessionMemories(
  items: Record<SessionMemoryStatusFilter, SortedItems<PreparedSessionMemoryItem>>,
  { searchText, sessionStatus, sort }: Pick<MemoryManagementViewFilters, "searchText" | "sessionStatus" | "sort">,
): ManagedSessionMemoryItem[] {
  const candidates = items[sessionStatus][sort];
  if (!searchText) {
    return candidates.map(({ item }) => item);
  }

  return candidates
    .filter((item) => matchesSearch(item.searchKey, searchText))
    .map((item) => item.item);
}

function filterGroupedMemories<TScope, TEntry extends { category: TCategory }, TCategory extends string>(
  groups: PreparedGroupCollection<TScope, TEntry, TCategory>,
  {
    searchText,
    category,
    sort,
  }: {
    searchText: string;
    category: TCategory | "all";
    sort: MemoryManagementSort;
  },
): MaterializedGroup<TScope, TEntry>[] {
  if (!searchText) {
    if (category === "all") {
      return groups.groupsBySort[sort];
    }
    return groups.groupsByCategory.get(category)?.[sort] ?? [];
  }

  return groups.groups
    .flatMap((group) => {
      const sourceEntries = category === "all"
        ? group.entries[sort]
        : (group.entriesByCategory.get(category)?.[sort] ?? []);
      const entries = sourceEntries.filter((entry) => matchesSearch(entry.searchKey, searchText));
      if (entries.length === 0) {
        return [];
      }

      return [{
        scope: group.scope,
        entries: entries.map((entry) => entry.entry),
        updatedAtMs: entries[0].updatedAtMs,
      }];
    })
    .sort((left, right) => {
      const delta = left.updatedAtMs - right.updatedAtMs;
      return sort === "updated-asc" ? delta : -delta;
    })
    .map(({ scope, entries }) => ({ scope, entries }));
}

function filterProjectMemories(
  groups: PreparedGroupCollection<ManagedProjectMemoryGroup["scope"], ProjectMemoryEntry, ProjectMemoryCategory>,
  { searchText, projectCategory, sort }: Pick<MemoryManagementViewFilters, "searchText" | "projectCategory" | "sort">,
): ManagedProjectMemoryGroup[] {
  return filterGroupedMemories(groups, {
    searchText,
    category: projectCategory,
    sort,
  });
}

function filterCharacterMemories(
  groups: PreparedGroupCollection<ManagedCharacterMemoryGroup["scope"], CharacterMemoryEntry, CharacterMemoryCategory>,
  { searchText, characterCategory, sort }: Pick<MemoryManagementViewFilters, "searchText" | "characterCategory" | "sort">,
): ManagedCharacterMemoryGroup[] {
  return filterGroupedMemories(groups, {
    searchText,
    category: characterCategory,
    sort,
  });
}

export function buildFilteredMemoryManagementSnapshot(
  snapshot: MemoryManagementSnapshot | null,
  filters: MemoryManagementViewFilters,
): MemoryManagementSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const preparedSnapshot = getPreparedSnapshot(snapshot);
  const searchText = normalizeSearchText(filters.searchText);
  const includeSession = filters.domain === "all" || filters.domain === "session";
  const includeProject = filters.domain === "all" || filters.domain === "project";
  const includeCharacter = filters.domain === "all" || filters.domain === "character";

  return {
    sessionMemories: includeSession
      ? filterSessionMemories(preparedSnapshot.sessionMemoriesByStatus, {
          searchText,
          sessionStatus: filters.sessionStatus,
          sort: filters.sort,
        })
      : [],
    projectMemories: includeProject
      ? filterProjectMemories(preparedSnapshot.projectMemories, {
          searchText,
          projectCategory: filters.projectCategory,
          sort: filters.sort,
        })
      : [],
    characterMemories: includeCharacter
      ? filterCharacterMemories(preparedSnapshot.characterMemories, {
          searchText,
          characterCategory: filters.characterCategory,
          sort: filters.sort,
        })
      : [],
  };
}
