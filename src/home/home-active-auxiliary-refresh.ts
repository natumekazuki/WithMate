import type { AuxiliarySessionSummary } from "../auxiliary-session-state.js";

export type HomeActiveAuxiliarySessionRefresherInput = {
  fetchActiveAuxiliarySessions: () => Promise<AuxiliarySessionSummary[]>;
  setActiveAuxiliarySessions: (sessions: AuxiliarySessionSummary[]) => void;
  onLoadState?: (state: "loading" | "ready" | "error") => void;
  onError?: (error: unknown) => void;
};

export type HomeActiveAuxiliarySessionRefresher = {
  refresh(): void;
  dispose(): void;
};

export function resolveHomeActiveAuxiliarySessionsState(
  current: AuxiliarySessionSummary[],
  next: AuxiliarySessionSummary[],
): AuxiliarySessionSummary[] {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

export function createHomeActiveAuxiliarySessionRefresher({
  fetchActiveAuxiliarySessions,
  setActiveAuxiliarySessions,
  onLoadState,
  onError,
}: HomeActiveAuxiliarySessionRefresherInput): HomeActiveAuxiliarySessionRefresher {
  let active = true;
  let refreshInFlight = false;
  let refreshRequestedWhileInFlight = false;
  let lastAppliedSessions: AuxiliarySessionSummary[] | null = null;

  const refresh = () => {
    if (!active) {
      return;
    }
    if (refreshInFlight) {
      refreshRequestedWhileInFlight = true;
      return;
    }

    refreshInFlight = true;
    refreshRequestedWhileInFlight = false;
    if (lastAppliedSessions === null) {
      onLoadState?.("loading");
    }
    void fetchActiveAuxiliarySessions().then((sessions) => {
      if (!active) {
        return;
      }
      onLoadState?.("ready");
      if (
        lastAppliedSessions
        && resolveHomeActiveAuxiliarySessionsState(lastAppliedSessions, sessions) === lastAppliedSessions
      ) {
        return;
      }
      setActiveAuxiliarySessions(sessions);
      lastAppliedSessions = sessions;
    }).catch((error) => {
      if (!active) {
        return;
      }
      onLoadState?.("error");
      onError?.(error);
    }).finally(() => {
      refreshInFlight = false;
      if (active && refreshRequestedWhileInFlight) {
        refresh();
      }
    });
  };

  return {
    refresh,
    dispose() {
      active = false;
    },
  };
}
