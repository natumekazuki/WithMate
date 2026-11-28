import { z } from "zod";

const id = z.string().trim().min(1).max(256);
/** Mainを指定するには、保存IDとその個体を識別するincarnation IDを両方要求する。 */
export const mainSessionTargetSchema = z
  .object({ kind: z.literal("main"), sessionId: id, incarnationId: id })
  .strict();
/** MainとAuxiliaryを区別し、Auxiliaryには所属するMainの個体も要求する。 */
export const sessionTargetSchema = z.discriminatedUnion("kind", [
  mainSessionTargetSchema,
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
/** 保存IDだけでは区別できない再作成を考慮したSession操作の宛先。 */
export type SessionTarget = z.infer<typeof sessionTargetSchema>;
/** Auxiliaryを対象にできない操作が受け付けるMain専用の宛先。 */
export type MainSessionTarget = z.infer<typeof mainSessionTargetSchema>;
