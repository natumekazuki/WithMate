import type { LiveSessionRunState } from "./runtime-state.js";
import type { Message } from "./session-state.js";

export type PendingLiveRunSessionIdentity = {
  id: string;
  threadId: string;
};

export type OwnedLiveSessionRunState = {
  ownerSessionId: string | null;
  state: LiveSessionRunState | null;
};

export type OptimisticRunningSessionBase = {
  messages: Message[];
  runState: string;
  updatedAt: string;
};

export function createOptimisticRunningSessionState<TSession extends OptimisticRunningSessionBase>(
  session: TSession,
  userMessage: string,
  updatedAt: string,
  options: { status?: string } = {},
): TSession {
  return {
    ...session,
    ...(options.status !== undefined ? { status: options.status } : {}),
    updatedAt,
    runState: "running",
    messages: [...session.messages, { role: "user", text: userMessage }],
  } as TSession;
}

export function buildOptimisticSessionRunUpdate<
  TSession extends OptimisticRunningSessionBase & PendingLiveRunSessionIdentity,
>({
  session,
  userMessage,
  updatedAt,
  status,
}: {
  session: TSession;
  userMessage: string;
  updatedAt: string;
  status?: string;
}): {
  runningSession: TSession;
  createPendingLiveRunState: (
    current?: OwnedLiveSessionRunState | null,
  ) => OwnedLiveSessionRunState;
} {
  const runningSession = createOptimisticRunningSessionState(
    session,
    userMessage,
    updatedAt,
    status !== undefined ? { status } : {},
  );
  return {
    runningSession,
    createPendingLiveRunState: (current) =>
      createOwnedPendingLiveSessionRunState(runningSession, current),
  };
}

export function applyOptimisticSessionRunUpdate<
  TSession extends OptimisticRunningSessionBase & PendingLiveRunSessionIdentity,
>({
  session,
  userMessage,
  updatedAt,
  status,
  updateLiveRunState,
  applyRunningSession,
}: {
  session: TSession;
  userMessage: string;
  updatedAt: string;
  status?: string;
  updateLiveRunState: (
    createPendingLiveRunState: (
      current?: OwnedLiveSessionRunState | null,
    ) => OwnedLiveSessionRunState,
  ) => void;
  applyRunningSession: (runningSession: TSession) => void;
}): TSession {
  const update = buildOptimisticSessionRunUpdate({
    session,
    userMessage,
    updatedAt,
    status,
  });
  updateLiveRunState(update.createPendingLiveRunState);
  applyRunningSession(update.runningSession);
  return update.runningSession;
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
