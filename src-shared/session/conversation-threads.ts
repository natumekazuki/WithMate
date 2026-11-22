import { z } from "zod";
import { sessionTargetSchema, type SessionTarget } from "./session-target.js";

const sequence = z.number().int().nonnegative();
export const conversationThreadsRequestSchema = z.object({ target: sessionTargetSchema }).strict();
export const conversationThreadsResultSchema = z.object({
  ok: z.literal(true),
  initialMessageIndexes: z.array(sequence),
  children: z.array(z.object({
    target: sessionTargetSchema,
    title: z.string(),
    messageIndexes: z.array(sequence),
    inboundTurnIds: z.array(z.string()),
    sentMessageIndexes: z.array(sequence),
  })),
});
export type ConversationThreads = Omit<z.infer<typeof conversationThreadsResultSchema>, "ok">;
export type ConversationThread = ConversationThreads["children"][number];

export function conversationPeerKey(target: SessionTarget): string {
  return JSON.stringify(target.kind === "main"
    ? [target.kind, target.sessionId, target.incarnationId]
    : [target.kind, target.sessionId, target.incarnationId, target.mainSessionId, target.mainIncarnationId]);
}
