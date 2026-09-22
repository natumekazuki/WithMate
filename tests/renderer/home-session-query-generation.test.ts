import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "../../src/home/home-session-query-generation.js";

test("Home Session query変更はdebounce前でも旧request tokenを失効させる", () => {
  const initialKey = buildHomeSessionQueryKey("", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(initialKey);
  const oldRequest = generation.beginRequest();

  generation.syncQueryKey(buildHomeSessionQueryKey("next", ["session-1"]));

  assert.equal(generation.isCurrent(oldRequest), false);
});

test("Home Session open ID変更は旧page request tokenを失効させる", () => {
  const initialKey = buildHomeSessionQueryKey("query", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(initialKey);
  const oldPageRequest = generation.capture();

  generation.syncQueryKey(buildHomeSessionQueryKey("query", ["session-1", "session-2"]));

  assert.equal(generation.isCurrent(oldPageRequest), false);
});

test("Home Session refresh開始は同じqueryの先行requestだけを失効させる", () => {
  const key = buildHomeSessionQueryKey("query", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(key);
  const firstRequest = generation.beginRequest();
  const latestRequest = generation.beginRequest();

  assert.equal(generation.isCurrent(firstRequest), false);
  assert.equal(generation.isCurrent(latestRequest), true);
});
