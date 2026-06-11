import {
  resolveClosedAuxiliarySessionsAfterReturn,
  type AuxiliarySession,
} from "./auxiliary-session-state.js";

const AUXILIARY_SESSION_RETURN_FAILED_MESSAGE = "Auxiliary Session の終了に失敗したよ。";

export function applyAuxiliarySessionReturnToMainUiState(input: {
  mutationRevision: { current: number };
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession | null) => void;
  mainDraft: string;
  mainCaret: number;
  setComposerCaret: (caret: number) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
}): void {
  input.mutationRevision.current += 1;
  input.activeSessionRef.current = null;
  input.setActiveSession(null);
  input.setComposerCaret(Math.min(input.mainCaret, input.mainDraft.length));
  input.setActionDockPinnedExpanded(false);
  input.setForceComposerBlockedFeedback(false);
}

export function createAuxiliarySessionReturnToMainUiStateApplier(input: {
  mutationRevision: { current: number };
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession | null) => void;
  mainDraft: string;
  mainCaret: number;
  setComposerCaret: (caret: number) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
}): () => void {
  return () => {
    applyAuxiliarySessionReturnToMainUiState(input);
  };
}

export function createAuxiliarySessionReturnBeforeCloseHandler(input: {
  loadRevision: { current: number };
}): () => void {
  return () => {
    input.loadRevision.current += 1;
  };
}

export function resolveAuxiliarySessionReturnToMainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : AUXILIARY_SESSION_RETURN_FAILED_MESSAGE;
}

export function applyReturnedAuxiliaryClosedSession(
  currentSessions: AuxiliarySession[],
  closedSession: AuxiliarySession,
): AuxiliarySession[] {
  return resolveClosedAuxiliarySessionsAfterReturn(currentSessions, closedSession);
}

export function createReturnedAuxiliaryClosedSessionApplier(input: {
  setClosedSessions: (updater: (currentSessions: AuxiliarySession[]) => AuxiliarySession[]) => void;
}): (closedSession: AuxiliarySession) => void {
  return (closedSession) => {
    input.setClosedSessions((currentSessions) => applyReturnedAuxiliaryClosedSession(currentSessions, closedSession));
  };
}

export async function runAuxiliarySessionReturnToMainOperation(input: {
  activeSession: AuxiliarySession | null;
  beforeClose?: () => void;
  closeAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession>;
  applyClosedSession: (session: AuxiliarySession) => void;
  applyReturnedMainSession: () => void;
}): Promise<AuxiliarySession | null> {
  if (!input.activeSession) {
    return null;
  }

  input.beforeClose?.();
  const closedSession = await input.closeAuxiliarySession(input.activeSession.id);
  input.applyClosedSession(closedSession);
  input.applyReturnedMainSession();
  return closedSession;
}
