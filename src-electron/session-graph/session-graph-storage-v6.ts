import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionGraphOwner, SessionGraphIdentity, SessionGraphOperation, SessionGraphRequest, SessionGraphRecordInput, SessionGraphRecord, SessionGraphRelation, SessionGraphTopic, SessionGraphEndpoint } from "../../src-shared/session-graph/session-graph-contract.js";
import { SESSION_GRAPH_RELATION_LIMIT } from "../../src-shared/session-graph/session-graph-contract.js";
import { sessionGraphRecordSchema } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { assertRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";
import { sessionGraphStorageRequestSchemas, type SessionGraphStorageOperation, type SessionGraphStorageRequest, type SessionGraphStorageResult, type SessionGraphOverviewCategory, type SessionGraphOverviewGroup, type SessionGraphRecordSummary, type SessionGraphTopicOverview, type SessionGraphTopicRelation } from "../../src-shared/session-graph/session-graph-ui-read-contract.js";

type JsonRow = { payload_json: string };
const decode = <T>(row: JsonRow): T => JSON.parse(row.payload_json) as T;
const summaryColumns = ["id", "topicId", "title", "kind", "adoption", "progress", "result", "resolution", "validity", "updatedAt"] as const;
const summaryProjection = `json_object(${summaryColumns.flatMap((key) => [`'${key}'`, `json_extract(payload_json, '$.${key}')`]).join(",")}) AS payload_json`;
const categoryPredicate: Record<SessionGraphOverviewCategory, string> = {
  requirements: "kind = 'requirement'", constraints: "kind = 'constraint'",
  decisions: "kind = 'decision' AND json_extract(payload_json, '$.adoption') = 'accepted'",
  activities: "kind = 'activity'", observations: "kind = 'observation'",
  issues: "kind = 'issue' AND COALESCE(json_extract(payload_json, '$.resolution'), 'open') = 'open'",
};
const emptyGroup = (): SessionGraphOverviewGroup => ({ count: 0, states: {}, records: [] });
function addSummary(group: SessionGraphOverviewGroup, record: SessionGraphRecordSummary): void {
  group.count++;
  for (const key of ["adoption", "progress", "result", "resolution"] as const) {
    if (record[key]) { const state = `${key}:${record[key]}`; group.states[state] = (group.states[state] ?? 0) + 1; }
  }
  if (record.kind === "activity" && !record.progress) group.states["progress:unspecified"] = (group.states["progress:unspecified"] ?? 0) + 1;
  if (record.kind === "observation" && !record.result) group.states["result:unspecified"] = (group.states["result:unspecified"] ?? 0) + 1;
  if (group.records.length < 3) group.records.push(record);
}
function readSummary(row: JsonRow): SessionGraphRecordSummary {
  const value = decode<Record<string, unknown>>(row);
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null)) as SessionGraphRecordSummary;
}

export class SessionGraphStorageV6 {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) { this.db = openAppDatabase(dbPath); ensureV6Schema(this.db); }
  close(): void { this.db.close(); }

  private recordRecency(owner: SessionGraphOwner, topicId: string) {
    const row = this.db.prepare("SELECT min(updated_at) AS oldestUpdatedAt, max(updated_at) AS newestUpdatedAt FROM session_graph_records_v6 WHERE session_id = ? AND topic_id = ?").get(owner.sessionId, topicId) as { oldestUpdatedAt: string | null; newestUpdatedAt: string | null };
    return { ...(row.oldestUpdatedAt ? { oldestUpdatedAt: row.oldestUpdatedAt } : {}), ...(row.newestUpdatedAt ? { newestUpdatedAt: row.newestUpdatedAt } : {}) };
  }

  private overview(owner: SessionGraphOwner, input: SessionGraphStorageRequest<"overview">, revision: number) {
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    const total = (this.db.prepare("SELECT count(*) AS n FROM session_graph_topics_v6 WHERE session_id = ?").get(owner.sessionId) as { n: number }).n;
    const topics = this.db.prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM session_graph_topics_v6 WHERE session_id = ? ORDER BY title, id LIMIT ? OFFSET ?").all(owner.sessionId, limit, offset) as SessionGraphTopic[];
    const items: SessionGraphTopicOverview[] = topics.map((topic) => {
      const recency = this.recordRecency(owner, topic.id);
      const recordCount = (this.db.prepare("SELECT count(*) AS n FROM session_graph_records_v6 WHERE session_id = ? AND topic_id = ?").get(owner.sessionId, topic.id) as { n: number }).n;
      const item: SessionGraphTopicOverview = { ...topic, recordCount, recency, latestRecordUpdatedAt: recency.newestUpdatedAt,
        requirements: emptyGroup(), constraints: emptyGroup(), decisions: emptyGroup(), activities: emptyGroup(), observations: emptyGroup(), issues: emptyGroup(), actors: [] };
      const actors = new Map<string, SessionGraphTopicOverview["actors"][number]>();
      const rows = this.db.prepare(`SELECT ${summaryProjection}, json_extract(payload_json, '$.actorSnapshot') AS actor_json FROM session_graph_records_v6
        WHERE session_id = ? AND topic_id = ? AND json_extract(payload_json, '$.validity') IS NULL ORDER BY updated_at DESC, id`).all(owner.sessionId, topic.id) as Array<JsonRow & { actor_json: string }>;
      for (const row of rows) {
        const record = readSummary(row);
        const category = record.kind === "requirement" ? "requirements" : record.kind === "constraint" ? "constraints"
          : record.kind === "decision" && record.adoption === "accepted" ? "decisions" : record.kind === "activity" ? "activities"
          : record.kind === "observation" ? "observations" : record.kind === "issue" && record.resolution !== "resolved" ? "issues" : null;
        if (category) addSummary(item[category], record);
        if (record.kind === "activity") {
          const identity = JSON.parse(row.actor_json) as SessionGraphIdentity;
          let actor = actors.get(identity.sessionId);
          if (!actor) { actor = { identity, activities: emptyGroup() }; actors.set(identity.sessionId, actor); }
          addSummary(actor.activities, record);
        }
      }
      item.actors = [...actors.values()].sort((a, b) => a.identity.sessionId.localeCompare(b.identity.sessionId));
      return item;
    });
    const range = this.db.prepare(`SELECT min(latest) AS oldestUpdatedAt, max(latest) AS newestUpdatedAt FROM
      (SELECT max(updated_at) AS latest FROM session_graph_records_v6 WHERE session_id = ? GROUP BY topic_id)`).get(owner.sessionId) as { oldestUpdatedAt: string | null; newestUpdatedAt: string | null };
    const recency = { ...(range.oldestUpdatedAt ? { oldestUpdatedAt: range.oldestUpdatedAt } : {}), ...(range.newestUpdatedAt ? { newestUpdatedAt: range.newestUpdatedAt } : {}) };
    const topicRelations = this.db.prepare(`SELECT f.topic_id AS fromTopicId, t.topic_id AS toTopicId, json_extract(r.payload_json, '$.kind') AS kind, count(*) AS count
      FROM session_graph_relations_v6 r JOIN session_graph_records_v6 f ON f.session_id = r.session_id AND f.id = r.from_id
      JOIN session_graph_records_v6 t ON t.session_id = r.session_id AND t.id = r.to_id
      WHERE r.session_id = ? AND f.topic_id != t.topic_id GROUP BY f.topic_id, t.topic_id, json_extract(r.payload_json, '$.kind') ORDER BY f.topic_id, t.topic_id, json_extract(r.payload_json, '$.kind')`).all(owner.sessionId) as SessionGraphTopicRelation[];
    const hasMore = offset + items.length < total;
    return { status: "ok", revision, items, total, offset, hasMore, incomplete: hasMore || offset > 0, recency, topicRelations };
  }

  private topicRecords(owner: SessionGraphOwner, input: SessionGraphStorageRequest<"topic_records">, revision: number) {
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    const actor = input.actorSessionId ? " AND json_extract(payload_json, '$.actor.sessionId') = ?" : "";
    const params = [owner.sessionId, input.topicId, ...(input.actorSessionId ? [input.actorSessionId] : [])];
    const predicate = `session_id = ? AND topic_id = ? AND json_extract(payload_json, '$.validity') IS NULL AND ${categoryPredicate[input.category]}${actor}`;
    const total = (this.db.prepare(`SELECT count(*) AS n FROM session_graph_records_v6 WHERE ${predicate}`).get(...params) as { n: number }).n;
    const items = (this.db.prepare(`SELECT ${summaryProjection} FROM session_graph_records_v6 WHERE ${predicate} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...params, limit, offset) as JsonRow[]).map(readSummary);
    const hasMore = offset + items.length < total;
    return { status: "ok", revision, items, total, offset, hasMore, incomplete: hasMore || offset > 0 };
  }

  private topicRelations(owner: SessionGraphOwner, input: SessionGraphStorageRequest<"topic_relations">, revision: number) {
    const offset = input.offset ?? 0, limit = input.limit ?? 50;
    const selection = `FROM session_graph_relations_v6 r JOIN session_graph_records_v6 f ON f.session_id = r.session_id AND f.id = r.from_id
      JOIN session_graph_records_v6 t ON t.session_id = r.session_id AND t.id = r.to_id
      WHERE r.session_id = ? AND f.topic_id = ? AND t.topic_id = ? AND json_extract(r.payload_json, '$.kind') = ?`;
    const params = [owner.sessionId, input.fromTopicId, input.toTopicId, input.kind];
    const total = (this.db.prepare(`SELECT count(*) AS n ${selection}`).get(...params) as { n: number }).n;
    const items = (this.db.prepare(`SELECT r.payload_json ${selection} ORDER BY r.id LIMIT ? OFFSET ?`).all(...params, limit, offset) as JsonRow[]).map(decode<SessionGraphRelation>);
    const ids = [...new Set(items.flatMap((relation) => [relation.fromId, relation.toId]))];
    const endpoints = ids.length ? (this.db.prepare(`SELECT ${summaryProjection} FROM session_graph_records_v6 WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).all(owner.sessionId, ...ids) as JsonRow[]).map((row) => {
      const { id, topicId, title, kind, validity } = readSummary(row);
      return { id, topicId, title, kind, ...(validity ? { validity } : {}) };
    }) : [];
    const hasMore = offset + items.length < total;
    return { status: "ok", revision, items, total, offset, hasMore, incomplete: hasMore || offset > 0, endpoints };
  }

  execute<K extends SessionGraphStorageOperation>(owner: SessionGraphOwner, operation: K, request: SessionGraphStorageRequest<K>, identity?: SessionGraphIdentity, actorSnapshots: SessionGraphIdentity[] = []): SessionGraphStorageResult<K> {
    const input = sessionGraphStorageRequestSchemas[operation].parse(request);
    if (operation === "apply") assertRuntimeTurnAdmission();
    this.db.exec(operation === "apply" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      if (!this.db.prepare("SELECT 1 FROM sessions_v6 WHERE id = ? AND incarnation_id = ?").get(owner.sessionId, owner.incarnationId)) throw new Error("Session Graph owner is stale or unavailable.");
      const revision = (this.db.prepare("SELECT revision FROM session_graphs_v6 WHERE session_id = ?").get(owner.sessionId) as { revision: number } | undefined)?.revision ?? 0;
      let output: unknown;
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision) output = { status: "conflict", revision };
      else if (operation === "apply") output = this.apply(owner, input as SessionGraphRequest<"apply">, revision, identity, actorSnapshots);
      else if (operation === "list_topics") {
        const page = input as SessionGraphRequest<"list_topics">;
        const limit = page.limit ?? 50, offset = page.offset ?? 0;
        const total = (this.db.prepare("SELECT count(*) AS n FROM session_graph_topics_v6 WHERE session_id = ?").get(owner.sessionId) as { n: number }).n;
        const items = this.db.prepare("SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM session_graph_topics_v6 WHERE session_id = ? ORDER BY title, id LIMIT ? OFFSET ?").all(owner.sessionId, limit, offset) as SessionGraphTopic[];
        output = { status: "ok", revision, items, total, offset, hasMore: offset + items.length < total, incomplete: offset + items.length < total || offset > 0 };
      } else if (operation === "overview") output = this.overview(owner, input as SessionGraphStorageRequest<"overview">, revision);
      else if (operation === "topic_relations") output = this.topicRelations(owner, input as SessionGraphStorageRequest<"topic_relations">, revision);
      else if (operation === "topic_records") output = this.topicRecords(owner, input as SessionGraphStorageRequest<"topic_records">, revision);
      else {
        output = this.read(owner, operation as SessionGraphOperation, input, revision);
        if (operation === "get_topic_view") Object.assign(output as object, { recency: this.recordRecency(owner, (input as SessionGraphRequest<"get_topic_view">).topicId) });
      }
      if (operation === "apply") assertRuntimeTurnAdmission();
      this.db.exec("COMMIT");
      return output as SessionGraphStorageResult<K>;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private validateIdentity(owner: SessionGraphOwner, identity: SessionGraphIdentity): void {
    if (identity.sessionId === owner.sessionId && identity.role === "main") return;
    if (identity.role !== "auxiliary" || !this.db.prepare("SELECT 1 FROM auxiliary_sessions WHERE id = ? AND parent_session_id = ?").get(identity.sessionId, owner.sessionId)) throw new Error("Session Graph identity is outside the parent session.");
  }

  private apply(owner: SessionGraphOwner, input: SessionGraphRequest<"apply">, revision: number, identity: SessionGraphIdentity | undefined, snapshots: SessionGraphIdentity[]) {
    assertRuntimeTurnAdmission();
    if (!identity) throw new Error("Session Graph recorder identity is required.");
    this.validateIdentity(owner, identity);
    for (const snapshot of snapshots) this.validateIdentity(owner, snapshot);
    const latest = this.db.prepare("SELECT max(updated_at) AS latest FROM session_graph_records_v6 WHERE session_id = ?").get(owner.sessionId) as { latest: string | null };
    const now = new Date(Math.max(Date.now(), latest.latest ? Date.parse(latest.latest) + 1 : 0)).toISOString();
    this.db.prepare("INSERT OR IGNORE INTO session_graphs_v6(session_id, revision) VALUES (?, 0)").run(owner.sessionId);
    for (const topic of input.topics ?? []) this.db.prepare(`INSERT INTO session_graph_topics_v6(session_id, id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`).run(owner.sessionId, topic.id, topic.title, now, now);
    for (const record of input.records ?? []) {
      const oldRow = this.db.prepare("SELECT payload_json FROM session_graph_records_v6 WHERE session_id = ? AND id = ?").get(owner.sessionId, record.id) as JsonRow | undefined;
      const old = oldRow ? decode<SessionGraphRecord>(oldRow) : undefined;
      const merged: Record<string, unknown> = { ...old };
      for (const key of ["actorSnapshot", "recordedBy", "createdAt", "updatedAt"]) delete merged[key];
      for (const [key, value] of Object.entries(record)) {
        if (value === null) delete merged[key];
        else if (value !== undefined) merged[key] = value;
      }
      merged.actor ??= { sessionId: identity.sessionId };
      if (old?.adoptionOrigin && record.adoption !== undefined && record.adoption !== old.adoption && record.adoptionOrigin === undefined) {
        throw new Error("Changing adoption requires an explicit adoptionOrigin, or null to clear it.");
      }
      const content = sessionGraphRecordSchema.parse(merged);
      this.validateRecordState(content);
      const actorId = content.actor.sessionId;
      const sameActor = old?.actor.sessionId === actorId;
      // Retained snapshots do not exempt an actor from commit-time membership checks.
      const candidate = snapshots.find((entry) => entry.sessionId === actorId)
        ?? (identity.sessionId === actorId ? identity : sameActor ? old.actorSnapshot : undefined);
      if (!candidate) throw new Error("Session Graph actor snapshot is required.");
      this.validateIdentity(owner, candidate);
      const actorSnapshot = sameActor ? old.actorSnapshot : candidate;
      const value: SessionGraphRecord = { ...content, actorSnapshot, recordedBy: old?.recordedBy ?? identity, createdAt: old?.createdAt ?? now, updatedAt: now };
      this.db.prepare(`INSERT INTO session_graph_records_v6(session_id, id, topic_id, kind, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, id) DO UPDATE SET topic_id = excluded.topic_id, kind = excluded.kind, payload_json = excluded.payload_json, updated_at = excluded.updated_at`).run(owner.sessionId, record.id, record.topicId, record.kind, JSON.stringify(value), now);
    }
    for (const id of input.removeRelationIds ?? []) this.db.prepare("DELETE FROM session_graph_relations_v6 WHERE session_id = ? AND id = ?").run(owner.sessionId, id);
    for (const relation of input.relations ?? []) this.db.prepare(`INSERT INTO session_graph_relations_v6(session_id, id, from_id, to_id, payload_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET from_id = excluded.from_id, to_id = excluded.to_id, payload_json = excluded.payload_json`).run(owner.sessionId, relation.id, relation.fromId, relation.toId, JSON.stringify(relation));
    this.db.prepare("UPDATE session_graphs_v6 SET revision = revision + 1 WHERE session_id = ? AND revision = ?").run(owner.sessionId, revision);
    return { status: "ok", revision: revision + 1 } as const;
  }

  private validateRecordState(record: SessionGraphRecordInput): void {
    if (record.adoption !== undefined && record.kind !== "decision") throw new Error("Adoption is only valid for decisions.");
    if (record.progress !== undefined && record.kind !== "activity") throw new Error("Progress is only valid for activities.");
    if (record.resolution !== undefined && record.kind !== "issue") throw new Error("Resolution is only valid for issues.");
    if (record.result !== undefined && record.kind !== "activity" && record.kind !== "observation") throw new Error("Result is only valid for activities and observations.");
    if (record.adoptionOrigin !== undefined && record.adoption !== "accepted" && record.adoption !== "declined") throw new Error("Adoption origin requires an accepted or declined decision.");
  }

  private read(owner: SessionGraphOwner, operation: SessionGraphOperation, request: unknown, revision: number) {
    const input = request as SessionGraphRequest<"recent"> & { ids?: string[]; query?: string };
    const limit = input.limit ?? 50, offset = input.offset ?? 0, relationOffset = input.relationOffset ?? 0;
    const where = ["session_id = ?"], params: SQLInputValue[] = [owner.sessionId];
    for (const key of ["topicId", "actorSessionId", "recordedBySessionId", "kind", "adoption", "progress", "result", "resolution"] as const) {
      if (input[key] === undefined) continue;
      const expr = key === "topicId" ? "topic_id" : key === "kind" ? "kind" : `json_extract(payload_json, '$.${key === "actorSessionId" ? "actor.sessionId" : key === "recordedBySessionId" ? "recordedBy.sessionId" : key}')`;
      where.push(`${expr} = ?`); params.push(input[key]!);
    }
    if (input.ids) { where.push(`id IN (${input.ids.map(() => "?").join(",")})`); params.push(...input.ids); }
    if (input.query) {
      where.push("(instr(lower(json_extract(payload_json, '$.title')), lower(?)) > 0 OR instr(lower(json_extract(payload_json, '$.detail')), lower(?)) > 0)");
      params.push(input.query, input.query);
    }
    if (operation === "context") where.push(`json_extract(payload_json, '$.validity') IS NULL AND
      (kind IN ('requirement', 'constraint') OR (kind = 'decision' AND json_extract(payload_json, '$.adoption') = 'accepted')
       OR (kind = 'issue' AND COALESCE(json_extract(payload_json, '$.resolution'), 'open') = 'open')
       OR (kind = 'activity' AND COALESCE(json_extract(payload_json, '$.progress'), 'planned') NOT IN ('completed', 'canceled')))`);
    const predicate = where.join(" AND ");
    // UNION terminates cycles; dependencies point outward, evidence/checks point inward.
    const selection = operation === "context" ? `WITH RECURSIVE seeds AS (SELECT id FROM session_graph_records_v6 WHERE ${predicate}), selected(id) AS (
      SELECT id FROM seeds UNION SELECT CASE WHEN json_extract(r.payload_json, '$.kind') = 'depends_on' THEN r.to_id ELSE r.from_id END
      FROM session_graph_relations_v6 r JOIN selected s ON
        (json_extract(r.payload_json, '$.kind') = 'depends_on' AND r.from_id = s.id)
        OR (json_extract(r.payload_json, '$.kind') IN ('supports', 'checks') AND r.to_id = s.id)
      WHERE r.session_id = ?
    ) SELECT * FROM session_graph_records_v6 WHERE session_id = ? AND id IN (SELECT id FROM selected)`
      : `SELECT * FROM session_graph_records_v6 WHERE ${predicate}`;
    const queryParams = operation === "context" ? [...params, owner.sessionId, owner.sessionId] : params;
    const total = (this.db.prepare(`SELECT count(*) AS n FROM (${selection})`).get(...queryParams) as { n: number }).n;
    const rows = this.db.prepare(`${selection} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...queryParams, limit, offset) as JsonRow[];
    const items = rows.map(decode<SessionGraphRecord>);
    const ids = items.map((item) => item.id);
    let relations: SessionGraphRelation[] = [], externalEndpoints: SessionGraphEndpoint[] = [], edgesTruncated = false;
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const edges = this.db.prepare(`SELECT payload_json FROM session_graph_relations_v6 WHERE session_id = ? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders})) ORDER BY id LIMIT ? OFFSET ?`).all(owner.sessionId, ...ids, ...ids, SESSION_GRAPH_RELATION_LIMIT + 1, relationOffset) as JsonRow[];
      edgesTruncated = edges.length > SESSION_GRAPH_RELATION_LIMIT;
      relations = edges.slice(0, SESSION_GRAPH_RELATION_LIMIT).map(decode<SessionGraphRelation>);
      const external = [...new Set(relations.flatMap((edge) => [edge.fromId, edge.toId]).filter((id) => !ids.includes(id)))];
      if (external.length) externalEndpoints = (this.db.prepare(`SELECT payload_json FROM session_graph_records_v6 WHERE session_id = ? AND id IN (${external.map(() => "?").join(",")}) ORDER BY id`).all(owner.sessionId, ...external) as JsonRow[]).map((row) => {
        const value = decode<SessionGraphRecord>(row);
        return { id: value.id, topicId: value.topicId, title: value.title, kind: value.kind, ...(value.validity ? { validity: value.validity } : {}) };
      });
    }
    const hasMore = offset + items.length < total;
    return { status: "ok", revision, items, total, offset, hasMore, incomplete: hasMore || offset > 0 || relationOffset > 0 || edgesTruncated,
      relations, externalEndpoints, relationsTruncated: edgesTruncated, relationOffset, relationsHasMore: edgesTruncated };
  }
}
