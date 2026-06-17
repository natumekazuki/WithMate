import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatWindowModeFromSearch, resolveChatWindowModeTarget } from "../../src/chat/chat-window-mode.js";

test("resolveChatWindowModeFromSearch は通常 session を解決する", () => {
  assert.deepEqual(resolveChatWindowModeFromSearch("?sessionId=session-1"), {
    kind: "agent",
    sessionId: "session-1",
  });
});

test("resolveChatWindowModeFromSearch は companion session を優先して解決する", () => {
  assert.deepEqual(resolveChatWindowModeFromSearch("?sessionId=session-1&companionSessionId=companion-1"), {
    kind: "companion",
    companionSessionId: "companion-1",
  });
});

test("resolveChatWindowModeFromSearch は sessionId がない通常 window を許容する", () => {
  assert.deepEqual(resolveChatWindowModeFromSearch(""), {
    kind: "agent",
    sessionId: null,
  });
});

test("resolveChatWindowModeTarget は mode kind に対応する target を解決する", () => {
  const targets = {
    agent: "AgentSessionWindowApp",
    companion: "CompanionChatModeApp",
  };

  assert.equal(
    resolveChatWindowModeTarget({ kind: "agent", sessionId: "session-1" }, targets),
    "AgentSessionWindowApp",
  );
  assert.equal(
    resolveChatWindowModeTarget({ kind: "companion", companionSessionId: "companion-1" }, targets),
    "CompanionChatModeApp",
  );
});
