import type {
  WorkspaceDirectoryValidationFailureReason,
  WorkspaceDirectoryValidationResult,
} from "./workspace-directory-validation.js";

export type SessionWorkspaceAvailabilityState =
  | { status: "idle" }
  | {
      status: "checking";
      sessionId: string;
      workspacePath: string;
      requestId: number;
    }
  | {
      status: "available";
      sessionId: string;
      workspacePath: string;
    }
  | {
      status: "unavailable";
      sessionId: string;
      workspacePath: string;
      reason: WorkspaceDirectoryValidationFailureReason;
    };

export const INITIAL_SESSION_WORKSPACE_AVAILABILITY: SessionWorkspaceAvailabilityState = {
  status: "idle",
};

export function beginSessionWorkspaceAvailabilityCheck(
  sessionId: string,
  workspacePath: string,
  requestId: number,
): SessionWorkspaceAvailabilityState {
  return { status: "checking", sessionId, workspacePath, requestId };
}

export function applySessionWorkspaceAvailabilityResult(
  current: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
  requestId: number,
  result: WorkspaceDirectoryValidationResult,
): SessionWorkspaceAvailabilityState {
  if (
    current.status !== "checking"
    || current.sessionId !== sessionId
    || current.workspacePath !== workspacePath
    || current.requestId !== requestId
  ) {
    return current;
  }

  return result.valid
    ? { status: "available", sessionId, workspacePath }
    : { status: "unavailable", sessionId, workspacePath, reason: result.reason };
}

export function isSessionWorkspaceAvailable(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): boolean {
  return state.status === "available"
    && state.sessionId === sessionId
    && state.workspacePath === workspacePath;
}

export function resolveSessionWorkspaceBlockedReason(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): string {
  if (isSessionWorkspaceAvailable(state, sessionId, workspacePath)) {
    return "";
  }
  if (
    state.status === "unavailable"
    && state.sessionId === sessionId
    && state.workspacePath === workspacePath
  ) {
    return resolveSessionWorkspaceUnavailableMessage(state, sessionId, workspacePath);
  }
  return "";
}

export type SessionWorkspaceExecutionGate = {
  isPending: boolean;
  blockedReason: string;
};

export function resolveSessionWorkspaceExecutionGate(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): SessionWorkspaceExecutionGate {
  const isUnavailable = state.status === "unavailable"
    && state.sessionId === sessionId
    && state.workspacePath === workspacePath;
  const isPending = !isSessionWorkspaceAvailable(state, sessionId, workspacePath) && !isUnavailable;

  return {
    isPending,
    blockedReason: isPending
      ? ""
      : resolveSessionWorkspaceBlockedReason(state, sessionId, workspacePath),
  };
}

export function resolveSessionWorkspaceUnavailableMessage(
  state: SessionWorkspaceAvailabilityState,
  sessionId: string,
  workspacePath: string,
): string {
  if (
    state.status !== "unavailable"
    || state.sessionId !== sessionId
    || state.workspacePath !== workspacePath
  ) {
    return "";
  }

  switch (state.reason) {
    case "missing":
      return `Workspace not found: ${workspacePath}. Restore it, then recheck.`;
    case "not-directory":
      return `Workspace is not a directory: ${workspacePath}. Restore it, then recheck.`;
    case "empty":
    case "not-absolute":
    case "unavailable":
      return `Workspace unavailable: ${workspacePath}. Restore access, then recheck.`;
  }
}
