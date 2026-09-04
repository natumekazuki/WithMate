import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "../../src/home/home-session-query-generation.js";

// @test-value v1
// kind = "invariant"
// claim = "検索query変更はdebounce完了前でも旧Session request tokenを失効させる"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "旧検索結果が新しいqueryの一覧を上書きする"
// scope = "Home Session query generation"
// lifecycle = "permanent"
// @end-test-value
test("Home Session query変更はdebounce前でも旧request tokenを失効させる", () => {
  const initialKey = buildHomeSessionQueryKey("", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(initialKey);
  const oldRequest = generation.beginRequest();

  generation.syncQueryKey(buildHomeSessionQueryKey("next", ["session-1"]));

  assert.equal(generation.isCurrent(oldRequest), false);
});

// @test-value v1
// kind = "invariant"
// claim = "open Session ID集合の変更は旧page request tokenを失効させる"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "旧open集合を含むpage結果が現在の一覧へ混入する"
// scope = "Home Session open-set query generation"
// lifecycle = "permanent"
// @end-test-value
test("Home Session open ID変更は旧page request tokenを失効させる", () => {
  const initialKey = buildHomeSessionQueryKey("query", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(initialKey);
  const oldPageRequest = generation.capture();

  generation.syncQueryKey(buildHomeSessionQueryKey("query", ["session-1", "session-2"]));

  assert.equal(generation.isCurrent(oldPageRequest), false);
});

// @test-value v1
// kind = "invariant"
// claim = "同一queryの後続refresh開始は先行requestだけを失効させ最新tokenをcurrentにする"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md" }
// failure_mode = "先行refresh応答が後続refresh結果を上書きする"
// scope = "Home Session refresh request generation"
// lifecycle = "permanent"
// @end-test-value
test("Home Session refresh開始は同じqueryの先行requestだけを失効させる", () => {
  const key = buildHomeSessionQueryKey("query", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(key);
  const firstRequest = generation.beginRequest();
  const latestRequest = generation.beginRequest();

  assert.equal(generation.isCurrent(firstRequest), false);
  assert.equal(generation.isCurrent(latestRequest), true);
});
