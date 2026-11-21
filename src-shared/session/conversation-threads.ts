import { z } from "zod";
import { sessionTargetSchema, type SessionTarget } from "./session-target.js";

const sequence = z.number().int().nonnegative();
export const conversationThreadsRequestSchema = z.object({ target: sessionTargetSchema }).strict();
export const conversationThreadsResultSchema = z.object({
  ok: z.literal(true),
  threads: z.array(z.object({
    target: sessionTargetSchema,
    title: z.string(),
    messageIndexes: z.array(sequence),
    inboundTurnIds: z.array(z.string()),
    sent: z.array(z.object({ key: z.string(), messageIndex: sequence.nullable(), turnId: z.string() })),
  })),
});
export type ConversationThread = z.infer<typeof conversationThreadsResultSchema>["threads"][number];

export function conversationPeerKey(target: SessionTarget): string {
  return JSON.stringify(target.kind === "main"
    ? [target.kind, target.sessionId, target.incarnationId]
    : [target.kind, target.sessionId, target.incarnationId, target.mainSessionId, target.mainIncarnationId]);
}

/** Receipt and direct Steer are distinct identities even within one Turn. */
export function sentCardKey(item: { target: SessionTarget } & ({ receiptId: string } | { messageSeq: number })): string {
  return "receiptId" in item ? item.receiptId : `steer:${conversationPeerKey(item.target)}:${item.messageSeq}`;
}
