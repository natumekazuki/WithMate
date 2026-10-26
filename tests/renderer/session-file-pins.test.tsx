import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionDirectoryEntry, SessionFilePin } from "../../src-shared/file-explorer/file-explorer-contract.js";
import type { SessionFileExplorerPane } from "../../src/file-explorer/SessionFileExplorerPane.js";

type PaneProps = Parameters<typeof SessionFileExplorerPane>[0];
type RefreshOptions = Pick<PaneProps, "visible" | "refreshRevision"> & { activeTab?: PaneProps["activeTab"] };
const pin = (relativePath: string, kind: "file" | "directory" = "file"): SessionFilePin => ({
  rootKind: "workspace", rootPath: "C:\\workspace", rootId: "workspace", rootLabel: "Workspace", relativePath, kind, unavailableReason: null,
});
const entry = (relativePath: string, kind: "file" | "directory" = "file"): SessionDirectoryEntry => ({
  name: relativePath.split("/").at(-1)!, relativePath, kind, byteLength: 1, modifiedAt: null,
});

async function withPane(api: NonNullable<PaneProps["api"]>, run: (harness: {
  document: Document;
  render(sessionId: string, rootsRevision?: string, options?: RefreshOptions): Promise<void>;
  click(label: string): Promise<void>;
  until(condition: () => boolean): Promise<void>;
  opened: string[];
}) => Promise<void>, initialOptions: RefreshOptions = {}) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
  Object.defineProperty(dom.window, "ResizeObserver", { value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } });
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", { configurable: true, get() {
    return Math.max(this.clientHeight, Number.parseFloat(this.querySelector(".session-file-tree-virtual")?.style.height ?? "0"));
  } });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new dom.window.Event("scroll"));
  };
  const { SessionFileExplorerPane: Pane } = await import("../../src/file-explorer/SessionFileExplorerPane.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const opened: string[] = [];
  const render = async (sessionId: string, rootsRevision = sessionId, options: RefreshOptions = {}) => {
    await act(async () => root.render(<Pane api={api} sessionId={sessionId} enabled rootsRevision={rootsRevision}
      selectedFile={null} activeTab="files" onActiveTabChange={() => {}} onRefreshChanges={() => {}}
      onOpenFile={(request) => opened.push(request.relativePath)} canInsertPathReference={false} onInsertPathReference={() => {}} {...options} />));
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
  try { await render("session-a", "session-a", initialOptions); await run({ document: dom.window.document, render, click, until, opened }); }
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
// kind = "contract"
// claim = "Filesは表示時に最新の展開済み階層を取得し、更新中と失敗時に読む位置と内容を保ち、削除された子孫を除去する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Files更新時の取得対象・閲覧状態保持・失敗と削除" }
// fault = "更新でtreeを初期化する、読込失敗を空にする、削除directoryのcacheを復活させる、または未展開directoryまで走査する"
// observable = "tree行、focus対象、scrollTop、directory取得path、errorと再試行後の内容"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane event refresh"
// lifecycle = "permanent"
// impact = "外部変更を反映しつつ閲覧中のファイル階層とkeyboard操作を継続する"
// distinction = "単発のdirectory展開やPin操作では検出できない更新・削除・失敗の連携を検証する"
// @end-test-value
test("Filesの更新は展開と読む位置を保ち削除と取得失敗を区別する", async () => {
  const api = baseApi();
  let phase = 0;
  const reads: string[] = [];
  api.listSessionDirectory = async ({ relativePath }) => {
    reads.push(relativePath);
    if (phase === 2) throw new Error("Refresh failed.");
    if (!relativePath) return [entry("closed", "directory"), ...(phase === 3 ? [] : [entry("folder", "directory")]), ...Array.from({ length: 30 }, (_, index) => entry(`file-${index}.txt`))];
    return [entry(`folder/${phase ? "latest" : "original"}.txt`)];
  };
  await withPane(api, async ({ document, render, click, until }) => {
    await click("Workspace");
    await click("folder");
    await until(() => !!document.querySelector("[title='folder/original.txt']"));
    const folder = document.querySelector<HTMLButtonElement>("[title='folder']")!;
    folder.focus();
    const scroller = document.querySelector<HTMLDivElement>(".session-file-explorer-body")!;
    await act(async () => scroller.scrollTo({ top: 31 }));
    phase = 1;
    await render("session-a", "session-a", { refreshRevision: 1 });
    await until(() => !!document.querySelector("[title='folder/latest.txt']"));
    assert.equal(document.activeElement, folder);
    assert.equal(scroller.scrollTop, 31);
    assert.deepEqual(reads, ["", "folder", "", "folder"]);
    phase = 2;
    await render("session-a", "session-a", { refreshRevision: 2 });
    await until(() => !!document.querySelector("[role='alert']"));
    await click("Files Error Details");
    assert.equal(document.querySelector("[role='dialog'] p")?.textContent, "Refresh failed.");
    assert.ok(document.querySelector("[title='folder/latest.txt']"));
    phase = 3;
    await click("Retry Files");
    await until(() => !document.querySelector("[title='folder']"));
    assert.equal(document.querySelector("[title='folder/latest.txt']"), null);
    assert.equal(reads.at(-1), "");
    assert.equal(reads.includes("closed"), false);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Filesのrootsとdirectory更新後もPin操作のfocusを保持し、更新待ちに利用者が移したfocusを奪わない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Filesの同一owner／root更新とPin keyboard操作" }
// fault = "同じ行のPin buttonから展開buttonへfocusを移す、または更新応答で別controlからfocusを奪う"
// observable = "roots・directory応答後のactiveElement identity、focus中buttonからのPin保存、展開中の子行と外部controlのfocus"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane refresh control focus"
// lifecycle = "permanent"
// impact = "更新後のkeyboard操作が意図したPinを変更し、誤ってdirectory開閉やpreviewを実行しない"
// distinction = "既存の行先頭buttonのfocus確認では区別できない、同じ行の複数controlと遅延応答を検証する"
// @end-test-value
test("Filesの更新はPin controlのfocusと利用者のfocus移動を保つ", async () => {
  const api = baseApi();
  let pins: SessionFilePin[] = [];
  const saved: string[] = [];
  let refreshing = false;
  let finishDirectory: ((entries: SessionDirectoryEntry[]) => void) | undefined;
  api.listSessionFilePins = async () => pins;
  api.pinSessionFile = async (request) => {
    saved.push(request.relativePath);
    const result = pin(request.relativePath, "directory");
    pins = [result];
    return result;
  };
  api.listSessionDirectory = async ({ relativePath }) => {
    if (!relativePath && refreshing) return new Promise((resolve) => { finishDirectory = resolve; });
    return relativePath ? [entry("folder/child.txt")] : [entry("folder", "directory")];
  };
  await withPane(api, async ({ document, render, click, until, opened }) => {
    await click("Workspace");
    await click("folder");
    const pinButton = document.querySelector<HTMLButtonElement>("[aria-label='Pin folder']")!;
    pinButton.focus();
    refreshing = true;
    await render("session-a", "session-a", { refreshRevision: 1 });
    await until(() => !!finishDirectory);
    assert.equal(document.activeElement, pinButton, "roots応答でもPin controlを維持する");
    await act(async () => finishDirectory?.([entry("folder", "directory"), entry("new.txt")]));
    await until(() => !!document.querySelector("[title='new.txt']"));
    assert.equal(document.activeElement, pinButton, "directory応答でもPin controlを維持する");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    assert.deepEqual(saved, ["folder"]);
    assert.deepEqual(opened, []);
    assert.ok(document.querySelector("[title='folder/child.txt']"), "Pin操作でdirectoryを閉じない");
    assert.equal(pinButton.getAttribute("aria-label"), "Unpin folder");
    pinButton.focus();
    finishDirectory = undefined;
    await render("session-a", "session-a", { refreshRevision: 2 });
    await until(() => !!finishDirectory);
    assert.equal(document.activeElement, pinButton, "Unpin controlもroots応答で維持する");
    const filter = document.querySelector<HTMLButtonElement>("[aria-label='Pinned only']")!;
    filter.focus();
    await act(async () => finishDirectory?.([entry("folder", "directory"), entry("latest.txt")]));
    await until(() => !!document.querySelector("[title='latest.txt']"));
    assert.equal(document.activeElement, filter, "待機中に移したfocusを奪わない");
  });
});

// @test-value v2
// kind = "contract"
// claim = "多数の前方追加を伴うFiles更新は閲覧位置と行またはPinのfocusを保持し、削除やowner切替では古いfocusを引き継がない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Filesの同一owner／root更新時のfocus・scroll保持とowner境界" }
// fault = "仮想範囲の移動時にfocus中のcontrolをunmountする、または削除行や旧ownerのfocusを同名の別対象へ移す"
// observable = "更新前後のactiveElement identityとscrollTop、削除とowner変更後のfocus、focusされたcontrolのopen／Pin保存結果"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane virtualized refresh focus"
// lifecycle = "permanent"
// impact = "自動更新だけでkeyboard操作の起点を失ったり別Sessionの対象を操作したりすることを防ぐ"
// distinction = "少数行のfocus確認では通らないoverscanを超える前方追加を、実際の仮想化と二種類のcontrolで確認する"
// @end-test-value
test("Filesの多数前方追加で行とPinのfocusを保持し削除とowner切替では引き継がない", async () => {
  for (const control of ["file", "pin"] as const) {
    const api = baseApi();
    const original = Array.from({ length: 500 }, (_, index) => entry(`file-${String(index).padStart(4, "0")}.txt`));
    const target = "file-0200.txt";
    let entries = original;
    const saved: string[] = [];
    api.listSessionDirectory = async () => entries;
    api.pinSessionFile = async (request) => { saved.push(request.relativePath); return pin(request.relativePath); };
    await withPane(api, async ({ document, render, click, until, opened }) => {
      await click("Workspace");
      const scroller = document.querySelector<HTMLDivElement>(".session-file-explorer-body")!;
      await act(async () => scroller.scrollTo({ top: 6200 }));
      const selector = control === "pin" ? `[aria-label='Pin ${target}']` : `[title='${target}']`;
      await until(() => !!document.querySelector(selector));
      const focused = document.querySelector<HTMLButtonElement>(selector)!;
      focused.focus();
      entries = [...Array.from({ length: 70 }, (_, index) => entry(`added-${index}.txt`)), ...original];
      await render("session-a", "session-a", { refreshRevision: 1 });
      assert.equal(scroller.scrollTop, 6200 + 70 * 31, "前方追加分だけ閲覧位置を補正する");
      assert.equal(document.activeElement, focused, "仮想範囲の再描画を待つ間も同じcontrolを保持する");
      await act(async () => scroller.scrollTo({ top: scroller.scrollTop }));
      assert.equal(document.activeElement, focused, "補正後の仮想範囲でもfocusを保持する");
      assert.ok(document.querySelectorAll(".session-file-tree-row").length < 100, "全件描画へ切り替えない");
      await act(async () => focused.click());
      assert.deepEqual(opened, control === "file" ? [target] : []);
      assert.deepEqual(saved, control === "pin" ? [target] : []);

      entries = entries.filter((item) => item.relativePath !== target);
      await render("session-a", "session-a", { refreshRevision: 2 });
      assert.equal(focused.isConnected, false);
      assert.equal(document.activeElement, document.body, "削除行のfocusを隣の対象へ移さない");
      entries = original;
      await render("session-a", "session-a", { refreshRevision: 3 });
      await act(async () => scroller.scrollTo({ top: 6200 }));
      await until(() => !!document.querySelector(selector));
      assert.equal(document.activeElement, document.body, "同名行の再登場で古いfocusを復元しない");
      const oldOwnerControl = document.querySelector<HTMLButtonElement>(selector)!;
      oldOwnerControl.focus();
      await render("session-b");
      assert.equal(oldOwnerControl.isConnected, false);
      await click("Workspace");
      await act(async () => scroller.scrollTo({ top: 6200 }));
      await until(() => !!document.querySelector(selector));
      assert.equal(document.activeElement, document.body, "新ownerの同名行へ古いfocusを移さない");
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "非表示のFilesとPinは取得を始めず、再表示で更新し、重複通知は一つの後続更新へまとめ、折りたたみとowner切替を保つ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer表示時更新・通知集約・owner境界" }
// fault = "hiddenでI/Oを始める、通知ごとに並行取得する、非表示後に子孫取得を続ける、または旧ownerのtreeを表示する"
// observable = "roots・Pin・directoryの取得回数とowner、遅延応答後のtreeとPin行の内容"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane refresh lifecycle"
// lifecycle = "permanent"
// impact = "不可視の余分なI/OとSessionを跨いだ誤表示を防ぐ"
// distinction = "表示切替と未解決requestを組み合わせたlifecycleは型検査や単発取得testでは保証できない"
// @end-test-value
test("Filesの非表示と重複通知とowner切替を未解決request越しに扱う", async () => {
  const api = baseApi();
  let rootReads = 0;
  let pinReads = 0;
  let hold = false;
  const pending: Array<() => void> = [];
  const pendingPins: Array<{ sessionId: string; resolve: (pins: SessionFilePin[]) => void }> = [];
  const directories: string[] = [];
  api.listSessionFileRoots = async (sessionId) => {
    rootReads += 1;
    if (hold) await new Promise<void>((resolve) => pending.push(resolve));
    return [{ id: "workspace", kind: "workspace", label: sessionId, displayPath: `C:\\${sessionId}` }];
  };
  api.listSessionFilePins = async (sessionId) => {
    pinReads += 1;
    return new Promise<SessionFilePin[]>((resolve) => pendingPins.push({ sessionId, resolve }));
  };
  api.listSessionDirectory = async ({ sessionId }) => { directories.push(sessionId); return [entry("current.txt")]; };
  await withPane(api, async ({ document, render, click, until }) => {
    assert.equal(rootReads, 0);
    assert.equal(pinReads, 0);
    await render("session-a");
    assert.equal(pinReads, 1);
    assert.equal(pendingPins[0]?.sessionId, "session-a");
    await act(async () => pendingPins.shift()?.resolve([pin("initial.md")]));
    await click("Pinned only");
    assert.match(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /initial\.md/);
    await click("Pinned only");
    await click("session-a");
    await until(() => !!document.querySelector("[title='current.txt']"));
    hold = true;
    await render("session-a", "session-a", { refreshRevision: 1 });
    await render("session-a", "session-a", { refreshRevision: 2 });
    await render("session-a", "session-a", { refreshRevision: 3 });
    assert.equal(rootReads, 2);
    assert.equal(pinReads, 2);
    await click("Pinned only");
    assert.match(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /initial\.md/);
    await act(async () => pendingPins.shift()?.resolve([pin("intermediate.md")]));
    await until(() => pinReads === 3);
    assert.match(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /intermediate\.md/);
    assert.equal(pendingPins.length, 1);
    assert.equal(pendingPins[0]?.sessionId, "session-a");
    await click("Pinned only");
    await act(async () => pending.shift()?.());
    await until(() => rootReads === 3);
    await click("session-a");
    await render("session-a", "session-a", { refreshRevision: 4 });
    assert.equal(pinReads, 3);
    await render("session-a", "session-a", { visible: false, refreshRevision: 5 });
    const directoryCount = directories.length;
    await act(async () => {
      pending.shift()?.();
      pendingPins.shift()?.resolve([pin("settled-while-hidden.md")]);
    });
    assert.equal(directories.length, directoryCount);
    assert.equal(document.querySelector("[title='current.txt']"), null);
    assert.equal(rootReads, 3);
    assert.equal(pinReads, 3);
    assert.equal(pendingPins.length, 0);
    await render("session-a", "session-a", { refreshRevision: 5 });
    assert.equal(rootReads, 4);
    assert.equal(pinReads, 4);
    await click("Pinned only");
    assert.match(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /settled-while-hidden\.md/);
    await act(async () => {
      pending.shift()?.();
      pendingPins.shift()?.resolve([pin("resumed-current.md")]);
    });
    await until(() => document.querySelector(".session-file-pinned-row")?.textContent?.includes("resumed-current.md") ?? false);
    assert.equal(pinReads, 4);
    assert.equal(document.querySelectorAll(".session-file-pinned-row").length, 1);
    await render("session-a", "session-a", { refreshRevision: 6 });
    assert.equal(rootReads, 5);
    assert.equal(pinReads, 5);
    await render("session-b");
    assert.equal(rootReads, 6);
    assert.equal(pinReads, 6);
    assert.deepEqual(pendingPins.map((request) => request.sessionId), ["session-a", "session-b"]);
    assert.equal(document.querySelector(".session-file-pinned-row"), null);
    await act(async () => {
      pending.shift()?.();
      pendingPins.shift()?.resolve([pin("stale-session-a.md")]);
    });
    assert.equal(document.querySelector(".session-file-root-row"), null);
    assert.equal(document.querySelector(".session-file-pinned-row"), null);
    await act(async () => {
      pending.shift()?.();
      pendingPins.shift()?.resolve([pin("session-b-current.md")]);
    });
    await until(() => document.querySelector(".session-file-pinned-row")?.textContent?.includes("session-b-current.md") ?? false);
    assert.equal(pinReads, 6);
    assert.doesNotMatch(document.querySelector(".session-file-pinned-row")?.textContent ?? "", /stale-session-a|settled-while-hidden/);
    await click("Pinned only");
    assert.equal(document.querySelector(".session-file-root-row")?.textContent, "▸session-b");
    assert.equal(document.body.textContent?.includes("current.txt"), false);
  }, { visible: false });
});

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
// claim = "閉じた祖先配下のdirectory Pinは取得応答が遅れても一度の選択で通常treeの対象まで展開・scroll・focusできる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer Pin" }
// fault = "取得Promise完了をReact state反映完了とみなし、祖先取得後に展開を中断する"
// observable = "directory取得path、filterのpressed state、対象の展開iconと子行、scrollTop、document.activeElement"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane asynchronous pinned directory reveal"
// lifecycle = "permanent"
// impact = "未展開の深いdirectoryへのPinからの到達とkeyboard操作の継続を保証する"
// distinction = "file Pinの直接openや型検査では検出できない、非同期取得とReact描画・仮想tree移動の連携を検証する"
// @end-test-value
test("遅延取得でもdirectory Pinを一度選択すれば対象まで展開しfocusする", async () => {
  const api = baseApi();
  const reads: string[] = [];
  api.listSessionFilePins = async () => [pin("closed/deep", "directory")];
  api.listSessionDirectory = async ({ relativePath }) => {
    reads.push(relativePath);
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (relativePath === "") return [...Array.from({ length: 80 }, (_, index) => entry(`sibling-${index}`, "directory")), entry("closed", "directory")];
    if (relativePath === "closed") return [entry("closed/deep", "directory")];
    return [entry("closed/deep/note.md")];
  };
  await withPane(api, async ({ document, click, until, opened }) => {
    await click("Pinned only");
    await click("Workspace: closed/deep");
    await until(() => document.activeElement?.getAttribute("title") === "closed/deep");
    assert.deepEqual(reads, ["", "closed", "closed/deep"]);
    assert.equal(document.querySelector("[aria-label='Pinned only']")?.getAttribute("aria-pressed"), "false");
    assert.ok(document.querySelector("[title='closed/deep'] .is-expanded"));
    assert.ok(document.querySelector("[title='closed/deep/note.md']"));
    assert.ok(document.querySelector<HTMLDivElement>(".session-file-explorer-body")!.scrollTop > 0);
    assert.deepEqual(opened, []);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "Pin directoryの祖先取得に失敗したらerrorを表示して子孫取得を停止し、再選択で取得を再試行できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer Pin" }
// fault = "取得失敗を成功として子孫へ進める、失敗を隠す、または失敗cacheで再試行を妨げる"
// observable = "alert、directory取得path、再選択後の対象focusと子行"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane pinned directory load failure recovery"
// lifecycle = "permanent"
// impact = "filesystem取得失敗を利用者へ伝え、Pinを失わず対象へ再到達できる"
// distinction = "Pin保存失敗のtestでは通らないdirectory取得の失敗と再選択の連携を確認する"
// @end-test-value
test("Pin directoryの取得失敗を表示して停止し再選択で回復する", async () => {
  const api = baseApi();
  const reads: string[] = [];
  let fail = true;
  api.listSessionFilePins = async () => [pin("closed/deep", "directory")];
  api.listSessionDirectory = async ({ relativePath }) => {
    reads.push(relativePath);
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (relativePath === "") return [entry("closed", "directory")];
    if (relativePath === "closed") {
      if (fail) throw new Error("Directory read failed.");
      return [entry("closed/deep", "directory")];
    }
    return [entry("closed/deep/note.md")];
  };
  await withPane(api, async ({ document, click, until }) => {
    await click("Pinned only");
    await click("Workspace: closed/deep");
    await until(() => !!document.querySelector("[role='alert']"));
    await click("Files Error Details");
    assert.equal(document.querySelector("[role='dialog'] p")?.textContent, "Directory read failed.");
    await click("Close Error Details");
    assert.deepEqual(reads, ["", "closed"]);
    assert.equal(document.querySelector("[title='closed/deep']"), null);
    fail = false;
    await click("Pinned only");
    await click("Workspace: closed/deep");
    await until(() => document.activeElement?.getAttribute("title") === "closed/deep");
    assert.deepEqual(reads, ["", "closed", "closed", "closed/deep"]);
    assert.ok(document.querySelector("[title='closed/deep/note.md']"));
    assert.equal(document.querySelector("[role='alert']"), null);
  });
});

// @test-value v2
// kind = "invariant"
// claim = "directory Pinの展開途中でSessionまたはroot revisionが変わったら旧取得結果を新treeへ適用せず、新しい展開・focusを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: File Explorer PinのSession／root変更前の遅延応答" }
// fault = "旧directory応答から子孫の取得を続ける、旧行を新treeへ追加する、または新しい選択のfocusを奪う"
// observable = "API requestのSessionとpath、切替後のtree行とdocument.activeElement"
// observation_boundary = "component-behavior"
// scope = "SessionFileExplorerPane pinned directory reveal owner boundary"
// lifecycle = "permanent"
// impact = "Sessionやrootを切り替えた利用者へ旧対象の内容や移動を持ち込まない"
// distinction = "Pin一覧と保存の旧応答testでは通らないdirectory revealの継続処理を制御Promiseで確認する"
// @end-test-value
test("Pin directoryの旧応答はSessionとroot revisionの切替後へ展開を持ち込まない", async () => {
  for (const change of ["session", "roots"] as const) {
    const api = baseApi();
    const reads: string[] = [];
    let finish!: (entries: SessionDirectoryEntry[]) => void;
    let current = false;
    api.listSessionFilePins = async () => [pin(current ? "current" : "closed/deep", "directory")];
    api.listSessionDirectory = async ({ sessionId, relativePath }) => {
      reads.push(`${sessionId}:${relativePath}`);
      if (!current) return new Promise<SessionDirectoryEntry[]>((resolve) => { finish = resolve; });
      return relativePath === "" ? [entry("current", "directory")] : [entry("current/note.md")];
    };
    await withPane(api, async ({ document, render, click, until }) => {
      await click("Pinned only");
      await click("Workspace: closed/deep");
      await until(() => !!finish);
      current = true;
      const nextSession = change === "session" ? "session-b" : "session-a";
      await render(nextSession, "new-roots");
      await click("Pinned only");
      await click("Workspace: current");
      await until(() => document.activeElement?.getAttribute("title") === "current");
      await act(async () => {
        finish([entry("closed", "directory")]);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      assert.deepEqual(reads, ["session-a:", `${nextSession}:`, `${nextSession}:current`]);
      assert.equal(document.querySelector("[title='closed']"), null);
      assert.ok(document.querySelector("[title='current/note.md']"));
      assert.equal(document.activeElement?.getAttribute("title"), "current");
    });
  }
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
    assert.ok(document.querySelector("[role='alert']"));
    await click("Pins Error Details");
    assert.equal(document.querySelector("[role='dialog'] p")?.textContent, "Pin save failed.");
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
