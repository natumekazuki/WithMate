import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStorageV6 } from "../../src-electron/session/session-storage-v6.js";
import { createV6StorageWorkerBundle } from "../../src-electron/storage/storage-worker-bundle.js";
import { openAppDatabase } from "../../src-electron/storage/sqlite-connection.js";
import { SessionGraphApplicationService } from "../../src-electron/session-graph/session-graph-application-service.js";
import { buildNewSession, getSessionIncarnationId } from "../../src-shared/session/session-state.js";
import { DEFAULT_APPROVAL_MODE } from "../../src-shared/settings/approval-mode.js";
import type { SessionGraphIdentity, SessionGraphRecordInput } from "../../src-shared/session-graph/session-graph-contract.js";

const record = (id: string, topicId = "a"): SessionGraphRecordInput => ({ id, topicId, kind: "requirement", title: id, detail: "Long original evidence", scope: "Scope", origin: { type: "user" }, references: [] });

// @test-value v2
// kind = "contract"
// claim = "UI集約は全recordの時刻と現行カテゴリ・担当状態を別々に数え、省略された古い残件と実relation端点へ同一revisionで辿れる"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/901" }
// fault = "表示代表やpageだけから時刻・件数を計算する、撤回条件を現行扱いする、状態を完了へ潰す、方向を落とす、または変更前の続きpageを混在する"
// observable = "実Storage Workerとapplication readのoverview/category/relation/detail結果・conflict・owner失効エラー"
// observation_boundary = "public-boundary"
// scope = "Session Graph UI専用readから実WorkerとSQLiteまで"
// lifecycle = "permanent"
// impact = "全体図から古い未解決や並行担当が消え、誤った現在地を示すことを防ぐ"
// distinction = "型とrenderer mockではSQL集約・thin投影・Worker command・revision transactionを保証できず、小規模実DBで一度に確認する"
// @end-test-value
test("Session Graph UI reads aggregate full scopes and page original evidence at one revision", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "withmate-graph-overview-"));
  let bundle: ReturnType<typeof createV6StorageWorkerBundle> | undefined;
  try {
    const dbPath = path.join(temporary, "withmate-v6.db");
    const sessions = new SessionStorageV6(dbPath);
    const main = sessions.insertSession(buildNewSession({ id: "main", taskTitle: "Graph", workspaceLabel: "workspace", workspacePath: temporary,
      branch: "main", characterId: "character", character: "Character", characterIconPath: "",
      characterThemeColors: { main: "#000000", sub: "#ffffff" }, approvalMode: DEFAULT_APPROVAL_MODE }));
    const db = openAppDatabase(dbPath);
    db.prepare("INSERT INTO auxiliary_sessions(id, parent_session_id, status, created_at, updated_at) VALUES ('aux', 'main', 'active', 'time', 'time')").run();
    db.close(); sessions.close();
    bundle = createV6StorageWorkerBundle({ dbPath, userDataPath: temporary,
      workerUrl: new URL("../../src-electron/storage/storage-worker-entry.ts", import.meta.url),
      handlerModule: new URL("../../src-electron/storage/storage-worker-bundle.ts", import.meta.url), workerOptions: { execArgv: ["--import", "tsx"] } });
    await bundle.initialize();
    const store = bundle.stores.sessionGraph;
    const owner = { sessionId: main.id, incarnationId: getSessionIncarnationId(main) };
    const identity: SessionGraphIdentity = { sessionId: "main", sessionTitle: "Main", role: "main", character: { id: "character", name: "Character", theme: { main: "#000000", sub: "#ffffff" } } };
    const auxiliary: SessionGraphIdentity = { ...identity, sessionId: "aux", sessionTitle: "Aux", role: "auxiliary" };
    let available = true;
    const application = new SessionGraphApplicationService({ getStore: () => store, resolveSession: () => available ? { owner, identity, providerId: "codex", generation: store } : null });
    const records: SessionGraphRecordInput[] = [
      ...Array.from({ length: 6 }, (_, index) => record(`requirement-${index}`)),
      { ...record("constraint"), kind: "constraint" },
      { ...record("withdrawn"), validity: "withdrawn" },
      { ...record("superseded"), validity: "superseded" },
      { ...record("accepted"), kind: "decision", adoption: "accepted", adoptionOrigin: { type: "user" } },
      { ...record("declined"), kind: "decision", adoption: "declined", adoptionOrigin: { type: "agent" } },
      { ...record("finished"), kind: "activity", progress: "completed", result: "reported" },
      { ...record("parallel"), kind: "activity", actor: { sessionId: "aux" }, progress: "in_progress" },
      { ...record("passed"), kind: "observation", result: "passed", origin: { type: "external", label: "CI" } },
      { ...record("failed"), kind: "observation", result: "failed" },
      { ...record("open"), kind: "issue" }, { ...record("resolved"), kind: "issue", resolution: "resolved" },
      record("target", "b"),
    ];
    await store.execute(owner, "apply", { expectedRevision: 0, topics: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "empty", title: "Empty" }], records,
      relations: [ { id: "a-b-1", fromId: "requirement-0", toId: "target", kind: "depends_on", label: "Needs target" },
        { id: "a-b-2", fromId: "requirement-1", toId: "target", kind: "depends_on" },
        { id: "b-a", fromId: "target", toId: "accepted", kind: "supports" } ] }, identity, [auxiliary]);
    const first = await application.read("main", "overview", { limit: 1 });
    if (first.status !== "ok") throw new Error("Unexpected conflict");
    const a = first.items[0];
    assert.equal(first.total, 3); assert.equal(first.hasMore, true); assert.equal(first.incomplete, true);
    assert.equal(a.recordCount, 17); assert.equal(a.requirements.count, 6); assert.equal(a.requirements.records.length, 3);
    assert.equal(a.constraints.count, 1); assert.equal(a.decisions.count, 1); assert.equal(a.issues.count, 1);
    assert.deepEqual(a.observations.states, { "result:failed": 1, "result:passed": 1 });
    assert.deepEqual(a.activities.states, { "progress:completed": 1, "result:reported": 1, "progress:in_progress": 1 });
    assert.deepEqual(a.actors.map((actor) => [actor.identity.sessionId, actor.activities.count]), [["aux", 1], ["main", 1]]);
    assert.deepEqual(a.actors[1].identity.character?.theme, identity.character?.theme);
    assert.equal(a.recency.oldestUpdatedAt, a.recency.newestUpdatedAt); assert.deepEqual(first.recency, a.recency);
    assert.deepEqual(first.topicRelations, [ { fromTopicId: "a", toTopicId: "b", kind: "depends_on", count: 2 }, { fromTopicId: "b", toTopicId: "a", kind: "supports", count: 1 } ]);
    assert.equal(JSON.stringify(first).includes("Long original evidence"), false);
    const remaining = await application.read("main", "topic_records", { topicId: "a", category: "requirements", offset: 3, expectedRevision: 1 });
    if (remaining.status !== "ok") throw new Error("Unexpected conflict");
    assert.equal(remaining.total, 6); assert.equal(remaining.items.length, 3); assert.equal(remaining.hasMore, false);
    assert.deepEqual([...a.requirements.records, ...remaining.items].map((item) => item.id).sort(), records.slice(0, 6).map((item) => item.id));
    const actorWork = await application.read("main", "topic_records", { topicId: "a", category: "activities", actorSessionId: "aux", expectedRevision: 1 });
    if (actorWork.status !== "ok") throw new Error("Unexpected conflict");
    assert.deepEqual(actorWork.items.map((item) => item.id), ["parallel"]);
    const edges = await application.read("main", "topic_relations", { fromTopicId: "a", toTopicId: "b", kind: "depends_on", limit: 1, expectedRevision: 1 });
    if (edges.status !== "ok") throw new Error("Unexpected conflict");
    assert.equal(edges.total, 2); assert.equal(edges.hasMore, true); assert.equal(edges.items[0].label, "Needs target");
    assert.deepEqual(edges.endpoints.map((item) => [item.id, item.topicId]), [["requirement-0", "a"], ["target", "b"]]);
    const nextEdges = await application.read("main", "topic_relations", { fromTopicId: "a", toTopicId: "b", kind: "depends_on", offset: 1, expectedRevision: 1 });
    if (nextEdges.status !== "ok") throw new Error("Unexpected conflict");
    assert.deepEqual(nextEdges.items.map((item) => item.id), ["a-b-2"]); assert.equal(nextEdges.hasMore, false);
    await store.execute(owner, "apply", { expectedRevision: 1, records: [record("requirement-0")] }, { ...identity, character: { ...identity.character!, theme: { main: "#ff0000", sub: "#ff0000" } } });
    const detail = await application.read("main", "get_topic_view", { topicId: "a", offset: 1, limit: 1, expectedRevision: 2 });
    if (detail.status !== "ok") throw new Error("Unexpected conflict");
    assert.equal(detail.recency.oldestUpdatedAt, a.recency.oldestUpdatedAt); assert.ok(detail.recency.newestUpdatedAt! > a.recency.newestUpdatedAt!);
    assert.notEqual(detail.items[0].updatedAt, detail.recency.newestUpdatedAt);
    const original = await application.read("main", "get", { ids: ["requirement-0"] });
    if (original.status !== "ok") throw new Error("Unexpected conflict");
    assert.deepEqual(original.items[0].actorSnapshot.character?.theme, identity.character?.theme);
    await store.execute(owner, "apply", { expectedRevision: 2, topics: [{ id: "a", title: "Renamed" }], removeRelationIds: ["b-a"] }, identity);
    const afterTitle = await application.read("main", "get_topic_view", { topicId: "a" });
    if (afterTitle.status !== "ok") throw new Error("Unexpected conflict");
    assert.deepEqual(afterTitle.recency, detail.recency);
    await store.execute(owner, "apply", { expectedRevision: 3, records: [record("requirement-0", "b")] }, identity);
    assert.deepEqual(await application.read("main", "overview", { offset: 1, expectedRevision: 1 }), { status: "conflict", revision: 4 });
    assert.deepEqual(await application.read("main", "topic_relations", { fromTopicId: "a", toTopicId: "b", kind: "depends_on", offset: 1, expectedRevision: 1 }), { status: "conflict", revision: 4 });
    const moved = await application.read("main", "overview", {});
    if (moved.status !== "ok") throw new Error("Unexpected conflict");
    assert.deepEqual(moved.topicRelations, [{ fromTopicId: "a", toTopicId: "b", kind: "depends_on", count: 1 }]);
    assert.equal(moved.items.find((topic) => topic.id === "a")?.requirements.count, 5);
    assert.deepEqual(moved.items.find((topic) => topic.id === "empty")?.recency, {});
    assert.equal(moved.recency.newestUpdatedAt, moved.items.find((topic) => topic.id === "b")?.latestRecordUpdatedAt);
    available = false;
    await assert.rejects(application.read("main", "overview", {}), /owner is unavailable/);
    await assert.rejects(store.execute({ ...owner, incarnationId: "stale" }, "overview", {}), /stale or unavailable/);
  } finally { await bundle?.client.close(); await rm(temporary, { recursive: true, force: true }); }
});
