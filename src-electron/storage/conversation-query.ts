import type { DatabaseSync } from "node:sqlite";
import {
  normalizeMessage,
  type Message,
} from "../../src-shared/session/session-state.js";
import {
  CONVERSATION_PAGE_SIZE,
  type ConversationPage,
  type ConversationPageRequest,
} from "../../src-shared/session/conversation-page.js";
import type {
  ConversationSearchRequest,
  ConversationSearchMatch,
  ConversationNavigatorEntry,
} from "../../src-shared/session/conversation-page.js";
import {
  projectMessageRenderedSearchText,
  projectMessagePlainText,
} from "../../src-shared/session/message-search.js";
import { findTextMatches } from "../../src-shared/text/find-text-matches.js";

type MessageTable = "session_messages_v6" | "auxiliary_session_messages";
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
      `SELECT seq, role, body FROM ${table} WHERE ${owner} = ? AND seq >= ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(sessionId, startIndex, CONVERSATION_PAGE_SIZE) as Array<{
    seq: number;
    role: string;
    body: string;
  }>;
  const messages = rows.map((row) => {
    const message = normalizeMessage({
      ...JSON.parse(row.body),
      role: row.role,
    });
    if (!message)
      throw new Error(`Invalid conversation message: ${sessionId}:${row.seq}`);
    return { ...message, historyIndex: row.seq };
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

function* iterateConversation(
  db: DatabaseSync,
  table: MessageTable,
  sessionId: string,
): Generator<{ message: Message; index: number }> {
  const owner =
    table === "session_messages_v6" ? "session_id" : "auxiliary_session_id";
  for (const row of db
    .prepare(
      `SELECT seq, role, body FROM ${table} WHERE ${owner} = ? ORDER BY seq ASC`,
    )
    .iterate(sessionId)) {
    const message = normalizeMessage({
      ...JSON.parse(row.body as string),
      role: row.role,
    });
    if (!message)
      throw new Error(`Invalid conversation message: ${sessionId}:${row.seq}`);
    yield { message, index: row.seq as number };
  }
}

export function searchStoredConversation(
  db: DatabaseSync,
  table: MessageTable,
  sessionId: string,
  request: ConversationSearchRequest,
): ConversationSearchMatch[] {
  if (
    typeof request?.query !== "string" ||
    (request.mode !== "source" && request.mode !== "preview")
  )
    throw new TypeError("Conversation search is invalid.");
  if (!request.query.trim()) return [];
  const matches: ConversationSearchMatch[] = [];
  for (const { message, index } of iterateConversation(db, table, sessionId)) {
    const text =
      request.mode === "source"
        ? message.text
        : projectMessageRenderedSearchText(message.text);
    findTextMatches(text, request.query).forEach((_, occurrenceIndex) =>
      matches.push({ messageIndex: index, occurrenceIndex }),
    );
  }
  return matches;
}

export function listStoredConversationNavigator(
  db: DatabaseSync,
  table: MessageTable,
  sessionId: string,
): ConversationNavigatorEntry[] {
  const entries: ConversationNavigatorEntry[] = [];
  for (const { message, index } of iterateConversation(db, table, sessionId)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    entries.push({
      messageIndex: index,
      role: message.role,
      preview: projectMessagePlainText(message.text),
      accent: message.accent === true,
      isBookmarked: message.isBookmarked === true,
    });
  }
  return entries;
}
