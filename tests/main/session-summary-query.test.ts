import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  parseSessionSummaryPageRequest,
} from "../../src-electron/session/session-summary-query.js";
import { normalizeSessionSummaryInvalidation } from "../../src-shared/session/session-summary-invalidation.js";

// @test-value v2
// kind = "contract"
// claim = "Session summary parserはpage、search query、open IDの上限とscope固有の入力制約を守る"
// oracle = { type = "contract", ref = "src-electron/session/session-summary-query.ts" }
// fault = "上限超過やopen queryの不正な組合せを受け入れ、正規化済みscope・query・IDを返さない"
// observable = "parsed page request and thrown validation errors"
// observation_boundary = "public-boundary"
// scope = "Session summary page request parser"
// lifecycle = "permanent"
// impact = "Session一覧のpaging・検索・open ID取得が誤った対象や件数を返す"
// distinction = "正常な正規化結果と各上限・scope制約の拒否を一つの公開parserで確認する"
// @end-test-value
test("Session summary parser は page / query / open ID の上限を守る", () => {
  assert.deepEqual(parseSessionSummaryPageRequest({
    scope: "recent",
    limit: 50,
    searchText: "  TASK ",
  }), {
    scope: "recent",
    cursor: null,
    limit: 50,
    searchText: "task",
    sessionIds: undefined,
  });
  assert.throws(() => parseSessionSummaryPageRequest({ scope: "recent", limit: 51 }), /at most 50/);
  assert.throws(() => parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: Array.from({ length: 101 }, (_, index) => `session-${index}`),
  }), /batches of 100/);
  assert.throws(() => parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: ["session-a", "session-b"],
    limit: 1,
  }), /at least the number of requested IDs/);
  assert.throws(() => parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: ["session-a"],
    searchText: "literal",
  }), /do not accept search conditions/);
  assert.deepEqual(parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: ["session-a", "session-a"],
    searchText: "",
  }), {
    scope: "open",
    cursor: null,
    limit: 100,
    searchText: "",
    sessionIds: ["session-a"],
  });
  assert.equal(parseSessionSummaryPageRequest({ scope: "open", sessionIds: ["session-a"] }).searchText, "");
  assert.equal(parseSessionSummaryPageRequest({ scope: "pinned", searchText: "literal" }).searchText, "literal");
  assert.throws(() => parseSessionSummaryPageRequest({ searchText: "x".repeat(121) }), /120 characters or fewer/);
});

// @test-value v2
// kind = "invariant"
// claim = "Session summary cursorは発行時のscopeとnormalized queryが一致する場合だけ復元できる"
// oracle = { type = "contract", ref = "src-electron/session/session-summary-query.ts" }
// fault = "別scopeまたは別queryのcursorを受け入れ、異なるSession summary結果へpagingする"
// observable = "decoded cursor or validation error"
// observation_boundary = "public-boundary"
// scope = "Session summary cursor scope and query binding"
// lifecycle = "permanent"
// impact = "一覧pagingが別の検索条件へ越境し、表示対象が不正になる"
// distinction = "同じcursorをscope違いとquery違いで検証し、両方の拒否を確認する"
// @end-test-value
test("Session summary cursor は scope / normalized query の世代を跨がない", () => {
  const cursor = encodeSessionSummaryCursor("recent", "2026-08-20T00:00:00.000Z", "session-1", "task");

  assert.equal(cursor.length <= 512, true);
  assert.deepEqual(decodeSessionSummaryCursor(cursor, "recent", "task"), {
    lastActiveAt: "2026-08-20T00:00:00.000Z",
    id: "session-1",
  });
  assert.throws(() => decodeSessionSummaryCursor(cursor, "recent", "other"), /does not match the current query/);
  assert.throws(() => decodeSessionSummaryCursor(cursor, "pinned", "task"), /does not match the current query/);
});

test("Session summary invalidation は 256件を超えたIDを切り捨てず all にする", () => {
  assert.deepEqual(normalizeSessionSummaryInvalidation({
    scope: "ids",
    sessionIds: [" session-1 ", "session-1"],
  }), { scope: "ids", sessionIds: ["session-1"] });
  assert.deepEqual(normalizeSessionSummaryInvalidation({
    scope: "ids",
    sessionIds: Array.from({ length: 257 }, (_, index) => `session-${index}`),
  }), { scope: "all" });
  assert.equal(normalizeSessionSummaryInvalidation({ scope: "ids", sessionIds: [] }), null);
});
