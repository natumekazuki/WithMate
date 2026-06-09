import {
  loadClosedAuxiliarySessionDetails,
  type AuxiliarySession,
  type AuxiliarySessionSummary,
} from "./auxiliary-session-state.js";

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

export type ClosedAuxiliarySessionsLoadOperationResult =
  | {
      status: "skipped";
    }
  | {
      status: "stale";
    }
  | {
      status: "loaded";
      sessions: AuxiliarySession[];
    };

export async function runClosedAuxiliarySessionsLoadOperation(input: {
  parentSessionId: string | null;
  listAuxiliarySessions: (parentSessionId: string) => Promise<AuxiliarySessionSummary[]>;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
}): Promise<ClosedAuxiliarySessionsLoadOperationResult> {
  if (!input.parentSessionId) {
    return { status: "skipped" };
  }

  let sessions: AuxiliarySession[];
  try {
    sessions = await loadClosedAuxiliarySessionDetails({
      parentSessionId: input.parentSessionId,
      listAuxiliarySessions: input.listAuxiliarySessions,
      getAuxiliarySession: input.getAuxiliarySession,
    });
  } catch {
    sessions = [];
  }

  if (!input.isActive()) {
    return { status: "stale" };
  }

  return {
    status: "loaded",
    sessions,
  };
}
