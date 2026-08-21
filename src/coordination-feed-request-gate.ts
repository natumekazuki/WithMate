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

export class CoordinationResolutionAttemptRegistry {
  private readonly attempts = new Map<string, Map<string, string>>();

  constructor(private readonly createKey: () => string = () => crypto.randomUUID()) {}

  getOrCreate(eventId: string, optionId: string): string {
    const eventAttempts = this.attempts.get(eventId) ?? new Map<string, string>();
    const existing = eventAttempts.get(optionId);
    if (existing) return existing;
    const key = this.createKey();
    eventAttempts.set(optionId, key);
    this.attempts.set(eventId, eventAttempts);
    return key;
  }

  settle(eventId: string): void {
    this.attempts.delete(eventId);
  }

  clear(): void {
    this.attempts.clear();
  }
}

export function reconcileCoordinationEventDetails<
  TSummary extends { eventId: string; state: string },
  TDetail extends { eventId: string; state: string },
>(
  summaries: readonly TSummary[],
  details: Readonly<Record<string, TDetail>>,
): Record<string, TDetail> {
  const currentStates = new Map(summaries.map((summary) => [summary.eventId, summary.state]));
  return Object.fromEntries(
    Object.entries(details).filter(([eventId, detail]) => currentStates.get(eventId) === detail.state),
  );
}
