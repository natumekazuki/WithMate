import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  FileRootGitChangeEntry,
  FileRootGitHistoryCommit,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryRepository,
} from "../../src/file-explorer/file-explorer-contract.js";

type ObserverEntry = { isIntersecting: boolean };

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly root: Element | null;
  readonly callback: (entries: ObserverEntry[]) => void;

  constructor(callback: (entries: ObserverEntry[]) => void, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    TestIntersectionObserver.instances.push(this);
  }

  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }]);
  }
}

class TestResizeObserver {
  readonly callback: (entries: Array<{ contentRect: DOMRect; target: Element }>) => void;

  constructor(callback: (entries: Array<{ contentRect: DOMRect; target: Element }>) => void) {
    this.callback = callback;
  }

  observe(element: Element): void {
    this.callback([{ contentRect: element.getBoundingClientRect(), target: element }]);
  }

  disconnect(): void {}
  unobserve(): void {}
}

const repositoryA: FileRootGitHistoryRepository = {
  repositoryId: "git:aaaaaaaaaaaaaaaaaaaaaaaa",
  rootId: "workspace",
  label: "withmate",
  displayPath: "C:/withmate",
};
const repositoryB: FileRootGitHistoryRepository = {
  repositoryId: "git:bbbbbbbbbbbbbbbbbbbbbbbb",
  rootId: "additional:repo",
  label: "other",
  displayPath: "C:/other",
};

function commit(id: string, subject: string): FileRootGitHistoryCommit {
  return {
    id: id.repeat(40 / id.length).slice(0, 40),
    shortHash: id.slice(0, 7),
    subject,
    authorName: "Author",
    authorEmail: "author@example.invalid",
    authoredAt: "2026-08-22T00:00:00.000Z",
    refs: [],
    parentIds: [],
  };
}

function changedEntry(relativePath: string): FileRootGitChangeEntry {
  return {
    relativePath,
    previousRelativePath: null,
    kinds: { commit: "modified" },
    scopes: ["commit"],
  };
}

function installDom(): {
  dom: JSDOM;
  restore(): void;
} {
  const previous = {
    actEnvironment: (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    navigator: globalThis.navigator,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IntersectionObserver: globalThis.IntersectionObserver,
    ResizeObserver: globalThis.ResizeObserver,
  };
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = this.classList.contains("workspace-changes-list") || this.classList.contains("file-history-commit-list")
      ? 360
      : 30;
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
      return this.classList.contains("workspace-changes-list") || this.classList.contains("file-history-commit-list")
        ? 360
        : 30;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", {
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
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: TestIntersectionObserver,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  TestIntersectionObserver.instances = [];
  return {
    dom,
    restore() {
      (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
      Object.defineProperty(globalThis, "window", { configurable: true, value: previous.window });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previous.document });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: previous.HTMLElement });
      Object.defineProperty(globalThis, "Element", { configurable: true, value: previous.Element });
      Object.defineProperty(globalThis, "Node", { configurable: true, value: previous.Node });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: previous.navigator });
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: previous.requestAnimationFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: previous.cancelAnimationFrame,
      });
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        value: previous.IntersectionObserver,
      });
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: previous.ResizeObserver,
      });
      dom.window.close();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("History pagination は Load more buttonを出さず sentinel と専用scroll rootで次pageを一度だけ取得する", async () => {
  const { dom, restore } = installDom();
  const pageRequests: Array<{ sessionId: string; repositoryId: string; rootId: string; cursor: string | null }> = [];
  const pendingPages: Array<(result: unknown) => void> = [];
  const first = commit("a", "first commit");
  const second = commit("b", "second commit");
  const third = commit("c", "third commit");
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: (request: { sessionId: string; repositoryId: string; rootId: string; cursor: string | null }) => {
      pageRequests.push(request);
      return new Promise((resolve) => pendingPages.push(resolve));
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "ok" as const, commit: first, entries: [] }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: first.id, relativePath: null, patch: "" }),
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    assert.deepEqual(pageRequests, [{ sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, cursor: null }]);
    await act(async () => {
      pendingPages.shift()?.({
        status: "ok",
        page: { entries: [first, second], nextCursor: "100", hasMore: true },
      });
      await Promise.resolve();
    });
    assert.equal(dom.window.document.querySelector("button")?.textContent?.includes("Load more"), false);
    assert.ok(dom.window.document.querySelector(".file-history-list-sentinel"));
    const observer = TestIntersectionObserver.instances.at(-1);
    assert.ok(observer);
    assert.equal(observer?.root, dom.window.document.querySelector(".file-history-commit-list"));
    await act(async () => observer?.trigger(false));
    await flush();
    assert.equal(pageRequests.length, 1);
    await act(async () => {
      observer?.trigger(true);
      observer?.trigger(true);
    });
    await flush();
    assert.deepEqual(pageRequests, [
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, cursor: null },
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, cursor: "100" },
    ]);
    pendingPages.at(-1)?.({
      status: "ok",
      page: { entries: [second, third], nextCursor: null, hasMore: false },
    });
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /third commit/);
    assert.equal(dom.window.document.querySelector(".file-history-list-sentinel"), null);
    await act(async () => observer?.trigger(true));
    await flush();
    assert.equal(pageRequests.length, 2);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

test("History 追加pageの失敗は既存一覧を維持し、sentinelから再試行できる", async () => {
  const { dom, restore } = installDom();
  const first = commit("a", "first commit");
  const second = commit("b", "retried commit");
  const pageRequests: string[] = [];
  let appendAttempts = 0;
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async (request: { cursor: string | null }) => {
      pageRequests.push(request.cursor ?? "first");
      if (request.cursor === "100") {
        appendAttempts += 1;
        return appendAttempts === 1
          ? { status: "failed" as const, message: "next page failed" }
          : { status: "ok" as const, page: { entries: [second], nextCursor: null, hasMore: false } };
      }
      return { status: "ok" as const, page: { entries: [first], nextCursor: "100", hasMore: true } };
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "ok" as const, commit: first, entries: [] }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: first.id, relativePath: null, patch: "" }),
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const observer = TestIntersectionObserver.instances.at(-1);
    assert.ok(observer);
    await act(async () => observer?.trigger(true));
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /first commit/);
    assert.match(dom.window.document.body.textContent ?? "", /next page failed/);
    assert.ok(dom.window.document.querySelector(".file-history-list-sentinel"));
    await act(async () => observer?.trigger(true));
    await flush();
    assert.deepEqual(pageRequests, ["first", "100", "100"]);
    assert.match(dom.window.document.body.textContent ?? "", /retried commit/);
    assert.equal(dom.window.document.querySelector(".file-history-list-sentinel"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

test("History はrepository 0件とcommit 0件を別のempty stateで表示する", async () => {
  const { dom, restore } = installDom();
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    const noRepositoryApi = {
      listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [] }),
      listFileRootGitHistoryCommits: async () => ({
        status: "ok" as const,
        page: { entries: [], nextCursor: null, hasMore: false },
      }),
      getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "none" }),
      getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "none" }),
    };
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api: noRepositoryApi,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /No Git repositories/);
    assert.equal(dom.window.document.querySelector(".file-history-list-sentinel"), null);
    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
        api: {
          ...noRepositoryApi,
          listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
          listFileRootGitHistoryCommits: async () => ({
            status: "ok" as const,
            page: { entries: [], nextCursor: null, hasMore: false },
          }),
        },
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-2",
        refreshRevision: 0,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /No commits/);
    assert.equal(dom.window.document.querySelector(".file-history-list-sentinel"), null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

test("History repository切り替えは古いpageを捨てて新repositoryの先頭から開始する", async () => {
  const { dom, restore } = installDom();
  const pageRequests: Array<{ sessionId: string; repositoryId: string; rootId: string; cursor: string | null }> = [];
  const pendingPages: Array<(result: unknown) => void> = [];
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA, repositoryB] }),
    listFileRootGitHistoryCommits: (request: { sessionId: string; repositoryId: string; rootId: string; cursor: string | null }) => {
      pageRequests.push(request);
      return new Promise((resolve) => pendingPages.push(resolve));
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "ok" as const, commit: commit("d", "detail"), entries: [] }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: commit("d", "detail").id, relativePath: null, patch: "" }),
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const select = dom.window.document.querySelector("select") as HTMLSelectElement;
    assert.ok(select);
    assert.equal(pageRequests.length, 1);
    await act(async () => {
      select.value = repositoryB.repositoryId;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    assert.deepEqual(pageRequests, [
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, cursor: null },
      { sessionId: "session-1", repositoryId: repositoryB.repositoryId, rootId: repositoryB.rootId, cursor: null },
    ]);
    pendingPages[0]?.({
      status: "ok",
      page: { entries: [commit("e", "stale old repository")], nextCursor: null, hasMore: false },
    });
    await flush();
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /stale old repository/);
    pendingPages[1]?.({
      status: "ok",
      page: { entries: [commit("f", "new repository")], nextCursor: null, hasMore: false },
    });
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /new repository/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

test("History detail はcommit metadata、changed file tree、file diffとOpen Changesを同じ状態で開く", async () => {
  const { dom, restore } = installDom();
  const targetCommit = commit("1", "history detail");
  const detailEntry = changedEntry("src/example.ts");
  const diffRequests: FileRootGitHistoryDiffRequest[] = [];
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async () => ({
      status: "ok" as const,
      page: { entries: [targetCommit], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: async () => ({
      status: "ok" as const,
      commit: targetCommit,
      entries: [detailEntry],
    }),
    getFileRootGitHistoryDiff: async (request: FileRootGitHistoryDiffRequest) => {
      diffRequests.push(request);
      return { status: "ok" as const, commitId: request.commitId, relativePath: request.relativePath ?? null, patch: "diff --git" };
    },
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async (request: FileRootGitHistoryDiffRequest) => {
          diffRequests.push(request);
          return null;
        },
      }));
      await Promise.resolve();
    });
    await flush();
    const commitButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")][0];
    assert.ok(commitButton);
    await act(async () => commitButton.click());
    await flush();
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /history detail/);
    const fileButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".workspace-change-row[title='src/example.ts']",
    );
    assert.ok(fileButton);
    await act(async () => fileButton.click());
    await flush();
    assert.equal(diffRequests.at(-1)?.relativePath, "src/example.ts");
    const openChanges = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open Changes");
    assert.ok(openChanges);
    await act(async () => openChanges.click());
    await flush();
    assert.equal(diffRequests.at(-1)?.relativePath, null);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

test("History は古いcommit detail結果を現在のcommitへ混入させない", async () => {
  const { dom, restore } = installDom();
  const firstCommit = commit("a", "first detail");
  const secondCommit = commit("b", "second detail");
  const pendingDetails: Array<(result: unknown) => void> = [];
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async () => ({
      status: "ok" as const,
      page: { entries: [firstCommit, secondCommit], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: (request: { commitId: string }) => new Promise((resolve) => {
      pendingDetails.push((result) => resolve(result));
      assert.ok(request.commitId === firstCommit.id || request.commitId === secondCommit.id);
    }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: firstCommit.id, relativePath: null, patch: "" }),
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const rows = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")];
    assert.equal(rows.length, 2);
    await act(async () => rows[0]?.click());
    await flush();
    assert.equal(pendingDetails.length, 1);
    const backButton = dom.window.document.querySelector<HTMLButtonElement>(".file-history-back");
    assert.ok(backButton);
    await act(async () => backButton.click());
    await flush();
    const secondRow = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")]
      .find((button) => button.textContent?.includes("second detail"));
    assert.ok(secondRow);
    await act(async () => secondRow.click());
    await flush();
    assert.equal(pendingDetails.length, 2);
    pendingDetails[0]?.({
      status: "ok",
      commit: firstCommit,
      entries: [changedEntry("old.ts")],
    });
    await flush();
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /old\.ts/);
    pendingDetails[1]?.({
      status: "ok",
      commit: secondCommit,
      entries: [changedEntry("new.ts")],
    });
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /new\.ts/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

test("History は古いfile Diff結果をBack後のcommitへ混入させない", async () => {
  const { dom, restore } = installDom();
  const firstCommit = commit("a", "first diff");
  const secondCommit = commit("b", "second diff");
  let resolveDiff: ((message: string | null) => void) | null = null;
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async () => ({
      status: "ok" as const,
      page: { entries: [firstCommit, secondCommit], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: async (request: { commitId: string }) => ({
      status: "ok" as const,
      commit: request.commitId === firstCommit.id ? firstCommit : secondCommit,
      entries: [changedEntry(request.commitId === firstCommit.id ? "first.ts" : "second.ts")],
    }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: firstCommit.id, relativePath: null, patch: "" }),
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    await act(async () => {
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 0,
        onOpenDiff: async () => new Promise<string | null>((resolve) => {
          resolveDiff = resolve;
        }),
      }));
      await Promise.resolve();
    });
    await flush();
    const firstRow = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")]
      .find((button) => button.textContent?.includes("first diff"));
    assert.ok(firstRow);
    await act(async () => firstRow.click());
    await flush();
    const firstFile = dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row[title='first.ts']");
    assert.ok(firstFile);
    await act(async () => firstFile.click());
    await flush();
    assert.ok(resolveDiff);
    const backButton = dom.window.document.querySelector<HTMLButtonElement>(".file-history-back");
    assert.ok(backButton);
    await act(async () => backButton.click());
    await flush();
    const secondRow = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")]
      .find((button) => button.textContent?.includes("second diff"));
    assert.ok(secondRow);
    await act(async () => secondRow.click());
    await flush();
    resolveDiff?.("stale diff");
    await flush();
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /stale diff/);
    assert.match(dom.window.document.body.textContent ?? "", /second\.ts/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});
