import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";

function entry(id: string): HomeMonitorEntry {
  return {
    kind: "agent", state: { kind: "neutral", label: "Idle" }, mainState: { kind: "neutral", label: "Idle" }, auxiliarySessions: [],
    session: {
      id, taskTitle: id, status: "idle", runState: "idle", updatedAt: "2026-10-12T00:00:00.000Z", isPinned: false,
      workspaceLabel: "workspace", workspacePath: "C:/workspace", sessionKind: "default", accessMode: "active", sourceSchemaVersion: 5,
      characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    },
  };
}

async function withMonitor(run: (context: { dom: JSDOM; root: ReturnType<typeof createRoot> }) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try { await run({ dom, root }); } finally {
    await act(async () => root.unmount());
    dom.window.close();
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

// @test-value v2
// kind = "contract"
// claim = "分類境界は隣接親件数が少ない側を閉じ、同数はAttention優先で残し、閉じた側の復帰を優先する。件数更新だけでは開閉しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "多い側を閉じる、同数でAttentionを閉じる、Runningを閉じられない、両側closedから低優先を開く、または更新で自動開閉する"
// observable = "境界click前後と件数更新後のcontentのinert/aria-hidden、closed行指定、DOM同一性、scrollTop、focus"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの分類境界clickと保持する一覧状態"
// lifecycle = "permanent"
// impact = "限られた監視面積を必要な分類へ配分し、閉じた一覧へkeyboard focusが迷い込まず同じ位置へ復帰できる"
// distinction = "componentの利用操作と更新を跨ぐ状態保持はCSS検査や型checkでは確認できない"
// @end-test-value
test("Monitor分類のclickは件数と優先度に従いDOMを保持して開閉する", async () => {
  await withMonitor(async ({ dom, root }) => {
    const render = (counts: number[], key = "monitor") => root.render(createElement(HomeMonitorContent, {
      key, approvalEntries: Array.from({ length: counts[0]! }, (_, i) => entry(`approval-${i}`)),
      runningEntries: Array.from({ length: counts[1]! }, (_, i) => entry(`running-${i}`)),
      nonRunningEntries: Array.from({ length: counts[2]! }, (_, i) => entry(`stopped-${i}`)),
      onOpenSession() {}, onShowContextMenu() {},
    }));
    const doc = dom.window.document;
    const contents = () => [...doc.querySelectorAll<HTMLElement>(".home-monitor-section-content")];
    const closed = () => contents().map((content) => content.getAttribute("aria-hidden") === "true");
    const click = async (index: number) => { await act(async () => doc.querySelectorAll<HTMLButtonElement>(".home-monitor-splitter")[index]!.click()); };
    for (const [counts, boundary, target] of [ [[1, 3, 2], 0, 0], [[3, 1, 2], 0, 1], [[2, 3, 1], 1, 2], [[2, 1, 3], 1, 1], [[1, 1, 1], 0, 1], [[1, 1, 1], 1, 2] ] as const) {
      await act(async () => render([...counts], `${counts}-${boundary}`));
      const content = contents()[target]!;
      const list = content.querySelector<HTMLElement>(".home-monitor-list")!;
      list.scrollTop = 42;
      list.querySelector<HTMLButtonElement>(".home-monitor-parent-button")!.focus();
      await click(boundary);
      assert.deepEqual(closed(), [0, 1, 2].map((i) => i === target));
      assert.equal(content.hasAttribute("inert"), true);
      assert.equal(doc.activeElement, doc.querySelectorAll(".home-monitor-splitter")[Math.min(target, 1)]);
      assert.ok(doc.querySelector<HTMLElement>(".home-monitor-sections")!.style.gridTemplateRows.includes("max-content"));
      await act(async () => render([5, 5, 5], `${counts}-${boundary}`));
      assert.equal(contents()[target], content);
      assert.equal(closed()[target], true);
      await click(boundary);
      assert.deepEqual(closed(), [false, false, false]);
      assert.equal(list.scrollTop, 42);
      assert.equal(content.hasAttribute("inert"), false);
    }
    await act(async () => render([1, 2, 3], "both-closed"));
    await click(0); // Attention closes (fewer than Running).
    await click(1); // Running closes (fewer than Stopped).
    assert.deepEqual(closed(), [true, true, false]);
    await click(0); // Both closed: restore Attention first.
    assert.deepEqual(closed(), [false, true, false]);
    await click(0); // One closed: restore Running irrespective of count.
    assert.deepEqual(closed(), [false, false, false]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitor境界は隣接領域だけをpointer移動量と24px矢印でresizeし、48px下限・Home/End・drag後click抑止・終了後move無視を維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "第三領域も変える、deltaを累積する、下限を超える、dragを開閉と誤認する、またはpointer終了後もresizeする"
// observable = "操作後のgridTemplateRowsから得る領域高、separatorのaria-valuenow、contentのaria-hidden"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentと共通ChatDockSplitterのresize入力"
// lifecycle = "permanent"
// impact = "分類の表示面積をpointerとkeyboardで安全に調整し、意図せず一覧を閉じない"
// distinction = "click契約testやCSS検査ではpointer lifecycleと数値的な配分を確認できない。実寸法はbrowser検証へ分担する"
// @end-test-value
test("Monitorは隣接分類の高さを調整しdrag後clickを開閉にしない", async () => {
  await withMonitor(async ({ dom, root }) => {
    dom.window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      const height = this.classList.contains("home-monitor-sections") ? 1000 : this.classList.contains("home-monitor-splitter") ? 20 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) };
    };
    for (const boundary of [0, 1]) for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
      await act(async () => root.render(createElement(HomeMonitorContent, {
        key: `${boundary}-${ending}`, approvalEntries: [], runningEntries: [], nonRunningEntries: [], onOpenSession() {}, onShowContextMenu() {},
      })));
      const doc = dom.window.document;
      const sections = doc.querySelector<HTMLElement>(".home-monitor-sections")!;
      const splitter = doc.querySelectorAll<HTMLButtonElement>(".home-monitor-splitter")[boundary]!;
      const heights = () => [...sections.style.gridTemplateRows.matchAll(/minmax\(48px, ([\d.]+)fr\)/g)].map((match) => Number(match[1]));
      const pointer = async (type: string, y: number) => {
        const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
        Object.defineProperty(event, "pointerId", { value: 1 });
        await act(async () => splitter.dispatchEvent(event));
      };
      const key = async (value: string) => { await act(async () => splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }))); };
      assert.deepEqual(heights(), [320, 320, 320]);
      await pointer("pointerdown", 400);
      await pointer("pointermove", 496);
      await pointer("pointermove", 592);
      const expected = [320, 320, 320]; expected[boundary] = 512; expected[boundary + 1] = 128;
      assert.deepEqual(heights(), expected);
      assert.equal(splitter.getAttribute("aria-valuenow"), String(Math.round((boundary === 0 ? 512 : 832) / 960 * 100)));
      await pointer(ending, 592);
      await pointer("pointermove", 700);
      assert.deepEqual(heights(), expected);
      if (ending === "pointerup") {
        await act(async () => splitter.click());
        assert.ok([...doc.querySelectorAll(".home-monitor-section-content")].every((item) => item.getAttribute("aria-hidden") === "false"));
      }
      await key("ArrowUp"); expected[boundary] -= 24; expected[boundary + 1] += 24;
      assert.deepEqual(heights(), expected);
      await key("Home"); expected[boundary] = 48; expected[boundary + 1] = 592;
      assert.deepEqual(heights(), expected);
      await key("End"); expected[boundary] = 592; expected[boundary + 1] = 48;
      assert.deepEqual(heights(), expected);
    }
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは縮小時も開いた分類を48px以上へ配分し、親行が収まらない一覧をinertにしてfocusを境界へ戻し、拡大で同じDOMを復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "Window縮小で最小高を破る、隠れた一覧へfocusを残す、または拡大時に一覧を再mountしてscroll位置を失う"
// observable = "ResizeObserver通知後のgrid row配分、contentのinert/aria-hidden、document.activeElement、DOM同一性とscrollTop"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの寸法変更と小領域一覧の操作境界"
// lifecycle = "permanent"
// impact = "監視Windowの縮小後も隠れたcontrolを誤操作せず、拡大後に一覧位置を維持して監視を続けられる"
// distinction = "固定寸法のdrag testと別に外側resizeの通知経路を通す。JSDOMの仮想寸法で数値と操作状態を確認し実寸法はbrowserへ分担する"
// @end-test-value
test("Monitorは外側resizeで最小高と小領域一覧のfocusを保つ", async () => {
  await withMonitor(async ({ dom, root }) => {
    let notifyResize = () => {};
    let containerHeight = 1000;
    let contentHeight = 80;
    class Observer implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { notifyResize = () => callback([], this); }
      observe() {} unobserve() {} disconnect() {}
    }
    dom.window.ResizeObserver = Observer;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      const height = this.classList.contains("home-monitor-sections") ? containerHeight
        : this.classList.contains("home-monitor-splitter") ? 20
        : this.classList.contains("home-monitor-section-content") ? contentHeight
        : this.classList.contains("home-monitor-parent-row") ? 36
        : this.classList.contains("home-monitor-column-headers") ? 14 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: height, width: 300, height, toJSON: () => ({}) };
    };
    await act(async () => root.render(createElement(HomeMonitorContent, {
      approvalEntries: [entry("a")], runningEntries: [entry("b")], nonRunningEntries: [entry("c")], onOpenSession() {}, onShowContextMenu() {},
    })));
    const doc = dom.window.document;
    const splitter = doc.querySelectorAll<HTMLButtonElement>(".home-monitor-splitter")[0]!;
    await act(async () => splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    containerHeight = 340;
    const content = doc.querySelector<HTMLElement>(".home-monitor-section-content")!;
    const list = content.querySelector<HTMLElement>(".home-monitor-list")!;
    list.scrollTop = 42;
    list.querySelector<HTMLButtonElement>(".home-monitor-parent-button")!.focus();
    contentHeight = 49;
    await act(async () => notifyResize());
    const heights = [...doc.querySelector<HTMLElement>(".home-monitor-sections")!.style.gridTemplateRows.matchAll(/minmax\(48px, ([\d.]+)fr\)/g)].map((match) => Number(match[1]));
    assert.ok(heights.every((height) => height >= 48));
    assert.ok(Math.abs(heights.reduce((sum, height) => sum + height, 0) - 300) < 0.001);
    assert.equal(content.hasAttribute("inert"), true);
    assert.equal(content.getAttribute("aria-hidden"), "true");
    assert.equal(doc.activeElement, splitter);
    contentHeight = 80;
    await act(async () => notifyResize());
    assert.equal(doc.querySelector(".home-monitor-section-content"), content);
    assert.equal(content.hasAttribute("inert"), false);
    assert.equal(list.scrollTop, 42);
    assert.equal(doc.activeElement, splitter);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Monitorは分類更新後もAuxiliary展開を維持し、親focus操作・stable child IDでの移動・keyboard context menuを区別する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window" }
// fault = "分類移動で展開を失う、Auxiliary選択を親だけの移動へ変える、またはkeyboard menuで別親IDを渡す"
// observable = "更新前後のdisclosure aria-expandedとAuxiliary button、およびopen/context menu callback引数"
// observation_boundary = "component-behavior"
// scope = "HomeMonitorContentの一覧更新・展開・navigation"
// lifecycle = "permanent"
// impact = "状態が頻繁に変わる監視中も選択中のAuxiliaryへ到達でき、親と子を誤って開かない"
// distinction = "静的markupやprojection testでは検出できないcomponentの更新を跨ぐ操作状態とcallback境界を確認する"
// @end-test-value
test("Monitorは分類更新を跨いでAuxiliary展開と移動先を維持する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const names = ["window", "document", "HTMLElement", "Node", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of names) Object.defineProperty(globalThis, name, {
    configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
  });
  const entry: HomeMonitorEntry = {
    kind: "agent", state: { kind: "running", label: "Running" }, mainState: { kind: "neutral", label: "Idle" },
    session: {
      id: "parent-1", taskTitle: "Task", status: "idle", runState: "idle", updatedAt: "2026-10-12T00:00:00.000Z", isPinned: false,
      workspaceLabel: "workspace", workspacePath: "C:/workspace", sessionKind: "default", accessMode: "active", sourceSchemaVersion: 5,
      characterId: "mate", character: "Mate", characterIconPath: "", characterThemeColors: { main: "#223344", sub: "#88bbcc" },
    },
    auxiliarySessions: [{
      id: "stable-child", parentSessionId: "parent-1", status: "active", runState: "running", preview: "Child work",
      title: "", provider: "codex", catalogRevision: 1, model: "gpt-6.1-sol", reasoningEffort: "medium",
      approvalMode: "never", codexSandboxMode: "workspace-write", codexSpeed: "standard", codexReviewer: "user",
      customAgentName: "", allowedAdditionalDirectories: [], threadId: "", displayAfterMessageIndex: null,
      createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", closedAt: "",
    }],
  };
  const opened: unknown[][] = [];
  const menus: unknown[][] = [];
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (approval: boolean) => root.render(createElement(HomeMonitorContent, {
    approvalEntries: approval ? [entry] : [], runningEntries: approval ? [] : [entry], nonRunningEntries: [],
    onOpenSession: (...args) => opened.push(args), onShowContextMenu: (...args) => menus.push(args),
  }));
  try {
    await act(async () => render(false));
    const document = dom.window.document;
    assert.ok(document.querySelector('[aria-label="Main Idle"]'));
    assert.ok(document.querySelector('[aria-label="Auxiliary Running: 1"]'));
    await act(async () => document.querySelector<HTMLButtonElement>(".home-monitor-disclosure")!.click());
    await act(async () => render(true));
    assert.equal(document.querySelector(".home-monitor-disclosure")?.getAttribute("aria-expanded"), "true");
    const parent = document.querySelector<HTMLButtonElement>(".home-monitor-parent-button")!;
    await act(async () => parent.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".home-monitor-auxiliary-row")!.click());
    assert.deepEqual(opened, [["parent-1"], ["parent-1", "stable-child"]]);
    await act(async () => parent.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true })));
    assert.deepEqual(menus, [["agent", "parent-1", { x: 0, y: 0 }]]);
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
