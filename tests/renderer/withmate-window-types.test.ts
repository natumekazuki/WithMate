import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenSessionWindowIdsPage,
  normalizeOpenSessionWindowIdsChangedPayload,
  normalizeOpenSessionWindowIdsPageResult,
} from "../../src-shared/window/withmate-window-types.js";

/** 101件の Window ID を100件と残り一件へ分け、カーソルと終端を通知し、正規化後も一ページ目の件数が維持される。 */
test("open Session Window ID page は100件単位で全体を返せる", () => {
  const sessionIds = Array.from(
    { length: 101 },
    (_, index) => `session-${String(index).padStart(3, "0")}`,
  );
  const first = buildOpenSessionWindowIdsPage(sessionIds, { limit: 100 });
  const second = buildOpenSessionWindowIdsPage(sessionIds, {
    cursor: first.nextCursor,
    limit: 100,
  });

  assert.equal(first.sessionIds.length, 100);
  assert.deepEqual(first.nextCursor, "session-099");
  assert.equal(first.hasMore, true);
  assert.deepEqual(second.sessionIds, ["session-100"]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.hasMore, false);
  assert.equal(
    normalizeOpenSessionWindowIdsPageResult(first)?.sessionIds.length,
    100,
  );
});

/** 前ページの項目が閉じて件数が変わっても、前ページ末尾の ID の次から再開し、後続の一件を飛ばさない。 */
test("open Session Window ID page は前pageのSessionが閉じても後続IDを欠落させない", () => {
  const sessionIds = Array.from(
    { length: 101 },
    (_, index) => `session-${String(index).padStart(3, "0")}`,
  );
  const first = buildOpenSessionWindowIdsPage(sessionIds, { limit: 100 });
  const changedSessionIds = sessionIds.slice(1);

  const second = buildOpenSessionWindowIdsPage(changedSessionIds, {
    cursor: first.nextCursor,
    limit: 100,
  });

  assert.deepEqual(second.sessionIds, ["session-100"]);
});

/** 通知の ID 数が上限を超えたら一部だけを配信せず、一覧全体の更新を指定する。 */
test("open Session Window ID broadcast は上限超過を all にしてsilent truncationしない", () => {
  assert.deepEqual(
    normalizeOpenSessionWindowIdsChangedPayload(
      Array.from({ length: 101 }, (_, index) => `session-${index}`),
    ),
    { scope: "all" },
  );
});
