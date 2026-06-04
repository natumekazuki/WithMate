import type {
  AuxiliaryLaunchSessionDefaults,
} from "./chat/auxiliary-launch-state.js";
import { buildCreateAuxiliarySessionInput } from "./chat/auxiliary-launch-state.js";
import type {
  AuxiliarySession,
  CreateAuxiliarySessionInput,
} from "./auxiliary-session-state.js";

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
