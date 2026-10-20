import type { SessionTurnQueueReceipt } from "../../../src-shared/session/session-turn-queue.js";
import { MessageRichText } from "../../ui/markdown/MessageRichText.js";
import type { MarkdownImageResolver } from "../../ui/markdown/image-resource-loader.js";
import { ButtonContent } from "../../ui/button-content.js";
import type { SessionTurnQueueActionKind } from "./use-session-turn-queue.js";
import type { SessionTurnSubmission } from "../runtime/session-turn-submissions.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import type { CharacterVisual } from "../../../src-shared/character/character-state.js";
import { SessionRunFailureRow } from "./session-run-failure.js";

export function SessionTurnSubmissionRow({ submission, resolveImageSource, character }: { submission: SessionTurnSubmission; character: CharacterVisual; resolveImageSource?: MarkdownImageResolver }) {
  return <><article className="message-row user" data-message-source="turn-submission">
    <div className="message-card user"><div className="message-card-content">
      <MessageRichText text={submission.userMessage} resolveImageSource={resolveImageSource} />
      {submission.error ? submission.uncertain ? <p className="pending-run-error-note" role="alert">{submission.error}</p> : null
        : <LoadingIndicator inline label="Queued turn" />}
    </div></div>
  </article>
    {submission.error && !submission.uncertain ? <SessionRunFailureRow reason={submission.error} character={character} /> : null}
  </>;
}

export function SessionTurnQueueStatus({ receipt, position, busy, busyKind, onCancel, onRelease, onSendInput }: {
  receipt: SessionTurnQueueReceipt; position?: number; busy: boolean;
  busyKind?: SessionTurnQueueActionKind | null;
  onCancel: (receipt: SessionTurnQueueReceipt) => void; onRelease: (receipt: SessionTurnQueueReceipt) => void;
  onSendInput?: (receipt: SessionTurnQueueReceipt) => void;
}) {
  if (receipt.state !== "queued" && receipt.state !== "interrupted") return null;
  const label = receipt.state === "interrupted" ? "Interrupted" : undefined;
  return <div className="session-turn-queue-status" role={label ? "status" : undefined} aria-label={label}>
    {receipt.reason ? <span className="session-turn-queue-reason">{receipt.reason}</span> : null}
    {receipt.state === "interrupted" && receipt.releasedAt === null ? <span className="session-turn-queue-reason">Execution outcome is unknown. Later turns are held.</span> : null}
    {label ? <span>{label}</span> : null}
    {receipt.state === "queued" && onSendInput ? <button className="drawer-toggle compact secondary" type="button" title="Send this message to the current turn" disabled={busy} aria-busy={busyKind === "input" || undefined} onClick={() => onSendInput(receipt)}><ButtonContent busy={busyKind === "input"}>Steer</ButtonContent></button> : null}
    {receipt.state === "queued" ? <button className="drawer-toggle compact secondary" type="button" aria-label={position === undefined ? "Cancel queued turn" : `Cancel queued turn ${position}`} disabled={busy} aria-busy={busyKind === "cancel" || undefined} onClick={() => onCancel(receipt)}><ButtonContent busy={busyKind === "cancel"}>Cancel</ButtonContent></button> : null}
    {receipt.state === "interrupted" && receipt.releasedAt === null ? <button className="drawer-toggle compact secondary" type="button" disabled={busy} aria-busy={busyKind === "release" || undefined} onClick={() => onRelease(receipt)}><ButtonContent busy={busyKind === "release"}>Release Later Turns</ButtonContent></button> : null}
  </div>;
}

export function SessionTurnQueueRow(props: Parameters<typeof SessionTurnQueueStatus>[0] & { character: CharacterVisual; resolveImageSource?: MarkdownImageResolver }) {
  return <><article className="message-row user" data-message-source="turn-queue">
    <div className="message-card user"><div className="message-card-content">
      <MessageRichText text={props.receipt.captured.request.userMessage} resolveImageSource={props.resolveImageSource} />
      <SessionTurnQueueStatus {...props} />
    </div></div>
  </article>
    {props.receipt.state === "failed" ? <SessionRunFailureRow reason={props.receipt.reason ?? ""} character={props.character} /> : null}
  </>;
}
