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

// @test-value v1
// kind = "invariant"
// claim = "Files treeはroot・directory・regular fileだけを同じpath context menu契約へ渡し、通常clickとload identityを維持する"
// oracle = { type = "contract", ref = "accepted behavior: File Explorer tree path context menu siblings" }
// failure_mode = "rootまたはdirectoryでpath操作できない、対象外rowに操作が出る、またはcontext menu追加で通常clickと非同期loadが回帰する"
// scope = "SessionFileExplorerPane Files tree interaction"
// lifecycle = "permanent"
// distinction = "root・directory・fileの兄弟入口とsymbolic link除外を、既存click/load observableと同時に確認する"
// @end-test-value
test("SessionFileExplorerPane は path menu対象と既存tree操作をowner単位に保つ", async () => {
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
  const pathMenuRequests: unknown[] = [];
  let directoryCalls = 0;
  const api = {
    async showSessionFileTreeContextMenu(request: unknown) {
      pathMenuRequests.push(request);
      return (request as { nodeKind?: string }).nodeKind === "file"
        ? { status: "failed" as const, message: "Path action failed." }
        : { status: "dismissed" as const };
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
        canInsertPathReference: true,
        onInsertPathReference() {},
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
    initialRoot.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 6,
      clientY: 9,
    }));
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
      directoryRequests[1]?.resolve([
        fileEntry("new.txt"),
        directoryEntry("folder"),
        { ...fileEntry("linked.txt"), kind: "symbolic-link" },
      ]);
      await directoryRequests[1]?.promise;
    });
    await waitFor(() => dom.window.document.body.textContent?.includes("new.txt") ?? false);
    const rows = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".session-file-tree-row"));
    const fileRow = rows.find((row) => row.textContent?.includes("new.txt"));
    const directoryRow = rows.find((row) => row.textContent?.includes("folder"));
    const symbolicLinkRow = rows.find((row) => row.textContent?.includes("linked.txt"));
    assert.ok(fileRow);
    assert.ok(directoryRow);
    assert.ok(symbolicLinkRow);
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
      symbolicLinkRow.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 60,
      }));
      await Promise.resolve();
    });
    assert.deepEqual(openedFiles, [
      { relativePath: "new.txt", openInWindow: false },
      { relativePath: "new.txt", openInWindow: true },
    ]);
    assert.deepEqual(pathMenuRequests, [
      {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "",
        nodeKind: "root",
        canInsert: true,
        point: { x: 6, y: 9 },
      },
      {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "folder",
        nodeKind: "directory",
        canInsert: true,
        point: { x: 12, y: 18 },
      },
      {
        sessionId: "session-1",
        rootId: "workspace",
        relativePath: "new.txt",
        nodeKind: "file",
        canInsert: true,
        point: { x: 24, y: 48 },
      },
    ]);
    assert.equal(
      dom.window.document.querySelector(".session-file-tree-feedback")?.textContent,
      "Path action failed.",
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
        canInsertPathReference: false,
        onInsertPathReference() {},
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

// @test-value v1
// kind = "invariant"
// claim = "path insertion resultはaction確定時にも同じactive ownerかつ書き込み可能なcomposerだけへ渡る"
// oracle = { type = "contract", ref = "accepted behavior: File Explorer path insertion owner revalidation" }
// failure_mode = "menu表示後のowner切替またはcomposer無効化後に別ownerや書き込み不可draftへpathを挿入する"
// scope = "SessionFileExplorerPane path insertion result boundary"
// lifecycle = "permanent"
// distinction = "menu request時のcapabilityではなくresult適用時の最新ownerとcapabilityを観測する"
// @end-test-value
test("SessionFileExplorerPane は path insertion result適用時にownerとcapabilityを再確認する", async () => {
  const { applySessionFileTreePathInsertionResult } = await import(
    "../../src/file-explorer/SessionFileExplorerPane.js"
  );
  const inserted: string[] = [];
  const result = {
    status: "insert-path",
    ownerSessionId: "session-1",
    absolutePath: "C:\\workspace\\docs\\report.md",
  };
  const insertPathReference = (_ownerSessionId: string, absolutePath: string) => inserted.push(absolutePath);

  assert.equal(applySessionFileTreePathInsertionResult({
    result,
    currentOwnerSessionId: "session-2",
    canInsert: true,
    insertPathReference,
  }), false);
  assert.equal(applySessionFileTreePathInsertionResult({
    result,
    currentOwnerSessionId: "session-1",
    canInsert: false,
    insertPathReference,
  }), false);
  assert.equal(applySessionFileTreePathInsertionResult({
    result,
    currentOwnerSessionId: "session-1",
    canInsert: true,
    insertPathReference,
  }), true);
  assert.deepEqual(inserted, ["C:\\workspace\\docs\\report.md"]);
});

// @test-value v1
// kind = "contract"
// claim = "SessionFileExplorerPaneはowner単位でtabをlazy mountし、tab切替では保持してowner変更時に破棄する"
// oracle = { type = "contract", ref = "accepted behavior: in-window File Explorer tab state retention" }
// failure_mode = "tab切替で取得結果が失われるか、Sessionまたはroot集合の変更後も旧panel stateが残る"
// scope = "SessionFileExplorerPane tab panel lifecycle"
// lifecycle = "permanent"
// distinction = "同一owner内のtab切替と、Session・root集合によるowner変更を一つのlifecycleとして扱う"
// @end-test-value
test("SessionFileExplorerPane は訪問済みtab panelを保持する", async () => {
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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const { SessionFileExplorerPane } = await import("../../src/file-explorer/SessionFileExplorerPane.js");

  function StatefulPanel({ name }: { name: string }) {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      "button",
      { type: "button", "data-panel": name, onClick: () => setCount((current) => current + 1) },
      `${name}:${count}`,
    );
  }

  const api = {
    async listSessionFileRoots() {
      return [];
    },
    async listSessionDirectory() {
      return [];
    },
    async showSessionFileTreeContextMenu() {
      return { status: "dismissed" as const };
    },
  };
  function Harness({ sessionId, rootsRevision }: { sessionId: string; rootsRevision: string }) {
    const [activeTab, setActiveTab] = React.useState<"files" | "changes" | "history">("files");
    return React.createElement(SessionFileExplorerPane, {
      api,
      sessionId,
      enabled: true,
      rootsRevision,
      selectedFile: null,
      activeTab,
      onActiveTabChange: setActiveTab,
      onRefreshChanges() {},
      onOpenFile() {},
      canInsertPathReference: false,
      onInsertPathReference() {},
      renderChangesContent: () => React.createElement(StatefulPanel, { name: "changes" }),
      historyContent: React.createElement(StatefulPanel, { name: "history" }),
    });
  }

  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(Harness, { sessionId: "session-1", rootsRevision: "roots-1" }));
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector("[data-panel='changes']"), null);
    assert.equal(dom.window.document.querySelector("[data-panel='history']"), null);

    const tabs = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    const filesTab = tabs.find((tab) => tab.textContent === "Files");
    const changesTab = tabs.find((tab) => tab.textContent === "Changes");
    const historyTab = tabs.find((tab) => tab.textContent === "History");
    assert.ok(filesTab);
    assert.ok(changesTab);
    assert.ok(historyTab);

    await act(async () => changesTab.click());
    const changesPanel = dom.window.document.querySelector<HTMLButtonElement>("[data-panel='changes']");
    assert.ok(changesPanel);
    await act(async () => changesPanel.click());
    assert.equal(changesPanel.textContent, "changes:1");

    await act(async () => historyTab.click());
    assert.equal(changesPanel.closest("[role='tabpanel']")?.hasAttribute("hidden"), true);
    const historyPanel = dom.window.document.querySelector<HTMLButtonElement>("[data-panel='history']");
    assert.ok(historyPanel);
    await act(async () => historyPanel.click());
    assert.equal(historyPanel.textContent, "history:1");

    await act(async () => filesTab.click());
    assert.equal(historyPanel.closest("[role='tabpanel']")?.hasAttribute("hidden"), true);
    await act(async () => changesTab.click());
    assert.equal(changesPanel.textContent, "changes:1");
    await act(async () => historyTab.click());
    assert.equal(historyPanel.textContent, "history:1");
    await act(async () => {
      root?.render(React.createElement(Harness, { sessionId: "session-1", rootsRevision: "roots-2" }));
      await Promise.resolve();
    });
    const nextHistoryPanel = dom.window.document.querySelector<HTMLButtonElement>("[data-panel='history']");
    assert.ok(nextHistoryPanel);
    assert.notEqual(nextHistoryPanel, historyPanel);
    assert.equal(nextHistoryPanel.textContent, "history:0");
    await act(async () => changesTab.click());
    const nextChangesPanel = dom.window.document.querySelector<HTMLButtonElement>("[data-panel='changes']");
    assert.ok(nextChangesPanel);
    assert.notEqual(nextChangesPanel, changesPanel);
    await act(async () => nextChangesPanel.click());
    assert.equal(nextChangesPanel.textContent, "changes:1");
    await act(async () => {
      root?.render(React.createElement(Harness, { sessionId: "session-2", rootsRevision: "roots-2" }));
      await Promise.resolve();
    });
    const nextSessionChangesPanel = dom.window.document.querySelector<HTMLButtonElement>("[data-panel='changes']");
    assert.ok(nextSessionChangesPanel);
    assert.notEqual(nextSessionChangesPanel, nextChangesPanel);
    assert.equal(nextSessionChangesPanel.textContent, "changes:0");
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
    dom.window.close();
  }
});
