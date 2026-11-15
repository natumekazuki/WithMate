import { z } from "zod";

const id = z.string().trim().min(1).max(256);
export const sessionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("main"), sessionId: id, incarnationId: id })
    .strict(),
  z
    .object({
      kind: z.literal("auxiliary"),
      sessionId: id,
      incarnationId: id,
      mainSessionId: id,
      mainIncarnationId: id,
    })
    .strict(),
]);
export type SessionTarget = z.infer<typeof sessionTargetSchema>;
