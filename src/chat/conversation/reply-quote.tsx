import { createContext, useContext, useEffect, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import {
  savedFinalAnswerTurnId,
  type SessionReply,
} from "../../../src-shared/session/session-reply.js";
import { conversationPeerKey } from "../../../src-shared/session/conversation-threads.js";
import type { SessionTurnQueueOrigin } from "../../../src-shared/session/session-turn-queue.js";
import type { ReplyLocation } from "./reply-location.js";
import type { SessionTarget } from "../../../src-shared/session/session-target.js";
import type { SentInstructionCard } from "../../../src-shared/session/session-execution-read.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";

/** 保存済みの返信元の参照と引用本文。受付から読んだ場合は送信来歴も持てる。 */
export type ResolvedReply = {
  reference: SessionReply;
  text: string;
  origin?: SessionTurnQueueOrigin | null;
};
/** 解決済みの引用や送信カードを、この会話で利用できる正確な移動先へ変換する操作。 */
export type ReplyQuoteNavigation = {
  locate: (quote: ResolvedReply) => Promise<ReplyLocation | null>;
  locateSent: (
    source: SessionTarget,
    item: SentInstructionCard,
  ) => ReplyLocation | null;
  open: (location: ReplyLocation) => void;
};
/** 会話から引用へ移動操作を供給する。提供元がなければ本文だけを表示する。 */
export const ReplyQuoteNavigationContext =
  createContext<ReplyQuoteNavigation | null>(null);

/** 元の受付入力または保存メッセージの抜粋を読み、指定した識別子と一致しない応答は拒否する。 */
export async function readReplyQuote(
  ownerSessionId: string,
  reference: SessionReply,
): Promise<ResolvedReply> {
  const read = getWithMateApi()?.readSessionExecution;
  if (!read) throw new Error("Saved reply targets are unavailable.");
  const { target } = reference;
  if ("receiptId" in reference) {
    const result = await read(ownerSessionId, "get_execution_input", {
      target,
      receiptId: reference.receiptId,
      stage: "original",
      maxChars: 320,
    });
    if (!result.ok || result.receiptId !== reference.receiptId)
      throw new Error("The original reply target is unavailable.");
    return {
      reference,
      text: result.text + (result.nextOffset !== null ? "…" : ""),
      origin: result.origin,
    };
  }
  const result = await read(ownerSessionId, "get_message", {
    target,
    seq: reference.seq,
    maxChars: 320,
  });
  if (!result.ok || result.seq !== reference.seq)
    throw new Error("The original reply target is unavailable.");
  const finalAnswerTurnId = savedFinalAnswerTurnId(result);
  if (
    reference.finalAnswerTurnId &&
    reference.finalAnswerTurnId !== finalAnswerTurnId
  )
    throw new Error("The original reply target no longer matches.");
  return {
    reference: finalAnswerTurnId
      ? { ...reference, finalAnswerTurnId }
      : reference,
    text: result.text + (result.nextOffset !== null ? "…" : ""),
  };
}

/** 現在の引用だけを表示し、移動先を解決できた場合に限って返信元へ移動できるようにする。 */
export function ReplyQuote({
  ownerSessionId,
  reference,
  navigable = false,
}: {
  ownerSessionId: string;
  reference: SessionReply;
  navigable?: boolean;
}) {
  const navigation = useContext(ReplyQuoteNavigationContext);
  const locate = navigable ? navigation?.locate : undefined;
  const key = JSON.stringify([
    ownerSessionId,
    conversationPeerKey(reference.target),
    ...("receiptId" in reference
      ? ["receipt", reference.receiptId]
      : ["message", reference.seq, reference.finalAnswerTurnId]),
  ]);
  const [state, set] = useState<{ key: string; quote: ResolvedReply | null }>();
  useEffect(() => {
    let active = true;
    void readReplyQuote(ownerSessionId, reference).then(
      (quote) => {
        if (active) set({ key, quote });
      },
      () => {
        if (active) set({ key, quote: null });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  const current = state?.key === key ? state : undefined;
  const quote = current?.quote;
  const [resolved, setResolved] = useState<{
    quote: ResolvedReply;
    locate: ReplyQuoteNavigation["locate"];
    location: ReplyLocation;
  }>();
  useEffect(() => {
    if (!quote || !locate) return;
    let active = true;
    void locate(quote).then(
      (location) => {
        if (active)
          setResolved(location ? { quote, locate, location } : undefined);
      },
      () => {
        if (active) setResolved(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, [quote, locate]);
  const location =
    resolved?.quote === quote && resolved?.locate === locate
      ? resolved?.location
      : undefined;
  const text = quote?.text ?? "Original message unavailable";
  return (
    <blockquote
      className="session-reply-quote"
      aria-label="Reply to"
      aria-busy={!current || undefined}
    >
      {!current ? (
        <LoadingIndicator inline label="Loading original message" />
      ) : location && navigation ? (
        <button
          type="button"
          className="session-reply-link"
          aria-label={`Go to quoted message: ${text}`}
          onClick={() => navigation.open(location)}
        >
          {text}
        </button>
      ) : (
        text
      )}
    </blockquote>
  );
}
