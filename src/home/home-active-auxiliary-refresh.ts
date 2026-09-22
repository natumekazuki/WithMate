import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";

export type HomeAuxiliarySessionRefresherInput = {
  fetchAuxiliarySessionSummaries: () => Promise<AuxiliarySessionSummary[]>;
  setAuxiliarySessionSummaries: (sessions: AuxiliarySessionSummary[]) => void;
  onLoadState?: (state: "loading" | "ready" | "error") => void;
  onError?: (error: unknown) => void;
};

export type HomeAuxiliarySessionRefresher = {
  refresh(): void;
  dispose(): void;
};

export function resolveHomeAuxiliarySessionSummariesState(
  current: AuxiliarySessionSummary[],
  next: AuxiliarySessionSummary[],
): AuxiliarySessionSummary[] {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

export function createHomeAuxiliarySessionRefresher({
  fetchAuxiliarySessionSummaries,
  setAuxiliarySessionSummaries,
  onLoadState,
  onError,
}: HomeAuxiliarySessionRefresherInput): HomeAuxiliarySessionRefresher {
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
    void fetchAuxiliarySessionSummaries().then((sessions) => {
      if (!active) {
        return;
      }
      onLoadState?.("ready");
      if (
        lastAppliedSessions
        && resolveHomeAuxiliarySessionSummariesState(lastAppliedSessions, sessions) === lastAppliedSessions
      ) {
        return;
      }
      setAuxiliarySessionSummaries(sessions);
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
