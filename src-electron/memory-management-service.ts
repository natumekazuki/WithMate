import { cloneSessions, type Session } from "../src/app-state.js";
import {
  cloneMemoryManagementSnapshot,
  type ManagedCharacterMemoryGroup,
  type ManagedProjectMemoryGroup,
  type ManagedSessionMemoryItem,
  type MemoryManagementSnapshot,
} from "../src/memory-management-state.js";
import type { CharacterMemoryEntry, CharacterScope, ProjectMemoryEntry, ProjectScope, SessionMemory } from "../src/memory-state.js";

type MemoryManagementServiceDeps = {
  listSessions(): Session[];
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
    const sessions = cloneSessions(this.deps.listSessions());
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
