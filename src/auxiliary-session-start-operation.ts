import type {
  AuxiliaryLaunchSessionDefaults,
} from "./chat/auxiliary-launch-state.js";
import { buildCreateAuxiliarySessionInput } from "./chat/auxiliary-launch-state.js";
import type {
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "./auxiliary-session-state.js";

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
