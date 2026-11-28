import type { LiveSessionRunState } from "../../../src-shared/session/runtime-state.js";

/** 実行情報の到着前に暫定表示を作るためのセッション識別子。 */
export type PendingLiveRunSessionIdentity = {
  id: string;
  threadId: string;
};

/** 実行表示の状態と、それを所有するセッションの対応。 */
export type OwnedLiveSessionRunState = {
  ownerSessionId: string | null;
  state: LiveSessionRunState | null;
};

/** 例外が Error のときはそのメッセージ、その他は操作側の既定文を使う。 */
export function resolveSessionRunErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  return error instanceof Error ? error.message : fallbackMessage;
}

/** 実行開始の確定前にセッションの投影と、そのセッションが所有する暫定実行表示を更新する。 */
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
  updateLiveRunState((current) =>
    createOwnedPendingLiveSessionRunState(runningSession, current),
  );
  return runningSession;
}

/** 対象セッションの暫定実行表示だけを解除し、セッションの投影を元に戻す。 */
export function rollbackOptimisticSessionRunUpdate({
  sessionId,
  updateLiveRunState,
  restoreSession,
}: {
  sessionId: string;
  updateLiveRunState: (
    clearLiveRunState: (
      current: OwnedLiveSessionRunState,
    ) => OwnedLiveSessionRunState,
  ) => void;
  restoreSession: () => void;
}): void {
  updateLiveRunState((current) =>
    clearOwnedLiveSessionRunState(current, sessionId),
  );
  restoreSession();
}

/** 保存が確定したセッションを投影に反映し、呼び出し元にも返す。 */
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

/** 新しい実行の本文や要求は空で始め、既存のバックグラウンド作業だけを引き継ぐ。 */
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

/** 同じセッションの実行表示からだけバックグラウンド作業を引き継いで暫定状態を作る。 */
export function createOwnedPendingLiveSessionRunState(
  session: PendingLiveRunSessionIdentity,
  current?: OwnedLiveSessionRunState | null,
): OwnedLiveSessionRunState {
  const previousState =
    current?.ownerSessionId === session.id ? current.state : null;
  return {
    ownerSessionId: session.id,
    state: createPendingLiveSessionRunState(session, previousState),
  };
}

/** 現在の表示所有者が指定したセッションなら、所有者を保ったまま実行情報を空にする。 */
export function clearOwnedLiveSessionRunState(
  current: OwnedLiveSessionRunState,
  sessionId: string,
): OwnedLiveSessionRunState {
  return current.ownerSessionId === sessionId
    ? { ownerSessionId: sessionId, state: null }
    : current;
}

/** 解決した承認・質問が現在の所有者と要求IDにまだ一致する場合だけ、再取得した実行情報を反映する。 */
export function replaceLiveRunAfterResolvedRequest(
  current: OwnedLiveSessionRunState,
  options: {
    sessionId: string;
    requestId: string;
    requestKind: "approval" | "elicitation";
    latestLiveRun: LiveSessionRunState | null;
  },
): OwnedLiveSessionRunState {
  const matchesRequest =
    options.requestKind === "approval"
      ? current.state?.approvalRequest?.requestId === options.requestId
      : (
          current.state?.elicitationRequests ??
          (current.state?.elicitationRequest
            ? [current.state.elicitationRequest]
            : [])
        ).some((request) => request.requestId === options.requestId);

  if (current.ownerSessionId !== options.sessionId || !matchesRequest) {
    return current;
  }

  return {
    ownerSessionId: options.sessionId,
    state: options.latestLiveRun,
  };
}
