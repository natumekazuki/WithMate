import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  FileRootFileDiffRequest,
  FileRootGitChangeEntry,
} from "../../src/file-explorer/file-explorer-contract.js";

test("FileRootChangesPane は大量の変更を constrained viewport 内で仮想化する", async () => {
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
    const height = this.classList.contains("workspace-changes-list") ? 480 : 30;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 280,
      bottom: height,
      width: 280,
      height,
      toJSON: () => ({}),
    };
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.classList.contains("workspace-changes-list") ? 480 : 30;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 280;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.classList.contains("workspace-changes-list") ? 480 : 30;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 280;
    },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const { FileRootChangesPane } = await import("../../src/file-explorer/FileRootChangesPane.js");

  const entries: FileRootGitChangeEntry[] = Array.from({ length: 400 }, (_, index) => ({
    relativePath: index === 0 ? "src/00-shared.ts" : `src/file-${index}.ts`,
    previousRelativePath: null,
    scopes: ["working-tree"],
    kinds: { "working-tree": "modified", staged: null },
  }));
  const additionalEntries: FileRootGitChangeEntry[] = [{
    relativePath: "app/src/00-shared.ts",
    previousRelativePath: null,
    scopes: ["working-tree"],
    kinds: { "working-tree": "modified" },
  }];
  const requestedRootIds: string[] = [];
  const diffRequests: FileRootFileDiffRequest[] = [];
  let rootListFailure: Error | null = null;
  let workspaceEntries = entries;
  const testApi = {
    listSessionFileRoots: async () => {
      if (rootListFailure) {
        throw rootListFailure;
      }
      return [
        { id: "session-folder", kind: "session-folder" as const, label: "Session Folder", displayPath: "C:/session" },
        { id: "additional:broken", kind: "additional" as const, label: "broken", displayPath: "C:/broken" },
        { id: "additional:repo", kind: "additional" as const, label: "repo", displayPath: "C:/repo" },
        { id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:/repo/app" },
      ];
    },
    listFileRootChanges: async (request: { rootId: string }) => {
      requestedRootIds.push(request.rootId);
      if (request.rootId === "session-folder") {
        return { status: "not-git" as const, message: "Not a Git repository." };
      }
      if (request.rootId === "additional:broken") {
        return { status: "failed" as const, message: "Git status failed for broken root." };
      }
      return {
        status: "ok" as const,
        entries: request.rootId === "workspace" ? workspaceEntries : additionalEntries,
      };
    },
  };
  const baseProps = {
    api: testApi,
    enabled: true,
    rootsRevision: "roots-1",
    refreshRevision: 0,
    onOpenFile: () => undefined,
    onOpenDiff: async (request: FileRootFileDiffRequest) => {
      diffRequests.push(request);
      return null;
    },
  };
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
      }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const groups = [...dom.window.document.querySelectorAll<HTMLElement>(".workspace-changes-root-group")];
    const lists = [...dom.window.document.querySelectorAll<HTMLElement>(".workspace-changes-list")];
    const rows = [...dom.window.document.querySelectorAll<HTMLElement>(".workspace-change-virtual-row")];
    assert.equal(groups.length, 3);
    assert.equal(lists.length, 3);
    assert.ok(lists.every((list) => list.tabIndex === 0));
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Live root status/);
    assert.equal(dom.window.document.querySelector(".workspace-changes-refresh"), null);
    assert.equal(
      groups.find((group) => group.dataset.rootId === "workspace")
        ?.querySelector(".workspace-changes-root-count")?.textContent,
      String(entries.length),
    );
    assert.equal(groups.find((group) => group.dataset.rootId === "additional:broken")?.style.minHeight, "78px");
    assert.equal(groups.find((group) => group.dataset.rootId === "additional:repo")?.style.maxHeight, "230px");
    assert.equal(groups.find((group) => group.dataset.rootId === "workspace")?.style.maxHeight, "408px");
    assert.deepEqual(requestedRootIds, ["session-folder", "additional:broken", "additional:repo", "workspace"]);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Session Folder/);
    assert.match(dom.window.document.body.textContent ?? "", /Git status failed for broken root/);
    assert.match(dom.window.document.body.textContent ?? "", /repo/);
    assert.match(dom.window.document.body.textContent ?? "", /Workspace/);
    assert.ok(rows.length > 0, dom.window.document.body.innerHTML);
    assert.ok(rows.length < entries.length, `mounted ${rows.length} rows for ${entries.length} entries`);
    assert.ok(rows.every((row) => row.dataset.index !== undefined));
    const rootPath = dom.window.document.querySelector<HTMLElement>(
      ".workspace-changes-root-header[title='C:/repo'] .workspace-changes-root-path",
    );
    assert.equal(rootPath?.textContent, "C:/repo");

    const appDirectory = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".workspace-change-directory-row")]
      .find((button) => button.title === "app");
    assert.ok(appDirectory);
    assert.equal(appDirectory.getAttribute("aria-expanded"), "true");
    await act(async () => appDirectory.click());
    assert.equal(
      [...dom.window.document.querySelectorAll<HTMLButtonElement>(".workspace-change-row")]
        .some((button) => button.title === "app/src/00-shared.ts"),
      false,
    );
    assert.equal(appDirectory.getAttribute("aria-expanded"), "false");
    await act(async () => appDirectory.click());

    const additionalChange = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".workspace-change-row")]
      .find((button) => button.title === "app/src/00-shared.ts");
    const workspaceChange = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".workspace-change-row")]
      .find((button) => button.title === "src/00-shared.ts");
    assert.ok(additionalChange);
    assert.ok(workspaceChange);
    await act(async () => {
      additionalChange.click();
      await Promise.resolve();
    });
    await act(async () => {
      workspaceChange.click();
      await Promise.resolve();
    });
    assert.deepEqual(diffRequests.map(({ rootId, relativePath }) => ({ rootId, relativePath })), [
      { rootId: "additional:repo", relativePath: "app/src/00-shared.ts" },
      { rootId: "workspace", relativePath: "src/00-shared.ts" },
    ]);

    const repoList = dom.window.document.querySelector<HTMLElement>(
      ".workspace-changes-root-group[data-root-id='additional:repo'] .workspace-changes-list",
    );
    const workspaceList = dom.window.document.querySelector<HTMLElement>(
      ".workspace-changes-root-group[data-root-id='workspace'] .workspace-changes-list",
    );
    assert.ok(repoList);
    assert.ok(workspaceList);
    repoList.scrollTop = 20;
    workspaceList.scrollTop = 120;
    assert.equal(repoList.scrollTop, 20);
    assert.equal(workspaceList.scrollTop, 120);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
        refreshRevision: 1,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const refreshedRepoList = dom.window.document.querySelector<HTMLElement>(
      ".workspace-changes-root-group[data-root-id='additional:repo'] .workspace-changes-list",
    );
    const refreshedWorkspaceList = dom.window.document.querySelector<HTMLElement>(
      ".workspace-changes-root-group[data-root-id='workspace'] .workspace-changes-list",
    );
    assert.equal(refreshedRepoList, repoList);
    assert.equal(refreshedWorkspaceList, workspaceList);
    assert.equal(refreshedRepoList?.scrollTop, 20);
    assert.equal(refreshedWorkspaceList?.scrollTop, 120);

    rootListFailure = new Error("Temporary root refresh failure.");
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
        refreshRevision: 2,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".workspace-changes-root-group[data-root-id='additional:repo'] .workspace-changes-list"),
      repoList,
    );
    assert.equal(
      dom.window.document.querySelector(".workspace-changes-root-group[data-root-id='workspace'] .workspace-changes-list"),
      workspaceList,
    );
    assert.equal(repoList.scrollTop, 20);
    assert.equal(workspaceList.scrollTop, 120);
    assert.match(dom.window.document.body.textContent ?? "", /Temporary root refresh failure/);

    rootListFailure = null;
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
        refreshRevision: 3,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".workspace-changes-root-group[data-root-id='workspace'] .workspace-changes-list"),
      workspaceList,
    );
    assert.equal(workspaceList.scrollTop, 120);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Temporary root refresh failure/);

    workspaceEntries = entries.slice(0, 1);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
        refreshRevision: 4,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      dom.window.document.querySelector(".workspace-changes-root-group[data-root-id='workspace'] .workspace-changes-list"),
      workspaceList,
    );
    assert.equal(workspaceList.scrollTop, 0);
    assert.equal(repoList.scrollTop, 20);

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-2",
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const nextSessionWorkspaceList = dom.window.document.querySelector<HTMLElement>(
      ".workspace-changes-root-group[data-root-id='workspace'] .workspace-changes-list",
    );
    assert.ok(nextSessionWorkspaceList);
    assert.notEqual(nextSessionWorkspaceList, workspaceList);
    assert.equal(nextSessionWorkspaceList.scrollTop, 0);

    let rejectStaleRequest: ((reason?: unknown) => void) | null = null;
    let statusRequestCount = 0;
    const staleReloadApi = {
      listSessionFileRoots: async () => [
        { id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:/repo/app" },
      ],
      listFileRootChanges: async () => {
        statusRequestCount += 1;
        if (statusRequestCount === 1) {
          return new Promise<never>((_resolve, reject) => {
            rejectStaleRequest = reject;
          });
        }
        return {
          status: "ok" as const,
          entries: [{
            relativePath: "new.txt",
            previousRelativePath: null,
            scopes: ["working-tree" as const],
            kinds: { "working-tree": "modified" as const },
          }],
        };
      },
    };
    const staleReloadProps = {
      api: staleReloadApi,
      sessionId: "session-1",
      enabled: true,
      refreshRevision: 0,
      onOpenFile: () => undefined,
      onOpenDiff: async () => null,
    };
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...staleReloadProps,
        rootsRevision: "stale-1",
      }));
      await Promise.resolve();
    });
    assert.ok(rejectStaleRequest);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...staleReloadProps,
        rootsRevision: "stale-2",
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(dom.window.document.body.textContent ?? "", /new\.txt/);
    await act(async () => {
      rejectStaleRequest?.(new Error("stale root failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(dom.window.document.body.textContent ?? "", /new\.txt/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /stale root failure/);
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
