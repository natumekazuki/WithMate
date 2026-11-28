import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";

/** 送信元 Turn の終了待ちで配送できない受付だけを、実行中の待機と状態不明に分ける。 */
export function getQueuedSourceWaitState(
  receipt?: SessionTurnQueueReceipt,
): "waiting" | "unknown" | null {
  const origin = receipt?.accepted?.origin ?? receipt?.captured.origin;
  if (
    receipt?.state !== "queued" ||
    origin?.deliveryTiming !== "after_source_turn"
  )
    return null;
  const phase = receipt.sourceTurnPhase;
  if (phase === undefined || phase === "unknown") return "unknown";
  return receipt.sourceTurnPendingRelease || phase === "running"
    ? "waiting"
    : null;
}
