import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { FileRootGitChangeEntry, FileRootGitChangeScope } from "../../src-shared/file-explorer/file-explorer-contract.js";

// @test-value v2
// kind = "contract"
// claim = "Changesとcommitの行一覧はviewportに限定して描画し、高さ0からの復帰とresizeで選択・折りたたみ・途中scroll・diff導線を維持する。同一データの再描画ではscope投影を走査し直さない"
// oracle = { type = "contract", ref = "accepted requirement: bounded Changes/History virtualization and state-preserving tab return; docs/design/desktop-ui.md Agent File Explorer" }
// fault = "高さ0で全件DOMを作る、復帰時に行が欠落する、scrollや選択を失う、またはloading/selection更新だけで全entriesを再走査する"
// observable = "DOM行数・位置、scrollTop、選択class、directory expanded、diff callback、entriesのscopes読み取り回数"
// observation_boundary = "component-behavior"
// scope = "FileRootChangesGroup: default Changes scopesとHistory commit scopes、0/360/180px viewport、Historyは親scrollと120pxのheader位置"
// lifecycle = "permanent"
// impact = "多数の変更を持つSessionで非表示タブのDOM/CPU負荷を抑えながら、表示復帰後の閲覧とdiff操作を保つ"
// distinction = "既存pane testの固定viewportでは計測0・表示復帰・同一データの再走査を検出できない。小さいJSDOM検証で継続する表示範囲と状態保持の契約を守る"
// @end-test-value
test("Changes group はviewportの復帰と状態保持をboundedな描画で行う", async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  let viewportHeight = 0;
  const observers = new Set<TestResizeObserver>();
  class TestResizeObserver {
    readonly elements = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(element: Element) { this.elements.add(element); }
    unobserve(element: Element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); observers.delete(this); }
    resize() {
      const entries = [...this.elements].map((target): ResizeObserverEntry => {
        const size = [{ inlineSize: 280, blockSize: (target as HTMLElement).offsetHeight }];
        return {
          target,
          borderBoxSize: size,
          contentBoxSize: size,
          devicePixelContentBoxSize: size,
          contentRect: target.getBoundingClientRect(),
        };
      });
      if (entries.length) this.callback(entries, this);
    }
  }
  Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  for (const property of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, property, {
      configurable: true,
      get() {
        if (viewportHeight === 0) return 0;
        if (this.classList.contains("history-scroll-viewport")) return viewportHeight;
        if (this.classList.contains("workspace-changes-list")) {
          return this.closest(".history-scroll-viewport") ? this.scrollHeight : viewportHeight;
        }
        return this.classList.contains("header") ? 31 : 30;
      },
    });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 280 });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const inner = (this as HTMLElement).querySelector<HTMLElement>(".workspace-changes-list-inner");
      return viewportHeight === 0 ? 0 : Number.parseFloat(inner?.style.height ?? "0")
        + (this.classList.contains("history-scroll-viewport") ? 120 : 0);
    },
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const container = this.closest<HTMLElement>(".history-scroll-viewport");
    const top = container && this.classList.contains("workspace-changes-list") ? 120 - container.scrollTop : 0;
    return { x: 0, y: top, top, bottom: top + this.offsetHeight, left: 0, right: 280, width: 280,
      height: this.offsetHeight, toJSON: () => ({}) };
  };
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options: ScrollToOptions | number = {}, y?: number) {
    this.scrollTop = typeof options === "number" ? y ?? 0 : options.top ?? this.scrollTop;
  };
  const { FileRootChangesGroup } = await import("../../src/file-explorer/FileRootChangesGroup.js");
  function HistoryViewport(props: React.ComponentProps<typeof FileRootChangesGroup>) {
    const [scrollContainer, setScrollContainer] = React.useState<HTMLDivElement | null>(null);
    return React.createElement("div", { className: "history-scroll-viewport", ref: setScrollContainer },
      React.createElement(FileRootChangesGroup, { ...props, scrollContainer }));
  }
  let root: Root | null = null;
  const resize = async (height: number) => {
    await act(async () => {
      viewportHeight = height;
      for (const observer of [...observers]) observer.resize();
      await Promise.resolve();
    });
  };
  try {
    root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
    for (const scope of ["working-tree", "commit"] as const) {
      viewportHeight = 0;
      let scopeReads = 0;
      const entries: FileRootGitChangeEntry[] = Array.from({ length: 1500 }, (_, index) => ({
        relativePath: `src/file-${String(index).padStart(4, "0")}.ts`,
        previousRelativePath: null,
        get scopes(): FileRootGitChangeScope[] { scopeReads += 1; return [scope]; },
        kinds: { [scope]: "modified" },
      }));
      const rootChange = {
        root: { id: "workspace", kind: "workspace" as const, label: "Workspace", displayPath: "C:/repo" },
        status: "success" as const,
        entries,
        message: "",
      };
      const opened: Array<{ relativePath: string; scope: FileRootGitChangeScope; openInWindow: boolean }> = [];
      let collapsedDirectories: Record<string, boolean> = {};
      let selectedEntryKey: string | null = null;
      let loadingKey = "";
      const historyScopes = [["commit", "Changed Files"]] as const;
      const render = () => {
        const groupProps: React.ComponentProps<typeof FileRootChangesGroup> & { key: string } = {
          key: scope,
          rootChange,
          groupCount: 1,
          sizing: scope === "commit" ? "content" : "bounded",
          collapsedDirectories,
          selectedEntryKey,
          loadingKey,
          ...(scope === "commit" ? { scopes: historyScopes } : {}),
          onToggleDirectory: (rootId, changeScope, relativePath) => {
            const key = `${rootId}\u0000${changeScope}\u0000${relativePath}`;
            collapsedDirectories = { ...collapsedDirectories, [key]: !collapsedDirectories[key] };
            render();
          },
          onOpenEntry: async (_rootId, entry, changeScope, openInWindow) => {
            opened.push({ relativePath: entry.relativePath, scope: changeScope, openInWindow });
            selectedEntryKey = `workspace:${changeScope}:${entry.relativePath}`;
            render();
          },
        };
        root!.render(React.createElement(scope === "commit" ? HistoryViewport : FileRootChangesGroup, groupProps));
      };
      const rows = () => [...dom.window.document.querySelectorAll<HTMLElement>(".workspace-change-virtual-row")];
      const firstEntry = () => dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row");
      await act(async () => render());
      assert.equal(rows().length, 0, "initial zero viewport must not mount all entries");
      await resize(360);
      assert.ok(rows().length > 0 && rows().length <= 50);
      assert.equal(firstEntry()?.title, "src/file-0000.ts", "initial unmeasured rows must recover");
      const list = dom.window.document.querySelector<HTMLElement>(scope === "commit" ? ".history-scroll-viewport" : ".workspace-changes-list")!;
      list.tabIndex = 0;
      list.focus();
      assert.equal(dom.window.document.activeElement, list);
      await act(async () => {
        dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-directory-row")!.click();
      });
      assert.equal(firstEntry(), null);
      await resize(0);
      await resize(360);
      const directory = dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-directory-row")!;
      assert.equal(directory.getAttribute("aria-expanded"), "false");
      await act(async () => directory.click());
      await act(async () => {
        list.scrollTop = 18000;
        list.dispatchEvent(new dom.window.Event("scroll"));
      });
      assert.ok(rows().length > 0 && rows().length <= 50);
      const target = firstEntry()!;
      const targetPath = target.title;
      assert.notEqual(targetPath, "src/file-0000.ts");
      const readsBeforeRerender = scopeReads;
      await act(async () => target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true })));
      assert.equal(scopeReads, readsBeforeRerender, "selection updates must reuse the scope projection");
      assert.deepEqual(opened, [{ relativePath: targetPath, scope, openInWindow: true }]);
      assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row.is-selected")?.title, targetPath);
      await act(async () => { loadingKey = `workspace:${scope}:${targetPath}`; render(); });
      assert.equal(scopeReads, readsBeforeRerender, "loading updates must reuse the scope projection");
      await resize(0);
      assert.equal(rows().length, 0);
      await act(async () => { loadingKey = ""; render(); });
      assert.equal(list.scrollTop, 18000, "hidden rerender must not clamp the retained scroll to zero");
      await resize(180);
      assert.equal(list.scrollTop, 18000);
      assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".workspace-change-row.is-selected")?.title, targetPath);
      assert.ok(rows().length > 0 && rows().length <= 40);
      const starts = rows().map((row) => Number(row.style.transform.match(/translateY\((.+)px\)/)?.[1]));
      assert.ok(starts.every((start, index) => index === 0 || start > starts[index - 1]!));
      await resize(360);
      assert.equal(list.scrollTop, 18000);
      assert.equal(scopeReads, readsBeforeRerender);
    }
  } finally {
    await act(async () => root?.unmount());
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
