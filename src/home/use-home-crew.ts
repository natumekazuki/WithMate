import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { HomeCrewPageResult } from "../../src-shared/window/home-crew-types.js";
import { OPEN_SESSION_WINDOW_IDS_PAGE_MAX } from "../../src-shared/window/withmate-window-types.js";

type CrewSnapshot = Pick<HomeCrewPageResult, "entries" | "auxiliarySessions">;
type HomeCrewReadApi = Pick<WithMateWindowApi,
  "listHomeCrewPage" | "subscribeLiveSessionRunStatus" | "subscribeSessionInvalidation" |
  "onSessionTurnUpdated" | "subscribeOpenSessionWindowIds">;
type CrewReadState = {
  snapshot: CrewSnapshot | null;
  pending: boolean;
  error: string;
};

/** Only return a complete snapshot of the current request. A superseded read has no result. */
async function loadCrewSnapshot(
  api: Pick<WithMateWindowApi, "listHomeCrewPage">,
  isCurrent: () => boolean,
): Promise<CrewSnapshot | null> {
  const entries = new Map<string, CrewSnapshot["entries"][number]>();
  const auxiliaries = new Map<string, CrewSnapshot["auxiliarySessions"][number]>();
  let cursor: string | null = null;
  while (isCurrent()) {
    const page: HomeCrewPageResult = await api.listHomeCrewPage({ cursor, limit: OPEN_SESSION_WINDOW_IDS_PAGE_MAX });
    if (!isCurrent()) return null;
    for (const member of page.entries) {
      const previous = entries.get(member.id);
      if (previous && previous.incarnationId !== member.incarnationId) {
        throw new Error("A session changed while its Crew was loading.");
      }
      entries.set(member.id, member);
    }
    for (const auxiliary of page.auxiliarySessions) auxiliaries.set(auxiliary.id, auxiliary);
    if (!page.hasMore) return { entries: [...entries.values()], auxiliarySessions: [...auxiliaries.values()] };
    // Within a Main snapshot the cursor is a fixed generation prefix followed by an ascending Session ID.
    if (!page.nextCursor || (cursor !== null && page.nextCursor <= cursor)) {
      throw new Error("Could not advance the Crew page.");
    }
    cursor = page.nextCursor;
  }
  return null;
}

export function useHomeCrew(api: HomeCrewReadApi | null, enabled: boolean) {
  const [state, setState] = useState<CrewReadState>({ snapshot: null, pending: true, error: "" });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!enabled || !api) return;
    let active = true;
    let inFlight = false;
    let scheduled = false;
    let generation = 0;

    const load = async () => {
      const requested = generation;
      const isCurrent = () => active && requested === generation;
      inFlight = true;
      setState((current) => current.pending ? current : { ...current, pending: true });
      try {
        const snapshot = await loadCrewSnapshot(api, isCurrent);
        if (isCurrent() && snapshot) setState({ snapshot, pending: false, error: "" });
      } catch (error) {
        if (isCurrent()) {
          const message = error instanceof Error && error.message ? error.message : "Could not load Crews.";
          setState((current) => ({ ...current, pending: false, error: message }));
        }
      } finally {
        inFlight = false;
        if (active && !isCurrent()) schedule();
      }
    };
    function schedule() {
      if (inFlight || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) void load();
      });
    }
    const invalidate = () => {
      generation += 1;
      schedule();
    };

    refreshRef.current = invalidate;
    const liveStates = new Map<string, string>();
    const unsubscribeLive = api.subscribeLiveSessionRunStatus((id, status) => {
      const key = JSON.stringify([status?.runState, status?.cancellationState, status?.approvalPending]);
      if (liveStates.get(id) === key) return;
      liveStates.set(id, key);
      invalidate();
    });
    const unsubscribeSession = api.subscribeSessionInvalidation(invalidate);
    const unsubscribeTurn = api.onSessionTurnUpdated(invalidate);
    const unsubscribeWindows = api.subscribeOpenSessionWindowIds(invalidate);
    window.addEventListener("focus", invalidate);
    invalidate();
    return () => {
      active = false;
      refreshRef.current = () => {};
      unsubscribeLive();
      unsubscribeSession();
      unsubscribeTurn();
      unsubscribeWindows();
      window.removeEventListener("focus", invalidate);
    };
  }, [api, enabled]);

  return { ...state, refresh };
}
