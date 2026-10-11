import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";

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
