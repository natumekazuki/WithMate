import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type { HomeCrewMember, HomeCrewPageResult } from "../../src-shared/window/home-crew-types.js";
import { parseOpenSessionWindowIdsPageRequest } from "../../src-shared/window/withmate-window-types.js";

export type OpenCrewWindowIdentity = { sessionId: string; incarnationId: string };

type HomeCrewQueryDeps = {
  getGeneration(): string;
  listOpenSessionWindows(): OpenCrewWindowIdentity[];
  readMembers(openWindows: OpenCrewWindowIdentity[], afterId: string | null, limit: number): Promise<Omit<HomeCrewMember, "isWindowOpen">[]>;
  readAuxiliarySummaries(sessionIds: string[]): Promise<AuxiliarySessionSummary[]>;
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  hasUnreadResult(sessionId: string): boolean;
};

export function parseHomeCrewPageRequest(input: unknown): { cursor: string | null; limit: number } {
  if (input != null && (typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "cursor" && key !== "limit"))) {
    throw new TypeError("Invalid Home Crew page request.");
  }
  const { cursor, limit } = (input ?? {}) as Record<string, unknown>;
  // カーソルには Session ID に加え、取得元の世代も保持する。
  if (cursor != null && (typeof cursor !== "string" || !cursor || cursor.length > 400)) {
    throw new TypeError("Invalid Home Crew cursor.");
  }
  return { cursor: typeof cursor === "string" ? cursor : null, limit: parseOpenSessionWindowIdsPageRequest({ limit }).limit };
}

export async function readHomeCrewPage(deps: HomeCrewQueryDeps, { cursor, limit: pageSize }: ReturnType<typeof parseHomeCrewPageRequest>): Promise<HomeCrewPageResult> {
  const generation = deps.getGeneration();
  const prefix = `${generation}:`;
  const assertCurrent = () => {
    if (generation !== deps.getGeneration()) throw new Error("Home Crew changed while loading. Reload the list.");
  };
  if (cursor && (!cursor.startsWith(prefix) || cursor.length === prefix.length)) {
    throw new Error("Home Crew changed while loading. Reload the list.");
  }
  const openWindows = deps.listOpenSessionWindows();
  const openById = new Map(openWindows.map(({ sessionId, incarnationId }) => [sessionId, incarnationId]));
  const rows = await deps.readMembers(openWindows, cursor ? cursor.slice(prefix.length) : null, pageSize);
  assertCurrent();
  const members = rows.slice(0, pageSize);
  const auxiliaries = members.length ? await deps.readAuxiliarySummaries(members.map(({ id }) => id)) : [];
  assertCurrent();
  const withLiveStatus = <T extends { id: string; runState?: string }>(summary: T) => {
    const status = projectLiveSessionRunStatus(deps.getLiveSessionRun(summary.id));
    return {
      ...summary,
      ...(status?.runState ? { runState: status.runState } : {}),
      cancellationState: status?.cancellationState,
      approvalPending: status?.approvalPending ?? false,
      hasUnreadResult: deps.hasUnreadResult(summary.id),
    };
  };
  const hasMore = rows.length > pageSize;
  return {
    entries: members.map((member) => withLiveStatus({ ...member, isWindowOpen: openById.get(member.id) === member.incarnationId })),
    auxiliarySessions: auxiliaries.map(withLiveStatus),
    nextCursor: hasMore ? `${prefix}${members.at(-1)!.id}` : null,
    hasMore,
  };
}
