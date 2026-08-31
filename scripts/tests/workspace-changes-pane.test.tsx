import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  FileRootChangesResult,
  FileRootFileDiffRequest,
  FileRootGitChangeEntry,
  SessionFileRoot,
} from "../../src/file-explorer/file-explorer-contract.js";

// @test-value v1
// kind = "contract"
// claim = "Changes pane は認可済みroot枠だけを先に表示し、明示Refresh以外ではChanges取得を開始しない"
// oracle = { type = "contract", ref = "accepted behavior: manual Changes refresh" }
// failure_mode = "初回表示に不要なidle説明が出るか、再描画、root集合変更、Session切替でGit statusが暗黙に実行される"
// scope = "FileRootChangesPane refresh boundary"
// lifecycle = "permanent"
// distinction = "取得後のrepository別完了順ではなく、取得を開始できる操作を検証する"
// @end-test-value
test("FileRootChangesPane は明示RefreshだけでChangesを取得する", async () => {
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
  const { FileRootChangesPane } = await import("../../src/file-explorer/FileRootChangesPane.js");

  type ChangesResult = { status: "ok"; entries: FileRootGitChangeEntry[] };
  const repositoryRequests: Array<{ sessionId: string; rootIds: string[] }> = [];
  const changesRequests: Array<{ sessionId: string; rootId: string }> = [];
  const pendingChanges: Array<(result: ChangesResult) => void> = [];
  const testApi = {
    listFileRootChangesRepositories: async (request: { sessionId: string; rootIds: string[] }) => {
      repositoryRequests.push(request);
      return {
        status: "ok" as const,
        repositories: request.rootIds.map((rootId) => ({ rootId })),
        failures: [],
      };
    },
    listFileRootChanges: async (request: { sessionId: string; rootId: string }) => {
      changesRequests.push(request);
      return new Promise<ChangesResult>((resolve) => pendingChanges.push(resolve));
    },
  };
  const roots: SessionFileRoot[] = [
    { id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:/repo" },
  ];
  const baseProps = {
    api: testApi,
    sessionId: "session-1",
    enabled: true,
    roots,
    rootsRevision: "roots-1",
    refreshRevision: 0,
    onOpenFile: () => undefined,
    onOpenDiff: async () => null,
  };
  const completeRequest = async (index: number) => {
    await act(async () => {
      pendingChanges[index]?.({ status: "ok", entries: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootChangesPane, baseProps));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(repositoryRequests, [{ sessionId: "session-1", rootIds: ["workspace"] }]);
    assert.equal(dom.window.document.querySelectorAll(".workspace-changes-root-group").length, 1);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Not loaded/);
    assert.deepEqual(changesRequests, []);

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      root?.render(React.createElement(FileRootChangesPane, baseProps));
      await Promise.resolve();
    });
    assert.equal(changesRequests.length, 0);

    const refreshedProps = { ...baseProps, refreshRevision: 1 };
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, refreshedProps));
      await Promise.resolve();
    });
    assert.deepEqual(changesRequests, [{ sessionId: "session-1", rootId: "workspace" }]);
    await completeRequest(0);

    await act(async () => {
      root?.render(React.createElement("div"));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, refreshedProps));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(changesRequests.length, 1);
    assert.equal(repositoryRequests.length, 2);

    const nextRoots: SessionFileRoot[] = [
      { id: "additional:repo", kind: "additional", label: "Repo", displayPath: "C:/other" },
    ];
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...refreshedProps,
        roots: nextRoots,
        rootsRevision: "roots-2",
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(changesRequests.length, 1);
    assert.deepEqual(repositoryRequests.at(-1), { sessionId: "session-1", rootIds: ["additional:repo"] });
    assert.equal(dom.window.document.querySelector("[data-root-id='workspace']"), null);
    assert.ok(dom.window.document.querySelector("[data-root-id='additional:repo']"));

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...refreshedProps,
        sessionId: "session-2",
        roots: nextRoots,
        rootsRevision: "roots-2",
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(changesRequests.length, 1);
    assert.deepEqual(repositoryRequests.at(-1), { sessionId: "session-2", rootIds: ["additional:repo"] });

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...refreshedProps,
        sessionId: "session-2",
        roots: nextRoots,
        rootsRevision: "roots-2",
        refreshRevision: 2,
      }));
      await Promise.resolve();
    });
    assert.deepEqual(changesRequests.at(-1), { sessionId: "session-2", rootId: "additional:repo" });
    await completeRequest(1);
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

// @test-value v1
// kind = "regression"
// claim = "Changes paneはGit repository discovery中を視覚spinnerとscreen reader向けstatusで示す"
// oracle = { type = "contract", ref = "user feedback: Changes tab loading indicator" }
// failure_mode = "Changes tabへの切替時にrepository discoveryのloadingがvisible textだけで表示される"
// scope = "FileRootChangesPane repository discovery loading state"
// lifecycle = "permanent"
// distinction = "Refresh後のrepository別pendingではなく、Changes tab切替直後のrepository discovery pendingを扱う"
// @end-test-value
test("FileRootChangesPane はrepository discovery中をspinnerで示す", async () => {
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
  const style = dom.window.document.createElement("style");
  style.textContent = (await readFile(new URL("../../src/styles.css", import.meta.url), "utf8"))
    .replace(/^@import .*;$/gm, "");
  dom.window.document.head.append(style);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: dom.window.Element });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  const { FileRootChangesPane } = await import("../../src/file-explorer/FileRootChangesPane.js");

  const testApi = {
    listFileRootChangesRepositories: async () => new Promise<{
      status: "ok";
      repositories: Array<{ rootId: string }>;
      failures: [];
    }>(() => undefined),
    listFileRootChanges: async () => ({ status: "ok" as const, entries: [] }),
  };
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootChangesPane, {
        api: testApi,
        sessionId: "session-1",
        enabled: true,
        roots: [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:/repo" }],
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenFile: () => undefined,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });

    const status = dom.window.document.querySelector("[role='status']");
    assert.ok(status);
    const spinner = status.querySelector<HTMLElement>(".workspace-changes-spinner[aria-hidden='true']");
    assert.ok(spinner);
    const spinnerStyle = dom.window.getComputedStyle(spinner);
    assert.equal(spinnerStyle.width, "24px");
    assert.equal(spinnerStyle.height, "24px");
    assert.equal(spinnerStyle.borderTopStyle, "solid");
    assert.equal(status.querySelector(".visually-hidden")?.textContent, "Discovering Git repositories");
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

// @test-value v1
// kind = "regression"
// claim = "repository別groupはnon-Git結果を除外し、失敗を局所表示しながら既存の変更導線と仮想化を維持する"
// oracle = { type = "contract", ref = "MT-023D10 and MT-023D10A" }
// failure_mode = "手動Refresh化に伴ってnon-Git除外、repository別failure、directory collapse、diff/file previewまたは大量表示が壊れる"
// scope = "FileRootChangesPane repository groups"
// lifecycle = "permanent"
// distinction = "取得開始条件ではなく、取得後の既存group操作と表示を検証する"
// @end-test-value
test("FileRootChangesPane はrepository別groupの既存導線と仮想化を維持する", async () => {
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
  const additionalEntries: FileRootGitChangeEntry[] = [
    {
      relativePath: "app/src/00-shared.ts",
      previousRelativePath: null,
      scopes: ["working-tree"],
      kinds: { "working-tree": "modified" },
    },
    {
      relativePath: "notes.txt",
      previousRelativePath: null,
      scopes: ["working-tree"],
      kinds: { "working-tree": "untracked" },
    },
  ];
  const requestedRootIds: string[] = [];
  const diffRequests: Array<FileRootFileDiffRequest & { openInWindow: boolean }> = [];
  const fileRequests: Array<{
    sessionId: string;
    rootId: string;
    relativePath: string;
    openInWindow: boolean;
  }> = [];
  let workspaceEntries = entries;
  const roots: SessionFileRoot[] = [
    { id: "session-folder", kind: "session-folder", label: "Session Folder", displayPath: "C:/session" },
    { id: "additional:broken", kind: "additional", label: "broken", displayPath: "C:/broken" },
    { id: "additional:repo", kind: "additional", label: "repo", displayPath: "C:/repo" },
    { id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:/repo/app" },
  ];
  const testApi = {
    listFileRootChangesRepositories: async () => ({
      status: "ok" as const,
      repositories: ["additional:broken", "additional:repo", "workspace"].map((rootId) => ({ rootId })),
      failures: [],
    }),
    listFileRootChanges: async (request: { rootId: string }) => {
      requestedRootIds.push(request.rootId);
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
    roots,
    rootsRevision: "roots-1",
    refreshRevision: 0,
    onOpenFile: async (request: { sessionId: string; rootId: string; relativePath: string }, openInWindow: boolean) => {
      fileRequests.push({ ...request, openInWindow });
      return null;
    },
    onOpenDiff: async (request: FileRootFileDiffRequest, openInWindow: boolean) => {
      diffRequests.push({ ...request, openInWindow });
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
      await Promise.resolve();
    });
    await act(async () => {
      root.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
        refreshRevision: 1,
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
    assert.equal(groups.find((group) => group.dataset.rootId === "additional:repo")?.style.maxHeight, "260px");
    assert.equal(groups.find((group) => group.dataset.rootId === "workspace")?.style.maxHeight, "408px");
    assert.deepEqual(requestedRootIds, ["additional:broken", "additional:repo", "workspace"]);
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
    assert.deepEqual(diffRequests.map(({ rootId, relativePath, openInWindow }) => ({
      rootId,
      relativePath,
      openInWindow,
    })), [
      { rootId: "additional:repo", relativePath: "app/src/00-shared.ts", openInWindow: false },
      { rootId: "workspace", relativePath: "src/00-shared.ts", openInWindow: false },
    ]);

    await act(async () => {
      additionalChange.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
      await Promise.resolve();
    });
    await act(async () => {
      workspaceChange.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, metaKey: true }));
      await Promise.resolve();
    });
    assert.deepEqual(diffRequests.slice(2).map(({ rootId, relativePath, scope, openInWindow }) => ({
      rootId,
      relativePath,
      scope,
      openInWindow,
    })), [
      {
        rootId: "additional:repo",
        relativePath: "app/src/00-shared.ts",
        scope: "working-tree",
        openInWindow: true,
      },
      {
        rootId: "workspace",
        relativePath: "src/00-shared.ts",
        scope: "working-tree",
        openInWindow: true,
      },
    ]);

    const untrackedChange = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".workspace-change-row")]
      .find((button) => button.title === "notes.txt");
    assert.ok(untrackedChange);
    await act(async () => {
      untrackedChange.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      untrackedChange.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
      untrackedChange.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, metaKey: true }));
      await Promise.resolve();
    });
    assert.deepEqual(fileRequests, [
      { sessionId: "session-1", rootId: "additional:repo", relativePath: "notes.txt", openInWindow: false },
      { sessionId: "session-1", rootId: "additional:repo", relativePath: "notes.txt", openInWindow: true },
      { sessionId: "session-1", rootId: "additional:repo", relativePath: "notes.txt", openInWindow: true },
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
        refreshRevision: 2,
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

    workspaceEntries = entries.slice(0, 1);
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
      listFileRootChangesRepositories: async (request: { rootIds: string[] }) => ({
        status: "ok" as const,
        repositories: request.rootIds.map((rootId) => ({ rootId })),
        failures: [],
      }),
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
      roots: [
        { id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:/repo/app" },
      ],
      refreshRevision: 0,
      onOpenFile: () => undefined,
      onOpenDiff: async () => null,
    };
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...staleReloadProps,
        rootsRevision: "stale-1",
        refreshRevision: 1,
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.ok(rejectStaleRequest);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...staleReloadProps,
        rootsRevision: "stale-1",
        refreshRevision: 2,
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

// @test-value v1
// kind = "invariant"
// claim = "Refreshはrepositoryごとに並行開始し、完了済みgroupを即時反映しながら古いrequest結果を無視する"
// oracle = { type = "contract", ref = "accepted behavior: per-repository concurrent refresh" }
// failure_mode = "遅いrepositoryが他groupの表示を止める、または再RefreshやSession切替後の古い結果が現行stateを上書きする"
// scope = "FileRootChangesPane repository request generation"
// lifecycle = "permanent"
// distinction = "明示Refreshの開始条件ではなく、複数repositoryの完了順とrequest世代を検証する"
// @end-test-value
test("FileRootChangesPane はrepositoryごとに完了を反映してstale requestを無視する", async () => {
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
  const { FileRootChangesPane } = await import("../../src/file-explorer/FileRootChangesPane.js");

  const pendingRequests: Array<{
    request: { sessionId: string; rootId: string };
    resolve: (result: FileRootChangesResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const testApi = {
    listFileRootChangesRepositories: async (request: { rootIds: string[] }) => ({
      status: "ok" as const,
      repositories: request.rootIds.map((rootId) => ({ rootId })),
      failures: [],
    }),
    listFileRootChanges: async (request: { sessionId: string; rootId: string }) => (
      new Promise<FileRootChangesResult>((resolve, reject) => pendingRequests.push({ request, resolve, reject }))
    ),
  };
  const roots: SessionFileRoot[] = [
    { id: "slow", kind: "workspace", label: "Slow", displayPath: "C:/slow" },
    { id: "fast", kind: "additional", label: "Fast", displayPath: "C:/fast" },
  ];
  const baseProps = {
    api: testApi,
    sessionId: "session-1",
    enabled: true,
    roots,
    rootsRevision: "roots-1",
    refreshRevision: 0,
    onOpenFile: () => undefined,
    onOpenDiff: async () => null,
  };
  const entries = (count: number): FileRootGitChangeEntry[] => Array.from({ length: count }, (_, index) => ({
    relativePath: `file-${index}.txt`,
    previousRelativePath: null,
    scopes: ["working-tree"],
    kinds: { "working-tree": "modified" },
  }));
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootChangesPane, baseProps));
      await Promise.resolve();
    });
    assert.equal(pendingRequests.length, 0);
    assert.equal(dom.window.document.querySelectorAll(".workspace-changes-root-group").length, 2);

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 1 }));
      await Promise.resolve();
    });
    assert.deepEqual(pendingRequests.map(({ request }) => request), [
      { sessionId: "session-1", rootId: "slow" },
      { sessionId: "session-1", rootId: "fast" },
    ]);
    assert.equal(dom.window.document.querySelector(".workspace-changes-loading"), null);
    assert.equal(dom.window.document.querySelector("[data-root-id='slow']")?.getAttribute("aria-busy"), "true");
    assert.equal(dom.window.document.querySelector("[data-root-id='fast']")?.getAttribute("aria-busy"), "true");

    await act(async () => {
      pendingRequests[1]?.resolve({ status: "ok", entries: entries(2) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(dom.window.document.querySelector("[data-root-id='slow']")?.getAttribute("aria-busy"), "true");
    assert.equal(dom.window.document.querySelector("[data-root-id='fast']")?.getAttribute("aria-busy"), "false");
    assert.equal(
      dom.window.document.querySelector("[data-root-id='fast'] .workspace-changes-root-count")?.textContent,
      "2",
    );

    await act(async () => {
      pendingRequests[0]?.resolve({ status: "ok", entries: entries(1) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(dom.window.document.querySelector("[data-root-id='slow']")?.getAttribute("aria-busy"), "false");

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 2 }));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 3 }));
      await Promise.resolve();
    });
    assert.equal(pendingRequests.length, 4);

    await act(async () => {
      pendingRequests[2]?.resolve({ status: "ok", entries: entries(7) });
      pendingRequests[3]?.resolve({ status: "ok", entries: entries(8) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(pendingRequests.length, 6);
    assert.equal(dom.window.document.querySelectorAll("[data-root-id='slow'] .workspace-change-row").length, 1);
    assert.equal(dom.window.document.querySelectorAll("[data-root-id='fast'] .workspace-change-row").length, 2);

    await act(async () => {
      pendingRequests[4]?.resolve({ status: "ok", entries: [] });
      pendingRequests[5]?.reject(new Error("Fast repository failed."));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(dom.window.document.querySelector("[data-root-id='slow']")?.textContent ?? "", /No changes/);
    assert.match(dom.window.document.querySelector("[data-root-id='fast']")?.textContent ?? "", /Fast repository failed/);
    assert.equal(dom.window.document.querySelector("[data-root-id='fast']")?.getAttribute("aria-busy"), "false");

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        refreshRevision: 4,
      }));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-2",
        roots: [{ id: "next", kind: "workspace", label: "Next", displayPath: "C:/next" }],
        rootsRevision: "roots-2",
        refreshRevision: 4,
      }));
      await Promise.resolve();
      pendingRequests[6]?.resolve({ status: "ok", entries: entries(9) });
      pendingRequests[7]?.resolve({ status: "ok", entries: entries(9) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(dom.window.document.querySelector("[data-root-id='slow']"), null);
    assert.equal(dom.window.document.querySelector("[data-root-id='fast']"), null);
    assert.ok(dom.window.document.querySelector("[data-root-id='next']"));
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

// @test-value v1
// kind = "invariant"
// claim = "20 repositoryのRefreshと連続Refreshでもpane内のChanges要求は同時2件に制限され、最新世代だけを継続する"
// oracle = { type = "contract", ref = "accepted behavior: bounded per-repository concurrent refresh" }
// failure_mode = "一括Refreshまたは連続RefreshがMainのGit操作queueへ無制限に要求を積み、自己飽和させる"
// scope = "FileRootChangesPane bounded request scheduling"
// lifecycle = "permanent"
// distinction = "repository別の表示順ではなく、18件超と連続Refresh時のadmission上限を検証する"
// @end-test-value
test("FileRootChangesPane は大量repositoryと連続Refreshをbounded schedulingする", async () => {
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
  const { FileRootChangesPane } = await import("../../src/file-explorer/FileRootChangesPane.js");

  const pendingRequests: Array<{
    request: { sessionId: string; rootId: string };
    settled: boolean;
    resolve: (result: FileRootChangesResult) => void;
  }> = [];
  const roots: SessionFileRoot[] = Array.from({ length: 20 }, (_, index) => ({
    id: `repo-${index}`,
    kind: index === 0 ? "workspace" as const : "additional" as const,
    label: `Repo ${index}`,
    displayPath: `C:/repo-${index}`,
  }));
  const testApi = {
    listFileRootChangesRepositories: async () => ({
      status: "ok" as const,
      repositories: roots.map((root) => ({ rootId: root.id })),
      failures: [],
    }),
    listFileRootChanges: async (request: { sessionId: string; rootId: string }) => (
      new Promise<FileRootChangesResult>((resolve) => {
        const pending = {
          request,
          settled: false,
          resolve(result: FileRootChangesResult) {
            pending.settled = true;
            resolve(result);
          },
        };
        pendingRequests.push(pending);
      })
    ),
  };
  const baseProps = {
    api: testApi,
    sessionId: "session-1",
    enabled: true,
    roots,
    rootsRevision: "roots-1",
    refreshRevision: 0,
    onOpenFile: () => undefined,
    onOpenDiff: async () => null,
  };
  let root: Root | null = null;
  try {
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootChangesPane, baseProps));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 1 }));
      await Promise.resolve();
    });
    assert.equal(pendingRequests.length, 2);

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 2 }));
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 3 }));
      await Promise.resolve();
    });
    assert.equal(pendingRequests.length, 2);

    await act(async () => {
      pendingRequests[0]?.resolve({ status: "ok", entries: [] });
      pendingRequests[1]?.resolve({ status: "ok", entries: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(pendingRequests.slice(2).map(({ request }) => request.rootId), ["repo-0", "repo-1"]);
    assert.equal(pendingRequests.filter(({ settled }) => !settled).length, 2);

    for (let index = 2; index < 22; index += 1) {
      await act(async () => {
        pendingRequests[index]?.resolve({ status: "ok", entries: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.ok(pendingRequests.filter(({ settled }) => !settled).length <= 2);
    }
    assert.equal(pendingRequests.length, 22);
    assert.deepEqual(pendingRequests.slice(2).map(({ request }) => request.rootId), roots.map((root) => root.id));
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

// @test-value v1
// kind = "contract"
// claim = "reduced motion用media ruleはChangesのrepository局所spinnerのanimationをnoneにする"
// oracle = { type = "contract", ref = "accepted behavior: repository-local pending status" }
// failure_mode = "repositoryのpending spinnerがreduced motion設定でも動き続ける"
// scope = "Changes reduced-motion stylesheet contract"
// lifecycle = "permanent"
// @end-test-value
test("Changes pending indicator はreduced motionに配慮する", async () => {
  const styles = await readFile(new URL("../../src/styles.css", import.meta.url), "utf8");
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  const style = dom.window.document.createElement("style");
  style.textContent = styles.replace(/^@import .*;$/gm, "");
  dom.window.document.head.append(style);
  const reducedMotionRules = Array.from(style.sheet?.cssRules ?? []).filter((rule) => (
    "media" in rule
      && (rule as CSSMediaRule).media.mediaText.replaceAll(" ", "") === "(prefers-reduced-motion:reduce)"
  )) as CSSMediaRule[];
  assert.ok(reducedMotionRules.length > 0);
  const spinnerRule = reducedMotionRules.flatMap((rule) => Array.from(rule.cssRules)).find((rule) => (
    "selectorText" in rule
      && (rule as CSSStyleRule).selectorText.split(",").map((selector) => selector.trim())
        .includes(".workspace-changes-root-spinner")
  )) as CSSStyleRule | undefined;
  assert.ok(spinnerRule);
  assert.equal(spinnerRule.style.getPropertyValue("animation"), "none");
  dom.window.close();
});
