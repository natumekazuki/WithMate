import assert from "node:assert/strict";
import test from "node:test";
import { sessionGraphRecency } from "../../src/session-graph/graph-recency.js";

const range = {
  oldestUpdatedAt: "2026-10-01T00:00:00.000Z",
  newestUpdatedAt: "2026-10-11T00:00:00.000Z",
};

// @test-value v2
// kind = "invariant"
// claim = "サーバーの全対象時間幅に対し、古・中・新を指定パレットへ対応させ、最新だけを強調する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/895" }
// fault = "取得済み順序や件数を時間幅として用い、新旧の背景または最新判定を取り違える"
// observable = "全対象rangeと各更新日時から返るbackgroundとlatest"
// observation_boundary = "consumer"
// scope = "Session Graph record/Topic共通新しさ表示"
// lifecycle = "permanent"
// impact = "古い残件と最新の活動の視覚的な比較を誤らせる"
// distinction = "型検査では検出できない時刻と表示色の対応を小さな純粋関数で検証する"
// @end-test-value
test("recency uses the complete server time range and shared palette", () => {
  assert.deepEqual(sessionGraphRecency(range.oldestUpdatedAt, range), { background: "#1C212B", latest: false });
  assert.deepEqual(sessionGraphRecency("2026-10-06T00:00:00.000Z", range), { background: "#263243", latest: false });
  assert.deepEqual(sessionGraphRecency(range.newestUpdatedAt, range), { background: "#34465A", latest: true });
  assert.deepEqual(sessionGraphRecency("2026-10-03T12:00:00.000Z", range), { background: "#212A37", latest: false });
  assert.deepEqual(sessionGraphRecency("2026-10-08T12:00:00.000Z", range), { background: "#2D3C4F", latest: false });
});

// @test-value v2
// kind = "invariant"
// claim = "単一日時と同率最新の全対象は同じ最新色と最新帯判定を持つ"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/895" }
// fault = "時間幅0で補間が壊れる、または最新1件だけを強調する"
// observable = "同時刻を繰り返し評価したbackgroundとlatest"
// observation_boundary = "consumer"
// scope = "Session Graph record/Topic共通新しさ表示"
// lifecycle = "permanent"
// impact = "同一batch更新や単一recordの最新状態を識別できなくなる"
// distinction = "型検査や通常の異なる時刻のfixtureでは時間幅0を検出できない"
// @end-test-value
test("single and tied latest timestamps receive the same latest treatment", () => {
  const tied = { oldestUpdatedAt: range.newestUpdatedAt, newestUpdatedAt: range.newestUpdatedAt };
  for (const updatedAt of [range.newestUpdatedAt, range.newestUpdatedAt]) {
    assert.deepEqual(sessionGraphRecency(updatedAt, tied), { background: "#34465A", latest: true });
    assert.deepEqual(sessionGraphRecency(updatedAt, range), { background: "#34465A", latest: true });
  }
});

// @test-value v2
// kind = "invariant"
// claim = "更新日時を持たない空Topicと全体空の比較範囲には最新帯を付けない"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/901" }
// fault = "更新日時の欠落同士の一致を最新として扱う"
// observable = "日時なしの評価で返るbackgroundとlatest"
// observation_boundary = "consumer"
// scope = "Session Graph 空Topicの新しさ表示"
// lifecycle = "permanent"
// impact = "記録がないTopicを最新の活動として誤認させる"
// distinction = "optional型は空日時の表示意味までは保証しない"
// @end-test-value
test("empty topics and an empty graph are excluded from latest treatment", () => {
  assert.deepEqual(sessionGraphRecency(undefined, range), { background: "#1C212B", latest: false });
  assert.deepEqual(sessionGraphRecency(undefined, {}), { background: "#1C212B", latest: false });
});
