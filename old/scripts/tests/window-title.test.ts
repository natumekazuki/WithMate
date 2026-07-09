import assert from "node:assert/strict";
import test from "node:test";

import {
  applySessionDocumentTitle,
  resolveAgentSessionDocumentTitle,
  resolveCompanionDocumentTitle,
  resolveSessionDocumentTitle,
} from "../../src/chat/window-title.js";

test("resolveSessionDocumentTitle は session title を window title として使う", () => {
  assert.equal(resolveSessionDocumentTitle("Issue 58 cleanup", "Session"), "Issue 58 cleanup");
  assert.equal(resolveSessionDocumentTitle("  Issue 58 cleanup  ", "Session"), "Issue 58 cleanup");
});

test("resolveSessionDocumentTitle は空 title では fallback を使う", () => {
  assert.equal(resolveSessionDocumentTitle("", "Session"), "Session");
  assert.equal(resolveSessionDocumentTitle("   ", "Session"), "Session");
  assert.equal(resolveSessionDocumentTitle(null, "WithMate Companion"), "WithMate Companion");
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

test("resolveCompanionDocumentTitle は chat と merge の window title を分ける", () => {
  assert.equal(
    resolveCompanionDocumentTitle({ mode: "chat", sessionTitle: "Companion task", sessionId: "companion-1" }),
    "Companion task",
  );
  assert.equal(
    resolveCompanionDocumentTitle({ mode: "chat", sessionTitle: undefined, sessionId: "companion-1" }),
    "Companion - companion-1",
  );
  assert.equal(
    resolveCompanionDocumentTitle({ mode: "merge", sessionTitle: "Companion task", sessionId: "companion-1" }),
    "Companion Merge - companion-1",
  );
});
