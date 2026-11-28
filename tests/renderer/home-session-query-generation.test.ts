import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeSessionQueryKey,
  HomeSessionQueryGeneration,
} from "../../src/home/home-session-query-generation.js";

/** 検索文字列の変更に気付いた時点で旧要求を無効にし、次の要求をまだ開始していなくても古い結果を採用しない。 */
test("Home Session query変更はdebounce前でも旧request tokenを失効させる", () => {
  const initialKey = buildHomeSessionQueryKey("", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(initialKey);
  const oldRequest = generation.beginRequest();

  generation.syncQueryKey(buildHomeSessionQueryKey("next", ["session-1"]));

  assert.equal(generation.isCurrent(oldRequest), false);
});

/** 検索文字列が同じでも開いている Session ID が変わった場合は、以前取得したページ読み取り用トークンを無効にする。 */
test("Home Session open ID変更は旧page request tokenを失効させる", () => {
  const initialKey = buildHomeSessionQueryKey("query", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(initialKey);
  const oldPageRequest = generation.capture();

  generation.syncQueryKey(
    buildHomeSessionQueryKey("query", ["session-1", "session-2"]),
  );

  assert.equal(generation.isCurrent(oldPageRequest), false);
});

/** 同じ検索条件で再取得すると、最新要求のトークンだけが有効になる。 */
test("Home Session refresh開始は同じqueryの先行requestだけを失効させる", () => {
  const key = buildHomeSessionQueryKey("query", ["session-1"]);
  const generation = new HomeSessionQueryGeneration(key);
  const firstRequest = generation.beginRequest();
  const latestRequest = generation.beginRequest();

  assert.equal(generation.isCurrent(firstRequest), false);
  assert.equal(generation.isCurrent(latestRequest), true);
});
