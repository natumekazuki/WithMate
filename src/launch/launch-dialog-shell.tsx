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
  onStart: () => void;
  startButtonRef?: RefObject<HTMLButtonElement | null>;
};

export function LaunchDialogFooter({
  feedback,
  startButtonLabel,
  startButtonDisabled,
  startButtonAriaDisabled,
  onStart,
  startButtonRef,
}: LaunchDialogFooterProps) {
  return (
    <>
      {feedback ? <p className="launch-feedback">{feedback}</p> : null}
      <button
        ref={startButtonRef}
        className="start-session-button"
        type="button"
        disabled={startButtonDisabled}
        aria-disabled={startButtonAriaDisabled}
        onClick={onStart}
      >
        {startButtonLabel}
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
