import type { CSSProperties, ReactNode } from "react";

import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import { SessionDiffModal } from "./runtime/session-diff.js";

export type ChatSessionModalsProps = {
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  children?: ReactNode;
};

export function ChatSessionModals({
  selectedDiff,
  selectedDiffThemeStyle,
  onCloseDiff,
  onOpenDiffWindow,
  children,
}: ChatSessionModalsProps) {
  return (
    <>
      <SessionDiffModal
        selectedDiff={selectedDiff}
        themeStyle={selectedDiffThemeStyle}
        onClose={onCloseDiff}
        onOpenDiffWindow={onOpenDiffWindow}
      />


      {children}
    </>
  );
}
