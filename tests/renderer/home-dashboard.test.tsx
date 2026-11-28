import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { HomeDashboardScreen } from "../../src/home/HomeDashboardScreen.js";
import {
  HomeHeader,
  homeRightPaneLabels,
  type HomeRightPaneView,
} from "../../src/home/HomeHeader.js";

// @test-value v2
// kind = "contract"
// claim = "Homeは分割外headerの検索とNew Session操作を両paneの開閉にかかわらず維持し、表示中の右pane名と最小幅に従って分割する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "paneを閉じるとheader操作も無効になる、右pane名を誤る、境界操作が逆のpaneを閉じる、または復帰で入力を破棄する"
// observable = "検索inputとNew Sessionのinert祖先、作成callback回数、境界の対象ID・表示名、両paneのinert/aria-hidden、検索値とDOM identity、ResizeObserver後のgrid比率とpane幅"
// observation_boundary = "component-behavior"
// scope = "HomeDashboardScreenの外側resize補正と共通ConcurrentChatSplitterの結線"
// lifecycle = "permanent"
// impact = "多セッション監視の面積切替で検索中の入力や操作対象を失う"
// distinction = "Session splitter単体testではHomeのpane対応・非表示制御・入力保持の結線を検出できない"
// @end-test-value
/** 左右ペインを閉じてもヘッダー操作と検索入力を保ち、外側リサイズで両側の最小幅に収まるよう分割比率を補正することを確認する。 */
test("Homeは共通splitterの開閉と外側縮小でpaneと最小幅を保持する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://withmate.local/",
  });
  const keys = [
    "window",
    "document",
    "HTMLElement",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previous = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  [dom.window, dom.window.document, dom.window.HTMLElement, true].forEach(
    (value, index) => {
      Object.defineProperty(globalThis, keys[index], {
        configurable: true,
        value,
      });
    },
  );
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  /** Observer が作られるまでリサイズ通知を送らない。 */
  let notifyResize = () => {};
  /** ブラウザーのレイアウトに頼らず幅の変化を通知する ResizeObserver の代役。 */
  class Observer implements ResizeObserver {
    /** テストが幅を変更した時点で通知を発火できるようコールバックを受け取る。 */
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this);
    }
    /** 通知は手動発火するため、要素の監視は登録しない。 */
    observe() {}
    /** 実監視を登録していないため、個別の解除は不要。 */
    unobserve() {}
    /** ブラウザーの監視資源を確保していないため、切断時は何もしない。 */
    disconnect() {}
  }
  dom.window.ResizeObserver = Observer;
  let containerWidth = 1000;
  let settingsCalls = 0;
  let launchCalls = 0;
  /** 右ペインの切替を実画面と同様にラベルとヘッダーの両方へ反映する。 */
  const renderScreen = (view: HomeRightPaneView = "monitor") =>
    root.render(
      <HomeDashboardScreen
        homePageClassName="home-page"
        header={
          <HomeHeader
            searchInputText="keep this search"
            onChangeSearchText={() => {}}
            onOpenLaunchDialog={() => {
              launchCalls += 1;
            }}
            canCreateSession
            rightPaneView={view}
            onChangeRightPaneView={(next) => renderScreen(next)}
            monitorWindowIcon={null}
            onOpenSessionMonitorWindow={() => {}}
            onOpenSettingsWindow={() => {
              settingsCalls += 1;
            }}
            onRestoreSessionWindows={() => {}}
          />
        }
        rightPaneLabel={homeRightPaneLabels[view]}
        recentSessionsPanel={<div>Recent Sessions</div>}
        rightPane={<button type="button">Open Session</button>}
        launchDialog={null}
      />,
    );
  try {
    await act(async () => renderScreen());
    const splitter = element.querySelector<HTMLButtonElement>(
      ".concurrent-chat-splitter",
    )!;
    const sessions = element.querySelector<HTMLElement>(".home-sessions-pane")!;
    const monitor = element.querySelector<HTMLElement>(".home-monitor-pane")!;
    const input = element.querySelector<HTMLInputElement>("input")!;
    const newSession = element.querySelector<HTMLButtonElement>(
      '[aria-label="New session"]',
    )!;
    assert.equal(splitter.getAttribute("aria-label"), "Collapse Monitor");
    assert.equal(splitter.getAttribute("aria-controls"), monitor.id);
    splitter.focus();
    await act(async () => splitter.click());
    assert.equal(monitor.getAttribute("aria-hidden"), "true");
    assert.equal(monitor.hasAttribute("inert"), true);
    assert.equal(sessions.getAttribute("aria-hidden"), "false");
    assert.equal(splitter.getAttribute("aria-label"), "Open Monitor");
    assert.equal(dom.window.document.activeElement, splitter);
    const settings = element.querySelector<HTMLButtonElement>(
      ".home-settings-button",
    )!;
    assert.equal(settings.closest("[inert]"), null);
    await act(async () => settings.click());
    assert.equal(settingsCalls, 1);
    assert.equal(input.closest("[inert]"), null);
    assert.equal(newSession.closest("[inert]"), null);
    await act(async () => newSession.click());
    assert.equal(launchCalls, 1);
    await act(async () => splitter.click());
    assert.equal(monitor.hasAttribute("inert"), false);

    sessions.style.setProperty("--session-region-min-width", "300px");
    monitor.style.setProperty("--session-region-min-width", "320px");
    Object.defineProperty(splitter.parentElement, "getBoundingClientRect", {
      /** 外側の幅を変更してから通知すると、更新後の計測値を返す。 */
      value: () => ({ width: containerWidth }),
      configurable: true,
    });
    Object.defineProperty(splitter, "getBoundingClientRect", {
      /** 分割比率の計算から差し引く境界の幅を固定する。 */
      value: () => ({ width: 20 }),
      configurable: true,
    });
    /** 同じポインターによる水平ドラッグを再現するため、座標付きイベントを作る。 */
    const pointer = (type: string, clientX: number) => {
      const event = new dom.window.Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        clientY: { value: 0 },
        pointerId: { value: 1 },
      });
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
    assert.equal(input.closest("[inert]"), null);
    assert.equal(newSession.closest("[inert]"), null);
    await act(async () => newSession.click());
    assert.equal(launchCalls, 2);
    await act(async () => splitter.click());
    assert.equal(sessions.hasAttribute("inert"), false);
    assert.equal(element.querySelector("input"), input);
    assert.equal(input.value, "keep this search");
    await act(async () =>
      splitter.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    assert.match(
      splitter.parentElement?.style.gridTemplateColumns ?? "",
      /0\.52fr/,
    );
    const charactersTab = [
      ...element.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((tab) => tab.textContent === "Characters");
    assert.ok(charactersTab);
    await act(async () => charactersTab.click());
    assert.equal(splitter.getAttribute("aria-label"), "Collapse Characters");
    await act(async () => splitter.click());
    assert.equal(splitter.getAttribute("aria-label"), "Open Characters");
    assert.equal(settings.closest("[inert]"), null);
    containerWidth = 900;
    await act(async () => notifyResize());
    assert.equal(monitor.getAttribute("aria-hidden"), "true");
    containerWidth = 1000;
    await act(async () => splitter.click());
    /** キーボードによる分割位置の調整を送り、描画が落ち着くまで待つ。 */
    const key = async (key: string) => {
      await act(async () =>
        splitter.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
        ),
      );
    };
    /** 設定済みの列トラックから右ペインの比率を読み取り、最小幅の計算に使う。 */
    const monitorRatio = () =>
      Number(
        [
          ...splitter.parentElement!.style.gridTemplateColumns.matchAll(
            /([\d.]+)fr/g,
          ),
        ][1]![1],
      );
    for (let i = 0; i < 8; i++) await key("ArrowRight");
    containerWidth = 900;
    await act(async () => notifyResize());
    assert.ok(Math.abs(monitorRatio() * 880 - 320) < 0.001);
    await act(async () => splitter.click());
    containerWidth = 1000;
    await act(async () => splitter.click());
    for (let i = 0; i < 8; i++) await key("ArrowLeft");
    containerWidth = 900;
    await act(async () => notifyResize());
    assert.ok(Math.abs((1 - monitorRatio()) * 880 - 300) < 0.001);
    await key("ArrowLeft");
    assert.equal(sessions.hasAttribute("inert"), true);
    containerWidth = 800;
    await act(async () => notifyResize());
    assert.equal(sessions.hasAttribute("inert"), true);
    assert.equal(element.querySelector("input"), input);
    assert.equal(input.value, "keep this search");
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
