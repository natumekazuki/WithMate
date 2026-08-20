import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenSessionWindowIdsPage,
  normalizeOpenSessionWindowIdsChangedPayload,
  normalizeOpenSessionWindowIdsPageResult,
} from "../../src/withmate-window-types.js";

test("open Session Window ID page は100件単位で全体を返せる", () => {
  const sessionIds = Array.from({ length: 101 }, (_, index) => `session-${index}`);
  const first = buildOpenSessionWindowIdsPage(sessionIds, { limit: 100 });
  const second = buildOpenSessionWindowIdsPage(sessionIds, { offset: first.nextOffset, limit: 100 });

  assert.equal(first.sessionIds.length, 100);
  assert.deepEqual(first.nextOffset, 100);
  assert.equal(first.hasMore, true);
  assert.deepEqual(second.sessionIds, ["session-100"]);
  assert.equal(second.nextOffset, null);
  assert.equal(second.hasMore, false);
  assert.equal(normalizeOpenSessionWindowIdsPageResult(first)?.sessionIds.length, 100);
});

test("open Session Window ID broadcast は上限超過を all にしてsilent truncationしない", () => {
  assert.deepEqual(normalizeOpenSessionWindowIdsChangedPayload(
    Array.from({ length: 101 }, (_, index) => `session-${index}`),
  ), { scope: "all" });
});
