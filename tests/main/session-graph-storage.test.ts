import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { SessionGraphStorageV6 } from "../../src-electron/session-graph/session-graph-storage-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { createOrVerifyV6FreshDatabase } from "../../src-electron/storage/app-database-v6-bootstrap.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { SessionGraphIdentity, SessionGraphRecordInput } from "../../src-shared/session-graph/session-graph-contract.js";

function newSession(id: string, workspacePath: string) {
  return buildNewSession({ id, taskTitle: "Graph", workspaceLabel: "workspace", workspacePath,
    branch: "main", characterId: "unknown", character: "Unknown", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: DEFAULT_APPROVAL_MODE });
}
const identity: SessionGraphIdentity = { sessionId: "main", sessionTitle: "Main", role: "main" };
function record(id: string, topicId = "topic"): SessionGraphRecordInput {
  return { id, topicId, kind: "requirement", title: id, detail: "Markdown **content**", scope: "feature", actor: { sessionId: "main" }, references: [] };
}

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
      bundledModelCatalogPath: path.join(process.cwd(), "public/model-catalog.json"),
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
    if (view.status === "ok") { assert.equal(view.hasMore, true); assert.equal(view.incomplete, true); }
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
