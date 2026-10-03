import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import {
  startLiveSessionRunSubscription,
} from "./session-live-run-subscription.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";

function sameRunControls(left: OwnedLiveSessionRunState["state"], right: OwnedLiveSessionRunState["state"]): boolean {
  return Boolean(left) === Boolean(right)
    && Boolean(left?.assistantText) === Boolean(right?.assistantText)
    && Boolean(left?.approvalRequest) === Boolean(right?.approvalRequest)
    && Boolean(left?.elicitationRequest) === Boolean(right?.elicitationRequest)
    && left?.errorMessage === right?.errorMessage
    && left?.cancellationState === right?.cancellationState
    && Boolean(left?.steps.some((step) => step.status === "in_progress"))
      === Boolean(right?.steps.some((step) => step.status === "in_progress"));
}

function useSessionLiveRunSubscription(
  api: WithMateWindowApi | null,
  selectedSession: Session | null,
  activeRunSessionId: string | null,
  controlsOnly = false,
): {
  hasSelectedSessionLiveRun: boolean;
  selectedSessionCancellationState: NonNullable<OwnedLiveSessionRunState["state"]>["cancellationState"];
  getLiveRunRevision: () => number;
  selectedSessionLiveRun: OwnedLiveSessionRunState["state"];
  setLiveRunState: (update: SetStateAction<OwnedLiveSessionRunState>) => void;
} {
  const [liveRunStates, setLiveRunStates] = useState<Record<string, OwnedLiveSessionRunState>>({});
  const latestStatesRef = useRef<Record<string, OwnedLiveSessionRunState>>({});
  const liveRunRevisionRef = useRef(0);
  const setLiveRunForSession = useCallback((sessionId: string | null, update: SetStateAction<OwnedLiveSessionRunState>) => {
    if (!sessionId) {
      return;
    }
    liveRunRevisionRef.current += 1;
    const previous = latestStatesRef.current[sessionId] ?? { ownerSessionId: sessionId, state: null };
    const next = typeof update === "function" ? update(previous) : update;
    if (next.ownerSessionId !== sessionId) return;
    latestStatesRef.current = { ...latestStatesRef.current, [sessionId]: next };
    setLiveRunStates((current) => controlsOnly && sameRunControls(current[sessionId]?.state ?? null, next.state)
      ? current : { ...current, [sessionId]: next });
  }, [controlsOnly]);
  const liveRunState = liveRunStates[activeRunSessionId ?? ""] ?? { ownerSessionId: activeRunSessionId, state: null };
  const setLiveRunState = useCallback(
    (update: SetStateAction<OwnedLiveSessionRunState>) => setLiveRunForSession(activeRunSessionId, update),
    [activeRunSessionId, setLiveRunForSession],
  );
  const selectedSessionLiveRun = useMemo(
    () => (activeRunSessionId !== null && liveRunState.ownerSessionId === activeRunSessionId ? liveRunState.state : null),
    [activeRunSessionId, liveRunState.ownerSessionId, liveRunState.state],
  );
  const hasSelectedSessionLiveRun = !!selectedSession?.id && !!liveRunStates[selectedSession.id]?.state;
  const getLiveRunRevision = useCallback(() => liveRunRevisionRef.current, []);

  useEffect(() => {
    if (!api || !selectedSession?.id || !activeRunSessionId) {
      setLiveRunState({ ownerSessionId: null, state: null });
      return;
    }

    const cachedState = latestStatesRef.current[activeRunSessionId]?.state;
    return startLiveSessionRunSubscription({
      sessionId: activeRunSessionId,
      api,
      // Resubscription is not an authoritative cancellation release.
      initialState: cachedState?.cancellationState ? cachedState : null,
      applyLiveRunState: setLiveRunState,
    });
  }, [activeRunSessionId, api, selectedSession?.id, setLiveRunState]);

  return {
    getLiveRunRevision,
    hasSelectedSessionLiveRun,
    selectedSessionCancellationState: liveRunStates[selectedSession?.id ?? ""]?.state?.cancellationState,
    selectedSessionLiveRun,
    setLiveRunState,
  };
}

/** Full display snapshots belong to the conversation, context, or audit surface. */
export function useActiveSessionLiveRun(api: WithMateWindowApi | null, selectedSession: Session | null, activeRunSessionId: string | null) {
  return useSessionLiveRunSubscription(api, selectedSession, activeRunSessionId);
}

/** Shell consumers only react to changes that affect their controls and notices. */
export function useSessionRunControls(api: WithMateWindowApi | null, selectedSession: Session | null, activeRunSessionId: string | null) {
  const { selectedSessionLiveRun: liveRun, ...operations } = useSessionLiveRunSubscription(api, selectedSession, activeRunSessionId, true);
  return {
    ...operations,
    hasLiveRun: Boolean(liveRun),
    hasAssistantText: Boolean(liveRun?.assistantText),
    hasApprovalRequest: Boolean(liveRun?.approvalRequest),
    hasElicitationRequest: Boolean(liveRun?.elicitationRequest),
    hasInProgressStep: Boolean(liveRun?.steps.some((step) => step.status === "in_progress")),
    errorMessage: liveRun?.errorMessage ?? "",
  };
}
