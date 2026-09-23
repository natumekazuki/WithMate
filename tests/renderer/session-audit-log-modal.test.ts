import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionAuditLogModal, shouldLoadAuditLogDetailForFold } from "../../src/chat/runtime/session-audit-log.js";
import type { AuditLogSummary } from "../../src-shared/session/runtime-state.js";

function createAuditLogSummary(id: number, overrides?: Partial<AuditLogSummary>): AuditLogSummary {
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
    ...overrides,
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

  // @test-value v2
  // kind = "contract"
  // claim = "Audit log modalは取得済みpageの全entryを一覧内に描画し、一覧の後に次ページ操作を示す"
  // oracle = { type = "contract", ref = "docs/design/data-loading-performance-audit.md" }
  // fault = "entryを間引くかpagination controlを一覧より前へ置き、履歴の続きへ到達できなくする"
  // observable = "audit-log-cardの件数・各entryの時刻と一覧・Load More buttonのDOM順序"
  // observation_boundary = "component-behavior"
  // scope = "session-audit-log-page-rendering"
  // lifecycle = "permanent"
  // impact = "監査履歴の欠落や誤ったscroll体験によりrunの確認を妨げる"
  // distinction = "paged summaryの描画件数とpagination affordanceを同一renderで確認する"
  // @end-test-value
  it("取得済み page の entry を一覧に描画し、次ページ操作を後に置く", () => {
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

    const { document, Node } = new JSDOM(html).window;
    const list = document.querySelector(".audit-log-list");
    const cards = [...document.querySelectorAll("article.audit-log-card")];
    const loadMore = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Load More");
    assert.ok(list);
    assert.equal(cards.length, 50);
    assert.deepEqual(cards.map((card) => card.querySelector(".audit-log-time")?.textContent),
      entries.map((entry) => entry.createdAt));
    assert.ok(cards.every((card) => list.contains(card)));
    assert.ok(loadMore);
    assert.ok((list.compareDocumentPosition(loadMore) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
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

  // @test-value v2
  // kind = "contract"
  // claim = "Audit log source labelはphase labelの隣へタグとして描画される"
  // oracle = { type = "contract", ref = "src/chat/runtime/session-audit-log.tsx" }
  // fault = "sourceをphaseへ混ぜるか隠し、Main/Auxiliaryの監査対象を区別できなくする"
  // observable = "source tagのDOMとCompleted phase labelに対する描画順"
  // observation_boundary = "component-behavior"
  // scope = "session-audit-log-source-label"
  // lifecycle = "permanent"
  // impact = "同一画面上のaudit sourceを誤認する"
  // distinction = "tagの存在だけでなくphase後の順序をassertする"
  // @end-test-value
  it("sourceLabel を phase の隣にタグとして描画する", () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionAuditLogModal, {
        open: true,
        entries: [createAuditLogSummary(1)],
        sourceLabel: "Main Session",
        details: {},
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

    assert.match(html, /audit-log-source-tag/);
    assert.match(html, />Completed</);
    assert.match(html, />Main Session</);
    assert.ok(
      html.indexOf("Completed") < html.indexOf("Main Session"),
      "source tag は phase label の後に描画する",
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "detail unavailable entryはlive previewだけを描画し、保存済みdetail foldを表示しない"
  // oracle = { type = "contract", ref = "src/chat/runtime/session-audit-log.tsx" }
  // fault = "未保存のdetailを保存済みと誤表示し、preview中に存在しないlogical/raw sectionを出す"
  // observable = "Live preview only、assistant preview、operation summary、Logical prompt/Raw itemsの不在"
  // observation_boundary = "component-behavior"
  // scope = "session-audit-log-live-preview"
  // lifecycle = "permanent"
  // impact = "streaming中の監査情報を誤って確定値として扱う"
  // distinction = "利用可能なpreviewの保持と未利用sectionの非表示を同時に確認する"
  // @end-test-value
  it("detail unavailable entry は live preview として描画し、保存済み detail fold を出さない", () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionAuditLogModal, {
        open: true,
        entries: [
          createAuditLogSummary(1, {
            id: -1,
            phase: "running",
            assistantTextPreview: "streaming response",
            operations: [{ type: "command_execution", summary: "npm test", details: "running" }],
            detailAvailable: false,
          }),
        ],
        details: {},
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

    assert.match(html, /Live preview only/);
    assert.match(html, /streaming response/);
    assert.match(html, /npm test/);
    assert.doesNotMatch(html, /Logical prompt/);
    assert.doesNotMatch(html, /Raw items/);
  });
});
