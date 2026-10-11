import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";

export function SessionTurnQueueStatus({ receipt, position, busy, onCancel, onRelease, onSendInput }: {
  receipt: SessionTurnQueueReceipt; position?: number; busy: boolean;
  onCancel: (receipt: SessionTurnQueueReceipt) => void; onRelease: (receipt: SessionTurnQueueReceipt) => void;
  onSendInput?: (receipt: SessionTurnQueueReceipt) => void;
}) {
  if (receipt.state === "completed" || receipt.state === "canceled") return null;
  const label = receipt.state === "queued" ? `Queued ${position ?? ""}`.trim()
    : receipt.inputTurnId && receipt.state === "starting" ? "Sending to Current Turn"
    : receipt.state[0].toUpperCase() + receipt.state.slice(1);
  return <div className="session-turn-queue-status" role="status" aria-label={label}>
    {receipt.reason ? <span className="session-turn-queue-reason">{receipt.reason}</span> : null}
    {receipt.state === "interrupted" && receipt.releasedAt === null ? <span className="session-turn-queue-reason">Execution outcome is unknown. Later turns are held.</span> : null}
    <span>{label}</span>
    {receipt.state === "queued" && onSendInput ? <button className="drawer-toggle compact secondary" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => onSendInput(receipt)}>Send to Current Turn</button> : null}
    {receipt.state === "queued" ? <button className="drawer-toggle compact secondary" type="button" aria-label={position === undefined ? "Cancel queued turn" : `Cancel queued turn ${position}`} disabled={busy} aria-busy={busy || undefined} onClick={() => onCancel(receipt)}>Cancel</button> : null}
    {receipt.state === "interrupted" && receipt.releasedAt === null ? <button className="drawer-toggle compact secondary" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => onRelease(receipt)}>Release Later Turns</button> : null}
  </div>;
}

export function SessionTurnQueueRow(props: Parameters<typeof SessionTurnQueueStatus>[0]) {
  return <article className="message-row user" data-message-source="turn-queue">
    <div className="message-card user"><div className="message-card-content">
      <MessageRichText text={props.receipt.captured.request.userMessage} />
      <SessionTurnQueueStatus {...props} />
    </div></div>
  </article>;
}
