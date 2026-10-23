import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";

export type HomeAuxiliarySessionRefresherInput = {
  fetchAuxiliarySessionSummaries: () => Promise<AuxiliarySessionSummary[]>;
  setAuxiliarySessionSummaries: (sessions: AuxiliarySessionSummary[]) => void;
  onLoadState?: (state: "loading" | "ready" | "error") => void;
  onRefreshingChange?: (refreshing: boolean) => void;
  onError?: (error: unknown) => void;
};

export type HomeAuxiliarySessionRefresher = {
  refresh(): void;
  retry(): void;
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
  onRefreshingChange,
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
    onRefreshingChange?.(true);
    if (lastAppliedSessions === null) {
      onLoadState?.("loading");
    }
    void fetchAuxiliarySessionSummaries().then((sessions) => {
      if (!active || refreshRequestedWhileInFlight) {
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
      if (!active || refreshRequestedWhileInFlight) {
        return;
      }
      onLoadState?.("error");
      onError?.(error);
    }).finally(() => {
      refreshInFlight = false;
      if (active && refreshRequestedWhileInFlight) {
        refresh();
      } else if (active) {
        onRefreshingChange?.(false);
      }
    });
  };

  return {
    refresh,
    retry() {
      if (!refreshInFlight) refresh();
    },
    dispose() {
      active = false;
    },
  };
}
