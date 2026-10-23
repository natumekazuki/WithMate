import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import type { FileRootGitHistoryPaneProps } from "../../src/file-explorer/FileRootGitHistoryPane.js";

// @test-value v2
// kind = "contract"
// claim = "History Compareの検索0件でも同じFilterとfocusを保持し、検索語解除で取得済み比較を再取得せず閲覧できる"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "検索0件でFilterをunmountする、入力のfocusを失う、または再比較しないと検索語を解除できない"
// observable = "FilterのDOM同一性・値・focus、結果件数、空のfile本文、comparison API呼出し数、正常0件時のFilterとOpen All Changes操作可否"
// observation_boundary = "component-behavior"
// scope = "FileRootGitHistoryPane comparison filtering"
// lifecycle = "permanent"
// impact = "一致しない検索語を入力した利用者がその場で検索を解除し比較結果へ戻れる"
// distinction = "既存比較testはref選択とdiff callbackが対象であり、実入力による0件往復とfocus保持は型検査や静的markupでは検出できない"
// @end-test-value
test("History Compareは検索0件でもFilterを保持して検索を解除できる", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "Element", { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", { value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true });
  let root: Root | null = null;
  let comparisonCalls = 0;
  let emptyComparison = false;
  const api: NonNullable<FileRootGitHistoryPaneProps["api"]> = {
    listFileRootGitHistoryRepositories: async () => ({ status: "ok", repositories: [{
      repositoryId: "repo", rootId: "workspace", label: "Example", displayPath: "/example",
      currentBranch: "feature", branches: ["main", "feature"],
      refs: [{ kind: "branch", name: "main" }, { kind: "branch", name: "feature" }],
    }] }),
    listFileRootGitHistoryCommits: async () => ({ status: "ok", page: { entries: [], nextCursor: null, hasMore: false } }),
    getFileRootGitHistoryCommitDetail: async () => ({ status: "failed", message: "Unused" }),
    getFileRootGitHistoryDiff: async () => ({ status: "not-changed", message: "Unused" }),
    getFileRootGitHistoryComparison: async () => {
      comparisonCalls += 1;
      return {
        status: "ok",
        comparison: { mode: "direct", base: { kind: "branch", name: "main" }, target: { kind: "branch", name: "feature" }, baseCommitId: "a".repeat(40), targetCommitId: "b".repeat(40), mergeBaseCommitId: null },
        entries: emptyComparison ? [] : [{ relativePath: "example.ts", previousRelativePath: null, kinds: { commit: "modified" }, scopes: ["commit"] }],
      };
    },
  };
  try {
    const { createRoot } = await import("react-dom/client");
    const { FileRootGitHistoryPane } = await import("../../src/file-explorer/FileRootGitHistoryPane.js");
    const container = dom.window.document.getElementById("root")!;
    await act(async () => {
      root = createRoot(container);
      root.render(<FileRootGitHistoryPane api={api} sessionId="session" enabled rootsRevision="roots" refreshRevision={0} onOpenDiff={async () => null} />);
    });
    const trigger = container.querySelector<HTMLButtonElement>(".file-history-compare-trigger");
    assert.ok(trigger);
    await act(async () => trigger.click());
    const submit = container.querySelector<HTMLButtonElement>(".file-history-comparison-submit");
    assert.ok(submit);
    assert.equal(submit.disabled, false);
    await act(async () => submit.click());
    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter changed files"]');
    assert.ok(filter);
    assert.equal(comparisonCalls, 1);
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => filter.focus());
    await act(async () => {
      setValue.call(filter, "no-such-file");
      filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(container.querySelector(".file-history-comparison-result-header")?.textContent ?? "", /0 Matching Files/);
    assert.equal(container.querySelector('input[aria-label="Filter changed files"]'), filter);
    assert.equal(dom.window.document.activeElement, filter);
    assert.equal(filter.value, "no-such-file");
    assert.equal(container.querySelector(".file-history-changed-files")?.textContent, "");
    await act(async () => {
      setValue.call(filter, "");
      filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(container.querySelector(".file-history-comparison-result-header")?.textContent ?? "", /1 Changed Files/);
    assert.equal(dom.window.document.activeElement, filter);
    assert.equal(comparisonCalls, 1);
    const openAll = container.querySelector<HTMLButtonElement>(".file-history-comparison-result-actions button");
    assert.ok(openAll);
    assert.equal(openAll.disabled, false);
    emptyComparison = true;
    await act(async () => submit.click());
    assert.match(container.querySelector(".file-history-comparison-result-header")?.textContent ?? "", /0 Changed Files/);
    assert.ok(container.querySelector('input[aria-label="Filter changed files"]'));
    assert.equal(container.querySelector<HTMLButtonElement>(".file-history-comparison-result-actions button")?.disabled, true);
  } finally {
    if (root) await act(async () => root?.unmount());
    for (const [name, value] of Object.entries(previous)) Object.defineProperty(globalThis, name, { value, configurable: true });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousAct;
    dom.window.close();
  }
});
