import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SessionDirectoryEntry } from "../../src/file-explorer/file-explorer-contract.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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

function directoryEntry(name: string): SessionDirectoryEntry {
  return {
    name,
    relativePath: name,
    kind: "directory",
    byteLength: 0,
    modifiedAt: "2026-08-02T00:00:00.000Z",
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
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const { SessionFileExplorerPane } = await import("../../src/file-explorer/SessionFileExplorerPane.js");

  const directoryRequests: Array<Deferred<SessionDirectoryEntry[]>> = [];
  const copyMenuRequests: unknown[] = [];
  let directoryCalls = 0;
  const api = {
    isSessionFileObjectCopyAvailable() {
      return true;
    },
    async showSessionFileObjectCopyContextMenu(request: unknown) {
      copyMenuRequests.push(request);
      return { status: "effect-unknown" as const, message: "File copy status is unknown." };
    },
    async listSessionFileRoots() {
      return [{ id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:\\workspace" }];
    },
    listSessionDirectory() {
      directoryCalls += 1;
      const request = deferred<SessionDirectoryEntry[]>();
      directoryRequests.push(request);
      return request.promise;
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
      directoryRequests[1]?.resolve([fileEntry("new.txt"), directoryEntry("folder")]);
      await directoryRequests[1]?.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("new.txt") ?? false);
    const rows = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".session-file-tree-row"));
    const fileRow = rows.find((row) => row.textContent?.includes("new.txt"));
    const directoryRow = rows.find((row) => row.textContent?.includes("folder"));
    assert.ok(fileRow);
    assert.ok(directoryRow);
    await act(async () => {
      fileRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      fileRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
      directoryRow.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 18,
      }));
      fileRow.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 48,
      }));
      await Promise.resolve();
    });
    assert.deepEqual(openedFiles, [
      { relativePath: "new.txt", openInWindow: false },
      { relativePath: "new.txt", openInWindow: true },
    ]);
    assert.deepEqual(copyMenuRequests, [{
      resource: { sessionId: "session-1", rootId: "workspace", relativePath: "new.txt" },
      point: { x: 24, y: 48 },
    }]);
    assert.equal(
      dom.window.document.querySelector(".session-file-tree-feedback")?.textContent,
      "File copy status is unknown.",
    );

    await act(async () => {
      directoryRequests[0]?.resolve([fileEntry("old.txt")]);
      await directoryRequests[0]?.promise;
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent ?? "", /new\.txt/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /old\.txt/);

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
    const changesRefresh = dom.window.document.querySelector<HTMLButtonElement>(".session-file-explorer-refresh");
    assert.ok(changesRefresh);
    assert.equal(changesRefresh.ariaLabel, "Refresh changes");
    await act(async () => changesRefresh.click());
    assert.equal(changesRefreshCalls, 1);
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
