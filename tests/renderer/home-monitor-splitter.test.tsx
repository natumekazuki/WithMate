import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";

// @test-value v2
// kind = "contract"
// claim = "Monitorの2本の境界はpointerと上下矢印キーで隣接領域だけを変更し、drag終了・cancel・capture喪失後と再描画でも比率を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "第三領域の境界も動かす、ドラッグ差分を累積する、終了後もmoveを適用する、keyboardを無視する、または再描画で3等分へ戻す"
// observable = "イベント後のgridTemplateRows、separatorのaria-valuenowとfocus、境界で確保するsection高さ"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentから共通ChatDockSplitterを通るresize操作"
// lifecycle = "permanent"
// impact = "Home／独立MonitorでApproval・Running・Stoppedの配分を操作・保持でき、3見出しと一覧へ継続して到達できる"
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
    key, feedback, approvalEntries: [], runningEntries: [], nonRunningEntries: [],
    onOpenSession() {}, onShowContextMenu() {},
  }));
  const rectangle = (height: number): DOMRect => ({
    x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height,
    toJSON: () => ({}),
  });
  try {
    for (const index of [0, 1]) for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
      const renderKey = `${index}-${ending}`;
      await act(async () => render(renderKey));
      const sections = dom.window.document.querySelector<HTMLDivElement>(".home-monitor-sections")!;
      const splitters = [...sections.querySelectorAll<HTMLButtonElement>('[role="separator"]')];
      assert.equal(splitters.length, 2);
      const splitter = splitters[index]!;
      const other = splitters[1 - index]!;
      sections.getBoundingClientRect = () => rectangle(1000);
      for (const item of splitters) item.getBoundingClientRect = () => rectangle(20);
      const availableHeight = 960;
      const initialBoundary = (index + 1) * availableHeight / 3;
      const unchangedBoundary = other.getAttribute("aria-valuenow");
      const assertBoundary = (expected: number) => {
        const ratios = [...sections.style.gridTemplateRows.matchAll(/minmax\(48px, ([\d.]+)fr\)/g)].map((match) => Number(match[1]));
        const boundary = ratios.slice(0, index + 1).reduce((sum, ratio) => sum + ratio, 0) * availableHeight;
        assert.ok(Math.abs(boundary - expected) < 0.000001, `${boundary} should equal ${expected}`);
        assert.equal(splitter.getAttribute("aria-valuenow"), String(Math.round(expected / availableHeight * 100)));
        assert.equal(other.getAttribute("aria-valuenow"), unchangedBoundary);
        assert.ok(ratios.every((ratio) => ratio * availableHeight >= 48 - 0.000001));
      };
      const pointer = async (type: string, y: number, pointerId = 1) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
        Object.defineProperty(event, "pointerId", { value: pointerId });
        await act(async () => { splitter.dispatchEvent(event); });
      };
      assertBoundary(initialBoundary);
      await pointer("pointerdown", 500);
      assert.equal(dom.window.document.activeElement, splitter);
      await pointer("pointermove", 596);
      assertBoundary(initialBoundary + 96);
      await pointer("pointermove", 692);
      assertBoundary(initialBoundary + 192);
      await pointer(ending, 692);
      await pointer("pointermove", 788);
      assertBoundary(initialBoundary + 192);
      await act(async () => render(renderKey, "Updated status"));
      assertBoundary(initialBoundary + 192);
      const key = async (value: string) => {
        await act(async () => { splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
      };
      await key("ArrowUp");
      assertBoundary(initialBoundary + 168);
      await key("ArrowDown");
      assertBoundary(initialBoundary + 192);
      await key("Home");
      const minimumBoundary = index === 0 ? 48 : 368;
      const maximumBoundary = index === 0 ? 592 : 912;
      assertBoundary(minimumBoundary);
      await key("End");
      assertBoundary(maximumBoundary);
      await pointer("pointerdown", 500);
      await pointer("pointermove", -5000);
      assertBoundary(minimumBoundary);
      await pointer("pointermove", 5000);
      assertBoundary(maximumBoundary);
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
// claim = "Monitorは3分類の小領域一覧をinertにし、Approvalは先頭、RunningとStoppedは末尾splitterへfocusを退避し、拡大時に同じDOMとscroll位置を復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "小領域の一覧を操作可能にする、非表示buttonへfocusを残す、隣接しないsplitterへ退避する、または再mountしてscroll位置を失う"
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
      approvalEntries: [entry], runningEntries: [entry], nonRunningEntries: [entry], onOpenSession() {}, onShowContextMenu() {},
    })));
    const document = dom.window.document;
    const lists = [...document.querySelectorAll<HTMLDivElement>(".home-monitor-list")];
    const splitters = [...document.querySelectorAll<HTMLButtonElement>('[role="separator"]')];
    assert.equal(lists.length, 3);
    for (const [index, list] of lists.entries()) {
      const card = list.querySelector<HTMLDivElement>(".home-monitor-card")!;
      const splitter = splitters[Math.min(index, 1)]!;
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
      assert.equal(document.querySelectorAll(".home-monitor-list")[index], list);
      assert.equal(list.hasAttribute("inert"), false);
      assert.equal(list.classList.contains("is-collapsed"), false);
      assert.equal(list.scrollTop, 42);
      assert.equal(document.activeElement, splitter);
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
  assert.equal(disconnected, true);
});

// @test-value v2
// kind = "contract"
// claim = "Monitor縮小時は3領域各48pxを維持した2境界をARIAへ反映し、各境界の最初の矢印は24px、dragはpointer移動量だけ表示位置から動く"
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
    for (const index of [0, 1]) for (const edge of ["Home", "End"]) for (const input of ["resize-first", "key-first", "pointer-first"]) {
      containerHeight = 790;
      await act(async () => root.render(createElement(HomeMonitorContent, {
        key: `${index}-${edge}-${input}`,
        approvalEntries: [], runningEntries: [], nonRunningEntries: [], onOpenSession() {}, onShowContextMenu() {},
      })));
      const sections = dom.window.document.querySelector<HTMLDivElement>(".home-monitor-sections")!;
      const splitters = [...sections.querySelectorAll<HTMLButtonElement>('[role="separator"]')];
      const splitter = splitters[index]!;
      const key = async (value: string, target = splitter) => {
        await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true })); });
      };
      const pointer = async (type: string, y: number) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
        Object.defineProperty(event, "pointerId", { value: 1 });
        await act(async () => { splitter.dispatchEvent(event); });
      };
      const boundaries = () => {
        const ratios = [...sections.style.gridTemplateRows.matchAll(/minmax\(48px, ([\d.]+)fr\)/g)].map((match) => Number(match[1]));
        const height = containerHeight - 40;
        assert.ok(ratios.every((ratio) => ratio * height >= 48 - 0.000001));
        return [ratios[0]! * height, (ratios[0]! + ratios[1]!) * height];
      };
      const assertBoundary = (expected: number) => {
        assert.ok(Math.abs(boundaries()[index]! - expected) < 0.000001);
        assert.equal(splitter.getAttribute("aria-valuenow"), String(Math.round(expected / (containerHeight - 40) * 100)));
      };
      if (index === 0 && edge === "End") await key("End", splitters[1]);
      if (index === 1 && edge === "Home") await key("Home", splitters[0]);
      await key(edge);
      containerHeight = 470;
      const expected = index === 0 ? edge === "Home" ? 48 : 334 : edge === "Home" ? 96 : 382;
      const direction = edge === "Home" ? 1 : -1;
      if (input === "resize-first") {
        await act(async () => notifyResize());
        assertBoundary(expected);
      }
      if (input === "pointer-first") {
        await pointer("pointerdown", 400);
        assertBoundary(expected);
        const other = boundaries()[1 - index];
        await pointer("pointermove", 400 + direction * 30);
        assertBoundary(expected + direction * 30);
        assert.ok(Math.abs(boundaries()[1 - index]! - other!) < 0.000001);
        await pointer("pointerup", 400 + direction * 30);
      } else {
        await key(direction === 1 ? "ArrowDown" : "ArrowUp");
        assertBoundary(expected + direction * 24);
      }
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
