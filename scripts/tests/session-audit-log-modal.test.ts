import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionAuditLogModal } from "../../src/session-components.js";
import type { AuditLogSummary } from "../../src/runtime-state.js";

function createAuditLogSummary(id: number): AuditLogSummary {
  return {
    id,
    sessionId: "session-1",
    createdAt: `2026-04-29T00:${String(id).padStart(2, "0")}:00.000Z`,
    phase: "completed",
    provider: "codex",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    approvalMode: "never",
    threadId: `thread-${id}`,
    assistantTextPreview: `preview ${id}`,
    operations: [{ type: "analysis", summary: `operation ${id}` }],
    usage: { inputTokens: id, cachedInputTokens: 0, outputTokens: id + 1 },
    errorMessage: "",
    detailAvailable: true,
  };
}

describe("SessionAuditLogModal", () => {
  it("大量 entry でも初期 render は window 範囲だけを描画する", () => {
    const entries = Array.from({ length: 100 }, (_, index) => createAuditLogSummary(index + 1));
    const html = renderToStaticMarkup(
      React.createElement(SessionAuditLogModal, {
        open: true,
        entries,
        details: {},
        hasMore: true,
        loadingMore: false,
        total: 100,
        errorMessage: null,
        onLoadMore() {},
        onLoadDetail() {},
        onClose() {},
      }),
    );

    const renderedCardCount = (html.match(/audit-log-card/g) ?? []).length;
    assert.ok(renderedCardCount > 0);
    assert.ok(renderedCardCount < 100);
    assert.match(html, /operation 1/);
    assert.doesNotMatch(html, /operation 100/);
    assert.match(html, /Load More/);
  });
});
