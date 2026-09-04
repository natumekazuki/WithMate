import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import App from "../../src/App.js";
import type { GlossaryListResult, SessionGlossaryProjection } from "../../src/glossary-contract.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { Session } from "../../src/session-state.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

type SearchResult = { ok: true } & GlossaryListResult;

function createSession(): Session {
  return {
    id: "session-1",
    taskTitle: "Glossary search",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    provider: "codex",
    catalogRevision: 1,
    workspaceLabel: "WithMate",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 4,
    characterId: "character-1",
    character: "Test",
    characterIconPath: "",
    characterThemeColors: { main: "#000000", sub: "#ffffff" },
    characterRuntimeSnapshot: {
      characterId: "character-1",
      name: "Test",
      description: "Glossary search test",
      iconFilePath: "",
      theme: { main: "#000000", sub: "#ffffff" },
      definitionMarkdown: "# Test",
      definitionSha256: "character-sha",
      definitionByteSize: 6,
      snapshotAt: "2026-01-01T00:00:00.000Z",
    },
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    model: "gpt-test",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "thread-1",
    messages: [],
    stream: [],
  };
}

function createProjection(revision: string, sequence: number): SessionGlossaryProjection {
  return {
    sessionId: "session-1",
    scopeRevision: `scope-${sequence}`,
    sequence,
    checkout: {
      repositoryName: "WithMate",
      branch: "main",
      pathLabel: "WithMate",
    },
    state: {
      status: "valid",
      relativePath: ".withmate/glossary.yaml",
      revision,
      entries: [{ term: "Base term", aliases: [], definition: "Base definition" }],
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve = (_value: T) => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

// @test-value v1
// kind = "regression"
// claim = "Session Glossaryの検索scopeが更新されると表示中の旧結果を消し、同じrevisionでも最新requestより前のresponseを一覧へ戻さない"
// oracle = { type = "contract", ref = "docs/features/repository-glossary.md#更新と監視" }
// failure_mode = "revision更新待ちに旧entryが残るか、同一revisionへ並行した遅い旧responseが最新検索結果を上書きする"
// scope = "App Session Glossary search UI"
// lifecycle = "permanent"
// distinction = "revision比較helper単体では観測できない、Appのrequest世代管理と描画状態遷移をconsumer DOMで検証する"
// @end-test-value
test("Glossary検索はscope更新時に旧結果を消し、遅い旧requestを表示へ戻さない", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
    url: "https://withmate.test/?sessionId=session-1",
  });
  const projectionA = createProjection("revision-a", 1);
  const projectionB = createProjection("revision-b", 2);
  let glossaryListener: ((projection: SessionGlossaryProjection) => void) | null = null;
  const searchRequests: Array<{
    query: string;
    deferred: ReturnType<typeof createDeferred<SearchResult>>;
  }> = [];
  const session = createSession();
  const knownApi = {
    getSession: async () => session,
    getSessionGlossaryProjection: async () => projectionA,
    searchSessionGlossary: async (_sessionId: string, request: { query: string }) => {
      const deferred = createDeferred<SearchResult>();
      searchRequests.push({ query: request.query, deferred });
      return deferred.promise;
    },
    subscribeSessionGlossary: (listener: (projection: SessionGlossaryProjection) => void) => {
      glossaryListener = listener;
      return () => undefined;
    },
    getAppSettings: async () => createDefaultAppSettings(),
    getModelCatalog: async () => null,
    getLiveSessionRun: async () => null,
    getActiveAuxiliarySession: async () => null,
    getAuxiliarySession: async () => null,
    listAuxiliarySessions: async () => [],
    listSessionAuditLogSummaryPage: async () => ({
      entries: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    }),
    listSessionTurnExecutions: async () => [],
    listWorkspaceSkills: async () => [],
    validateSessionWorkspace: async () => ({ valid: true as const }),
    isSessionFileObjectCopyAvailable: () => false,
    reportRendererLog: () => undefined,
  };
  const api = new Proxy(knownApi, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      if (typeof property === "string" && property.startsWith("subscribe")) {
        return () => () => undefined;
      }
      if (typeof property === "string" && property.startsWith("list")) {
        return async () => [];
      }
      if (typeof property === "string" && property.startsWith("get")) {
        return async () => null;
      }
      return async () => undefined;
    },
  }) as unknown as WithMateWindowApi;
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const { createRoot } = await import("react-dom/client");

  let root: Root | null = null;
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const setSearchQuery = async (query: string) => {
    const input = dom.window.document.querySelector<HTMLInputElement>(".glossary-search-field input");
    assert.ok(input);
    const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, query);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush();
  };
  const resolveSearch = async (index: number, revision: string, term: string) => {
    await act(async () => {
      searchRequests[index]?.deferred.resolve({
        ok: true,
        revision,
        entries: [{ term, aliases: [], definition: `${term} definition` }],
        total: 1,
        offset: 0,
        pageSize: 100,
      });
      await flush();
    });
  };

  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(App));
      await flush();
      await flush();
    });

    const nextTab = dom.window.document.querySelector<HTMLButtonElement>(
      'button[aria-label="次の表示へ切り替え"]',
    );
    assert.ok(nextTab);
    await act(async () => {
      nextTab.click();
      nextTab.click();
      await flush();
    });
    assert.ok(dom.window.document.querySelector(".glossary-search-field input"));

    await act(async () => setSearchQuery("first"));
    assert.equal(searchRequests.length, 1);
    await resolveSearch(0, "revision-a", "Old result");
    assert.match(dom.window.document.body.textContent ?? "", /Old result/);

    await act(async () => {
      glossaryListener?.(projectionB);
      await flush();
    });
    assert.equal(searchRequests.length, 2);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Old result/);
    assert.equal(
      dom.window.document.querySelector(".glossary-entry-list")?.getAttribute("aria-busy"),
      "true",
    );

    await act(async () => setSearchQuery("second"));
    assert.equal(searchRequests.length, 3);
    assert.equal(searchRequests[2]?.query, "second");
    await resolveSearch(2, "revision-b", "Current result");
    assert.match(dom.window.document.body.textContent ?? "", /Current result/);

    await resolveSearch(1, "revision-b", "Stale result");
    assert.match(dom.window.document.body.textContent ?? "", /Current result/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Stale result/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
  }
});
