import type { Message } from "./session-state.js";

export const CONVERSATION_PAGE_SIZE = 60;

export type ConversationPageRequest = {
  startIndex?: number;
};

export type ConversationPage = {
  sessionId: string;
  incarnationId: string;
  messages: Message[];
  startIndex: number;
  totalCount: number;
};

export const CONVERSATION_QUERY_PAGE_SIZE = 64;

export type ConversationQueryStamp = {
  generationId: string;
  ownerIdentity: string;
  contentRevision: number;
  requestId: string;
};

export type ConversationQueryRequest = {
  requestId: string;
  producerId: string;
  offset?: number;
  stamp?: ConversationQueryStamp;
};

export type ConversationQueryPage<T> = {
  status: "complete";
  stamp: ConversationQueryStamp;
  incarnationId: string;
  messageCount: number;
  totalCount: number;
  offset: number;
  items: T[];
};

export type ConversationQueryOutcome<T> = ConversationQueryPage<T> | {
  status: "cancelled" | "invalidated";
};

export type ConversationQueryCancelRequest = Pick<ConversationQueryRequest, "requestId" | "producerId">;

export type ConversationSearchRequest = ConversationQueryRequest & {
  query: string;
  mode: "source" | "preview";
};

export type ConversationNavigatorRequest = ConversationQueryRequest & {
  filter: "all" | "bookmarks";
};

export type ConversationSearchMatch = {
  messageIndex: number;
  occurrenceIndex: number;
};

export type ConversationNavigatorEntry = {
  messageIndex: number;
  role: Message["role"];
  preview: string;
  accent: boolean;
  isBookmarked: boolean;
};

export function getMessageHistoryIndex(message: Message, localIndex: number): number {
  return message.historyIndex ?? localIndex;
}

export function getConversationMessageCount(session: {
  messages: readonly Message[];
  messageCount?: number;
}): number {
  return session.messageCount ?? session.messages.length;
}
