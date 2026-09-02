import type { SessionWindowRestoreResult } from "../session-window-restore.js";

const FAILURE_LABELS = {
  missing: "削除済み",
  unreadable: "読込不能",
  "open-failed": "Windowを開けませんでした",
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
    .map(({ sessionId, reason }) => `${sessionId}（${FAILURE_LABELS[reason]}）`)
    .join("、");
  return `復元できなかったSession: ${failedTargets}`;
}
