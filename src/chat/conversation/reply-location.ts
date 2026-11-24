import { conversationPeerKey, type ConversationThreads } from "../../../src-shared/session/conversation-threads.js";
import type { SessionTarget } from "../../../src-shared/session/session-target.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { ResolvedReply } from "./reply-quote.js";
import type { SentInstructionCard } from "../../../src-shared/session/session-execution-read.js";
import { sentInstructionKey } from "./use-sent-deliveries.js";

export type ReplyLocation = {
  column: "main" | "auxiliary";
  ownerKey: string;
  frameId: string;
  seq: number;
  sentKey?: string;
};

export type ReplyLocationScope = {
  main?: SessionTarget;
  auxiliary?: SessionTarget;
  threads?: ConversationThreads;
};

type ReadApi = Pick<WithMateWindowApi, "readSessionExecution" | "getConversationPage">;

export function replyLocationIsProjected(scope: ReplyLocationScope, location: ReplyLocation): boolean {
  const owner = scope[location.column];
  if (!owner || conversationPeerKey(owner) !== location.ownerKey) return false;
  if (location.column === "auxiliary") return true;
  if (!location.frameId) return !location.sentKey && (scope.threads?.initialMessageIndexes.includes(location.seq) ?? false);
  const frame = scope.threads?.children.find((child) => conversationPeerKey(child.target) === location.frameId);
  return (location.sentKey ? frame?.sentMessageIndexes : frame?.messageIndexes)?.includes(location.seq) ?? false;
}

/** A rendered item already comes from the authorized, batched source read. */
export function locateSentInstruction(scope: ReplyLocationScope, source: SessionTarget, item: SentInstructionCard): ReplyLocation | null {
  const { main } = scope;
  const { origin, target, sourceMessageSeq: seq } = item;
  if (!main || main.kind !== "main" || source.kind !== "main" || target.kind !== "main"
    || conversationPeerKey(source) !== conversationPeerKey(main) || seq === null
    || origin.kind !== "session" || origin.operation !== ("receiptId" in item ? "send" : "steer")
    || origin.actorKind !== "main" || origin.actorSessionId !== main.sessionId || origin.actorIncarnationId !== main.incarnationId
    || origin.actorTurnId !== item.sourceTurnId
    || origin.targetSessionId !== target.sessionId || origin.targetIncarnationId !== target.incarnationId) return null;
  const location: ReplyLocation = {
    column: "main", ownerKey: conversationPeerKey(main), frameId: conversationPeerKey(target), seq, sentKey: sentInstructionKey(item),
  };
  return replyLocationIsProjected(scope, location) ? location : null;
}

/** Only saved targets represented in this Window can become navigation actions. */
export async function locateReply(api: ReadApi, ownerId: string, scope: ReplyLocationScope, quote: ResolvedReply): Promise<ReplyLocation | null> {
  const { reference, origin } = quote;
  const targetKey = conversationPeerKey(reference.target);
  const mainKey = scope.main && conversationPeerKey(scope.main);
  if ("seq" in reference) {
    const seq = reference.seq;
    let location: ReplyLocation;
    if (scope.main && scope.threads && targetKey === mainKey) {
      const frames = scope.threads.children.filter((child) => child.messageIndexes.includes(seq));
      const initial = scope.threads.initialMessageIndexes.includes(seq);
      if (frames.length + Number(initial) !== 1) return null;
      location = { column: "main", ownerKey: targetKey, frameId: initial ? "" : conversationPeerKey(frames[0].target), seq };
    } else if (scope.auxiliary && conversationPeerKey(scope.auxiliary) === targetKey) {
      location = { column: "auxiliary", ownerKey: targetKey, frameId: "", seq };
    } else return null;
    const page = await api.getConversationPage(reference.target.sessionId, { messageIndexes: [seq] });
    const source = page?.messages.find((message) => message.historyIndex === seq);
    // Confirm this is an independently rendered message, not an answer folded into a question.
    return page?.sessionId === reference.target.sessionId && page.incarnationId === reference.target.incarnationId
      && source && !(source.turnInput?.state === "confirmed" && source.turnInput.questionRequestId) ? location : null;
  }

  // The receipt is addressed to the child, but its visible card belongs to the sending Main.
  // The receiving Turn or a neighbouring sender message cannot substitute for that card.
  const main = scope.main;
  const child = scope.threads?.children.find((frame) => conversationPeerKey(frame.target) === targetKey);
  if (!main || !mainKey || !child || origin?.kind !== "session" || origin.operation !== "send" || origin.actorKind !== "main"
    || origin.actorSessionId !== main.sessionId || origin.actorIncarnationId !== main.incarnationId || !origin.actorTurnId
    || origin.targetSessionId !== reference.target.sessionId || origin.targetIncarnationId !== reference.target.incarnationId) return null;
  const turn = await api.readSessionExecution(ownerId, "get_execution", { target: main, turnId: origin.actorTurnId });
  if (!turn.ok || turn.turnId !== origin.actorTurnId) return null;
  const seq = turn.resultState === "saved" || turn.resultState === "partial" ? turn.assistantMessageSeq : turn.userMessageSeq;
  if (seq === null || !child.sentMessageIndexes.includes(seq)) return null;
  let cursor: number | undefined;
  do {
    const result = await api.readSessionExecution(ownerId, "list_sent_deliveries", {
      target: main, messageSeqs: [seq], cursor, limit: 20,
    });
    if (!result.ok) return null;
    if (result.items.some((item) => item.receiptId === reference.receiptId && conversationPeerKey(item.target) === targetKey
      && item.sourceTurnId === origin.actorTurnId && item.sourceMessageSeq === seq)) {
      return { column: "main", ownerKey: mainKey, frameId: targetKey, seq, sentKey: reference.receiptId };
    }
    if (result.nextCursor === null || (cursor !== undefined && result.nextCursor <= cursor)) return null;
    cursor = result.nextCursor;
  } while (true);
}
