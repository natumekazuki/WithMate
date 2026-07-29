import type { AuxiliarySessionSummary } from "../auxiliary-session-state.js";

export type HomeActiveAuxiliarySessionRefresherInput = {
  fetchActiveAuxiliarySessions: () => Promise<AuxiliarySessionSummary[]>;
  setActiveAuxiliarySessions: (sessions: AuxiliarySessionSummary[]) => void;
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
    void fetchActiveAuxiliarySessions().then((sessions) => {
      if (!active) {
        return;
      }
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
