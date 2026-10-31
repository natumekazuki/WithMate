import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatWindowModeFromSearch, resolveChatWindowModeTarget } from "../../src/chat/chat-window-mode.js";

test("resolveChatWindowModeFromSearch は通常 session を解決する", () => {
  assert.deepEqual(resolveChatWindowModeFromSearch("?sessionId=session-1"), {
    kind: "agent",
    sessionId: "session-1",
  });
});


test("resolveChatWindowModeFromSearch は sessionId がない通常 window を許容する", () => {
  assert.deepEqual(resolveChatWindowModeFromSearch(""), {
    kind: "agent",
    sessionId: null,
  });
});

// @test-value v2
// kind = "contract"
// claim = "Session window routingは登録されたAgent用の表示targetを返す"
// oracle = { type = "contract", ref = "src/chat/ChatWindowAppRouter.tsx" }
// fault = "通常Sessionを対応するchat window componentへルーティングしない"
// observable = "resolveChatWindowModeTargetが返す登録target"
// observation_boundary = "public-boundary"
// scope = "Session window target routing"
// lifecycle = "permanent"
// @end-test-value
test("resolveChatWindowModeTarget は mode kind に対応する target を解決する", () => {
  const targets = {
    agent: "AgentSessionWindowApp",
  };

  assert.equal(
    resolveChatWindowModeTarget({ kind: "agent", sessionId: "session-1" }, targets),
    "AgentSessionWindowApp",
  );
});
