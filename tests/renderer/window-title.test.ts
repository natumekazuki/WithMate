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

test("resolveAgentSessionDocumentTitle は hydrate 前でも sessionId fallback を返す", () => {
  assert.equal(
    resolveAgentSessionDocumentTitle({ sessionTitle: undefined, sessionId: "session-1" }),
    "WithMate Session - session-1",
  );
  assert.equal(
    resolveAgentSessionDocumentTitle({ sessionTitle: "Issue 58 cleanup", sessionId: "session-1" }),
    "Issue 58 cleanup",
  );
});
