import { useCallback, useState, type KeyboardEventHandler } from "react";

import type { Session } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { currentTimestampLabel } from "../../../src-shared/time-state.js";
import {
  createCancelTitleEditHandler,
  createStartTitleEditHandler,
} from "../session-shell-handlers.js";
import type { SessionHeaderProps } from "./session-header.js";
import { buildLiveSessionHeaderProps } from "../chat-header-actions.js";

export type SessionHeaderOperations = {
  titleDraft: string;
  setTitleDraft(title: string): void;
  isEditingTitle: boolean;
  startTitleEdit(): boolean;
  cancelTitleEdit(): void;
  saveTitle(): Promise<void>;
  deleteSession(): Promise<void>;
  buildChatHeader(input: {
    isRunning: boolean;
    isReadOnly: boolean;
    isPinned: boolean;
    isPinPending: boolean;
    isAuxiliaryMode?: boolean;
    isWorkspaceAvailable: boolean;
    onOpenAuditLog: () => void;
    onOpenSessionTerminal: () => void;
    onOpenSessionFilesExplorer: () => void;
    onOpenSessionFilesTerminal: () => void;
    onTitleInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
    onDeleteSession: () => void;
    onToggleSessionPin: () => void;
    onOpenSessionExplorer: () => void;
  }): SessionHeaderProps;
};

export function useSessionHeaderOperations(input: {
  api: WithMateWindowApi | null;
  selectedSession: Session | null;
  isReadOnly: boolean;
  runState: Session["runState"] | null;
  persistSession(nextSession: Session): Promise<Session>;
  closeWindow(): void;
}): SessionHeaderOperations {
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const canEdit = !!input.selectedSession && !input.isReadOnly && input.runState !== "running";

  const startTitleEdit = useCallback(() => createStartTitleEditHandler({
    getTitle: () => input.selectedSession?.taskTitle,
    canStart: () => canEdit,
    setTitleDraft,
    setHeaderExpanded: () => {},
    setEditingTitle: setIsEditingTitle,
  })(), [canEdit, input.selectedSession]);

  const cancelTitleEdit = useCallback(() => createCancelTitleEditHandler({
    getTitle: () => input.selectedSession?.taskTitle,
    setTitleDraft,
    setEditingTitle: setIsEditingTitle,
  })(), [input.selectedSession]);

  const saveTitle = useCallback(async () => {
    const session = input.selectedSession;
    if (!session || input.isReadOnly) return;
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      setTitleDraft(session.taskTitle);
      setIsEditingTitle(false);
      return;
    }
    if (nextTitle === session.taskTitle) {
      setIsEditingTitle(false);
      return;
    }
    await input.persistSession({ ...session, taskTitle: nextTitle, updatedAt: currentTimestampLabel() });
    setIsEditingTitle(false);
  }, [input, titleDraft]);

  const deleteSession = useCallback(async () => {
    const session = input.selectedSession;
    if (!input.api || !session || input.runState === "running") return;
    if (!window.confirm(`Delete session "${session.taskTitle}"?`)) return;
    await input.api.deleteSession(session.id);
    input.closeWindow();
  }, [input]);

  const buildChatHeader = useCallback((view: Parameters<SessionHeaderOperations["buildChatHeader"]>[0]) => {
    const session = input.selectedSession;
    if (!session) {
      throw new Error("Cannot build a session header without a selected session.");
    }

    return buildLiveSessionHeaderProps({
      taskTitle: session.taskTitle,
      isEditingTitle,
      titleDraft,
      isRunning: view.isRunning,
      isReadOnly: view.isReadOnly,
      isPinned: view.isPinned,
      isPinPending: view.isPinPending,
      isAuxiliaryMode: view.isAuxiliaryMode,
      canViewAuxiliaryAuditLog: true,
      canDeleteSession: true,
      canViewAuditLog: true,
      onOpenAuditLog: view.onOpenAuditLog,
      onOpenTerminal: view.onOpenSessionTerminal,
      isTerminalDisabled: !view.isWorkspaceAvailable,
      onOpenSessionFilesExplorer: view.onOpenSessionFilesExplorer,
      onOpenSessionFilesTerminal: view.onOpenSessionFilesTerminal,
      onTitleDraftChange: setTitleDraft,
      onTitleInputKeyDown: view.onTitleInputKeyDown,
      onSaveTitle: () => void saveTitle(),
      onCancelTitleEdit: cancelTitleEdit,
      onStartTitleEdit: startTitleEdit,
      onDeleteSession: view.onDeleteSession,
      onTogglePin: view.onToggleSessionPin,
      onOpenWorkspaceExplorer: view.onOpenSessionExplorer,
      isWorkspaceExplorerDisabled: !view.isWorkspaceAvailable,
    });
  }, [cancelTitleEdit, input.selectedSession, isEditingTitle, saveTitle, startTitleEdit, titleDraft]);

  return { titleDraft, setTitleDraft, isEditingTitle, startTitleEdit, cancelTitleEdit, saveTitle, deleteSession, buildChatHeader };
}
