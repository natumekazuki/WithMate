import { useCallback, useEffect, useRef, useState } from "react";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { HomeCrewPageResult } from "../../src-shared/window/home-crew-types.js";
import { OPEN_SESSION_WINDOW_IDS_PAGE_MAX } from "../../src-shared/window/withmate-window-types.js";

/** 同一取得世代の全ページから揃えた Main と Auxiliary の要約。 */
type CrewSnapshot = Pick<HomeCrewPageResult, "entries" | "auxiliarySessions">;
/** Home の Crew ページを読み、構成や状態を変え得る通知を購読する API。 */
type HomeCrewReadApi = Pick<
  WithMateWindowApi,
  | "listHomeCrewPage"
  | "subscribeLiveSessionRunStatus"
  | "subscribeSessionInvalidation"
  | "onSessionTurnUpdated"
  | "subscribeOpenSessionWindowIds"
>;
/** 最後に揃った一覧を、新しい取得の進捗や失敗とは独立して保持する。 */
type CrewReadState = {
  snapshot: CrewSnapshot | null;
  pending: boolean;
  error: string;
};

/** 現在のリクエストの完全なスナップショットだけを返す。後続の取得に置き換えられた読み取りは結果を返さない。 */
async function loadCrewSnapshot(
  api: Pick<WithMateWindowApi, "listHomeCrewPage">,
  isCurrent: () => boolean,
): Promise<CrewSnapshot | null> {
  const entries = new Map<string, CrewSnapshot["entries"][number]>();
  const auxiliaries = new Map<
    string,
    CrewSnapshot["auxiliarySessions"][number]
  >();
  let cursor: string | null = null;
  while (isCurrent()) {
    const page: HomeCrewPageResult = await api.listHomeCrewPage({
      cursor,
      limit: OPEN_SESSION_WINDOW_IDS_PAGE_MAX,
    });
    if (!isCurrent()) return null;
    for (const member of page.entries) {
      const previous = entries.get(member.id);
      if (previous && previous.incarnationId !== member.incarnationId) {
        throw new Error("A session changed while its Crew was loading.");
      }
      entries.set(member.id, member);
    }
    for (const auxiliary of page.auxiliarySessions)
      auxiliaries.set(auxiliary.id, auxiliary);
    if (!page.hasMore)
      return {
        entries: [...entries.values()],
        auxiliarySessions: [...auxiliaries.values()],
      };
    // 一つの Main スナップショット内では、カーソルは固定の世代接頭辞に続けて昇順の Session ID を持つ。
    if (!page.nextCursor || (cursor !== null && page.nextCursor <= cursor)) {
      throw new Error("Could not advance the Crew page.");
    }
    cursor = page.nextCursor;
  }
  return null;
}

/** Crew の構成や状態の通知をまとめて再取得し、完全な現在世代の一覧だけで表示を置き換える。 */
export function useHomeCrew(api: HomeCrewReadApi | null, enabled: boolean) {
  const [state, setState] = useState<CrewReadState>({
    snapshot: null,
    pending: true,
    error: "",
  });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    if (!enabled || !api) return;
    let active = true;
    let inFlight = false;
    let scheduled = false;
    let generation = 0;

    /** 今の世代を固定して先頭から全ページを読み、追い越された場合は結果を出さず読み直す。 */
    const load = async () => {
      const requested = generation;
      /** 購読を終了したり更新通知で世代が進んだりしたら、途中の取得を無効にする。 */
      const isCurrent = () => active && requested === generation;
      inFlight = true;
      setState((current) =>
        current.pending ? current : { ...current, pending: true },
      );
      try {
        const snapshot = await loadCrewSnapshot(api, isCurrent);
        if (isCurrent() && snapshot)
          setState({ snapshot, pending: false, error: "" });
      } catch (error) {
        if (isCurrent()) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : "Could not load Crews.";
          setState((current) => ({
            ...current,
            pending: false,
            error: message,
          }));
        }
      } finally {
        inFlight = false;
        if (active && !isCurrent()) schedule();
      }
    };
    /** 取得中または予約済みなら重複させず、同じ処理周期の通知を一つの取得にまとめる。 */
    function schedule() {
      if (inFlight || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) void load();
      });
    }
    /** 現在の取得世代を無効化して、最新状態の取得を予約する。 */
    const invalidate = () => {
      generation += 1;
      schedule();
    };

    refreshRef.current = invalidate;
    const liveStates = new Map<string, string>();
    const unsubscribeLive = api.subscribeLiveSessionRunStatus((id, status) => {
      const key = JSON.stringify([
        status?.runState,
        status?.cancellationState,
        status?.approvalPending,
      ]);
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
