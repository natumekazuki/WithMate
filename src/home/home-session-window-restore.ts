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
  if (result.requestedSessionIds.length === 0) {
    return "復元できる前回のSessionはありません。";
  }
  const opened = `${result.openedSessionIds.length}件のSessionを開きました。`;
  if (result.failures.length === 0) {
    return opened;
  }
  const failedTargets = result.failures
    .map(({ sessionId, reason }) => `${sessionId}（${FAILURE_LABELS[reason]}）`)
    .join("、");
  return `${opened} 復元できなかったSession: ${failedTargets}`;
}
