import { type CSSProperties } from "react";

import type { DiffPreviewPayload } from "../../../src-shared/session/session-state.js";
import { DiffViewer } from "../../ui/DiffViewer.js";

import { useDialogA11y } from "../../ui/a11y.js";

export type SessionDiffModalProps = {
  selectedDiff: DiffPreviewPayload | null;
  themeStyle: CSSProperties;
  onClose: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
};

export function SessionDiffModal({
  selectedDiff,
  themeStyle,
  onClose,
  onOpenDiffWindow,
}: SessionDiffModalProps) {
  const { dialogRef, handleDialogKeyDown } = useDialogA11y<HTMLElement>({
    open: !!selectedDiff,
    onClose,
  });

  if (!selectedDiff) {
    return null;
  }

  return (
    <div className="diff-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <section
        ref={dialogRef}
        className="diff-editor panel theme-accent"
        style={themeStyle}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="diff-titlebar">
          <h2>{selectedDiff.file.path}</h2>
          <div className="diff-titlebar-actions">
            <button className="diff-close diff-popout" type="button" onClick={() => onOpenDiffWindow(selectedDiff)}>
              Open in window
            </button>
            <button className="diff-close" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <DiffViewer file={selectedDiff.file} />
      </section>
    </div>
  );
}
