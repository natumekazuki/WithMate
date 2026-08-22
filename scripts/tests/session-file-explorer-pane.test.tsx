import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  SessionDirectoryEntry,
  SessionFileSearchResult,
} from "../../src/file-explorer/file-explorer-contract.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  assert.fail("Timed out waiting for file explorer state.");
}

function fileEntry(name: string): SessionDirectoryEntry {
  return {
    name,
    relativePath: name,
    kind: "file",
    byteLength: 1,
    modifiedAt: "2026-08-02T00:00:00.000Z",
  };
}

function searchResult(name: string, relativePath: string): SessionFileSearchResult {
  return {
    status: "ok",
    groups: [{
      root: { id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" },
      entries: [{ name, relativePath }],
    }],
    exploredEntryCount: 1,
    matchedFileCount: 1,
    returnedFileCount: 1,
  };
}

test("SessionFileExplorerPane は directory load を明示展開と現行 request identity に限定する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousElement = globalThis.Element;
  const previousNode = globalThis.Node;
  const previousEvent = globalThis.Event;
  const previousInputEvent = globalThis.InputEvent;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  const previousGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const previousClientHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "clientHeight");
  const previousClientWidth = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "clientWidth");
  const previousOffsetHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "offsetHeight");
  const previousOffsetWidth = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, "offsetWidth");
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = this.classList.contains("session-file-explorer-body") ? 480 : 31;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 320,
      bottom: height,
      width: 320,
      height,
      toJSON: () => ({}),
    };
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("session-file-explorer-body") ? 480 : 31;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 320;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.classList.contains("session-file-explorer-body") ? 480 : 31;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 320;
    },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, "InputEvent", { configurable: true, value: dom.window.InputEvent });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const { SessionFileExplorerPane } = await import("../../src/file-explorer/SessionFileExplorerPane.js");

  const directoryRequests: Array<Deferred<SessionDirectoryEntry[]>> = [];
  const searchRequests: Array<{ query: string; deferred: Deferred<SessionFileSearchResult> }> = [];
  let directoryCalls = 0;
  const api = {
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:\\workspace" }];
    },
    listSessionDirectory() {
      directoryCalls += 1;
      const request = deferred<SessionDirectoryEntry[]>();
      directoryRequests.push(request);
      return request.promise;
    },
    searchSessionFiles(request: { query: string }) {
      const searchRequest = deferred<SessionFileSearchResult>();
      searchRequests.push({ query: request.query, deferred: searchRequest });
      return searchRequest.promise;
    },
  };
  let changesRefreshCalls = 0;
  const openedFiles: Array<{ relativePath: string; openInWindow: boolean }> = [];
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(SessionFileExplorerPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        selectedFile: null,
        activeTab: "files",
        onActiveTabChange() {},
        onRefreshChanges() {
          changesRefreshCalls += 1;
        },
        onOpenFile(request, openInWindow) {
          openedFiles.push({ relativePath: request.relativePath, openInWindow });
        },
      }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => dom.window.document.querySelector(".session-file-root-row") !== null);
    assert.equal(directoryCalls, 0);

    const initialRoot = dom.window.document.querySelector<HTMLButtonElement>(".session-file-root-row");
    assert.ok(initialRoot);
    await act(async () => {
      initialRoot.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      initialRoot.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      initialRoot.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(directoryCalls, 1);

    const refresh = dom.window.document.querySelector<HTMLButtonElement>(".session-file-explorer-refresh");
    assert.ok(refresh);
    await act(async () => {
      refresh.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await waitFor(() => dom.window.document.querySelector(".session-file-root-row") !== null);
    const refreshedRoot = dom.window.document.querySelector<HTMLButtonElement>(".session-file-root-row");
    assert.ok(refreshedRoot);
    await act(async () => {
      refreshedRoot.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(directoryCalls, 2);

    await act(async () => {
      directoryRequests[1]?.resolve([fileEntry("new.txt")]);
      await directoryRequests[1]?.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("new.txt") ?? false);
    const fileRow = dom.window.document.querySelector<HTMLButtonElement>(".session-file-tree-row");
    assert.ok(fileRow);
    await act(async () => {
      fileRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      fileRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });
    assert.deepEqual(openedFiles, [
      { relativePath: "new.txt", openInWindow: false },
      { relativePath: "new.txt", openInWindow: true },
    ]);

    await act(async () => {
      directoryRequests[0]?.resolve([fileEntry("old.txt")]);
      await directoryRequests[0]?.promise;
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent ?? "", /new\.txt/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /old\.txt/);

    const explorerBody = dom.window.document.querySelector<HTMLElement>(".session-file-explorer-body");
    assert.ok(explorerBody);
    explorerBody.scrollTop = 73;
    const searchInput = dom.window.document.querySelector<HTMLInputElement>(".session-file-search-input");
    assert.ok(searchInput);
    const setSearchInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value,
      }));
    };
    await act(async () => {
      setSearchInputValue(searchInput, "n");
      setSearchInputValue(searchInput, "new");
      explorerBody.scrollTop = 0;
      await Promise.resolve();
    });
    assert.equal(searchRequests.length, 0);
    await waitFor(() => searchRequests.length === 1);
    assert.equal(searchRequests[0]?.query, "new");
    assert.equal(searchInput.getAttribute("placeholder"), null);
    assert.equal(dom.window.document.querySelector(".session-file-search-loading"), null);
    assert.equal(dom.window.document.querySelector(".session-file-tree-status"), null);
    assert.equal(dom.window.document.querySelector(".session-file-search-input-row")?.getAttribute("aria-busy"), "true");
    assert.match(
      dom.window.document.querySelector(".session-file-search-loading-status")?.textContent ?? "",
      /Searching files…/,
    );
    await act(async () => {
      searchRequests[0]?.deferred.resolve({
        ...searchResult("search-result.ts", "src/search-result.ts"),
        status: "limit-reached",
        limit: "exploration",
      });
      await searchRequests[0]?.deferred.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("search-result.ts") ?? false);
    assert.match(dom.window.document.body.textContent ?? "", /src\/search-result\.ts/);
    assert.equal(dom.window.document.querySelectorAll(".session-file-search-root-row").length, 1);
    const searchLimit = dom.window.document.querySelector<HTMLElement>(".session-file-search-limit");
    assert.ok(searchLimit);
    assert.equal(searchLimit.querySelector(".session-file-search-limit-icon")?.textContent, "⚠");
    assert.match(searchLimit.getAttribute("title") ?? "", /Search was limited/);
    assert.match(searchLimit.querySelector(".visually-hidden")?.textContent ?? "", /more may be omitted/);
    const searchRow = dom.window.document.querySelector<HTMLButtonElement>(".session-file-search-row");
    assert.ok(searchRow);
    await act(async () => {
      searchRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      searchRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    });

    await act(async () => {
      setSearchInputValue(searchInput, "old");
      await Promise.resolve();
    });
    await waitFor(() => searchRequests.length === 2);
    await act(async () => {
      setSearchInputValue(searchInput, "newer");
      await Promise.resolve();
    });
    await waitFor(() => searchRequests.length === 3);
    await act(async () => {
      searchRequests[2]?.deferred.resolve(searchResult("newer-result.ts", "src/newer-result.ts"));
      await searchRequests[2]?.deferred.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("newer-result.ts") ?? false);
    await act(async () => {
      searchRequests[1]?.deferred.resolve(searchResult("old-result.ts", "src/old-result.ts"));
      await searchRequests[1]?.deferred.promise;
    });
    assert.match(dom.window.document.body.textContent ?? "", /newer-result\.ts/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /old-result\.ts/);

    await act(async () => {
      setSearchInputValue(searchInput, "broken");
      await Promise.resolve();
    });
    await waitFor(() => searchRequests.length === 4);
    await act(async () => {
      searchRequests[3]?.deferred.reject(new Error("search failed"));
      await assert.rejects(searchRequests[3]?.deferred.promise, /search failed/);
    });
    await waitFor(() => dom.window.document.querySelector(".session-file-search-error") !== null);
    assert.match(dom.window.document.body.textContent ?? "", /newer-result\.ts/);
    const retry = dom.window.document.querySelector<HTMLButtonElement>(".session-file-search-error button");
    assert.ok(retry);
    await act(async () => retry.click());
    await waitFor(() => searchRequests.length === 5);
    await act(async () => {
      searchRequests[4]?.deferred.resolve(searchResult("recovered.ts", "src/recovered.ts"));
      await searchRequests[4]?.deferred.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("recovered.ts") ?? false);
    assert.equal(dom.window.document.querySelector(".session-file-search-error"), null);

    await act(async () => {
      root?.render(React.createElement(SessionFileExplorerPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        selectedFile: null,
        activeTab: "changes",
        onActiveTabChange() {},
        onRefreshChanges() {
          changesRefreshCalls += 1;
        },
        onOpenFile() {},
        changesContent: React.createElement("div", null, "Changes content"),
      }));
    });
    assert.equal(dom.window.document.querySelector(".session-file-search-input"), null);
    const changesRefresh = dom.window.document.querySelector<HTMLButtonElement>(".session-file-explorer-refresh");
    assert.ok(changesRefresh);
    assert.equal(changesRefresh.ariaLabel, "Refresh changes");
    await act(async () => changesRefresh.click());
    assert.equal(changesRefreshCalls, 1);

    await act(async () => {
      root?.render(React.createElement(SessionFileExplorerPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        selectedFile: null,
        activeTab: "files",
        onActiveTabChange() {},
        onRefreshChanges() {},
        onOpenFile() {},
      }));
      await Promise.resolve();
    });
    await waitFor(() => searchRequests.length === 6);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>(".session-file-search-input")?.value, "broken");
    await act(async () => {
      searchRequests[5]?.deferred.resolve(searchResult("returned.ts", "src/returned.ts"));
      await searchRequests[5]?.deferred.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("returned.ts") ?? false);
    const restoredSearchInput = dom.window.document.querySelector<HTMLInputElement>(".session-file-search-input");
    assert.ok(restoredSearchInput);
    await act(async () => {
      setSearchInputValue(restoredSearchInput, "");
      await Promise.resolve();
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("new.txt") ?? false);
    assert.equal(explorerBody.scrollTop, 73);
    assert.equal(searchRequests.length, 6);

    const sessionSearchInput = dom.window.document.querySelector<HTMLInputElement>(".session-file-search-input");
    assert.ok(sessionSearchInput);
    await act(async () => {
      setSearchInputValue(sessionSearchInput, "stale-session");
      await Promise.resolve();
    });
    await waitFor(() => searchRequests.length === 7);
    await act(async () => {
      root?.render(React.createElement(SessionFileExplorerPane, {
        api,
        sessionId: "session-2",
        enabled: true,
        rootsRevision: "roots-2",
        selectedFile: null,
        activeTab: "files",
        onActiveTabChange() {},
        onRefreshChanges() {},
        onOpenFile() {},
      }));
      await Promise.resolve();
    });
    await waitFor(() => dom.window.document.querySelector<HTMLInputElement>(".session-file-search-input")?.value === "");
    assert.equal(searchRequests.length, 7);
    await act(async () => {
      searchRequests[6]?.deferred.resolve(searchResult("stale-session.ts", "stale-session.ts"));
      await searchRequests[6]?.deferred.promise;
    });
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /stale-session\.ts/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previousHTMLElement });
    Object.defineProperty(globalThis, "Element", { configurable: true, value: previousElement });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "Event", { configurable: true, value: previousEvent });
    Object.defineProperty(globalThis, "InputEvent", { configurable: true, value: previousInputEvent });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    dom.window.HTMLElement.prototype.getBoundingClientRect = previousGetBoundingClientRect;
    if (previousClientHeight) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", previousClientHeight);
    }
    if (previousClientWidth) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", previousClientWidth);
    }
    if (previousOffsetHeight) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", previousOffsetHeight);
    }
    if (previousOffsetWidth) {
      Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", previousOffsetWidth);
    }
    dom.window.close();
  }
});
