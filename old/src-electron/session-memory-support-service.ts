import {
  createDefaultSessionMemory,
  type Session,
  type SessionMemory,
} from "../src/app-state.js";
import { resolveProjectScope, type ResolvedProjectScopeInput } from "./project-scope.js";

export type SessionMemorySupportServiceDeps = {
  getSessionMemory(sessionId: string): SessionMemory | null;
  upsertSessionMemory(memory: SessionMemory): void;
  ensureProjectScope(scope: ResolvedProjectScopeInput): { id: string };
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

  private ensureProjectScope(session: Session): { id: string } {
    return this.deps.ensureProjectScope(resolveProjectScope(session.workspacePath));
  }
}
