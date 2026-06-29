import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { buildNewSession } from "../../src/app-state.js";
import { useSessionAuditLogs } from "../../src/session-audit-log-state.js";
import type { AuditLogSummary } from "../../src/runtime-state.js";

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
    const auditLogApi = {
      async listSessionAuditLogSummaryPage(sessionId: string, page: { cursor: number; limit: number }) {
        calls.push({ sessionId, cursor: page.cursor, limit: page.limit });
        return {
          entries: [createAuditLogSummary(calls.length)],
          nextCursor: null,
          hasMore: false,
          total: 1,
        };
      },
      async getSessionAuditLogDetailSection() {
        return null;
      },
      async getSessionAuditLogOperationDetail() {
        return null;
      },
    };
    let openAuditLogs: (() => void) | null = null;
    let replaceSessionWithSameId: (() => void) | null = null;
    let root: Root | null = null;

    function Harness() {
      const [currentSession, setCurrentSession] = useState(session);
      const auditLogs = useSessionAuditLogs({
        withmateApi: null,
        selectedSession: currentSession,
        liveRun: null,
        auditLogApi,
      });

      useEffect(() => {
        openAuditLogs = () => auditLogs.setAuditLogsOpen(true);
        replaceSessionWithSameId = () => setCurrentSession((current) => ({ ...current }));
      }, [auditLogs]);

      return React.createElement("div");
    }

    try {
      await act(async () => {
        root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
        root.render(React.createElement(Harness));
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.sessionId, "session-1");

      await act(async () => {
        openAuditLogs?.();
      });

      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((call) => call.cursor), [0, 0]);

      await act(async () => {
        replaceSessionWithSameId?.();
      });

      assert.equal(calls.length, 2);
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
