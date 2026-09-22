import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import {
  startLiveSessionRunSubscription,
} from "./session-live-run-subscription.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";

export function useActiveSessionLiveRun(
  api: WithMateWindowApi | null,
  selectedSession: Session | null,
  activeRunSessionId: string | null,
): {
  hasSelectedSessionLiveRun: boolean;
  getLiveRunRevision: () => number;
  selectedSessionLiveRun: OwnedLiveSessionRunState["state"];
  setLiveRunState: (update: SetStateAction<OwnedLiveSessionRunState>) => void;
} {
  const [liveRunStates, setLiveRunStates] = useState<Record<string, OwnedLiveSessionRunState>>({});
  const liveRunRevisionRef = useRef(0);
  const setLiveRunForSession = useCallback((sessionId: string | null, update: SetStateAction<OwnedLiveSessionRunState>) => {
    if (!sessionId) {
      return;
    }
    liveRunRevisionRef.current += 1;
    setLiveRunStates((current) => {
      const previous = current[sessionId] ?? { ownerSessionId: sessionId, state: null };
      const next = typeof update === "function" ? update(previous) : update;
      return next.ownerSessionId === sessionId ? { ...current, [sessionId]: next } : current;
    });
  }, []);
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

    return startLiveSessionRunSubscription({
      sessionId: activeRunSessionId,
      api,
      applyLiveRunState: setLiveRunState,
    });
  }, [activeRunSessionId, api, selectedSession?.id, setLiveRunState]);

  return { getLiveRunRevision, hasSelectedSessionLiveRun, selectedSessionLiveRun, setLiveRunState };
}
