import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenSessionWindowIdsPage,
  normalizeOpenSessionWindowIdsChangedPayload,
  normalizeOpenSessionWindowIdsPageResult,
} from "../../src/withmate-window-types.js";

// @test-value v1
// kind = "contract"
// claim = "open Session Window ID page は100件単位で全体を返せるが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/withmate-window-types.test.ts:10 public contract" }
// failure_mode = "open Session Window ID page は100件単位で全体を返せるの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "withmate-window-types"
// lifecycle = "permanent"
// distinction = "対象テスト「open Session Window ID page は100件単位で全体を返せる」固有の入力、境界、またはwindow scopeを確認する"
// @end-test-value
test("open Session Window ID page は100件単位で全体を返せる", () => {
  const sessionIds = Array.from({ length: 101 }, (_, index) => `session-${String(index).padStart(3, "0")}`);
  const first = buildOpenSessionWindowIdsPage(sessionIds, { limit: 100 });
  const second = buildOpenSessionWindowIdsPage(sessionIds, { cursor: first.nextCursor, limit: 100 });
  assert.equal(first.sessionIds.length, 100);
  assert.equal(first.nextCursor, "session-099");
  assert.equal(first.hasMore, true);
  assert.deepEqual(second.sessionIds, ["session-100"]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.hasMore, false);
  assert.equal(normalizeOpenSessionWindowIdsPageResult(first)?.sessionIds.length, 100);
});

// @test-value v1
// kind = "regression"
// claim = "open Session Window ID page は前pageのSessionが閉じても後続IDを欠落させないが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/withmate-window-types.test.ts:23 public contract" }
// failure_mode = "open Session Window ID page は前pageのSessionが閉じても後続IDを欠落させないの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "withmate-window-types"
// lifecycle = "permanent"
// distinction = "対象テスト「open Session Window ID page は前pageのSessionが閉じても後続IDを欠落させない」固有の入力、境界、またはwindow scopeを確認する"
// @end-test-value
test("open Session Window ID page は前pageのSessionが閉じても後続IDを欠落させない", () => {
  const sessionIds = Array.from({ length: 101 }, (_, index) => `session-${String(index).padStart(3, "0")}`);
  const first = buildOpenSessionWindowIdsPage(sessionIds, { limit: 100 });
  const changedSessionIds = sessionIds.slice(1);

  const second = buildOpenSessionWindowIdsPage(changedSessionIds, { cursor: first.nextCursor, limit: 100 });
  assert.deepEqual(second.sessionIds, ["session-100"]);
});

// @test-value v1
// kind = "regression"
// claim = "open Session Window ID broadcast は上限超過を all にしてsilent truncationしないが検証対象の公開契約を成立させる"
// oracle = { type = "contract", ref = "scripts/tests/withmate-window-types.test.ts:32 public contract" }
// failure_mode = "open Session Window ID broadcast は上限超過を all にしてsilent truncationしないの条件で、consumerから観測できる公開結果が欠落・誤配信・不正許可になる"
// scope = "withmate-window-types"
// lifecycle = "permanent"
// distinction = "対象テスト「open Session Window ID broadcast は上限超過を all にしてsilent truncationしない」固有の入力、境界、またはwindow scopeを確認する"
// @end-test-value
test("open Session Window ID broadcast は上限超過を all にしてsilent truncationしない", () => {
  assert.deepEqual(normalizeOpenSessionWindowIdsChangedPayload(
    Array.from({ length: 101 }, (_, index) => `session-${index}`),
  ), { scope: "all" });
});
