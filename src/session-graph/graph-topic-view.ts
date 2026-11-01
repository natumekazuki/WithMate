import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionGraphEndpoint, SessionGraphReadResult, SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import type { SessionGraphTopicOverview, SessionGraphTopicRelation } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";
import type { GraphOverviewEdge, GraphOverviewNode } from "./graph-overview.js";

export async function readExpandedTopicViews(
  api: Pick<WithMateWindowApi, "readSessionGraph">, sessionId: string, revision: number,
  topics: SessionGraphTopicOverview[], expandedIds: string[], previous: SessionGraphReadResult | null,
  more: boolean, pageSize: number,
): Promise<{ view: SessionGraphReadResult & { recency: {} }; reads: SessionGraphReadResult[] }> {
  const expanded = topics.filter((topic) => expandedIds.includes(topic.id));
  const loaded = (id: string) => previous?.items.filter((record) => record.topicId === id).length ?? 0;
  const nextTopic = more ? expanded.find((topic) => loaded(topic.id) < topic.recordCount)?.id : undefined;
  const pages = await Promise.all(expanded.map(async (topic) => {
    const wanted = Math.min(topic.recordCount, Math.max(pageSize, loaded(topic.id) + (topic.id === nextTopic ? pageSize : 0)));
    const reads: SessionGraphReadResult[] = [];
    let count = 0;
    while (count < wanted) {
      const result = await api.readSessionGraph(sessionId, "get_topic_view", {
        topicId: topic.id, expectedRevision: revision, limit: Math.min(200, wanted - count), offset: count,
      });
      if (result.status !== "ok") throw new Error("The graph changed. Retry to load its current state.");
      if (!result.items.length || result.total !== topic.recordCount) throw new Error("Topic Retrieval Is Incomplete. Retry.");
      reads.push(result);
      count += result.items.length;
      if (!result.hasMore) {
        if (count !== result.total) throw new Error("Topic Retrieval Is Incomplete. Retry.");
        break;
      }
    }
    return reads;
  }));
  const reads = pages.flat();
  const items = reads.flatMap((read) => read.items);
  const total = expanded.reduce((sum, topic) => sum + topic.recordCount, 0);
  const relationsTruncated = reads.some((read) => read.relationsTruncated);
  return { reads, view: {
    status: "ok", revision, items, total, offset: 0, hasMore: items.length < total,
    incomplete: items.length < total || relationsTruncated, recency: {},
    relations: [...new Map(reads.flatMap((read) => read.relations).map((edge) => [edge.id, edge])).values()],
    externalEndpoints: [...new Map(reads.flatMap((read) => read.externalEndpoints).map((endpoint) => [endpoint.id, endpoint])).values()],
    relationsTruncated, relationOffset: 0, relationsHasMore: reads.some((read) => read.relationsHasMore),
  } };
}

export function collapsedTopicEdges(
  collapsed: Set<string>, summaries: SessionGraphTopicRelation[], nodes: GraphOverviewNode[],
  relations: SessionGraphRelation[], endpoints: ReadonlyMap<string, SessionGraphEndpoint>,
): GraphOverviewEdge[] {
  const byRecord = new Map(nodes.flatMap((node) => node.records.map((record) => [record.id, node.id] as const)));
  const grouped = new Map<string, { fromId: string; toId: string; kind: SessionGraphRelation["kind"]; label?: string; count: number }>();
  for (const edge of summaries) if (collapsed.has(edge.fromTopicId) && collapsed.has(edge.toTopicId)) {
    const fromId = `topic:${edge.fromTopicId}`, toId = `topic:${edge.toTopicId}`;
    grouped.set(JSON.stringify([fromId, toId, edge.kind]), { fromId, toId, kind: edge.kind, count: edge.count });
  }
  for (const edge of relations) {
    const fromTopic = endpoints.get(edge.fromId)?.topicId, toTopic = endpoints.get(edge.toId)?.topicId;
    const fromCollapsed = !!fromTopic && collapsed.has(fromTopic), toCollapsed = !!toTopic && collapsed.has(toTopic);
    if (fromCollapsed === toCollapsed) continue;
    const fromId = fromCollapsed ? `topic:${fromTopic}` : byRecord.get(edge.fromId);
    const toId = toCollapsed ? `topic:${toTopic}` : byRecord.get(edge.toId);
    if (!fromId || !toId) continue;
    const id = JSON.stringify([fromId, toId, edge.kind, edge.label]);
    const current = grouped.get(id);
    grouped.set(id, { fromId, toId, kind: edge.kind, label: edge.label, count: (current?.count ?? 0) + 1 });
  }
  return [...grouped].map(([id, edge]) => ({
    id: `topic-relation:${id}`, fromId: edge.fromId, toId: edge.toId, kind: edge.kind, grouped: false,
    label: `${edge.label ?? edge.kind.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ")} · ${edge.count} Record ${edge.count === 1 ? "Relation" : "Relations"}`,
  }));
}
