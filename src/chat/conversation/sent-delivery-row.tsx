import { useEffect, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import type { SessionExecutionReadResult } from "../../../src-shared/session/session-execution-window-contract.js";
import { getWithMateApi } from "../../app/renderer-withmate-api.js";
import { CharacterAvatar } from "../../ui/ui-utils.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { InputDetailRow, inputDetailStateLabel, SessionOriginRoute, AdditionalInputStatus, type TurnInputReadContext } from "./turn-input-details.js";
import { sentInstructionKey, type SentInstruction } from "./use-sent-deliveries.js";
import { CoordinationNotice } from "./coordination-notice.js";

type Execution = Extract<SessionExecutionReadResult<"get_execution">, { ok: true }>;
type SentMessageContext = Pick<ComponentProps<typeof MessageRichText>,
  "onOpenPath" | "markdownLinkFileContext" | "markdownImageContext" | "resolveImageSource" | "displayMode"
  | "responseProvider" | "onFind" | "onCopyText" | "onQuoteText">;

/** A source Turn summary; receipts do not record an exact position inside its output. */
export function SentDeliveryRow({ item, context, inline = false, positionUnknown = false, onOpenThread, ...messageContext }: { item: SentInstruction; context: TurnInputReadContext; inline?: boolean; positionUnknown?: boolean; onOpenThread?: (item: SentInstruction) => Promise<string | undefined> } & SentMessageContext) {
  const receipt = "receiptId" in item ? item : null;
  const steer = "messageSeq" in item ? item : null;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [execution, setExecution] = useState<Execution | null>(null);
  const [statusError, setStatusError] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusRevision, setStatusRevision] = useState(0);
  const [jumpError, setJumpError] = useState("");
  const [jumpBusy, setJumpBusy] = useState(false);
  const identity = JSON.stringify([context.ownerSessionId, sentInstructionKey(item), item.target]);
  const bodyClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(bodyClickTimer.current), [identity]);
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
  const distinctContent = coordination && (coordination.consultation === undefined || coordination.text !== coordination.consultation);
  const jump = async () => {
    clearTimeout(bodyClickTimer.current);
    if (!onOpenThread || jumpBusy) return;
    setJumpError(""); setJumpBusy(true);
    try { setJumpError(await onOpenThread(item) ?? ""); }
    finally { setJumpBusy(false); }
  };
  const onBodyClick = (event: MouseEvent<HTMLDivElement>) => {
    clearTimeout(bodyClickTimer.current);
    if (!onOpenThread || event.defaultPrevented || event.detail === 0
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.target instanceof Element && event.target.closest("a, button, input, textarea, select, summary, [role='button'], [contenteditable]"))) return;
    const body = event.currentTarget;
    if (event.detail !== 1) return;
    const hasSelection = () => {
      const selection = body.ownerDocument.getSelection();
      return !!selection && !selection.isCollapsed && selection.containsNode(body, true);
    };
    if (hasSelection()) return;
    // A second click can select a word. Keep the explicit button immediate.
    bodyClickTimer.current = setTimeout(() => {
      if (body.isConnected && !hasSelection()) void jump();
    }, 500);
  };
  const detailsButton = <button type="button" className="artifact-toggle artifact-toggle-icon" aria-label={open ? "Hide Delivery Details" : "Show Delivery Details"} title="Delivery Details" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "−" : "i"}</button>;
  const card = <div className="message-card assistant session-outbound"><div className="message-card-content">
      <div className="sent-delivery-header">
        <SessionOriginRoute origin={item.origin} target={item.target} onError={setError} />
        {inline ? detailsButton : null}
      </div>
      {positionUnknown ? <p className="sent-delivery-position-unknown">Position not confirmed</p> : null}
      <div className={onOpenThread ? "sent-delivery-thread-body" : undefined} onClick={onOpenThread ? onBodyClick : undefined}>{coordination
        ? <CoordinationNotice id={coordination.id} consultation={coordination.consultation ?? coordination.text} target={item.target} />
        : <MessageRichText {...messageContext} text={item.text} />}
      {coordination && distinctContent ? <section aria-label="Sent Content"><MessageRichText {...messageContext} text={coordination.text} /></section> : null}
      </div>
      {onOpenThread ? <div className="sent-delivery-thread-action">
        <button type="button" className="drawer-toggle compact secondary" disabled={jumpBusy} onClick={() => void jump()}>{jumpBusy ? "Opening conversation…" : jumpError ? "Retry Conversation" : "Open in Conversation"}</button>
        {jumpError ? <p role="alert">{jumpError}</p> : null}
      </div> : null}
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
  const location = { "data-sent-card-key": sentInstructionKey(item), tabIndex: -1 };
  if (inline) return <section {...location} className="session-outbound-inline" aria-label={`Sent Message: ${item.origin.targetSnapshot?.sessionTitle ?? "Unknown Session"}`} data-source-turn-id={item.sourceTurnId} aria-busy={open && statusBusy || undefined}>{card}</section>;
  return <article {...location} className="message-row assistant session-outbound" aria-label={`Sent Message: ${item.origin.targetSnapshot?.sessionTitle ?? "Unknown Session"}`} data-source-turn-id={item.sourceTurnId} aria-busy={open && statusBusy || undefined}>
    <div className="message-avatar-stack">
      <CharacterAvatar character={character} size="small" className="message-avatar" />
      {detailsButton}
    </div>
    <div className="message-character-name">{character.name}</div>
    {card}
  </article>;
}
