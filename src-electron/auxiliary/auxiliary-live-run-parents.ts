import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";

type AuxiliaryLiveRunParentsOptions = {
  getStorageOwner(): object | null;
  isRunPending(sessionId: string): boolean;
  hasLiveSessionRun(sessionId: string): boolean;
  broadcastLiveSessionRun(sessionId: string, state: LiveSessionRunState | null): void;
};

export class AuxiliaryLiveRunParents {
  private readonly parents = new Map<string, { parentSessionId: string; owner: object }>();

  public constructor(private readonly options: AuxiliaryLiveRunParentsOptions) {}

  public get size(): number {
    return this.parents.size;
  }

  public get(sessionId: string): string | undefined {
    const entry = this.parents.get(sessionId);
    return entry?.owner === this.options.getStorageOwner() ? entry.parentSessionId : undefined;
  }

  public hasPendingRunForParent(parentSessionId: string): boolean {
    const owner = this.options.getStorageOwner();
    for (const [sessionId, entry] of this.parents) {
      if (entry.owner === owner && entry.parentSessionId === parentSessionId
        && this.options.isRunPending(sessionId)) return true;
    }
    return false;
  }

  public remember(session: Pick<AuxiliarySession, "id" | "parentSessionId" | "status">, owner: object): void {
    if (owner !== this.options.getStorageOwner() || session.status !== "active"
      || !this.options.isRunPending(session.id)) return;
    this.parents.set(session.id, { parentSessionId: session.parentSessionId, owner });
  }

  public async trackRun<T>(
    session: Pick<AuxiliarySession, "id" | "parentSessionId" | "status">,
    owner: object,
    run: () => Promise<T>,
  ): Promise<T> {
    // Admission can publish cancellation before the first provider/session read.
    if (owner === this.options.getStorageOwner() && session.status === "active") {
      this.parents.set(session.id, { parentSessionId: session.parentSessionId, owner });
    }
    try {
      return await run();
    } finally {
      this.releaseIfUnused(session.id, owner);
    }
  }

  public delete(sessionId: string, owner: object): void {
    if (this.parents.get(sessionId)?.owner === owner) this.parents.delete(sessionId);
  }

  public releaseIfUnused(sessionId: string, owner: object): void {
    if (!this.options.isRunPending(sessionId) && !this.options.hasLiveSessionRun(sessionId)) {
      this.delete(sessionId, owner);
    }
  }

  public clear(): void {
    this.parents.clear();
  }

  public publish(sessionId: string, state: LiveSessionRunState | null, owner: object | null): void {
    if (owner !== this.options.getStorageOwner()) return;
    // Resolve and deliver the terminal null before releasing its parent association.
    this.options.broadcastLiveSessionRun(sessionId, state);
    if (owner) this.releaseIfUnused(sessionId, owner);
  }
}
