import type { AuxiliarySession } from "./auxiliary-session-state.js";

export async function runAuxiliarySessionReturnToMainOperation(input: {
  activeSession: AuxiliarySession | null;
  beforeClose?: () => void;
  closeAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession>;
  applyClosedSession: (session: AuxiliarySession) => void;
  applyReturnedMainSession: () => void;
}): Promise<AuxiliarySession | null> {
  if (!input.activeSession) {
    return null;
  }

  input.beforeClose?.();
  const closedSession = await input.closeAuxiliarySession(input.activeSession.id);
  input.applyClosedSession(closedSession);
  input.applyReturnedMainSession();
  return closedSession;
}
