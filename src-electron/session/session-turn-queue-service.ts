import type {
  SessionTurnQueueCapturedInput,
  SessionTurnQueueOwner,
  SessionTurnQueueReceipt,
  SessionTurnQueueStore,
} from "../../src-shared/session/session-turn-queue.js";

export type SessionTurnQueueDispatchResult = {
  state: "completed" | "failed" | "canceled";
  reason?: string;
};

export type SessionTurnQueueServiceDeps = {
  store: SessionTurnQueueStore;
  isRunInFlight(sessionId: string): boolean;
  dispatch(
    receipt: SessionTurnQueueReceipt,
    onStarted: (input: { turnId: string; userMessageSeq: number }) => Promise<void>,
  ): Promise<SessionTurnQueueDispatchResult>;
  onChanged?(owner: SessionTurnQueueOwner): void;
};

export class SessionTurnQueueService {
  private readonly owners = new Map<string, SessionTurnQueueOwner>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly drains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly blocked = new Set<string>();
  private readonly lastClaim = new Map<string, SessionTurnQueueReceipt>();
  private readonly wakeRequested = new Set<string>();
  private closing = false;
  private closed = false;

  constructor(private readonly deps: SessionTurnQueueServiceDeps) {}

  async start(): Promise<void> {
    this.requireAccepting();
    await this.track((async () => {
      await this.deps.store.recoverInterrupted();
      const owners = await this.deps.store.listPendingOwners();
      for (const owner of owners) {
        this.adoptOwner(owner);
        this.notify(owner);
        this.wake(owner.sessionId);
      }
    })());
  }

  enqueue(owner: SessionTurnQueueOwner, captured: SessionTurnQueueCapturedInput): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      const receipt = await this.deps.store.enqueue(owner, captured);
      this.adoptOwner(owner);
      this.notify(owner);
      this.wake(owner.sessionId);
      return receipt;
    }));
  }

  reconcileKnownReceipt(receipt: SessionTurnQueueReceipt): void {
    this.adoptOwner(receipt);
    if (this.lastClaim.get(receipt.sessionId)?.id === receipt.id && isConfirmedTerminal(receipt)) {
      this.blocked.delete(receipt.sessionId);
    }
    this.notify(receipt);
    this.wake(receipt.sessionId);
  }

  cancelQueued(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      const receipt = await this.deps.store.cancelQueued(owner, id);
      if (this.isCurrentOwner(owner)) {
        this.notify(owner);
        this.wake(owner.sessionId);
      }
      return receipt;
    }));
  }

  releaseInterrupted(owner: SessionTurnQueueOwner, id: string): Promise<SessionTurnQueueReceipt> {
    this.requireAccepting();
    return this.track(this.withLock(owner.sessionId, async () => {
      const claimed = this.isCurrentOwner(owner) ? this.lastClaim.get(owner.sessionId) : undefined;
      const current = claimed?.id === id ? await this.deps.store.getReceipt(owner, claimed.requestId) : null;
      const receipt = current && isConfirmedTerminal(current)
        ? current
        : await this.deps.store.releaseInterrupted(owner, id, { runReleased: !this.deps.isRunInFlight(owner.sessionId) });
      if (this.isCurrentOwner(owner)) {
        this.blocked.delete(owner.sessionId);
        this.notify(owner);
        this.wake(owner.sessionId);
      }
      return receipt;
    }));
  }

  wake(sessionId: string): void {
    const owner = this.owners.get(sessionId);
    if (this.closing || this.blocked.has(sessionId) || !owner) return;
    if (this.drains.has(sessionId)) {
      this.wakeRequested.add(sessionId);
      return;
    }
    const drain = this.track(this.drain(owner).catch(() => {
      // A claim or terminal commit may have succeeded before its reply failed.
      // Never retry an unknown dispatch or advance its followers automatically.
      if (this.isCurrentOwner(owner)) this.blocked.add(sessionId);
    }));
    this.drains.set(sessionId, drain);
    void drain.then(() => {
      if (this.drains.get(sessionId) !== drain) return;
      this.drains.delete(sessionId);
      if (this.wakeRequested.delete(sessionId)) this.wake(sessionId);
    });
  }

  beginShutdown(): void {
    this.closing = true;
    this.wakeRequested.clear();
  }

  async waitForPending(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  resume(): void {
    if (this.closed) return;
    this.closing = false;
    for (const sessionId of this.owners.keys()) this.wake(sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.beginShutdown();
    await this.waitForPending();
  }

  private async drain(owner: SessionTurnQueueOwner): Promise<void> {
    const { sessionId } = owner;
    while (!this.closing && this.isCurrentOwner(owner) && !this.blocked.has(sessionId)) {
      const receipt = await this.withLock(sessionId, async () => {
        if (this.closing || !this.isCurrentOwner(owner) || this.blocked.has(sessionId) || this.deps.isRunInFlight(sessionId)) return null;
        const active = await this.deps.store.listActive(owner);
        if (this.closing || !this.isCurrentOwner(owner) || this.deps.isRunInFlight(sessionId)) return null;
        for (const released of active) {
          if (released.state !== "interrupted" || released.releasedAt === null) continue;
          await this.deps.store.releaseInterrupted(owner, released.id, { runReleased: true });
          if (this.closing || !this.isCurrentOwner(owner) || this.deps.isRunInFlight(sessionId)) return null;
        }
        return this.deps.store.claimNext(owner);
      });
      if (!receipt || !this.isCurrentOwner(owner)) return;
      this.lastClaim.set(sessionId, receipt);
      this.notify(receipt);
      // A committed claim is admitted work, including when shutdown begins while
      // awaiting its reply. Shutdown waits for this dispatch and its terminal save.
      let result: SessionTurnQueueDispatchResult;
      try {
        result = await this.deps.dispatch(receipt, async (input) => {
          if (!this.isCurrentOwner(owner)) throw new Error("The queue owner changed before turn start.");
          await this.deps.store.markStarted(receipt, receipt.id, input);
          if (!this.isCurrentOwner(owner)) throw new Error("The queue owner changed during turn start.");
          this.notify(receipt);
        });
      } catch (error) {
        if (!this.isCurrentOwner(owner)) return;
        this.blocked.add(sessionId);
        this.notify(receipt);
        const canonical = await this.deps.store.settle(receipt, receipt.id, "interrupted", error instanceof Error ? error.message : "The execution outcome could not be confirmed.");
        if (!this.isCurrentOwner(owner)) return;
        this.notify(receipt);
        if (!isConfirmedTerminal(canonical)) return;
        this.blocked.delete(sessionId);
        if (this.deps.isRunInFlight(sessionId)) return;
        continue;
      }
      if (!this.isCurrentOwner(owner)) return;
      try {
        await this.deps.store.settle(receipt, receipt.id, result.state, result.reason);
      } catch {
        // Only canonical reads can resolve a lost commit reply; never repeat the
        // mutation or provider dispatch to manufacture a known outcome.
        if (!this.isCurrentOwner(owner)) return;
        this.blocked.add(sessionId);
        this.notify(receipt);
        const current = await this.deps.store.getReceipt(receipt, receipt.requestId);
        if (!this.isCurrentOwner(owner) || !current || !isConfirmedTerminal(current)) return;
        this.blocked.delete(sessionId);
      }
      if (!this.isCurrentOwner(owner)) return;
      this.notify(receipt);
      // A terminal response is not proof that provider/setup/terminal guards
      // have been released. The runtime's actual release signal wakes this loop.
      if (this.deps.isRunInFlight(sessionId)) return;
    }
  }

  private requireAccepting(): void {
    if (this.closing) throw new Error("Session turn queue is shutting down.");
  }

  private isCurrentOwner(owner: SessionTurnQueueOwner): boolean {
    return this.owners.get(owner.sessionId)?.incarnationId === owner.incarnationId;
  }

  private adoptOwner(owner: SessionTurnQueueOwner): void {
    if (!this.isCurrentOwner(owner)) {
      this.blocked.delete(owner.sessionId);
      this.lastClaim.delete(owner.sessionId);
    }
    this.owners.set(owner.sessionId, { ...owner });
  }

  private notify(owner: SessionTurnQueueOwner): void {
    try {
      this.deps.onChanged?.({ sessionId: owner.sessionId, incarnationId: owner.incarnationId });
    } catch {
      // Durable acceptance and queue progress do not depend on projection observers.
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  private withLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run);
    const released = next.then(() => undefined, () => undefined);
    this.locks.set(sessionId, released);
    void released.then(() => {
      if (this.locks.get(sessionId) === released) this.locks.delete(sessionId);
    });
    return next;
  }
}

function isConfirmedTerminal(receipt: SessionTurnQueueReceipt): boolean {
  return receipt.state === "completed" || receipt.state === "failed" || receipt.state === "canceled";
}
