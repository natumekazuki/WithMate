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
