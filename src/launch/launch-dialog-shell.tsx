import type { KeyboardEventHandler, ReactNode, RefObject } from "react";

type LaunchDialogShellProps = {
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
  className?: string;
  dialogClassName?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function LaunchDialogShell({
  onClose,
  dialogRef,
  onKeyDown,
  className = "launch-modal",
  dialogClassName,
  children,
  footer,
}: LaunchDialogShellProps) {
  return (
    <div className={className} role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className={`launch-dialog panel${dialogClassName ? ` ${dialogClassName}` : ""}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="launch-dialog-head minimal">
          <button className="diff-close" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="launch-panel minimal">
          {children}
        </div>

        <div className="launch-dialog-foot minimal">{footer}</div>
      </section>
    </div>
  );
}
