import { z } from "zod";
import { sessionTargetSchema } from "./session-target.js";

const turnId = z.string().regex(/^[1-9]\d*$/);
/** 返信先を、保存メッセージの連番、または配送の受付UUIDのいずれかで指定する。 */
export const sessionReplySchema = z.union([
  z
    .object({
      target: sessionTargetSchema,
      seq: z.number().int().nonnegative(),
      finalAnswerTurnId: turnId.optional(),
    })
    .strict(),
  z
    .object({ target: sessionTargetSchema, receiptId: z.string().uuid() })
    .strict(),
]);
/** 保存されたSessionの個体と、そのうち返信するメッセージまたは受付を示す。 */
export type SessionReply = z.infer<typeof sessionReplySchema>;

/** 保存済みの完了したアシスタントメッセージから、正の十進数表記のTurn IDだけを採用する。 */
export function savedFinalAnswerTurnId(message: {
  role: string;
  turn: unknown;
}): string | undefined {
  const turn = message.turn;
  if (
    message.role !== "assistant" ||
    typeof turn !== "object" ||
    !turn ||
    !("id" in turn) ||
    !("phase" in turn) ||
    turn.phase !== "completed"
  )
    return undefined;
  const id = String(turn.id);
  return turnId.safeParse(id).success ? id : undefined;
}
