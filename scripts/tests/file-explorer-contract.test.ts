import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSessionFileSearchQuery,
  parseSessionFileSearchRequest,
  SESSION_FILE_SEARCH_QUERY_MAX_LENGTH,
  SESSION_FILE_SEARCH_RAW_QUERY_MAX_LENGTH,
} from "../../src/file-explorer/file-explorer-contract.js";

test("file search request parser は query を正規化し raw / normalized の上限を適用する", () => {
  assert.deepEqual(parseSessionFileSearchRequest({ sessionId: "session-1", query: "  ReadMe.MD  " }), {
    sessionId: "session-1",
    query: "readme.md",
  });
  assert.equal(normalizeSessionFileSearchQuery(`${" ".repeat(391)}${"x".repeat(SESSION_FILE_SEARCH_QUERY_MAX_LENGTH)} `).length, SESSION_FILE_SEARCH_QUERY_MAX_LENGTH);
  assert.equal(normalizeSessionFileSearchQuery(` ${"x".repeat(SESSION_FILE_SEARCH_QUERY_MAX_LENGTH)} `).length, SESSION_FILE_SEARCH_QUERY_MAX_LENGTH);
  assert.throws(
    () => normalizeSessionFileSearchQuery("x".repeat(SESSION_FILE_SEARCH_RAW_QUERY_MAX_LENGTH + 1)),
    /長すぎる/,
  );
  assert.throws(
    () => normalizeSessionFileSearchQuery(` ${"x".repeat(SESSION_FILE_SEARCH_QUERY_MAX_LENGTH + 1)} `),
    /文字以内/,
  );
});

test("file search request parser は unknown field と不正な型を拒否する", () => {
  assert.throws(
    () => parseSessionFileSearchRequest({ sessionId: "session-1", query: "file", extra: true }),
    /未知の field/,
  );
  assert.throws(
    () => parseSessionFileSearchRequest({ sessionId: "session-1", query: 42 }),
    /query が不正/,
  );
  assert.throws(
    () => parseSessionFileSearchRequest({ sessionId: "session-1" }),
    /未知の field/,
  );
  assert.throws(
    () => parseSessionFileSearchRequest({ sessionId: "", query: "file" }),
    /session ID が不正/,
  );
});
