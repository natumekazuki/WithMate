import type { AuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import { resolveEditableActiveAuxiliarySession } from "../../../src-shared/auxiliary/auxiliary-session-state.js";

/** 楽観反映した会話と保存応答の組。更新対象がなければ null。 */
export type AuxiliarySessionUpdateOperationResult = {
  nextSession: AuxiliarySession;
  saved: AuxiliarySession;
} | null;

/** 復旧時は保存先の現行会話を優先し、取得できなければ楽観反映前の値へ戻す。 */
export async function resolveAuxiliarySessionRollbackSession(input: {
  pendingSession: AuxiliarySession;
  previousSession: AuxiliarySession;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
}): Promise<AuxiliarySession> {
  try {
    return (
      (await input.getAuxiliarySession(input.pendingSession.id)) ??
      input.previousSession
    );
  } catch {
    return input.previousSession;
  }
}

/** 先行処理の成否を問わず保存を直列化し、個別の失敗は呼び出し元へ伝える。 */
export function enqueueAuxiliarySessionSaveOperation<T>(
  currentQueue: Promise<void>,
  operation: () => Promise<T>,
): {
  operation: Promise<T>;
  queue: Promise<void>;
} {
  const saveOperation = currentQueue.catch(() => undefined).then(operation);
  return {
    operation: saveOperation,
    queue: saveOperation.then(
      () => undefined,
      () => undefined,
    ),
  };
}

/** 次の保存を共有キューの末尾に追加し、その保存の結果だけを待てるように返す。 */
export function enqueueAuxiliarySessionSaveWithQueue<T>(
  queueRef: { current: Promise<void> },
  operation: () => Promise<T>,
): Promise<T> {
  const saveOperation = enqueueAuxiliarySessionSaveOperation(
    queueRef.current,
    operation,
  );
  queueRef.current = saveOperation.queue;
  return saveOperation.operation;
}

/** 編集可能な会話に変更を先に反映し、保存失敗時は復旧処理を待って失敗を伝える。 */
export async function runAuxiliarySessionUpdateOperation(input: {
  activeSession: AuxiliarySession;
  currentSession: AuxiliarySession | null;
  recipe: (current: AuxiliarySession) => AuxiliarySession;
  applyPendingSession: (session: AuxiliarySession) => void;
  rollbackPendingSession: (input: {
    error: unknown;
    pendingSession: AuxiliarySession;
    previousSession: AuxiliarySession;
  }) => void | Promise<void>;
  saveAuxiliarySession: (
    session: AuxiliarySession,
  ) => Promise<AuxiliarySession>;
}): Promise<AuxiliarySessionUpdateOperationResult> {
  const previousSession = resolveEditableActiveAuxiliarySession({
    activeSession: input.activeSession,
    currentSession: input.currentSession,
  });
  if (!previousSession) {
    return null;
  }

  const nextSession = input.recipe(previousSession);
  input.applyPendingSession(nextSession);
  let saved: AuxiliarySession;
  try {
    saved = await input.saveAuxiliarySession(nextSession);
  } catch (error) {
    await input.rollbackPendingSession({
      error,
      pendingSession: nextSession,
      previousSession,
    });
    throw error;
  }

  return { nextSession, saved };
}

/** 下書きの先行保存を待って会話を更新し、選択先または変更世代が変わった後の応答は画面に反映しない。 */
export async function runGuardedAuxiliarySessionUpdate(input: {
  activeSession: AuxiliarySession | null;
  getCurrentSession: () => AuxiliarySession | null;
  applyActiveSession: (session: AuxiliarySession) => void;
  draftSaveQueue: { current: Promise<void> };
  sessionSaveQueue: { current: Promise<void> };
  mutationRevision: { current: number };
  recipe: (current: AuxiliarySession) => AuxiliarySession;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  saveAuxiliarySession: (
    session: AuxiliarySession,
  ) => Promise<AuxiliarySession>;
}): Promise<AuxiliarySessionUpdateOperationResult> {
  if (!input.activeSession) {
    return null;
  }

  await input.draftSaveQueue.current.catch(() => undefined);
  let operationRevision = input.mutationRevision.current;
  const result = await runAuxiliarySessionUpdateOperation({
    activeSession: input.activeSession,
    currentSession: input.getCurrentSession(),
    recipe: input.recipe,
    /** 楽観反映した版に世代を割り当て、後から届く保存結果の照合に使う。 */
    applyPendingSession: (session) => {
      operationRevision = input.mutationRevision.current + 1;
      input.mutationRevision.current = operationRevision;
      input.applyActiveSession(session);
    },
    /** 読み戻しの前後で会話と変更世代を照合し、復旧待ちの間の再編集や会話切り替えを保護する。 */
    rollbackPendingSession: async ({ pendingSession, previousSession }) => {
      if (
        input.mutationRevision.current !== operationRevision ||
        input.getCurrentSession()?.id !== pendingSession.id
      ) {
        return;
      }
      const rollbackSession = await resolveAuxiliarySessionRollbackSession({
        pendingSession,
        previousSession,
        getAuxiliarySession: input.getAuxiliarySession,
      });
      if (
        input.mutationRevision.current !== operationRevision ||
        input.getCurrentSession()?.id !== pendingSession.id
      ) {
        return;
      }
      input.applyActiveSession(rollbackSession);
    },
    /** 別の会話更新の保存が終わるまで、今回の保存を待機させる。 */
    saveAuxiliarySession: (session) => {
      return enqueueAuxiliarySessionSaveWithQueue(input.sessionSaveQueue, () =>
        input.saveAuxiliarySession(session),
      );
    },
  });
  if (!result) {
    return result;
  }

  if (
    input.mutationRevision.current !== operationRevision ||
    input.getCurrentSession()?.id !== result.saved.id
  ) {
    return result;
  }
  input.applyActiveSession(result.saved);
  return result;
}

/** 更新の呼び出しごとに現在の API を取得し、利用できる場合に世代付きの保存経路へ接続する。 */
export function createGuardedActiveAuxiliarySessionUpdater(input: {
  activeSession: AuxiliarySession | null;
  getApi: () => {
    getAuxiliarySession: (
      sessionId: string,
    ) => Promise<AuxiliarySession | null>;
    updateAuxiliarySession: (
      session: AuxiliarySession,
    ) => Promise<AuxiliarySession>;
  } | null;
  getCurrentSession: () => AuxiliarySession | null;
  setActiveSession: (session: AuxiliarySession) => void;
  draftSaveQueue: { current: Promise<void> };
  sessionSaveQueue: { current: Promise<void> };
  mutationRevision: { current: number };
}): (
  recipe: (current: AuxiliarySession) => AuxiliarySession,
) => Promise<AuxiliarySessionUpdateOperationResult> {
  return async (recipe) => {
    const api = input.getApi();
    if (!api) {
      return null;
    }

    return runGuardedAuxiliarySessionUpdate({
      activeSession: input.activeSession,
      getCurrentSession: input.getCurrentSession,
      applyActiveSession: input.setActiveSession,
      draftSaveQueue: input.draftSaveQueue,
      sessionSaveQueue: input.sessionSaveQueue,
      mutationRevision: input.mutationRevision,
      recipe,
      /** 復旧に使う保存済み会話を識別子で取得する。 */
      getAuxiliarySession: (sessionId) => api.getAuxiliarySession(sessionId),
      /** 楽観反映済みの会話を API へ保存し、採用された値を返す。 */
      saveAuxiliarySession: (session) => api.updateAuxiliarySession(session),
    });
  };
}

/** 非同期処理の照合に使う参照を、選択中の会話または未選択の状態と同期する。 */
export function syncActiveAuxiliarySessionRef(input: {
  activeSession: AuxiliarySession | null;
  activeSessionRef: { current: AuxiliarySession | null };
}): void {
  input.activeSessionRef.current = input.activeSession;
}
