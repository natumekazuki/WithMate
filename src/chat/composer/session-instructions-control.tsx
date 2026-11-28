import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  SESSION_INSTRUCTIONS_MAX_BYTES,
  sessionInstructionsByteLength,
  type SessionInstructionsTarget,
} from "../../../src-shared/session/session-instructions.js";
import { LaunchDialogShell } from "../../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../../ui/a11y.js";
import { ButtonContent } from "../../ui/button-content.js";

type InstructionsControlProps = {
  api: Pick<WithMateWindowApi, "getSessionInstructions" | "setSessionInstructions">;
  target: SessionInstructionsTarget;
  title: string;
};

/** Hosts the editor for one target. Key by the complete identity so a switch discards the old editor. */
export function SessionInstructionsControl(props: InstructionsControlProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="composer-instructions-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Instructions
      </button>
      {open ? createPortal(<SessionInstructionsDialog {...props} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

/** An absent body indicates that loading has not succeeded, not a saved empty value. */
type InstructionRead = { status: "loading" | "failed" } | { status: "loaded"; body: string };

/** Reads on opening and edits an isolated draft until Cancel or acknowledged Save. */
function SessionInstructionsDialog({ api, target, title, onClose }: InstructionsControlProps & { onClose: () => void }) {
  const [read, setRead] = useState<InstructionRead>({ status: "loading" });
  const [readAttempt, setReadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const mounted = useRef(false);
  const pendingSave = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();
  const counterId = useId();
  const timingId = useId();
  const limitErrorId = useId();

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const closeUnlessSaving = () => {
    // Cancel discards edits; it cannot undo a replacement already dispatched.
    if (!pendingSave.current) onClose();
  };
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true, onClose: closeUnlessSaving, initialFocusRef: inputRef,
  });

  // Capture the target once for this opening, not on every live Session projection update.
  const [openedTarget] = useState(target);
  useEffect(() => {
    let current = true;
    void api.getSessionInstructions(openedTarget).then((body) => {
      if (current) setRead({ status: "loaded", body });
    }, () => {
      if (current) setRead({ status: "failed" });
    });
    return () => { current = false; };
  }, [api, openedTarget, readAttempt]);

  const bytes = read.status === "loaded" ? sessionInstructionsByteLength(read.body) : null;
  const overLimit = bytes !== null && bytes > SESSION_INSTRUCTIONS_MAX_BYTES;

  /** Dispatches one exact replacement and only alters the editor that started it. */
  const save = async () => {
    // Check independently of the rendered button so two events cannot overlap.
    if (read.status !== "loaded" || overLimit || pendingSave.current) return;
    pendingSave.current = true;
    setSaving(true);
    setSaveFailed(false);
    inputRef.current?.focus();
    try {
      await api.setSessionInstructions(openedTarget, read.body);
      if (mounted.current) onClose();
    } catch {
      // Keep the full draft for correction or retry.
      if (mounted.current) setSaveFailed(true);
    } finally {
      pendingSave.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <LaunchDialogShell
      dialogRef={dialogRef}
      dialogTabIndex={-1}
      className="launch-modal session-instructions-modal"
      dialogClassName="session-instructions-dialog"
      ariaLabelledBy={headingId}
      showDismissControl={false}
      closeOnBackdropClick={false}
      onClose={closeUnlessSaving}
      onKeyDown={(event) => {
        // Keep Session shortcuts out of the modal without intercepting text input.
        event.stopPropagation();
        if (!event.nativeEvent.isComposing) handleDialogKeyDown(event);
      }}
      footer={
        <>
          <button type="button" className="drawer-toggle compact secondary" disabled={saving} onClick={closeUnlessSaving}>Cancel</button>
          <button
            type="button" className="start-session-button" disabled={read.status !== "loaded" || overLimit || saving}
            aria-busy={saving || undefined} onClick={() => void save()}
          >
            <ButtonContent busy={saving} busyLabel="Saving Instructions">Save</ButtonContent>
          </button>
        </>
      }
    >
      <div className="session-instructions-editor">
        <header>
          <h2 id={headingId}>Session Instructions</h2>
          <p className="session-instructions-target">{title}</p>
        </header>
        <textarea
          ref={inputRef}
          className="session-instructions-body"
          aria-label="Instructions"
          aria-describedby={`${counterId} ${timingId}${overLimit ? ` ${limitErrorId}` : ""}`}
          aria-invalid={overLimit || undefined}
          aria-busy={read.status === "loading" || undefined}
          readOnly={read.status !== "loaded" || saving}
          value={read.status === "loaded" ? read.body : ""}
          onChange={(event) => {
            setRead({ status: "loaded", body: event.target.value });
            setSaveFailed(false);
          }}
          spellCheck={false}
        />
        <div className="session-instructions-meta">
          <span id={timingId}>Changes apply from the next turn.</span>
          <span id={counterId}>{bytes?.toLocaleString("en-US") ?? "—"} / {SESSION_INSTRUCTIONS_MAX_BYTES.toLocaleString("en-US")} bytes</span>
        </div>
        <div className="session-instructions-feedback">
          {read.status === "loading" ? <span role="status">Loading Instructions…</span> : null}
          {read.status === "failed" ? <>
            <span role="alert">Could not load instructions.</span>
            <button type="button" className="drawer-toggle compact secondary" onClick={() => {
              inputRef.current?.focus();
              setRead({ status: "loading" });
              setReadAttempt((attempt) => attempt + 1);
            }}>Retry</button>
          </> : null}
          {overLimit ? <span id={limitErrorId} role="alert">Instructions exceed the byte limit.</span> : null}
          {saveFailed ? <span role="alert">Could not save instructions. Your draft is still here.</span> : null}
        </div>
      </div>
    </LaunchDialogShell>
  );
}
