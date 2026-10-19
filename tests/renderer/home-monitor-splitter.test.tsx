import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { HomeMonitorContent } from "../../src/home/HomeMonitorContent.js";
import type { HomeMonitorEntry } from "../../src/home/home-session-projection.js";

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
