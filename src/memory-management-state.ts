import type { CharacterMemoryEntry, CharacterScope, ProjectMemoryEntry, ProjectScope, SessionMemory } from "./memory-state.js";
import type { CharacterMemoryCategory, ProjectMemoryCategory } from "./memory-state.js";
import type { Session } from "./session-state.js";

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

export type ManagedCharacterMemoryGroup = {
  scope: CharacterScope;
  entries: CharacterMemoryEntry[];
};

export type MemoryManagementSnapshot = {
  sessionMemories: ManagedSessionMemoryItem[];
  projectMemories: ManagedProjectMemoryGroup[];
  characterMemories: ManagedCharacterMemoryGroup[];
};

export type MemoryManagementDomain = "all" | "session" | "project" | "character";

export type MemoryManagementPageRequest = {
  domain?: MemoryManagementDomain;
  cursor?: number;
  limit?: number;
  searchText?: string;
  sort?: "updated-desc" | "updated-asc";
  sessionStatus?: "all" | "running" | "idle" | "saved";
  projectCategory?: "all" | ProjectMemoryCategory;
  characterCategory?: "all" | CharacterMemoryCategory;
};

export type MemoryManagementDomainPageInfo = {
  nextCursor: number | null;
  hasMore: boolean;
  total: number;
};

export type MemoryManagementPageResult = {
  snapshot: MemoryManagementSnapshot;
  pages: {
    session: MemoryManagementDomainPageInfo;
    project: MemoryManagementDomainPageInfo;
    character: MemoryManagementDomainPageInfo;
  };
};

export function buildMemoryManagementPageRequest(
  filters: Pick<
    MemoryManagementPageRequest,
    "domain" | "searchText" | "sort" | "sessionStatus" | "projectCategory" | "characterCategory"
  >,
  options?: { domain?: MemoryManagementDomain; cursor?: number | null; limit?: number },
): MemoryManagementPageRequest {
  return {
    domain: options?.domain ?? filters.domain ?? "all",
    cursor: options?.cursor ?? 0,
    limit: options?.limit,
    searchText: filters.searchText,
    sort: filters.sort,
    sessionStatus: filters.sessionStatus,
    projectCategory: filters.projectCategory,
    characterCategory: filters.characterCategory,
  };
}

export function cloneMemoryManagementSnapshot(snapshot: MemoryManagementSnapshot): MemoryManagementSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as MemoryManagementSnapshot;
}

export function mergeMemoryManagementSnapshots(
  current: MemoryManagementSnapshot | null,
  next: MemoryManagementSnapshot,
  domain: MemoryManagementDomain,
): MemoryManagementSnapshot {
  if (!current || domain === "all") {
    return cloneMemoryManagementSnapshot(next);
  }

  return cloneMemoryManagementSnapshot({
    sessionMemories: domain === "session"
      ? mergeSessionMemories(current.sessionMemories, next.sessionMemories)
      : current.sessionMemories,
    projectMemories: domain === "project"
      ? mergeGroupedMemories(current.projectMemories, next.projectMemories)
      : current.projectMemories,
    characterMemories: domain === "character"
      ? mergeGroupedMemories(current.characterMemories, next.characterMemories)
      : current.characterMemories,
  });
}

function mergeSessionMemories(
  currentItems: ManagedSessionMemoryItem[],
  nextItems: ManagedSessionMemoryItem[],
): ManagedSessionMemoryItem[] {
  const seen = new Set(currentItems.map((item) => item.sessionId));
  const merged = [...currentItems];

  for (const item of nextItems) {
    if (seen.has(item.sessionId)) {
      continue;
    }
    seen.add(item.sessionId);
    merged.push(item);
  }

  return merged;
}

function mergeGroupedMemories<TGroup extends { scope: { id: string }; entries: TEntry[] }, TEntry extends { id: string }>(
  currentGroups: TGroup[],
  nextGroups: TGroup[],
): TGroup[] {
  const groupById = new Map(currentGroups.map((group) => [group.scope.id, {
    group,
    entryIds: new Set(group.entries.map((entry) => entry.id)),
  }]));
  const merged: TGroup[] = currentGroups.map((group) => ({ ...group, entries: [...group.entries] }) as TGroup);

  for (const nextGroup of nextGroups) {
    const existing = groupById.get(nextGroup.scope.id);
    if (!existing) {
      merged.push(nextGroup);
      continue;
    }

    const target = merged.find((group) => group.scope.id === nextGroup.scope.id);
    if (!target) {
      continue;
    }

    for (const entry of nextGroup.entries) {
      if (existing.entryIds.has(entry.id)) {
        continue;
      }
      existing.entryIds.add(entry.id);
      target.entries.push(entry);
    }
  }

  return merged;
}

function removeGroupedEntry<
  TGroup extends { entries: TEntry[] },
  TEntry extends { id: string },
>(groups: TGroup[], entryId: string): TGroup[] {
  let changed = false;
  const nextGroups: TGroup[] = [];

  for (const group of groups) {
    const idx = group.entries.findIndex((entry) => entry.id === entryId);
    if (idx === -1) {
      nextGroups.push(group);
      continue;
    }

    changed = true;
    const nextEntries = group.entries.slice(0, idx).concat(group.entries.slice(idx + 1));
    if (nextEntries.length > 0) {
      nextGroups.push({
        ...group,
        entries: nextEntries,
      });
    }
  }

  return changed ? nextGroups : groups;
}

export function removeSessionMemoryFromSnapshot(
  snapshot: MemoryManagementSnapshot,
  sessionId: string,
): MemoryManagementSnapshot {
  const nextSessionMemories = snapshot.sessionMemories.filter((item) => item.sessionId !== sessionId);
  if (nextSessionMemories.length === snapshot.sessionMemories.length) {
    return snapshot;
  }

  return {
    ...snapshot,
    sessionMemories: nextSessionMemories,
  };
}

export function removeProjectMemoryEntryFromSnapshot(
  snapshot: MemoryManagementSnapshot,
  entryId: string,
): MemoryManagementSnapshot {
  const nextProjectMemories = removeGroupedEntry(snapshot.projectMemories, entryId);
  if (nextProjectMemories === snapshot.projectMemories) {
    return snapshot;
  }

  return {
    ...snapshot,
    projectMemories: nextProjectMemories,
  };
}

export function removeCharacterMemoryEntryFromSnapshot(
  snapshot: MemoryManagementSnapshot,
  entryId: string,
): MemoryManagementSnapshot {
  const nextCharacterMemories = removeGroupedEntry(snapshot.characterMemories, entryId);
  if (nextCharacterMemories === snapshot.characterMemories) {
    return snapshot;
  }

  return {
    ...snapshot,
    characterMemories: nextCharacterMemories,
  };
}
