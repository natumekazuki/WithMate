import assert from "node:assert/strict";
import test from "node:test";

import {
  applySessionDocumentTitle,
  resolveAgentSessionDocumentTitle,
  resolveSessionDocumentTitle,
} from "../../src/chat/window-title.js";

test("resolveSessionDocumentTitle は session title を window title として使う", () => {
  assert.equal(resolveSessionDocumentTitle("Issue 58 cleanup", "Session"), "Issue 58 cleanup");
  assert.equal(resolveSessionDocumentTitle("  Issue 58 cleanup  ", "Session"), "Issue 58 cleanup");
});

// @test-value v2
// kind = "contract"
// claim = "通常Sessionの空titleは指定fallbackへ解決する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "空titleで専用window titleまたは空文字を返す"
// observable = "resolveSessionDocumentTitleのfallback結果"
// observation_boundary = "public-boundary"
// scope = "session-window-title"
// lifecycle = "permanent"
// @end-test-value
test("resolveSessionDocumentTitle は空 title では fallback を使う", () => {
  assert.equal(resolveSessionDocumentTitle("", "Session"), "Session");
  assert.equal(resolveSessionDocumentTitle("   ", "Session"), "Session");
  assert.equal(resolveSessionDocumentTitle(null, "WithMate Session"), "WithMate Session");
});

test("applySessionDocumentTitle は document がある場合だけ title を同期する", () => {
  const previousDocument = globalThis.document;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { title: "before" },
  });

  try {
    applySessionDocumentTitle("Session Title");
    assert.equal(globalThis.document.title, "Session Title");
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Agent sessionのhydrate前window title fallbackはnative session windowと同じ短いapp labelを使う"
// oracle = { type = "contract", ref = "src-electron/windows/main-window-runtime.ts: session window title" }
// fault = "rendererだけが空白付きの旧prefixを返し、同じsession windowでtitle表記が不一致になる"
// observable = "sessionIdだけを与えたresolveAgentSessionDocumentTitleの返却文字列"
// observation_boundary = "public-boundary"
// scope = "agent-session-window-title-fallback"
// lifecycle = "permanent"
// impact = "hydrate前のwindow titleがnative側と不一致になり、window識別が揺れる"
// distinction = "user入力titleの保持ではなく、sessionId fallbackのrenderer/native契約を直接確認する"
// @end-test-value
test("resolveAgentSessionDocumentTitle は hydrate 前でも sessionId fallback を返す", () => {
  assert.equal(
    resolveAgentSessionDocumentTitle({ sessionTitle: undefined, sessionId: "session-1" }),
    "WithMateSession - session-1",
  );
  assert.equal(
    resolveAgentSessionDocumentTitle({ sessionTitle: "Issue 58 cleanup", sessionId: "session-1" }),
    "Issue 58 cleanup",
  );
});
