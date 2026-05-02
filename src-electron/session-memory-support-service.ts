import {
  createDefaultSessionMemory,
  type CharacterMemoryDelta,
  type CharacterMemoryEntry,
  type CharacterReflectionMonologue,
  type ProjectMemoryEntry,
  type Session,
  type SessionMemory,
  type SessionMemoryDelta,
} from "../src/app-state.js";
import { currentTimestampLabel } from "../src/time-state.js";
import { buildProjectMemoryPromotionEntries } from "./project-memory-promotion.js";
import { retrieveProjectMemoryEntries } from "./project-memory-retrieval.js";
import { retrieveCharacterMemoryEntries } from "./character-memory-retrieval.js";
import { resolveProjectScope, type ResolvedProjectScopeInput } from "./project-scope.js";
import type { Awaitable } from "./persistent-store-lifecycle-service.js";

export type SessionMemorySupportServiceDeps = {
  getSessionMemory(sessionId: string): SessionMemory | null;
  ensureSessionMemory(session: Session): SessionMemory;
  upsertSessionMemory(memory: SessionMemory): void;
  ensureProjectScope(scope: ResolvedProjectScopeInput): { id: string };
  listProjectMemoryEntries(projectScopeId: string): ProjectMemoryEntry[];
  upsertProjectMemoryEntry(
    entry: Omit<ProjectMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt"> & { id?: string },
  ): ProjectMemoryEntry;
  markProjectMemoryEntriesUsed(entryIds: string[]): void;
  ensureCharacterScope(input: { characterId: string; displayName: string }): { id: string };
  listCharacterMemoryEntries(characterScopeId: string): CharacterMemoryEntry[];
  upsertCharacterMemoryEntry(
    entry: Omit<CharacterMemoryEntry, "id" | "createdAt" | "updatedAt" | "lastUsedAt"> & { id?: string },
  ): CharacterMemoryEntry;
  markCharacterMemoryEntriesUsed(entryIds: string[]): void;
  upsertSession(session: Session): Awaitable<Session>;
};

export class SessionMemorySupportService {
  constructor(private readonly deps: SessionMemorySupportServiceDeps) {}

  syncSessionDependencies(session: Session): void {
    const existingMemory = this.deps.getSessionMemory(session.id);
    if (existingMemory) {
      this.deps.upsertSessionMemory({
        ...existingMemory,
        workspacePath: session.workspacePath,
        threadId: session.threadId,
        goal: existingMemory.goal.trim() ? existingMemory.goal : createDefaultSessionMemory(session).goal,
      });
    }
    this.ensureProjectScope(session);
    this.ensureCharacterScope(session);
  }

  resolveProjectMemoryEntriesForPrompt(
    session: Session,
    userMessage: string,
    sessionMemory: SessionMemory,
  ): ProjectMemoryEntry[] {
    const projectScope = this.ensureProjectScope(session);
    const entries = this.deps.listProjectMemoryEntries(projectScope.id);
    const resolved = retrieveProjectMemoryEntries(entries, userMessage, sessionMemory);
    this.deps.markProjectMemoryEntriesUsed(resolved.map((entry) => entry.id));
    return resolved;
  }

  promoteSessionMemoryDeltaToProjectMemory(session: Session, delta: SessionMemoryDelta): number {
    const projectScope = this.ensureProjectScope(session);
    const entries = buildProjectMemoryPromotionEntries(session, projectScope.id, delta);
    for (const entry of entries) {
      this.deps.upsertProjectMemoryEntry(entry);
    }
    return entries.length;
  }

  resolveCharacterMemoryEntriesForReflection(session: Session): CharacterMemoryEntry[] {
    const characterScope = this.ensureCharacterScope(session);
    const entries = this.deps.listCharacterMemoryEntries(characterScope.id);
    return retrieveCharacterMemoryEntries(entries, session);
  }

  saveCharacterMemoryDelta(session: Session, entries: CharacterMemoryDelta["entries"]): number {
    if (entries.length === 0) {
      return 0;
    }

    const characterScope = this.ensureCharacterScope(session);
    for (const entry of entries) {
      this.deps.upsertCharacterMemoryEntry({
        characterScopeId: characterScope.id,
        sourceSessionId: session.id,
        category: entry.category,
        title: entry.title,
        detail: entry.detail,
        keywords: entry.keywords,
        evidence: entry.evidence,
      });
    }
    return entries.length;
  }

  markCharacterMemoryEntriesUsed(entryIds: string[]): void {
    this.deps.markCharacterMemoryEntriesUsed(entryIds);
  }

  async appendMonologueToSession(session: Session, monologue: CharacterReflectionMonologue): Promise<Session> {
    const nextStream = [
      ...session.stream,
      {
        mood: monologue.mood,
        time: currentTimestampLabel(),
        text: monologue.text,
      },
    ].slice(-30);

    return await this.deps.upsertSession({
      ...session,
      updatedAt: currentTimestampLabel(),
      stream: nextStream,
    });
  }

  private ensureProjectScope(session: Session): { id: string } {
    return this.deps.ensureProjectScope(resolveProjectScope(session.workspacePath));
  }

  private ensureCharacterScope(session: Session): { id: string } {
    return this.deps.ensureCharacterScope({
      characterId: session.characterId,
      displayName: session.character,
    });
  }
}
