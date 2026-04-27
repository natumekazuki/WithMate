import {
  createDefaultSessionMemory,
  normalizeCharacterMemoryEntry,
  normalizeCharacterScope,
  normalizeProjectMemoryEntry,
  normalizeProjectScope,
  type CharacterMemoryEntry,
  type CharacterScope,
  type ProjectMemoryEntry,
  type ProjectScope,
  type Session,
  type SessionMemory,
} from "../src/app-state.js";
import type { ResolvedProjectScopeInput } from "./project-scope.js";

function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

export class SessionMemoryStorageV2Read {
  getSessionMemory(_sessionId: string): SessionMemory | null {
    return null;
  }

  listSessionMemories(): SessionMemory[] {
    return [];
  }

  upsertSessionMemory(memory: SessionMemory): SessionMemory {
    return memory;
  }

  ensureSessionMemory(session: Pick<Session, "id" | "workspacePath" | "threadId" | "taskTitle" | "taskSummary">): SessionMemory {
    return createDefaultSessionMemory(session);
  }

  deleteSessionMemory(_sessionId: string): void {
    return;
  }

  clearSessionMemories(): void {
    return;
  }

  close(): void {
    return;
  }
}

export class ProjectMemoryStorageV2Read {
  listProjectScopes(): ProjectScope[] {
    return [];
  }

  getProjectScopeById(_projectScopeId: string): ProjectScope | null {
    return null;
  }

  getProjectScopeByKey(_projectKey: string): ProjectScope | null {
    return null;
  }

  ensureProjectScope(input: ResolvedProjectScopeInput): ProjectScope {
    const now = currentIsoTimestamp();
    const normalized = normalizeProjectScope({
      id: `v2-readonly:${input.projectKey}`,
      projectType: input.projectType,
      projectKey: input.projectKey,
      workspacePath: input.workspacePath,
      gitRoot: input.gitRoot,
      gitRemoteUrl: input.gitRemoteUrl,
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
    });
    if (!normalized) {
      throw new Error("V2 read-only project scope の形式が不正だよ。");
    }
    return normalized;
  }

  listProjectMemoryEntries(_projectScopeId: string): ProjectMemoryEntry[] {
    return [];
  }

  deleteProjectMemoryEntry(_entryId: string): void {
    return;
  }

  markProjectMemoryEntriesUsed(_entryIds: string[]): void {
    return;
  }

  upsertProjectMemoryEntry(
    input: Omit<ProjectMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt"> & { id?: string },
  ): ProjectMemoryEntry {
    const now = currentIsoTimestamp();
    const normalized = normalizeProjectMemoryEntry({
      ...input,
      id: input.id ?? `v2-readonly:${input.projectScopeId}:${input.category}:${input.title}`,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
    if (!normalized) {
      throw new Error("V2 read-only project memory entry の形式が不正だよ。");
    }
    return normalized;
  }

  clearProjectMemories(): void {
    return;
  }

  close(): void {
    return;
  }
}

export class CharacterMemoryStorageV2Read {
  listCharacterScopes(): CharacterScope[] {
    return [];
  }

  getCharacterScopeById(_characterScopeId: string): CharacterScope | null {
    return null;
  }

  getCharacterScopeByCharacterId(_characterId: string): CharacterScope | null {
    return null;
  }

  ensureCharacterScope(input: Pick<CharacterScope, "characterId" | "displayName">): CharacterScope {
    const now = currentIsoTimestamp();
    const normalized = normalizeCharacterScope({
      id: `v2-readonly:${input.characterId}`,
      characterId: input.characterId,
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
    });
    if (!normalized) {
      throw new Error("V2 read-only character scope の形式が不正だよ。");
    }
    return normalized;
  }

  listCharacterMemoryEntries(_characterScopeId: string): CharacterMemoryEntry[] {
    return [];
  }

  deleteCharacterMemoryEntry(_entryId: string): void {
    return;
  }

  markCharacterMemoryEntriesUsed(_entryIds: string[]): void {
    return;
  }

  upsertCharacterMemoryEntry(
    input: Omit<CharacterMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt"> & { id?: string },
  ): CharacterMemoryEntry {
    const now = currentIsoTimestamp();
    const normalized = normalizeCharacterMemoryEntry({
      ...input,
      id: input.id ?? `v2-readonly:${input.characterScopeId}:${input.category}:${input.title}`,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
    if (!normalized) {
      throw new Error("V2 read-only character memory entry の形式が不正だよ。");
    }
    return normalized;
  }

  clearCharacterMemories(): void {
    return;
  }

  close(): void {
    return;
  }
}
