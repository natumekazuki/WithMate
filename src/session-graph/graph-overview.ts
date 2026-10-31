import type {
  SessionGraphRecord,
  SessionGraphRelation,
} from "../../src-shared/session-graph/session-graph-contract.js";

export type GraphOverviewNode = { id: string; records: SessionGraphRecord[] };
export type GraphOverviewEdge = SessionGraphRelation & { grouped: boolean };

// Only uninterrupted, fully loaded paths with one incoming and one outgoing
// relation of the same meaning can be represented by an expandable group.
export function projectSessionGraph(
  records: SessionGraphRecord[],
  relations: SessionGraphRelation[],
  capacity: number,
  scopeIds: string[] | null = null,
): { nodes: GraphOverviewNode[]; edges: GraphOverviewEdge[] } {
  const byId = new Map(records.map((record) => [record.id, record]));
  const incoming = new Map(records.map((record) => [record.id, [] as SessionGraphRelation[]]));
  const outgoing = new Map(records.map((record) => [record.id, [] as SessionGraphRelation[]]));
  for (const edge of relations) {
    incoming.get(edge.toId)?.push(edge);
    outgoing.get(edge.fromId)?.push(edge);
  }
  const scope = scopeIds ? new Set(scopeIds.filter((id) => byId.has(id))) : new Set(byId.keys());
  const visible = new Set(scope);
  if (scopeIds) {
    for (const edge of relations) {
      if (scope.has(edge.fromId) && byId.has(edge.toId)) visible.add(edge.toId);
      if (scope.has(edge.toId) && byId.has(edge.fromId)) visible.add(edge.fromId);
    }
  }
  const eligible = new Set<string>();
  for (const id of scope) {
    const ins = incoming.get(id)!;
    const outs = outgoing.get(id)!;
    if (ins.length !== 1 || outs.length !== 1) continue;
    const before = ins[0];
    const after = outs[0];
    if (before.fromId === id || after.toId === id || before.fromId === after.toId) continue;
    if (!byId.has(before.fromId) || !byId.has(after.toId)) continue;
    if (before.kind === after.kind && before.label === after.label) eligible.add(id);
  }
  const groups = new Map<string, GraphOverviewNode>();
  const reaches = (start: string, target: string) => {
    const pending = [start];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of outgoing.get(id) ?? []) pending.push(edge.toId);
    }
    return false;
  };
  if (visible.size > capacity) {
    const slots = Math.max(2, capacity - (visible.size - scope.size));
    const groupSize = scopeIds ? Math.ceil(scope.size / slots) : Number.POSITIVE_INFINITY;
    for (const id of eligible) {
      if (eligible.has(incoming.get(id)![0].fromId)) continue;
      const path: string[] = [];
      let next = id;
      while (eligible.has(next)) {
        path.push(next);
        next = outgoing.get(next)![0].toId;
      }
      // Keep a cycle visible even when a branch interrupts its degree-two run.
      if (reaches(next, incoming.get(id)![0].fromId)) continue;
      for (let offset = 0; offset < path.length; offset += groupSize) {
        const ids = path.slice(offset, offset + groupSize);
        if (ids.length < 2) continue;
        const group = { id: `group:${JSON.stringify(ids)}`, records: ids.map((member) => byId.get(member)!) };
        for (const member of ids) groups.set(member, group);
      }
    }
  }
  const nodes = [...new Map(records.filter((record) => visible.has(record.id)).map((record) => {
    const node = groups.get(record.id) ?? { id: `record:${record.id}`, records: [record] };
    return [node.id, node] as const;
  })).values()];
  const nodeByRecord = new Map(nodes.flatMap((node) => node.records.map((record) => [record.id, node] as const)));
  const edges = relations.flatMap((edge) => {
    const from = nodeByRecord.get(edge.fromId);
    const to = nodeByRecord.get(edge.toId);
    if (!from || !to || from === to && from.records.length > 1) return [];
    return [{ ...edge, fromId: from.id, toId: to.id, grouped: from.records.length > 1 || to.records.length > 1 }];
  });
  return { nodes, edges };
}
