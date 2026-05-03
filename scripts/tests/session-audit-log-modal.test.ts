import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionAuditLogModal, shouldLoadAuditLogDetailForFold } from "../../src/session-components.js";
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
  it("Operations fold は paged summary から detail を読み込む対象にする", () => {
    assert.equal(shouldLoadAuditLogDetailForFold("logical"), true);
    assert.equal(shouldLoadAuditLogDetailForFold("transport"), true);
    assert.equal(shouldLoadAuditLogDetailForFold("response"), true);
    assert.equal(shouldLoadAuditLogDetailForFold("operations"), true);
    assert.equal(shouldLoadAuditLogDetailForFold("raw"), true);
    assert.equal(shouldLoadAuditLogDetailForFold("usage"), false);
    assert.equal(shouldLoadAuditLogDetailForFold("error"), false);
  });

  it("取得済み page の entry を固定高 spacer なしで描画する", () => {
    const entries = Array.from({ length: 50 }, (_, index) => createAuditLogSummary(index + 1));
    const html = renderToStaticMarkup(
      React.createElement(SessionAuditLogModal, {
        open: true,
        entries,
        details: {},
        operationDetails: {},
        hasMore: true,
        loadingMore: false,
        total: 100,
        errorMessage: null,
        onLoadMore() {},
        onLoadDetail() {},
        onLoadOperationDetail() {},
        onClose() {},
      }),
    );

    const renderedCardCount = (html.match(/audit-log-card/g) ?? []).length;
    assert.equal(renderedCardCount, 50);
    assert.doesNotMatch(html, /audit-log-list-spacer/);
    assert.match(html, /Load More/);
  });

  it("Operations detail は operation ごとの fold を開くまで本文を描画しない", () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionAuditLogModal, {
        open: true,
        entries: [createAuditLogSummary(1)],
        details: {
          1: {
            detail: {
              id: 1,
              sessionId: "session-1",
              operations: [{
                type: "analysis",
                summary: "operation 1",
                details: "OPERATION_DETAIL_SENTINEL",
              }],
            },
            loadedSections: { operations: true },
            loadingSections: {},
            errorMessages: {},
          },
        },
        operationDetails: {},
        hasMore: false,
        loadingMore: false,
        total: 1,
        errorMessage: null,
        onLoadMore() {},
        onLoadDetail() {},
        onLoadOperationDetail() {},
        onClose() {},
      }),
    );

    assert.doesNotMatch(html, /Details/);
    assert.doesNotMatch(html, /OPERATION_DETAIL_SENTINEL/);
  });
});
