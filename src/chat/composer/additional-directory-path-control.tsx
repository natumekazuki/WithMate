import { useEffect, useRef, useState } from "react";

import { LaunchDialogShell } from "../../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../../ui/a11y.js";

export function AdditionalDirectoryPathControl({ disabled, onAdd }: {
  disabled: boolean;
  onAdd: (directoryPath: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inFlightRef = useRef(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const close = () => {
    if (!inFlightRef.current) setOpen(false);
  };
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: open && !disabled,
    onClose: close,
    initialFocusRef: inputRef,
  });
  const submit = async () => {
    if (disabled || inFlightRef.current || !directoryPath.trim()) return;
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
          setDirectoryPath("");
          setError("");
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
              <button className="drawer-toggle compact additional-directory-path-add" type="submit" form="additional-directory-path-form" disabled={busy || !directoryPath.trim()} aria-busy={busy || undefined}>
                Add
              </button>
            </>
          }
        >
          <h2>Add Directory By Path</h2>
          <form id="additional-directory-path-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <input
              id="additional-directory-path"
              className="launch-field-input"
              aria-label="Directory path"
              autoComplete="off"
              spellCheck={false}
              ref={inputRef}
              value={directoryPath}
              readOnly={busy}
              aria-invalid={!!error}
              aria-describedby={error ? "additional-directory-path-error" : undefined}
              onChange={(event) => { setDirectoryPath(event.target.value); setError(""); }}
            />
            {error ? <p id="additional-directory-path-error" className="launch-feedback" role="alert">{error}</p> : null}
          </form>
        </LaunchDialogShell>
      ) : null}
    </>
  );
}
