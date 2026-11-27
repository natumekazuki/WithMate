import type { SessionReply } from "../../src-shared/session/session-reply.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";

/** A normal Agent send can reply only to the actual sender of its own saved starting input. */
export function initiatingReply(source: SessionTarget, recipient: Pick<SessionTarget, "kind" | "sessionId" | "incarnationId">,
  turnId: string, receipts: readonly SessionTurnQueueReceipt[]): SessionReply | undefined {
  const entries = receipts.filter((entry) => entry.sessionId === source.sessionId && entry.incarnationId === source.incarnationId
    && entry.turnId === turnId && entry.inputTurnId == null && entry.userMessageSeq !== null && entry.state === "running");
  if (entries.length !== 1) return undefined;
  const [entry] = entries;
  const origin = entry.dispatched?.origin;
  if (origin?.kind !== "session" || origin.actorKind !== recipient.kind || origin.actorSessionId !== recipient.sessionId
    || origin.actorIncarnationId !== recipient.incarnationId || origin.targetSessionId !== source.sessionId
    || origin.targetIncarnationId !== source.incarnationId || entry.userMessageSeq === null) return undefined;
  return { target: source, seq: entry.userMessageSeq };
}
