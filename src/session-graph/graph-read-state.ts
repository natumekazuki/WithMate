import type {
  SessionGraphEndpoint,
  SessionGraphReadResult,
  SessionGraphRelation,
} from "../../src-shared/session-graph/session-graph-contract.js";

export type GraphRelationCheck = {
  ids: string[];
  revision: number;
  nextOffset: number;
  completed: boolean;
  relationIds: string[];
};

export type GraphReadState = {
  revision: number | null;
  relations: SessionGraphRelation[];
  externalEndpoints: SessionGraphEndpoint[];
  checks: GraphRelationCheck[];
  relationRevisions: Record<string, number>;
};

export function createGraphReadState(read?: SessionGraphReadResult): GraphReadState {
  const state: GraphReadState = {
    revision: null, relations: [], externalEndpoints: [], checks: [], relationRevisions: {},
  };
  return read ? applyGraphRead(state, read) : state;
}

/** Apply a successful read only; conflicts and failed reads leave the caller's state intact. */
export function applyGraphRead(state: GraphReadState, read: SessionGraphReadResult): GraphReadState {
  if (state.revision !== null && read.revision < state.revision) {
    throw new Error("Cannot apply an older Session Graph revision");
  }
  const ids = [...new Set(read.items.map((item) => item.id))].sort();
  const scopeKey = JSON.stringify(ids);
  const previous = state.checks.find((check) => JSON.stringify(check.ids) === scopeKey);
  if (read.relationOffset !== 0 && (!previous || previous.revision !== read.revision
    || previous.completed || previous.nextOffset !== read.relationOffset)) {
    throw new Error("Session Graph relation pages must start at zero and continue in the same scope and revision");
  }
  const relationIds = [...new Set([
    ...(read.relationOffset === 0 ? [] : previous!.relationIds),
    ...read.relations.map((relation) => relation.id),
  ])];
  const check: GraphRelationCheck = {
    ids, revision: read.revision,
    nextOffset: read.relationOffset + read.relations.length,
    completed: !read.relationsHasMore,
    relationIds,
  };
  const scopeIds = new Set(ids);
  const seenIds = new Set(relationIds);
  const relations = new Map(state.relations.map((relation) => [relation.id, relation]));
  if (check.completed) {
    for (const [id, relation] of relations) {
      if ((scopeIds.has(relation.fromId) || scopeIds.has(relation.toId)) && !seenIds.has(id)) relations.delete(id);
    }
  }
  for (const relation of read.relations) relations.set(relation.id, relation);
  const relationRevisions = { ...state.relationRevisions };
  for (const id of Object.keys(relationRevisions)) {
    if (!relations.has(id)) delete relationRevisions[id];
  }
  for (const relation of read.relations) relationRevisions[relation.id] = read.revision;
  const endpoints = new Map(state.externalEndpoints.map((endpoint) => [endpoint.id, endpoint]));
  for (const endpoint of [...read.externalEndpoints, ...read.items]) endpoints.set(endpoint.id, {
    id: endpoint.id, topicId: endpoint.topicId, kind: endpoint.kind, title: endpoint.title,
    ...(endpoint.validity === undefined ? {} : { validity: endpoint.validity }),
  });
  const connectedIds = new Set([...relations.values()].flatMap((relation) => [relation.fromId, relation.toId]));
  const checks = [...state.checks.filter((entry) => !entry.ids.every((id) => scopeIds.has(id))), check];
  const completedIds = new Set(checks.filter((entry) => entry.revision === read.revision && entry.completed)
    .flatMap((entry) => entry.ids));
  return {
    revision: read.revision,
    relations: [...relations.values()],
    externalEndpoints: [...endpoints.values()].filter((endpoint) => connectedIds.has(endpoint.id)),
    checks: checks.filter((entry) => (entry.revision === read.revision && entry.completed)
      || !entry.ids.every((id) => completedIds.has(id))),
    relationRevisions,
  };
}

/** A refresh batch must describe one revision; never commit a partially mixed refresh. */
export function applyGraphReadBatch(
  state: GraphReadState,
  reads: SessionGraphReadResult[],
  retainedIds?: string[],
): GraphReadState {
  if (new Set(reads.map((read) => read.revision)).size > 1) {
    throw new Error("Session Graph refresh requires a single revision");
  }
  let next = reads.reduce(applyGraphRead, state);
  if (retainedIds) {
    const retained = new Set(retainedIds);
    const relations = next.relations.filter((relation) => retained.has(relation.fromId) || retained.has(relation.toId));
    const connected = new Set(relations.flatMap((relation) => [relation.fromId, relation.toId]));
    next = {
      ...next, relations,
      externalEndpoints: next.externalEndpoints.filter((endpoint) => connected.has(endpoint.id)),
      checks: next.checks.filter((check) => check.ids.some((id) => retained.has(id))),
      relationRevisions: Object.fromEntries(relations.map((relation) => [relation.id, next.relationRevisions[relation.id]])),
    };
  }
  return next;
}

export function graphReadPendingScopes(state: GraphReadState): Array<{
  ids: string[]; nextOffset: number; expectedRevision: number;
}> {
  if (state.revision === null) return [];
  const revision = state.revision;
  return state.checks.filter((check) => check.revision !== revision || !check.completed).map((check) => ({
    ids: check.ids,
    nextOffset: check.revision === revision ? check.nextOffset : 0,
    expectedRevision: revision,
  }));
}

export function graphReadIsIncomplete(state: GraphReadState): boolean {
  return graphReadPendingScopes(state).length > 0
    || state.relations.some((relation) => state.relationRevisions[relation.id] !== state.revision);
}
