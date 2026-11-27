import { z } from "zod";
import { sessionTargetSchema } from "./session-target.js";

const turnId = z.string().regex(/^[1-9]\d*$/);
export const sessionReplySchema = z.union([
  z.object({ target: sessionTargetSchema, seq: z.number().int().nonnegative(), finalAnswerTurnId: turnId.optional() }).strict(),
  z.object({ target: sessionTargetSchema, receiptId: z.string().uuid() }).strict(),
]);
export type SessionReply = z.infer<typeof sessionReplySchema>;

export function savedFinalAnswerTurnId(message: { role: string; turn: unknown }): string | undefined {
  const turn = message.turn;
  if (message.role !== "assistant" || typeof turn !== "object" || !turn || !("id" in turn)
    || !("phase" in turn) || turn.phase !== "completed") return undefined;
  const id = String(turn.id);
  return turnId.safeParse(id).success ? id : undefined;
}
