import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type {
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
} from "../../../src-shared/session/runtime-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  replaceLiveRunAfterResolvedRequest,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
import {
  runRunningSessionCancelOperation,
  resolveRunningSessionCancelTargetId,
  type RunningSessionCancelTarget,
} from "../send-or-cancel.js";
import { subscribeSessionLiveEvents } from "./session-window-live-ingress.js";

type LiveRunStateUpdater = (update: SetStateAction<OwnedLiveSessionRunState>) => void;

export function useSessionRunActions(options: {
  api: WithMateWindowApi | null;
  activeRunSessionId: string | null;
  setLiveRunState: LiveRunStateUpdater;
  onError: (message: string) => void;
}): {
  approvalActionRequestId: string | null;
  elicitationActionRequestId: string | null;
  resolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => Promise<void>;
  resolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => Promise<void>;
  pendingCancelSessionIds: ReadonlySet<string>;
  cancelRun: (target: RunningSessionCancelTarget, kind?: "main" | "auxiliary", turnId?: string) => Promise<void>;
} {
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
  const pendingCancels = useRef(new Map<string, { turnId?: string; handedOff: boolean }>());
  const [pendingCancelSessionIds, setPendingCancelSessionIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!options.api) return;
    return subscribeSessionLiveEvents(options.api, (id, state) => {
      const pending = pendingCancels.current.get(id);
      if (pending && state && pending.turnId === undefined) pending.turnId = state.turnId;
      if (pending && (!state || state.cancellationState || state.turnId !== pending.turnId)) {
        if (!state || !state.cancellationState && state.turnId !== pending.turnId) pendingCancels.current.delete(id);
        else pending.handedOff = true;
        setPendingCancelSessionIds(new Set([...pendingCancels.current].filter(([, request]) => !request.handedOff).map(([sessionId]) => sessionId)));
      }
    });
  }, [options.api]);

  useEffect(() => {
    setApprovalActionRequestId(null);
    setElicitationActionRequestId(null);
  }, [options.activeRunSessionId]);

  const resolveLiveApproval = useCallback(async (request: LiveApprovalRequest, decision: "approve" | "deny") => {
    if (!options.api || !options.activeRunSessionId || approvalActionRequestId === request.requestId) {
      return;
    }
    const sessionId = options.activeRunSessionId;
    setApprovalActionRequestId(request.requestId);
    try {
      await options.api.resolveLiveApproval(sessionId, request.requestId, decision);
      const latestLiveRun = await options.api.getLiveSessionRun(sessionId);
      options.setLiveRunState((current) => replaceLiveRunAfterResolvedRequest(current, {
        sessionId,
        requestId: request.requestId,
        requestKind: "approval",
        latestLiveRun,
      }));
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Could not process the approval request.");
    } finally {
      setApprovalActionRequestId(null);
    }
  }, [approvalActionRequestId, options.activeRunSessionId, options.api, options.onError, options.setLiveRunState]);

  const resolveLiveElicitation = useCallback(async (
    request: LiveElicitationRequest,
    response: LiveElicitationResponse,
  ) => {
    if (!options.api || !options.activeRunSessionId || elicitationActionRequestId === request.requestId) {
      return;
    }
    const sessionId = options.activeRunSessionId;
    setElicitationActionRequestId(request.requestId);
    try {
      await options.api.resolveLiveElicitation(sessionId, request.requestId, response);
      const latestLiveRun = await options.api.getLiveSessionRun(sessionId);
      options.setLiveRunState((current) => replaceLiveRunAfterResolvedRequest(current, {
        sessionId,
        requestId: request.requestId,
        requestKind: "elicitation",
        latestLiveRun,
      }));
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Could not process the input request.");
    } finally {
      setElicitationActionRequestId(null);
    }
  }, [elicitationActionRequestId, options.activeRunSessionId, options.api, options.onError, options.setLiveRunState]);

  const cancelRun = useCallback(async (target: RunningSessionCancelTarget, kind: "main" | "auxiliary" = "main", turnId?: string) => {
    const id = resolveRunningSessionCancelTargetId(target);
    if (!id || !options.api || pendingCancels.current.has(id)) return;
    const pending = { turnId, handedOff: false };
    pendingCancels.current.set(id, pending);
    setPendingCancelSessionIds(new Set([...pendingCancels.current].filter(([, request]) => !request.handedOff).map(([sessionId]) => sessionId)));
    try {
      await runRunningSessionCancelOperation({
        target,
        cancelRun: (sessionId) => kind === "auxiliary"
          ? options.api!.cancelAuxiliarySessionRun(sessionId)
          : options.api!.cancelSessionRun(sessionId),
      });
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Could not cancel the run.");
    } finally {
      if (pendingCancels.current.get(id) === pending) {
        pendingCancels.current.delete(id);
        setPendingCancelSessionIds(new Set([...pendingCancels.current].filter(([, request]) => !request.handedOff).map(([sessionId]) => sessionId)));
      }
    }
  }, [options.api, options.onError]);

  return {
    approvalActionRequestId,
    elicitationActionRequestId,
    pendingCancelSessionIds,
    resolveLiveApproval,
    resolveLiveElicitation,
    cancelRun,
  };
}
