import type {
  AuxiliaryLaunchSessionDefaults,
} from "./chat/auxiliary-launch-state.js";
import { buildCreateAuxiliarySessionInput } from "./chat/auxiliary-launch-state.js";
import type {
  AuxiliarySession,
  AuxiliarySessionSummary,
  CreateAuxiliarySessionInput,
} from "./auxiliary-session-state.js";
import { runClosedAuxiliarySessionsLoadAndApply } from "./auxiliary-session-refresh-operation.js";
import { createActiveAuxiliarySessionUpdateApplier } from "./auxiliary-session-update-operation.js";

export function beginAuxiliarySessionStartOperation(input: {
  loadRevision: { current: number };
  resetLaunchFeedback: () => void;
  setActionPending: (pending: boolean) => void;
}): number {
  input.resetLaunchFeedback();
  const nextRevision = input.loadRevision.current + 1;
  input.loadRevision.current = nextRevision;
  input.setActionPending(true);
  return nextRevision;
}

export function applyAuxiliarySessionStartError(input: {
  error: unknown;
  setLaunchStartError: (error: unknown) => void;
}): void {
  input.setLaunchStartError(input.error);
}

export function applyAuxiliarySessionStartResult(input: {
  session: AuxiliarySession;
  incrementMutationRevision: () => void;
  applyActiveSession: (session: AuxiliarySession) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
  closeLaunchDialog: () => void;
}): void {
  input.incrementMutationRevision();
  input.applyActiveSession(input.session);
  input.setActionDockPinnedExpanded(true);
  input.setForceComposerBlockedFeedback(false);
  input.closeLaunchDialog();
}

export function createAuxiliarySessionStartResultApplier(input: {
  incrementMutationRevision: () => void;
  applyActiveSession: (session: AuxiliarySession) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
  closeLaunchDialog: () => void;
}): (session: AuxiliarySession) => void {
  return (session) => {
    applyAuxiliarySessionStartResult({
      ...input,
      session,
    });
  };
}

export function createActiveAuxiliarySessionStartResultApplier(input: {
  mutationRevision: { current: number };
  activeSessionRef: { current: AuxiliarySession | null };
  setActiveSession: (session: AuxiliarySession) => void;
  setActionDockPinnedExpanded: (expanded: boolean) => void;
  setForceComposerBlockedFeedback: (forced: boolean) => void;
  closeLaunchDialog: () => void;
}): (session: AuxiliarySession) => void {
  return createAuxiliarySessionStartResultApplier({
    incrementMutationRevision: () => {
      input.mutationRevision.current += 1;
    },
    applyActiveSession: createActiveAuxiliarySessionUpdateApplier({
      activeSessionRef: input.activeSessionRef,
      setActiveSession: input.setActiveSession,
    }),
    setActionDockPinnedExpanded: input.setActionDockPinnedExpanded,
    setForceComposerBlockedFeedback: input.setForceComposerBlockedFeedback,
    closeLaunchDialog: input.closeLaunchDialog,
  });
}

export async function runAuxiliarySessionStartOperation(input: {
  parentSessionId: string;
  provider: string;
  defaults?: Partial<AuxiliaryLaunchSessionDefaults> | null;
  createAuxiliarySession: (request: CreateAuxiliarySessionInput) => Promise<AuxiliarySession>;
  applyStartedSession: (session: AuxiliarySession) => void;
}): Promise<AuxiliarySession> {
  const session = await input.createAuxiliarySession(buildCreateAuxiliarySessionInput({
    parentSessionId: input.parentSessionId,
    provider: input.provider,
    defaults: input.defaults,
  }));
  input.applyStartedSession(session);
  return session;
}

export function finishAuxiliarySessionStartClosedLoad(input: {
  parentSessionId: string;
  listAuxiliarySessions: (parentSessionId: string) => Promise<AuxiliarySessionSummary[]>;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
  setClosedSessions: (sessions: AuxiliarySession[]) => void;
  setActionPending: (pending: boolean) => void;
}): void {
  void runClosedAuxiliarySessionsLoadAndApply({
    parentSessionId: input.parentSessionId,
    listAuxiliarySessions: input.listAuxiliarySessions,
    getAuxiliarySession: input.getAuxiliarySession,
    isActive: input.isActive,
    setClosedSessions: input.setClosedSessions,
  });
  input.setActionPending(false);
}

export function finishAuxiliarySessionStartClosedLoadWithApi(input: {
  parentSessionId: string;
  api: {
    listAuxiliarySessions: (parentSessionId: string) => Promise<AuxiliarySessionSummary[]>;
    getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  };
  isActive: () => boolean;
  setClosedSessions: (sessions: AuxiliarySession[]) => void;
  setActionPending: (pending: boolean) => void;
}): void {
  finishAuxiliarySessionStartClosedLoad({
    parentSessionId: input.parentSessionId,
    listAuxiliarySessions: (parentSessionId) => input.api.listAuxiliarySessions(parentSessionId),
    getAuxiliarySession: (sessionId) => input.api.getAuxiliarySession(sessionId),
    isActive: input.isActive,
    setClosedSessions: input.setClosedSessions,
    setActionPending: input.setActionPending,
  });
}
