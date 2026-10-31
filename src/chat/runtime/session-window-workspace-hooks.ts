import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Session } from "../../../src-shared/session/session-state.js";
import {
  applySessionWorkspaceAvailabilityResult,
  beginSessionWorkspaceAvailabilityCheck,
  INITIAL_SESSION_WORKSPACE_AVAILABILITY,
  type SessionWorkspaceAvailabilityState,
} from "./session-workspace-availability.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";

export function useSessionWorkspaceAvailability(
  api: WithMateWindowApi | null,
  selectedSession: Session | null,
): {
  workspaceAvailability: SessionWorkspaceAvailabilityState;
  workspaceAvailabilityCheckRevision: number;
  setWorkspaceAvailabilityCheckRevision: Dispatch<SetStateAction<number>>;
  validateSessionWorkspace: (session: Session, preserveAvailableState?: boolean) => Promise<boolean>;
} {
  const [workspaceAvailability, setWorkspaceAvailability] = useState(INITIAL_SESSION_WORKSPACE_AVAILABILITY);
  const [workspaceAvailabilityCheckRevision, setWorkspaceAvailabilityCheckRevision] = useState(0);
  const workspaceAvailabilityRequestIdRef = useRef(0);
  const validateSessionWorkspace = useCallback(async (
    session: Session,
    preserveAvailableState = false,
  ): Promise<boolean> => {
    if (!api) {
      return false;
    }
    const { id: sessionId, workspacePath } = session;
    const requestId = workspaceAvailabilityRequestIdRef.current + 1;
    workspaceAvailabilityRequestIdRef.current = requestId;
    if (!preserveAvailableState) {
      setWorkspaceAvailability(beginSessionWorkspaceAvailabilityCheck(sessionId, workspacePath, requestId));
    }
    const result = await api.validateSessionWorkspace(sessionId)
      .catch(() => ({ valid: false, reason: "unavailable" } as const));
    if (workspaceAvailabilityRequestIdRef.current !== requestId) {
      return false;
    }
    if (preserveAvailableState) {
      setWorkspaceAvailability((current) => {
        if (current.status !== "available" || current.sessionId !== sessionId || current.workspacePath !== workspacePath) {
          return current;
        }
        if (result.valid) {
          return current;
        }
        return { status: "unavailable", sessionId, workspacePath, reason: result.reason };
      });
    } else {
      setWorkspaceAvailability((current) => applySessionWorkspaceAvailabilityResult(
        current,
        sessionId,
        workspacePath,
        requestId,
        result,
      ));
    }
    return result.valid;
  }, [api]);

  useEffect(() => {
    if (!api || !selectedSession) {
      workspaceAvailabilityRequestIdRef.current += 1;
      setWorkspaceAvailability(INITIAL_SESSION_WORKSPACE_AVAILABILITY);
      return;
    }

    void validateSessionWorkspace(selectedSession);

    return () => {
      workspaceAvailabilityRequestIdRef.current += 1;
    };
  }, [api, selectedSession?.id, selectedSession?.workspacePath, validateSessionWorkspace, workspaceAvailabilityCheckRevision]);

  return {
    workspaceAvailability,
    workspaceAvailabilityCheckRevision,
    setWorkspaceAvailabilityCheckRevision,
    validateSessionWorkspace,
  };
}
