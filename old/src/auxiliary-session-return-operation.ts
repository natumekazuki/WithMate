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

export function beginAuxiliarySessionReturnToMainOperation(input: {
  setActionPending: (pending: boolean) => void;
}): void {
  input.setActionPending(true);
}

export function finishAuxiliarySessionReturnToMainOperation(input: {
  setActionPending: (pending: boolean) => void;
}): void {
  input.setActionPending(false);
}

export type AuxiliarySessionReturnToMainPreflightResult<TApi> = {
  status: "ready";
  api: TApi;
  activeSession: AuxiliarySession;
} | {
  status: "blocked";
};

export function resolveAuxiliarySessionReturnToMainPreflight<TApi>(input: {
  api: TApi | null | undefined;
  activeSession: AuxiliarySession | null;
  isActionPending: boolean;
}): AuxiliarySessionReturnToMainPreflightResult<TApi> {
  if (!input.api || !input.activeSession || input.isActionPending) {
    return { status: "blocked" };
  }
  return {
    status: "ready",
    api: input.api,
    activeSession: input.activeSession,
  };
}

export function resolveAuxiliarySessionReturnToMainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : AUXILIARY_SESSION_RETURN_FAILED_MESSAGE;
}

export function createAuxiliarySessionReturnToMainErrorHandler(input: {
  alertError: (message: string) => void;
}): (error: unknown) => void {
  return (error) => {
    input.alertError(resolveAuxiliarySessionReturnToMainErrorMessage(error));
  };
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

export function createAuxiliarySessionReturnToMainOperationAppliers(input: {
  loadRevision: { current: number };
  setClosedSessions: (updater: (currentSessions: AuxiliarySession[]) => AuxiliarySession[]) => void;
  mutationRevision: { current: number };
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession | null) => void;
  mainDraft: string;
  mainCaret: number;
  setComposerCaret: (caret: number) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
}): {
  beforeClose: () => void;
  applyClosedSession: (session: AuxiliarySession) => void;
  applyReturnedMainSession: () => void;
} {
  return {
    beforeClose: createAuxiliarySessionReturnBeforeCloseHandler({
      loadRevision: input.loadRevision,
    }),
    applyClosedSession: createReturnedAuxiliaryClosedSessionApplier({
      setClosedSessions: input.setClosedSessions,
    }),
    applyReturnedMainSession: createAuxiliarySessionReturnToMainUiStateApplier({
      mutationRevision: input.mutationRevision,
      activeSessionRef: input.activeSessionRef,
      setActiveSession: input.setActiveSession,
      mainDraft: input.mainDraft,
      mainCaret: input.mainCaret,
      setComposerCaret: input.setComposerCaret,
      setActionDockPinnedExpanded: input.setActionDockPinnedExpanded,
      setForceComposerBlockedFeedback: input.setForceComposerBlockedFeedback,
    }),
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

export async function runAuxiliarySessionReturnToMainOperationWithApi(input: {
  activeSession: AuxiliarySession | null;
  beforeClose?: () => void;
  api: {
    closeAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession>;
  };
  applyClosedSession: (session: AuxiliarySession) => void;
  applyReturnedMainSession: () => void;
}): Promise<AuxiliarySession | null> {
  return runAuxiliarySessionReturnToMainOperation({
    activeSession: input.activeSession,
    beforeClose: input.beforeClose,
    closeAuxiliarySession: (sessionId) => input.api.closeAuxiliarySession(sessionId),
    applyClosedSession: input.applyClosedSession,
    applyReturnedMainSession: input.applyReturnedMainSession,
  });
}

export async function runGuardedAuxiliarySessionReturnToMainOperationWithApi(input: {
  api: {
    closeAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession>;
  } | null | undefined;
  activeSession: AuxiliarySession | null;
  isActionPending: boolean;
  setActionPending: (pending: boolean) => void;
  alertError: (message: string) => void;
  loadRevision: { current: number };
  setClosedSessions: (updater: (currentSessions: AuxiliarySession[]) => AuxiliarySession[]) => void;
  mutationRevision: { current: number };
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession | null) => void;
  mainDraft: string;
  mainCaret: number;
  setComposerCaret: (caret: number) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
}): Promise<AuxiliarySession | null> {
  const preflight = resolveAuxiliarySessionReturnToMainPreflight({
    api: input.api,
    activeSession: input.activeSession,
    isActionPending: input.isActionPending,
  });
  if (preflight.status === "blocked") {
    return null;
  }

  const handleError = createAuxiliarySessionReturnToMainErrorHandler({
    alertError: input.alertError,
  });

  beginAuxiliarySessionReturnToMainOperation({
    setActionPending: input.setActionPending,
  });
  try {
    return await runAuxiliarySessionReturnToMainOperationWithApi({
      activeSession: preflight.activeSession,
      api: preflight.api,
      ...createAuxiliarySessionReturnToMainOperationAppliers({
        loadRevision: input.loadRevision,
        setClosedSessions: input.setClosedSessions,
        mutationRevision: input.mutationRevision,
        activeSessionRef: input.activeSessionRef,
        setActiveSession: input.setActiveSession,
        mainDraft: input.mainDraft,
        mainCaret: input.mainCaret,
        setComposerCaret: input.setComposerCaret,
        setActionDockPinnedExpanded: input.setActionDockPinnedExpanded,
        setForceComposerBlockedFeedback: input.setForceComposerBlockedFeedback,
      }),
    });
  } catch (error) {
    handleError(error);
    return null;
  } finally {
    finishAuxiliarySessionReturnToMainOperation({
      setActionPending: input.setActionPending,
    });
  }
}
