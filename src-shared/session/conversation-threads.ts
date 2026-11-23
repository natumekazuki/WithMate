import { z } from "zod";
import { mainSessionTargetSchema, sessionTargetSchema, type MainSessionTarget, type SessionTarget } from "./session-target.js";
import type { SessionReply } from "./session-reply.js";

const sequence = z.number().int().nonnegative();
/** null selects the initial frame; a Main target selects that exact direct peer. ALL is not a thread. */
export const mainConversationThreadSchema = mainSessionTargetSchema.nullable();
export const conversationThreadsRequestSchema = z.object({ target: sessionTargetSchema }).strict();
export const conversationThreadsResultSchema = z.object({
  ok: z.literal(true),
  initialMessageIndexes: z.array(sequence),
  children: z.array(z.object({
    target: sessionTargetSchema,
    title: z.string(),
    character: z.object({ name: z.string(), iconPath: z.string() }).optional(),
    isProcessing: z.boolean().optional(),
    lastActivityAt: z.number().int().optional(),
    hasUnreadResult: z.boolean().optional(),
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

/** Resolve a saved message's frame, not a sent-card overlay. Undefined means not represented here. */
export function savedReplyConversationFrame(main: MainSessionTarget, threads: ConversationThreads | undefined, reply: SessionReply | undefined): MainSessionTarget | null | undefined {
  if (!threads || !reply || !("seq" in reply) || conversationPeerKey(reply.target) !== conversationPeerKey(main)) return undefined;
  return savedMessageConversationFrame(threads, reply.seq);
}

export function savedMessageConversationFrame(threads: ConversationThreads, seq: number): MainSessionTarget | null | undefined {
  const matches = threads.children.filter((child) => child.messageIndexes.includes(seq));
  const initial = threads.initialMessageIndexes.includes(seq);
  if (matches.length + Number(initial) !== 1) return undefined;
  if (initial) return null;
  const target = matches[0].target;
  return target.kind === "main" ? target : undefined;
}
