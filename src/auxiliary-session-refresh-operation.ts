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

export async function runActiveAuxiliarySessionRefreshAndApply(input: {
  sessionId: string;
  activeSessionId: string | null;
  loadAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
  setActiveSession: (updater: (current: AuxiliarySession | null) => AuxiliarySession | null) => void;
  activeSessionRef: { current: AuxiliarySession | null };
}): Promise<ActiveAuxiliarySessionRefreshOperationResult> {
  const result = await runActiveAuxiliarySessionRefreshOperation(input);
  if (result.status !== "loaded") {
    return result;
  }

  input.setActiveSession((current) => {
    return applyActiveAuxiliarySessionRefreshResult({
      currentSession: current,
      savedSession: result.savedSession,
      sessionId: input.sessionId,
      activeSessionRef: input.activeSessionRef,
    });
  });
  return result;
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

export async function runActiveAuxiliarySessionLoadAndApply(input: {
  parentSessionId: string | null;
  getActiveAuxiliarySession: (parentSessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
  setActiveSession: (session: AuxiliarySession | null) => void;
}): Promise<ActiveAuxiliarySessionLoadOperationResult> {
  const result = await runActiveAuxiliarySessionLoadOperation(input);
  applyActiveAuxiliarySessionLoadResult({
    result,
    setActiveSession: input.setActiveSession,
  });
  return result;
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

export function applyClosedAuxiliarySessionsLoadResult(input: {
  result: ClosedAuxiliarySessionsLoadOperationResult;
  setClosedSessions: (sessions: AuxiliarySession[]) => void;
}): boolean {
  if (input.result.status !== "loaded") {
    return false;
  }

  input.setClosedSessions(input.result.sessions);
  return true;
}

export function clearAuxiliarySessionsLoadState(input: {
  setActiveSession: (session: AuxiliarySession | null) => void;
  setClosedSessions: (sessions: AuxiliarySession[]) => void;
}): void {
  input.setActiveSession(null);
  input.setClosedSessions([]);
}

export async function runClosedAuxiliarySessionsLoadAndApply(input: {
  parentSessionId: string | null;
  listAuxiliarySessions: (parentSessionId: string) => Promise<AuxiliarySessionSummary[]>;
  getAuxiliarySession: (sessionId: string) => Promise<AuxiliarySession | null>;
  isActive: () => boolean;
  setClosedSessions: (sessions: AuxiliarySession[]) => void;
}): Promise<ClosedAuxiliarySessionsLoadOperationResult> {
  const result = await runClosedAuxiliarySessionsLoadOperation(input);
  applyClosedAuxiliarySessionsLoadResult({
    result,
    setClosedSessions: input.setClosedSessions,
  });
  return result;
}
