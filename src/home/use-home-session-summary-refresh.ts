import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import { getWithMateApi } from "../app/renderer-withmate-api.js";
import { startSessionSummaryInvalidationSubscription } from "../chat/runtime/session-summary-subscription.js";
import {
  buildHomeSessionQueryKey,
  type HomeSessionQueryGeneration,
} from "./home-session-query-generation.js";
import {
  fetchHomeSessionSummaryPages,
  listOpenSessionSummaryEntries,
} from "./home-session-summary-query.js";
import {
  createHomeSessionSummaryRefresher,
  type HomeSessionSummaryRefresher,
  type HomeSessionSummaryRefreshRequest,
} from "./home-session-summary-refresh.js";
import {
  applyHomeSessionSummaryPages,
  type HomeSessionSummariesState,
} from "./home-session-summaries-state.js";

/** ページを初めから取り直すか、読み込み済みの範囲まで更新するかの指定。 */
type HomeSessionSummaryRefreshMode = HomeSessionSummaryRefreshRequest["mode"];

/** 現在の検索と開いている Window の一覧、共有要約の状態と取得世代を受け取る。 */
type UseHomeSessionSummaryRefreshInput = {
  enabled: boolean;
  sessionSearchText: string;
  openSessionWindowIds: string[];
  sessionSummariesState: HomeSessionSummariesState;
  setSessionSummariesState: Dispatch<SetStateAction<HomeSessionSummariesState>>;
  sessionQueryGeneration: HomeSessionQueryGeneration;
};

/** 検索の変更と永続化側の無効化を分けて処理し、必要な要約だけを現行のクエリとして更新する。 */
export function useHomeSessionSummaryRefresh({
  enabled,
  sessionSearchText,
  openSessionWindowIds,
  sessionSummariesState,
  setSessionSummariesState,
  sessionQueryGeneration,
}: UseHomeSessionSummaryRefreshInput) {
  const sessionQueryKey = buildHomeSessionQueryKey(
    sessionSearchText,
    openSessionWindowIds,
  );
  const sessionSummaryRefresherRef = useRef<HomeSessionSummaryRefresher | null>(
    null,
  );
  const openSummaryQueryKey = JSON.stringify(openSessionWindowIds);
  const previousOpenSummaryQueryKeyRef = useRef(openSummaryQueryKey);
  const previousSessionSearchTextRef = useRef(sessionSearchText);
  const previousEnabledRef = useRef(enabled);
  const sessionRefreshModeRef =
    useRef<HomeSessionSummaryRefreshMode>("replace");
  const sessionRefreshInvalidationRef =
    useRef<SessionSummaryInvalidation | null>({ scope: "all" });

  useLayoutEffect(() => {
    const searchChanged =
      previousSessionSearchTextRef.current !== sessionSearchText;
    const openIdsChanged =
      previousOpenSummaryQueryKeyRef.current !== openSummaryQueryKey;
    sessionQueryGeneration.syncQueryKey(sessionQueryKey);
    if (searchChanged || openIdsChanged) {
      sessionSummaryRefresherRef.current?.invalidate(
        searchChanged ? "replace" : "preserve",
      );
    }
    if (openIdsChanged || previousEnabledRef.current !== enabled) {
      sessionRefreshInvalidationRef.current = { scope: "all" };
    }
    sessionRefreshModeRef.current = searchChanged ? "replace" : "preserve";
    previousSessionSearchTextRef.current = sessionSearchText;
    previousOpenSummaryQueryKeyRef.current = openSummaryQueryKey;
    previousEnabledRef.current = enabled;
    if (!enabled || !getWithMateApi()) {
      return;
    }
    if (searchChanged) {
      setSessionSummariesState((current) => ({
        ...current,
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
      setSessionSummariesState((current) => ({
        ...current,
        openStatus: "loading",
      }));
    }
  }, [
    enabled,
    openSummaryQueryKey,
    sessionQueryGeneration,
    sessionQueryKey,
    sessionSearchText,
    setSessionSummariesState,
  ]);

  /** 最近・ピン留めと、無効化対象の開いている Session・Character 利用情報を別々に反映する。 */
  const refreshBoundedSessionSummaries = async (
    { mode, invalidation }: HomeSessionSummaryRefreshRequest,
    isCurrent: () => boolean,
  ): Promise<void> => {
    const api = getWithMateApi();
    if (!api) {
      return;
    }

    const searchText = sessionSearchText;
    const refreshAllOpen =
      invalidation !== null &&
      (invalidation.scope === "all" ||
        sessionSummariesState.openStatus !== "loaded");
    const currentOpenSessionIds = refreshAllOpen
      ? openSessionWindowIds
      : openSessionWindowIds.filter(
          (id) =>
            invalidation?.scope === "ids" &&
            invalidation.sessionIds.includes(id),
        );
    const refreshOpen = refreshAllOpen || currentOpenSessionIds.length > 0;
    setSessionSummariesState((current) => ({
      ...current,
      recentStatus: "loading",
      pinnedStatus: "loading",
      ...(refreshOpen ? { openStatus: "loading" as const } : {}),
      ...(invalidation ? { characterUsageStatus: "loading" as const } : {}),
      loadingRecentPage: false,
      loadingPinnedPage: false,
    }));

    /** 一覧の範囲と置換方式に従って先頭から取得し、他の一覧の結果を保ったまま差し替える。 */
    const refreshPages = async (scope: "recent" | "pinned") => {
      const statusKey = scope === "recent" ? "recentStatus" : "pinnedStatus";
      const errorKey = scope === "recent" ? "recentError" : "pinnedError";
      const pageErrorKey =
        scope === "recent" ? "recentPageError" : "pinnedPageError";
      const loadedPages =
        scope === "recent"
          ? sessionSummariesState.recentPages
          : sessionSummariesState.pinnedPages;
      try {
        const pages = await fetchHomeSessionSummaryPages(
          api,
          scope,
          searchText,
          mode === "replace" ? 1 : loadedPages.length,
          isCurrent,
        );
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
          [errorKey]:
            error instanceof Error
              ? error.message
              : `Could not load ${scope} sessions.`,
        }));
      }
    };
    /** 必要な開いている ID の要約が揃った場合だけ、対象範囲を置き換える。 */
    const refreshOpenSummaries = async () => {
      if (!refreshOpen) return;
      try {
        const open = await listOpenSessionSummaryEntries(
          api,
          currentOpenSessionIds,
          isCurrent,
        );
        if (!isCurrent()) return;
        if (
          currentOpenSessionIds.some(
            (id) => !open.some((summary) => summary.id === id),
          )
        ) {
          throw new Error(
            "Could not identify all open session characters. Retry loading sessions.",
          );
        }
        setSessionSummariesState((current) => ({
          ...applyHomeSessionSummaryPages(current, {
            recent: current.recentPages,
            pinned: current.pinnedPages,
            open: refreshAllOpen
              ? open
              : [
                  ...current.openSummaries.filter(
                    (summary) => !currentOpenSessionIds.includes(summary.id),
                  ),
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
          openError:
            error instanceof Error
              ? error.message
              : "Could not load open sessions.",
        }));
      }
    };
    /** 検索ではなく保存情報が無効になった場合に、ランダムな Character 選択用の履歴を再取得する。 */
    const refreshCharacterUsage = async () => {
      if (!invalidation) return;
      try {
        const characterUsage = await api.listSessionCharacterUsage();
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({
          ...current,
          characterUsageStatus: "loaded",
          characterUsage,
        }));
      } catch {
        if (!isCurrent()) return;
        setSessionSummariesState((current) => ({
          ...current,
          characterUsageStatus: "error",
        }));
      }
    };
    await Promise.all([
      refreshPages("recent"),
      refreshPages("pinned"),
      refreshOpenSummaries(),
      refreshCharacterUsage(),
    ]);
  };
  const runSessionSummaryRefreshRef = useRef(refreshBoundedSessionSummaries);
  runSessionSummaryRefreshRef.current = refreshBoundedSessionSummaries;
  useEffect(() => {
    const refresher = createHomeSessionSummaryRefresher((request, isCurrent) =>
      runSessionSummaryRefreshRef.current(request, isCurrent),
    );
    sessionSummaryRefresherRef.current = refresher;
    return () => {
      refresher.dispose();
      sessionQueryGeneration.beginRequest();
      sessionSummaryRefresherRef.current = null;
    };
  }, [sessionQueryGeneration]);
  const refreshSessionSummaries = useCallback(
    (
      mode: HomeSessionSummaryRefreshMode = "preserve",
      invalidation: SessionSummaryInvalidation | null = { scope: "all" },
    ): Promise<void> => {
      sessionQueryGeneration.beginRequest();
      return (
        sessionSummaryRefresherRef.current?.refresh({ mode, invalidation }) ??
        Promise.resolve()
      );
    },
    [sessionQueryGeneration],
  );

  useEffect(() => {
    if (!enabled || !getWithMateApi()) {
      return;
    }

    /** 保留中の無効化範囲を一度だけ取り出し、現在の取得方式で読み直す。 */
    const refresh = () => {
      const invalidation = sessionRefreshInvalidationRef.current;
      sessionRefreshInvalidationRef.current = null;
      void refreshSessionSummaries(sessionRefreshModeRef.current, invalidation);
    };
    if (sessionRefreshModeRef.current === "replace") {
      refresh();
      return;
    }
    const timer = window.setTimeout(refresh, 120);
    return () => window.clearTimeout(timer);
  }, [
    enabled,
    openSessionWindowIds,
    refreshSessionSummaries,
    sessionSearchText,
  ]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    return startSessionSummaryInvalidationSubscription({
      api: getWithMateApi(),
      /** 保存情報の変更は、取得済みのページ数を維持する更新として渡す。 */
      onInvalidation: (payload) => {
        void refreshSessionSummaries("preserve", payload);
      },
    });
  }, [enabled, refreshSessionSummaries]);

  useEffect(() => {
    if (!enabled || !getWithMateApi()) {
      return;
    }

    /** Home に戻ったとき、既に閲覧していた範囲も含めて要約を更新する。 */
    const refreshOnFocus = () => {
      void refreshSessionSummaries("preserve");
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [enabled, refreshSessionSummaries]);

  return refreshSessionSummaries;
}
