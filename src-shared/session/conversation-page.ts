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

export type ConversationSearchRequest = {
  query: string;
  mode: "source" | "preview";
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
