import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { projectCharacterPublicProfile, type CharacterPublicProfile } from "../../src-shared/character/character-participant.js";
import { normalizeSessionRelationship, type RelatedSessionRole, type SessionRelationship } from "../../src-shared/session/session-role.js";
import { getSessionIncarnationId, type SessionSummary } from "../../src-shared/session/session-state.js";

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

/** Saved identity is the only source of Crew membership and operation relationships. */
export function resolveRelatedSessions(mains: readonly SessionSummary[], auxiliaries: readonly AuxiliarySessionSummary[]): RelatedSession[] {
  const byId = new Map(mains.map((main) => [main.id, main]));
  const entries: RelatedSession[] = mains.map((main) => {
    const relationship = normalizeSessionRelationship(main);
    return { ...relationship, id: main.id, incarnationId: getSessionIncarnationId(main), kind: "main", role: relationship.sessionRole,
      mainSessionId: main.id, mainIncarnationId: getSessionIncarnationId(main), title: main.taskTitle, description: (main as SessionSummary & { description?: string }).description ?? "", runState: main.runState,
      character: projectCharacterPublicProfile(main) };
  });
  for (const auxiliary of auxiliaries) {
    const main = byId.get(auxiliary.parentSessionId);
    if (!main) throw new Error("The Auxiliary's saved Main Session could not be found.");
    const relationship = normalizeSessionRelationship(main);
    entries.push({ ...relationship, parentSessionId: null, createdBySessionId: null, id: auxiliary.id,
      incarnationId: auxiliary.createdAt, kind: "auxiliary", role: "auxiliary", mainSessionId: main.id, mainIncarnationId: getSessionIncarnationId(main),
      title: auxiliary.title, description: (auxiliary as AuxiliarySessionSummary & { description?: string }).description ?? "", runState: auxiliary.runState,
      character: projectCharacterPublicProfile(auxiliary) });
  }
  return entries;
}

export function queryRelatedSessions(entries: readonly RelatedSession[], caller: RelatedSession, query: RelatedSessionQuery = {}): { entries: RelatedSession[]; total: number; hasMore: boolean } {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid related Session page.");
  const searchText = query.searchText?.trim().toLocaleLowerCase();
  const matching = entries.filter((entry) => (query.allCrews || entry.rootSessionId === (query.rootSessionId ?? caller.rootSessionId))
    && (!query.role || entry.role === query.role)
    && (query.relationship !== "created" || entry.createdBySessionId === caller.id)
    && (query.relationship !== "creator" || entry.id === caller.createdBySessionId)
    && (!searchText || `${entry.title}\n${entry.description}\n${entry.character?.name ?? ""}\n${entry.character?.description ?? ""}`.toLocaleLowerCase().includes(searchText)));
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
