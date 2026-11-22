import { useRef, useState } from "react";
import type { Message } from "../../../src-shared/session/session-state.js";
import { LoadError } from "../../ui/load-error.js";
import { ComposerIcon } from "../composer/composer-icon.js";
import { createSessionTurnClientRequestId } from "../runtime/session-submit-coordinator.js";
import { useFailedTurnRetry } from "../runtime/failed-turn-retry-context.js";
import { useTurnInputRead, type TurnInputReadContext } from "./turn-input-details.js";

export function FailedTurnRetry({ message, context, turnId, dock = false, targetLabel, disabled = false }: {
  message: Message; context: TurnInputReadContext; turnId?: string; dock?: boolean; targetLabel?: string; disabled?: boolean;
}) {
  const retry = useFailedTurnRetry();
  const read = useTurnInputRead({ message, context, turnId });
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const execution = read.observed;
  const available = execution?.turnState === "failed" && execution.receiptState === "failed"
    && execution.inputs.entry?.kind === "start" && execution.inputs.entry.stage === "fixed"
    && !!execution.turnId && (!turnId || execution.turnId === turnId) && !!execution.receiptId && !!execution.origin;
  if (!retry) return null;
  if (!dock && execution?.turnId && retry.dockTurn?.sessionId === context.target.sessionId && retry.dockTurn.turnId === execution.turnId) return null;
  if (read.readError) return <LoadError message={`Could not load the failed Turn for Resend: ${read.readError}`} onRetry={() => read.setRevision((value) => value + 1)} />;
  if (!available || !execution?.receiptId || !execution.turnId) return dock && execution
    ? <LoadError message="Resend is unavailable: the failed Turn or its saved input could not be confirmed." /> : null;
  const submit = async () => {
    if (pending.current || disabled || retry.blocked(context.target.sessionId)) return;
    pending.current = true; setBusy(true); setError("");
    try {
      await retry.submit({ target: context.target, receiptId: execution.receiptId!, turnId: execution.turnId!, clientRequestId: createSessionTurnClientRequestId() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not resend this failed Turn.");
    } finally { pending.current = false; setBusy(false); }
  };
  const name = targetLabel ?? (context.target.kind === "main" ? "Main" : "Auxiliary");
  const label = dock ? `${name}: Resend Previous Request` : `${name}: Resend Failed Turn`;
  return <>
    <button className="drawer-toggle compact secondary composer-icon-button failed-turn-resend" type="button" title={label} aria-label={label} disabled={disabled || busy || retry.blocked(context.target.sessionId)} onClick={() => void submit()}>
      <ComposerIcon name="resend" /><span className="visually-hidden">Resend</span>
    </button>
    {execution.inputs.entry?.comparison === "changed" ? <span className="failed-turn-retry-feedback">Uses the instruction edited before this Turn started.</span> : null}
    {error ? <LoadError className="failed-turn-retry-feedback" message={`Resend: ${error}${error.includes("Check Receipt") ? "" : " Check the reason, then try Resend again."}`} /> : null}
  </>;
}
