import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";

/** 対象の Session が一覧内にある場合だけ、保存済みのピン状態を取り込む。他の値や順序は保つ。 */
export function mergePinnedSessionSummary(
  summaries: readonly HomeSessionSummary[],
  saved: HomeSessionSummary,
): HomeSessionSummary[] {
  return summaries.map((session) =>
    session.id === saved.id
      ? { ...session, isPinned: saved.isPinned }
      : session,
  );
}
