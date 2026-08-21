export type CoordinationFeedRequestToken = Readonly<{
  sessionId: string;
  revision: number;
}>;

export class CoordinationFeedRequestGate {
  private sessionId: string | null = null;
  private revision = 0;

  selectSession(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.revision += 1;
  }

  selectedSessionId(): string | null {
    return this.sessionId;
  }

  isSelected(sessionId: string): boolean {
    return this.sessionId === sessionId;
  }

  begin(sessionId: string): CoordinationFeedRequestToken | null {
    if (this.sessionId !== sessionId) return null;
    return { sessionId, revision: ++this.revision };
  }

  isCurrent(token: CoordinationFeedRequestToken): boolean {
    return token.sessionId === this.sessionId && token.revision === this.revision;
  }
}
