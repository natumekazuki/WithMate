import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import {
  projectCharacterPublicProfile,
  type CharacterPublicProfile,
} from "../../src-shared/character/character-participant.js";
import {
  normalizeSessionRelationship,
  type RelatedSessionRole,
  type SessionRelationship,
} from "../../src-shared/session/session-role.js";
import {
  getSessionIncarnationId,
  type SessionSummary,
} from "../../src-shared/session/session-state.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";

/** 保存された所属・識別情報と、発見・操作に使える公開メタデータを持つ Session。 */
export type RelatedSession = SessionRelationship & {
  id: string;
  incarnationId: string;
  kind: "main" | "auxiliary";
  role: RelatedSessionRole;
  mainSessionId: string;
  mainIncarnationId: string;
  title: string;
  description: string;
  runState: string;
  provider: string;
  workspacePath: string;
  character?: CharacterPublicProfile | null;
};

/** Crew・役割・作成関係・検索語で対象を絞り、位置と件数で取得範囲を指定する。 */
export type RelatedSessionQuery = {
  rootSessionId?: string;
  allCrews?: boolean;
  role?: RelatedSessionRole;
  relationship?: "all" | "created" | "creator";
  searchText?: string;
  offset?: number;
  limit?: number;
};

/** 条件に合うページ内の Session と、該当全件数・次ページの有無。 */
export type RelatedSessionPage = {
  entries: RelatedSession[];
  total: number;
  hasMore: boolean;
};
/** 実行主体と一緒に取得する範囲を、単一の対象・検索ページ・追加対象なしから選ぶ。 */
export type SessionManagementSelection =
  { target: SessionTarget } | { query: RelatedSessionQuery } | null;
/** 保存先の同じ読み取りで得た実行主体と、要求時に選んだ対象または検索ページ。 */
export type SessionManagementScope = {
  actor: RelatedSession | null;
  target?: RelatedSession | null;
  page?: RelatedSessionPage;
};

/** Crew の所属や操作に必要な関係は、保存済みの識別情報だけを根拠に決める。 */
export function resolveRelatedMain(main: SessionSummary): RelatedSession {
  const relationship = normalizeSessionRelationship(main);
  const incarnationId = getSessionIncarnationId(main);
  return {
    ...relationship,
    id: main.id,
    incarnationId,
    kind: "main",
    role: relationship.sessionRole,
    mainSessionId: main.id,
    mainIncarnationId: incarnationId,
    title: main.taskTitle,
    description: main.description ?? "",
    runState: main.runState,
    provider: main.provider,
    workspacePath: main.workspacePath,
    character: projectCharacterPublicProfile(main),
  };
}

/** Auxiliary の識別・公開情報に Main の Crew と作業場所を関連付ける。通常子を示す親子・作成者関係は付けない。 */
export function resolveRelatedAuxiliary(
  auxiliary: AuxiliarySessionSummary,
  main: Pick<
    SessionSummary,
    keyof SessionRelationship | "id" | "incarnationId" | "workspacePath"
  >,
): RelatedSession {
  const relationship = normalizeSessionRelationship(main);
  return {
    ...relationship,
    parentSessionId: null,
    createdBySessionId: null,
    id: auxiliary.id,
    incarnationId: auxiliary.createdAt,
    kind: "auxiliary",
    role: "auxiliary",
    mainSessionId: main.id,
    mainIncarnationId: getSessionIncarnationId(main),
    title: auxiliary.title,
    description: auxiliary.description ?? "",
    runState: auxiliary.runState,
    provider: auxiliary.provider,
    workspacePath: main.workspacePath,
    character: projectCharacterPublicProfile(auxiliary),
  };
}

/** 種別・ID・世代をすべて照合する。Auxiliary は所属する Main の ID・世代も一致させる。 */
export function matchesRelatedSession(
  entry: RelatedSession,
  reference: SessionTarget,
): boolean {
  return (
    entry.id === reference.sessionId &&
    entry.kind === reference.kind &&
    entry.incarnationId === reference.incarnationId &&
    (reference.kind !== "auxiliary" ||
      (entry.mainSessionId === reference.mainSessionId &&
        entry.mainIncarnationId === reference.mainIncarnationId))
  );
}

/** Main と Auxiliary を共通の一覧に写す。保存済みの所属 Main が見つからない Auxiliary があれば失敗する。 */
export function resolveRelatedSessions(
  mains: readonly SessionSummary[],
  auxiliaries: readonly AuxiliarySessionSummary[],
): RelatedSession[] {
  const byId = new Map(mains.map((main) => [main.id, main]));
  return [
    ...mains.map(resolveRelatedMain),
    ...auxiliaries.map((auxiliary) => {
      const main = byId.get(auxiliary.parentSessionId);
      if (!main)
        throw new Error(
          "The Auxiliary's saved Main Session could not be found.",
        );
      return resolveRelatedAuxiliary(auxiliary, main);
    }),
  ];
}

/** 正規化済みの小文字の検索語を、Session と公開キャラクター情報の名前・説明に含むか調べる。 */
export function matchesRelatedSessionSearch(
  entry: Pick<RelatedSession, "title" | "description" | "character">,
  searchText: string,
): boolean {
  return `${entry.title}\n${entry.description}\n${entry.character?.name ?? ""}\n${entry.character?.description ?? ""}`
    .toLocaleLowerCase()
    .includes(searchText);
}

/** 既定で呼び出し元の Crew を検索する。取得範囲を検証し、一致項目の順序を保ってページを切り出す。 */
export function queryRelatedSessions(
  entries: readonly RelatedSession[],
  caller: RelatedSession,
  query: RelatedSessionQuery = {},
): RelatedSessionPage {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error("Invalid related Session page.");
  const searchText = query.searchText?.trim().toLocaleLowerCase();
  const matching = entries.filter(
    (entry) =>
      (query.allCrews ||
        entry.rootSessionId ===
          (query.rootSessionId ?? caller.rootSessionId)) &&
      (!query.role || entry.role === query.role) &&
      (query.relationship !== "created" ||
        entry.createdBySessionId === caller.id) &&
      (query.relationship !== "creator" ||
        entry.id === caller.createdBySessionId) &&
      (!searchText || matchesRelatedSessionSearch(entry, searchText)),
  );
  return {
    entries: matching.slice(offset, offset + limit),
    total: matching.length,
    hasMore: offset + limit < matching.length,
  };
}

/** 通常送信は同じ Crew に保存された Main の直接親子間に限り、どちらの向きも許す。 */
export function assertDirectSessionSend(
  actor: RelatedSession,
  target: RelatedSession,
): void {
  if (
    actor.kind === "main" &&
    target.kind === "main" &&
    actor.rootSessionId === target.rootSessionId &&
    (actor.parentSessionId === target.id || target.parentSessionId === actor.id)
  )
    return;
  throw new Error(
    "Session messages require a saved direct parent-child relationship.",
  );
}

/** キャンセル・停止は同じ Crew の Main の直接親から子への操作に限る。 */
export function assertDirectChildSessionControl(
  actor: RelatedSession,
  target: RelatedSession,
): void {
  if (
    actor.kind === "main" &&
    target.kind === "main" &&
    actor.rootSessionId === target.rootSessionId &&
    target.parentSessionId === actor.id
  )
    return;
  throw new Error(
    "Only the saved direct parent can cancel or stop this Session.",
  );
}
