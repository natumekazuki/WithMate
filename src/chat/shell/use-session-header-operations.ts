import { useCallback, useState } from "react";

import type { Session } from "../../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import { currentTimestampLabel } from "../../../src-shared/time-state.js";
import {
  createCancelTitleEditHandler,
  createStartTitleEditHandler,
} from "../session-shell-handlers.js";

export type SessionHeaderOperations = {
  titleDraft: string;
  setTitleDraft(title: string): void;
  isEditingTitle: boolean;
  startTitleEdit(): boolean;
  cancelTitleEdit(): void;
  saveTitle(): Promise<void>;
  deleteSession(): Promise<void>;
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
    if (!window.confirm(`セッション「${session.taskTitle}」を削除する？`)) return;
    await input.api.deleteSession(session.id);
    input.closeWindow();
  }, [input]);

  return { titleDraft, setTitleDraft, isEditingTitle, startTitleEdit, cancelTitleEdit, saveTitle, deleteSession };
}
