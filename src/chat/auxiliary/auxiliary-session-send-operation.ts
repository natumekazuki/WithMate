import {
  buildAuxiliarySessionRunningTransition,
  resolveAuxiliarySessionSendPreflight,
  resolveAuxiliarySessionSendTarget,
  type AuxiliarySession,
  type AuxiliarySessionSendPreflightResult,
  type AuxiliarySessionSendTargetResolution,
} from "../../../src-shared/auxiliary/auxiliary-session-state.js";
import type { SessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import { captureSessionExecutionOptions } from "../../../src-shared/session/session-execution-options.js";
import type { RunSessionTurnRequest } from "../../../src-shared/session/runtime-state.js";
import { createSessionTurnClientRequestId } from "../runtime/session-submit-coordinator.js";
import { mergeMessageBookmarkProjection } from "../runtime/session-submit-coordinator.js";
import {
  clearOwnedLiveSessionRunState,
  applyOptimisticSessionRunUpdate,
  type OwnedLiveSessionRunState,
} from "../runtime/session-live-run-state.js";
import type { AuxiliaryDraftPersistence } from "./use-auxiliary-draft-persistence.js";
import type { ComposerControllerRegistry } from "../composer-controller.js";
import type { AuxiliarySessionBinding } from "../use-auxiliary-workspace.js";

type AuxiliaryComposerSendInput = {
  api: AuxiliarySessionSendOperationApi;
  binding: AuxiliarySessionBinding;
  drafts: AuxiliaryDraftPersistence;
  composerRegistry: ComposerControllerRegistry;
  blockedReason: string | null;
  busyReason: string;
  parentMessageCount: number | null;
  updatedAt: string;
  isCurrentTarget(): boolean;
  collapseActionDock(): void;
  updateLiveRunState(updater: (current: OwnedLiveSessionRunState) => OwnedLiveSessionRunState): void;
  onRunningSessionApplied(session: AuxiliarySession): void;
  onBlocked(): void;
};

export class AuxiliaryComposerSendOwner {
  private readonly inFlightIds = new Set<string>();

  send(input: AuxiliaryComposerSendInput): Promise<void> {
    const session = input.binding.getSession();
    if (!session || input.composerRegistry.isFrozen) return Promise.resolve();
    if (this.inFlightIds.has(session.id) || input.busyReason) return Promise.resolve();
    const executionOptions = captureSessionExecutionOptions(session);
    const captured = input.composerRegistry.capture({ kind: "auxiliary", id: session.id });
    const composer = input.composerRegistry.get(captured.owner);
    if (composer.saveState === "error" || composer.preview.errors.length > 0 || !captured.draft.trim() || session.runState === "running") {
      input.onBlocked();
      return Promise.resolve();
    }
    this.inFlightIds.add(session.id);
    const releaseDetail = input.binding.retainDetail();
    const perform = async () => {
      const submission = await input.drafts.prepareSubmission(session, captured, "turn");
      if (!submission) return;
      const result = await runAuxiliarySessionSendOperation({
        activeSession: session,
        executionOptions,
        composerBlockedReason: input.blockedReason,
        messageText: captured.draft,
        auxiliaryDraftIncarnation: submission.durable.incarnation,
        auxiliaryDraftDurableRevision: submission.durable.durableRevision,
        parentMessageCount: input.parentMessageCount,
        updatedAt: input.updatedAt,
        draftSaveQueue: input.binding.draftSaveQueue,
        mutationRevision: input.binding.mutationRevision,
        getCurrentSession: input.binding.getSession,
        canStartRun: () => !input.composerRegistry.isFrozen && input.isCurrentTarget() && submission.isCurrent(),
        beforeRunningSessionApplied: () => {
          submission.clear();
          input.collapseActionDock();
        },
        onRunError: () => {
          const current = input.binding.getSession();
          if (current?.id === session.id && current.createdAt === session.createdAt) submission.restore();
        },
        applyRunningSession: createAuxiliarySessionRunningApplier({
          activeSessionRef: input.binding.sessionRef,
          setActiveSession: input.binding.setSession,
          updateLiveRunState: input.updateLiveRunState,
        }),
        afterRunningSessionApplied: input.onRunningSessionApplied,
        ...createAuxiliarySessionSendResultAppliers({ activeSessionRef: input.binding.sessionRef, setActiveSession: input.binding.setSession }),
        clearPendingLiveRun: createAuxiliarySessionPendingLiveRunClearer({ updateLiveRunState: input.updateLiveRunState }),
        runAuxiliarySessionTurn: (id, request) => submission.consume(() => input.api.runAuxiliarySessionTurn(id, request)),
      });
      await submission.reload().catch(() => undefined);
      handleAuxiliarySessionSendOperationResult({
        result,
        onBlocked: (preflight) => { throw new Error(preflight.blockedMessage); },
        onRunningTargetBlocked: () => { throw new Error("The Auxiliary session is still running."); },
        onError: (error) => { console.error(error); throw error; },
      });
    };
    return input.drafts.trackSend(perform().finally(() => {
      releaseDetail();
      this.inFlightIds.delete(session.id);
    }));
  }
}

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
}): (runningSession: AuxiliarySession) => void {
  return (runningSession) => {
    const current = input.activeSessionRef.current;
    const projected = current?.id === runningSession.id && current.createdAt === runningSession.createdAt
      ? { ...runningSession, ...captureSessionExecutionOptions(current), messages: mergeMessageBookmarkProjection(current.messages, runningSession.messages) }
      : runningSession;
    applyOptimisticSessionRunUpdate({
      runningSession: projected,
      applyRunningSession: input.setActiveSession,
      updateLiveRunState: input.updateLiveRunState,
    });
  };
}

export function createAuxiliarySessionSendResultAppliers(input: {
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession) => void;
}): {
  applySavedSession: (session: AuxiliarySession) => void;
  restoreSessionAfterError: (session: AuxiliarySession) => void;
} {
  const applyWithCurrentSelection = (session: AuxiliarySession) => {
    const current = input.activeSessionRef.current;
    input.setActiveSession(current?.id === session.id && current.createdAt === session.createdAt
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
      || input.getCurrentSession()?.createdAt !== saved.createdAt
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
      || input.getCurrentSession()?.createdAt !== currentAuxiliarySession.createdAt
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
