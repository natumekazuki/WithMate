import type { AuxiliarySession } from "./auxiliary-session-state.js";
import { resolveEditableActiveAuxiliarySession } from "./auxiliary-session-state.js";

export type AuxiliarySessionUpdateOperationResult = {
  nextSession: AuxiliarySession;
  saved: AuxiliarySession;
} | null;

export async function resolveAuxiliarySessionRollbackSession(input: {
  pendingSession: AuxiliarySession;
  previousSession: AuxiliarySession;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
}): Promise<AuxiliarySession> {
  try {
    return await input.getAuxiliarySession(input.pendingSession.id) ?? input.previousSession;
  } catch {
    return input.previousSession;
  }
}

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
    queue: saveOperation.then(() => undefined, () => undefined),
  };
}

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
  saveAuxiliarySession: (session: AuxiliarySession) => Promise<AuxiliarySession>;
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
    await input.rollbackPendingSession({ error, pendingSession: nextSession, previousSession });
    throw error;
  }

  return { nextSession, saved };
}

export async function runGuardedAuxiliarySessionUpdate(input: {
  activeSession: AuxiliarySession | null;
  getCurrentSession: () => AuxiliarySession | null;
  applyActiveSession: (session: AuxiliarySession) => void;
  draftSaveQueue: { current: Promise<void> };
  sessionSaveQueue: { current: Promise<void> };
  mutationRevision: { current: number };
  recipe: (current: AuxiliarySession) => AuxiliarySession;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  saveAuxiliarySession: (session: AuxiliarySession) => Promise<AuxiliarySession>;
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
    applyPendingSession: (session) => {
      operationRevision = input.mutationRevision.current + 1;
      input.mutationRevision.current = operationRevision;
      input.applyActiveSession(session);
    },
    rollbackPendingSession: async ({ pendingSession, previousSession }) => {
      if (
        input.mutationRevision.current !== operationRevision
        || input.getCurrentSession()?.id !== pendingSession.id
      ) {
        return;
      }
      const rollbackSession = await resolveAuxiliarySessionRollbackSession({
        pendingSession,
        previousSession,
        getAuxiliarySession: input.getAuxiliarySession,
      });
      if (
        input.mutationRevision.current !== operationRevision
        || input.getCurrentSession()?.id !== pendingSession.id
      ) {
        return;
      }
      input.applyActiveSession(rollbackSession);
    },
    saveAuxiliarySession: (session) => {
      const saveOperation = enqueueAuxiliarySessionSaveOperation(
        input.sessionSaveQueue.current,
        () => input.saveAuxiliarySession(session),
      );
      input.sessionSaveQueue.current = saveOperation.queue;
      return saveOperation.operation;
    },
  });
  if (!result) {
    return result;
  }

  if (
    input.mutationRevision.current !== operationRevision
    || input.getCurrentSession()?.id !== result.saved.id
  ) {
    return result;
  }
  input.applyActiveSession(result.saved);
  return result;
}
