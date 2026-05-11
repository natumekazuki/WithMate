import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionWindowModeFromSearch, resolveSessionWindowModeTarget } from "../../src/session-window-mode.js";

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

test("resolveSessionWindowModeFromSearch は mate-talk window を優先して解決する", () => {
  assert.deepEqual(resolveSessionWindowModeFromSearch("?sessionId=session-1&companionSessionId=companion-1&mode=mate-talk"), {
    kind: "mate-talk",
  });
});

test("resolveSessionWindowModeFromSearch は sessionId がない通常 window を許容する", () => {
  assert.deepEqual(resolveSessionWindowModeFromSearch(""), {
    kind: "agent",
    sessionId: null,
  });
});

test("resolveSessionWindowModeTarget は mode kind に対応する target を解決する", () => {
  const targets = {
    agent: "AgentSessionWindowApp",
    companion: "CompanionReviewApp",
    "mate-talk": "MateTalkWindowApp",
  };

  assert.equal(
    resolveSessionWindowModeTarget({ kind: "agent", sessionId: "session-1" }, targets),
    "AgentSessionWindowApp",
  );
  assert.equal(
    resolveSessionWindowModeTarget({ kind: "companion", companionSessionId: "companion-1" }, targets),
    "CompanionReviewApp",
  );
  assert.equal(resolveSessionWindowModeTarget({ kind: "mate-talk" }, targets), "MateTalkWindowApp");
});
