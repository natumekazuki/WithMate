import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import type { MessageListProjection } from "../auxiliary/auxiliary-session-message-projection.js";

export function projectSessionTurnQueue(history: MessageListProjection, receipts: readonly SessionTurnQueueReceipt[], owner: { sessionId: string; incarnationId: string }) {
  const owned = receipts.filter((receipt) => receipt.sessionId === owner.sessionId && receipt.incarnationId === owner.incarnationId)
    .sort((left, right) => left.sequence - right.sequence);
  const metadata = new Map<string, SessionTurnQueueReceipt>();
  const projection: MessageListProjection = { messages: [...history.messages], keys: [...history.keys], sources: [...history.sources], groups: [...history.groups] };
  const tail: SessionTurnQueueReceipt[] = [];
  for (const receipt of owned) {
    const savedIndex = receipt.userMessageSeq === null ? -1 : projection.sources.findIndex((source) => (source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId) && source.messageIndex === receipt.userMessageSeq);
    if (savedIndex >= 0) {
      if (receipt.state !== "completed" && receipt.state !== "canceled") metadata.set(projection.keys[savedIndex], receipt);
      continue;
    }
    const firstSaved = projection.sources.find((source) => source.kind === "session" || source.kind === "auxiliary" && source.sessionId === owner.sessionId);
    if (receipt.userMessageSeq !== null && (firstSaved?.kind === "session" || firstSaved?.kind === "auxiliary") && receipt.userMessageSeq < firstSaved.messageIndex) continue;
    if (receipt.state === "queued" || ((receipt.state === "failed" || receipt.state === "interrupted") && receipt.userMessageSeq === null)) {
      tail.push(receipt);
      continue;
    }
    if (receipt.state === "canceled" && receipt.userMessageSeq === null) continue;
    // A terminal notification must not drop the accepted prompt before its saved row arrives.
    const liveIndex = projection.sources.findIndex((source) => source.kind === "live-assistant");
    const index = liveIndex < 0 ? projection.messages.length : liveIndex;
    const key = `turn-queue-${receipt.incarnationId}-${receipt.id}`;
    projection.messages.splice(index, 0, { role: "user", text: receipt.captured.request.userMessage });
    projection.keys.splice(index, 0, key);
    projection.sources.splice(index, 0, { kind: "turn-queue", receipt });
    projection.groups.splice(index, 0, null);
    metadata.set(key, receipt);
  }
  return { projection, metadata, tail };
}
