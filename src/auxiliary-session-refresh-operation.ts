import {
  loadClosedAuxiliarySessionDetails,
  resolveActiveAuxiliarySessionRefreshResult,
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

export function applyActiveAuxiliarySessionRefreshResult(input: {
  currentSession: AuxiliarySession | null;
  savedSession: AuxiliarySession | null;
  sessionId: string;
  activeSessionRef: { current: AuxiliarySession | null };
}): AuxiliarySession | null {
  const nextSession = resolveActiveAuxiliarySessionRefreshResult({
    currentSession: input.currentSession,
    savedSession: input.savedSession,
    sessionId: input.sessionId,
  });
  if (nextSession !== input.currentSession) {
    input.activeSessionRef.current = nextSession;
  }

  return nextSession;
}

export type ActiveAuxiliarySessionLoadOperationResult =
  | {
      status: "skipped";
    }
  | {
      status: "stale";
    }
  | {
      status: "loaded";
      session: AuxiliarySession | null;
    };

export async function runActiveAuxiliarySessionLoadOperation(input: {
  parentSessionId: string | null;
  getActiveAuxiliarySession: (parentSessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
}): Promise<ActiveAuxiliarySessionLoadOperationResult> {
  if (!input.parentSessionId) {
    return { status: "skipped" };
  }

  let session: AuxiliarySession | null;
  try {
    session = await input.getActiveAuxiliarySession(input.parentSessionId);
  } catch {
    session = null;
  }

  if (!input.isActive()) {
    return { status: "stale" };
  }

  return {
    status: "loaded",
    session,
  };
}

export function applyActiveAuxiliarySessionLoadResult(input: {
  result: ActiveAuxiliarySessionLoadOperationResult;
  setActiveSession: (session: AuxiliarySession | null) => void;
}): boolean {
  if (input.result.status !== "loaded") {
    return false;
  }

  input.setActiveSession(input.result.session);
  return true;
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
