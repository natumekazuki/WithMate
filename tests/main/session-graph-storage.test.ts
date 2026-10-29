import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionGraphStorageV6 } from "../../src-electron/session-graph/session-graph-storage-v6.js";
import { AuxiliarySessionStorage } from "../../src-electron/auxiliary/auxiliary-session-storage.js";
import { openAppDatabase } from "../../src-electron/storage/sqlite-connection.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { SessionGraphIdentity, SessionGraphRecordInput, SessionGraphRequest, SessionGraphOperationResult } from "../../src-shared/session-graph/session-graph-contract.js";

function newSession(id: string, workspacePath: string) {
  return buildNewSession({ id, taskTitle: "Graph", workspaceLabel: "workspace", workspacePath,
    branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE });
}
const identity: SessionGraphIdentity = { sessionId: "main", sessionTitle: "Main", role: "main" };
function record(id: string, topicId = "topic"): SessionGraphRecordInput {
  return { id, topicId, kind: "requirement", title: id, detail: "Markdown **content**", scope: "feature", origin: { type: "agent" }, references: [] };
}

// @test-value v2
// kind = "contract"
// claim = "新規の担当は呼出元から解決し、別agentの通常更新とユーザー採用で担当snapshot・初回記録者・内容由来を保持し、明示担当変更と任意属性解除だけを反映する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md#記録" }
// fault = "省略を欠損として保存する、採用で由来や担当を上書きする、同CharacterのSessionを同一視する、または所属を失った担当を保存する"
// observable = "SQLite get/context/filterで返る担当・各由来・任意属性・記録者・snapshotと失敗後のrevision"
// observation_boundary = "public-boundary"
// scope = "SessionGraphStorageV6の新規と通常更新と明示変更"
// lifecycle = "permanent"
// impact = "共有要求や判断の帰属喪失と採用者の誤表示を防ぐ"
// distinction = "型や入力schemaではDBの既存値とのmerge・所属検証・検索投影を保証できず、小規模な実DBで観測する"
// @end-test-value
test("Session Graph preserves responsibility and provenance across agent updates", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-graph-attribution-"));
  const dbPath = path.join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const auxiliary = new AuxiliarySessionStorage(dbPath);
  const db = openAppDatabase(dbPath);
  const graph = new SessionGraphStorageV6(dbPath);
  try {
    const main = sessions.insertSession(newSession("main", temporary));
    const owner = { sessionId: main.id, incarnationId: getSessionIncarnationId(main) };
    db.prepare("INSERT INTO auxiliary_sessions(id, parent_session_id, status, created_at, updated_at) VALUES ('aux', 'main', 'active', 'time', 'time')").run();
    const a: SessionGraphIdentity = { ...identity, character: { id: "same-character", name: "Character", icon: "original.png" } };
    const b: SessionGraphIdentity = { ...a, sessionId: "aux", sessionTitle: "Auxiliary", role: "auxiliary" };
    const body = { id: "proposal", topicId: "topic", kind: "decision" as const, title: "Proposal", detail: "Plan", scope: "feature", references: [] };
    graph.execute(owner, "apply", { expectedRevision: 0, topics: [{ id: "topic", title: "Topic" }], records: [
      { ...body, origin: { type: "agent" }, adoption: "proposed", actorRole: "Implementation", fields: { reason: "requested" } },
      { ...record("request"), origin: { type: "user" } },
      { ...record("external"), origin: { type: "external", label: "CI" } },
    ] }, a);
    graph.execute(owner, "apply", { expectedRevision: 1, records: [{ ...record("aux-request"), origin: { type: "user" } }] }, b);
    graph.execute(owner, "apply", { expectedRevision: 2, records: [{ ...body, adoption: "accepted", adoptionOrigin: { type: "user" } }] }, b);
    graph.execute(owner, "apply", { expectedRevision: 3, records: [{ ...body, title: "Accepted Proposal" }] }, b);
    const read = () => {
      const result = graph.execute(owner, "get", { ids: ["proposal"] });
      assert.equal(result.status, "ok");
      if (result.status !== "ok") throw new Error("Unexpected conflict");
      return result.items[0];
    };
    const accepted = read();
    assert.deepEqual(accepted.actor, { sessionId: "main" });
    assert.deepEqual(accepted.actorSnapshot, a);
    assert.deepEqual(accepted.recordedBy, a);
    assert.deepEqual(accepted.origin, { type: "agent" });
    assert.deepEqual(accepted.adoptionOrigin, { type: "user" });
    assert.equal(accepted.adoption, "accepted");
    assert.equal(accepted.actorRole, "Implementation");
    assert.deepEqual(accepted.fields, { reason: "requested" });
    for (const filter of [{ actorSessionId: "main" }, { recordedBySessionId: "main" }]) {
      const context = graph.execute(owner, "context", filter);
      assert.equal(context.status, "ok");
      if (context.status === "ok") assert.deepEqual(context.items.map((item) => item.id).sort(), ["external", "proposal", "request"]);
    }
    const auxRecords = graph.execute(owner, "recent", { actorSessionId: "aux" });
    if (auxRecords.status !== "ok") throw new Error("Unexpected conflict");
    assert.deepEqual(auxRecords.items.map((item) => item.id), ["aux-request"]);
    assert.deepEqual(auxRecords.items[0].actorSnapshot, b);
    assert.throws(() => graph.execute(owner, "apply", { expectedRevision: 4, records: [{ ...body, adoption: "declined" }] }, b), /explicit adoptionOrigin/);
    graph.execute(owner, "apply", { expectedRevision: 4, records: [{ ...body, actor: { sessionId: "aux" }, actorRole: null, fields: null }] }, b);
    assert.deepEqual(read().actorSnapshot, b);
    assert.deepEqual(read().recordedBy, a);
    assert.equal(read().actorRole, undefined);
    assert.equal(read().fields, undefined);
    graph.execute(owner, "apply", { expectedRevision: 5, records: [{ ...body, adoption: "declined", adoptionOrigin: { type: "agent" } }] }, { ...a, character: { ...a.character!, name: "Renamed" } });
    assert.deepEqual(read().actorSnapshot, b);
    assert.deepEqual(read().adoptionOrigin, { type: "agent" });
    graph.execute(owner, "apply", { expectedRevision: 6, records: [{ ...body, adoption: null, adoptionOrigin: null }] }, a);
    assert.equal(read().adoption, undefined);
    assert.equal(read().adoptionOrigin, undefined);
    assert.throws(() => graph.execute(owner, "apply", { expectedRevision: 7, records: [{ ...body, id: "missing-origin" }] }, a), /origin/);
    assert.throws(() => graph.execute(owner, "apply", { expectedRevision: 7, records: [{ ...body, adoptionOrigin: { type: "user" } }] }, a), /requires an accepted or declined/);
    db.prepare("DELETE FROM auxiliary_sessions WHERE id = 'aux'").run();
    assert.throws(() => graph.execute(owner, "apply", { expectedRevision: 7, records: [body] }, a), /outside the parent/);
    const after = graph.execute(owner, "list_topics", {});
    assert.equal(after.revision, 7);
  } finally { graph.close(); db.close(); auxiliary.close(); sessions.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "参照は新規・通常更新・未変更値の再保存で同じ形式検証を受け、正しいhrefは文字列を変えず保持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/894" }
// fault = "更新だけ検証を迂回する、保存済みの不正hrefを例外受理する、またはquery/fragmentを改変する"
// observable = "SQLite applyの拒否とgetのhrefおよびrevision"
// observation_boundary = "public-boundary"
// scope = "SessionGraphStorageV6 references保存境界"
// lifecycle = "permanent"
// impact = "相対参照による誤った対象の解決と保存値の意図しない変更を防ぐ"
// distinction = "validator単体testでは保存時の適用漏れを検出できず、既存DB値を含む実保存経路を確認する"
// @end-test-value
test("Session Graph validates every reference on creation and update", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-graph-href-"));
  const dbPath = path.join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  const graph = new SessionGraphStorageV6(dbPath);
  const db = openAppDatabase(dbPath);
  try {
    const main = sessions.insertSession(newSession("main", temporary));
    const owner = { sessionId: main.id, incarnationId: getSessionIncarnationId(main) };
    const href = "https://example.com/review?q=a%2Fb#part%202";
    const input = { ...record("reference"), references: [{ role: "evidence" as const, label: "Review", href }] };
    graph.execute(owner, "apply", { expectedRevision: 0, topics: [{ id: "topic", title: "Topic" }], records: [input] }, identity);
    graph.execute(owner, "apply", { expectedRevision: 1, records: [{ ...input, title: "Updated" }] }, identity);
    const result = graph.execute(owner, "get", { ids: ["reference"] });
    if (result.status !== "ok") throw new Error("Unexpected conflict");
    assert.equal(result.items[0].references[0].href, href);
    for (const invalid of ["report.md", "C:report.md", "//host/report", "https:"]) {
      for (const id of ["new-record", "reference"]) assert.throws(() => graph.execute(owner, "apply", { expectedRevision: 2,
        records: [{ ...input, id, references: [{ ...input.references[0], href: invalid }] }] }, identity), /absolute file path/);
    }
    db.prepare("UPDATE session_graph_records_v6 SET payload_json = json_set(payload_json, '$.references[0].href', 'relative.md') WHERE id = 'reference'").run();
    const reread = graph.execute(owner, "get", { ids: ["reference"] });
    if (reread.status !== "ok") throw new Error("Unexpected conflict");
    assert.throws(() => graph.execute(owner, "apply", { expectedRevision: 2, records: [{ ...input, references: reread.items[0].references }] }, identity), /absolute file path/);
    assert.equal(graph.execute(owner, "list_topics", {}).revision, 2);
  } finally { graph.close(); db.close(); sessions.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "Graphのbatchはrevision競合と不正endpointで部分保存せず、更新でも初回recorderとactor snapshotを保持する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "競合時や不正relationでtopicだけ保存するか、更新したidentityで記録主体を上書きする"
// observable = "apply結果、topic一覧、get結果のrecorder・actor・revision"
// observation_boundary = "public-boundary"
// scope = "SessionGraphStorageV6の実SQLite transaction"
// lifecycle = "permanent"
// impact = "同時更新による要求喪失と記録者の誤帰属を防ぐ"
// distinction = "schemaや型検査では保証しないSQLite rollbackと永続化snapshotを少数batchで確認する"
// @end-test-value
test("Session Graph batches are atomic and preserve attribution", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-graph-"));
  const dbPath = path.join(temporary, "withmate-v6.db");
  const sessions = new SessionStorageV6(dbPath);
  let graph: SessionGraphStorageV6 | null = null;
  try {
    const session = sessions.insertSession(newSession("main", temporary));
    const owner = { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
    graph = new SessionGraphStorageV6(dbPath);
    assert.deepEqual(graph.execute(owner, "apply", { expectedRevision: 0, topics: [{ id: "topic", title: "Topic" }], records: [record("req")] }, identity), { status: "ok", revision: 1 });
    assert.deepEqual(graph.execute(owner, "apply", { expectedRevision: 0, topics: [{ id: "conflict", title: "Conflict" }] }, identity), { status: "conflict", revision: 1 });
    assert.throws(() => graph!.execute(owner, "apply", { expectedRevision: 1, topics: [{ id: "rollback", title: "Rollback" }], relations: [{ id: "bad", fromId: "req", toId: "missing", kind: "depends_on" }] }, identity), /FOREIGN KEY/);
    const topics = graph.execute(owner, "list_topics", {});
    assert.equal(topics.status, "ok");
    if (topics.status === "ok") assert.deepEqual(topics.items.map((topic) => topic.id), ["topic"]);
    graph.execute(owner, "apply", { expectedRevision: 1, records: [{ ...record("req"), title: "Updated" }] }, { ...identity, sessionTitle: "Renamed" });
    graph.close(); graph = new SessionGraphStorageV6(dbPath);
    const reread = graph.execute(owner, "get", { ids: ["req"] });
    assert.equal(reread.status, "ok");
    if (reread.status === "ok") {
      assert.equal(reread.revision, 2); assert.equal(reread.items[0].title, "Updated");
      assert.deepEqual(reread.items[0].recordedBy, identity); assert.deepEqual(reread.items[0].actorSnapshot, identity);
    }
    assert.throws(() => graph!.execute(owner, "apply", { expectedRevision: 2, records: [{ ...record("foreign"), actor: { sessionId: "other" } }] }, identity, [{ sessionId: "other", sessionTitle: "Other", role: "main" }]), /outside/);
    sessions.deleteSession("main");
    const recreated = sessions.insertSession(newSession("main", temporary));
    assert.throws(() => graph!.execute(owner, "recent", {}), /stale/);
    const fresh = graph.execute({ sessionId: "main", incarnationId: getSessionIncarnationId(recreated) }, "list_topics", {});
    assert.equal(fresh.status, "ok");
    if (fresh.status === "ok") { assert.equal(fresh.revision, 0); assert.deepEqual(fresh.items, []); }
  } finally { graph?.close(); sessions.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "40件pageと200件既知record refreshと詳細getで400関係を独立page取得でき、revision競合・stable IDの削除とendpoint変更を区別する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "400件丁度を欠落扱いする、401件目へ到達できない、古いrevisionの続きが混在する、削除やendpoint変更が反映されない"
// observable = "実SQLiteの各readのitems・関係ID・externalEndpoints・continuation flagと競合結果"
// observation_boundary = "public-boundary"
// scope = "SessionGraphStorageV6の関係page取得・atomic更新"
// lifecycle = "permanent"
// impact = "rendererとagentが不完全な接続を完全と判断することを防ぐ"
// distinction = "型検査とrendererのmockでは保証できないSQL LIMITと返却flagの境界を確認する"
// @end-test-value
test("Session Graph reads page relations within revision-bound record scopes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-graph-relations-"));
  const sessions = new SessionStorageV6(path.join(temporary, "withmate-v6.db"));
  let graph: SessionGraphStorageV6 | null = null;
  try {
    const session = sessions.insertSession(newSession("main", temporary));
    const owner = { sessionId: session.id, incarnationId: getSessionIncarnationId(session) };
    graph = new SessionGraphStorageV6(path.join(temporary, "withmate-v6.db"));
    const records = [record("hub"), ...Array.from({ length: 79 }, (_, index) => record(`isolated-${index}`)),
      ...Array.from({ length: 401 }, (_, index) => record(`leaf-${index}`, "other"))];
    let revision = 0;
    for (let offset = 0; offset < records.length; offset += 200) graph.execute(owner, "apply", {
      expectedRevision: revision++, topics: [{ id: "topic", title: "Topic" }, { id: "other", title: "Other" }], records: records.slice(offset, offset + 200),
    }, identity);
    const relations = Array.from({ length: 401 }, (_, index) => ({ id: `edge-${index}`, fromId: "hub", toId: `leaf-${index}`, kind: "depends_on" as const }));
    graph.execute(owner, "apply", { expectedRevision: revision++, relations: relations.slice(0, 400) }, identity);
    const complete = graph.execute(owner, "get", { ids: ["hub"] });
    assert.equal(complete.status, "ok");
    if (complete.status === "ok") {
      assert.equal(complete.relations.length, 400); assert.equal(complete.relationsTruncated, false); assert.equal(complete.incomplete, false);
      assert.equal(complete.relationOffset, 0); assert.equal(complete.relationsHasMore, false);
    }
    graph.execute(owner, "apply", { expectedRevision: revision++, relations: relations.slice(400) }, identity);
    const partial = graph.execute(owner, "get", { ids: ["hub"] });
    assert.equal(partial.status, "ok");
    if (partial.status === "ok") {
      assert.equal(partial.relations.length, 400); assert.equal(partial.relationsTruncated, true); assert.equal(partial.incomplete, true);
    }
    const requests: Array<{ operation: "get_topic_view"; input: SessionGraphRequest<"get_topic_view"> } | { operation: "get"; input: SessionGraphRequest<"get"> }> = [
      { operation: "get_topic_view", input: { topicId: "topic", limit: 40 } },
      { operation: "get", input: { ids: ["hub", ...records.filter((entry) => entry.topicId === "other").slice(0, 199).map((entry) => entry.id)], limit: 200 } },
      { operation: "get", input: { ids: ["hub"] } },
    ];
    for (const request of requests) {
      const first: SessionGraphOperationResult<"get"> = graph.execute(owner, request.operation, { ...request.input, expectedRevision: revision });
      const next: SessionGraphOperationResult<"get"> = graph.execute(owner, request.operation, { ...request.input, expectedRevision: revision, relationOffset: 400 });
      assert.equal(first.status, "ok"); assert.equal(next.status, "ok");
      if (first.status !== "ok" || next.status !== "ok") continue;
      assert.equal(first.items.length, request.operation === "get_topic_view" ? 40 : request.input.ids.length);
      assert.deepEqual(next.items, first.items);
      assert.equal(first.relationsHasMore, true); assert.equal(next.relationsHasMore, false);
      assert.equal(next.relationOffset, 400); assert.equal(next.relationsTruncated, false); assert.equal(next.incomplete, true);
      assert.equal(next.relations.length, 1);
      assert.deepEqual([...first.relations, ...next.relations].map((edge) => edge.id).sort(), relations.map((edge) => edge.id).sort());
      assert.ok(next.externalEndpoints.every((endpoint) => !next.items.some((item) => item.id === endpoint.id)));
    }
    const moreRecords = graph.execute(owner, "get_topic_view", { topicId: "topic", limit: 40, offset: 40, expectedRevision: revision });
    assert.equal(moreRecords.status, "ok");
    if (moreRecords.status === "ok") {
      assert.equal(moreRecords.items.length, 40); assert.equal(moreRecords.hasMore, false);
      assert.equal(moreRecords.relationOffset, 0); assert.equal(moreRecords.relationsHasMore, false);
      assert.deepEqual(moreRecords.relations, []);
    }
    const oldRevision = revision;
    graph.execute(owner, "apply", { expectedRevision: revision++, removeRelationIds: ["edge-0"],
      relations: [{ ...relations[1], fromId: "leaf-0", toId: "leaf-2" }] }, identity);
    assert.deepEqual(graph.execute(owner, "get", { ids: ["hub"], relationOffset: 400, expectedRevision: oldRevision }), { status: "conflict", revision });
    const updated = graph.execute(owner, "get", { ids: ["hub"], expectedRevision: revision });
    assert.equal(updated.status, "ok");
    if (updated.status === "ok") {
      assert.equal(updated.relationsHasMore, false); assert.equal(updated.relations.length, 399);
      assert.ok(updated.relations.every((edge) => edge.id !== "edge-0" && edge.id !== "edge-1"));
    }
    const moved = graph.execute(owner, "get", { ids: ["leaf-0"], expectedRevision: revision });
    assert.equal(moved.status, "ok");
    if (moved.status === "ok") assert.deepEqual(moved.relations, [{ ...relations[1], fromId: "leaf-0", toId: "leaf-2" }]);
  } finally { graph?.close(); sessions.close(); await rm(temporary, { recursive: true, force: true }); }
});

// @test-value v2
// kind = "contract"
// claim = "実Workerは失効turnのGraph保存を拒否しreadに更新順・context選別・cross-topic endpointとrevision付きpageを返す"
// oracle = { type = "contract", ref = "docs/design/session-graph.md" }
// fault = "失効turnを保存するかWorker command未接続、contextから現行要求が欠落、cross-topic依存喪失、変更後のcontinuationを成功にする"
// observable = "失効commandの拒否と未保存revision、Worker経由のrecent/context/topic view/searchと競合結果"
// observation_boundary = "public-boundary"
// scope = "V6StorageWorkerBundle sessionGraph.executeの実Worker/SQLite read"
// lifecycle = "permanent"
// impact = "agentとrendererが古いpageや誤った現在contextを根拠に作業することを防ぐ"
// distinction = "同期storage testと型検査では確認できない許可commandとtransport、複数のread投影を小規模fixtureで確認する"
// @end-test-value
test("Session Graph Worker reads preserve context, pagination and current ordering", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-graph-worker-"));
  let bundle: ReturnType<typeof createV6StorageWorkerBundle> | null = null;
  try {
    const { dbPath } = await createOrVerifyV6FreshDatabase(temporary);
    bundle = createV6StorageWorkerBundle({ dbPath, userDataPath: temporary,
      workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
      handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url),
      workerOptions: { execArgv: ["--import", "tsx"] } });
    await bundle.initialize();
    const session = await bundle.stores.session.insertSession(newSession("main", temporary));
    const owner = { sessionId: "main", incarnationId: getSessionIncarnationId(session) };
    const graph = bundle.stores.sessionGraph;
    const revoked = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    Atomics.store(new Int32Array(revoked), 0, 1);
    await assert.rejects(bundle.client.call("store.call", { store: "sessionGraph", method: "execute",
      args: [owner, "apply", { expectedRevision: 0, topics: [{ id: "revoked", title: "Revoked" }] }, identity],
      runtimeTurnAdmissionState: revoked }, { mutation: true }), /no longer active/);
    assert.deepEqual(await graph.execute(owner, "list_topics", {}), { status: "ok", revision: 0, items: [], total: 0, offset: 0, hasMore: false, incomplete: false });
    await graph.execute(owner, "apply", { expectedRevision: 0, topics: [{ id: "topic", title: "Topic" }, { id: "other", title: "Other" }],
      records: [record("req"), { ...record("old"), validity: "superseded" }, { ...record("evidence", "other"), kind: "observation", result: "checked" }, { ...record("finished"), kind: "activity", progress: "completed" }],
      relations: [{ id: "dependency", fromId: "evidence", toId: "req", kind: "checks" }] }, identity);
    const context = await graph.execute(owner, "context", { topicId: "topic" });
    assert.equal(context.status, "ok");
    if (context.status === "ok") assert.deepEqual(context.items.map((item) => item.id).sort(), ["evidence", "req"]);
    const view = await graph.execute(owner, "get_topic_view", { topicId: "topic", limit: 1 });
    assert.equal(view.status, "ok");
    if (view.status === "ok") { assert.equal(view.hasMore, true); assert.equal(view.incomplete, true); assert.equal(view.relationsTruncated, false); }
    await new Promise((resolve) => setTimeout(resolve, 5));
    await graph.execute(owner, "apply", { expectedRevision: 1, records: [{ ...record("req"), title: "Most recent" }] }, identity);
    assert.deepEqual(await graph.execute(owner, "recent", { offset: 1, expectedRevision: 1 }), { status: "conflict", revision: 2 });
    const latest = await graph.execute(owner, "recent", { limit: 1 });
    assert.equal(latest.status, "ok");
    if (latest.status === "ok") assert.equal(latest.items[0].id, "req");
    const topic = await graph.execute(owner, "get_topic_view", { topicId: "topic" });
    assert.equal(topic.status, "ok");
    if (topic.status === "ok") assert.deepEqual(topic.externalEndpoints.map((entry) => entry.id), ["evidence"]);
    const search = await graph.execute(owner, "search", { query: "Most recent", actorSessionId: "main" });
    assert.equal(search.status, "ok");
    if (search.status === "ok") assert.deepEqual(search.items.map((entry) => entry.id), ["req"]);
  } finally { await bundle?.client.close(); await rm(temporary, { recursive: true, force: true }); }
});
