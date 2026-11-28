import type { SessionWindowRestoreResult } from "../../src-shared/window/session-window-restore.js";

const FAILURE_LABELS = {
  missing: "Deleted",
  unreadable: "Unavailable",
  "open-failed": "Could not open window",
} as const;

/** 復元の候補から既に開いている Session を除き、未復元の ID を元の順に残す。 */
export function selectPendingSessionWindowRestoreIds(
  restoreSessionIds: readonly string[],
  openSessionIds: readonly string[],
): string[] {
  const openSessionIdSet = new Set(openSessionIds);
  return restoreSessionIds.filter(
    (sessionId) => !openSessionIdSet.has(sessionId),
  );
}

/** 復元できなかった Session ごとの ID と理由を表示し、全件成功なら空の案内を返す。 */
export function buildSessionWindowRestoreFeedback(
  result: SessionWindowRestoreResult,
): string {
  if (result.failures.length === 0) {
    return "";
  }
  const failedTargets = result.failures
    .map(({ sessionId, reason }) => `${sessionId} (${FAILURE_LABELS[reason]})`)
    .join(", ");
  return `Could not restore sessions: ${failedTargets}`;
}
