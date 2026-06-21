import type { ReactNode } from "react";

export type SessionFilesActionsInput = {
  onOpenExplorer: () => void;
  onOpenTerminal: () => void;
};

export function createSessionFilesActions({
  onOpenExplorer,
  onOpenTerminal,
}: SessionFilesActionsInput): ReactNode {
  return (
    <>
      <button
        className="drawer-toggle compact secondary"
        type="button"
        onClick={onOpenExplorer}
        title="Open session files directory"
      >
        Explorer
      </button>
      <button
        className="drawer-toggle compact secondary"
        type="button"
        onClick={onOpenTerminal}
        title="Open terminal in session files directory"
      >
        Terminal
      </button>
    </>
  );
}
