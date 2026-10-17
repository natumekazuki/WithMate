import { useEffect, useRef, useState } from "react";

import { LaunchDialogShell } from "../../launch/launch-dialog-shell.js";
import { DirectoryPathField } from "../../launch/directory-path-field.js";
import {
  createDirectoryPathValidationController,
  type DirectoryPathValidationState,
} from "../../launch/directory-path-validation.js";
import {
  resolveWorkspaceDirectoryValidationMessage,
  type WorkspaceDirectoryValidationResult,
} from "../../../src-shared/window/workspace-directory-validation.js";
import { useDialogA11y } from "../../ui/a11y.js";
import { ButtonContent } from "../../ui/button-content.js";

export function AdditionalDirectoryPathControl({ disabled, onAdd, onValidate }: {
  disabled: boolean;
  onAdd: (directoryPath: string) => void | Promise<void>;
  onValidate: (directoryPath: string) => Promise<WorkspaceDirectoryValidationResult>;
}) {
  const [open, setOpen] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const [error, setError] = useState("");
  const [validation, setValidation] = useState<DirectoryPathValidationState>("idle");
  const [validationMessage, setValidationMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inFlightRef = useRef(false);
  const validateRef = useRef(onValidate);
  validateRef.current = onValidate;
  const [validationController] = useState(() => createDirectoryPathValidationController({
    validate: (targetPath) => validateRef.current(targetPath),
    onScheduled: (targetPath) => {
      setValidation(targetPath ? "debouncing" : "idle");
      setValidationMessage("");
    },
    onValidationStart: () => setValidation("pending"),
    onResult: (_targetPath, result) => {
      setValidation(result.valid ? "valid" : "invalid");
      setValidationMessage(resolveWorkspaceDirectoryValidationMessage(result));
    },
  }));
  useEffect(() => () => validationController.cancel(), [validationController]);
  useEffect(() => {
    if (disabled) {
      validationController.cancel();
      setOpen(false);
    }
  }, [disabled, validationController]);
  const close = () => {
    if (!inFlightRef.current) {
      validationController.cancel();
      setOpen(false);
    }
  };
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: open && !disabled,
    onClose: close,
    initialFocusRef: inputRef,
  });
  const submit = async () => {
    if (disabled || inFlightRef.current || !directoryPath.trim() || validation !== "valid") return;
    inFlightRef.current = true;
    inputRef.current?.focus();
    setBusy(true);
    setError("");
    try {
      await onAdd(directoryPath.trim());
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the directory.");
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="drawer-toggle compact secondary composer-skill-button"
        type="button"
        disabled={disabled || busy}
        aria-haspopup="dialog"
        onClick={() => {
          validationController.cancel();
          setDirectoryPath("");
          setError("");
          setValidation("idle");
          setValidationMessage("");
          setOpen(true);
        }}
      >
        Add Directory By Path
      </button>
      {open && !disabled ? (
        <LaunchDialogShell
          onClose={close}
          dialogRef={dialogRef}
          onKeyDown={handleDialogKeyDown}
          ariaLabel="Add Directory By Path"
          className="launch-modal additional-directory-path-modal"
          dialogClassName="additional-directory-path-dialog"
          showDismissControl={false}
          footer={
            <>
              <button className="drawer-toggle compact secondary" type="button" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button className="drawer-toggle compact additional-directory-path-add" type="submit" form="additional-directory-path-form" disabled={busy || validation !== "valid"} aria-busy={busy || undefined}>
                <ButtonContent busy={busy}>Add</ButtonContent>
              </button>
            </>
          }
        >
          <h2>Add Directory By Path</h2>
          <form id="additional-directory-path-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <DirectoryPathField
              id="additional-directory-path"
              ariaLabel="Directory path"
              autoComplete="off"
              spellCheck={false}
              inputRef={inputRef}
              value={directoryPath}
              readOnly={busy}
              validation={validation}
              errorMessage={error || validationMessage}
              errorRole="alert"
              checkingLabel="Checking directory path…"
              onChange={(value) => {
                setDirectoryPath(value);
                setError("");
                validationController.schedule(value.trim());
              }}
            />
          </form>
        </LaunchDialogShell>
      ) : null}
    </>
  );
}
