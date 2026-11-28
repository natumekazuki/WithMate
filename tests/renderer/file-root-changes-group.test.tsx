import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  FileRootGitChangeEntry,
  FileRootGitChangeScope,
} from "../../src-shared/file-explorer/file-explorer-contract.js";

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
/** ChangesとHistory双方で高さ0から復帰しても描画はビューポート内に限り、折りたたみ・選択・スクロールとdiff導線を維持する。同じ変更データは選択・読込だけの更新で再走査しない。 */
test("Changes group はviewportの復帰と状態保持をboundedな描画で行う", async () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { pretendToBeVisual: true },
  );
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
  /** JSDOMでは得られないサイズ通知を、テストで制御するビューポート寸法から配信する。 */
  class TestResizeObserver {
    readonly elements = new Set<Element>();
    /** 新しい監視インスタンスを寸法変更の通知先へ追加する。 */
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    /** サイズ変更の対象として要素を登録する。 */
    observe(element: Element) {
      this.elements.add(element);
    }
    /** 個別の要素へのサイズ通知を止める。 */
    unobserve(element: Element) {
      this.elements.delete(element);
    }
    /** すべての監視要素を解放し、このインスタンスへの通知も止める。 */
    disconnect() {
      this.elements.clear();
      observers.delete(this);
    }
    /** 登録済み要素の現在の寸法を組み立て、まとめてコールバックへ通知する。 */
    resize() {
      const entries = [...this.elements].map((target): ResizeObserverEntry => {
        const size = [
          { inlineSize: 280, blockSize: (target as HTMLElement).offsetHeight },
        ];
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
  Object.defineProperty(dom.window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  for (const property of ["offsetHeight", "clientHeight"]) {
    Object.defineProperty(dom.window.HTMLElement.prototype, property, {
      configurable: true,
      /** 一覧の固定行高と、Changes自身またはHistory親のビューポート高を返す。 */
      get() {
        if (viewportHeight === 0) return 0;
        if (this.classList.contains("history-scroll-viewport"))
          return viewportHeight;
        if (this.classList.contains("workspace-changes-list")) {
          return this.closest(".history-scroll-viewport")
            ? this.scrollHeight
            : viewportHeight;
        }
        return this.classList.contains("header") ? 31 : 30;
      },
    });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    /** 幅を280pxに固定し、高さ変更だけを比較する。 */ get: () => 280,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    /** 仮想一覧の全高とHistoryの先頭余白をスクロール寸法に反映する。 */
    get() {
      const inner = (this as HTMLElement).querySelector<HTMLElement>(
        ".workspace-changes-list-inner",
      );
      return viewportHeight === 0
        ? 0
        : Number.parseFloat(inner?.style.height ?? "0") +
            (this.classList.contains("history-scroll-viewport") ? 120 : 0);
    },
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      const container = this.closest<HTMLElement>(".history-scroll-viewport");
      const top =
        container && this.classList.contains("workspace-changes-list")
          ? 120 - container.scrollTop
          : 0;
      return {
        x: 0,
        y: top,
        top,
        bottom: top + this.offsetHeight,
        left: 0,
        right: 280,
        width: 280,
        height: this.offsetHeight,
        /** 座標として使うため、JSON化に追加情報は持たせない。 */ toJSON:
          () => ({}),
      };
    };
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(
    options: ScrollToOptions | number = {},
    y?: number,
  ) {
    this.scrollTop =
      typeof options === "number" ? (y ?? 0) : (options.top ?? this.scrollTop);
  };
  const { FileRootChangesGroup } =
    await import("../../src/file-explorer/FileRootChangesGroup.js");
  /** Historyの変更一覧を親スクロール領域内に描画し、実際に親を監視する経路を通す。 */
  function HistoryViewport(
    props: React.ComponentProps<typeof FileRootChangesGroup>,
  ) {
    const [scrollContainer, setScrollContainer] =
      React.useState<HTMLDivElement | null>(null);
    return React.createElement(
      "div",
      { className: "history-scroll-viewport", ref: setScrollContainer },
      React.createElement(FileRootChangesGroup, { ...props, scrollContainer }),
    );
  }
  let root: Root | null = null;
  /** ビューポート高を変え、React更新内で全監視インスタンスへ通知する。 */
  const resize = async (height: number) => {
    await act(async () => {
      viewportHeight = height;
      for (const observer of [...observers]) observer.resize();
      await Promise.resolve();
    });
  };
  try {
    root = createRoot(
      dom.window.document.getElementById("root") as HTMLElement,
    );
    for (const scope of ["working-tree", "commit"] as const) {
      viewportHeight = 0;
      let scopeReads = 0;
      const entries: FileRootGitChangeEntry[] = Array.from(
        { length: 1500 },
        (_, index) => ({
          relativePath: `src/file-${String(index).padStart(4, "0")}.ts`,
          previousRelativePath: null,
          /** scope投影で参照された回数を記録し、変更データを再走査したかを判定できるようにする。 */
          get scopes(): FileRootGitChangeScope[] {
            scopeReads += 1;
            return [scope];
          },
          kinds: { [scope]: "modified" },
        }),
      );
      const rootChange = {
        root: {
          id: "workspace",
          kind: "workspace" as const,
          label: "Workspace",
          displayPath: "C:/repo",
        },
        status: "success" as const,
        entries,
        message: "",
      };
      const opened: Array<{
        relativePath: string;
        scope: FileRootGitChangeScope;
        openInWindow: boolean;
      }> = [];
      let collapsedDirectories: Record<string, boolean> = {};
      let selectedEntryKey: string | null = null;
      let loadingKey = "";
      const historyScopes = [["commit", "Changed Files"]] as const;
      /** 同じ変更データを保って操作後の状態だけを渡し、ChangesとHistoryで適切なスクロール所有者を選ぶ。 */
      const render = () => {
        const groupProps: React.ComponentProps<typeof FileRootChangesGroup> & {
          key: string;
        } = {
          key: scope,
          rootChange,
          groupCount: 1,
          sizing: scope === "commit" ? "content" : "bounded",
          collapsedDirectories,
          selectedEntryKey,
          loadingKey,
          ...(scope === "commit" ? { scopes: historyScopes } : {}),
          /** 対象ルート・scope・パスの組み合わせで開閉状態を切り替え、同じ一覧を更新する。 */
          onToggleDirectory: (rootId, changeScope, relativePath) => {
            const key = `${rootId}\u0000${changeScope}\u0000${relativePath}`;
            collapsedDirectories = {
              ...collapsedDirectories,
              [key]: !collapsedDirectories[key],
            };
            render();
          },
          /** diffを開く要求の対象と開き方を記録し、選択状態を反映する。 */
          onOpenEntry: async (_rootId, entry, changeScope, openInWindow) => {
            opened.push({
              relativePath: entry.relativePath,
              scope: changeScope,
              openInWindow,
            });
            selectedEntryKey = `workspace:${changeScope}:${entry.relativePath}`;
            render();
          },
        };
        root!.render(
          React.createElement(
            scope === "commit" ? HistoryViewport : FileRootChangesGroup,
            groupProps,
          ),
        );
      };
      /** 今ビューポートに生成されている仮想行だけをDOMから集める。 */
      const rows = () => [
        ...dom.window.document.querySelectorAll<HTMLElement>(
          ".workspace-change-virtual-row",
        ),
      ];
      /** フォルダー行ではなく最初に表示された変更ファイルのボタンを取得する。 */
      const firstEntry = () =>
        dom.window.document.querySelector<HTMLButtonElement>(
          ".workspace-change-row",
        );
      await act(async () => render());
      assert.equal(
        rows().length,
        0,
        "initial zero viewport must not mount all entries",
      );
      await resize(360);
      assert.ok(rows().length > 0 && rows().length <= 50);
      assert.equal(
        firstEntry()?.title,
        "src/file-0000.ts",
        "initial unmeasured rows must recover",
      );
      const list = dom.window.document.querySelector<HTMLElement>(
        scope === "commit"
          ? ".history-scroll-viewport"
          : ".workspace-changes-list",
      )!;
      list.tabIndex = 0;
      list.focus();
      assert.equal(dom.window.document.activeElement, list);
      await act(async () => {
        dom.window.document
          .querySelector<HTMLButtonElement>(".workspace-change-directory-row")!
          .click();
      });
      assert.equal(firstEntry(), null);
      await resize(0);
      await resize(360);
      const directory = dom.window.document.querySelector<HTMLButtonElement>(
        ".workspace-change-directory-row",
      )!;
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
      await act(async () =>
        target.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }),
        ),
      );
      assert.equal(
        scopeReads,
        readsBeforeRerender,
        "selection updates must reuse the scope projection",
      );
      assert.deepEqual(opened, [
        { relativePath: targetPath, scope, openInWindow: true },
      ]);
      assert.equal(
        dom.window.document.querySelector<HTMLButtonElement>(
          ".workspace-change-row.is-selected",
        )?.title,
        targetPath,
      );
      await act(async () => {
        loadingKey = `workspace:${scope}:${targetPath}`;
        render();
      });
      assert.equal(
        scopeReads,
        readsBeforeRerender,
        "loading updates must reuse the scope projection",
      );
      await resize(0);
      assert.equal(rows().length, 0);
      await act(async () => {
        loadingKey = "";
        render();
      });
      assert.equal(
        list.scrollTop,
        18000,
        "hidden rerender must not clamp the retained scroll to zero",
      );
      await resize(180);
      assert.equal(list.scrollTop, 18000);
      assert.equal(
        dom.window.document.querySelector<HTMLButtonElement>(
          ".workspace-change-row.is-selected",
        )?.title,
        targetPath,
      );
      assert.ok(rows().length > 0 && rows().length <= 40);
      const starts = rows().map((row) =>
        Number(row.style.transform.match(/translateY\((.+)px\)/)?.[1]),
      );
      assert.ok(
        starts.every(
          (start, index) => index === 0 || start > starts[index - 1]!,
        ),
      );
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
