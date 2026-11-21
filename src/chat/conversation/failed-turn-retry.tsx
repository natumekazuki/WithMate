import { useEffect, useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import { createSessionTurnClientRequestId } from "../runtime/session-submit-coordinator.js";
import { useFailedTurnRetry } from "../runtime/failed-turn-retry-context.js";
import { useTurnInputRead, type TurnInputReadContext } from "./turn-input-details.js";

export function FailedTurnRetry({ message, context }: { message: Message; context: TurnInputReadContext }) {
  const retry = useFailedTurnRetry();
  const read = useTurnInputRead({ message, context });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const execution = read.observed;
  const available = execution?.turnState === "failed" && execution.receiptState === "failed"
    && execution.inputs.entry?.kind === "start" && execution.inputs.entry.stage === "fixed"
    && !!execution.turnId && !!execution.receiptId && !!execution.origin;
  useEffect(() => {
    if (!dialog.current) return;
    if (open && !dialog.current.open) { dialog.current.showModal(); cancel.current?.focus(); }
    if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  if (!retry || !available || !execution?.receiptId || !execution.turnId || !execution.origin) return null;
  const sourceOrigin = execution.retrySource?.origin ?? execution.origin;
  const sender = sourceOrigin.kind === "session" ? sourceOrigin.actorSnapshot?.character.name ?? "Unknown Session" : "You";
  const close = () => { if (!busy) { setOpen(false); button.current?.focus(); } };
  const submit = async () => {
    if (busy || retry.blocked(context.target.sessionId)) return;
    setBusy(true); setError("");
    try {
      await retry.submit({ target: context.target, receiptId: execution.receiptId!, turnId: execution.turnId!, clientRequestId: createSessionTurnClientRequestId() });
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not retry this Turn.");
    } finally { setBusy(false); }
  };
  return <>
    <button ref={button} className="drawer-toggle compact secondary" type="button" disabled={retry.blocked(context.target.sessionId)} onClick={() => { setError(""); setOpen(true); }}>Retry Failed Turn</button>
    <dialog ref={dialog} className="session-recovery-conflict" aria-label="Retry Failed Turn" onCancel={(event) => { event.preventDefault(); close(); }}>
      <p>Retry the starting instruction from {sender} as a new Turn in this conversation.</p>
      {execution.inputs.entry?.comparison === "changed" ? <p>The instruction was edited before the failed Turn started. The dispatched version will be used.</p> : null}
      <p>Actions from the failed Turn may already have taken effect. Additional inputs are not resent. Attached files may have changed since then.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="session-recovery-conflict-actions">
        <button ref={cancel} className="drawer-toggle compact secondary" type="button" disabled={busy} onClick={close}>Cancel</button>
        <button className="drawer-toggle compact danger" type="button" disabled={busy || retry.blocked(context.target.sessionId)} onClick={() => void submit()}>{busy ? "Submitting…" : "Retry Failed Turn"}</button>
      </div>
    </dialog>
  </>;
}
