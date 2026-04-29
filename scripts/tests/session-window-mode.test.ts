import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionWindowModeFromSearch } from "../../src/session-window-mode.js";

test("resolveSessionWindowModeFromSearch は通常 session を解決する", () => {
  assert.deepEqual(resolveSessionWindowModeFromSearch("?sessionId=session-1"), {
    kind: "agent",
    sessionId: "session-1",
  });
});

test("resolveSessionWindowModeFromSearch は companion session を優先して解決する", () => {
  assert.deepEqual(resolveSessionWindowModeFromSearch("?sessionId=session-1&companionSessionId=companion-1"), {
    kind: "companion",
    companionSessionId: "companion-1",
  });
});

test("resolveSessionWindowModeFromSearch は sessionId がない通常 window を許容する", () => {
  assert.deepEqual(resolveSessionWindowModeFromSearch(""), {
    kind: "agent",
    sessionId: null,
  });
});
