import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenSessionWindowIdsPage,
  normalizeOpenSessionWindowIdsChangedPayload,
  normalizeOpenSessionWindowIdsPageResult,
} from "../../src/withmate-window-types.js";

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

test("open Session Window ID page は前pageのSessionが閉じても後続IDを欠落させない", () => {
  const sessionIds = Array.from({ length: 101 }, (_, index) => `session-${String(index).padStart(3, "0")}`);
  const first = buildOpenSessionWindowIdsPage(sessionIds, { limit: 100 });
  const second = buildOpenSessionWindowIdsPage(sessionIds.slice(1), { cursor: first.nextCursor, limit: 100 });
  assert.deepEqual(second.sessionIds, ["session-100"]);
});

test("open Session Window ID broadcast は上限超過を all にしてsilent truncationしない", () => {
  assert.deepEqual(normalizeOpenSessionWindowIdsChangedPayload(
    Array.from({ length: 101 }, (_, index) => `session-${index}`),
  ), { scope: "all" });
});
