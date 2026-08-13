import type { LiveSessionRunState } from "./runtime-state.js";
import type { Session } from "./session-state.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";

export type SessionSubmitLease = {
  sessionId: string;
  release(): void;
};

export class SessionSubmitCoordinator {
  private readonly claims = new Map<string, symbol>();

  tryAcquire(sessionId: string): SessionSubmitLease | null {
    if (this.claims.has(sessionId)) {
      return null;
    }

    const claim = Symbol(sessionId);
    this.claims.set(sessionId, claim);
    let released = false;
    return {
      sessionId,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.claims.get(sessionId) === claim) {
          this.claims.delete(sessionId);
        }
      },
    };
  }

  isClaimed(sessionId: string): boolean {
    return this.claims.has(sessionId);
  }
}

export class LatestRequestRevision {
  private revision = 0;

  start(): number {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

export class StateMutationRevision {
  private revision = 0;

  capture(): number {
    return this.revision;
  }

  advance(): void {
    this.revision += 1;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

export function createSessionTurnClientRequestId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUuid) {
    return randomUuid();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function fingerprintSessionDraft(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function mergeRejectedSessionDraft(submittedDraft: string, currentDraft: string): string {
  if (!currentDraft.trim()) {
    return submittedDraft;
  }
  if (currentDraft === submittedDraft) {
    return currentDraft;
  }
  return `${submittedDraft}\n\n${currentDraft}`;
}

export function mergeRefetchedSessionProjection(
  current: Session | null,
  refreshed: Session,
  preserveCurrentPin: boolean,
): Session {
  return preserveCurrentPin && current?.id === refreshed.id
    ? { ...refreshed, isPinned: current.isPinned }
    : refreshed;
}

export function convergeResolvedSessionProjection(
  current: Session | null,
  saved: Session,
  preserveCurrentPin: boolean,
): Session {
  return mergeRefetchedSessionProjection(current, saved, preserveCurrentPin);
}

export function recoverRejectedSessionSnapshot(
  current: Session | null,
  optimistic: Session,
  canReplaceOptimisticBody: boolean,
): Session | null {
  if (!canReplaceOptimisticBody || !current || current.id !== optimistic.id) {
    return current;
  }
  return {
    ...optimistic,
    isPinned: current.isPinned,
    status: "idle",
    runState: "error",
  };
}

export function convergeRejectedSessionSnapshot(
  current: Session | null,
  optimistic: Session,
  refreshed: Session | null,
  canReplaceOptimisticBody: boolean,
  preserveCurrentPin: boolean,
): Session | null {
  if (!canReplaceOptimisticBody || !current || current.id !== optimistic.id) {
    return current;
  }
  return refreshed
    ? mergeRefetchedSessionProjection(current, refreshed, preserveCurrentPin)
    : null;
}

export function convergeRejectedLiveRunState(
  current: OwnedLiveSessionRunState,
  sessionId: string,
  refreshed: LiveSessionRunState | null,
  optimisticRevision: number,
  currentRevision: number,
): OwnedLiveSessionRunState {
  if (current.ownerSessionId !== sessionId || currentRevision !== optimisticRevision) {
    return current;
  }
  return {
    ownerSessionId: sessionId,
    state: refreshed,
  };
}
