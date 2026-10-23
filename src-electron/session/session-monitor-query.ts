import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { HomeSessionSummary } from "../../src-shared/session/session-state.js";
import { buildOpenSessionWindowIdsPage, type SessionMonitorPageRequest, type SessionMonitorPageResult } from "../../src-shared/window/withmate-window-types.js";

export async function readSessionMonitorPage(deps: {
  listMonitorSessionIds(): string[];
  readSummaries(sessionIds: string[]): Promise<HomeSessionSummary[]>;
  readAuxiliarySummaries(sessionIds: string[]): Promise<AuxiliarySessionSummary[]>;
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
}, request?: SessionMonitorPageRequest | null): Promise<SessionMonitorPageResult> {
  const page = buildOpenSessionWindowIdsPage(deps.listMonitorSessionIds(), request);
  const [summaries, auxiliaries] = await Promise.all([
    deps.readSummaries(page.sessionIds),
    deps.readAuxiliarySummaries(page.sessionIds),
  ]);
  const withLiveStatus = <T extends { id: string }>(summary: T) => {
    const status = projectLiveSessionRunStatus(deps.getLiveSessionRun(summary.id));
    return { ...summary, cancellationState: status?.cancellationState, approvalPending: status?.approvalPending ?? false };
  };
  return {
    entries: summaries.map(withLiveStatus),
    auxiliarySessions: auxiliaries.map(withLiveStatus),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
