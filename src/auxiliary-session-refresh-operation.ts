import type { AuxiliarySession } from "./auxiliary-session-state.js";

export type ActiveAuxiliarySessionRefreshOperationResult =
  | {
      status: "skipped";
    }
  | {
      status: "stale";
    }
  | {
      status: "loaded";
      savedSession: AuxiliarySession | null;
    };

export async function runActiveAuxiliarySessionRefreshOperation(input: {
  sessionId: string;
  activeSessionId: string | null;
  loadAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
}): Promise<ActiveAuxiliarySessionRefreshOperationResult> {
  if (input.activeSessionId !== input.sessionId) {
    return { status: "skipped" };
  }

  const savedSession = await input.loadAuxiliarySession(input.sessionId);
  if (!input.isActive()) {
    return { status: "stale" };
  }

  return {
    status: "loaded",
    savedSession,
  };
}
