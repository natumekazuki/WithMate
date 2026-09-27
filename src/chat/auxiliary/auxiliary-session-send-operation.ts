import {
  buildAuxiliarySessionRunningTransition,
  resolveAuxiliarySessionSendPreflight,
  resolveAuxiliarySessionSendTarget,
  type AuxiliarySession,
  type AuxiliarySessionSendPreflightResult,
  type AuxiliarySessionSendTargetResolution,
} from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  applyActiveAuxiliarySessionUpdate,
  createActiveAuxiliarySessionUpdateApplier,
} from "./auxiliary-session-update-operation.js";
import type { SessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import { captureSessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import { createSessionTurnClientRequestId } from "../runtime/session-submit-coordinator.js";
import { mergeMessageBookmarkProjection } from "../runtime/session-submit-coordinator.js";
import {
  clearOwnedLiveSessionRunState,
  createOwnedPendingLiveSessionRunState,
  type OwnedLiveSessionRunState,
  type PendingLiveRunSessionIdentity,
} from "../runtime/session-live-run-state.js";

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

export function createAuxiliarySessionRunningApplier(input: {
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession) => void;
  updateLiveRunState: (
    updater: (current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState,
  ) => void;
  buildRuntimeSession: (runningSession: AuxiliarySession) => PendingLiveRunSessionIdentity;
}): (runningSession: AuxiliarySession) => void {
  return (runningSession) => {
    const current = input.activeSessionRef.current;
    const projected = current?.id === runningSession.id && current.createdAt === runningSession.createdAt
      ? { ...runningSession, ...captureSessionExecutionOptions(current), messages: mergeMessageBookmarkProjection(current.messages, runningSession.messages) }
      : runningSession;
    applyActiveAuxiliarySessionUpdate({
      session: projected,
      activeSessionRef: input.activeSessionRef,
      setActiveSession: input.setActiveSession,
    });
    input.updateLiveRunState((current) => createOwnedPendingLiveSessionRunState(
      input.buildRuntimeSession(runningSession),
      current,
    ));
  };
}

export function createAuxiliarySessionSendResultAppliers(input: {
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession) => void;
}): {
  applySavedSession: (session: AuxiliarySession) => void;
  restoreSessionAfterError: (session: AuxiliarySession) => void;
} {
  const applyActiveSession = createActiveAuxiliarySessionUpdateApplier(input);
  const applyWithCurrentSelection = (session: AuxiliarySession) => {
    const current = input.activeSessionRef.current;
    applyActiveSession(current?.id === session.id && current.createdAt === session.createdAt
      ? { ...session, ...captureSessionExecutionOptions(current), messages: mergeMessageBookmarkProjection(current.messages, session.messages) }
      : session);
  };
  return {
    applySavedSession: applyWithCurrentSelection,
    restoreSessionAfterError: applyWithCurrentSelection,
  };
}

export function createAuxiliarySessionPendingLiveRunClearer(input: {
  updateLiveRunState: (
    updater: (current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState,
  ) => void;
}): (sessionId: string) => void {
  return (sessionId) => {
    input.updateLiveRunState((current) => clearOwnedLiveSessionRunState(current, sessionId));
  };
}

export function handleAuxiliarySessionSendOperationResult(input: {
  result: AuxiliarySessionSendOperationResult;
  onBlocked?: (preflight: AuxiliarySessionSendPreflightResult) => void;
  onRunningTargetBlocked?: (target: AuxiliarySessionSendTargetResolution) => void;
  onError?: (error: unknown) => void;
}): void {
  if (input.result.status === "blocked") {
    input.onBlocked?.(input.result.preflight);
    return;
  }
  if (input.result.status === "target-blocked" && input.result.target.blockedReason === "running") {
    input.onRunningTargetBlocked?.(input.result.target);
    return;
  }
  if (input.result.status === "error") {
    input.onError?.(input.result.error);
  }
}

export type AuxiliarySessionSendOperationInput = {
  activeSession: AuxiliarySession;
  executionOptions: SessionExecutionOptions;
  composerBlockedReason?: string | null;
  messageText: string;
  auxiliaryDraftIncarnation?: string;
  auxiliaryDraftDurableRevision?: number;
  parentMessageCount: number | null;
  updatedAt: string;
  draftSaveQueue: { current: Promise<void> };
  mutationRevision: { current: number };
  getCurrentSession: () => AuxiliarySession | null;
  canStartRun?: () => boolean;
  beforeRunningSessionApplied?: () => void;
  onRunError?: () => void;
  applyRunningSession: (session: AuxiliarySession) => void;
  afterRunningSessionApplied?: (session: AuxiliarySession) => void;
  applySavedSession: (session: AuxiliarySession) => void;
  restoreSessionAfterError: (session: AuxiliarySession) => void;
  clearPendingLiveRun: (sessionId: string) => void;
  runAuxiliarySessionTurn: (sessionId: string, request: RunSessionTurnRequest) => Promise<AuxiliarySession>;
};

export type AuxiliarySessionSendOperationApi = {
  runAuxiliarySessionTurn: (sessionId: string, request: RunSessionTurnRequest) => Promise<AuxiliarySession>;
};

export async function runAuxiliarySessionSendOperation(input: AuxiliarySessionSendOperationInput): Promise<AuxiliarySessionSendOperationResult> {
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
  if (input.mutationRevision.current !== sendStartRevision || input.canStartRun?.() === false) {
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
  const { runningSession } = buildAuxiliarySessionRunningTransition({
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
    const saved = await input.runAuxiliarySessionTurn(currentAuxiliarySession.id, {
      userMessage: preflight.userMessage,
      clientRequestId: createSessionTurnClientRequestId(),
      submitSource: "composer",
      executionOptions: input.executionOptions,
      displayAnchorParentMessageCount: input.parentMessageCount ?? undefined,
      auxiliaryDraftIncarnation: input.auxiliaryDraftIncarnation,
      auxiliaryDraftDurableRevision: input.auxiliaryDraftDurableRevision,
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
    input.onRunError?.();
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

export async function runAuxiliarySessionSendOperationWithApi(
  input: Omit<AuxiliarySessionSendOperationInput, "runAuxiliarySessionTurn"> & {
    api: AuxiliarySessionSendOperationApi;
  },
): Promise<AuxiliarySessionSendOperationResult> {
  return runAuxiliarySessionSendOperation({
    ...input,
    runAuxiliarySessionTurn: (sessionId, request) => input.api.runAuxiliarySessionTurn(sessionId, request),
  });
}
