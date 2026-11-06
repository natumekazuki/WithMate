import { useEffect, useRef, useState } from "react";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { SessionOriginRoute, type TurnInputReadContext } from "./turn-input-details.js";
import type { SentDelivery } from "./use-sent-deliveries.js";

type Input = Extract<SessionExecutionReadResult<"get_execution_input">, { ok: true }>;

/** A source Turn summary; receipts do not record an exact position inside its output. */
export function SentDeliveryRow({ item, context }: { item: SentDelivery; context: TurnInputReadContext }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<Input | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { ++attempt.current; }, [context.ownerSessionId, item.receiptId, JSON.stringify(item.target)]);
  const load = async (more = false) => {
    const api = getWithMateApi();
    if (!api?.readSessionExecution) { setError("Saved outgoing input reads are unavailable."); return; }
    const current = ++attempt.current;
    setBusy(true); setError("");
    try {
      const original = input?.inputPair.original;
      const result = await api.readSessionExecution(context.ownerSessionId, "get_execution_input", {
        target: item.target, receiptId: item.receiptId, stage: "original", maxChars: 100000,
        ...(more && original?.nextOffset != null ? { offset: original.nextOffset, expectedInput: input!.expectedInput } : {}),
      });
      if (attempt.current !== current) return;
      if (!result.ok) { setError(result.message); return; }
      setInput(result);
      const piece = result.inputPair.original;
      if (piece) setText((previous) => more && previous !== null ? previous + piece.text.slice(Math.max(0, previous.length - piece.offset)) : piece.text);
      else { setText(null); setError("The original sent input was not recorded."); }
    } catch (failure) {
      if (attempt.current === current) setError(failure instanceof Error ? failure.message : "Could not read sent input.");
    } finally { if (attempt.current === current) setBusy(false); }
  };
  const character = item.origin.actorSnapshot?.character ?? { name: "Unknown Sender", iconPath: "" };
  const original = input?.inputPair.original;
  const incomplete = text === null ? item.textChars > item.textPreview.length : original?.nextOffset != null;
  return <article className="message-row assistant session-outbound" aria-label={`Sent Message: ${item.origin.targetSnapshot?.sessionTitle ?? "Unknown Session"}`} data-source-turn-id={item.sourceTurnId} aria-busy={busy || undefined}>
    <div className="message-avatar-stack">
      <CharacterAvatar character={character} size="small" className="message-avatar" />
      <button type="button" className="artifact-toggle artifact-toggle-icon" aria-label={open ? "Hide Delivery Details" : "Show Delivery Details"} title="Delivery Details" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && !input) void load(); }}>{open ? "−" : "i"}</button>
    </div>
    <div className="message-character-name">{character.name}</div>
    <div className="message-card assistant session-outbound"><div className="message-card-content">
      <SessionOriginRoute origin={item.origin} target={item.target} onError={setError} />
      <MessageRichText text={text ?? item.textPreview} />
      {incomplete ? <button type="button" className="drawer-toggle compact secondary" disabled={busy} onClick={() => void load(text !== null)}>{text === null ? `Read Full Message · ${item.textChars.toLocaleString("en-US")} Characters` : `Load More Message · ${text.length.toLocaleString("en-US")} / ${item.textChars.toLocaleString("en-US")} Characters`}</button> : null}
      {busy ? <LoadingIndicator inline label="Loading sent message" /> : null}
      {error ? <p role="alert">{error} <button type="button" className="drawer-toggle compact secondary" disabled={busy} onClick={() => void load()}>Reload Message</button></p> : null}
      {open ? <section className="turn-input-details" aria-label="Delivery Details"><dl className="turn-input-references">
        <dt>Receipt</dt><dd><code>{item.receiptId}</code></dd>
        <dt>Receipt State</dt><dd>{input?.receiptState ?? item.state}</dd>
        <dt>Turn State</dt><dd>{input?.turnState ?? "Not Confirmed"}</dd>
        <dt>Source WithMate Turn</dt><dd><code>{item.sourceTurnId}</code></dd>
        {input?.turnId ? <><dt>Recipient WithMate Turn</dt><dd><code>{input.turnId}</code></dd></> : null}
      </dl></section> : null}
    </div></div>
  </article>;
}
