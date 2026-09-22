import type { KeyboardEventHandler, ReactNode } from "react";

import type { SessionHeaderProps } from "./shell/session-header.js";
import type { KeyboardShortcutSettings } from "../../src-shared/settings/keyboard-shortcut-state.js";
import { appendShortcutLabel, SHORTCUT_COMMAND_IDS } from "../settings/shortcut-registry.js";
import { resolveChatHeaderVisibility } from "./chat-header-visibility.js";
import { createSessionFilesActions } from "./session-files-actions.js";

export type WorkspaceExplorerActionOptions = {
  disabled?: boolean;
  onOpenExplorer: () => void;
};

export type LiveSessionHeaderPropsInput = {
  taskTitle: string;
  isEditingTitle: boolean;
  titleDraft: string;
  isRunning: boolean;
  isReadOnly?: boolean;
  isPinned?: boolean;
  isPinPending?: boolean;
  isAuxiliaryMode?: boolean;
  canViewAuxiliaryAuditLog?: boolean;
  canDeleteSession: boolean;
  canViewAuditLog: boolean;
  showTerminalButton?: boolean;
  isTerminalDisabled?: boolean;
  onOpenAuditLog: () => void;
  onOpenTerminal: () => void;
  onOpenSessionFilesExplorer: () => void;
  onOpenSessionFilesTerminal: () => void;
  onTitleDraftChange: (value: string) => void;
  onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onSaveTitle: () => void;
  onCancelTitleEdit: () => void;
  onStartTitleEdit: () => void;
  onDeleteSession: () => void;
  onTogglePin?: () => void;
  onOpenWorkspaceExplorer: () => void;
  isWorkspaceExplorerDisabled?: boolean;
  actions?: ReactNode;
};

export function createWorkspaceExplorerAction({
  disabled = false,
  onOpenExplorer,
}: WorkspaceExplorerActionOptions) {
  return (
    <button
      className="drawer-toggle compact secondary"
      type="button"
      disabled={disabled}
      onClick={onOpenExplorer}
    >
      Explorer
    </button>
  );
}

export type MessageCollapseHeaderActionOptions = {
  allMessagesCollapsed: boolean;
  disabled?: boolean;
  onToggle: () => void;
  keyboardShortcuts?: KeyboardShortcutSettings;
};

export function createMessageCollapseHeaderAction({
  allMessagesCollapsed,
  disabled = false,
  onToggle,
  keyboardShortcuts,
}: MessageCollapseHeaderActionOptions) {
  const label = allMessagesCollapsed ? "Expand" : "Collapse";
  const accessibleLabel = allMessagesCollapsed
    ? "完了済みmessageをすべて展開"
    : "完了済みmessageをすべて縮小";

  return (
    <button
      className="drawer-toggle compact secondary"
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={accessibleLabel}
      title={appendShortcutLabel(
        accessibleLabel,
        SHORTCUT_COMMAND_IDS.messageToggleCollapse,
        undefined,
        keyboardShortcuts,
      )}
    >
      {label}
    </button>
  );
}

export function buildLiveSessionHeaderProps(input: LiveSessionHeaderPropsInput): SessionHeaderProps {
  return {
    taskTitle: input.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isRunning,
    isReadOnly: input.isReadOnly,
    isPinned: input.isPinned,
    isPinPending: input.isPinPending,
    ...resolveChatHeaderVisibility({
      isAuxiliaryMode: input.isAuxiliaryMode,
      canViewAuxiliaryAuditLog: input.canViewAuxiliaryAuditLog,
      canDeleteSession: input.canDeleteSession,
      canViewAuditLog: input.canViewAuditLog,
    }),
    showTerminalButton: input.showTerminalButton ?? true,
    isTerminalDisabled: input.isTerminalDisabled,
    onOpenAuditLog: input.onOpenAuditLog,
    onOpenTerminal: input.onOpenTerminal,
    sessionFilesActions: createSessionFilesActions({
      onOpenExplorer: input.onOpenSessionFilesExplorer,
      onOpenTerminal: input.onOpenSessionFilesTerminal,
    }),
    onTitleDraftChange: input.onTitleDraftChange,
    onTitleInputKeyDown: input.onTitleInputKeyDown,
    onSaveTitle: input.onSaveTitle,
    onCancelTitleEdit: input.onCancelTitleEdit,
    onStartTitleEdit: input.onStartTitleEdit,
    onDeleteSession: input.onDeleteSession,
    onTogglePin: input.onTogglePin,
    actions: input.actions,
    workspaceActions: createWorkspaceExplorerAction({
      disabled: input.isWorkspaceExplorerDisabled,
      onOpenExplorer: input.onOpenWorkspaceExplorer,
    }),
  };
}
