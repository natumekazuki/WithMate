import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type {
  CancelSessionRunRequest,
  LiveApprovalRequest,
  LiveElicitationRequest,
  LiveElicitationResponse,
} from "../../../src-shared/session/runtime-state.js";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import {
  replaceLiveRunAfterResolvedRequest,
  type OwnedLiveSessionRunState,
} from "./session-live-run-state.js";
import { subscribeSessionLiveEvents } from "./session-window-live-ingress.js";
import type { SessionStopTarget } from "../send-or-cancel.js";

type LiveRunStateUpdater = (update: SetStateAction<OwnedLiveSessionRunState>) => void;
type PendingStop = CancelSessionRunRequest & { handedOff: boolean };

function isSameStopTarget(pending: CancelSessionRunRequest, target: SessionStopTarget): boolean {
  return pending.sessionId === target.request.sessionId && pending.incarnationId === target.request.incarnationId
    && (pending.execution.kind === target.request.execution.kind && pending.execution.id === target.request.execution.id
      || pending.execution.kind === "receipt" && pending.execution.id === target.receiptId);
}

export function useSessionRunActions(options: {
  api: WithMateWindowApi | null;
  activeRunSessionId: string | null;
  stopTargets: readonly [SessionStopTarget | null, (SessionStopTarget | null)?];
  setLiveRunState: LiveRunStateUpdater;
  onError: (message: string) => void;
}): {
  approvalActionRequestId: string | null;
  elicitationActionRequestId: string | null;
  resolveLiveApproval: (request: LiveApprovalRequest, decision: "approve" | "deny") => Promise<void>;
  resolveLiveElicitation: (request: LiveElicitationRequest, response: LiveElicitationResponse) => Promise<void>;
  pendingCancelSessionIds: ReadonlySet<string>;
  cancelRun: (target: SessionStopTarget | null, kind: "main" | "auxiliary") => Promise<void>;
} {
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);
  const pendingCancels = useRef(new Map<string, PendingStop>());
  const [pendingRevision, refreshPending] = useState(0);
  const [mainStopTarget, auxiliaryStopTarget] = options.stopTargets;
  const pendingCancelSessionIds = useMemo(() => new Set([mainStopTarget, auxiliaryStopTarget].flatMap((target) => {
    if (!target) return [];
    const pending = pendingCancels.current.get(target.request.sessionId);
    return pending && !pending.handedOff && isSameStopTarget(pending, target) ? [pending.sessionId] : [];
  })), [mainStopTarget, auxiliaryStopTarget, pendingRevision]);
  useEffect(() => {
    if (!options.api) return;
    return subscribeSessionLiveEvents(options.api, (id, state) => {
      const pending = pendingCancels.current.get(id);
      if (!pending) return;
      const matches = pending.execution.kind === "turn" ? state?.sessionTurnId === pending.execution.id
        : state?.queueReceipt?.id === pending.execution.id && state.queueReceipt.incarnationId === pending.incarnationId;
      if (matches && state?.cancellationState) {
        pending.handedOff = true;
        refreshPending((revision) => revision + 1);
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

  const cancelRun = useCallback(async (target: SessionStopTarget | null, kind: "main" | "auxiliary") => {
    if (!target || !options.api) return;
    const { request } = target;
    const id = request.sessionId;
    const previous = pendingCancels.current.get(id);
    if (previous && isSameStopTarget(previous, target)) return;
    const pending = { ...request, handedOff: false };
    pendingCancels.current.set(id, pending);
    refreshPending((revision) => revision + 1);
    try {
      await (kind === "auxiliary" ? options.api.cancelAuxiliarySessionRun(request) : options.api.cancelSessionRun(request));
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Could not cancel the run.");
    } finally {
      if (pendingCancels.current.get(id) === pending) {
        pendingCancels.current.delete(id);
        refreshPending((revision) => revision + 1);
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
