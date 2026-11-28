import type { SessionSummaryInvalidation } from "../../src-shared/session/session-state.js";
import { HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE } from "./home-session-summary-query.js";

/** 読み込み済みの範囲を作り直すか維持するかと、検索以外に無効になった要約の範囲。 */
export type HomeSessionSummaryRefreshRequest = {
  mode: "replace" | "preserve";
  // 検索だけの変更では、検索に依存するRecent/Pinnedのみを更新する。
  invalidation: SessionSummaryInvalidation | null;
};

/** 重複する要約の読み取りをまとめ、現行の更新だけを反映するための制御口。 */
export type HomeSessionSummaryRefresher = {
  /** 新しい更新要求を取り込み、処理中ならその後にまとめて実行する。 */
  refresh(request: HomeSessionSummaryRefreshRequest): Promise<void>;
  /** 現在の取得を無効にし、処理中だった要求を必要なら待機へ戻す。 */
  invalidate(mode?: HomeSessionSummaryRefreshRequest["mode"]): void;
  /** 今後の要求を受け付けず、保留中の更新と処理中の結果を破棄する。 */
  dispose(): void;
};

/** 強い置換条件と無効化範囲を合わせ、個別 ID の集合が上限を超えると全体を対象にする。 */
function mergeRequests(
  pending: HomeSessionSummaryRefreshRequest | null,
  next: HomeSessionSummaryRefreshRequest,
): HomeSessionSummaryRefreshRequest {
  const mode =
    pending?.mode === "replace" || next.mode === "replace"
      ? "replace"
      : "preserve";
  if (!pending?.invalidation) return { mode, invalidation: next.invalidation };
  if (!next.invalidation) return { mode, invalidation: pending.invalidation };
  if (
    pending?.invalidation.scope === "all" ||
    next.invalidation.scope === "all"
  ) {
    return { mode, invalidation: { scope: "all" } };
  }
  const sessionIds = new Set<string>();
  for (const ids of [
    pending?.invalidation.sessionIds ?? [],
    next.invalidation.sessionIds,
  ]) {
    for (const id of ids) {
      sessionIds.add(id);
      if (sessionIds.size > HOME_SESSION_SUMMARY_OPEN_ID_CHUNK_SIZE) {
        return { mode, invalidation: { scope: "all" } };
      }
    }
  }
  return { mode, invalidation: { scope: "ids", sessionIds: [...sessionIds] } };
}

/** 更新を常に直列に実行し、後から要求が来た場合は先の応答を無効にして合流した条件で再実行する。 */
export function createHomeSessionSummaryRefresher(
  run: (
    request: HomeSessionSummaryRefreshRequest,
    isCurrent: () => boolean,
  ) => Promise<void>,
): HomeSessionSummaryRefresher {
  let active = true;
  let generation = 0;
  let pending: HomeSessionSummaryRefreshRequest | null = null;
  let running: HomeSessionSummaryRefreshRequest | null = null;
  let inFlight: Promise<void> | null = null;

  /** 蓄積した更新を順に実行し、終了処理中に新たな要求が残った場合も取りこぼさない。 */
  const drain = (): Promise<void> => {
    inFlight = Promise.resolve()
      .then(async () => {
        while (active && pending) {
          const request = pending;
          const requestGeneration = generation;
          pending = null;
          running = request;
          try {
            await run(
              request,
              () => active && generation === requestGeneration,
            );
          } finally {
            running = null;
          }
        }
      })
      .finally(() => {
        inFlight = null;
        if (active && pending) return drain();
      });
    return inFlight;
  };

  return {
    /** 現行世代を進め、待機中または処理中の条件に要求を統合する。 */
    refresh(request) {
      if (!active) return Promise.resolve();
      generation += 1;
      pending = mergeRequests(pending ?? running, request);
      return inFlight ?? drain();
    },
    /** 現行の結果を無効にし、実行中の対象を次回の再取得に含める。 */
    invalidate(mode = "preserve") {
      generation += 1;
      if (running) pending = mergeRequests(pending, running);
      if (pending && mode === "replace") pending = { ...pending, mode };
    },
    /** 保留を捨て、既に始まった実行が現行とみなされないようにする。 */
    dispose() {
      active = false;
      generation += 1;
      pending = null;
    },
  };
}
