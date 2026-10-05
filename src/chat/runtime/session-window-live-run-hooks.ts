import { useCallback, useEffect, useState, type SetStateAction } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { Session } from "../../../src-shared/session/session-state.js";
import type { OwnedLiveSessionRunState } from "./session-live-run-state.js";
import { getSessionLiveRevision, projectSessionRunControls, subscribeSessionLiveSelection, subscribeSessionRunControls, updateSessionLiveState } from "./session-window-live-ingress.js";

export function useActiveSessionLiveRun(api: WithMateWindowApi | null, selectedSession: Session | null, activeRunSessionId: string | null, enabled = true) {
  const [owned, setOwned] = useState<OwnedLiveSessionRunState>({ ownerSessionId: null, state: null });
  const id = enabled && selectedSession ? activeRunSessionId : null;
  useEffect(() => {
    if (!api || !id) { setOwned({ ownerSessionId: null, state: null }); return; }
    return subscribeSessionLiveSelection({ api, sessionId: id, select: (state) => state,
      onChange: (state) => setOwned({ ownerSessionId: id, state }) });
  }, [api, id]);
  return { selectedSessionLiveRun: id && owned.ownerSessionId === id ? owned.state : null };
}

type RunControls = ReturnType<typeof projectSessionRunControls>;
function useOwnerControls(api: WithMateWindowApi | null, id: string | null): RunControls {
  const [owned, setOwned] = useState<{ id: string | null; controls: RunControls }>({ id: null, controls: projectSessionRunControls(null) });
  useEffect(() => {
    if (!api || !id) { setOwned({ id: null, controls: projectSessionRunControls(null) }); return; }
    return subscribeSessionRunControls({ api, sessionId: id,
      onChange: (controls) => setOwned({ id, controls }) });
  }, [api, id]);
  return owned.id === id ? owned.controls : projectSessionRunControls(null);
}

/** Shell owns compact controls for Main and the active target, never full detail. */
export function useSessionRunControls(api: WithMateWindowApi | null, selectedSession: Session | null, activeRunSessionId: string | null) {
  const active = useOwnerControls(api, selectedSession ? activeRunSessionId : null);
  const main = useOwnerControls(api, selectedSession?.id ?? null);
  const getLiveRunRevision = useCallback(() => api ? getSessionLiveRevision(api) : 0, [api]);
  const setLiveRunState = useCallback((update: SetStateAction<OwnedLiveSessionRunState>) => {
    if (api && activeRunSessionId) updateSessionLiveState(api, activeRunSessionId, update);
  }, [api, activeRunSessionId]);
  const { cancellationState: _activeCancellationState, ...controls } = active;
  return { ...controls, getLiveRunRevision, setLiveRunState,
    hasSelectedSessionLiveRun: main.hasLiveRun, selectedSessionCancellationState: main.cancellationState };
}
