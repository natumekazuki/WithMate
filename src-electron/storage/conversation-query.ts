import type { DatabaseSync } from "node:sqlite";
import { withMessageRunFailure } from "../../src-shared/session/message-run-failure.js";
import {
  normalizeMessage,
  type Message,
} from "../../src-shared/session/session-state.js";
import {
  CONVERSATION_PAGE_SIZE,
  type ConversationPage,
  type ConversationPageRequest,
} from "../../src-shared/session/conversation-page.js";

export type MessageTable = "session_messages_v6" | "auxiliary_session_messages";
export type ConversationMutationSink = (table: MessageTable, id?: string) => void;
export type ConversationQuerySnapshot = {
  ownerIdentity: string;
  incarnationId: string;
  messageCount: number;
};
export type ConversationQueryRow = { seq: number; role: string; body: string; runFailure?: string | null };

export function conversationMessageColumns(table: MessageTable, db: DatabaseSync): string {
  // Auxiliary transcripts are also read during schema initialization, before minimal turns exist.
  if (table === "auxiliary_session_messages" && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_turns_v6'").get()) {
    return "seq, role, body";
  }
  const owner = table === "session_messages_v6" ? "session_id" : "auxiliary_session_id";
  return `seq, role, body, (SELECT error_summary FROM session_turns_v6 t
    WHERE t.${owner} = ${table}.${owner} AND t.phase = 'failed'
      AND t.assistant_message_seq = ${table}.seq
    ORDER BY t.id DESC LIMIT 1) AS runFailure`;
}

/** A cursor read ends synchronously; neither its statement nor a transaction crosses an await. */
export function readConversationQueryBatch(db: DatabaseSync, table: MessageTable, id: string, afterSeq: number): ConversationQueryRow[] {
  const owner = table === "session_messages_v6" ? "session_id" : "auxiliary_session_id";
  const rows: ConversationQueryRow[] = [];
  let bytes = 0;
  for (const raw of db.prepare(`SELECT ${conversationMessageColumns(table, db)} FROM ${table} WHERE ${owner} = ? AND seq > ? ORDER BY seq ASC LIMIT 32`).iterate(id, afterSeq)) {
    const row = raw as ConversationQueryRow;
    const size = Buffer.byteLength(row.body, "utf8");
    if (rows.length && bytes + size > 256 * 1024) break;
    rows.push(row);
    bytes += size;
    if (bytes >= 256 * 1024) break;
  }
  return rows;
}

export function readConversationQuerySnapshot(db: DatabaseSync, table: MessageTable, id: string): ConversationQuerySnapshot | null {
  if (table === "session_messages_v6") {
    const row = db.prepare(`SELECT incarnation_id FROM sessions_v6 WHERE id = ?`).get(id) as { incarnation_id: string } | undefined;
    if (!row) return null;
    const incarnationId = row.incarnation_id?.trim() || `legacy:${id}`;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM session_messages_v6 WHERE session_id = ?`).get(id) as { count: number };
    return { ownerIdentity: JSON.stringify(["main", id, incarnationId]), incarnationId, messageCount: count.count };
  }
  const row = db.prepare(`SELECT a.created_at, d.incarnation, a.parent_session_id, p.incarnation_id AS parent_incarnation
    FROM auxiliary_sessions a JOIN auxiliary_session_drafts d ON d.auxiliary_session_id = a.id
    JOIN sessions_v6 p ON p.id = a.parent_session_id WHERE a.id = ?`).get(id) as {
      created_at: string; incarnation: string; parent_session_id: string; parent_incarnation: string;
    } | undefined;
  if (!row) return null;
  const count = db.prepare(`SELECT COUNT(*) AS count FROM auxiliary_session_messages WHERE auxiliary_session_id = ?`).get(id) as { count: number };
  return { ownerIdentity: JSON.stringify(["auxiliary", id, row.incarnation, row.parent_session_id, row.parent_incarnation, row.created_at]),
    incarnationId: row.created_at, messageCount: count.count };
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
  if (
    request?.startIndex !== undefined &&
    (!Number.isInteger(request.startIndex) || request.startIndex < 0)
  ) {
    throw new TypeError("Conversation page start index is invalid.");
  }
  const startIndex = Math.min(
    request?.startIndex ?? Math.max(0, totalCount - CONVERSATION_PAGE_SIZE),
    totalCount,
  );
  const rows = db
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
