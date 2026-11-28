import type {
  Session,
  SessionSummary,
} from "../../src-shared/session/session-state.js";

/** 要約から完全な Session を復元するために、一覧と個別の保存データを読み取れる境界。 */
type SessionSummaryHydrationSource = {
  /** 読み込み対象の Session 要約を順序付きで返す。 */
  listSessionSummaries(): SessionSummary[];
  /** ID に対応する完全な Session を返す。読み込み時点で存在しなければ null。 */
  getSession(sessionId: string): Session | null;
};

/** 履歴を読まず表示に使える形にするため、メッセージ・ストリームを空、実行時キャラクター定義を null として補う。 */
export function sessionSummaryToSession(summary: SessionSummary): Session {
  return {
    ...summary,
    characterRuntimeSnapshot: null,
    messages: [],
    stream: [],
  };
}

/** 要約を元の順序のまま、履歴を持たない Session の形へ変換する。 */
export function sessionSummariesToSessions(
  summaries: SessionSummary[],
): Session[] {
  return summaries.map(sessionSummaryToSession);
}

/** 要約の順に保存済みの詳細を取り出し、途中で存在しなくなった Session を除く。 */
export function hydrateSessionsFromSummaries(
  source: SessionSummaryHydrationSource,
): Session[] {
  return source
    .listSessionSummaries()
    .map((summary) => source.getSession(summary.id))
    .filter((session): session is Session => session !== null);
}
