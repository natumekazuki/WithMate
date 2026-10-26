import { useEffect, useId, useRef, useState } from "react";

import { ButtonContent } from "../ui/button-content.js";

export function CharacterEditorReadError({ subject, summary, details, notice, onRetry, retryBusy = false }: {
  subject: string;
  summary: string;
  details: string;
  notice?: string;
  onRetry: () => void;
  retryBusy?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);

  const closeAndRestoreFocus = () => {
    panelRef.current?.hidePopover();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      panelRef.current?.hidePopover();
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="character-editor-read-error">
      <span className={notice ? undefined : "visually-hidden"} role="alert">{notice ?? summary}</span>
      <div className="character-editor-read-error-actions">
        <button
          ref={triggerRef}
          className="launch-toggle compact character-editor-error-toggle"
          type="button"
          aria-label={`${open ? "Hide" : "Show"} ${subject} Error Details`}
          title={open ? "Hide Error Details" : "Show Error Details"}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls={`${id}-details`}
          popoverTarget={`${id}-details`}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
        </button>
        <button className="launch-toggle compact" type="button" disabled={retryBusy} aria-busy={retryBusy || undefined} onClick={onRetry}>
          <ButtonContent busy={retryBusy} busyLabel={`Retrying ${subject}`}>Retry</ButtonContent>
        </button>
      </div>
      <div
        ref={panelRef}
        id={`${id}-details`}
        className="character-editor-error-popover"
        popover="auto"
        role="dialog"
        aria-label={`${subject} Error Details`}
        tabIndex={-1}
        onToggle={(event) => {
          const showing = event.newState === "open";
          setOpen(showing);
          if (showing) panelRef.current?.focus();
        }}
      >
        <button className="launch-toggle compact character-editor-error-close" type="button" aria-label="Close Error Details" title="Close Error Details" onClick={closeAndRestoreFocus}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
        <pre>{details}</pre>
      </div>
    </div>
  );
}
