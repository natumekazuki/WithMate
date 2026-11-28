import { z } from "zod";
import {
  mainSessionTargetSchema,
  sessionTargetSchema,
  type MainSessionTarget,
  type SessionTarget,
} from "./session-target.js";
import type { SessionReply } from "./session-reply.js";

const sequence = z.number().int().nonnegative();
/** null は初期フレームを選び、Main の指定は特定の直接の相手を選ぶ。ALL はスレッドではない。 */
export const mainConversationThreadSchema = mainSessionTargetSchema.nullable();
/** スレッドの照会対象を、履歴を所有するSessionの個体で指定する。 */
export const conversationThreadsRequestSchema = z
  .object({ target: sessionTargetSchema })
  .strict();
/** 初期フレームと相手別スレッドに分け、各スレッドの保存位置と配送情報を返す。 */
export const conversationThreadsResultSchema = z.object({
  ok: z.literal(true),
  initialMessageIndexes: z.array(sequence),
  children: z.array(
    z.object({
      target: sessionTargetSchema,
      title: z.string(),
      character: z
        .object({ name: z.string(), iconPath: z.string() })
        .optional(),
      isProcessing: z.boolean().optional(),
      lastActivityAt: z.number().int().optional(),
      hasUnreadResult: z.boolean().optional(),
      messageIndexes: z.array(sequence),
      inboundTurnIds: z.array(z.string()),
      sentMessageIndexes: z.array(sequence),
    }),
  ),
});
/** 閲覧画面で使う、初期フレームと相手別スレッドの割り当て。 */
export type ConversationThreads = Omit<
  z.infer<typeof conversationThreadsResultSchema>,
  "ok"
>;
/** ある相手との保存メッセージ位置、受信Turn、送信位置と表示情報。 */
export type ConversationThread = ConversationThreads["children"][number];

/** Sessionと所属Mainの個体も区別できるよう、種別ごとの識別情報を配列で直列化する。 */
export function conversationPeerKey(target: SessionTarget): string {
  return JSON.stringify(
    target.kind === "main"
      ? [target.kind, target.sessionId, target.incarnationId]
      : [
          target.kind,
          target.sessionId,
          target.incarnationId,
          target.mainSessionId,
          target.mainIncarnationId,
        ],
  );
}

/** 送信カードのオーバーレイではなく、保存済みメッセージのフレームを解決する。undefined はここに表示されないことを示す。 */
export function savedReplyConversationFrame(
  main: MainSessionTarget,
  threads: ConversationThreads | undefined,
  reply: SessionReply | undefined,
): MainSessionTarget | null | undefined {
  if (
    !threads ||
    !reply ||
    !("seq" in reply) ||
    conversationPeerKey(reply.target) !== conversationPeerKey(main)
  )
    return undefined;
  return savedMessageConversationFrame(threads, reply.seq);
}

/** 列番号が一つのフレームにだけ属する場合に、そのMainまたは初期フレームのnullを返す。 */
export function savedMessageConversationFrame(
  threads: ConversationThreads,
  seq: number,
): MainSessionTarget | null | undefined {
  const matches = threads.children.filter((child) =>
    child.messageIndexes.includes(seq),
  );
  const initial = threads.initialMessageIndexes.includes(seq);
  if (matches.length + Number(initial) !== 1) return undefined;
  if (initial) return null;
  const target = matches[0].target;
  return target.kind === "main" ? target : undefined;
}
