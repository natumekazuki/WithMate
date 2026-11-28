import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import {
  buildOpenSessionWindowIdsPage,
  type SessionMonitorPageRequest,
  type SessionMonitorPageResult,
} from "../../src-shared/window/withmate-window-types.js";

/** モニター対象をページ化し、Main と Auxiliary の保存済み要約に現在の注意状態を加えて返す。 */
export async function readSessionMonitorPage(
  deps: {
    /** モニターに載せる Main の Session ID を現在の並び順で取得する。 */
    listMonitorSessionIds(): string[];
    /** このページに属する Main の保存済み要約を取得する。 */
    readSummaries(sessionIds: string[]): Promise<HomeSessionSummary[]>;
    /** このページの Main に所属する Auxiliary の保存済み要約を取得する。 */
    readAuxiliarySummaries(
      sessionIds: string[],
    ): Promise<AuxiliarySessionSummary[]>;
    /** 指定 Session の実行状態を取得し、ライブ表示に使えるものがなければ null を返す。 */
    getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
    /** 指定 Session について、まだ読まれていない結果があるか確認する。 */
    hasUnreadResult(sessionId: string): boolean;
  },
  request?: SessionMonitorPageRequest | null,
): Promise<SessionMonitorPageResult> {
  const page = buildOpenSessionWindowIdsPage(
    deps.listMonitorSessionIds(),
    request,
  );
  const [summaries, auxiliaries] = await Promise.all([
    deps.readSummaries(page.sessionIds),
    deps.readAuxiliarySummaries(page.sessionIds),
  ]);
  /** 保存済み要約を変えず、停止状態・承認待ち・未読の表示情報を追加する。 */
  const withLiveStatus = <T extends { id: string }>(summary: T) => {
    const status = projectLiveSessionRunStatus(
      deps.getLiveSessionRun(summary.id),
    );
    return {
      ...summary,
      cancellationState: status?.cancellationState,
      approvalPending: status?.approvalPending ?? false,
      hasUnreadResult: deps.hasUnreadResult(summary.id),
    };
  };
  return {
    entries: summaries.map(withLiveStatus),
    auxiliarySessions: auxiliaries.map(withLiveStatus),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
