import type { ReactNode } from "react";
import { SessionHeaderIcon } from "./shell/session-header-icon.js";

/** 同じ Session Folder を Explorer または外部ターミナルで開く処理。 */
export type SessionFilesActionsInput = {
  onOpenExplorer: () => void;
  onOpenTerminal: () => void;
};

/** Session Folder の二つの開き方を、ヘッダー用のアイコンボタンとして並べる。 */
export function createSessionFilesActions({
  onOpenExplorer,
  onOpenTerminal,
}: SessionFilesActionsInput): ReactNode {
  return (
    <>
      <button
        className="drawer-toggle compact secondary session-header-icon-button"
        type="button"
        onClick={onOpenExplorer}
        aria-label="Open Session Folder In Explorer"
        title="Open Session Folder In Explorer"
      >
        <SessionHeaderIcon name="folder" />
      </button>
      <button
        className="drawer-toggle compact secondary session-header-icon-button"
        type="button"
        onClick={onOpenTerminal}
        aria-label="Open External Terminal In Session Folder"
        title="Open External Terminal In Session Folder"
      >
        <SessionHeaderIcon name="external-terminal" />
      </button>
    </>
  );
}
