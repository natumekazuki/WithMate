import { useCallback, useEffect, useRef, useState } from "react";
import type { WithMateWindowApi } from "../../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnRecord } from "../../../src-shared/session/session-turn-state.js";

export type LatestSessionTurnApi = Pick<WithMateWindowApi, "getLatestSessionTurn" | "onSessionTurnUpdated">;

export function useLatestSessionTurn(api: LatestSessionTurnApi | null, sessionId: string | null, scope: string | null, revision?: string) {
  const key = sessionId && scope ? `${scope}:${sessionId}` : null;
  const [retryRevision, setRetryRevision] = useState(0);
  const requestRevision = useRef(0);
  const retry = useCallback(() => setRetryRevision((value) => value + 1), []);
  const [state, setState] = useState<{ key: string | null; turn: SessionTurnRecord | null; loading: boolean; error: string | null; revision: number }>({ key: null, turn: null, loading: false, error: null, revision: 0 });
  useEffect(() => {
    if (!api || !sessionId || !key) {
      setState({ key: null, turn: null, loading: false, error: null, revision: 0 });
      return;
    }
    let active = true;
    const refresh = () => {
      const current = ++requestRevision.current;
      setState((previous) => ({ key, turn: previous.key === key ? previous.turn : null, loading: true, error: null, revision: current }));
      void api.getLatestSessionTurn(sessionId).then((turn) => {
        if (!active || current !== requestRevision.current) return;
        if (turn && turn.sessionId !== sessionId) throw new Error("The execution record belongs to another conversation.");
        setState({ key, turn, loading: false, error: null, revision: current });
      }).catch((error: unknown) => {
        if (active && current === requestRevision.current) setState((previous) => ({ key, turn: previous.key === key ? previous.turn : null, loading: false, error: error instanceof Error ? error.message : "Could not load the latest execution.", revision: current }));
      });
    };
    const unsubscribe = api.onSessionTurnUpdated((id) => { if (id === sessionId) refresh(); });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [api, key, sessionId, revision, retryRevision]);
  return { ...(api && state.key === key && key ? state : { key, turn: null, loading: !!api && !!key, error: null, revision: 0 }), retry };
}
