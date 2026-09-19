import type {
  AuxiliaryCreationResult,
  AuxiliaryCreationRequest,
  AuxiliarySession,
} from "../auxiliary-session-state.js";
import { matchesAuxiliaryLaunchCreationRequest } from "./auxiliary-launch-state.js";

export type AuxiliaryLaunchReconciliationResult = {
  status: AuxiliaryCreationResult["status"];
  applied: boolean;
  stale: boolean;
};

export async function reconcileAuxiliaryLaunchCreation(input: {
  request: AuxiliaryCreationRequest;
  getCreation: (request: AuxiliaryCreationRequest) => Promise<AuxiliaryCreationResult>;
  getSession: (sessionId: string) => Promise<AuxiliarySession | null>;
  isCurrent: (request: AuxiliaryCreationRequest) => boolean;
  onStatus: (status: AuxiliaryCreationResult["status"]) => void;
  onCommittedSession: (session: AuxiliarySession) => void;
}): Promise<AuxiliaryLaunchReconciliationResult> {
  const result = await input.getCreation(input.request);
  if (!input.isCurrent(input.request)) {
    return { status: result.status, applied: false, stale: true };
  }
  input.onStatus(result.status);
  if (result.status !== "committed" || !result.auxiliarySessionId) {
    return { status: result.status, applied: false, stale: false };
  }
  const session = await input.getSession(result.auxiliarySessionId);
  if (!input.isCurrent(input.request)) {
    return { status: result.status, applied: false, stale: true };
  }
  if (!session || !matchesAuxiliaryLaunchCreationRequest(session, input.request)) {
    return { status: result.status, applied: false, stale: true };
  }
  input.onCommittedSession(session);
  return { status: result.status, applied: true, stale: false };
}
