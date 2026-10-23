import { readStylesheet } from "../support/read-stylesheet.js";
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
} from "../../src-shared/file-explorer/file-explorer-contract.js";

// @test-value v2
// kind = "contract"
// claim = "Changes paneは表示開始・再表示・非同期root集合変化で認可済みrootを再探索し、同内容の配列再生成や非表示中は取得を開始しない"
// oracle = { type = "contract", ref = "Issue #875: visible Changes activation refresh" }
// fault = "非表示中にGit I/Oが走る、非同期root到着後にstatusを取得しない、同内容の配列で再取得する、または再表示でGit root作成・削除を認識できない"
// observable = "discoveryとChanges取得の呼び出し列および初期表示"
// observation_boundary = "component-behavior"
// scope = "FileRootChangesPane refresh boundary"
// lifecycle = "permanent"
// distinction = "取得後のrepository別完了順ではなく、取得を開始できる操作を検証する"
// @end-test-value
test("FileRootChangesPane は表示時に自動取得し非表示中は待機する", async () => {
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
  let repositoryPresent = true;
  const testApi = {
    listFileRootChangesRepositories: async (request: { sessionId: string; rootIds: string[] }) => {
      repositoryRequests.push(request);
      return {
        status: "ok" as const,
        repositories: repositoryPresent ? request.rootIds.map((rootId) => ({ rootId })) : [],
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
      root.render(React.createElement(FileRootChangesPane, { ...baseProps, visible: false }));
      await Promise.resolve();
    });
    assert.equal(repositoryRequests.length, 0);
    assert.equal(changesRequests.length, 0);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, visible: false, refreshRevision: 1 }));
      await Promise.resolve();
    });
    assert.equal(repositoryRequests.length, 0);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, baseProps));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(repositoryRequests, [{ sessionId: "session-1", rootIds: ["workspace"] }]);
    assert.deepEqual(changesRequests, [{ sessionId: "session-1", rootId: "workspace" }]);
    await completeRequest(0);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, roots: [...roots] }));
      await Promise.resolve();
    });
    assert.equal(repositoryRequests.length, 1);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, visible: false }));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, baseProps));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(repositoryRequests.length, 2);
    assert.equal(changesRequests.length, 2);
    await completeRequest(1);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-2" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(changesRequests.at(-1), { sessionId: "session-2", rootId: "workspace" });
    await completeRequest(2);
    repositoryPresent = false;
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-2", visible: false }));
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-2" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(changesRequests.length, 3);
    assert.equal(dom.window.document.querySelector("[data-root-id='workspace']"), null);
    repositoryPresent = true;
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-2", visible: false }));
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-2" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(changesRequests.length, 4);
    assert.ok(dom.window.document.querySelector("[data-root-id='workspace']"));
    await completeRequest(3);
    const discoveryCount = repositoryRequests.length;
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-3", roots: [] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(repositoryRequests.length, discoveryCount);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-3" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(repositoryRequests.length, discoveryCount + 1);
    assert.deepEqual(changesRequests.at(-1), { sessionId: "session-3", rootId: "workspace" });
    await completeRequest(4);
    const additionalRoot: SessionFileRoot = {
      id: "additional:repo", kind: "additional", label: "Repo", displayPath: "C:/other",
    };
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps, sessionId: "session-3", roots: [additionalRoot],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(repositoryRequests.length, discoveryCount + 2);
    assert.deepEqual(changesRequests.at(-1), { sessionId: "session-3", rootId: "additional:repo" });
    assert.equal(dom.window.document.querySelector("[data-root-id='workspace']"), null);
    await completeRequest(5);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
        ...baseProps, sessionId: "session-3", roots: [{ ...additionalRoot, displayPath: "C:/moved" }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(repositoryRequests.length, discoveryCount + 3);
    await completeRequest(6);
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

// @test-value v2
// kind = "regression"
// claim = "Changes paneはGit repository discovery中を視覚spinnerとscreen reader向けstatusで示す"
// oracle = { type = "contract", ref = "user feedback: Changes tab loading indicator" }
// fault = "Changes tabへの切替時にrepository discoveryのloadingがvisible textだけで表示される"
// observable = "repository discovery中に描画されるspinnerとscreen reader向けstatus"
// observation_boundary = "consumer"
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
  style.textContent = (await readStylesheet())
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
    const spinner = status.querySelector<HTMLElement>(".loading-indicator-spinner[aria-hidden='true']");
    assert.ok(spinner);
    const spinnerStyle = dom.window.getComputedStyle(spinner);
    assert.equal(spinnerStyle.width, "16px");
    assert.equal(spinnerStyle.height, "16px");
    assert.equal(spinnerStyle.borderTopStyle, "solid");
    assert.equal(status.getAttribute("aria-label"), "Discovering Git repositories");
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

// @test-value v2
// kind = "regression"
// claim = "repository discovery失敗後の明示Refreshはdiscoveryを再試行し、成功した現行世代のChanges取得を開始して正常空をblankで保つ"
// oracle = { type = "contract", ref = "accepted behavior: explicit Refresh recovers transient repository discovery failures" }
// fault = "一時的なdiscovery失敗後にRefreshしても空のrepository集合だけを処理し、Changesを再取得できない"
// observable = "failedからRefresh後のdiscovery success、repository-local Changes取得、および正常空のblank表示"
// observation_boundary = "component-behavior"
// scope = "FileRootChangesPane discovery retry transition"
// lifecycle = "permanent"
// distinction = "初回discoveryのloading表示ではなく、failedから利用者操作でsuccessへ復旧し正常空に余計な説明を出さない遷移を検証する"
// @end-test-value
test("FileRootChangesPane はRefreshでrepository discovery失敗から復旧する", async () => {
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

  let discoveryCalls = 0;
  const changesRequests: Array<{ sessionId: string; rootId: string }> = [];
  const testApi = {
    listFileRootChangesRepositories: async () => {
      discoveryCalls += 1;
      return discoveryCalls === 1
        ? { status: "failed" as const, message: "Repository discovery timed out." }
        : {
            status: "ok" as const,
            repositories: [{ rootId: "workspace" }],
            failures: [],
          };
    },
    listFileRootChanges: async (request: { sessionId: string; rootId: string }) => {
      changesRequests.push(request);
      return { status: "ok" as const, entries: [] };
    },
  };
  const baseProps = {
    api: testApi,
    sessionId: "session-1",
    enabled: true,
    roots: [{ id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:/repo" }],
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(discoveryCalls, 1);
    assert.match(dom.window.document.body.textContent ?? "", /Repository discovery timed out/);
    assert.deepEqual(changesRequests, []);

    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(discoveryCalls, 2);
    assert.deepEqual(changesRequests, [{ sessionId: "session-1", rootId: "workspace" }]);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Repository discovery timed out/);
    assert.equal(dom.window.document.querySelector("[data-root-id='workspace']"), null);
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

// @test-value v2
// kind = "regression"
// claim = "repository別groupはnon-Git結果を除外して失敗を局所表示し、変更導線・仮想化とentries差替え時の閲覧anchorを維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Files / Changes; docs/adr/015-file-root-scoped-git-changes.md: root別取得失敗と独立scope" }
// fault = "non-Git除外、repository別failure、directory collapse、diff/file previewや大量表示が壊れるか、先頭の変更追加・削除で閲覧rowが画面内を移動する"
// observable = "repository group数、failure alert表示、directory操作、diff/file request、virtual row数、および先頭変更追加・削除前後の閲覧rowのviewport内offsetとfocus"
// observation_boundary = "component-behavior"
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
    kinds: { "working-tree": "modified" },
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
      const mountedRoot = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root = mountedRoot;
      mountedRoot.render(React.createElement(FileRootChangesPane, {
        ...baseProps,
        sessionId: "session-1",
      }));
      await Promise.resolve();
    });
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, {
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
    assert.equal(groups.find((group) => group.dataset.rootId === "additional:repo")?.style.maxHeight, "199px");
    assert.equal(groups.find((group) => group.dataset.rootId === "workspace")?.style.maxHeight, "408px");
    assert.deepEqual(requestedRootIds, ["additional:broken", "additional:repo", "workspace", "additional:broken", "additional:repo", "workspace"]);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Session Folder/);
    assert.match(dom.window.document.body.textContent ?? "", /Git status failed for broken root/);
    assert.equal(
      groups.find((group) => group.dataset.rootId === "additional:broken")?.querySelector('[role="alert"]')?.textContent,
      "Git status failed for broken root.",
    );
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
    repoList.focus();
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
    assert.equal(dom.window.document.activeElement, repoList);

    Object.defineProperty(workspaceList, "scrollHeight", {
      configurable: true,
      get: () => Number.parseFloat(workspaceList.querySelector<HTMLElement>(".workspace-changes-list-inner")?.style.height ?? "0"),
    });
    const rowOffset = (row: HTMLElement) => (
      Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1]) - workspaceList.scrollTop
    );
    await act(async () => {
      workspaceList.scrollTop = 540;
      workspaceList.dispatchEvent(new dom.window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const anchorRow = [...workspaceList.querySelectorAll<HTMLElement>(".workspace-change-virtual-row")]
      .find((row) => row.querySelector(".workspace-change-row") && rowOffset(row) + 30 > 0);
    assert.ok(anchorRow);
    const anchorButton = anchorRow.querySelector<HTMLButtonElement>(".workspace-change-row");
    assert.ok(anchorButton);
    anchorButton.focus();
    assert.equal(dom.window.document.activeElement, anchorButton);
    const anchorOffset = rowOffset(anchorRow);
    workspaceEntries = [{ ...entries[0]!, relativePath: "src/000-new.ts" }, ...entries];
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-1", refreshRevision: 21 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(dom.window.document.activeElement, anchorButton);
    assert.equal(rowOffset(anchorButton.closest<HTMLElement>(".workspace-change-virtual-row")!), anchorOffset);
    workspaceEntries = entries;
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, sessionId: "session-1", refreshRevision: 22 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(rowOffset(anchorButton.closest<HTMLElement>(".workspace-change-virtual-row")!), anchorOffset);

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
        rootsRevision: "stale-2",
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

// @test-value v2
// kind = "invariant"
// claim = "Refreshはrepositoryごとに完了を反映し、連続Refresh中も現行結果を表示し、Session切替後の結果だけを無視する"
// oracle = { type = "contract", ref = "accepted behavior: per-repository concurrent refresh" }
// fault = "遅いrepositoryや連続Refreshが完了済み結果の表示を止めるか、Session切替後の結果が現行stateを上書きする"
// observable = "repository groupの完了順表示、連続更新・失敗後の既存listとfocus、およびSession切替後のstale結果の無視"
// observation_boundary = "component-behavior"
// scope = "FileRootChangesPane repository request generation"
// lifecycle = "permanent"
// distinction = "表示開始条件ではなく、複数repositoryの完了順と読み取り状態・owner境界を検証する"
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
  for (const property of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, property, {
      configurable: true,
      get() { return this.classList.contains("workspace-changes-list") ? 360 : 30; },
    });
  }
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
    assert.equal(pendingRequests.length, 2);
    assert.equal(dom.window.document.querySelectorAll(".workspace-changes-root-group").length, 2);

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
    const fastList = dom.window.document.querySelector<HTMLElement>("[data-root-id='fast'] .workspace-changes-list");
    assert.ok(fastList);
    fastList.focus();

    await act(async () => {
      pendingRequests[2]?.resolve({ status: "ok", entries: entries(7) });
      pendingRequests[3]?.resolve({ status: "ok", entries: entries(8) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(pendingRequests.length, 6);
    assert.equal(dom.window.document.querySelector("[data-root-id='fast'] .workspace-changes-list"), fastList);
    assert.equal(dom.window.document.activeElement, fastList);
    assert.equal(dom.window.document.querySelectorAll("[data-root-id='slow'] .workspace-change-row").length, 7);
    assert.equal(dom.window.document.querySelectorAll("[data-root-id='fast'] .workspace-change-row").length, 8);

    await act(async () => {
      pendingRequests[4]?.resolve({ status: "ok", entries: [] });
      pendingRequests[5]?.reject(new Error("Fast repository failed."));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(dom.window.document.querySelector("[data-root-id='slow']"), null);
    assert.match(dom.window.document.querySelector("[data-root-id='fast']")?.textContent ?? "", /Fast repository failed/);
    assert.equal(dom.window.document.querySelector("[data-root-id='fast']")?.getAttribute("aria-busy"), "false");
    assert.equal(dom.window.document.querySelectorAll("[data-root-id='fast'] .workspace-change-row").length, 8);
    assert.equal(dom.window.document.querySelector("[data-root-id='fast'] .workspace-changes-list"), fastList);
    assert.equal(dom.window.document.activeElement, fastList);

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

// @test-value v2
// kind = "invariant"
// claim = "20 repositoryの連続Refreshを一つの後続取得へまとめ、非表示中は未開始要求を保留し、表示中は同時2件を維持する"
// oracle = { type = "contract", ref = "accepted behavior: bounded per-repository concurrent refresh" }
// fault = "連続Refreshが進行中の結果を捨て続けるか、Git操作を同時2件を超えて投入する"
// observable = "status呼び出しのroot順と未完了件数、最終呼び出し件数"
// observation_boundary = "component-behavior"
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
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, visible: false, refreshRevision: 3 }));
      await Promise.resolve();
    });
    await act(async () => {
      pendingRequests[0]?.resolve({ status: "ok", entries: [] });
      pendingRequests[1]?.resolve({ status: "ok", entries: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(pendingRequests.length, 2);
    await act(async () => {
      root?.render(React.createElement(FileRootChangesPane, { ...baseProps, refreshRevision: 3 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(pendingRequests.slice(2).map(({ request }) => request.rootId), ["repo-2", "repo-3"]);
    assert.equal(pendingRequests.filter(({ settled }) => !settled).length, 2);

    for (let index = 2; index < 40; index += 1) {
      await act(async () => {
        pendingRequests[index]?.resolve({ status: "ok", entries: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.ok(pendingRequests.filter(({ settled }) => !settled).length <= 2);
    }
    assert.equal(pendingRequests.length, 40);
    assert.deepEqual(pendingRequests.map(({ request }) => request.rootId), [...roots, ...roots].map((root) => root.id));
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

// @test-value v2
// kind = "contract"
// claim = "reduced motion用media ruleはChangesの共通loading spinnerのanimationをnoneにする"
// oracle = { type = "contract", ref = "src/styles/common.css: LoadingIndicator" }
// fault = "Changesの共通pending spinnerがreduced motion設定でも動き続ける"
// observable = "prefers-reduced-motion media rule内のloading-indicator-spinner animation"
// observation_boundary = "consumer"
// scope = "Changes reduced-motion stylesheet contract"
// lifecycle = "permanent"
// distinction = "Changes固有CSSではなく、全ReadStatusが共有する共通spinner規則を検証する"
// @end-test-value
test("Changes pending indicator はreduced motionに配慮する", async () => {
  const styles = await readStylesheet();
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
        .includes(".loading-indicator-spinner")
  )) as CSSStyleRule | undefined;
  assert.ok(spinnerRule);
  assert.equal(spinnerRule.style.getPropertyValue("animation"), "none");
  dom.window.close();
});
