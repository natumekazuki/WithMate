import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";

// @test-value v2
// kind = "contract"
// claim = "Monitorの比率はpointerと上下矢印キーで変更でき、drag終了・cancel・capture喪失後のmoveでは変わらず、再描画で初期値へ戻らない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "ドラッグ差分を累積して過大に変更する、終了後もmoveを適用する、keyboardを無視する、または状態更新で比率を5:5へ戻す"
// observable = "イベント後のgridTemplateRows、separatorのaria-valuenowとfocus、境界で確保するsection高さ"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentから共通ChatDockSplitterを通るresize操作"
// lifecycle = "permanent"
// impact = "Home／独立Monitorで比率を操作・保持でき、両見出しと一覧へ継続して到達できる"
// distinction = "初期DOMとCSSのtestでは検出できないpointer lifecycleとkeyboardによる状態遷移を、1つのJSDOMで検証する。実captureとscroll寸法は実描画で確認する"
// @end-test-value
test("Monitorはdragとkeyboardで比率を変更・保持し終了後のmoveを無視する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (key: string, feedback = "") => root.render(createElement(HomeMonitorContent, {
    key, feedback, runningEntries: [], nonRunningEntries: [],
    onOpenSession() {}, onShowContextMenu() {},
  }));
  const rectangle = (height: number): DOMRect => ({
    x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height,
    toJSON: () => ({}),
  });
  try {
    for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
      await act(async () => render(ending));
      const sections = dom.window.document.querySelector<HTMLDivElement>(".home-monitor-sections")!;
      const splitter = sections.querySelector<HTMLButtonElement>('[role="separator"]')!;
      sections.getBoundingClientRect = () => rectangle(1000);
      splitter.getBoundingClientRect = () => rectangle(20);
      const pointer = async (type: string, y: number, pointerId = 1) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
        Object.defineProperty(event, "pointerId", { value: pointerId });
        await act(async () => { splitter.dispatchEvent(event); });
      };
      assert.equal(splitter.getAttribute("aria-valuenow"), "50");
      await pointer("pointerdown", 500);
      assert.equal(dom.window.document.activeElement, splitter);
      await pointer("pointermove", 598);
      assert.equal(splitter.getAttribute("aria-valuenow"), "60");
      await pointer("pointermove", 696);
      assert.equal(splitter.getAttribute("aria-valuenow"), "70");
      await pointer(ending, 696);
      await pointer("pointermove", 794);
      assert.equal(splitter.getAttribute("aria-valuenow"), "70");
      await act(async () => render(ending, "Updated status"));
      assert.equal(splitter.getAttribute("aria-valuenow"), "70");
      const key = async (value: string) => {
        await act(async () => { splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
      };
      await key("ArrowUp");
      assert.equal(splitter.getAttribute("aria-valuenow"), "68");
      await key("ArrowDown");
      assert.equal(splitter.getAttribute("aria-valuenow"), "70");
      await key("Home");
      assert.match(sections.style.gridTemplateRows, /minmax\(48px, 0\.048979/);
      await key("End");
      assert.match(sections.style.gridTemplateRows, /minmax\(48px, 0\.951020/);
      await pointer("pointerdown", 500);
      await pointer("pointermove", -5000);
      assert.equal(splitter.getAttribute("aria-valuenow"), "5");
      await pointer("pointermove", 5000);
      assert.equal(splitter.getAttribute("aria-valuenow"), "95");
      await pointer("pointerup", 5000);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは親cardの2行分が収まらない一覧をinertにしてfocusをdividerへ移し、広げると同じ一覧DOMとscroll位置を復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "小領域の一覧を操作可能なまま残す、非表示のbuttonへfocusを残す、または復帰時に一覧を再mountしてscroll位置を失う"
// observable = "resize通知前後の一覧のinert属性・collapsed class・DOM同一性・scrollTopとdocument.activeElement"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの領域寸法から一覧の表示・操作状態への投影"
// lifecycle = "permanent"
// impact = "小領域の隠れた操作へkeyboard focusが入り込まず、配分を戻した後も同じ一覧位置から作業を続けられる"
// distinction = "既存の比率操作testや型検査では観測できない一覧の操作境界と復帰を、実componentで確認する。実寸法・Tab順・展開状態はbrowser検証へ分担する"
// @end-test-value
test("Monitorは小領域の一覧を操作不可にしfocusとscrollを維持して復帰する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  }
  let notifyResize = () => {};
  let disconnected = false;
  class TestResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this); }
    observe() {}
    unobserve() {}
    disconnect() { disconnected = true; }
  }
  dom.window.ResizeObserver = TestResizeObserver;
  const entry: HomeMonitorEntry = {
    kind: "agent", state: { kind: "neutral", label: "Idle" }, mainState: { kind: "neutral", label: "Idle" }, auxiliarySessions: [],
    session: {
      id: "session-1", taskTitle: "Task", status: "idle", runState: "idle", updatedAt: "2026-10-12T00:00:00.000Z", isPinned: false,
      workspaceLabel: "workspace", workspacePath: "C:/workspace", sessionKind: "default", accessMode: "active", sourceSchemaVersion: 5,
      characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    },
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(HomeMonitorContent, {
      runningEntries: [entry], nonRunningEntries: [], onOpenSession() {}, onShowContextMenu() {},
    })));
    const document = dom.window.document;
    const list = document.querySelector<HTMLDivElement>(".home-monitor-list")!;
    const card = list.querySelector<HTMLDivElement>(".home-monitor-card")!;
    const splitter = document.querySelector<HTMLButtonElement>('[role="separator"]')!;
    let availableHeight = 80;
    const rectangle = (height: number): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) });
    list.getBoundingClientRect = () => rectangle(availableHeight);
    card.getBoundingClientRect = () => rectangle(70);
    list.scrollTop = 42;
    await act(async () => notifyResize());
    assert.equal(list.hasAttribute("inert"), false);
    availableHeight = 70;
    await act(async () => notifyResize());
    assert.equal(list.hasAttribute("inert"), false);
    list.querySelector<HTMLButtonElement>(".home-monitor-parent-button")!.focus();
    assert.ok(list.contains(document.activeElement));
    availableHeight = 69;
    await act(async () => notifyResize());
    assert.equal(list.hasAttribute("inert"), true);
    assert.equal(list.classList.contains("is-collapsed"), true);
    assert.equal(document.activeElement, splitter);
    assert.equal(list.isConnected, true);
    availableHeight = 80;
    await act(async () => notifyResize());
    assert.equal(document.querySelector(".home-monitor-list"), list);
    assert.equal(list.hasAttribute("inert"), false);
    assert.equal(list.classList.contains("is-collapsed"), false);
    assert.equal(list.scrollTop, 42);
    assert.equal(document.activeElement, splitter);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  assert.equal(disconnected, true);
});

// @test-value v2
// kind = "contract"
// claim = "Monitorの領域高が縮むと上下48pxを維持した表示比率をARIAへ反映し、最初の矢印操作は24px、dragはpointer移動量だけ表示位置から動く"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "旧高さで保存した比率を縮小後も使い、ARIAの配分と最初のkeyboard／drag移動を表示位置からずらす"
// observable = "領域高変更・resize通知・keyboard／pointerイベント後のgridTemplateRowsの比率とseparatorのaria-valuenow"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの領域resizeから共有Splitterの入力起点と表示比率への同期"
// lifecycle = "permanent"
// impact = "Home／独立MonitorのWindowを縮めた後も、仕切りが入力に追従し支援技術へ実際の配分を伝えられる"
// distinction = "既存の固定高resize操作testでは検出できない高さ変更を1つのJSDOMで確認する。実際のCSS寸法とpointer追従はbrowser検証で確認する"
// @end-test-value
test("Monitorは領域縮小後の比率と最初のkeyboard／dragを現在の高さへ合わせる", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
    });
  }
  let containerHeight = 790;
  let notifyResize = () => {};
  class TestResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  dom.window.ResizeObserver = TestResizeObserver;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const height = this.classList.contains("home-monitor-sections") ? containerHeight : this.classList.contains("home-monitor-splitter") ? 20 : 0;
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) };
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(HomeMonitorContent, {
      runningEntries: [], nonRunningEntries: [], onOpenSession() {}, onShowContextMenu() {},
    })));
    const sections = dom.window.document.querySelector<HTMLDivElement>(".home-monitor-sections")!;
    const splitter = sections.querySelector<HTMLButtonElement>('[role="separator"]')!;
    const key = async (value: string) => {
      await act(async () => { splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true })); });
    };
    const pointer = async (type: string, y: number) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => { splitter.dispatchEvent(event); });
    };
    const assertRunningHeight = (expected: number) => {
      const ratio = Number(sections.style.gridTemplateRows.match(/minmax\(48px, ([\d.]+)fr\)/)?.[1]);
      assert.ok(Math.abs(ratio * (containerHeight - 20) - expected) < 0.000001);
      assert.equal(splitter.getAttribute("aria-valuenow"), String(Math.round(expected / (containerHeight - 20) * 100)));
    };
    for (const edge of ["Home", "End"]) {
      containerHeight = 790;
      await act(async () => notifyResize());
      await key(edge);
      containerHeight = 470;
      await act(async () => notifyResize());
      assertRunningHeight(edge === "Home" ? 48 : 402);
      await key(edge === "Home" ? "ArrowDown" : "ArrowUp");
      assertRunningHeight(edge === "Home" ? 72 : 378);

      // 入力がResizeObserver通知より先でも、表示中の限界位置から動く。
      containerHeight = 790;
      await act(async () => notifyResize());
      await key(edge);
      containerHeight = 470;
      await key(edge === "Home" ? "ArrowDown" : "ArrowUp");
      assertRunningHeight(edge === "Home" ? 72 : 378);

      containerHeight = 790;
      await act(async () => notifyResize());
      await key(edge);
      containerHeight = 470;
      await pointer("pointerdown", 400);
      assertRunningHeight(edge === "Home" ? 48 : 402);
      await pointer("pointermove", edge === "Home" ? 430 : 370);
      assertRunningHeight(edge === "Home" ? 78 : 372);
      await pointer("pointerup", edge === "Home" ? 430 : 370);
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
