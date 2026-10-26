import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { UnreadSessionResult } from "../../src-shared/session/session-turn-state.js";
import { observeSessionResultRead, type SessionResultReadApi } from "../../src/chat/conversation/observe-session-result-read.js";

function harness() {
  const dom = new JSDOM('<!doctype html><div id="list"><div class="session-message-virtual-row" data-index="0"><div data-message-body="true">Result</div></div></div>', { pretendToBeVisual: true });
  const list = dom.window.document.getElementById("list")!;
  const body = list.querySelector<HTMLElement>("[data-message-body]")!;
  const state = {
    focused: true, top: 600, result: { turnId: 1, assistantMessageSeq: 8 } as UnreadSessionResult | null,
    acknowledgement: Promise.resolve(true),
  };
  Object.defineProperty(dom.window.document, "hasFocus", { value: () => state.focused });
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON: () => ({}) });
  list.getBoundingClientRect = () => rect(0, 300);
  body.getBoundingClientRect = () => rect(state.top, 100);
  Object.defineProperty(dom.window, "ResizeObserver", { value: class { observe() {} disconnect() {} } });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  dom.window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  dom.window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const listeners = new Set<(id: string) => void>();
  const acknowledgements: Array<[string, number]> = [];
  const api: SessionResultReadApi = {
    getUnreadSessionResult: async () => state.result,
    markSessionResultRead: async (id, turnId) => { acknowledgements.push([id, turnId]); return state.acknowledgement; },
    onSessionTurnUpdated: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const indexes = new Map([[8, 0]]);
  const dispose = observeSessionResultRead({ api, sessionId: "main", list, assistantMessageIndexes: indexes });
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const scheduled = [...frames.values()];
    frames.clear();
    for (const callback of scheduled) callback(0);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return {
    dom, list, body, state, indexes, listeners, acknowledgements, settle,
    scroll: () => list.dispatchEvent(new dom.window.Event("scroll")),
    focus: () => dom.window.dispatchEvent(new dom.window.Event("focus")),
    update: (id = "main") => { for (const listener of listeners) listener(id); },
    close: () => { dispose(); dom.window.close(); },
  };
}

// @test-value v2
// kind = "contract"
// claim = "結果の自動既読はfocus中かつ最新の保存済みassistant本文または空本文の失敗表示がviewport内にある時だけ実行し、過去履歴・pending表示・折りたたみpreview・他会話では実行しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "最前面固定や過去履歴の表示、保存前のpending本文や折りたたみpreviewだけで最新結果を既読にする、または本文なしの失敗結果を閲覧しても未読を残す"
// observable = "実DOMのscroll/focus/更新eventに対する既読API呼出の会話IDとturn ID"
// observation_boundary = "component-behavior"
// scope = "結果本文の表示と自動既読observer"
// lifecycle = "permanent"
// impact = "見ていない結果をMonitorから消す、または閲覧後も未読を残す"
// distinction = "service/IPCは会話本文の可視領域を持たず、Browser描画だけでは条件違反の回帰を継続検出できない"
// @end-test-value
test("保存済みの最新結果が表示されfocusした時だけ既読にする", async () => {
  const h = harness();
  try {
    await h.settle();
    assert.deepEqual(h.acknowledgements, []);
    h.state.top = 20;
    h.state.focused = false;
    h.scroll();
    await h.settle();
    assert.deepEqual(h.acknowledgements, []);
    h.state.focused = true;
    h.indexes.clear();
    h.focus();
    await h.settle();
    assert.deepEqual(h.acknowledgements, []);
    h.indexes.set(8, 0);
    h.body.setAttribute("data-pending-message-body", "true");
    h.scroll();
    await h.settle();
    assert.deepEqual(h.acknowledgements, []);
    h.body.removeAttribute("data-pending-message-body");
    const preview = h.dom.window.document.createElement("p");
    preview.className = "message-collapsed-preview";
    preview.textContent = "Result preview";
    h.body.replaceChildren(preview);
    await h.settle();
    assert.deepEqual(h.acknowledgements, []);
    h.body.textContent = "Full result";
    await h.settle();
    assert.deepEqual(h.acknowledgements, [["main", 1]]);
    h.state.result = { turnId: 2, assistantMessageSeq: 9 };
    h.indexes.set(9, 0);
    h.update("aux");
    await h.settle();
    assert.equal(h.acknowledgements.length, 1);
    h.update();
    await h.settle();
    assert.deepEqual(h.acknowledgements, [["main", 1], ["main", 2]]);
    h.state.result = { turnId: 3, assistantMessageSeq: 10 };
    h.indexes.set(10, 0);
    const failure = h.dom.window.document.createElement("div");
    failure.className = "session-run-failure";
    failure.textContent = "Failed: provider unavailable";
    failure.getBoundingClientRect = h.body.getBoundingClientRect;
    h.body.getBoundingClientRect = () => new h.dom.window.DOMRect(0, h.state.top, 400, 0);
    h.body.replaceChildren();
    h.body.after(failure);
    h.state.top = 600;
    h.update();
    await h.settle();
    assert.equal(h.acknowledgements.length, 2);
    h.state.top = 20;
    h.scroll();
    await h.settle();
    assert.deepEqual(h.acknowledgements, [["main", 1], ["main", 2], ["main", 3]]);
  } finally { h.close(); }
});

// @test-value v2
// kind = "invariant"
// claim = "古い既読応答が遅れても新しい表示結果を再確認し、observer解除後のeventでは既読要求しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "前のturnの応答で新しい未読を捨てる、または非表示になった会話から要求を送る"
// observable = "非同期応答前後の既読API呼出、解除後の購読数とAPI呼出"
// observation_boundary = "component-behavior"
// scope = "自動既読の非同期競合と購読寿命"
// lifecycle = "permanent"
// impact = "素早い連続完了や会話切替で結果の確認状態が壊れる"
// distinction = "同期service testではrenderer側の応答待ちとDOM購読解除の競合は確認できない"
// @end-test-value
test("遅い既読応答は新結果の確認を止めず、解除後は要求しない", async () => {
  const h = harness();
  let resolve!: (value: boolean) => void;
  h.state.acknowledgement = new Promise((done) => { resolve = done; });
  try {
    h.state.top = 20;
    await h.settle();
    assert.deepEqual(h.acknowledgements, [["main", 1]]);
    h.state.result = { turnId: 2, assistantMessageSeq: 9 };
    h.indexes.set(9, 0);
    h.update();
    await h.settle();
    assert.equal(h.acknowledgements.length, 1);
    h.state.acknowledgement = Promise.resolve(true);
    resolve(true);
    await h.settle();
    assert.deepEqual(h.acknowledgements, [["main", 1], ["main", 2]]);
    h.close();
    assert.equal(h.listeners.size, 0);
    h.state.result = { turnId: 3, assistantMessageSeq: 9 };
    h.update();
    h.focus();
    h.scroll();
    await h.settle();
    assert.equal(h.acknowledgements.length, 2);
  } finally { h.close(); }
});
