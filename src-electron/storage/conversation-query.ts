import type { DatabaseSync } from "node:sqlite";
import { withMessageRunFailure } from "../../src-shared/session/message-run-failure.js";
import {
  normalizeMessage,
  type Message,
} from "../../src-shared/session/session-state.js";
import {
  CONVERSATION_PAGE_SIZE,
  isConversationMessageIndexes,
  type ConversationPage,
  type ConversationPageRequest,
} from "../../src-shared/session/conversation-page.js";

export type MessageTable = "session_messages_v6" | "auxiliary_session_messages";
export type ConversationMutationSink = (table: MessageTable, id?: string) => void;
export type ConversationQuerySnapshot = {
  ownerIdentity: string;
  provider: string;
  incarnationId: string;
  messageCount: number;
};
export type ConversationQueryRow = { seq: number; role: string; body: string; runFailure?: string | null; inputOriginJson?: string | null };
export const CONVERSATION_QUERY_BATCH_SIZE = 32;

export function conversationMessageColumns(table: MessageTable, db: DatabaseSync): string {
  // Auxiliary の会話記録は、最小限の Turn データがまだ存在しないスキーマ初期化中にも読み取られる。
  if (table === "auxiliary_session_messages" && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_turns_v6'").get()) {
    return "seq, role, body";
  }
  const owner = table === "session_messages_v6" ? "session_id" : "auxiliary_session_id";
  return `seq, role, body, (SELECT error_summary FROM session_turns_v6 t
    WHERE t.${owner} = ${table}.${owner} AND t.phase = 'failed'
      AND t.assistant_message_seq = ${table}.seq
    ORDER BY t.id DESC LIMIT 1) AS runFailure`;
}

/** 同期カーソル読み取り。範囲を限定した読み取りには、正本のインデックスを最大1バッチ渡す。 */
export function readConversationQueryBatch(db: DatabaseSync, table: MessageTable, id: string, afterSeq: number,
  includeSpeakers = true, messageIndexes?: readonly number[]): ConversationQueryRow[] {
  if (messageIndexes?.length === 0) return [];
  const owner = table === "session_messages_v6" ? "session_id" : "auxiliary_session_id";
  const scope = messageIndexes === undefined ? "" : ` AND seq IN (${messageIndexes.map(() => "?").join(",")})`;
  const rows: ConversationQueryRow[] = [];
  let bytes = 0;
  for (const raw of db.prepare(`SELECT ${conversationMessageColumns(table, db)} FROM ${table}
    WHERE ${owner} = ? AND seq > ?${scope} ORDER BY seq ASC LIMIT ${CONVERSATION_QUERY_BATCH_SIZE}`).iterate(id, afterSeq, ...(messageIndexes ?? []))) {
    const row = raw as ConversationQueryRow;
    const size = Buffer.byteLength(row.body, "utf8");
    if (rows.length && bytes + size > 256 * 1024) break;
    rows.push(row);
    bytes += size;
    if (bytes >= 256 * 1024) break;
  }
  if (includeSpeakers) {
    const userRows = rows.filter((row) => row.role === "user");
    if (!userRows.length) return rows;
    const main = table === "session_messages_v6";
    const identity = main
      ? db.prepare("SELECT incarnation_id AS incarnation FROM sessions_v6 WHERE id = ?").get(id) as { incarnation: string | null } | undefined
      : db.prepare("SELECT created_at AS incarnation FROM auxiliary_sessions WHERE id = ?").get(id) as { incarnation: string | null } | undefined;
    const receipts = db.prepare(`SELECT user_message_seq AS seq, json_extract(COALESCE(dispatched_json, accepted_json), '$.origin') AS origin
      FROM session_turn_queue_v6 WHERE ${owner} = ? ${main ? "AND auxiliary_session_id IS NULL" : ""}
        AND incarnation_id = ? AND user_message_seq IN (${userRows.map(() => "?").join(",")})
        ORDER BY user_message_seq, sequence`).all(
          id, identity?.incarnation?.trim() || `legacy:${id}`, ...userRows.map((row) => row.seq),
        ) as { seq: number; origin: string | null }[];
    // 同じ seq が複数回関連付けられている場合は、origin が null でも最後の受領記録を優先する。
    const bySequence = new Map(receipts.map((receipt) => [receipt.seq, receipt.origin]));
    for (const row of userRows) if (bySequence.has(row.seq)) row.inputOriginJson = bySequence.get(row.seq) ?? null;
  }
  return rows;
}

export function readConversationQuerySnapshot(db: DatabaseSync, table: MessageTable, id: string): ConversationQuerySnapshot | null {
  if (table === "session_messages_v6") {
    const row = db.prepare(`SELECT incarnation_id, provider_id FROM sessions_v6 WHERE id = ?`).get(id) as { incarnation_id: string; provider_id: string } | undefined;
    if (!row) return null;
    const incarnationId = row.incarnation_id?.trim() || `legacy:${id}`;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM session_messages_v6 WHERE session_id = ?`).get(id) as { count: number };
    return { ownerIdentity: JSON.stringify(["main", id, incarnationId]), provider: row.provider_id, incarnationId, messageCount: count.count };
  }
  const row = db.prepare(`SELECT a.created_at, a.provider_id, d.incarnation, a.parent_session_id, p.incarnation_id AS parent_incarnation
    FROM auxiliary_sessions a JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
    JOIN sessions_v6 p ON p.id = a.parent_session_id WHERE a.id = ?`).get(id) as {
      created_at: string; provider_id: string; incarnation: string; parent_session_id: string; parent_incarnation: string;
    } | undefined;
  if (!row) return null;
  const count = db.prepare(`SELECT COUNT(*) AS count FROM auxiliary_session_messages WHERE auxiliary_session_id = ?`).get(id) as { count: number };
  return { ownerIdentity: JSON.stringify(["auxiliary", id, row.incarnation, row.parent_session_id, row.parent_incarnation, row.created_at]),
    provider: row.provider_id, incarnationId: row.created_at, messageCount: count.count };
}
export function toConversationView<
  T extends { messages: Message[]; messageCount?: number },
>(session: T): T {
  if (session.messageCount !== undefined) return session;
  const start = Math.max(0, session.messages.length - CONVERSATION_PAGE_SIZE);
  let latestUserIndex = session.messages.length - 1;
  while (
    latestUserIndex >= 0 &&
    session.messages[latestUserIndex].role !== "user"
  )
    latestUserIndex -= 1;
  return {
    ...session,
    messageCount: session.messages.length,
    latestUserMessage:
      latestUserIndex < 0
        ? null
        : {
            ...session.messages[latestUserIndex],
            historyIndex: latestUserIndex,
          },
    messages: session.messages
      .slice(start)
      .map((message, index) => ({ ...message, historyIndex: start + index })),
  };
}
export function readConversationPage(
  db: DatabaseSync,
  table: MessageTable,
  sessionId: string,
  incarnationId: string,
  request?: ConversationPageRequest,
): ConversationPage {
  const owner =
    table === "session_messages_v6" ? "session_id" : "auxiliary_session_id";
  const totalCount = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${owner} = ?`)
      .get(sessionId) as { count: number }
  ).count;
  const indexes = request?.messageIndexes;
  if (indexes !== undefined && (request?.startIndex !== undefined || !isConversationMessageIndexes(indexes, CONVERSATION_PAGE_SIZE))) {
    throw new TypeError("Conversation page message indexes are invalid.");
  }
  if (
    request?.startIndex !== undefined &&
    (!Number.isInteger(request.startIndex) || request.startIndex < 0)
  ) {
    throw new TypeError("Conversation page start index is invalid.");
  }
  const startIndex = Math.min(
    indexes?.[0] ?? request?.startIndex ?? Math.max(0, totalCount - CONVERSATION_PAGE_SIZE),
    totalCount,
  );
  const rows = indexes !== undefined ? (indexes.length ? db.prepare(
    `SELECT ${conversationMessageColumns(table, db)} FROM ${table} WHERE ${owner} = ? AND seq IN (${indexes.map(() => "?").join(",")}) ORDER BY seq`,
  ).all(sessionId, ...indexes) : []) as ConversationQueryRow[] : db
    .prepare(
      `SELECT ${conversationMessageColumns(table, db)} FROM ${table} WHERE ${owner} = ? AND seq >= ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(sessionId, startIndex, CONVERSATION_PAGE_SIZE) as ConversationQueryRow[];
  const messages = rows.map((row) => {
    const message = normalizeMessage({
      ...JSON.parse(row.body),
      role: row.role,
    });
    if (!message)
      throw new Error(`Invalid conversation message: ${sessionId}:${row.seq}`);
    return { ...withMessageRunFailure(message, row.runFailure), historyIndex: row.seq };
  });
  return { sessionId, incarnationId, messages, startIndex, totalCount };
}

export function assertFullConversation(session: {
  messageCount?: number;
  messages: Message[];
}): void {
  if (
    session.messageCount !== undefined ||
    session.messages.some((message) => message.historyIndex !== undefined)
  ) {
    throw new Error(
      "A paged conversation cannot be saved as a complete transcript.",
    );
  }
}
