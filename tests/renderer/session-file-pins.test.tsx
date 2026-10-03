import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionDirectoryEntry, SessionFilePin } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { SessionFileExplorerPane } from "../../src/file-explorer/SessionFileExplorerPane.js";

type PaneProps = Parameters<typeof SessionFileExplorerPane>[0];
const pin = (relativePath: string, kind: "file" | "directory" = "file"): SessionFilePin => ({
  rootKind: "workspace", rootPath: "C:\\workspace", rootId: "workspace", rootLabel: "Workspace", relativePath, kind, unavailableReason: null,
});
const entry = (relativePath: string, kind: "file" | "directory" = "file"): SessionDirectoryEntry => ({
  name: relativePath.split("/").at(-1)!, relativePath, kind, byteLength: 1, modifiedAt: null,
});

async function withPane(api: NonNullable<PaneProps["api"]>, run: (harness: {
  document: Document;
  render(sessionId: string): Promise<void>;
  click(label: string): Promise<void>;
  until(condition: () => boolean): Promise<void>;
  opened: string[];
}) => Promise<void>) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = this.classList.contains("session-file-explorer-body") ? 480
      : this.querySelector(".session-file-pinned-row") ? 58 : 31;
    return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: height, width: 320, height, toJSON: () => ({}) };
  };
  for (const field of ["clientHeight", "offsetHeight"]) Object.defineProperty(dom.window.HTMLElement.prototype, field, { configurable: true, get() { return this.getBoundingClientRect().height; } });
  for (const field of ["clientWidth", "offsetWidth"]) Object.defineProperty(dom.window.HTMLElement.prototype, field, { configurable: true, get() { return 320; } });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new dom.window.Event("scroll"));
  };
  const { SessionFileExplorerPane: Pane } = await import("../../src/file-explorer/SessionFileExplorerPane.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const opened: string[] = [];
  const render = async (sessionId: string) => {
    await act(async () => root.render(<Pane api={api} sessionId={sessionId} enabled rootsRevision={sessionId}
      selectedFile={null} activeTab="files" onActiveTabChange={() => {}} onRefreshChanges={() => {}}
      onOpenFile={(request) => opened.push(request.relativePath)} canInsertPathReference={false} onInsertPathReference={() => {}} />));
  };
  const until = async (condition: () => boolean) => {
    for (let count = 0; count < 200; count += 1) {
      if (condition()) return;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assert.fail("Timed out waiting for the Files pane.");
  };
  const click = async (label: string) => {
    const button = Array.from(dom.window.document.querySelectorAll("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent === label || item.querySelector(".session-file-tree-name")?.textContent === label);
    assert.ok(button, `Missing button: ${label}`);
    assert.equal(button.disabled, false, `Disabled button: ${label}`);
    await act(async () => button.click());
  };
  try { await render("session-a"); await run({ document: dom.window.document, render, click, until, opened }); }
  finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function baseApi(): NonNullable<PaneProps["api"]> {
  return {
    async listSessionFileRoots() { return [{ id: "workspace", kind: "workspace", label: "Workspace", displayPath: "C:\\workspace" }]; },
    async listSessionDirectory() { return []; },
    async showSessionFileTreeContextMenu() { return { status: "dismissed" }; },
    async listSessionFilePins() { return []; },
    async pinSessionFile(request) { return pin(request.relativePath); },
    async unpinSessionFile() {},
  };
}

// @test-value v2
// kind = "invariant"
// claim = "FilesはPinを兄弟の第一ソート条件とし、閉じた祖先のPinも本文やdirectoryの追加取得なしで一覧から開ける"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer Pin" }
// fault = "folder優先がPinより上位になる、同条件の順序を崩す、または未展開のPinを一覧から欠落させる"
// observable = "描画されたtree rowの順序、Pinned Onlyの行とpressed state、open callback、directory取得回数"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane Pin sorting and filtering"
// lifecycle = "permanent"
// @end-test-value
test("Pin優先と深いPin一覧はdirectoryの追加取得なしで切り替わる", async () => {
  const api = baseApi();
  let reads = 0;
  api.listSessionFilePins = async () => [pin("z.txt"), pin("closed/deep/note.md")];
  api.listSessionDirectory = async () => { reads += 1; return [entry("a-folder", "directory"), entry("b-folder", "directory"), entry("a.txt"), entry("z.txt")]; };
  await withPane(api, async ({ document, click, until, opened }) => {
    await click("Workspace");
    await until(() => document.querySelectorAll(".session-file-tree-row").length === 4);
    assert.deepEqual(Array.from(document.querySelectorAll(".session-file-tree-row")).map((row) => row.textContent), ["·z.txt", "▸a-folder", "▸b-folder", "·a.txt"]);
    await click("Pinned only");
    await until(() => document.querySelectorAll(".session-file-pinned-row").length === 2);
    assert.equal(document.querySelector("[aria-label='Pinned only']")?.getAttribute("aria-pressed"), "true");
    await click("Workspace: closed/deep/note.md");
    assert.deepEqual(opened, ["closed/deep/note.md"]);
    assert.equal(reads, 1);
    await click("Pinned only");
    assert.equal(reads, 1);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Pin保存失敗は既存Pinを残してerrorとRetryを表示し、取得成功後だけ解除を再開して最後の解除ではfilterへfocusを戻す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer Pin" }
// fault = "失敗した解除を成功として行を消す、利用不可Pinを解除できない、または最後の解除でfocusが失われる"
// observable = "alert、Pin行、Unpin button状態、解除request、最後のdocument.activeElement"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane Pin failure recovery and unpin"
// lifecycle = "permanent"
// @end-test-value
test("利用不可Pinの解除失敗を保持し再取得後に解除できる", async () => {
  const api = baseApi();
  let pins = [{ ...pin("deleted.md"), rootId: null, unavailableReason: "The file root is not available." }];
  let fail = true;
  api.listSessionFilePins = async () => pins;
  api.unpinSessionFile = async (request) => {
    assert.equal(request.relativePath, "deleted.md");
    if (fail) throw new Error("Pin save failed.");
    pins = [];
  };
  await withPane(api, async ({ document, click, until }) => {
    await click("Pinned only");
    await until(() => document.querySelectorAll(".session-file-pinned-row").length === 1);
    assert.equal(document.querySelector<HTMLButtonElement>(".session-file-pinned-row")?.disabled, true);
    await click("Unpin deleted.md");
    assert.match(document.querySelector("[role='alert']")?.textContent ?? "", /Pin save failed/);
    assert.equal(document.querySelectorAll(".session-file-pinned-row").length, 1);
    assert.equal(document.querySelector<HTMLButtonElement>("[aria-label='Unpin deleted.md']")?.disabled, true);
    fail = false;
    await click("Retry Pins");
    await click("Unpin deleted.md");
    await until(() => document.activeElement?.getAttribute("aria-label") === "Pinned only");
    assert.equal(document.querySelectorAll(".session-file-pinned-row").length, 0);
    assert.equal(document.querySelector("[role='alert']"), null);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "仮想化されたPin一覧の中間解除後は次のPin、末尾解除後は直前のPinへfocusを保ち連続操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer Pinのkeyboard操作" }
// fault = "一覧全体の行indexと描画範囲内のindexを混同し、解除後のfocusを離れたPinやfilterへ移す"
// observable = "中間と末尾の解除後のdocument.activeElementのaccessible nameと解除対象の消失"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane virtualized Pin list focus"
// lifecycle = "permanent"
// impact = "多数Pinをkeyboardで連続解除するときの操作位置を維持する"
// distinction = "少数Pinのempty確認や型検査では観測できない、scroll途中の仮想化とfocusの連携を確認する"
// @end-test-value
test("仮想Pin一覧の中間と末尾を解除して隣接Pinへfocusを保つ", async () => {
  const api = baseApi();
  let pins = Array.from({ length: 180 }, (_, index) => pin(`file-${index}.md`));
  api.listSessionFilePins = async () => pins;
  api.unpinSessionFile = async (request) => { pins = pins.filter((item) => item.relativePath !== request.relativePath); };
  await withPane(api, async ({ document, click, until }) => {
    await click("Pinned only");
    await until(() => !!document.querySelector("[aria-label='Unpin file-0.md']"));
    const scroll = document.querySelector<HTMLDivElement>(".session-file-explorer-body")!;
    await act(async () => scroll.scrollTo({ top: 58 * 100 }));
    await until(() => !!document.querySelector("[aria-label='Unpin file-100.md']"));
    assert.equal(document.querySelector("[aria-label='Unpin file-0.md']"), null);
    assert.ok(document.querySelectorAll(".session-file-pinned-row").length < pins.length);
    for (const index of [100, 101]) {
      await click(`Unpin file-${index}.md`);
      await until(() => document.activeElement?.getAttribute("aria-label") === `Unpin file-${index + 1}.md`);
      assert.equal(document.querySelector(`[aria-label='Unpin file-${index}.md']`), null);
    }
    await act(async () => scroll.scrollTo({ top: 58 * pins.length - 480 }));
    await until(() => !!document.querySelector("[aria-label='Unpin file-179.md']"));
    await click("Unpin file-179.md");
    await until(() => document.activeElement?.getAttribute("aria-label") === "Unpin file-178.md");
    assert.equal(document.querySelector("[aria-label='Unpin file-179.md']"), null);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "旧Sessionで開始したPin取得と保存の遅延応答は現在表示中の別SessionのPin状態を書き換えない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer Pin" }
// fault = "Session切替後の遅いlistまたはpin成功を現Sessionへ適用する"
// observable = "切替前後のPinned Only行のpathとPin API requestのsession ID"
// observation_boundary = "component-behavior"
// scope = "useSessionFilePins asynchronous owner boundary"
// lifecycle = "permanent"
// @end-test-value
test("遅いPin取得と保存を別Sessionに表示しない", async () => {
  const api = baseApi();
  let finishList!: (pins: SessionFilePin[]) => void;
  let finishSave!: (pin: SessionFilePin) => void;
  const delayed = new Promise<SessionFilePin[]>((resolve) => { finishList = resolve; });
  api.listSessionFilePins = (sessionId) => sessionId === "session-a" ? delayed : Promise.resolve([pin(`${sessionId}.md`)]);
  api.listSessionDirectory = async () => [entry("new.md")];
  api.pinSessionFile = async (request) => {
    assert.equal(request.sessionId, "session-b");
    return new Promise<SessionFilePin>((resolve) => { finishSave = resolve; });
  };
  await withPane(api, async ({ document, render, click, until }) => {
    await render("session-b");
    await act(async () => finishList([pin("session-a.md")]));
    await click("Pinned only");
    await until(() => document.querySelectorAll(".session-file-pinned-row").length === 1);
    assert.match(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /session-b.md/);
    await click("Pinned only");
    await click("Workspace");
    await until(() => !!document.querySelector("[aria-label='Pin new.md']"));
    await click("Pin new.md");
    await render("session-c");
    await act(async () => finishSave(pin("new.md")));
    await click("Pinned only");
    await until(() => document.querySelectorAll(".session-file-pinned-row").length === 1);
    assert.match(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /session-c.md/);
  });
});
