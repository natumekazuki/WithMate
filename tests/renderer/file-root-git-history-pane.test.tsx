import { readStylesheet } from "../support/read-stylesheet.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  FileRootGitChangeEntry,
  FileRootGitHistoryCommit,
  FileRootGitHistoryCommitDetailRequest,
  FileRootGitHistoryCommitDetailResult,
  FileRootGitHistoryCommitsRequest,
  FileRootGitHistoryCommitsResult,
  FileRootGitHistoryComparisonRequest,
  FileRootGitHistoryComparisonResult,
  FileRootGitHistoryDiffRequest,
  FileRootGitHistoryRepositoriesResult,
  FileRootGitHistoryRepository,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import { isFileRootGitHistoryComparisonDiffRequest } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { FileRootGitHistoryPaneProps } from "../../src/file-explorer/FileRootGitHistoryPane.js";

type ObserverEntry = { isIntersecting: boolean };

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly root: Element | Document | null;
  readonly callback: (entries: ObserverEntry[]) => void;
  readonly observedElements: Element[] = [];

  constructor(callback: (entries: ObserverEntry[]) => void, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = options?.root ?? null;
    TestIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observedElements.push(element);
  }
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
  branches: ["main", "feature/history"],
  currentBranch: "main",
  refs: [
    { kind: "branch", name: "main" },
    { kind: "branch", name: "feature/history" },
  ],
};
const repositoryB: FileRootGitHistoryRepository = {
  repositoryId: "git:bbbbbbbbbbbbbbbbbbbbbbbb",
  rootId: "additional:repo",
  label: "other",
  displayPath: "C:/other",
  branches: ["other"],
  currentBranch: "other",
  refs: [{ kind: "branch", name: "other" }],
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return this.clientHeight; },
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

const unusedHistoryComparison = async (): Promise<FileRootGitHistoryComparisonResult> => ({
  status: "failed",
  message: "unused",
});

// @test-value v2
// kind = "contract"
// claim = "commit detailの失敗は近接したRetryで同じ対象を再取得し、再失敗後も再試行でき、成功時は内容と操作可能なfocusへ復帰する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "Retryがない、別対象を取得する、busy中に再実行する、再失敗で回復操作を失う、または成功時にfocusが消失する"
// observable = "detail API request、alertのraw message、RetryのDOM identity/disabled/aria-busy、activeElement、成功後のchanged file tree"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane detail recovery"
// lifecycle = "permanent"
// impact = "一時的な取得失敗から同じcommitへ復帰できず、keyboard利用者が操作位置を失う"
// distinction = "既存の正常detail/refresh testでは扱わない、失敗応答・例外・再成功とRetryの継続性を遅延APIで確認する。描画寸法は別途実描画で確認する"
// @end-test-value
test("History detailは同じ対象をRetryでき再失敗と成功後のfocusを扱う", async () => {
  const { dom, restore } = installDom();
  const target = commit("a", "raw commit subject");
  const requests: FileRootGitHistoryCommitDetailRequest[] = [];
  const pending: Array<{
    resolve: (result: FileRootGitHistoryCommitDetailResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const api: NonNullable<FileRootGitHistoryPaneProps["api"]> = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok", repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async () => ({
      status: "ok", page: { entries: [target], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: (request) => {
      requests.push(request);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    getFileRootGitHistoryDiff: async () => ({ status: "failed", message: "unused" }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    const render = async (refreshRevision: number) => act(async () => {
      root ??= createRoot(dom.window.document.getElementById("root") as HTMLElement);
      root.render(React.createElement(FileRootGitHistoryPane, {
        api, sessionId: "session-1", enabled: true, rootsRevision: "roots-1", refreshRevision,
        onOpenDiff: async () => null,
      }));
    });
    await render(0);
    await flush();
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-commit-row")?.click());
    await act(async () => pending[0]?.resolve({ status: "failed", message: "raw error: initial" }));
    const alert = dom.window.document.querySelector<HTMLElement>(".file-history-detail [role='alert']");
    const retry = alert?.querySelector<HTMLButtonElement>("button");
    assert.ok(alert && retry);
    assert.match(alert.textContent ?? "", /raw error: initial/);
    assert.equal(retry.textContent, "Retry");
    retry.focus();
    await act(async () => retry.click());
    retry.blur();
    assert.equal(dom.window.document.querySelector(".file-history-detail [role='alert'] button"), retry);
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.equal(dom.window.document.querySelector(".file-history-detail")?.getAttribute("aria-busy"), "true");
    assert.match(alert.textContent ?? "", /raw error: initial/);
    await act(async () => retry.click());
    await render(1);
    await flush();
    assert.equal(requests.length, 2, "busy Retry and header refresh must not duplicate the detail request");
    await act(async () => pending[1]?.reject(new Error("raw error: retry")));
    assert.match(alert.textContent ?? "", /raw error: retry/);
    assert.equal(retry.disabled, false);
    assert.equal(retry.hasAttribute("aria-busy"), false);
    assert.equal(dom.window.document.activeElement, retry);
    await act(async () => retry.click());
    retry.blur();
    await act(async () => pending[2]?.resolve({ status: "ok", commit: target, entries: [changedEntry("recovered.ts")] }));
    assert.deepEqual(requests, Array.from({ length: 3 }, () => ({
      sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, commitId: target.id,
    })));
    assert.equal(dom.window.document.querySelector(".file-history-detail [role='alert']"), null);
    assert.equal(dom.window.document.querySelector(".file-history-detail-header h3")?.textContent, target.subject);
    assert.ok(dom.window.document.querySelector(".workspace-change-row[title='recovered.ts']"));
    assert.equal(dom.window.document.activeElement, dom.window.document.querySelector(".file-history-back"));
  } finally {
    await act(async () => root?.unmount());
    restore();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Retry中にHistoryへ戻るかcommit/repositoryを切り替えた後は旧対象の成功・失敗・例外が現在の表示やbusyへ反映されない"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "旧Retryの遅延結果が一覧や新しいdetailを上書きし、旧errorを表示するか新requestのbusyを解除する"
// observable = "現在の一覧/detail DOM、alert、aria-busy、changed file tree"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane retry request invalidation"
// lifecycle = "permanent"
// impact = "別repository/commitの内容や失敗を現在の対象として誤認させる"
// distinction = "初回detailの遅延成功だけを扱う既存testに対し、失敗後のRetryを保留してBack/別commit/別repositoryと成功/失敗/例外の各分岐を確認する"
// @end-test-value
test("History detailのRetry結果はBackとcommitまたはrepository切替後へ混入しない", async () => {
  for (const scenario of ["back", "commit", "repository"] as const) {
    const { dom, restore } = installDom();
    const first = commit("a", "first retry target");
    const second = commit("b", "second retry target");
    const pending: Array<{
      resolve: (result: FileRootGitHistoryCommitDetailResult) => void;
      reject: (error: Error) => void;
    }> = [];
    const api: NonNullable<FileRootGitHistoryPaneProps["api"]> = {
      listFileRootGitHistoryRepositories: async () => ({ status: "ok", repositories: [repositoryA, repositoryB] }),
      listFileRootGitHistoryCommits: async () => ({
        status: "ok", page: { entries: [first, second], nextCursor: null, hasMore: false },
      }),
      getFileRootGitHistoryCommitDetail: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      getFileRootGitHistoryDiff: async () => ({ status: "failed", message: "unused" }),
      getFileRootGitHistoryComparison: unusedHistoryComparison,
    };
    let root: Root | null = null;
    try {
      const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
      await act(async () => {
        root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
        root.render(React.createElement(FileRootGitHistoryPane, {
          api, sessionId: "session-1", enabled: true, rootsRevision: "roots-1", refreshRevision: 0,
          onOpenDiff: async () => null,
        }));
      });
      await flush();
      await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-commit-row")?.click());
      await act(async () => pending[0]?.resolve({ status: "failed", message: "initial failure" }));
      const retry = dom.window.document.querySelector<HTMLButtonElement>(".file-history-detail [role='alert'] button");
      assert.ok(retry);
      await act(async () => retry.click());
      assert.equal(pending.length, 2);
      if (scenario === "repository") {
        const selector = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History repository']");
        assert.ok(selector);
        await act(async () => {
          selector.value = repositoryB.repositoryId;
          selector.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        });
      } else {
        await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-back")?.click());
      }
      await flush();
      if (scenario !== "back") {
        await act(async () => dom.window.document.querySelector<HTMLButtonElement>(`.file-history-commit-row[data-commit-id='${second.id}']`)?.click());
        assert.equal(pending.length, 3);
      }
      await act(async () => {
        if (scenario === "back") {
          pending[1]?.resolve({ status: "ok", commit: first, entries: [changedEntry("stale.ts")] });
        } else if (scenario === "commit") {
          pending[1]?.resolve({ status: "failed", message: "stale failure" });
        } else {
          pending[1]?.reject(new Error("stale exception"));
        }
      });
      assert.equal(dom.window.document.querySelector("[role='alert']"), null, scenario);
      assert.equal(dom.window.document.querySelector(".workspace-change-row[title='stale.ts']"), null);
      if (scenario === "back") {
        assert.ok(dom.window.document.querySelector(".file-history-commit-list"));
      } else {
        assert.equal(dom.window.document.querySelector(".file-history-detail-header h3")?.textContent, second.subject);
        assert.equal(dom.window.document.querySelector(".file-history-detail")?.getAttribute("aria-busy"), "true");
        await act(async () => pending[2]?.resolve({ status: "ok", commit: second, entries: [changedEntry("current.ts")] }));
        assert.ok(dom.window.document.querySelector(".workspace-change-row[title='current.ts']"));
      }
    } finally {
      await act(async () => root?.unmount());
      restore();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "History paginationは専用scroll rootのsentinelから次pageを一度だけ取得し、完了後sentinelを隠す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "Load more buttonへの依存、scroll rootの誤り、同じcursorの重複取得、またはhasMore false後もsentinelが残る"
// observable = "DOMのLoad more button・sentinel・IntersectionObserver rootとobserved sentinel、public listFileRootGitHistoryCommits request"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane pagination"
// lifecycle = "permanent"
// distinction = "intersection triggerを連続して与え、in-flight guardとnextCursor、完了時のDOMを同時に観測する"
// @end-test-value
test("History pagination は Load more buttonを出さず sentinel と専用scroll rootで次pageを一度だけ取得する", async () => {
  const { dom, restore } = installDom();
  const pageRequests: FileRootGitHistoryCommitsRequest[] = [];
  const pendingPages: Array<(result: FileRootGitHistoryCommitsResult) => void> = [];
  const first = commit("a", "first commit");
  const second = commit("b", "second commit");
  const third = commit("c", "third commit");
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: (request: FileRootGitHistoryCommitsRequest) => {
      pageRequests.push(request);
      return new Promise<FileRootGitHistoryCommitsResult>((resolve) => pendingPages.push(resolve));
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "ok" as const, commit: first, entries: [] }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: first.id, displayPath: "C:/repo", relativePath: null, patch: "", previewResource: null }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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
    assert.deepEqual(pageRequests, [{ sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, branch: "main", cursor: null }]);
    await act(async () => {
      pendingPages.shift()?.({
        status: "ok",
        page: { entries: [first, second], nextCursor: "100", hasMore: true },
      });
      await Promise.resolve();
    });
    assert.equal(
      Array.from(dom.window.document.querySelectorAll("button"))
        .some((button) => button.textContent?.includes("Load more") ?? false),
      false,
    );
    assert.ok(dom.window.document.querySelector(".file-history-list-sentinel"));
    const observer = TestIntersectionObserver.instances.at(-1);
    assert.ok(observer);
    assert.equal(observer?.root, dom.window.document.querySelector(".file-history-commit-list"));
    assert.equal(observer?.observedElements.at(-1), dom.window.document.querySelector(".file-history-list-sentinel"));
    await act(async () => observer?.trigger(false));
    await flush();
    assert.equal(pageRequests.length, 1);
    await act(async () => {
      observer?.trigger(true);
      observer?.trigger(true);
    });
    await flush();
    assert.deepEqual(pageRequests, [
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, branch: "main", cursor: null },
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, branch: "main", cursor: "100" },
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

// @test-value v2
// kind = "contract"
// claim = "Historyの追加page失敗は既存commit一覧を保持し、sentinelから同じcursorを再試行できる"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "追加pageの失敗で既存一覧を消す、再試行できない、または同じcursorを重複せず誤ったcursorで取得する"
// observable = "commit list DOM、error message、sentinel DOM、public listFileRootGitHistoryCommits cursor request"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane pagination failure recovery"
// lifecycle = "permanent"
// distinction = "追加pageの失敗後に既存commitとエラーを同時に保持し、同じsentinel triggerの再試行で次pageを一度だけ反映することをDOMとpublic requestで確認する"
// @end-test-value
test("History 追加pageの失敗は既存一覧を維持し、sentinelから再試行できる", async () => {
  const { dom, restore } = installDom();
  const first = commit("a", "first commit");
  const second = commit("b", "retried commit");
  const pageRequests: string[] = [];
  let appendAttempts = 0;
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async (request: FileRootGitHistoryCommitsRequest) => {
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
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: first.id, displayPath: "C:/repo", relativePath: null, patch: "", previewResource: null }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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

// @test-value v2
// kind = "contract"
// claim = "History repository切替は古いpageを破棄し、選択repositoryのcurrent branchから取得する"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "古い非同期pageが新repository一覧に混入する、またはrepository切替後も古い一覧を表示する"
// observable = "repository select value、commit list、public listFileRootGitHistoryCommits request"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane repository selection"
// lifecycle = "permanent"
// distinction = "初回pageを表示した後、同じrepositoryのrefresh中に別repositoryを選択し、旧page表示を即時破棄するとともに遅延した旧page結果を無視して新repositoryのcursor nullから始めることを確認する"
// @end-test-value
test("History repository切り替えは古いpageを捨てて新repositoryの先頭から開始する", async () => {
  const { dom, restore } = installDom();
  const switchRepositoryB: FileRootGitHistoryRepository = {
    ...repositoryB,
    branches: ["other-shadow", "other"],
    currentBranch: "other",
  };
  const pageRequests: FileRootGitHistoryCommitsRequest[] = [];
  const pendingPages: Array<(result: FileRootGitHistoryCommitsResult) => void> = [];
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA, switchRepositoryB] }),
    listFileRootGitHistoryCommits: (request: FileRootGitHistoryCommitsRequest) => {
      pageRequests.push(request);
      if (pageRequests.length === 1) {
        return Promise.resolve({
          status: "ok" as const,
          page: { entries: [commit("d", "old repository")], nextCursor: null, hasMore: false },
        });
      }
      return new Promise<FileRootGitHistoryCommitsResult>((resolve) => pendingPages.push(resolve));
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "ok" as const, commit: commit("d", "detail"), entries: [] }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: commit("d", "detail").id, displayPath: "C:/repo", relativePath: null, patch: "", previewResource: null }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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
    assert.match(dom.window.document.body.textContent ?? "", /old repository/);
    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 1,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const select = dom.window.document.querySelector("select") as HTMLSelectElement;
    assert.ok(select);
    assert.equal(pageRequests.length, 2);
    await act(async () => {
      select.value = repositoryB.repositoryId;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    assert.equal(select.value, switchRepositoryB.repositoryId);
    assert.deepEqual(pageRequests, [
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, branch: "main", cursor: null },
      { sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, branch: "main", cursor: null },
      { sessionId: "session-1", repositoryId: switchRepositoryB.repositoryId, rootId: switchRepositoryB.rootId, branch: "other", cursor: null },
    ]);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /old repository/);
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

// @test-value v2
// kind = "contract"
// claim = "History repositoryの再読込開始時は旧Compare表示とcallback対象を即時に失効させ、再読込失敗を現在のpaneに反映する"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "repository再読込中も旧Compare表示やcallback対象を保持し、失敗した再読込のmessageを表示しない"
// observable = "onRepositoryChange callback value、repository request count、History pane DOM state"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane repository reload invalidation"
// lifecycle = "permanent"
// distinction = "初回repository選択後にCompareを開き、rootsRevisionを変え、再読込がpendingの間にcallbackへnullを渡してCompare表示を失効させ、失敗messageを表示することを観測する"
// @end-test-value
test("History repository一覧の再読込開始時に旧Diffを即座に失効させる", async () => {
  const { dom, restore } = installDom();
  const repositoryChanges: Array<string | null> = [];
  let repositoryRequests = 0;
  let resolveReload: ((result: FileRootGitHistoryRepositoriesResult) => void) | null = null;
  const api = {
    listFileRootGitHistoryRepositories: async () => {
      repositoryRequests += 1;
      if (repositoryRequests === 1) {
        return { status: "ok" as const, repositories: [repositoryA] };
      }
        return new Promise<FileRootGitHistoryRepositoriesResult>((resolve) => {
        resolveReload = resolve;
      });
    },
    listFileRootGitHistoryCommits: async () => ({
      status: "ok" as const,
      page: { entries: [commit("a", "first commit")], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "none" }),
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "none" }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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
        onRepositoryChange: (repositoryId) => repositoryChanges.push(repositoryId),
      }));
      await Promise.resolve();
    });
    await flush();
    assert.equal(repositoryChanges.at(-1), repositoryA.repositoryId);
    const compareTrigger = dom.window.document.querySelector<HTMLButtonElement>(".file-history-compare-trigger");
    assert.ok(compareTrigger);
    await act(async () => compareTrigger.click());
    await flush();
    assert.ok(dom.window.document.querySelector(".file-history-comparison"));

    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-2",
        refreshRevision: 0,
        onOpenDiff: async () => null,
        onRepositoryChange: (repositoryId) => repositoryChanges.push(repositoryId),
      }));
      await Promise.resolve();
    });
    await flush();
    assert.equal(repositoryRequests, 2);
    assert.equal(repositoryChanges.at(-1), null);
    assert.equal(dom.window.document.querySelector(".file-history-comparison"), null);

    await act(async () => {
      resolveReload?.({ status: "failed", message: "repository reload failed" });
      await Promise.resolve();
    });
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /repository reload failed/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Historyは対象rootのcurrent branchを初期選択し、明示したbranchの選択を同一rootのrefreshで保持し、root変更で新repositoryのcurrent branchへ戻す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "全branchの履歴を表示する、normal refreshや再描画で選択branchをcurrent branchへ戻す、root変更でbranches先頭を誤選択する、または削除された選択branchを別branchとして成功表示する"
// observable = "History branch selectのvalue・current branch label、commit list、listFileRootGitHistoryCommits request"
// observation_boundary = "consumer"
// scope = "FileRootGitHistoryPane branch selection"
// lifecycle = "permanent"
// impact = "利用者が見ているbranchの履歴がnormal refreshやroot切替のたびに別branchへすり替わらない"
// distinction = "serviceのbranch到達性検証とは別に、非先頭のcurrentBranchを含むcomponentのcurrentBranch、user selection、refresh、root変更、削除branchの表示をどう投影するかをDOMとpublic API requestで確認する"
// @end-test-value
test("History branch選択は同一rootのrefreshで保持しroot変更でcurrent branchへ戻す", async () => {
  const { dom, restore } = installDom();
  const branchRepositoryA: FileRootGitHistoryRepository = {
    ...repositoryA,
    branches: ["feature/history", "main"],
    currentBranch: "main",
  };
  const deletedRepository: FileRootGitHistoryRepository = {
    ...branchRepositoryA,
    branches: ["main"],
    currentBranch: "main",
  };
  const branchRepositoryB: FileRootGitHistoryRepository = {
    ...repositoryB,
    branches: ["other-shadow", "other"],
    currentBranch: "other",
  };
  const repositoryResponses = [
    { status: "ok" as const, repositories: [branchRepositoryA] },
    { status: "ok" as const, repositories: [branchRepositoryA] },
    { status: "ok" as const, repositories: [deletedRepository] },
    { status: "ok" as const, repositories: [branchRepositoryB] },
  ];
  const pageRequests: FileRootGitHistoryCommitsRequest[] = [];
  let repositoryRequests = 0;
  let resolveInitialMainPage: ((result: FileRootGitHistoryCommitsResult) => void) | null = null;
  const api = {
    listFileRootGitHistoryRepositories: async () => {
      const response = repositoryResponses[Math.min(repositoryRequests, repositoryResponses.length - 1)]!;
      repositoryRequests += 1;
      return response;
    },
    listFileRootGitHistoryCommits: async (request: FileRootGitHistoryCommitsRequest) => {
      pageRequests.push(request);
      if (request.branch === "main" && pageRequests.length === 1) {
        return new Promise<FileRootGitHistoryCommitsResult>((resolve) => {
          resolveInitialMainPage = resolve;
        });
      }
      if (request.branch === "feature/history" && repositoryRequests === 3) {
        return { status: "branch-not-found" as const, message: "The selected Git branch is no longer available." };
      }
      const selectedCommit = request.repositoryId === branchRepositoryB.repositoryId
        ? commit("c", "other branch commit")
        : request.branch === "feature/history"
          ? commit("b", "feature branch commit")
          : commit("a", "main branch commit");
      return {
        status: "ok" as const,
        page: { entries: [selectedCommit], nextCursor: null, hasMore: false },
      };
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "none" }),
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "none" }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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
    const branchSelect = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
    assert.ok(branchSelect);
    assert.equal(branchSelect.value, "main");
    assert.ok([...branchSelect.options].some((option) => option.textContent === "main (Current)"));
    assert.deepEqual(pageRequests, [{ sessionId: "session-1", repositoryId: repositoryA.repositoryId, rootId: repositoryA.rootId, branch: "main", cursor: null }]);

    await act(async () => {
      branchSelect.value = "feature/history";
      branchSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    const selectedBranchAfterSelection = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
    assert.ok(selectedBranchAfterSelection);
    assert.equal(selectedBranchAfterSelection.value, "feature/history");
    assert.deepEqual(pageRequests.at(-1), {
      sessionId: "session-1",
      repositoryId: repositoryA.repositoryId,
      rootId: repositoryA.rootId,
      branch: "feature/history",
      cursor: null,
    });
    assert.match(dom.window.document.body.textContent ?? "", /feature branch commit/);
    await act(async () => {
      resolveInitialMainPage?.({
        status: "ok",
        page: { entries: [commit("stale-main", "stale main branch commit")], nextCursor: null, hasMore: false },
      });
      await Promise.resolve();
    });
    await flush();
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /stale main branch commit/);
    assert.match(dom.window.document.body.textContent ?? "", /feature branch commit/);

    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
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
    assert.equal(repositoryRequests, 1);
    const selectedBranchAfterRerender = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
    assert.ok(selectedBranchAfterRerender);
    assert.equal(selectedBranchAfterRerender.value, "feature/history");

    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 1,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const selectedBranchAfterRefresh = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
    assert.ok(selectedBranchAfterRefresh);
    assert.equal(selectedBranchAfterRefresh.value, "feature/history");
    assert.deepEqual(pageRequests.at(-1), {
      sessionId: "session-1",
      repositoryId: repositoryA.repositoryId,
      rootId: repositoryA.rootId,
      branch: "feature/history",
      cursor: null,
    });

    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-1",
        refreshRevision: 2,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const selectedBranchAfterDeletion = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
    assert.ok(selectedBranchAfterDeletion);
    assert.equal(selectedBranchAfterDeletion.value, "feature/history");
    assert.ok([...selectedBranchAfterDeletion.options].some((option) => option.disabled && option.value === "feature/history"));

    await act(async () => {
      root?.render(React.createElement(FileRootGitHistoryPane, {
        api,
        sessionId: "session-1",
        enabled: true,
        rootsRevision: "roots-2",
        refreshRevision: 2,
        onOpenDiff: async () => null,
      }));
      await Promise.resolve();
    });
    await flush();
    const nextBranchSelect = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
    assert.ok(nextBranchSelect);
    assert.equal(nextBranchSelect.value, branchRepositoryB.currentBranch);
    assert.deepEqual(pageRequests.at(-1), {
      sessionId: "session-1",
      repositoryId: branchRepositoryB.repositoryId,
      rootId: branchRepositoryB.rootId,
      branch: "other",
      cursor: null,
    });
    assert.match(dom.window.document.body.textContent ?? "", /other branch commit/);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "History detailはref種別、commit metadata、changed file tree、file diffとOpen All Changesを同じpane状態で利用できる"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "detail headerのref種別やcommit metadataが欠落する、changed file treeを開けない、またはOpen All Changesが選択commitのdiff callbackへ渡らない"
// observable = "detail header DOM、ref badge markerとaccessible label、changed file tree DOM、diff request、Open All Changes callback"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane commit detail"
// lifecycle = "permanent"
// distinction = "単一commitをdetailへ開き、headerのref/metadata、changed file、通常のOpen All Changes requestを同時に観測する"
// @end-test-value
test("History detail はref種別、commit metadata、changed file tree、file diffとOpen All Changesを同じ状態で開く", async () => {
  const { dom, restore } = installDom();
  const targetCommit = commit("1", "history detail");
  targetCommit.refs = [
    { kind: "head", name: "HEAD" },
    { kind: "branch", name: "feature/history-layout" },
    { kind: "tag", name: "v6.3.25" },
  ];
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
      if (isFileRootGitHistoryComparisonDiffRequest(request)) {
        return {
          status: "ok" as const,
          comparison: request.comparison,
          displayPath: `C:/repo${request.relativePath ? `/${request.relativePath}` : ""}`,
          relativePath: request.relativePath ?? null,
          patch: "diff --git",
          previewBeforeResource: null,
          previewAfterResource: null,
        };
      }
      return {
        status: "ok" as const,
        commitId: request.commitId,
        displayPath: `C:/repo${request.relativePath ? `/${request.relativePath}` : ""}`,
        relativePath: request.relativePath ?? null,
        patch: "diff --git",
        previewResource: null,
      };
    },
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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
    assert.match(commitButton.textContent ?? "", /feature\/history-layout/);
    assert.ok(commitButton.querySelector(".file-history-commit-row-ref-badges"));
    const badgeStates = (container: ParentNode) => (
      [...container.querySelectorAll<HTMLElement>(".file-history-ref-badge")].map((badge) => ({
        kind: badge.dataset.refKind,
        marker: badge.querySelector(".file-history-ref-badge-marker")?.textContent,
        label: badge.getAttribute("aria-label"),
      }))
    );
    const expectedBadges = [
      { kind: "head", marker: "H", label: "HEAD" },
      { kind: "branch", marker: "B", label: "Branch: feature/history-layout" },
      { kind: "tag", marker: "T", label: "Tag: v6.3.25" },
    ];
    assert.deepEqual(badgeStates(commitButton), expectedBadges);
    await act(async () => commitButton.click());
    await flush();
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    await flush();
    assert.match(dom.window.document.body.textContent ?? "", /history detail/);
    const detailHeader = dom.window.document.querySelector(".file-history-detail-header");
    assert.ok(detailHeader);
    assert.equal(detailHeader.querySelector("code")?.textContent, targetCommit.id);
    assert.equal(
      detailHeader.querySelector(".file-history-commit-meta span")?.textContent,
      targetCommit.authorName,
    );
    assert.equal(
      detailHeader.querySelector("time")?.getAttribute("dateTime"),
      targetCommit.authoredAt,
    );
    assert.deepEqual(badgeStates(detailHeader), expectedBadges);
    const fileButton = dom.window.document.querySelector<HTMLButtonElement>(
      ".workspace-change-row[title='src/example.ts']",
    );
    assert.ok(fileButton);
    await act(async () => fileButton.click());
    await flush();
    const fileDiffRequest = diffRequests.at(-1);
    assert.ok(fileDiffRequest && !isFileRootGitHistoryComparisonDiffRequest(fileDiffRequest));
    assert.equal(fileDiffRequest.relativePath, "src/example.ts");
    assert.equal(fileDiffRequest.commitId, targetCommit.id);
    const openChanges = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open All Changes");
    assert.ok(openChanges);
    await act(async () => openChanges.click());
    await flush();
    const allChangesRequest = diffRequests.at(-1);
    assert.ok(allChangesRequest && !isFileRootGitHistoryComparisonDiffRequest(allChangesRequest));
    assert.equal(allChangesRequest.relativePath, null);
    assert.equal(allChangesRequest.commitId, targetCommit.id);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "HistoryのCompareは履歴entryとbranch toolbarから同じpane内で起動し、pickerのlabel・focus・closeを保ったままbranch/remote refとmodeを固定comparisonのdiff callbackへ渡す"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Compare" }
// fault = "Compare用の別tabを増やす、履歴entryから起動できない、endpoint labelのないpicker、外側クリックやEscapeで閉じないpicker、focusを失うpicker、branch/remote refを選べない、modeを失う、またはCtrl+clickをcentralへ固定する"
// observable = "Compare trigger、picker ARIA label、ArrowDown option focus、outside pointer close、Escape focus restore、picker options、mode select、comparison request、resolved OID header、changed file DOM、onOpenDiff openInWindow"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane comparison"
// lifecycle = "permanent"
// impact = "履歴画面から比較条件を指定して、detached diff callbackへ同じcomparisonを渡せる"
// distinction = "履歴entryのCompare起動後に戻り、toolbarからbase/targetをpicker keyboard操作と外側クリック・Escapeを含めて選択し、direct modeとfileのCtrl+clickでpublic callback requestを観測する"
// @end-test-value
test("History Compareはentryとtoolbarから起動し、固定comparisonをdetached diff callbackへ渡す", async () => {
  const { dom, restore } = installDom();
  const comparisonRepository: FileRootGitHistoryRepository = {
    ...repositoryA,
    refs: [
      { kind: "branch", name: "main" },
      { kind: "branch", name: "feature/history" },
      { kind: "remote", name: "origin/feature/history" },
      { kind: "tag", name: "v6.3.25" },
    ],
  };
  const targetCommit = commit("1", "compare entry");
  const comparisonRequests: FileRootGitHistoryComparisonRequest[] = [];
  const diffRequests: Array<{ request: FileRootGitHistoryDiffRequest; openInWindow: boolean }> = [];
  const comparison: NonNullable<FileRootGitHistoryComparisonResult & { status: "ok" }> = {
    status: "ok",
    comparison: {
      mode: "direct",
      base: { kind: "branch", name: "feature/history" },
      target: { kind: "remote", name: "origin/feature/history" },
      baseCommitId: "a".repeat(40),
      targetCommitId: "b".repeat(40),
      mergeBaseCommitId: null,
    },
    entries: [changedEntry("src/example.ts")],
  };
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [comparisonRepository] }),
    listFileRootGitHistoryCommits: async () => ({
      status: "ok" as const,
      page: { entries: [targetCommit], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: async () => ({ status: "ok" as const, commit: targetCommit, entries: [] }),
    getFileRootGitHistoryComparison: async (request: FileRootGitHistoryComparisonRequest) => {
      comparisonRequests.push(request);
      return comparison;
    },
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "unused" }),
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
        onOpenDiff: async (request: FileRootGitHistoryDiffRequest, openInWindow: boolean) => {
          diffRequests.push({ request, openInWindow });
          return null;
        },
      }));
      await Promise.resolve();
    });
    await flush();
    const entryCompare = dom.window.document.querySelector<HTMLButtonElement>(".file-history-commit-compare");
    assert.ok(entryCompare);
    await act(async () => entryCompare.click());
    await flush();
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>(".file-history-comparison-picker-trigger")?.textContent?.trim(),
      "Commit " + targetCommit.id.slice(0, 7),
    );
    const comparisonBack = dom.window.document.querySelector<HTMLButtonElement>(".file-history-back");
    assert.ok(comparisonBack);
    await act(async () => comparisonBack.click());
    await flush();

    const compareTrigger = dom.window.document.querySelector<HTMLButtonElement>(".file-history-compare-trigger");
    assert.ok(compareTrigger);
    await act(async () => compareTrigger.click());
    await flush();
    const pickers = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-comparison-picker-trigger")];
    assert.equal(pickers.length, 2);
    const baseLabelIds = pickers[0]?.getAttribute("aria-labelledby")?.split(/\s+/u) ?? [];
    assert.equal(baseLabelIds.length, 2);
    assert.equal(dom.window.document.getElementById(baseLabelIds[0] ?? "")?.textContent, "Base");
    assert.ok(dom.window.document.getElementById(baseLabelIds[1] ?? ""));
    await act(async () => pickers[0]?.click());
    await flush();
    assert.equal(dom.window.document.querySelectorAll(".file-history-comparison-picker-menu").length, 1);
    const baseSearch = dom.window.document.querySelector<HTMLInputElement>("input[aria-label='Base search']");
    assert.ok(baseSearch);
    await act(async () => {
      baseSearch?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      await Promise.resolve();
    });
    assert.equal(dom.window.document.activeElement?.getAttribute("role"), "option");
    const comparisonMode = dom.window.document.querySelector<HTMLElement>(".file-history-comparison-mode");
    assert.ok(comparisonMode);
    await act(async () => {
      comparisonMode?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    assert.equal(dom.window.document.querySelectorAll(".file-history-comparison-picker-menu").length, 0);
    await act(async () => pickers[0]?.click());
    await flush();
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await Promise.resolve();
    });
    await flush();
    assert.equal(dom.window.document.querySelectorAll(".file-history-comparison-picker-menu").length, 0);
    assert.equal(dom.window.document.activeElement, pickers[0]);
    await act(async () => pickers[0]?.click());
    await flush();
    const baseOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-comparison-picker-option")]
      .find((button) => button.textContent?.includes("feature/history") && !button.textContent.includes("origin/"));
    assert.ok(baseOption);
    await act(async () => baseOption?.click());
    await act(async () => pickers[1]?.click());
    await flush();
    const targetOption = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-comparison-picker-option")]
      .find((button) => button.textContent?.includes("origin/feature/history"));
    assert.ok(targetOption);
    await act(async () => targetOption?.click());
    const modeSelect = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='Comparison mode']");
    assert.ok(modeSelect);
    modeSelect.value = "direct";
    await act(async () => {
      modeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const submit = dom.window.document.querySelector<HTMLButtonElement>(".file-history-comparison-submit");
    assert.ok(submit);
    await act(async () => submit.click());
    await flush();
    assert.deepEqual(comparisonRequests.at(-1), {
      sessionId: "session-1",
      repositoryId: comparisonRepository.repositoryId,
      rootId: comparisonRepository.rootId,
      base: { kind: "branch", name: "feature/history" },
      target: { kind: "remote", name: "origin/feature/history" },
      mode: "direct",
    });
    const resultHeader = dom.window.document.querySelector<HTMLElement>(".file-history-comparison-result-header");
    assert.equal(resultHeader?.dataset.baseCommitId, "a".repeat(40));
    assert.equal(resultHeader?.dataset.targetCommitId, "b".repeat(40));
    assert.match(resultHeader?.textContent ?? "", /Direct Comparison/);
    const openAllChanges = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open All Changes");
    assert.ok(openAllChanges);
    await act(async () => openAllChanges.click());
    await flush();
    assert.equal(diffRequests.at(-1)?.request.relativePath, null);
    const filter = dom.window.document.querySelector<HTMLInputElement>("input[aria-label='Filter changed files']");
    assert.ok(filter);
    filter.value = "example";
    await act(async () => {
      filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const fileButton = dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row[title='src/example.ts']");
    assert.ok(fileButton);
    await act(async () => {
      fileButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
      await Promise.resolve();
    });
    await flush();
    assert.equal(diffRequests.at(-1)?.openInWindow, true);
    assert.deepEqual(diffRequests.at(-1)?.request, {
      sessionId: "session-1",
      repositoryId: comparisonRepository.repositoryId,
      rootId: comparisonRepository.rootId,
      comparison: comparison.comparison,
      relativePath: "src/example.ts",
    });
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Git History ref badgeの共有primitiveはforeground、background、borderを明示し、HEAD、branch、tagのvariantは既存theme tokenでaccentを選ぶ"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "badgeの背景またはborderが透明なまま文字色だけを変え、通常、hover、selected row、detail headerの背景上でref labelが埋もれる"
// observable = "readStylesheet()で展開したentryのfile-history-ref-badge ruleとhead/branch/tag variant declarations"
// observation_boundary = "implementation"
// scope = "file-history-ref-badge-css"
// lifecycle = "permanent"
// distinction = "DOMでは算出できないCSSのforeground、background、border契約とvariantのtheme token利用を静的に検証する"
// @end-test-value
test("History ref badge CSS は共有primitiveでforeground、background、borderとtheme variantを定義する", async () => {
  const css = await readStylesheet();
  const badgeRule = css.match(/^\.file-history-ref-badge\s*\{(?<body>[\s\S]*?)\n\}/m)?.groups?.body ?? "";

  assert.match(badgeRule, /--file-history-ref-foreground:\s*var\(--ink\);/);
  assert.match(badgeRule, /--file-history-ref-background:\s*color-mix\([\s\S]*var\(--surface-strong\)[\s\S]*\);/);
  assert.match(badgeRule, /--file-history-ref-border:\s*color-mix\([\s\S]*var\(--ink\)[\s\S]*\);/);
  assert.match(badgeRule, /border:\s*1px solid var\(--file-history-ref-border\);/);
  assert.match(badgeRule, /background:\s*var\(--file-history-ref-background\);/);
  assert.match(badgeRule, /color:\s*var\(--file-history-ref-foreground\);/);
  assert.match(css, /\.file-history-ref-badge--head\s*\{\s*--file-history-ref-accent:\s*var\(--character-main\);\s*\}/);
  assert.match(css, /\.file-history-ref-badge--branch\s*\{\s*--file-history-ref-accent:\s*var\(--teal\);\s*\}/);
  assert.match(css, /\.file-history-ref-badge--tag\s*\{\s*--file-history-ref-accent:\s*var\(--gold\);\s*\}/);
});

// @test-value v2
// kind = "invariant"
// claim = "Historyは古いcommit detail結果を、Back後に選択された現在のcommitへ反映しない"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "前のcommit detailの遅延結果が新しく選択したcommitのchanged file treeへ混入する"
// observable = "changed file tree DOMに表示されるold.ts/new.ts"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane commit detail request invalidation"
// lifecycle = "permanent"
// distinction = "first commit detailをpendingのままBackしてsecond commitを選び、first response後もold pathが表示されずsecond responseだけが表示されることを観測する"
// @end-test-value
test("History は古いcommit detail結果を現在のcommitへ混入させない", async () => {
  const { dom, restore } = installDom();
  const firstCommit = commit("a", "first detail");
  const secondCommit = commit("b", "second detail");
  const pendingDetails: Array<(result: FileRootGitHistoryCommitDetailResult) => void> = [];
  const api = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok" as const, repositories: [repositoryA] }),
    listFileRootGitHistoryCommits: async () => ({
      status: "ok" as const,
      page: { entries: [firstCommit, secondCommit], nextCursor: null, hasMore: false },
    }),
    getFileRootGitHistoryCommitDetail: (request: { commitId: string }) => new Promise<FileRootGitHistoryCommitDetailResult>((resolve) => {
      pendingDetails.push((result) => resolve(result));
      assert.ok(request.commitId === firstCommit.id || request.commitId === secondCommit.id);
    }),
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: firstCommit.id, displayPath: "C:/repo", relativePath: null, patch: "", previewResource: null }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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

// @test-value v2
// kind = "invariant"
// claim = "Historyは古いfile Diff結果を、Back後に選択された現在のcommitへ反映しない"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "前のcommitの遅延Diff結果がBack後に選択したcommitのchanged file treeへ混入する"
// observable = "diff result messageのDOMと現在commitのchanged file tree DOM"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane file diff request invalidation"
// lifecycle = "permanent"
// distinction = "first commitのfile diff callbackをpendingにしてBack後にsecond commitを開き、遅延したstale diffが表示されずsecond commit pathだけが残ることを観測する"
// @end-test-value
test("History は古いfile Diff結果をBack後のcommitへ混入させない", async () => {
  const { dom, restore } = installDom();
  const firstCommit = commit("a", "first diff");
  const secondCommit = commit("b", "second diff");
  const diffResolver: { resolve: ((message: string | null) => void) | null } = { resolve: null };
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
    getFileRootGitHistoryDiff: async () => ({ status: "ok" as const, commitId: firstCommit.id, displayPath: "C:/repo", relativePath: null, patch: "", previewResource: null }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
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
          diffResolver.resolve = resolve;
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
    assert.ok(diffResolver.resolve);
    const backButton = dom.window.document.querySelector<HTMLButtonElement>(".file-history-back");
    assert.ok(backButton);
    await act(async () => backButton.click());
    await flush();
    const secondRow = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")]
      .find((button) => button.textContent?.includes("second diff"));
    assert.ok(secondRow);
    await act(async () => secondRow.click());
    await flush();
    diffResolver.resolve?.("stale diff");
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

// @test-value v2
// kind = "contract"
// claim = "Historyはvisible期間だけrefreshとpaginationを開始し、集中したrefreshを一つの後続取得へ集約し、失敗しても読む行とfocusを保つ"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "hidden状態で取得する、refresh要求ごとに並行取得する、またはrefresh中と失敗時に既読行をunmountする"
// observable = "repository/page API呼出数、commit rowのDOM identityとactiveElement、失敗alert"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane visibility and refresh queue"
// lifecycle = "permanent"
// impact = "会話や他tabへ移っている間の不要な取得と、閲覧復帰時の読む位置やkeyboard focusの喪失を防ぐ"
// distinction = "既存pagination testでは扱わないvisibilityと遅延refreshの重なりをpublic APIとDOMで検証する"
// @end-test-value
test("History refreshはvisibilityとqueueを守り失敗時も読む行を保持する", async () => {
  const { dom, restore } = installDom();
  let repositoryReads = 0;
  const pendingRepositories: Array<(result: FileRootGitHistoryRepositoriesResult) => void> = [];
  const pageRequests: FileRootGitHistoryCommitsRequest[] = [];
  const api = {
    listFileRootGitHistoryRepositories: async () => {
      repositoryReads += 1;
      if (repositoryReads === 1) {
        return { status: "ok" as const, repositories: [repositoryA] };
      }
      return new Promise<FileRootGitHistoryRepositoriesResult>((resolve) => pendingRepositories.push(resolve));
    },
    listFileRootGitHistoryCommits: async (request: FileRootGitHistoryCommitsRequest) => {
      pageRequests.push(request);
      return { status: "ok" as const, page: { entries: [commit("a", "reading commit")], nextCursor: "100", hasMore: true } };
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "unused" }),
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "unused" }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    const render = async (visible: boolean, refreshRevision: number) => {
      await act(async () => root?.render(React.createElement(FileRootGitHistoryPane, {
        api, sessionId: "session-1", enabled: true, visible, rootsRevision: "roots-1", refreshRevision,
        onOpenDiff: async () => null,
      })));
      await flush();
    };
    await render(false, 0);
    assert.equal(repositoryReads, 0);
    await render(false, 1);
    assert.equal(repositoryReads, 0);
    await render(true, 1);
    assert.equal(repositoryReads, 1);
    const row = dom.window.document.querySelector<HTMLButtonElement>(".file-history-commit-row");
    assert.ok(row);
    row.focus();
    await render(true, 2);
    await render(true, 3);
    await render(true, 4);
    assert.equal(repositoryReads, 2);
    assert.equal(dom.window.document.querySelector(".file-history-commit-row"), row);
    assert.equal(dom.window.document.activeElement, row);
    await act(async () => pendingRepositories[0]?.({ status: "ok", repositories: [repositoryA] }));
    await flush();
    assert.equal(repositoryReads, 3);
    await act(async () => pendingRepositories[1]?.({ status: "failed", message: "refresh unavailable" }));
    await flush();
    assert.equal(repositoryReads, 3);
    assert.equal(dom.window.document.querySelector(".file-history-commit-row"), row);
    assert.equal(dom.window.document.activeElement, row);
    assert.match(dom.window.document.querySelector("[role='alert']")?.textContent ?? "", /refresh unavailable/);
    const observer = TestIntersectionObserver.instances.at(-1);
    const pagesBeforeHide = pageRequests.length;
    await render(false, 5);
    await act(async () => observer?.trigger(true));
    await flush();
    assert.equal(repositoryReads, 3);
    assert.equal(pageRequests.length, pagesBeforeHide);
    await render(true, 5);
    assert.equal(repositoryReads, 4);
    await act(async () => pendingRepositories[2]?.({ status: "ok", repositories: [repositoryA] }));
    await flush();
    assert.equal(dom.window.document.querySelector("[role='alert']"), null);
  } finally {
    await act(async () => root?.unmount());
    restore();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "History refreshはcommit detailと選択file、Compareのdraftと固定結果を保持し、一覧は戻った時点で更新する"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "refreshでdetailやCompareを初期化し、ref移動後のcommitへ固定結果を暗黙に変更する"
// observable = "detail/file DOM identity、focus、selected file、Compare picker値と固定OID、diff callback request、一覧API呼出数"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane immutable reading snapshots"
// lifecycle = "permanent"
// impact = "利用者が見ているcommitと比較対象が自動refreshで別の内容へすり替わらない"
// distinction = "既存detailとCompareの操作testに対し、同一repositoryの外部refreshを挟んだsnapshot継続性を検証する"
// @end-test-value
test("History refreshはdetailとCompare snapshotを保持する", async () => {
  const { dom, restore } = installDom();
  const readingCommit = commit("a", "reading detail");
  let repositoryReads = 0;
  let pageReads = 0;
  let detailReads = 0;
  let comparisonReads = 0;
  const openedDiffs: FileRootGitHistoryDiffRequest[] = [];
  const fixedComparison = {
    mode: "branch" as const,
    base: { kind: "branch" as const, name: "feature/history" },
    target: { kind: "branch" as const, name: "main" },
    baseCommitId: "b".repeat(40), targetCommitId: "a".repeat(40), mergeBaseCommitId: "c".repeat(40),
  };
  const api = {
    listFileRootGitHistoryRepositories: async () => {
      repositoryReads += 1;
      return { status: "ok" as const, repositories: [{ ...repositoryA, currentBranch: repositoryReads > 1 ? "feature/history" : "main" }] };
    },
    listFileRootGitHistoryCommits: async () => {
      pageReads += 1;
      return { status: "ok" as const, page: { entries: [readingCommit], nextCursor: null, hasMore: false } };
    },
    getFileRootGitHistoryCommitDetail: async () => {
      detailReads += 1;
      return { status: "ok" as const, commit: readingCommit, entries: [changedEntry("detail.ts")] };
    },
    getFileRootGitHistoryComparison: async () => {
      comparisonReads += 1;
      return { status: "ok" as const, comparison: fixedComparison, entries: [changedEntry("compared.ts")] };
    },
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "unused" }),
  };
  let root: Root | null = null;
  const onOpenDiff = async (request: FileRootGitHistoryDiffRequest) => { openedDiffs.push(request); return null; };
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    const render = async (refreshRevision: number) => {
      await act(async () => root?.render(React.createElement(FileRootGitHistoryPane, {
        api, sessionId: "session-1", enabled: true, rootsRevision: "roots-1", refreshRevision, onOpenDiff,
      })));
      await flush();
    };
    await render(0);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-commit-row")?.click());
    await flush();
    const detail = dom.window.document.querySelector<HTMLElement>(".file-history-detail");
    const file = dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row[title='detail.ts']");
    assert.ok(detail && file);
    await act(async () => file.click());
    await flush();
    detail.scrollTop = 120;
    file.focus();
    await render(1);
    assert.equal(dom.window.document.querySelector(".file-history-detail"), detail);
    assert.equal(detail.scrollTop, 120);
    assert.equal(dom.window.document.activeElement, file);
    assert.ok(file.classList.contains("is-selected"));
    assert.equal(detailReads, 1);
    assert.equal(pageReads, 1);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-back")?.click());
    await flush();
    assert.equal(pageReads, 2);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-compare-trigger")?.click());
    await flush();
    const pickerLabels = [...dom.window.document.querySelectorAll(".file-history-comparison-picker-trigger")].map((picker) => picker.textContent);
    await render(2);
    assert.deepEqual([...dom.window.document.querySelectorAll(".file-history-comparison-picker-trigger")].map((picker) => picker.textContent), pickerLabels);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".file-history-comparison-submit")?.click());
    await flush();
    const result = dom.window.document.querySelector<HTMLElement>(".file-history-comparison-result-header");
    assert.ok(result);
    await render(3);
    assert.equal(dom.window.document.querySelector(".file-history-comparison-result-header"), result);
    assert.equal(result.dataset.targetCommitId, fixedComparison.targetCommitId);
    assert.equal(comparisonReads, 1);
    assert.equal(pageReads, 2);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row[title='compared.ts']")?.click());
    await flush();
    const request = openedDiffs.at(-1);
    assert.ok(request && isFileRootGitHistoryComparisonDiffRequest(request));
    assert.deepEqual(request.comparison, fixedComparison);
  } finally {
    await act(async () => root?.unmount());
    restore();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Historyは既読page範囲をfresh cursorだけで一括更新し、途中page失敗では既読範囲を維持する"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "新しい先頭pageと古いoffset pageを混在させる、既読pageを捨てる、または更新失敗で部分結果を適用する"
// observable = "public page API cursor列、commit list DOM、scrollTopとfocus"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane loaded extent refresh"
// lifecycle = "permanent"
// impact = "追加commitのあるrepositoryでも読みかけの履歴範囲を失わず一貫した一覧を閲覧できる"
// distinction = "既存pagination testと異なり既読2pageのrefreshと2page目の失敗を扱い、旧offsetの混在を検出する"
// @end-test-value
test("History refreshは既読page範囲をatomicに置換し失敗時は保持する", async () => {
  const { dom, restore } = installDom();
  const cursors: Array<string | null> = [];
  let refreshRound = 0;
  const reading = commit("b", "reading older commit");
  const api = {
    listFileRootGitHistoryRepositories: async () => {
      refreshRound += 1;
      return { status: "ok" as const, repositories: [repositoryA] };
    },
    listFileRootGitHistoryCommits: async (request: FileRootGitHistoryCommitsRequest): Promise<FileRootGitHistoryCommitsResult> => {
      cursors.push(request.cursor ?? null);
      if (refreshRound === 3 && request.cursor !== null) {
        return { status: "failed", message: "second page unavailable" };
      }
      return request.cursor === null
        ? { status: "ok", page: { entries: refreshRound === 1
          ? [commit("a", "old prefix")]
          : [commit("c", "fresh prefix"), commit("a", "old prefix")], nextCursor: refreshRound === 1 ? "old-offset" : "fresh-offset", hasMore: true } }
        : { status: "ok", page: { entries: [reading], nextCursor: null, hasMore: false } };
    },
    getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "unused" }),
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "unused" }),
    getFileRootGitHistoryComparison: unusedHistoryComparison,
  };
  let root: Root | null = null;
  try {
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    const render = async (refreshRevision: number) => {
      const props: FileRootGitHistoryPaneProps = { api, sessionId: "session-1", enabled: true, rootsRevision: "roots-1", refreshRevision, onOpenDiff: async () => null };
      await act(async () => root?.render(React.createElement(FileRootGitHistoryPane, props)));
      await flush();
    };
    await render(0);
    await act(async () => TestIntersectionObserver.instances.at(-1)?.trigger(true));
    await flush();
    const list = dom.window.document.querySelector<HTMLElement>(".file-history-commit-list");
    assert.ok(list);
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      const rect = originalRect.call(this);
      if (this.classList.contains("file-history-commit-row")) {
        const index = [...list.querySelectorAll(".file-history-commit-row")].indexOf(this);
        const top = index * 30 - list.scrollTop;
        return { ...rect, top, bottom: top + 30 };
      }
      return rect;
    };
    list.scrollTop = 30;
    const readingRow = [...list.querySelectorAll<HTMLButtonElement>(".file-history-commit-row")].find((row) => row.textContent?.includes("reading older commit"));
    assert.ok(readingRow);
    readingRow.focus();
    await render(1);
    assert.deepEqual(cursors, [null, "old-offset", null, "fresh-offset"]);
    assert.equal(list.querySelectorAll(".file-history-commit-row").length, 3);
    assert.match(list.textContent ?? "", /fresh prefix/);
    assert.match(list.textContent ?? "", /reading older commit/);
    assert.equal(list.scrollTop, 60);
    assert.equal(dom.window.document.activeElement, readingRow);
    await render(2);
    assert.deepEqual(cursors.slice(-2), [null, "fresh-offset"]);
    assert.match(list.textContent ?? "", /second page unavailable/);
    assert.match(list.textContent ?? "", /fresh prefix/);
    assert.match(list.textContent ?? "", /reading older commit/);
    assert.equal(dom.window.document.activeElement, readingRow);
  } finally {
    await act(async () => root?.unmount());
    restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Historyは初回discoveryがrepositoryなし・branchなし・detachedでも、取得中の複数通知を後続discovery一回へ集約し、通知なしでは再取得しない"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "page取得を開始しない初回応答で通知を捨てる、通知数だけ再取得する、または通知がないのに再取得する"
// observable = "repositoryとcommit API呼出数、branch selectorの選択値、取得したcommit row"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane initial no-page refresh queue"
// lifecycle = "permanent"
// impact = "初回取得中のGit初期化やref更新を取りこぼさず、detached時の明示的なbranch選択も保つ"
// distinction = "既存のpage取得後のqueue testでは通らない三種類のno-page初回応答を遅延させ、通知の有無を比較する"
// @end-test-value
test("Historyはpageのない初回discovery中の通知を後続一回へ集約する", async () => {
  const initialRepositories: FileRootGitHistoryRepository[][] = [
    [],
    [{ ...repositoryA, branches: [], currentBranch: null, refs: [] }],
    [{ ...repositoryA, currentBranch: null }],
  ];
  for (const repositories of initialRepositories) {
    for (const notify of [false, true]) {
      const { dom, restore } = installDom();
      let repositoryReads = 0;
      let pageReads = 0;
      let resolveInitial: ((result: FileRootGitHistoryRepositoriesResult) => void) | undefined;
      const api = {
        listFileRootGitHistoryRepositories: async () => {
          repositoryReads += 1;
          return repositoryReads === 1
            ? new Promise<FileRootGitHistoryRepositoriesResult>((resolve) => { resolveInitial = resolve; })
            : { status: "ok" as const, repositories: [repositoryA] };
        },
        listFileRootGitHistoryCommits: async () => {
          pageReads += 1;
          return { status: "ok" as const, page: { entries: [commit("a", "latest discovered commit")], nextCursor: null, hasMore: false } };
        },
        getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "unused" }),
        getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "unused" }),
        getFileRootGitHistoryComparison: unusedHistoryComparison,
      };
      let root: Root | null = null;
      try {
        const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
        root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
        const render = async (refreshRevision: number) => {
          await act(async () => root?.render(React.createElement(FileRootGitHistoryPane, {
            api, sessionId: "session-1", enabled: true, rootsRevision: "roots-1", refreshRevision,
            onOpenDiff: async () => null,
          })));
          await flush();
        };
        await render(0);
        if (notify) {
          await render(1);
          await render(2);
        }
        assert.equal(repositoryReads, 1);
        assert.equal(pageReads, 0);
        assert.ok(resolveInitial);
        await act(async () => resolveInitial?.({ status: "ok", repositories }));
        await flush();
        assert.equal(repositoryReads, notify ? 2 : 1);
        if (!notify) {
          assert.equal(pageReads, 0);
          continue;
        }
        if (repositories.length > 0) {
          const branch = dom.window.document.querySelector<HTMLSelectElement>("select[aria-label='History branch']");
          assert.ok(branch);
          assert.equal(branch.value, "");
          assert.equal(pageReads, 0);
          await act(async () => {
            branch.value = "main";
            branch.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
          });
          await flush();
        }
        assert.equal(pageReads, 1);
        assert.match(dom.window.document.querySelector(".file-history-commit-row")?.textContent ?? "", /latest discovered commit/);
        assert.equal(repositoryReads, 2);
      } finally {
        await act(async () => root?.unmount());
        restore();
      }
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Historyの初回discovery中に通知があっても、非表示またはsession切替後の旧応答は後続取得を開始しない"
// oracle = { type = "contract", ref = "docs/features/git-history-and-commit-preview.md#Historyタブ" }
// fault = "旧ownerのtrailing通知を新ownerへ引き継ぐ、またはhiddenのまま後続discoveryを開始する"
// observable = "session別repository API呼出列とcommit API呼出数"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane initial no-page queue invalidation"
// lifecycle = "permanent"
// impact = "閲覧していないHistoryの不要取得と、別sessionへの旧通知の漏出を防ぐ"
// distinction = "初回pageなし応答を非表示・owner切替後まで保留し、非表示からの復帰だけが新取得を開始することを確認する"
// @end-test-value
test("Historyは初回pageなし応答後もhiddenと旧ownerの取得を止める", async () => {
  for (const changeOwner of [false, true]) {
    const { dom, restore } = installDom();
    const repositorySessions: string[] = [];
    const pending: Array<(result: FileRootGitHistoryRepositoriesResult) => void> = [];
    let pageReads = 0;
    const api = {
      listFileRootGitHistoryRepositories: async (request: { sessionId: string }) => {
        repositorySessions.push(request.sessionId);
        return new Promise<FileRootGitHistoryRepositoriesResult>((resolve) => pending.push(resolve));
      },
      listFileRootGitHistoryCommits: async () => {
        pageReads += 1;
        return { status: "ok" as const, page: { entries: [], nextCursor: null, hasMore: false } };
      },
      getFileRootGitHistoryCommitDetail: async () => ({ status: "commit-not-found" as const, message: "unused" }),
      getFileRootGitHistoryDiff: async () => ({ status: "not-changed" as const, message: "unused" }),
      getFileRootGitHistoryComparison: unusedHistoryComparison,
    };
    let root: Root | null = null;
    try {
      const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
      root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
      const render = async (sessionId: string, visible: boolean, refreshRevision: number) => {
        await act(async () => root?.render(React.createElement(FileRootGitHistoryPane, {
          api, sessionId, enabled: true, visible, rootsRevision: "roots-1", refreshRevision,
          onOpenDiff: async () => null,
        })));
        await flush();
      };
      await render("session-1", true, 0);
      await render("session-1", true, 1);
      await render(changeOwner ? "session-2" : "session-1", changeOwner, 1);
      assert.deepEqual(repositorySessions, changeOwner ? ["session-1", "session-2"] : ["session-1"]);
      await act(async () => pending[0]?.({ status: "ok", repositories: [] }));
      await flush();
      if (changeOwner) {
        await act(async () => pending[1]?.({ status: "ok", repositories: [] }));
        await flush();
        assert.deepEqual(repositorySessions, ["session-1", "session-2"]);
      } else {
        assert.deepEqual(repositorySessions, ["session-1"]);
        await render("session-1", true, 1);
        assert.deepEqual(repositorySessions, ["session-1", "session-1"]);
        await act(async () => pending[1]?.({ status: "ok", repositories: [] }));
        await flush();
        assert.equal(repositorySessions.length, 2);
      }
      assert.equal(pageReads, 0);
    } finally {
      await act(async () => root?.unmount());
      restore();
    }
  }
});
