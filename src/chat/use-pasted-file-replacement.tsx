import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PastedSessionFileConflict } from "../../src-shared/window/withmate-window-types.js";
import { LaunchDialogShell } from "../launch/launch-dialog-shell.js";
import { useDialogA11y } from "../ui/a11y.js";

function PastedFileReplacementDialog({ fileName, onResolve }: {
  fileName: string;
  onResolve: (replace: boolean) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: true,
    initialFocusRef: cancelRef,
    onClose: () => onResolve(false),
  });
  return createPortal(
    <LaunchDialogShell
      ariaLabel="Replace Pasted File"
      className="launch-modal pasted-file-replacement-modal"
      dialogClassName="pasted-file-replacement-dialog"
      dialogRef={dialogRef}
      onKeyDown={handleDialogKeyDown}
      onClose={() => onResolve(false)}
      showDismissControl={false}
      footer={<>
        <button ref={cancelRef} className="drawer-toggle compact secondary" type="button" onClick={() => onResolve(false)}>Cancel</button>
        <button className="drawer-toggle compact danger" type="button" onClick={() => onResolve(true)}>Replace File</button>
      </>}
    >
      <h2>Replace File?</h2>
      <p><strong>{fileName}</strong> has different contents.</p>
      <p>This also changes the file used by earlier messages.</p>
    </LaunchDialogShell>,
    document.body,
  );
}

export function usePastedFileReplacement(ownerKey: string | null | undefined, available: boolean) {
  const pending = useRef<{ resolve: (replace: boolean) => void } | null>(null);
  const current = useRef({ ownerKey, available, mounted: true });
  current.current.ownerKey = ownerKey;
  current.current.available = available;
  const [conflict, setConflict] = useState<{ ownerKey: typeof ownerKey; fileName: string } | null>(null);
  useEffect(() => {
    current.current.mounted = true;
    setConflict(null);
    return () => {
      current.current.mounted = false;
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, [ownerKey, available]);

  const resolve = (replace: boolean) => {
    pending.current?.resolve(replace);
    pending.current = null;
    setConflict(null);
  };
  return {
    confirmReplacement: (next: PastedSessionFileConflict): Promise<boolean> => {
      if (!current.current.mounted || !current.current.available || current.current.ownerKey !== ownerKey) return Promise.resolve(false);
      if (pending.current) throw new Error("Finish the current file replacement first.");
      setConflict({ ownerKey, fileName: next.fileName });
      return new Promise((resolve) => { pending.current = { resolve }; });
    },
    replacementDialog: available && conflict?.ownerKey === ownerKey && conflict
      ? <PastedFileReplacementDialog fileName={conflict.fileName} onResolve={resolve} />
      : null,
  };
}
