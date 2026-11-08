import { useRef } from "react";
import { createPortal } from "react-dom";
import { LaunchDialogShell } from "../../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../../ui/a11y.js";
import { ButtonContent } from "../../ui/button-content.js";
import { ErrorDetailsButton } from "../../ui/error-details.js";

export function SessionRoleChangeDialog({ title, pending, error, onClose, onConfirm }: {
  title: string;
  pending: boolean;
  error: string;
  onClose(): void;
  onConfirm(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = () => { if (!pending) onClose(); };
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true,
    onClose: close,
    initialFocusRef: cancelRef,
  });
  return createPortal(
    <LaunchDialogShell
      ariaLabel="Change Session Role"
      dialogClassName="session-role-change-dialog"
      dialogRef={dialogRef}
      dialogTabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      onClose={close}
      showDismissControl={false}
      closeOnBackdropClick={false}
      footer={<>
        {error ? <div className="session-role-change-error" role="alert">
          Role could not be changed.
          <ErrorDetailsButton message={error} label="Role Change Error Details" />
        </div> : null}
        <button ref={cancelRef} className="launch-toggle" type="button" disabled={pending} onClick={close}>Cancel</button>
        <button className="start-session-button" type="button" disabled={pending} aria-busy={pending || undefined} onClick={() => {
          dialogRef.current?.focus();
          onConfirm();
        }}>
          <ButtonContent busy={pending} busyLabel="Changing session role.">Change Role</ButtonContent>
        </button>
      </>}
    >
      <h2>Change Session Role</h2>
      <p>Make “{title}” an <strong>Overall Coordinator</strong>?</p>
      <p>It will be able to create child Sessions. Its conversation and Workspace will stay unchanged. This change cannot be undone.</p>
    </LaunchDialogShell>, document.body,
  );
}
