import { useEffect, useRef, useState } from "react";
import { LoadError } from "../../ui/load-error.js";
import { LoadingIndicator } from "../../ui/loading-indicator.js";
import { ComposerIcon } from "../composer/composer-icon.js";

export type SessionRecoveryActionsProps = {
  retryState: {
    kind: "interrupted" | "failed" | "canceled";
    badge: string;
    title: string;
    lastRequestText: string;
  } | null;
  requestKey: string;
  targetLabel: string;
  isRetryActionDisabled: boolean;
  isRetryEditDisabled: boolean;
  isRetryDraftReplacePending: boolean;
  onResendLastMessage: () => void;
  onEditLastMessage: () => void;
  onConfirmRetryDraftReplace: () => void;
  onCancelRetryDraftReplace: () => void;
  latestTurnLoading?: boolean;
  latestTurnError?: string | null;
  onRetryLatestTurn?: () => void;
};

export function SessionRecoveryAnnouncement({ recovery }: { recovery?: SessionRecoveryActionsProps }) {
  const announced = useRef(new Set<string>());
  const previousConflict = useRef("");
  const [announcement, setAnnouncement] = useState("");
  const state = recovery?.retryState;
  const requestKey = recovery?.requestKey ?? "";
  const targetLabel = recovery?.targetLabel ?? "";
  const pending = recovery?.isRetryDraftReplacePending ?? false;
  useEffect(() => {
    if (!state) {
      setAnnouncement("");
      previousConflict.current = "";
      return;
    }
    const key = `${requestKey}:${state.kind}`;
    if (pending && previousConflict.current !== key) {
      setAnnouncement(`${targetLabel}: Your current draft is preserved. Choose whether to replace it.`);
    } else if (!announced.current.has(key)) {
      setAnnouncement(`${targetLabel}: Resend and Edit are available for the previous request.`);
    } else {
      setAnnouncement("");
    }
    announced.current.add(key);
    previousConflict.current = pending ? key : "";
  }, [requestKey, state?.kind, targetLabel, pending]);
  return <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>;
}

export function SessionRecoveryActions({
  retryState,
  targetLabel,
  isRetryActionDisabled,
  isRetryEditDisabled,
  isRetryDraftReplacePending,
  onResendLastMessage,
  onEditLastMessage,
  onConfirmRetryDraftReplace,
  onCancelRetryDraftReplace,
  latestTurnLoading = false,
  latestTurnError = null,
  onRetryLatestTurn,
}: SessionRecoveryActionsProps) {
  const editRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const conflictDialogRef = useRef<HTMLDialogElement>(null);
  const requestButtonRef = useRef<HTMLButtonElement>(null);
  const requestDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = conflictDialogRef.current;
    if (!dialog) return;
    if (isRetryDraftReplacePending && !dialog.open) {
      dialog.showModal();
      keepRef.current?.focus();
    } else if (!isRetryDraftReplacePending && dialog.open) dialog.close();
  }, [isRetryDraftReplacePending]);
  if (!retryState && !latestTurnLoading && !latestTurnError) return null;
  return (
    <div className="session-recovery-actions" role="group" aria-label={`${targetLabel}: Previous Request Actions`} aria-busy={latestTurnLoading || undefined}>
      {retryState ? <>
        {retryState.kind !== "failed" ? <span className={`session-recovery-badge ${retryState.kind}`}>{retryState.badge}</span> : null}
        <button ref={requestButtonRef} type="button" className="session-recovery-request" aria-label={`${targetLabel}: Show Previous Request`} aria-haspopup="dialog" onClick={() => {
          const dialog = requestDialogRef.current;
          if (!dialog) return;
          dialog.showModal();
          dialog.focus();
          dialog.scrollTop = 0;
        }}>
            <span className="session-recovery-target">{targetLabel}</span>
            <span className="session-recovery-preview">{retryState.lastRequestText.replace(/\s+/g, " ").trim()}</span>
            <span aria-hidden="true">⌄</span>
        </button>
        <dialog ref={requestDialogRef} tabIndex={-1} className="session-recovery-request-dialog" aria-label={`${targetLabel}: Previous Request`} onClick={(event) => event.stopPropagation()} onClose={() => requestButtonRef.current?.focus()}>
          <strong>{targetLabel} · Previous Request</strong>
          <p>{retryState.lastRequestText}</p>
          <button className="drawer-toggle compact secondary" type="button" onClick={() => requestDialogRef.current?.close()}>Close</button>
        </dialog>
        <button className="drawer-toggle compact secondary composer-icon-button" type="button" title={`${targetLabel}: Resend Previous Request`} aria-label={`${targetLabel}: Resend Previous Request`} onClick={() => { if (!isRetryActionDisabled) onResendLastMessage(); }} disabled={isRetryActionDisabled}>
          <ComposerIcon name="resend" />
          <span className="visually-hidden">Resend</span>
        </button>
        <button ref={editRef} className="drawer-toggle compact secondary composer-icon-button" type="button" title={`${targetLabel}: Edit Previous Request`} aria-label={`${targetLabel}: Edit Previous Request`} onClick={() => { if (!isRetryEditDisabled) onEditLastMessage(); }} disabled={isRetryEditDisabled}>
          <ComposerIcon name="edit" />
          <span className="visually-hidden">Edit</span>
        </button>
      </> : null}
      {latestTurnLoading ? <LoadingIndicator label="Loading latest execution" inline /> : null}
      {latestTurnError ? <LoadError message={`Could not load the latest execution: ${latestTurnError}`} onRetry={onRetryLatestTurn} retryDisabled={latestTurnLoading} /> : null}
      {retryState ? <dialog ref={conflictDialogRef} className="session-recovery-conflict" aria-label={`${targetLabel}: Replace Current Draft`} onClick={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); onCancelRetryDraftReplace(); editRef.current?.focus(); }}>
        <p>Your current draft is preserved.</p>
        <div className="session-recovery-conflict-actions">
          <button ref={keepRef} className="drawer-toggle compact secondary" type="button" onClick={() => { onCancelRetryDraftReplace(); editRef.current?.focus(); }}>Keep Current Draft</button>
          <button className="drawer-toggle compact danger" type="button" onClick={() => { if (!isRetryEditDisabled) onConfirmRetryDraftReplace(); }} disabled={isRetryEditDisabled}>Replace With Previous Request</button>
        </div>
      </dialog> : null}
    </div>
  );
}
