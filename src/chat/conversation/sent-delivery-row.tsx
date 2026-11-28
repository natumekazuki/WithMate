import { useContext, useEffect, useState, type ComponentProps } from "react";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { InputDetailRow, inputDetailStateLabel, SessionOriginRoute, AdditionalInputStatus, type TurnInputReadContext } from "./turn-input-details.js";
import { sentInstructionKey, type SentInstruction } from "./use-sent-deliveries.js";
import { SentInstructionBodyBoundary } from "./sent-instruction-body.js";
import { CoordinationNotice } from "./coordination-notice.js";
import { ReplyQuote, ReplyQuoteNavigationContext } from "./reply-quote.js";

type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;
type SentMessageContext = Pick<ComponentProps<typeof MessageRichText>,
  "onOpenPath" | "markdownLinkFileContext" | "markdownImageContext" | "resolveImageSource" | "displayMode"
  | "responseProvider" | "onFind" | "onCopyText" | "onQuoteText">;

/** 送信元 Turn の概要。受付情報には、その出力内での正確な位置は記録されない。 */
export function SentDeliveryRow({ item, context, inline = false, replyJumpHighlighted = false, ...messageContext }: {
  item: SentInstruction; context: TurnInputReadContext; inline?: boolean; replyJumpHighlighted?: boolean;
} & SentMessageContext) {
  const receipt = "receiptId" in item ? item : null;
  const steer = "messageSeq" in item ? item : null;
  const navigation = useContext(ReplyQuoteNavigationContext);
  const location = navigation?.locateSent(context.target, item);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [execution, setExecution] = useState<Execution | null>(null);
  const [statusError, setStatusError] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusRevision, setStatusRevision] = useState(0);
  const identity = JSON.stringify([context.ownerSessionId, sentInstructionKey(item), item.target]);
  useEffect(() => {
    if (!open) return;
    const api = getWithMateApi();
    let active = true;
    let current = 0;
    const refresh = async () => {
      const request = ++current;
      if (!api?.readSessionExecution) { setStatusError("Saved delivery state reads are unavailable."); return; }
      setStatusBusy(true); setStatusError("");
      try {
        const result = await api.readSessionExecution(context.ownerSessionId, "get_execution", { target: item.target, ...(receipt ? { receiptId: receipt.receiptId } : { messageSeq: steer!.messageSeq }) });
        if (!active || request !== current) return;
        if (result.ok) setExecution(result); else setStatusError(result.message);
      } catch (failure) {
        if (active && request === current) setStatusError(failure instanceof Error ? failure.message : "Could not read delivery state.");
      } finally { if (active && request === current) setStatusBusy(false); }
    };
    void refresh();
    const changed = (sessionId: string) => { if (sessionId === item.target.sessionId) void refresh(); };
    const queueChanged = api?.onSessionTurnQueueChanged?.(changed);
    const turnUpdated = api?.onSessionTurnUpdated?.(changed);
    const sentChanged = api?.onSessionSentDeliveriesChanged?.((sourceSessionId) => { if (sourceSessionId === context.target.sessionId) void refresh(); });
    return () => { active = false; queueChanged?.(); turnUpdated?.(); sentChanged?.(); };
  }, [open, identity, item.state, statusRevision]);
  const character = item.origin.actorSnapshot?.character ?? { name: "Unknown Sender", iconPath: "" };
  const coordination = receipt?.coordination;
  const renderBody = (render: ComponentProps<typeof SentInstructionBodyBoundary>["render"]) =>
    <SentInstructionBodyBoundary key={identity} source={item.bodyRead} requested={replyJumpHighlighted} render={render} />;
  const detailsButton = <button type="button" className="artifact-toggle artifact-toggle-icon" aria-label={open ? "Hide Delivery Details" : "Show Delivery Details"} title="Delivery Details" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "−" : "i"}</button>;
  const card = <div className={`message-card assistant session-outbound${replyJumpHighlighted ? " is-reply-jump-target" : ""}`}
    data-sent-instruction-key={sentInstructionKey(item)}><div className="message-card-content">
      <div className="sent-delivery-header">
        <SessionOriginRoute origin={item.origin} target={item.target} onError={setError}
          onOpenRecipientThread={location && navigation ? () => navigation.open(location) : undefined} />
        {inline ? detailsButton : null}
      </div>
      {receipt?.replyTo ? <ReplyQuote ownerSessionId={context.ownerSessionId} reference={receipt.replyTo} navigable /> : null}
      {coordination
        ? renderBody(({ text, consultation }) => <>
          <CoordinationNotice id={coordination.id} consultation={consultation ?? text} target={item.target} />
          {consultation === undefined || consultation !== text
            ? <section aria-label="Sent Content"><MessageRichText {...messageContext} text={text} /></section> : null}
        </>)
        : renderBody(({ text }) => <MessageRichText {...messageContext} text={text} />)}
      {steer ? <AdditionalInputStatus state={steer.state} /> : null}
      {error ? <p role="alert">{error}</p> : null}
      {open ? <section className="artifact-block turn-input-details turn-input-panel" aria-label="Delivery Details">
      <div className="artifact-section-header"><strong>Delivery Details</strong></div>
      {statusBusy ? <LoadingIndicator inline label="Loading delivery state" /> : null}
      {statusError ? <p role="alert">{statusError} <button type="button" className="drawer-toggle compact secondary" disabled={statusBusy} onClick={() => setStatusRevision((value) => value + 1)}>Retry Delivery Details</button></p> : null}
      <dl className="check-list turn-input-rows" aria-label="Delivery State">
        {receipt ? <InputDetailRow label="Receipt State">{inputDetailStateLabel(execution?.receiptState ?? receipt.state, "No Receipt")}</InputDetailRow> : null}
        <InputDetailRow label="Turn State">{inputDetailStateLabel(execution?.turnState, "Not Confirmed")}</InputDetailRow>
        {receipt ? <InputDetailRow label="Delivery Timing">{receipt.origin.deliveryTiming === "after_source_turn" ? "After Sender Turn" : "Immediate"}</InputDetailRow> : null}
      </dl>
      </section> : null}
    </div></div>;
  if (inline) return <section className="session-outbound-inline" aria-label={`Sent Message: ${item.origin.targetSnapshot?.sessionTitle ?? "Unknown Session"}`} data-source-turn-id={item.sourceTurnId} aria-busy={open && statusBusy || undefined}>{card}</section>;
  return <article className="message-row assistant session-outbound" aria-label={`Sent Message: ${item.origin.targetSnapshot?.sessionTitle ?? "Unknown Session"}`} data-source-turn-id={item.sourceTurnId} aria-busy={open && statusBusy || undefined}>
    <div className="message-avatar-stack">
      <CharacterAvatar character={character} size="small" className="message-avatar" />
      {detailsButton}
    </div>
    <div className="message-character-name">{character.name}</div>
    {card}
  </article>;
}
