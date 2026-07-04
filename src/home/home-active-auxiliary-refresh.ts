import type { AuxiliarySessionSummary } from "../auxiliary-session-state.js";

export type HomeActiveAuxiliarySessionRefresherInput = {
  getMonitorParentSessionIds: () => string[];
  fetchActiveAuxiliarySessions: (parentSessionIds: string[]) => Promise<AuxiliarySessionSummary[]>;
  setActiveAuxiliarySessions: (sessions: AuxiliarySessionSummary[]) => void;
  onError?: (error: unknown) => void;
};

export type HomeActiveAuxiliarySessionRefresher = {
  refresh(): void;
  dispose(): void;
};

export function createHomeActiveAuxiliarySessionRefresher({
  getMonitorParentSessionIds,
  fetchActiveAuxiliarySessions,
  setActiveAuxiliarySessions,
  onError,
}: HomeActiveAuxiliarySessionRefresherInput): HomeActiveAuxiliarySessionRefresher {
  let active = true;
  let refreshInFlight = false;
  let refreshRequestedWhileInFlight = false;

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
    const monitorParentSessionIds = getMonitorParentSessionIds();
    void fetchActiveAuxiliarySessions(monitorParentSessionIds).then((sessions) => {
      if (!active) {
        return;
      }
      setActiveAuxiliarySessions(sessions);
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
