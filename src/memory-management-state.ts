import type { CharacterMemoryEntry, CharacterScope, ProjectMemoryEntry, ProjectScope, SessionMemory } from "./memory-state.js";
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

export function cloneMemoryManagementSnapshot(snapshot: MemoryManagementSnapshot): MemoryManagementSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as MemoryManagementSnapshot;
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
    const nextEntries = [...group.entries.slice(0, idx), ...group.entries.slice(idx + 1)];
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
