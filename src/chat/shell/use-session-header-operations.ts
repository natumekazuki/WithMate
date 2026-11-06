import { createElement, useCallback, useEffect, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";

import type { Session } from "../../../src-shared/session/session-state.js";
import { getSessionIncarnationId } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  createCancelTitleEditHandler,
  createStartTitleEditHandler,
} from "../session-shell-handlers.js";
import type { SessionHeaderProps } from "./session-header.js";
import { buildLiveSessionHeaderProps } from "../chat-header-actions.js";
import { CrewDeletionDialog } from "../../coordination/CrewDeletionDialog.js";

export type SessionHeaderOperations = {
  titleDraft: string;
  setTitleDraft(title: string): void;
  isEditingTitle: boolean;
  startTitleEdit(): boolean;
  cancelTitleEdit(): void;
  saveTitle(): Promise<void>;
  deleteSession(): Promise<void>;
  buildChatHeader(input: {
    actions?: ReactNode;
    isRunning: boolean;
    isReadOnly: boolean;
    isPinned: boolean;
    isPinPending: boolean;
    isAuxiliaryMode?: boolean;
    isWorkspaceAvailable: boolean;
    onOpenSessionTerminal: () => void;
    onOpenExternalTerminal?: () => void;
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
  updateTitle(session: Session, title: string, isCurrent: () => boolean): Promise<string | void>;
  closeWindow(): void;
}): SessionHeaderOperations {
  const [titleDraft, setTitleDraft] = useState("");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isRoleChangePending, setIsRoleChangePending] = useState(false);
  const [crewDeletionOpen, setCrewDeletionOpen] = useState(false);
  const roleChangePendingRef = useRef(false);
  const latestSessionRef = useRef(input.selectedSession);
  latestSessionRef.current = input.selectedSession;
  const titleRequestRevisionRef = useRef(0);
  const latestDraftRef = useRef(titleDraft);
  latestDraftRef.current = titleDraft;
  const ownerId = input.selectedSession?.id;
  const incarnationId = input.selectedSession ? getSessionIncarnationId(input.selectedSession) : null;
  useEffect(() => {
    setIsEditingTitle(false);
    setCrewDeletionOpen(false);
    return () => { titleRequestRevisionRef.current += 1; };
  }, [ownerId, incarnationId]);
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
    const revision = ++titleRequestRevisionRef.current;
    const isCurrent = () => titleRequestRevisionRef.current === revision
      && latestSessionRef.current?.id === session.id
      && getSessionIncarnationId(latestSessionRef.current) === getSessionIncarnationId(session);
    try {
      const warning = await input.updateTitle(session, nextTitle, isCurrent);
      if (!isCurrent()) return;
      if (latestDraftRef.current.trim() === nextTitle) setIsEditingTitle(false);
      if (warning) window.alert(warning);
    } catch (error) {
      if (isCurrent()) {
        window.alert(`Title was not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [input, titleDraft]);

  const deleteSession = useCallback(async () => {
    const session = input.selectedSession;
    if (!input.api || !session || input.runState === "running") return;
    if (session.sessionKind === "default") { setCrewDeletionOpen(true); return; }
    if (!window.confirm(`Delete session "${session.taskTitle}"?\n\nIts Aux conversations and Session Graph will also be deleted.`)) return;
    await input.api.deleteSession(session.id);
    input.closeWindow();
  }, [input]);

  const promoteToOverallCoordinator = useCallback(async () => {
    const session = input.selectedSession;
    if (!input.api || !session || input.isReadOnly || input.runState === "running"
      || session.sessionKind !== "default" || (session.sessionRole ?? "standalone") !== "standalone"
      || roleChangePendingRef.current) return;
    if (!window.confirm(`Make "${session.taskTitle}" an Overall Coordinator?\n\nThis allows it to create child sessions. Its conversation and workspace will stay unchanged.`)) return;
    roleChangePendingRef.current = true;
    setIsRoleChangePending(true);
    try {
      await input.api.promoteSessionToOverallCoordinator(session.id, getSessionIncarnationId(session));
    } catch (error) {
      if (latestSessionRef.current?.id === session.id
        && getSessionIncarnationId(latestSessionRef.current) === getSessionIncarnationId(session)) {
        window.alert(`Session role was not changed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      roleChangePendingRef.current = false;
      setIsRoleChangePending(false);
    }
  }, [input]);

  const buildChatHeader = useCallback((view: Parameters<SessionHeaderOperations["buildChatHeader"]>[0]) => {
    const session = input.selectedSession;
    if (!session) {
      throw new Error("Cannot build a session header without a selected session.");
    }

    const header = buildLiveSessionHeaderProps({
      sessionRole: !view.isAuxiliaryMode && session.sessionKind === "default" ? session.sessionRole ?? "standalone" : undefined,
      isRoleChangePending,
      onPromoteToOverallCoordinator: !view.isAuxiliaryMode && session.sessionKind === "default"
        && (session.sessionRole ?? "standalone") === "standalone" && !view.isReadOnly
        ? () => void promoteToOverallCoordinator() : undefined,
      actions: view.actions,
      taskTitle: session.taskTitle,
      isEditingTitle,
      titleDraft,
      isRunning: view.isRunning,
      isReadOnly: view.isReadOnly,
      isPinned: view.isPinned,
      isPinPending: view.isPinPending,
      isAuxiliaryMode: view.isAuxiliaryMode,
      canDeleteSession: session.sessionKind !== "default" || (session.rootSessionId ?? session.id) === session.id,
      onOpenTerminal: view.onOpenSessionTerminal,
      onOpenExternalTerminal: view.onOpenExternalTerminal,
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
    if (session.sessionKind === "default") header.deleteActionLabel = "Delete Crew";
    if (crewDeletionOpen && input.api) header.actions = createElement("div", null, header.actions, createElement(CrewDeletionDialog, {
      api: input.api, sessionId: session.id, incarnationId: getSessionIncarnationId(session), title: session.taskTitle,
      onClose: () => setCrewDeletionOpen(false), onDeleted: input.closeWindow,
    }));
    return header;
  }, [cancelTitleEdit, input, crewDeletionOpen, isEditingTitle, isRoleChangePending, promoteToOverallCoordinator, saveTitle, startTitleEdit, titleDraft]);

  return { titleDraft, setTitleDraft, isEditingTitle, startTitleEdit, cancelTitleEdit, saveTitle, deleteSession, buildChatHeader };
}
