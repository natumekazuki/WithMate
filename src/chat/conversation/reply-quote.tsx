import { useEffect, useState } from "react";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { savedFinalAnswerTurnId, type SessionReply } from "../../../src-shared/session/session-reply.js";

export type ResolvedReply = { reference: SessionReply; text: string };

export async function readReplyQuote(ownerSessionId: string, reference: SessionReply): Promise<ResolvedReply> {
  const read = getWithMateApi()?.readSessionExecution;
  if (!read) throw new Error("Saved reply targets are unavailable.");
  const { target } = reference;
  if ("receiptId" in reference) {
    const result = await read(ownerSessionId, "get_execution_input", { target, receiptId: reference.receiptId, stage: "original", maxChars: 320 });
    if (!result.ok || result.receiptId !== reference.receiptId) throw new Error("The original reply target is unavailable.");
    return { reference, text: result.text + (result.nextOffset !== null ? "…" : "") };
  }
  const result = await read(ownerSessionId, "get_message", { target, seq: reference.seq, maxChars: 320 });
  if (!result.ok || result.seq !== reference.seq) throw new Error("The original reply target is unavailable.");
  const finalAnswerTurnId = savedFinalAnswerTurnId(result);
  if (reference.finalAnswerTurnId && reference.finalAnswerTurnId !== finalAnswerTurnId) throw new Error("The original reply target no longer matches.");
  return { reference: finalAnswerTurnId ? { ...reference, finalAnswerTurnId } : reference, text: result.text + (result.nextOffset !== null ? "…" : "") };
}

export function ReplyQuote({ ownerSessionId, reference }: { ownerSessionId: string; reference: SessionReply }) {
  const key = JSON.stringify([ownerSessionId, reference]);
  const [state, set] = useState<{ key: string; text: string }>();
  useEffect(() => {
    let active = true;
    void readReplyQuote(ownerSessionId, reference).then(({ text }) => {
      if (active) set({ key, text });
    }, () => { if (active) set({ key, text: "Original message unavailable" }); });
    return () => { active = false; };
  }, [key]);
  const quote = state?.key === key ? state : undefined;
  return <blockquote className="session-reply-quote" aria-label="Reply to" aria-busy={!quote || undefined}>
    {quote ? quote.text : "Loading original message…"}
  </blockquote>;
}
