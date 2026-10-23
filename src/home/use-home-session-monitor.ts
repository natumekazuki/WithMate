import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { LiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";

type HomeSessionMonitorSnapshot = {
  entries: HomeSessionSummary[];
  auxiliarySessions: AuxiliarySessionSummary[];
};

export async function fetchHomeSessionMonitorSnapshot(
  api: Pick<WithMateWindowApi, "listSessionMonitorPage">,
  isCurrent: () => boolean,
): Promise<HomeSessionMonitorSnapshot> {
  const entries = new Map<string, HomeSessionSummary>();
  const auxiliarySessions = new Map<string, AuxiliarySessionSummary>();
  let cursor: string | null = null;
  do {
    const page = await api.listSessionMonitorPage({ cursor, limit: 100 });
    if (!isCurrent()) break;
    for (const entry of page.entries) entries.set(entry.id, entry);
    for (const entry of page.auxiliarySessions) auxiliarySessions.set(entry.id, entry);
    if (!page.hasMore) break;
    if (!page.nextCursor || (cursor !== null && page.nextCursor <= cursor)) {
      throw new Error("Could not advance the Session Monitor page.");
    }
    cursor = page.nextCursor;
  } while (isCurrent());
  return { entries: [...entries.values()], auxiliarySessions: [...auxiliarySessions.values()] };
}

export function useHomeSessionMonitor(enabled: boolean, openSessionWindowIds: readonly string[]) {
  const [snapshot, setSnapshot] = useState<HomeSessionMonitorSnapshot>({ entries: [], auxiliarySessions: [] });
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [feedback, setFeedback] = useState("");
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!enabled) return;
    const api = getWithMateApi();
    if (!api) {
      setStatus("loaded");
      return;
    }
    let active = true;
    let generation = 0;
    let inFlight = false;
    let hasLoaded = false;
    const load = async () => {
      if (!active) return;
      const requestGeneration = ++generation;
      if (inFlight) return;
      inFlight = true;
      const isCurrent = () => active && generation === requestGeneration;
      if (!hasLoaded) setStatus("loading");
      try {
        const next = await fetchHomeSessionMonitorSnapshot(api, isCurrent);
        if (!isCurrent()) return;
        setSnapshot(next);
        hasLoaded = true;
        setStatus("loaded");
        setFeedback("");
      } catch (error) {
        if (!isCurrent()) return;
        setStatus("error");
        setFeedback(error instanceof Error ? error.message : "Could not load Session Monitor.");
      } finally {
        inFlight = false;
        if (active && generation !== requestGeneration) void load();
      }
    };
    refreshRef.current = () => { void load(); };
    const liveStates = new Map<string, LiveSessionRunStatus>();
    const unsubscribeLive = api.subscribeLiveSessionRunStatus((sessionId, state) => {
      const next = { runState: state?.runState, cancellationState: state?.cancellationState, approvalPending: state?.approvalPending };
      const previous = liveStates.get(sessionId);
      if (previous && previous.runState === next.runState
        && previous.cancellationState === next.cancellationState
        && previous.approvalPending === next.approvalPending) return;
      liveStates.set(sessionId, next);
      refresh();
    });
    const unsubscribeSession = api.subscribeSessionInvalidation(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      refreshRef.current = () => {};
      unsubscribeLive();
      unsubscribeSession();
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, refresh]);

  const openIdsKey = JSON.stringify(openSessionWindowIds);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, openIdsKey, refresh]);

  return { ...snapshot, status, feedback, refresh };
}
