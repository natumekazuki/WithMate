import type { LiveSessionRunState } from "../../../src-shared/session/runtime-state.js";

export type PendingLiveRunSessionIdentity = {
  id: string;
  threadId: string;
};

export type OwnedLiveSessionRunState = {
  ownerSessionId: string | null;
  state: LiveSessionRunState | null;
};

export function resolveSessionRunErrorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error ? error.message : fallbackMessage;
}

export function applyOptimisticSessionRunUpdate<
  TSession extends PendingLiveRunSessionIdentity,
>({
  runningSession,
  updateLiveRunState,
  applyRunningSession,
}: {
  runningSession: TSession;
  updateLiveRunState: (
    createPendingLiveRunState: (
      current?: OwnedLiveSessionRunState | null,
    ) => OwnedLiveSessionRunState,
  ) => void;
  applyRunningSession: (runningSession: TSession) => void;
}): TSession {
  applyRunningSession(runningSession);
  updateLiveRunState((current) => createOwnedPendingLiveSessionRunState(runningSession, current));
  return runningSession;
}

export function rollbackOptimisticSessionRunUpdate({
  sessionId,
  updateLiveRunState,
  restoreSession,
}: {
  sessionId: string;
  updateLiveRunState: (
    clearLiveRunState: (current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState,
  ) => void;
  restoreSession: () => void;
}): void {
  updateLiveRunState((current) => clearOwnedLiveSessionRunState(current, sessionId));
  restoreSession();
}

export function applyResolvedSessionRunUpdate<TSession>({
  savedSession,
  applySavedSession,
}: {
  savedSession: TSession;
  applySavedSession: (savedSession: TSession) => void;
}): TSession {
  applySavedSession(savedSession);
  return savedSession;
}

export function createPendingLiveSessionRunState(
  session: PendingLiveRunSessionIdentity,
  previousState?: LiveSessionRunState | null,
): LiveSessionRunState {
  return {
    sessionId: session.id,
    threadId: session.threadId,
    assistantText: "",
    reasoningText: "",
    steps: [],
    backgroundTasks: previousState?.backgroundTasks ?? [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
}

export function createOwnedPendingLiveSessionRunState(
  session: PendingLiveRunSessionIdentity,
  current?: OwnedLiveSessionRunState | null,
): OwnedLiveSessionRunState {
  const previousState = current?.ownerSessionId === session.id ? current.state : null;
  return {
    ownerSessionId: session.id,
    state: createPendingLiveSessionRunState(session, previousState),
  };
}

export function clearOwnedLiveSessionRunState(
  current: OwnedLiveSessionRunState,
  sessionId: string,
): OwnedLiveSessionRunState {
  return current.ownerSessionId === sessionId
    ? { ownerSessionId: sessionId, state: null }
    : current;
}

export function replaceLiveRunAfterResolvedRequest(
  current: OwnedLiveSessionRunState,
  options: {
    sessionId: string;
    requestId: string;
    requestKind: "approval" | "elicitation";
    latestLiveRun: LiveSessionRunState | null;
  },
): OwnedLiveSessionRunState {
  const currentRequest = options.requestKind === "approval"
    ? current.state?.approvalRequest
    : current.state?.elicitationRequest;

  if (
    current.ownerSessionId !== options.sessionId
    || currentRequest?.requestId !== options.requestId
  ) {
    return current;
  }

  return {
    ownerSessionId: options.sessionId,
    state: options.latestLiveRun,
  };
}
