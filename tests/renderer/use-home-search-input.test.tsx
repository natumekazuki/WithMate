import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { useHomeSearchInput } from "../../src/home/use-home-search-input.js";

async function mount(t: TestContext) {
  const dom = new JSDOM("<div id='root'></div>");
  const properties = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(properties).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let state!: ReturnType<typeof useHomeSearchInput>;
  let mounted = true;
  function Harness() {
    state = useHomeSearchInput();
    return <input readOnly value={state.inputText} />;
  }
  const unmount = async () => {
    if (!mounted) return;
    await act(async () => root.unmount());
    mounted = false;
  };
  t.after(async () => {
    await unmount();
    t.mock.timers.reset();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(<Harness />));
  return {
    get state() { return state; },
    get inputValue() { return dom.window.document.querySelector("input")!.value; },
    change: async (value: string) => { await act(async () => state.onChangeInputText(value)); },
    tick: async (ms: number) => { await act(async () => t.mock.timers.tick(ms)); },
    unmount,
  };
}

// @test-value v2
// kind = "contract"
// claim = "Home共通検索は入力を即座に表示し、最後の変更から300ms後にだけ検索語を置換する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "途中入力を即適用するか、連続入力の最初のtimerで最新語を早く適用する"
// observable = "React inputの値とhookが返すsearchTextの時刻別の値"
// observation_boundary = "component-behavior"
// scope = "Home共通検索入力のtrailing debounce"
// lifecycle = "permanent"
// impact = "入力ごとの一覧再取得と表示のちらつきを避ける"
// distinction = "静的型検査や検索filter testでは入力と適用の時間境界を検出できない"
// @end-test-value
test("Home検索は最後の入力から300ms待って共通検索語を置換する", async (t) => {
  const fixture = await mount(t);
  await fixture.change("old");
  assert.equal(fixture.inputValue, "old");
  assert.equal(fixture.state.searchText, "");
  await fixture.tick(300);
  assert.equal(fixture.state.searchText, "old");
  await fixture.change("n");
  await fixture.tick(200);
  await fixture.change("new");
  assert.equal(fixture.inputValue, "new");
  await fixture.tick(299);
  assert.equal(fixture.state.searchText, "old");
  await fixture.tick(1);
  assert.equal(fixture.state.searchText, "new");
});

// @test-value v2
// kind = "contract"
// claim = "IME開始で未適用入力を取消し、変換中は検索を更新せず、確定DOM値を300ms後に一度適用する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "変換中の語を適用するか、compositionend後の同値changeで待機を延長する"
// observable = "変換中・確定後のinputTextとsearchText"
// observation_boundary = "component-behavior"
// scope = "Home共通検索入力のIME lifecycle"
// lifecycle = "permanent"
// impact = "未確定の日本語で一覧が再取得・再配置されることを防ぐ"
// distinction = "通常入力のtimer testではcompositionと後続changeの順序を扱わない"
// @end-test-value
test("IME変換の確定値だけを適用し、後続の同値changeで待ち直さない", async (t) => {
  const fixture = await mount(t);
  await fixture.change("old");
  await fixture.tick(300);
  await fixture.change("pending");
  await fixture.tick(200);
  await act(async () => fixture.state.onCompositionStart());
  await fixture.change("に");
  await fixture.tick(500);
  assert.equal(fixture.state.inputText, "に");
  assert.equal(fixture.state.searchText, "old");
  await fixture.change("");
  await fixture.tick(500);
  assert.equal(fixture.state.searchText, "old");
  await act(async () => fixture.state.onCompositionEnd("日本"));
  assert.equal(fixture.inputValue, "日本");
  await fixture.tick(100);
  await fixture.change("日本");
  await fixture.tick(199);
  assert.equal(fixture.state.searchText, "old");
  await fixture.tick(1);
  assert.equal(fixture.state.searchText, "日本");
});

// @test-value v2
// kind = "contract"
// claim = "空入力は検索を即座に解除し、取消した待機入力を後から適用しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "clearにも300ms待機を課すか、取消前の語をtimerから復活させる"
// observable = "clear直後とtimer期限経過後のinputTextとsearchText"
// observation_boundary = "component-behavior"
// scope = "Home共通検索のclear"
// lifecycle = "permanent"
// impact = "クリア後も一覧が絞り込まれる操作不一致を防ぐ"
// distinction = "非空入力のdebounce testでは即時解除と取消の組合せを確認しない"
// @end-test-value
test("空入力は即座に適用し、保留中の検索を取消す", async (t) => {
  const fixture = await mount(t);
  await fixture.change("old");
  await fixture.tick(300);
  await fixture.change("pending");
  await fixture.tick(200);
  await fixture.change("");
  assert.equal(fixture.inputValue, "");
  assert.equal(fixture.state.searchText, "");
  await fixture.tick(500);
  assert.equal(fixture.state.searchText, "");
});

// @test-value v2
// kind = "contract"
// claim = "Home検索入力のunmountは保留timerを取消し、そのcallbackを実行しない"
// oracle = { type = "contract", ref = "docs/design/window-architecture.md#home-rendererの実装方針" }
// fault = "hookのlifecycle終了後も検索適用timerを動作させる"
// observable = "unmount後に実行されたsetTimeout callbackの件数"
// observation_boundary = "component-behavior"
// scope = "Home共通検索入力のtimer lifecycle"
// lifecycle = "permanent"
// impact = "閉じたHome入力に紐づく保留処理を残さない"
// distinction = "値だけの検査ではReactが破棄するunmount後の更新を検出できない"
// @end-test-value
test("unmountで保留中の検索timerを取消す", async (t) => {
  const fixture = await mount(t);
  let callbacks = 0;
  const setTimeoutBeforeSpy = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => setTimeoutBeforeSpy(() => {
    callbacks += 1;
    callback();
  }, delay));
  await fixture.change("pending");
  await fixture.unmount();
  await fixture.tick(500);
  assert.equal(callbacks, 0);
});
