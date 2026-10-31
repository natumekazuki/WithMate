import type { SessionWindowRestoreResult } from "../../src-shared/window/session-window-restore.js";

const FAILURE_LABELS = {
  missing: "Deleted",
  unreadable: "Unavailable",
  "open-failed": "Could not open window",
} as const;

export function selectPendingSessionWindowRestoreIds(
  restoreSessionIds: readonly string[],
  openSessionIds: readonly string[],
): string[] {
  const openSessionIdSet = new Set(openSessionIds);
  return restoreSessionIds.filter((sessionId) => !openSessionIdSet.has(sessionId));
}

export function buildSessionWindowRestoreFeedback(result: SessionWindowRestoreResult): string {
  if (result.failures.length === 0) {
    return "";
  }
  const failedTargets = result.failures
    .map(({ sessionId, reason }) => `${sessionId} (${FAILURE_LABELS[reason]})`)
    .join(", ");
  return `Could not restore sessions: ${failedTargets}`;
}
