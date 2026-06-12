import type { SessionHeaderProps } from "../session-components.js";

export type ChatHeaderVisibilityOptions = {
  isAuxiliaryMode?: boolean;
  canViewAuxiliaryAuditLog?: boolean;
  canDeleteSession?: boolean;
  canViewAuditLog?: boolean;
};

export type ChatHeaderVisibility = Pick<
  SessionHeaderProps,
  "showRenameButton" | "showAuditLogButton" | "showDeleteButton"
>;

export function resolveChatHeaderVisibility({
  isAuxiliaryMode = false,
  canViewAuxiliaryAuditLog = false,
  canDeleteSession = true,
  canViewAuditLog = true,
}: ChatHeaderVisibilityOptions): ChatHeaderVisibility {
  return {
    showRenameButton: !isAuxiliaryMode,
    showAuditLogButton: canViewAuditLog && (!isAuxiliaryMode || canViewAuxiliaryAuditLog),
    showDeleteButton: canDeleteSession && !isAuxiliaryMode,
  };
}
