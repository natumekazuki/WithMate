import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionGraphOwner, SessionGraphIdentity, SessionGraphOperation, SessionGraphRequest, SessionGraphOperationResult, SessionGraphRecordInput, SessionGraphRecord, SessionGraphRelation, SessionGraphTopic, SessionGraphEndpoint } from "../../src-shared/session-graph/session-graph-contract.js";
import { SESSION_GRAPH_RELATION_LIMIT } from "../../src-shared/session-graph/session-graph-contract.js";
import { sessionGraphOperationRequestSchemas } from "../../src-shared/session-graph/session-graph-operation-schema.js";
import { openAppDatabase } from "../storage/sqlite-connection.js";
import { ensureV6Schema } from "../storage/database-schema-v6.js";
import { assertRuntimeTurnAdmission } from "../platform/memory/runtime-turn-admission.js";

type JsonRow = { payload_json: string };
const decode = <T>(row: JsonRow): T => JSON.parse(row.payload_json) as T;

export class SessionGraphStorageV6 {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) { this.db = openAppDatabase(dbPath); ensureV6Schema(this.db); }
  close(): void { this.db.close(); }

  execute<K extends SessionGraphOperation>(owner: SessionGraphOwner, operation: K, request: SessionGraphRequest<K>, identity?: SessionGraphIdentity, actorSnapshots: SessionGraphIdentity[] = []): SessionGraphOperationResult<K> {
    const input = sessionGraphOperationRequestSchemas[operation].parse(request);
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
      } else output = this.read(owner, operation, input, revision);
      if (operation === "apply") assertRuntimeTurnAdmission();
      this.db.exec("COMMIT");
      return output as SessionGraphOperationResult<K>;
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
      this.validateRecordState(record);
      const oldRow = this.db.prepare("SELECT payload_json FROM session_graph_records_v6 WHERE session_id = ? AND id = ?").get(owner.sessionId, record.id) as JsonRow | undefined;
      const old = oldRow ? decode<SessionGraphRecord>(oldRow) : undefined;
      let actorSnapshot: SessionGraphIdentity | undefined;
      if ("sessionId" in record.actor) {
        const actorId = record.actor.sessionId;
        // Even unchanged actors must still belong to this parent at commit.
        const candidate = snapshots.find((entry) => entry.sessionId === actorId) ?? (identity.sessionId === actorId ? identity : old?.actorSnapshot);
        if (!candidate) throw new Error("Session Graph actor snapshot is required.");
        this.validateIdentity(owner, candidate);
        actorSnapshot = old && "sessionId" in old.actor && old.actor.sessionId === actorId ? old.actorSnapshot : candidate;
      }
      const value: SessionGraphRecord = { ...record, ...(actorSnapshot ? { actorSnapshot } : {}), recordedBy: old?.recordedBy ?? identity, createdAt: old?.createdAt ?? now, updatedAt: now };
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
  }

  private read(owner: SessionGraphOwner, operation: SessionGraphOperation, request: unknown, revision: number) {
    const input = request as SessionGraphRequest<"recent"> & { ids?: string[]; query?: string };
    const limit = input.limit ?? 50, offset = input.offset ?? 0;
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
      const edges = this.db.prepare(`SELECT payload_json FROM session_graph_relations_v6 WHERE session_id = ? AND (from_id IN (${placeholders}) OR to_id IN (${placeholders})) ORDER BY id LIMIT ?`).all(owner.sessionId, ...ids, ...ids, SESSION_GRAPH_RELATION_LIMIT + 1) as JsonRow[];
      edgesTruncated = edges.length > SESSION_GRAPH_RELATION_LIMIT;
      relations = edges.slice(0, SESSION_GRAPH_RELATION_LIMIT).map(decode<SessionGraphRelation>);
      const external = [...new Set(relations.flatMap((edge) => [edge.fromId, edge.toId]).filter((id) => !ids.includes(id)))];
      if (external.length) externalEndpoints = (this.db.prepare(`SELECT payload_json FROM session_graph_records_v6 WHERE session_id = ? AND id IN (${external.map(() => "?").join(",")}) ORDER BY id`).all(owner.sessionId, ...external) as JsonRow[]).map((row) => {
        const value = decode<SessionGraphRecord>(row);
        return { id: value.id, topicId: value.topicId, title: value.title, kind: value.kind, ...(value.validity ? { validity: value.validity } : {}) };
      });
    }
    const hasMore = offset + items.length < total;
    return { status: "ok", revision, items, total, offset, hasMore, incomplete: hasMore || offset > 0 || edgesTruncated, relations, externalEndpoints, relationsTruncated: edgesTruncated };
  }
}
