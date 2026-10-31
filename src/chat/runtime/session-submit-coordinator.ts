import { getSessionIncarnationId, setMessageBookmarked, type Message, type Session } from "../../../src-shared/session/session-state.js";
import { getMessageHistoryIndex } from "../../../src-shared/session/conversation-page.js";

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

export function mergeRefetchedSessionProjection(
  current: Session | null,
  refreshed: Session,
  preserveCurrentPin: boolean,
): Session {
  return preserveCurrentPin && current?.id === refreshed.id && getSessionIncarnationId(current) === getSessionIncarnationId(refreshed)
    ? { ...refreshed, isPinned: current.isPinned, messages: mergeMessageBookmarkProjection(current.messages, refreshed.messages) }
    : refreshed;
}

export function mergeMessageBookmarkProjection(current: Message[], incoming: Message[]): Message[] {
  const currentByHistoryIndex = new Map(current.map((message, index) => [getMessageHistoryIndex(message, index), message]));
  return incoming.map((message, index) => {
    const projected = currentByHistoryIndex.get(getMessageHistoryIndex(message, index));
    return projected && projected.role === message.role && projected.text === message.text
      ? setMessageBookmarked(message, projected.isBookmarked === true)
      : message;
  });
}
