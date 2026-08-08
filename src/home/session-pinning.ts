import type { SessionSummary } from "../session-state.js";

export function mergePinnedSessionSummary(
  summaries: readonly SessionSummary[],
  saved: SessionSummary,
): SessionSummary[] {
  return summaries.map((session) => (
    session.id === saved.id
      ? { ...session, isPinned: saved.isPinned }
      : session
  ));
}
