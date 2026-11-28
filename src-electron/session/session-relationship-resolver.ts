import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { projectCharacterPublicProfile, type CharacterPublicProfile } from "../../src-shared/character/character-participant.js";
import { normalizeSessionRelationship, type RelatedSessionRole, type SessionRelationship } from "../../src-shared/session/session-role.js";
import { getSessionIncarnationId, type SessionSummary } from "../../src-shared/session/session-state.js";
import type { SessionTarget } from "../../src-shared/session/session-target.js";

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

export type RelatedSessionQuery = {
  rootSessionId?: string;
  allCrews?: boolean;
  role?: RelatedSessionRole;
  relationship?: "all" | "created" | "creator";
  searchText?: string;
  offset?: number;
  limit?: number;
};

export type RelatedSessionPage = { entries: RelatedSession[]; total: number; hasMore: boolean };
export type SessionManagementSelection = { target: SessionTarget } | { query: RelatedSessionQuery } | null;
export type SessionManagementScope = {
  actor: RelatedSession | null;
  target?: RelatedSession | null;
  page?: RelatedSessionPage;
};

/** Crew の所属や操作に必要な関係は、保存済みの識別情報だけを根拠に決める。 */
export function resolveRelatedMain(main: SessionSummary): RelatedSession {
  const relationship = normalizeSessionRelationship(main);
  const incarnationId = getSessionIncarnationId(main);
  return { ...relationship, id: main.id, incarnationId, kind: "main", role: relationship.sessionRole,
    mainSessionId: main.id, mainIncarnationId: incarnationId, title: main.taskTitle, description: main.description ?? "", runState: main.runState,
    provider: main.provider, workspacePath: main.workspacePath, character: projectCharacterPublicProfile(main) };
}

export function resolveRelatedAuxiliary(
  auxiliary: AuxiliarySessionSummary,
  main: Pick<SessionSummary, keyof SessionRelationship | "id" | "incarnationId" | "workspacePath">,
): RelatedSession {
  const relationship = normalizeSessionRelationship(main);
  return { ...relationship, parentSessionId: null, createdBySessionId: null, id: auxiliary.id,
    incarnationId: auxiliary.createdAt, kind: "auxiliary", role: "auxiliary", mainSessionId: main.id, mainIncarnationId: getSessionIncarnationId(main),
    title: auxiliary.title, description: auxiliary.description ?? "", runState: auxiliary.runState,
    provider: auxiliary.provider, workspacePath: main.workspacePath, character: projectCharacterPublicProfile(auxiliary) };
}

export function matchesRelatedSession(entry: RelatedSession, reference: SessionTarget): boolean {
  return entry.id === reference.sessionId && entry.kind === reference.kind && entry.incarnationId === reference.incarnationId
    && (reference.kind !== "auxiliary" || (
      entry.mainSessionId === reference.mainSessionId && entry.mainIncarnationId === reference.mainIncarnationId
    ));
}

export function resolveRelatedSessions(mains: readonly SessionSummary[], auxiliaries: readonly AuxiliarySessionSummary[]): RelatedSession[] {
  const byId = new Map(mains.map((main) => [main.id, main]));
  return [...mains.map(resolveRelatedMain), ...auxiliaries.map((auxiliary) => {
    const main = byId.get(auxiliary.parentSessionId);
    if (!main) throw new Error("The Auxiliary's saved Main Session could not be found.");
    return resolveRelatedAuxiliary(auxiliary, main);
  })];
}

export function matchesRelatedSessionSearch(entry: Pick<RelatedSession, "title" | "description" | "character">, searchText: string): boolean {
  return `${entry.title}\n${entry.description}\n${entry.character?.name ?? ""}\n${entry.character?.description ?? ""}`.toLocaleLowerCase().includes(searchText);
}

export function queryRelatedSessions(entries: readonly RelatedSession[], caller: RelatedSession, query: RelatedSessionQuery = {}): RelatedSessionPage {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid related Session page.");
  const searchText = query.searchText?.trim().toLocaleLowerCase();
  const matching = entries.filter((entry) => (query.allCrews || entry.rootSessionId === (query.rootSessionId ?? caller.rootSessionId))
    && (!query.role || entry.role === query.role)
    && (query.relationship !== "created" || entry.createdBySessionId === caller.id)
    && (query.relationship !== "creator" || entry.id === caller.createdBySessionId)
    && (!searchText || matchesRelatedSessionSearch(entry, searchText)));
  return { entries: matching.slice(offset, offset + limit), total: matching.length, hasMore: offset + limit < matching.length };
}

export function assertDirectSessionSend(actor: RelatedSession, target: RelatedSession): void {
  if (actor.kind === "main" && target.kind === "main" && actor.rootSessionId === target.rootSessionId
    && (actor.parentSessionId === target.id || target.parentSessionId === actor.id)) return;
  throw new Error("Session messages require a saved direct parent-child relationship.");
}

export function assertDirectChildSessionControl(actor: RelatedSession, target: RelatedSession): void {
  if (actor.kind === "main" && target.kind === "main" && actor.rootSessionId === target.rootSessionId && target.parentSessionId === actor.id) return;
  throw new Error("Only the saved direct parent can cancel or stop this Session.");
}
