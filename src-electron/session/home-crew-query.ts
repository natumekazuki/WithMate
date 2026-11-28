import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import type {
  HomeCrewMember,
  HomeCrewPageResult,
} from "../../src-shared/window/home-crew-types.js";
import { parseOpenSessionWindowIdsPageRequest } from "../../src-shared/window/withmate-window-types.js";

/** 開いている Window と保存済みの Session を同じ ID・世代で照合するための識別情報。 */
export type OpenCrewWindowIdentity = {
  sessionId: string;
  incarnationId: string;
};

/** Home Crew のページを保存済みの関係と現在の Window・実行状態から組み立てるための依存。 */
type HomeCrewQueryDeps = {
  /** ページの途中で保存先が切り替わったかを照合するため、現在の世代を返す。 */
  getGeneration(): string;
  /** ページ読み取りの起点となる、いま開いている Window の識別情報を取得する。 */
  listOpenSessionWindows(): OpenCrewWindowIdentity[];
  /** 対象 Window の保存済み関係を、指定された直前 ID より後ろから読む。続きの判定には余分な 1 件も使う。 */
  readMembers(
    openWindows: OpenCrewWindowIdentity[],
    afterId: string | null,
    limit: number,
  ): Promise<Omit<HomeCrewMember, "isWindowOpen">[]>;
  /** このページで返す Main に所属する Auxiliary の要約を取得する。 */
  readAuxiliarySummaries(
    sessionIds: string[],
  ): Promise<AuxiliarySessionSummary[]>;
  /** 保存済み要約に重ねる現在の実行状態を取得する。実行情報がなければ null。 */
  getLiveSessionRun(sessionId: string): LiveSessionRunState | null;
  /** 指定 Session に未読の結果があるかを表示用に取得する。 */
  hasUnreadResult(sessionId: string): boolean;
};

/** カーソルと件数以外の入力を拒否し、空の要求は最初のページとして扱う。 */
export function parseHomeCrewPageRequest(input: unknown): {
  cursor: string | null;
  limit: number;
} {
  if (
    input != null &&
    (typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "cursor" && key !== "limit"))
  ) {
    throw new TypeError("Invalid Home Crew page request.");
  }
  const { cursor, limit } = (input ?? {}) as Record<string, unknown>;
  // カーソルには Session ID に加え、取得元の世代も保持する。
  if (
    cursor != null &&
    (typeof cursor !== "string" || !cursor || cursor.length > 400)
  ) {
    throw new TypeError("Invalid Home Crew cursor.");
  }
  return {
    cursor: typeof cursor === "string" ? cursor : null,
    limit: parseOpenSessionWindowIdsPageRequest({ limit }).limit,
  };
}

/** 保存済み Crew と最新の表示状態を一ページ分返す。別世代のカーソルや読み取り中の世代変更は再取得を要求する。 */
export async function readHomeCrewPage(
  deps: HomeCrewQueryDeps,
  { cursor, limit: pageSize }: ReturnType<typeof parseHomeCrewPageRequest>,
): Promise<HomeCrewPageResult> {
  const generation = deps.getGeneration();
  const prefix = `${generation}:`;
  /** 非同期の取得をまたいで別世代の保存結果を混ぜないよう照合する。 */
  const assertCurrent = () => {
    if (generation !== deps.getGeneration())
      throw new Error("Home Crew changed while loading. Reload the list.");
  };
  if (
    cursor &&
    (!cursor.startsWith(prefix) || cursor.length === prefix.length)
  ) {
    throw new Error("Home Crew changed while loading. Reload the list.");
  }
  const openWindows = deps.listOpenSessionWindows();
  const openById = new Map(
    openWindows.map(({ sessionId, incarnationId }) => [
      sessionId,
      incarnationId,
    ]),
  );
  const rows = await deps.readMembers(
    openWindows,
    cursor ? cursor.slice(prefix.length) : null,
    pageSize,
  );
  assertCurrent();
  const members = rows.slice(0, pageSize);
  const auxiliaries = members.length
    ? await deps.readAuxiliarySummaries(members.map(({ id }) => id))
    : [];
  assertCurrent();
  /** 実行中の状態があれば保存済み状態に重ね、停止・承認待ち・未読の表示情報を付ける。 */
  const withLiveStatus = <T extends { id: string; runState?: string }>(
    summary: T,
  ) => {
    const status = projectLiveSessionRunStatus(
      deps.getLiveSessionRun(summary.id),
    );
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
    entries: members.map((member) =>
      withLiveStatus({
        ...member,
        isWindowOpen: openById.get(member.id) === member.incarnationId,
      }),
    ),
    auxiliarySessions: auxiliaries.map(withLiveStatus),
    nextCursor: hasMore ? `${prefix}${members.at(-1)!.id}` : null,
    hasMore,
  };
}
