import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeSessionSummaryCursor,
  encodeSessionSummaryCursor,
  normalizeSessionSummaryInvalidation,
  parseSessionSummaryPageRequest,
} from "../../src-electron/session-summary-query.js";

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
  assert.throws(() => parseSessionSummaryPageRequest({ scope: "recent", limit: 51 }), /50件以内/);
  assert.throws(() => parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: Array.from({ length: 101 }, (_, index) => `session-${index}`),
  }), /100件ずつ/);
  assert.throws(() => parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: ["session-a", "session-b"],
    limit: 1,
  }), /ID数以上/);
  assert.throws(() => parseSessionSummaryPageRequest({
    scope: "open",
    sessionIds: ["session-a"],
    searchText: "literal",
  }), /検索条件/);
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
  assert.throws(() => parseSessionSummaryPageRequest({ searchText: "x".repeat(121) }), /120文字以内/);
});

test("Session summary cursor は scope / normalized query の世代を跨がない", () => {
  const cursor = encodeSessionSummaryCursor("recent", "2026-08-20T00:00:00.000Z", "session-1", "task");

  assert.equal(cursor.length <= 512, true);
  assert.deepEqual(decodeSessionSummaryCursor(cursor, "recent", "task"), {
    lastActiveAt: "2026-08-20T00:00:00.000Z",
    id: "session-1",
  });
  assert.throws(() => decodeSessionSummaryCursor(cursor, "recent", "other"), /一致しません/);
  assert.throws(() => decodeSessionSummaryCursor(cursor, "pinned", "task"), /一致しません/);
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
