import type { CSSProperties, ReactNode } from "react";

import type { DiffPreviewPayload } from "../../src-shared/session/session-state.js";
import {
  SessionAuditLogModal,
  type SessionAuditLogModalProps,
} from "./runtime/session-audit-log.js";
import { SessionDiffModal } from "./runtime/session-diff.js";

export type ChatSessionModalsProps = {
  selectedDiff: DiffPreviewPayload | null;
  selectedDiffThemeStyle: CSSProperties;
  auditLogProps: SessionAuditLogModalProps;
  onCloseDiff: () => void;
  onOpenDiffWindow: (payload: DiffPreviewPayload) => void;
  children?: ReactNode;
};

export function ChatSessionModals({
  selectedDiff,
  selectedDiffThemeStyle,
  auditLogProps,
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

      <SessionAuditLogModal {...auditLogProps} />

      {children}
    </>
  );
}
