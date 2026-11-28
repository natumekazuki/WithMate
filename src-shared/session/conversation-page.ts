import type { Message } from "./session-state.js";
import type { SessionSteerOrigin, SessionTurnQueueOrigin } from "./session-turn-queue.js";

export type ConversationInputSpeaker =
  | { kind: "user" }
  | { kind: "unknown" }
  | { kind: "agent"; name: string; iconPath: string };

export function conversationInputSpeaker(origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined): ConversationInputSpeaker {
  if (!origin) return { kind: "unknown" };
  if (origin.kind === "gui") return { kind: "user" };
  const character = origin.actorSnapshot?.character;
  return { kind: "agent", name: character?.name?.trim() || "Unknown Sender", iconPath: character?.iconPath || "" };
}

export const CONVERSATION_PAGE_SIZE = 60;

export type ConversationPageRequest = {
  startIndex?: number;
  /** 正本のメッセージのシーケンス番号を飛び飛びに指定するページ。startIndex とは併用できない。 */
  messageIndexes?: number[];
};

export function isConversationMessageIndexes(value: unknown, max = Infinity): value is number[] {
  return Array.isArray(value) && value.length <= max && value.every((index, i) =>
    Number.isSafeInteger(index) && index >= 0 && (i === 0 || index > value[i - 1]));
}

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
  /** この生成処理の対象を、閲覧用の投影に含まれる正本のメッセージに限定する。 */
  messageIndexes?: number[];
};

export type ConversationQueryPage<T> = {
  status: "complete";
  stamp: ConversationQueryStamp;
  incarnationId: string;
  messageCount: number;
  totalCount: number;
  offset: number;
  anchorOrdinal?: number;
  items: T[];
};

export type ConversationQueryOutcome<T> = ConversationQueryPage<T> | {
  status: "cancelled" | "invalidated";
};

export type ConversationQueryCancelRequest = Pick<ConversationQueryRequest, "requestId" | "producerId">;

export type ConversationSearchAnchor = {
  messageIndex: number;
  startOffset: number;
  endOffset: number;
};

export function isConversationSearchAnchor(value: unknown): value is ConversationSearchAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as ConversationSearchAnchor;
  return Number.isSafeInteger(anchor.messageIndex) && anchor.messageIndex >= 0
    && Number.isSafeInteger(anchor.startOffset) && anchor.startOffset >= 0
    && Number.isSafeInteger(anchor.endOffset) && anchor.endOffset > anchor.startOffset;
}

export type ConversationSearchRequest = ConversationQueryRequest & {
  query: string;
  mode: "source" | "preview";
  /** 初回リクエストで指定した変換前のソース範囲。スタンプ付きのページ取得では、省略しても初回の指定を引き継ぐ。 */
  anchor?: ConversationSearchAnchor;
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
  speaker?: ConversationInputSpeaker;
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
