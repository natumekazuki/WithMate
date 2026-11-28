import type { Message } from "./session-state.js";
import type {
  SessionSteerOrigin,
  SessionTurnQueueOrigin,
} from "./session-turn-queue.js";

/** 表示用の発話元。GUIの入力、識別できない入力、名前とアイコンを持つAgentを区別する。 */
export type ConversationInputSpeaker =
  | { kind: "user" }
  | { kind: "unknown" }
  | { kind: "agent"; name: string; iconPath: string };

/** 保存された起点から発話者を取り出し、Agentの情報が欠けていれば既定表示を使う。 */
export function conversationInputSpeaker(
  origin: SessionTurnQueueOrigin | SessionSteerOrigin | null | undefined,
): ConversationInputSpeaker {
  if (!origin) return { kind: "unknown" };
  if (origin.kind === "gui") return { kind: "user" };
  const character = origin.actorSnapshot?.character;
  return {
    kind: "agent",
    name: character?.name?.trim() || "Unknown Sender",
    iconPath: character?.iconPath || "",
  };
}

/** 会話本文を一度に扱うページ当たりの標準件数。 */
export const CONVERSATION_PAGE_SIZE = 60;

/** 開始位置からの会話ページ、または正本の列番号を明示した部分集合を要求する。 */
export type ConversationPageRequest = {
  startIndex?: number;
  /** 正本のメッセージのシーケンス番号を飛び飛びに指定するページ。startIndex とは併用できない。 */
  messageIndexes?: number[];
};

/** 件数上限を守り、重複なく昇順に並ぶ非負の安全な整数の配列か調べる。 */
export function isConversationMessageIndexes(
  value: unknown,
  max = Infinity,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(
      (index, i) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        (i === 0 || index > value[i - 1]),
    )
  );
}

/** Sessionの個体と、指定位置に対応する本文の部分集合、履歴全体の件数。 */
export type ConversationPage = {
  sessionId: string;
  incarnationId: string;
  messages: Message[];
  startIndex: number;
  totalCount: number;
};

/** 検索結果とナビゲーター項目を一度に返すページ当たりの標準件数。 */
export const CONVERSATION_QUERY_PAGE_SIZE = 64;

/** ページ取得の継続時に、元の要求と会話の所有者・内容の版を照合する情報。 */
export type ConversationQueryStamp = {
  generationId: string;
  ownerIdentity: string;
  contentRevision: number;
  requestId: string;
};

/** 発行元と要求を識別し、続きなら元の照合情報と読み取り位置を渡す。 */
export type ConversationQueryRequest = {
  requestId: string;
  producerId: string;
  offset?: number;
  stamp?: ConversationQueryStamp;
  /** この生成処理の対象を、閲覧用の投影に含まれる正本のメッセージに限定する。 */
  messageIndexes?: number[];
};

/** 完了した検索等の一ページ。元の照合情報、件数と結果位置を含む。 */
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

/** ページの取得成功と、取消や照合情報の失効で結果が使えない場合を区別する。 */
export type ConversationQueryOutcome<T> =
  | ConversationQueryPage<T>
  | {
      status: "cancelled" | "invalidated";
    };

/** 取消対象を、同じ発行元の同じ要求に限定する識別情報。 */
export type ConversationQueryCancelRequest = Pick<
  ConversationQueryRequest,
  "requestId" | "producerId"
>;

/** 検索開始時の位置を指定する、保存メッセージの列番号と変換前本文の範囲。 */
export type ConversationSearchAnchor = {
  messageIndex: number;
  startOffset: number;
  endOffset: number;
};

/** 開始・終了が非負の安全な整数で、終了が開始より後にある範囲か確認する。 */
export function isConversationSearchAnchor(
  value: unknown,
): value is ConversationSearchAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as ConversationSearchAnchor;
  return (
    Number.isSafeInteger(anchor.messageIndex) &&
    anchor.messageIndex >= 0 &&
    Number.isSafeInteger(anchor.startOffset) &&
    anchor.startOffset >= 0 &&
    Number.isSafeInteger(anchor.endOffset) &&
    anchor.endOffset > anchor.startOffset
  );
}

/** 検索語と、原文または描画用の文字列のどちらを検索するかを指定する。 */
export type ConversationSearchRequest = ConversationQueryRequest & {
  query: string;
  mode: "source" | "preview";
  /** 初回リクエストで指定した変換前のソース範囲。スタンプ付きのページ取得では、省略しても初回の指定を引き継ぐ。 */
  anchor?: ConversationSearchAnchor;
};

/** 履歴ナビゲーターの対象を全件またはブックマーク済みに絞る。 */
export type ConversationNavigatorRequest = ConversationQueryRequest & {
  filter: "all" | "bookmarks";
};

/** 保存された本文への移動に必要なメッセージ列番号と、その中での一致順。 */
export type ConversationSearchMatch = {
  messageIndex: number;
  occurrenceIndex: number;
};

/** 一覧へ出す発話種別・プレビュー・印と、本文に移動するための列番号。 */
export type ConversationNavigatorEntry = {
  messageIndex: number;
  role: Message["role"];
  preview: string;
  accent: boolean;
  isBookmarked: boolean;
  speaker?: ConversationInputSpeaker;
};

/** ページ式で保持する正本の列番号を優先し、なければ表示側の添字を使う。 */
export function getMessageHistoryIndex(
  message: Message,
  localIndex: number,
): number {
  return message.historyIndex ?? localIndex;
}

/** 一部だけ読んだ会話では保存済み総件数、全件ある会話では配列の長さを使う。 */
export function getConversationMessageCount(session: {
  messages: readonly Message[];
  messageCount?: number;
}): number {
  return session.messageCount ?? session.messages.length;
}
