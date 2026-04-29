import type { Session, SessionSummary } from "../src/session-state.js";

type SessionSummaryHydrationSource = {
  listSessionSummaries(): SessionSummary[];
  getSession(sessionId: string): Session | null;
};

export function sessionSummaryToSession(summary: SessionSummary): Session {
  return {
    ...summary,
    messages: [],
    stream: [],
  };
}

export function sessionSummariesToSessions(summaries: SessionSummary[]): Session[] {
  return summaries.map(sessionSummaryToSession);
}

export function hydrateSessionsFromSummaries(source: SessionSummaryHydrationSource): Session[] {
  return source.listSessionSummaries()
    .map((summary) => source.getSession(summary.id))
    .filter((session): session is Session => session !== null);
}
