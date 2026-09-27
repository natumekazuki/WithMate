import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { getSessionIncarnationId, type SessionSummary } from "../../src-shared/session/session-state.js";

type SelectionOwner = SessionSummary | AuxiliarySessionSummary;
type CurrentSelection = {
  identity: string;
  provider: string;
  parentSessionId: string | null;
  executionOptions: SessionExecutionOptions;
};

function ownerIdentity(owner: SelectionOwner): string {
  return "parentSessionId" in owner
    ? `${owner.parentSessionId}\0${owner.createdAt}`
    : getSessionIncarnationId(owner);
}

/** Current UI selections for one persistent-store generation, independent of checkpoints. */
export class CurrentExecutionSelections {
  private readonly entries = new Map<string, CurrentSelection>();

  remember(owner: SelectionOwner, executionOptions: SessionExecutionOptions): void {
    this.entries.delete(owner.id);
    this.entries.set(owner.id, {
      identity: ownerIdentity(owner),
      provider: owner.provider,
      parentSessionId: "parentSessionId" in owner ? owner.parentSessionId : null,
      executionOptions: { ...executionOptions },
    });
  }

  apply<T extends SelectionOwner>(owner: T): T {
    const current = this.entries.get(owner.id);
    return current && current.identity === ownerIdentity(owner) && current.provider === owner.provider
      ? { ...owner, ...current.executionOptions }
      : owner;
  }

  latestForProvider(provider: string): SessionExecutionOptions | null {
    const current = Array.from(this.entries.values()).reverse().find((entry) => entry.provider === provider);
    return current ? { ...current.executionOptions } : null;
  }

  retainParents(sessions: readonly SessionSummary[]): void {
    const owners = new Map(sessions.map((session) => [session.id, session]));
    for (const [id, entry] of this.entries) {
      const owner = owners.get(entry.parentSessionId ?? id);
      if (!owner || (!entry.parentSessionId && entry.identity !== ownerIdentity(owner))) {
        this.entries.delete(id);
      }
    }
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  forgetParent(id: string): void {
    for (const [key, entry] of this.entries) {
      if (key === id || entry.parentSessionId === id) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
