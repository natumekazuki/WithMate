import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGraphReadResult, SessionGraphRecord, SessionGraphRelation } from "../../src-shared/session-graph/session-graph-contract.js";
import {
  applyGraphRead, applyGraphReadBatch, createGraphReadState, graphReadIsIncomplete, graphReadPendingScopes,
} from "../../src/session-graph/graph-read-state.js";

function record(id: string): SessionGraphRecord {
  const identity = { sessionId: "main", sessionTitle: "Main", role: "main" as const };
  return {
    id, topicId: "topic", kind: "activity", title: id, detail: "", scope: "", references: [],
    origin: { type: "agent" }, actor: { sessionId: "main" }, actorSnapshot: identity, recordedBy: identity,
    createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z",
  };
}
function edge(id: string, fromId = "a", toId = "b"): SessionGraphRelation {
  return { id, fromId, toId, kind: "related" };
}
function read(ids: string[], relations: SessionGraphRelation[], revision = 1, relationOffset = 0, relationsHasMore = false): SessionGraphReadResult {
  return {
    status: "ok", revision, items: ids.map(record), total: ids.length, offset: 0,
    hasMore: false, incomplete: relationsHasMore, relations, externalEndpoints: [],
    relationOffset, relationsHasMore, relationsTruncated: relationsHasMore,
  };
}

// @test-value v2
// kind = "contract"
// claim = "累積400件超でも各scopeの関係を同revisionで完了すると完全であり、部分scopeの続きは同じidsとoffsetを返す"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: MCPと更新" }
// fault = "累積件数を切捨てと誤認するか、関係pageをrecord page件数から継続する"
// observable = "統合関係数、pending scopeのids/nextOffset/expectedRevision、不完全判定"
// observation_boundary = "consumer"
// scope = "rendererのrecord pageと関係page統合"
// lifecycle = "permanent"
// impact = "正常な関係多数Graphの集約を誤停止せず、明示追加取得で全関係へ到達する"
// distinction = "型検査やStorage page単体ではrenderer累積取得の完全性を確認できず、小fixtureで判定境界を保持できる"
// @end-test-value
test("relation completion follows scopes rather than cumulative edge count", () => {
  const first = Array.from({ length: 400 }, (_, index) => edge(`a${index}`));
  let state = createGraphReadState(read(["a"], first, 1, 0, true));
  assert.equal(graphReadIsIncomplete(state), true);
  assert.deepEqual(graphReadPendingScopes(state), [{ ids: ["a"], nextOffset: 400, expectedRevision: 1 }]);
  state = applyGraphRead(state, read(["c"], [edge("c1", "c", "d")]));
  state = applyGraphRead(state, read(["a"], [edge("last")], 1, 400));
  assert.equal(state.relations.length, 402);
  assert.deepEqual(graphReadPendingScopes(state), []);
  assert.equal(graphReadIsIncomplete(state), false);
});

// @test-value v2
// kind = "contract"
// claim = "不完全refreshは既知edgeを未確認として保ち、同scopeの最後のpage後にのみ確認したabsenceを削除する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: MCPと更新" }
// fault = "部分refreshでedgeを消すか、完全確認後もunionで削除edgeを残す"
// observable = "各page適用後のedge ID集合と不完全判定"
// observation_boundary = "consumer"
// scope = "同scopeのrevision更新と関係継続取得"
// lifecycle = "permanent"
// impact = "関係消失の誤表示と解除済み関係の残留を防ぐ"
// distinction = "Storageと型検査が扱わない複数revisionのrenderer保持stateを少数fixtureで検査する"
// @end-test-value
test("partial refresh retains unchecked edges until the same scope completes", () => {
  let state = createGraphReadState(read(["a"], [edge("kept"), edge("removed")]));
  state = applyGraphRead(state, read(["a"], [edge("kept")], 2, 0, true));
  assert.deepEqual(state.relations.map((relation) => relation.id), ["kept", "removed"]);
  assert.equal(graphReadIsIncomplete(state), true);
  state = applyGraphRead(state, read(["a"], [edge("added")], 2, 1));
  assert.deepEqual(state.relations.map((relation) => relation.id), ["kept", "added"]);
  assert.equal(graphReadIsIncomplete(state), false);
});

// @test-value v2
// kind = "contract"
// claim = "詳細getで確認した削除とstable IDのendpoint更新は一覧と同じ関係正本へ反映される"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: MCPと更新" }
// fault = "詳細を独立unionにして削除を戻すかstable IDの旧endpointを残す"
// observable = "詳細read適用後のrelation payloadとendpoint要約ID"
// observation_boundary = "consumer"
// scope = "一覧refreshと詳細getを共有するrenderer関係state"
// lifecycle = "permanent"
// impact = "詳細と図が同じ最新の向き・行き先を示す"
// distinction = "Storageでは成功するstable ID upsertをrendererがどのように統合するかは型検査では保証できない"
// @end-test-value
test("detail reads reconcile deletion and stable ID endpoint changes", () => {
  let state = createGraphReadState(read(["a", "b"], [edge("moving"), edge("removed", "b", "a")]));
  const detail = read(["b"], [edge("moving", "b", "external")], 2);
  detail.externalEndpoints = [{ id: "external", topicId: "other", kind: "requirement", title: "External" }];
  state = applyGraphRead(state, detail);
  assert.deepEqual(state.relations, [edge("moving", "b", "external")]);
  assert.deepEqual(state.externalEndpoints.map((endpoint) => endpoint.id).sort(), ["b", "external"]);
  state = applyGraphRead(state, read(["a", "b"], [edge("moving", "b", "external")], 2));
  assert.equal(graphReadIsIncomplete(state), false);
});

// @test-value v2
// kind = "contract"
// claim = "取得済200recordのrefreshは40record単位の確認を置換し、不完全なら次の関係offsetを保持する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: MCPと更新" }
// fault = "refresh後も旧小scopeを未確認のまま残すか、200record返却を関係完全と誤認する"
// observable = "200record refresh前後のpending scopeと不完全判定"
// observation_boundary = "consumer"
// scope = "40record page追加と200record一括refresh"
// lifecycle = "permanent"
// impact = "既知範囲のrefresh後に不要な取得を繰り返さず実際の関係欠落を表示する"
// distinction = "個々のStorage応答にはないrendererのscope包含と継続状態を固定サイズfixtureで確認する"
// @end-test-value
test("a larger refresh replaces covered page checks without hiding relation pagination", () => {
  const ids = Array.from({ length: 200 }, (_, index) => `record${index}`);
  let state = createGraphReadState();
  for (let offset = 0; offset < 200; offset += 40) state = applyGraphRead(state, read(ids.slice(offset, offset + 40), []));
  const relations = Array.from({ length: 400 }, (_, index) => edge(`r${index}`, ids[0], ids[1]));
  state = applyGraphReadBatch(state, [read(ids, relations, 2, 0, true)], ids);
  assert.deepEqual(graphReadPendingScopes(state), [{ ids: [...ids].sort(), nextOffset: 400, expectedRevision: 2 }]);
  assert.equal(graphReadIsIncomplete(state), true);
  state = applyGraphRead(state, read(ids, [], 2, 400));
  assert.equal(state.relations.length, 400);
  assert.equal(graphReadIsIncomplete(state), false);
  state = applyGraphReadBatch(state, [read(ids.slice(0, 100), [], 3), read(ids.slice(100), [], 3)], ids);
  assert.deepEqual(state.relations, []);
  assert.deepEqual(graphReadPendingScopes(state), []);
  assert.equal(graphReadIsIncomplete(state), false);
});

// @test-value v2
// kind = "contract"
// claim = "新revisionで未再確認scopeはoffset0から再確認が必要で、異revision・異scope・飛びpageを完全確認に混ぜない"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: MCPと更新" }
// fault = "旧revisionの途中offsetや異scopeのpageを受け入れてabsenceを誤確定する"
// observable = "pending scope、拒否されたread/batchの例外、元stateの関係集合"
// observation_boundary = "consumer"
// scope = "refresh時のrevision・scope境界"
// lifecycle = "permanent"
// impact = "同時更新中に未確認の関係を削除済みと扱わない"
// distinction = "各応答の型が正しくても起こる複数read間の整合性を少数fixtureで確認する"
// @end-test-value
test("refresh never completes a scope using pages from another revision or scope", () => {
  let state = createGraphReadState(read(["a"], [edge("old")], 1, 0, true));
  state = applyGraphRead(state, read(["c"], [], 2));
  assert.deepEqual(graphReadPendingScopes(state), [{ ids: ["a"], nextOffset: 0, expectedRevision: 2 }]);
  assert.equal(graphReadIsIncomplete(state), true);
  assert.throws(() => applyGraphRead(state, read(["a"], [], 2, 1)), /start at zero/);
  assert.throws(() => applyGraphRead(state, read(["b"], [], 2, 1)), /start at zero/);
  assert.throws(() => applyGraphRead(state, read(["a"], [], 1)), /older/);
  assert.throws(() => applyGraphReadBatch(state, [read(["a"], [], 2), read(["c"], [], 3)]), /single revision/);
  const started = applyGraphRead(state, read(["a"], [edge("old")], 2, 0, true));
  assert.deepEqual(graphReadPendingScopes(started), [{ ids: ["a"], nextOffset: 1, expectedRevision: 2 }]);
  assert.throws(() => applyGraphRead(started, read(["a"], [], 2, 2)), /start at zero/);
  assert.deepEqual(state.relations, [edge("old")]);
  state = applyGraphRead(state, read(["a"], [], 2));
  assert.deepEqual(state.relations, []);
  assert.equal(graphReadIsIncomplete(state), false);
});
