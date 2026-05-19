import {
  createDefaultSessionMemory,
  type ProjectMemoryEntry,
  type Session,
  type SessionMemory,
  type SessionMemoryDelta,
} from "../src/app-state.js";
import { buildProjectMemoryPromotionEntries } from "./project-memory-promotion.js";
import { retrieveProjectMemoryEntries } from "./project-memory-retrieval.js";
import { resolveProjectScope, type ResolvedProjectScopeInput } from "./project-scope.js";

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

  private ensureProjectScope(session: Session): { id: string } {
    return this.deps.ensureProjectScope(resolveProjectScope(session.workspacePath));
  }
}
