import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { HomeDashboardScreen } from "../../src/home/HomeDashboardScreen.js";
import { HomeHeader } from "../../src/home/HomeHeader.js";

// @test-value v2
// kind = "contract"
// claim = "Homeは分割外のheader操作を維持し、表示中の右pane名で開閉しながら非表示paneの入力とDOMを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "paneを閉じるとheader操作も無効になる、右pane名を誤る、境界操作が逆のpaneを閉じる、または復帰で入力を破棄する"
// observable = "header Settings callbackとinert祖先の不在、境界の対象ID・表示名、両paneのinert/aria-hidden、復帰した入力値とDOM identity"
// observation_boundary = "component-behavior"
// scope = "HomeDashboardScreenと共通ConcurrentChatSplitterの結線"
// lifecycle = "permanent"
// impact = "多セッション監視の面積切替で検索中の入力や操作対象を失う"
// distinction = "Session splitter単体testではHomeのpane対応・非表示制御・入力保持の結線を検出できない"
// @end-test-value
test("Homeは共通splitterで左右を全幅にし、分割復帰でpaneを保持する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://withmate.local/" });
  const keys = ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  [dom.window, dom.window.document, dom.window.HTMLElement, true].forEach((value, index) => {
    Object.defineProperty(globalThis, keys[index], { configurable: true, value });
  });
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  let settingsCalls = 0;
  const renderScreen = (view: "monitor" | "characters" = "monitor") => root.render(<HomeDashboardScreen
    homePageClassName="home-page"
    header={<HomeHeader
      rightPaneView={view}
      onChangeRightPaneView={(next) => renderScreen(next)}
      monitorWindowIcon={null}
      onOpenSessionMonitorWindow={() => {}}
      onOpenSettingsWindow={() => { settingsCalls += 1; }}
      onRestoreSessionWindows={() => {}}
    />}
    rightPaneLabel={view === "monitor" ? "Monitor" : "Characters"}
    recentSessionsPanel={<input aria-label="Search sessions" defaultValue="in progress" />}
    rightPane={<button type="button">Open Session</button>}
    launchDialog={null}
  />);
  try {
    await act(async () => renderScreen());
    const splitter = element.querySelector<HTMLButtonElement>(".concurrent-chat-splitter")!;
    const sessions = element.querySelector<HTMLElement>(".home-sessions-pane")!;
    const monitor = element.querySelector<HTMLElement>(".home-monitor-pane")!;
    const input = element.querySelector<HTMLInputElement>("input")!;
    input.value = "keep this search";
    assert.equal(splitter.getAttribute("aria-label"), "Collapse Monitor");
    assert.equal(splitter.getAttribute("aria-controls"), monitor.id);
    splitter.focus();
    await act(async () => splitter.click());
    assert.equal(monitor.getAttribute("aria-hidden"), "true");
    assert.equal(monitor.hasAttribute("inert"), true);
    assert.equal(sessions.getAttribute("aria-hidden"), "false");
    assert.equal(splitter.getAttribute("aria-label"), "Open Monitor");
    assert.equal(dom.window.document.activeElement, splitter);
    const settings = element.querySelector<HTMLButtonElement>(".home-settings-button")!;
    assert.equal(settings.closest("[inert]"), null);
    await act(async () => settings.click());
    assert.equal(settingsCalls, 1);
    await act(async () => splitter.click());
    assert.equal(monitor.hasAttribute("inert"), false);

    sessions.style.setProperty("--session-region-min-width", "300px");
    monitor.style.setProperty("--session-region-min-width", "320px");
    Object.defineProperty(splitter.parentElement, "getBoundingClientRect", {
      value: () => ({ width: 1000 }), configurable: true,
    });
    Object.defineProperty(splitter, "getBoundingClientRect", {
      value: () => ({ width: 20 }), configurable: true,
    });
    const pointer = (type: string, clientX: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperties(event, { button: { value: 0 }, clientX: { value: clientX }, clientY: { value: 0 }, pointerId: { value: 1 } });
      return event;
    };
    await act(async () => {
      splitter.dispatchEvent(pointer("pointerdown", 500));
      splitter.dispatchEvent(pointer("pointermove", -300));
      splitter.dispatchEvent(pointer("pointerup", -300));
      splitter.click();
    });
    assert.equal(sessions.getAttribute("aria-hidden"), "true");
    assert.equal(sessions.hasAttribute("inert"), true);
    assert.equal(monitor.hasAttribute("inert"), false);
    assert.equal(splitter.getAttribute("aria-label"), "Open Sessions");
    assert.equal(splitter.getAttribute("aria-controls"), sessions.id);
    await act(async () => splitter.click());
    assert.equal(sessions.hasAttribute("inert"), false);
    assert.equal(element.querySelector("input"), input);
    assert.equal(input.value, "keep this search");
    await act(async () => splitter.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    assert.match(splitter.parentElement?.style.gridTemplateColumns ?? "", /0\.52fr/);
    await act(async () => element.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!.click());
    assert.equal(splitter.getAttribute("aria-label"), "Collapse Characters");
    await act(async () => splitter.click());
    assert.equal(splitter.getAttribute("aria-label"), "Open Characters");
    assert.equal(settings.closest("[inert]"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
