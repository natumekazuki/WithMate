import { useCallback, useEffect, useState, type SetStateAction } from "react";
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
  type RunningSessionCancelTarget,
} from "../send-or-cancel.js";

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
  cancelRun: (target: RunningSessionCancelTarget) => Promise<void>;
} {
  const [approvalActionRequestId, setApprovalActionRequestId] = useState<string | null>(null);
  const [elicitationActionRequestId, setElicitationActionRequestId] = useState<string | null>(null);

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
      options.onError(error instanceof Error ? error.message : "承認要求の処理に失敗したよ。");
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
      options.onError(error instanceof Error ? error.message : "入力要求の処理に失敗したよ。");
    } finally {
      setElicitationActionRequestId(null);
    }
  }, [elicitationActionRequestId, options.activeRunSessionId, options.api, options.onError, options.setLiveRunState]);

  const cancelRun = useCallback(async (target: RunningSessionCancelTarget) => {
    try {
      await runRunningSessionCancelOperation({
        target,
        cancelRun: options.api ? (sessionId) => options.api!.cancelSessionRun(sessionId) : null,
      });
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "キャンセルに失敗したよ。");
    }
  }, [options.api, options.onError]);

  return {
    approvalActionRequestId,
    elicitationActionRequestId,
    resolveLiveApproval,
    resolveLiveElicitation,
    cancelRun,
  };
}
