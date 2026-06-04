import {
  buildAuxiliarySessionRunningTransition,
  resolveAuxiliarySessionSendPreflight,
  resolveAuxiliarySessionSendTarget,
  type AuxiliarySession,
  type AuxiliarySessionSendPreflightResult,
  type AuxiliarySessionSendTargetResolution,
} from "./auxiliary-session-state.js";
import { enqueueAuxiliarySessionSaveWithQueue } from "./auxiliary-session-update-operation.js";

export type AuxiliarySessionSendOperationResult =
  | {
      status: "blocked";
      preflight: AuxiliarySessionSendPreflightResult;
    }
  | {
      status: "target-blocked";
      target: AuxiliarySessionSendTargetResolution;
    }
  | {
      status: "stale";
    }
  | {
      status: "completed";
      saved: AuxiliarySession;
    }
  | {
      status: "error";
      error: unknown;
    };

export async function runAuxiliarySessionSendOperation(input: {
  activeSession: AuxiliarySession;
  composerBlockedReason?: string | null;
  messageText: string;
  parentMessageCount: number | null;
  updatedAt: string;
  draftSaveQueue: { current: Promise<void> };
  sessionSaveQueue: { current: Promise<void> };
  mutationRevision: { current: number };
  getCurrentSession: () => AuxiliarySession | null;
  beforeRunningSessionApplied?: () => void;
  applyRunningSession: (session: AuxiliarySession) => void;
  afterRunningSessionApplied?: (session: AuxiliarySession) => void;
  applySavedSession: (session: AuxiliarySession) => void;
  restoreSessionAfterError: (session: AuxiliarySession) => void;
  clearPendingLiveRun: (sessionId: string) => void;
  updateAuxiliarySession: (session: AuxiliarySession) => Promise<AuxiliarySession>;
  runAuxiliarySessionTurn: (sessionId: string, request: { userMessage: string }) => Promise<AuxiliarySession>;
}): Promise<AuxiliarySessionSendOperationResult> {
  const preflight = resolveAuxiliarySessionSendPreflight({
    activeSession: input.activeSession,
    composerBlockedReason: input.composerBlockedReason,
    messageText: input.messageText,
  });
  if (preflight.blockedReason) {
    return {
      status: "blocked",
      preflight,
    };
  }

  const sendStartRevision = input.mutationRevision.current;
  await input.draftSaveQueue.current.catch(() => undefined);
  await input.sessionSaveQueue.current.catch(() => undefined);
  if (input.mutationRevision.current !== sendStartRevision) {
    return { status: "stale" };
  }

  const sendTarget = resolveAuxiliarySessionSendTarget({
    activeSession: input.activeSession,
    currentSession: input.getCurrentSession(),
  });
  if (!sendTarget.session) {
    return {
      status: "target-blocked",
      target: sendTarget,
    };
  }

  const currentAuxiliarySession = sendTarget.session;
  input.beforeRunningSessionApplied?.();
  const { anchorUpdateSession, runningSession } = buildAuxiliarySessionRunningTransition({
    session: currentAuxiliarySession,
    userMessage: preflight.userMessage,
    parentMessageCount: input.parentMessageCount,
    updatedAt: input.updatedAt,
  });
  input.mutationRevision.current += 1;
  const runOperationRevision = input.mutationRevision.current;
  input.applyRunningSession(runningSession);
  input.afterRunningSessionApplied?.(runningSession);

  try {
    if (anchorUpdateSession) {
      await enqueueAuxiliarySessionSaveWithQueue(
        input.sessionSaveQueue,
        () => input.updateAuxiliarySession(anchorUpdateSession),
      );
    }
    const saved = await input.runAuxiliarySessionTurn(currentAuxiliarySession.id, {
      userMessage: preflight.userMessage,
    });
    if (
      input.mutationRevision.current !== runOperationRevision
      || input.getCurrentSession()?.id !== saved.id
    ) {
      return { status: "stale" };
    }
    input.applySavedSession(saved);
    return {
      status: "completed",
      saved,
    };
  } catch (error) {
    if (
      input.mutationRevision.current !== runOperationRevision
      || input.getCurrentSession()?.id !== currentAuxiliarySession.id
    ) {
      return { status: "stale" };
    }
    input.clearPendingLiveRun(runningSession.id);
    input.restoreSessionAfterError(currentAuxiliarySession);
    return {
      status: "error",
      error,
    };
  }
}
