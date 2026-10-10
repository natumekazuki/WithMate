import type { SessionHeaderProps } from "./shell/session-header.js";

export type ChatHeaderVisibilityOptions = {
  isAuxiliaryMode?: boolean;
  canDeleteSession?: boolean;
};

export type ChatHeaderVisibility = Pick<
  SessionHeaderProps,
  "showRenameButton" | "showDeleteButton"
>;

export function resolveChatHeaderVisibility({
  isAuxiliaryMode = false,
  canDeleteSession = true,
}: ChatHeaderVisibilityOptions): ChatHeaderVisibility {
  return {
    showRenameButton: !isAuxiliaryMode,
    showDeleteButton: canDeleteSession && !isAuxiliaryMode,
  };
}
