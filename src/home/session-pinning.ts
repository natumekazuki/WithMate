import type { HomeSessionSummary } from "../session-state.js";

export function mergePinnedSessionSummary(
  summaries: readonly HomeSessionSummary[],
  saved: HomeSessionSummary,
): HomeSessionSummary[] {
  return summaries.map((session) => (
    session.id === saved.id
      ? { ...session, isPinned: saved.isPinned }
      : session
  ));
}
