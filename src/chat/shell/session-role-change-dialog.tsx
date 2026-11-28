import { useRef } from "react";
import { createPortal } from "react-dom";
import { LaunchDialogShell } from "../../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../../ui/a11y.js";
import { ButtonContent } from "../../ui/button-content.js";
import { ErrorDetailsButton } from "../../ui/error-details.js";

/** Overall Coordinator への変更を確認し、処理中は閉じる操作と再送を抑える。 */
export function SessionRoleChangeDialog({
  title,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  title: string;
  pending: boolean;
  error: string;
  /** 変更を確定せず、確認ダイアログを閉じる。 */
  onClose(): void;
  /** 表示しているセッションの役割変更を申請する。 */
  onConfirm(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** Escape とキャンセルのどちらも、役割変更中はダイアログを維持する。 */
  const close = () => {
    if (!pending) onClose();
  };
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
      footer={
        <>
          {error ? (
            <div className="session-role-change-error" role="alert">
              Role could not be changed.
              <ErrorDetailsButton
                message={error}
                label="Role Change Error Details"
              />
            </div>
          ) : null}
          <button
            ref={cancelRef}
            className="launch-toggle"
            type="button"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </button>
          <button
            className="start-session-button"
            type="button"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => {
              dialogRef.current?.focus();
              onConfirm();
            }}
          >
            <ButtonContent busy={pending} busyLabel="Changing session role.">
              Change Role
            </ButtonContent>
          </button>
        </>
      }
    >
      <p>
        Make “{title}” an <strong>Overall Coordinator</strong>?
      </p>
    </LaunchDialogShell>,
    document.body,
  );
}
