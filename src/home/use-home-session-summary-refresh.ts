import { useCallback, useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { startSessionSummaryInvalidationSubscription } from "../chat/runtime/session-summary-subscription.js";
import { buildHomeSessionQueryKey, type HomeSessionQueryGeneration } from "./home-session-query-generation.js";
import { fetchHomeSessionSummaryPages, listOpenSessionSummaryEntries } from "./home-session-summary-query.js";
import {
  createHomeSessionSummaryRefresher,
  type HomeSessionSummaryRefresher,
  type HomeSessionSummaryRefreshRequest,
} from "./home-session-summary-refresh.js";
import { applyHomeSessionSummaryPages, type HomeSessionSummariesState } from "./home-session-summaries-state.js";

type HomeSessionSummaryRefreshMode = HomeSessionSummaryRefreshRequest["mode"];

type UseHomeSessionSummaryRefreshInput = {
  enabled: boolean;
  sessionSearchText: string;
  openSessionWindowIds: string[];
  sessionSummariesState: HomeSessionSummariesState;
  setSessionSummariesState: Dispatch<SetStateAction<HomeSessionSummariesState>>;
  sessionQueryGeneration: HomeSessionQueryGeneration;
};

export function useHomeSessionSummaryRefresh({
  enabled,
  sessionSearchText,
  openSessionWindowIds,
  sessionSummariesState,
  setSessionSummariesState,
  sessionQueryGeneration,
}: UseHomeSessionSummaryRefreshInput) {
  const sessionQueryKey = buildHomeSessionQueryKey(sessionSearchText, openSessionWindowIds);
  const sessionSummaryRefresherRef = useRef<HomeSessionSummaryRefresher | null>(null);
  const openSummaryQueryKey = JSON.stringify(openSessionWindowIds);
  const previousOpenSummaryQueryKeyRef = useRef(openSummaryQueryKey);
  const previousSessionSearchTextRef = useRef(sessionSearchText);
  const sessionRefreshModeRef = useRef<HomeSessionSummaryRefreshMode>("replace");

  useLayoutEffect(() => {
    const searchChanged = previousSessionSearchTextRef.current !== sessionSearchText;
    const openIdsChanged = previousOpenSummaryQueryKeyRef.current !== openSummaryQueryKey;
    sessionQueryGeneration.syncQueryKey(sessionQueryKey);
    if (searchChanged || openIdsChanged) sessionSummaryRefresherRef.current?.invalidate();
    sessionRefreshModeRef.current = searchChanged ? "replace" : "preserve";
    previousSessionSearchTextRef.current = sessionSearchText;
    previousOpenSummaryQueryKeyRef.current = openSummaryQueryKey;
    if (!enabled || !getWithMateApi()) {
      return;
    }
    if (searchChanged) {
      setSessionSummariesState((current) => ({
        ...current,
        ...applyHomeSessionSummaryPages(current, { recent: [], pinned: [], open: current.openSummaries }),
        recentStatus: "loading",
        pinnedStatus: "loading",
        recentError: "",
        pinnedError: "",
        recentPageError: "",
        pinnedPageError: "",
        loadingRecentPage: false,
        loadingPinnedPage: false,
      }));
    }
    if (openIdsChanged) {
      setSessionSummariesState((current) => ({ ...current, openStatus: "loading" }));
    }
  }, [enabled, openSummaryQueryKey, sessionQueryGeneration, sessionQueryKey, sessionSearchText, setSessionSummariesState]);

  const refreshBoundedSessionSummaries = async (
    { mode, invalidation }: HomeSessionSummaryRefreshRequest,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const api = getWithMateApi();
    if (!api) {
      return;
    }

    const searchText = sessionSearchText;
    const refreshAllOpen = invalidation.scope === "all" || sessionSummariesState.openStatus !== "loaded";
    const currentOpenSessionIds = refreshAllOpen
      ? openSessionWindowIds
      : openSessionWindowIds.filter((id) => invalidation.sessionIds.includes(id));
    const refreshOpen = refreshAllOpen || currentOpenSessionIds.length > 0;
    setSessionSummariesState((current) => ({
      ...(mode === "replace"
        ? applyHomeSessionSummaryPages(current, { recent: [], pinned: [], open: current.openSummaries })
        : current),
      recentStatus: "loading",
      pinnedStatus: "loading",
      ...(refreshOpen ? { openStatus: "loading" as const } : {}),
      characterUsageStatus: "loading",
      loadingRecentPage: false,
      loadingPinnedPage: false,
    }));

    const refreshPages = async (scope: "recent" | "pinned") => {
      const statusKey = scope === "recent" ? "recentStatus" : "pinnedStatus";
      const errorKey = scope === "recent" ? "recentError" : "pinnedError";
      const pageErrorKey = scope === "recent" ? "recentPageError" : "pinnedPageError";
      const loadedPages = scope === "recent" ? sessionSummariesState.recentPages : sessionSummariesState.pinnedPages;
      try {
        const pages = await fetchHomeSessionSummaryPages(api, scope, searchText, mode === "replace" ? 1 : loadedPages.length, isCurrent);
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({
          ...applyHomeSessionSummaryPages(current, {
            recent: scope === "recent" ? pages : current.recentPages,
            pinned: scope === "pinned" ? pages : current.pinnedPages,
            open: current.openSummaries,
          }),
          [statusKey]: "loaded",
          [errorKey]: "",
          [pageErrorKey]: "",
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({
          ...current,
          [statusKey]: "error",
          [errorKey]: error instanceof Error ? error.message : `Could not load ${scope} sessions.`,
        }));
      }
    };
    const refreshOpenSummaries = async () => {
      if (!refreshOpen) return;
      try {
        const open = await listOpenSessionSummaryEntries(api, currentOpenSessionIds, isCurrent);
        if (!isCurrent()) return;
        if (currentOpenSessionIds.some((id) => !open.some((summary) => summary.id === id))) {
          throw new Error("Could not identify all open session characters. Retry loading sessions.");
        }
        setSessionSummariesState((current) => ({
          ...applyHomeSessionSummaryPages(current, {
            recent: current.recentPages, pinned: current.pinnedPages,
            open: refreshAllOpen ? open : [
              ...current.openSummaries.filter((summary) => !currentOpenSessionIds.includes(summary.id)),
              ...open,
            ],
          }),
          openStatus: "loaded",
          openError: "",
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({
          ...current,
          openStatus: "error",
          openError: error instanceof Error ? error.message : "Could not load open sessions.",
        }));
      }
    };
    const refreshCharacterUsage = async () => {
      try {
        const characterUsage = await api.listSessionCharacterUsage();
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({ ...current, characterUsageStatus: "loaded", characterUsage }));
      } catch {
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({ ...current, characterUsageStatus: "error" }));
      }
    };
    await Promise.all([refreshPages("recent"), refreshPages("pinned"), refreshOpenSummaries(), refreshCharacterUsage()]);
  };
  const runSessionSummaryRefreshRef = useRef(refreshBoundedSessionSummaries);
  runSessionSummaryRefreshRef.current = refreshBoundedSessionSummaries;
  useEffect(() => {
    const refresher = createHomeSessionSummaryRefresher((request, isCurrent) => (
      runSessionSummaryRefreshRef.current(request, isCurrent)
    ));
    sessionSummaryRefresherRef.current = refresher;
    return () => {
      refresher.dispose();
      sessionQueryGeneration.beginRequest();
      sessionSummaryRefresherRef.current = null;
    };
  }, [sessionQueryGeneration]);
  const refreshSessionSummaries = useCallback((
    mode: HomeSessionSummaryRefreshMode = "preserve",
    invalidation: SessionSummaryInvalidation = { scope: "all" },
  ): Promise<void> => {
    sessionQueryGeneration.beginRequest();
    return sessionSummaryRefresherRef.current?.refresh({ mode, invalidation }) ?? Promise.resolve();
  }, [sessionQueryGeneration]);

  useEffect(() => {
    if (!enabled || !getWithMateApi()) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshSessionSummaries(sessionRefreshModeRef.current);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [enabled, openSessionWindowIds, refreshSessionSummaries, sessionSearchText]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    return startSessionSummaryInvalidationSubscription({
      api: getWithMateApi(),
      onInvalidation: (payload) => {
        void refreshSessionSummaries("preserve", payload);
      },
    });
  }, [enabled, refreshSessionSummaries]);

  useEffect(() => {
    if (!enabled || !getWithMateApi()) {
      return;
    }

    const refreshOnFocus = () => {
      void refreshSessionSummaries("preserve");
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [enabled, refreshSessionSummaries]);

  return refreshSessionSummaries;
}
