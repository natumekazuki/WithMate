import { useLayoutEffect, useRef } from "react";
import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";
import type { MarkdownImageContext, MarkdownImageResolver } from "../../ui/markdown/image-resource-loader.js";
import { ButtonContent } from "../../ui/button-content.js";
import type { SessionTurnQueueActionKind, SessionTurnQueueMoveDirection } from "./use-session-turn-queue.js";
import type { SessionTurnSubmission } from "../runtime/session-turn-submissions.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import type { CharacterVisual } from "../../../src-shared/character/character-state.js";
import { SessionRunFailureRow } from "./session-run-failure.js";

export function SessionTurnSubmissionRow({ submission, resolveImageSource, markdownImageContext, character }: { submission: SessionTurnSubmission; character: CharacterVisual; resolveImageSource?: MarkdownImageResolver; markdownImageContext?: MarkdownImageContext }) {
  return <><article className="message-row user" data-message-source="turn-submission">
    <div className="message-card user"><div className="message-card-content">
      <MessageRichText text={submission.userMessage} resolveImageSource={resolveImageSource} markdownImageContext={markdownImageContext} />
      {submission.error ? submission.uncertain ? <p className="pending-run-error-note" role="alert">{submission.error}</p> : null
        : <LoadingIndicator inline label="Queued turn" />}
    </div></div>
  </article>
    {submission.error && !submission.uncertain ? <SessionRunFailureRow reason={submission.error} character={character} /> : null}
  </>;
}

export function SessionTurnQueueStatus({ receipt, position, queueSize, busy, busyKind, onCancel, onRelease, onSendInput, onMove, moveDisabled }: {
  receipt: SessionTurnQueueReceipt; position?: number; busy: boolean;
  queueSize?: number;
  moveDisabled?: boolean;
  busyKind?: SessionTurnQueueActionKind | null;
  onCancel: (receipt: SessionTurnQueueReceipt) => void; onRelease: (receipt: SessionTurnQueueReceipt) => void;
  onSendInput?: (receipt: SessionTurnQueueReceipt) => void;
  onMove?: (receipt: SessionTurnQueueReceipt, direction: SessionTurnQueueMoveDirection) => void;
}) {
  const statusRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const button = moveFocus.current;
    if (!button || busy) return;
    const active = button.ownerDocument.activeElement;
    if (active === button || active === button.ownerDocument.body) {
      (button.disabled ? statusRef.current : button)?.focus({ preventScroll: true });
    }
    moveFocus.current = null;
  }, [busy, position]);
  useLayoutEffect(() => {
    const status = statusRef.current;
    return () => {
      if (status?.contains(status.ownerDocument.activeElement)) status.closest<HTMLElement>(".session-message-list")?.focus({ preventScroll: true });
    };
  }, []);
  if (receipt.state !== "queued" && receipt.state !== "interrupted") return null;
  const label = receipt.state === "interrupted" ? "Interrupted" : undefined;
  return <div ref={statusRef} className="session-turn-queue-status" data-queue-receipt-id={receipt.id} tabIndex={onMove ? -1 : undefined} role={label ? "status" : "group"} aria-label={label ?? (position === undefined ? "Queued turn" : `Queued turn ${position}${queueSize === undefined ? "" : ` of ${queueSize}`}`)}>
    {receipt.reason ? <span className="session-turn-queue-reason">{receipt.reason}</span> : null}
    {receipt.state === "interrupted" && receipt.releasedAt === null ? <span className="session-turn-queue-reason">Execution outcome is unknown. Later turns are held.</span> : null}
    {label ? <span>{label}</span> : null}
    {receipt.state === "queued" && onMove && position !== undefined && queueSize !== undefined ? <span className="session-turn-queue-move" role="group" aria-label="Change execution order">
      {(["up", "down"] as const).map((direction) => <button key={direction} className="drawer-toggle compact secondary session-turn-queue-move-button" type="button"
        title={direction === "up" ? "Move Up" : "Move Down"} aria-label={`Move queued turn ${position} ${direction}`} data-queue-move={direction}
        disabled={busy || moveDisabled || (direction === "up" ? position === 1 : position === queueSize)} aria-busy={busyKind === `move-${direction}` || undefined}
        onClick={(event) => { moveFocus.current = event.currentTarget; onMove(receipt, direction); }}>
        <ButtonContent busy={busyKind === `move-${direction}`}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={direction === "up" ? "M12 20V4m-6 6 6-6 6 6" : "M12 4v16m-6-6 6 6 6-6"} /></svg></ButtonContent>
      </button>)}
    </span> : null}
    {receipt.state === "queued" && onSendInput ? <button className="drawer-toggle compact secondary" type="button" title="Send this message to the current turn" disabled={busy} aria-busy={busyKind === "input" || undefined} onClick={() => onSendInput(receipt)}><ButtonContent busy={busyKind === "input"}>Steer</ButtonContent></button> : null}
    {receipt.state === "queued" ? <button className="drawer-toggle compact secondary" type="button" aria-label={position === undefined ? "Cancel queued turn" : `Cancel queued turn ${position}`} disabled={busy} aria-busy={busyKind === "cancel" || undefined} onClick={() => onCancel(receipt)}><ButtonContent busy={busyKind === "cancel"}>Cancel</ButtonContent></button> : null}
    {receipt.state === "interrupted" && receipt.releasedAt === null ? <button className="drawer-toggle compact secondary" type="button" disabled={busy} aria-busy={busyKind === "release" || undefined} onClick={() => onRelease(receipt)}><ButtonContent busy={busyKind === "release"}>Release Later Turns</ButtonContent></button> : null}
  </div>;
}

export function SessionTurnQueueRow(props: Parameters<typeof SessionTurnQueueStatus>[0] & { character: CharacterVisual; resolveImageSource?: MarkdownImageResolver; markdownImageContext?: MarkdownImageContext }) {
  return <><article className="message-row user" data-message-source="turn-queue">
    <div className="message-card user"><div className="message-card-content">
      <MessageRichText text={props.receipt.captured.request.userMessage} resolveImageSource={props.resolveImageSource} markdownImageContext={props.markdownImageContext} />
      <SessionTurnQueueStatus {...props} />
    </div></div>
  </article>
    {props.receipt.state === "failed" ? <SessionRunFailureRow reason={props.receipt.reason ?? ""} character={props.character} /> : null}
  </>;
}
