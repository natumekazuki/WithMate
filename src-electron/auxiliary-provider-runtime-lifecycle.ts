import type { AuxiliarySession } from "../src/auxiliary-session-state.js";

type AuxiliaryRuntimeIdentity = Pick<
  AuxiliarySession,
  "id" | "provider" | "catalogRevision" | "model" | "reasoningEffort"
>;

function hasProviderRuntimeIdentityChanged(
  current: AuxiliaryRuntimeIdentity,
  updated: AuxiliaryRuntimeIdentity,
): boolean {
  return current.provider !== updated.provider
    || current.catalogRevision !== updated.catalogRevision
    || current.model !== updated.model
    || current.reasoningEffort !== updated.reasoningEffort;
}

export async function updateAuxiliarySessionWithProviderRuntimeLifecycle(input: {
  session: AuxiliarySession;
  isRunInFlight: (sessionId: string) => boolean;
  getAuxiliarySession: (sessionId: string) => AuxiliarySession | null;
  updateAuxiliarySession: (session: AuxiliarySession) => AuxiliarySession;
  revokeSessionAgentRuntimeBindings: (sessionId: string) => void;
  invalidateProviderSessionThread: (providerId: string, sessionId: string) => Promise<void>;
}): Promise<AuxiliarySession> {
  if (input.isRunInFlight(input.session.id)) {
    throw new Error("実行中の Auxiliary Session は更新できないよ。");
  }
  const current = input.getAuxiliarySession(input.session.id);
  const updated = input.updateAuxiliarySession(input.session);
  if (!current || !hasProviderRuntimeIdentityChanged(current, updated)) {
    return updated;
  }

  input.revokeSessionAgentRuntimeBindings(updated.id);
  await input.invalidateProviderSessionThread(current.provider, updated.id);
  return updated;
}
