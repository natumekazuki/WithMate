import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { buildNewSession } from "../../src-shared/session/session-state.js";
import { useSessionAuditLogs } from "../../src/chat/runtime/session-audit-log-state.js";
import type { AuditLogSummary } from "../../src-shared/session/runtime-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    operations: [],
    usage: null,
    errorMessage: "",
    detailAvailable: true,
  };
}

describe("useSessionAuditLogs", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Audit Logを開いたとき対象Sessionのsummaryを再取得する"
  // oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
  // fault = "modalを開いても監査ログsummaryが更新されない"
  // observable = "audit log APIへのsession IDとcursor付き呼び出し"
  // observation_boundary = "component-behavior"
  // scope = "session-audit-log-state"
  // lifecycle = "permanent"
  // @end-test-value
  it("AuditLog modal open 時に summary を再取得する", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      pretendToBeVisual: true,
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousNode = globalThis.Node;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: dom.window.requestAnimationFrame.bind(dom.window),
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: dom.window.cancelAnimationFrame.bind(dom.window),
    });

    const session = {
      ...buildNewSession({
        taskTitle: "AuditLog",
        workspaceLabel: "repo",
        workspacePath: "/repo",
        branch: "main",
        characterId: "character-1",
        character: "WithMate",
        characterIconPath: "",
        characterThemeColors: {
          main: "#000000",
          sub: "#ffffff",
        },
        approvalMode: "untrusted",
      }),
      id: "session-1",
    };

    const calls: Array<{ sessionId: string; cursor: number; limit: number }> = [];
    const detailCalls: Array<{ sessionId: string; auditLogId: number }> = [];
    const auditLogApi = {
      async listSessionAuditLogSummaryPage(sessionId: string, page: { cursor: number; limit: number }) {
        calls.push({ sessionId, cursor: page.cursor, limit: page.limit });
        return {
          entries: [createAuditLogSummary(1)],
          nextCursor: null,
          hasMore: false,
          total: 1,
        };
      },
      async getSessionAuditLogDetailSection(sessionId: string, auditLogId: number) {
        detailCalls.push({ sessionId, auditLogId });
        return {
          id: auditLogId,
          sessionId,
          assistantText: `detail ${detailCalls.length}`,
        };
      },
      async getSessionAuditLogOperationDetail() {
        return null;
      },
    };
    let openAuditLogs: (() => void) | null = null;
    let replaceSessionWithSameId: (() => void) | null = null;
    let switchCacheScope: (() => void) | null = null;
    let loadFirstDetail: (() => void) | null = null;
    let root: Root | null = null;

    function Harness() {
      const [currentSession, setCurrentSession] = useState(session);
      const [cacheScope, setCacheScope] = useState("session");
      const auditLogs = useSessionAuditLogs({
        withmateApi: null,
        selectedSession: currentSession,
        ownerSessionId: "parent-session-1",
        cacheScopeKey: cacheScope,
        liveRun: null,
        auditLogApi,
      });

      useEffect(() => {
        openAuditLogs = () => auditLogs.setAuditLogsOpen(true);
        replaceSessionWithSameId = () => setCurrentSession((current) => ({ ...current }));
        switchCacheScope = () => setCacheScope("session-auxiliary");
        loadFirstDetail = () => {
          const entry = auditLogs.displayedEntries[0];
          if (entry) {
            auditLogs.handleLoadAuditLogDetail(entry, "response");
          }
        };
      }, [auditLogs]);

      return React.createElement("div");
    }

    try {
      await act(async () => {
        root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
        root.render(React.createElement(Harness));
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.sessionId, "parent-session-1");

      await act(async () => {
        openAuditLogs?.();
      });

      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((call) => call.cursor), [0, 0]);

      await act(async () => {
        replaceSessionWithSameId?.();
      });

      assert.equal(calls.length, 2);

      await act(async () => {
        loadFirstDetail?.();
      });

      assert.equal(detailCalls.length, 1);
      assert.deepEqual(detailCalls[0], { sessionId: "session-1", auditLogId: 1 });

      await act(async () => {
        switchCacheScope?.();
      });

      assert.equal(calls.length, 4);

      await act(async () => {
        loadFirstDetail?.();
      });

      assert.equal(detailCalls.length, 2);
      assert.deepEqual(detailCalls[1], { sessionId: "session-1", auditLogId: 1 });
    } finally {
      await act(async () => root?.unmount());
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
      Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: previousRequestAnimationFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: previousCancelAnimationFrame,
      });
      dom.window.close();
    }
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Audit refresh と pagination は独立したpendingを持ち、refresh完了後の古いpagination応答を適用しない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#Audit" }
  // fault = "refreshとLoad Moreを一つのbusyへ潰すか、refresh後に古いpageが新しい一覧へ混入する"
  // observable = "refreshing/loadingMoreの同時状態、page応答後の表示entry"
  // observation_boundary = "component-behavior"
  // scope = "session-audit-log-state"
  // lifecycle = "permanent"
  // @end-test-value
  it("Audit refresh と pagination のpendingを分離し、refresh後の古いpageを捨てる", async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
      pretendToBeVisual: true,
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    const previousNode = globalThis.Node;
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

    Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: dom.window.requestAnimationFrame.bind(dom.window),
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: dom.window.cancelAnimationFrame.bind(dom.window),
    });

    const session = {
      ...buildNewSession({
        taskTitle: "AuditLog",
        workspaceLabel: "repo",
        workspacePath: "/repo",
        branch: "main",
        characterId: "character-1",
        character: "WithMate",
        characterIconPath: "",
        characterThemeColors: {
          main: "#000000",
          sub: "#ffffff",
        },
        approvalMode: "untrusted",
      }),
      id: "session-1",
    };
    const firstPage = {
      entries: [createAuditLogSummary(1)],
      nextCursor: 1,
      hasMore: true,
      total: 2,
    };
    const refreshedPage = {
      entries: [createAuditLogSummary(3)],
      nextCursor: 1,
      hasMore: true,
      total: 2,
    };
    const stalePage = {
      entries: [createAuditLogSummary(2)],
      nextCursor: null,
      hasMore: false,
      total: 2,
    };
    let summaryCallCount = 0;
    let resolveRefresh: ((page: typeof refreshedPage) => void) | null = null;
    let resolveLoadMore: ((page: typeof stalePage) => void) | null = null;
    const auditLogApi = {
      listSessionAuditLogSummaryPage(_sessionId: string, page: { cursor: number; limit: number }) {
        summaryCallCount += 1;
        if (page.cursor === 0 && summaryCallCount === 1) {
          return Promise.resolve(firstPage);
        }
        if (page.cursor === 0) {
          return new Promise<typeof refreshedPage>((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return new Promise<typeof stalePage>((resolve) => {
          resolveLoadMore = resolve;
        });
      },
      async getSessionAuditLogDetailSection() {
        return null;
      },
      async getSessionAuditLogOperationDetail() {
        return null;
      },
    };
    let openAuditLogs: (() => void) | null = null;
    let loadMoreAuditLogs: (() => void) | null = null;
    let root: Root | null = null;

    function Harness() {
      const auditLogs = useSessionAuditLogs({
        withmateApi: null,
        selectedSession: session,
        ownerSessionId: "parent-session-1",
        liveRun: null,
        auditLogApi,
      });
      useEffect(() => {
        openAuditLogs = () => auditLogs.setAuditLogsOpen(true);
        loadMoreAuditLogs = auditLogs.handleLoadMoreAuditLogs;
      }, [auditLogs]);
      return React.createElement(
        "div",
        {
          "data-refreshing": String(auditLogs.modalProps.refreshing),
          "data-loading-more": String(auditLogs.modalProps.loadingMore),
          "data-entries": auditLogs.displayedEntries.map((entry) => entry.id).join(","),
        },
      );
    }

    try {
      await act(async () => {
        root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
        root.render(React.createElement(Harness));
      });
      await act(async () => {});
      assert.equal(summaryCallCount, 1);

      await act(async () => {
        openAuditLogs?.();
      });
      assert.equal(dom.window.document.querySelector("[data-refreshing]")?.getAttribute("data-refreshing"), "true");

      await act(async () => {
        loadMoreAuditLogs?.();
      });
      const stateDuringBoth = dom.window.document.querySelector("[data-refreshing]");
      assert.equal(stateDuringBoth?.getAttribute("data-refreshing"), "true");
      assert.equal(stateDuringBoth?.getAttribute("data-loading-more"), "true");

      await act(async () => {
        resolveRefresh?.(refreshedPage);
      });
      const stateAfterRefresh = dom.window.document.querySelector("[data-refreshing]");
      assert.equal(stateAfterRefresh?.getAttribute("data-refreshing"), "false");
      assert.equal(stateAfterRefresh?.getAttribute("data-loading-more"), "false");
      assert.equal(stateAfterRefresh?.getAttribute("data-entries"), "3");

      await act(async () => {
        resolveLoadMore?.(stalePage);
      });
      assert.equal(dom.window.document.querySelector("[data-refreshing]")?.getAttribute("data-entries"), "3");
    } finally {
      await act(async () => root?.unmount());
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
      Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: previousRequestAnimationFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: previousCancelAnimationFrame,
      });
      dom.window.close();
    }
  });
});
