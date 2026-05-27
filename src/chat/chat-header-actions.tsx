import type { KeyboardEventHandler, ReactNode } from "react";

import type { SessionHeaderProps } from "../session-components.js";
import { resolveChatHeaderVisibility } from "./chat-header-visibility.js";
import { createSessionFilesActions } from "./session-files-actions.js";

export type WorkspaceExplorerActionOptions = {
  disabled?: boolean;
  onOpenExplorer: () => void;
};

export type AuxiliaryHeaderActionsOptions = {
  isActive: boolean;
  showIdleLabel?: boolean;
  startDisabled?: boolean;
  returnDisabled?: boolean;
  onStart: () => void;
  onReturnToMain: () => void;
};

export type LiveSessionHeaderPropsInput = {
  taskTitle: string;
  isEditingTitle: boolean;
  titleDraft: string;
  isRunning: boolean;
  isReadOnly?: boolean;
  isAuxiliaryMode?: boolean;
  canViewAuxiliaryAuditLog?: boolean;
  canDeleteSession: boolean;
  canViewAuditLog: boolean;
  showTerminalButton?: boolean;
  onToggleExpanded: () => void;
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

export function createAuxiliaryHeaderActions({
  isActive,
  showIdleLabel = false,
  startDisabled = false,
  returnDisabled = false,
  onStart,
  onReturnToMain,
}: AuxiliaryHeaderActionsOptions) {
  const shouldShowLabel = isActive || showIdleLabel;

  return (
    <div className="session-window-control-group auxiliary-session-control-group" role="group" aria-label="Auxiliary session actions">
      {shouldShowLabel ? <span className="session-window-control-group-label">Auxiliary</span> : null}
      {isActive ? (
        <button
          className="drawer-toggle compact secondary"
          type="button"
          onClick={onReturnToMain}
          disabled={returnDisabled}
        >
          Return to main
        </button>
      ) : (
        <button
          className="drawer-toggle compact secondary"
          type="button"
          onClick={onStart}
          disabled={startDisabled}
        >
          Auxiliary
        </button>
      )}
    </div>
  );
}

export function buildLiveSessionHeaderProps(input: LiveSessionHeaderPropsInput): SessionHeaderProps {
  return {
    taskTitle: input.taskTitle,
    isEditingTitle: input.isEditingTitle,
    titleDraft: input.titleDraft,
    isRunning: input.isRunning,
    isReadOnly: input.isReadOnly,
    ...resolveChatHeaderVisibility({
      isAuxiliaryMode: input.isAuxiliaryMode,
      canViewAuxiliaryAuditLog: input.canViewAuxiliaryAuditLog,
      canDeleteSession: input.canDeleteSession,
      canViewAuditLog: input.canViewAuditLog,
    }),
    showTerminalButton: input.showTerminalButton ?? true,
    onToggleExpanded: input.onToggleExpanded,
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
    actions: input.actions,
    workspaceActions: createWorkspaceExplorerAction({
      disabled: input.isWorkspaceExplorerDisabled,
      onOpenExplorer: input.onOpenWorkspaceExplorer,
    }),
  };
}
