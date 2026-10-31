import type { UnreadSessionResult } from "../../src-shared/session/session-turn-state.js";
import type { SessionTurnTerminalCommit } from "./session-turn-terminal-commit.js";

export class SessionResultReadService {
  private readonly results = new Map<string, { result: UnreadSessionResult; unread: boolean }>();

  constructor(private readonly onChanged: (sessionId: string) => void) {}

  recordResult(commit: SessionTurnTerminalCommit): void {
    if ((this.results.get(commit.sessionId)?.result.turnId ?? 0) >= commit.turnId) return;
    this.results.set(commit.sessionId, {
      result: { turnId: commit.turnId, assistantMessageSeq: commit.assistantMessageSeq }, unread: true,
    });
    this.onChanged(commit.sessionId);
  }

  getUnreadResult(sessionId: string): UnreadSessionResult | null {
    const entry = this.results.get(sessionId);
    return entry?.unread ? { ...entry.result } : null;
  }

  markRead(sessionId: string, turnId: number): boolean {
    const entry = this.results.get(sessionId);
    if (!entry?.unread || entry.result.turnId !== turnId) return false;
    entry.unread = false;
    this.onChanged(sessionId);
    return true;
  }

  clear(): void {
    this.results.clear();
  }
}
