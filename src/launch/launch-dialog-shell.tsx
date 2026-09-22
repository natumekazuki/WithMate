import type { KeyboardEventHandler, ReactNode, RefObject } from "react";

type LaunchDialogShellProps = {
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  ariaLabel?: string;
  showDismissControl?: boolean;
  className?: string;
  dialogClassName?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export type LaunchDialogFooterProps = {
  feedback: string;
  startButtonLabel: string;
  startButtonDisabled: boolean;
  startButtonAriaDisabled?: boolean;
  startButtonBusy?: boolean;
  startButtonLoadingText?: string;
  onStart: () => void;
  startButtonRef?: RefObject<HTMLButtonElement | null>;
  backButtonLabel?: string;
  onBack?: () => void;
  backButtonDisabled?: boolean;
  cancelButtonLabel?: string;
  onCancel?: () => void;
  cancelButtonDisabled?: boolean;
};

export function LaunchDialogFooter({
  feedback,
  startButtonLabel,
  startButtonDisabled,
  startButtonAriaDisabled,
  startButtonBusy = false,
  startButtonLoadingText,
  onStart,
  startButtonRef,
  backButtonLabel,
  onBack,
  backButtonDisabled = false,
  cancelButtonLabel,
  onCancel,
  cancelButtonDisabled = false,
}: LaunchDialogFooterProps) {
  return (
    <>
      {feedback ? <p className="launch-feedback">{feedback}</p> : null}
      {backButtonLabel && onBack ? (
        <button className="drawer-toggle compact secondary" type="button" disabled={backButtonDisabled} onClick={onBack}>
          {backButtonLabel}
        </button>
      ) : null}
      {cancelButtonLabel && onCancel ? (
        <button className="drawer-toggle compact secondary" type="button" disabled={cancelButtonDisabled} onClick={onCancel}>
          {cancelButtonLabel}
        </button>
      ) : null}
      <button
        ref={startButtonRef}
        className="start-session-button"
        type="button"
        disabled={startButtonDisabled}
        aria-disabled={startButtonAriaDisabled}
        aria-busy={startButtonBusy || undefined}
        aria-label={startButtonBusy ? (startButtonLoadingText || startButtonLabel) : undefined}
        onClick={onStart}
      >
        {startButtonBusy ? <span className="chat-skill-picker-spinner" aria-hidden="true" /> : startButtonLabel}
      </button>
    </>
  );
}

export function LaunchDialogShell({
  onClose,
  dialogRef,
  onKeyDown,
  ariaLabel,
  showDismissControl = true,
  className = "launch-modal",
  dialogClassName,
  children,
  footer,
}: LaunchDialogShellProps) {
  const dialogClassNameValue = [
    "launch-dialog",
    "panel",
    dialogClassName ?? "",
    showDismissControl ? "" : "launch-dialog-no-dismiss",
  ].filter(Boolean).join(" ");

  return (
    <div className={className} role="dialog" aria-modal="true" aria-label={ariaLabel} onClick={onClose}>
      <section
        ref={dialogRef}
        className={dialogClassNameValue}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {showDismissControl ? (
          <div className="launch-dialog-head minimal">
            <button className="diff-close" type="button" aria-label="Close" title="Close" onClick={onClose}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : null}

        <div className="launch-panel minimal">
          {children}
        </div>

        <div className="launch-dialog-foot minimal">{footer}</div>
      </section>
    </div>
  );
}
