import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { installFailedTurnRetryFixture } from "./failed-turn-retry-fixture.js";

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryでBの実行中に履歴の確定失敗Aを明示受付でき、結果不明の旧失敗を再送せず、現draftとBを保持する。今回の受付結果が不明なら新IDを発行せず同じ要求で回復する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#failed-turn-retry; docs/design/desktop-ui.md: Action Dock・回復操作" }
// fault = "実行中に確定失敗の操作を止める、旧結果不明を確定失敗に読み替える、選択した履歴やownerを取り違える、draftを消す、現在Turnを停止またはSteerする、不明受付を新IDで作り直す"
// observable = "実SessionWindowの履歴ボタン・生成継続とdraft、preloadに渡る保存receipt/Turn/owner、受付と照会のID、Stop/Steer/通常送信の呼出有無"
// observation_boundary = "component-behavior"
// scope = "SessionWindowAppの実行中の履歴Resend。読み取り・受付IPCのみ合成"
// lifecycle = "permanent"
// impact = "必要な再試行を予約できない、別依頼を並行実行する、または下書き・現在実行を失う"
// distinction = "Facadeの成功だけでは実画面が実行中に操作を無効化する不具合を検出できない"
// @end-test-value
test("実行中でもMain/Auxの確定失敗Resendを受け付け、未知の受付は同じIDで回復する", { timeout: 10_000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
  const measure = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("session-message-list")) return dom.window.DOMRect.fromRect({ width: 800, height: 720 });
    return measure.call(this);
  };
  for (const property of ["offsetHeight", "clientHeight"]) Object.defineProperty(dom.window.HTMLElement.prototype, property, {
    configurable: true, get(this: HTMLElement) { return this.classList.contains("session-message-list") ? 720 : 0; },
  });
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: [] }, Buffer,
  });
  const f = await installFailedTurnRetryFixture(api, { loseFirstAuxReply: true });
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context);
  } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => cssImports.deregister());
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const composer = () => container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  const pane = (label: string) => container.querySelector(`#session-${label.toLowerCase()}-chat-pane`)!;
  const assertRunningB = (label: string) => assert.match(pane(label).textContent!, /B: Active instruction.*(?:Generating a response|B: Still generating)/s);
  const resend = (label: string) => {
    const buttons = pane(label).querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}: Resend Failed Turn"]`);
    assert.equal(buttons.length, 1, `only the confirmed failed start is eligible in ${label}`);
    return buttons[0]!;
  };
  const click = async (button: HTMLButtonElement) => act(async () => { button.click(); });
  try {
    await act(async () => root.render(<App />));
    assertRunningB("Main");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), "Keep Main draft");
      composer().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const mainResend = resend("Main");
    assert.equal(mainResend.disabled, false, "B must not block acceptance of saved A");
    await act(async () => { mainResend.click(); mainResend.click(); });
    assert.equal(f.requests.length, 1);
    const main = f.requests[0]!;
    assert.deepEqual([main.id, main.request.target, main.request.receiptId, main.request.turnId],
      [f.main.id, f.targets[f.main.id], `${f.main.id}:A`, "42"]);
    assert.equal(composer().value, "Keep Main draft");
    assertRunningB("Main");
    await click(container.querySelector<HTMLButtonElement>('button.concurrent-chat-splitter[aria-label="Open Auxiliary"]')!);
    await click(container.querySelector<HTMLButtonElement>('.concurrent-chat-target-dock button[title="Auxiliary"]')!);
    assert.equal(composer().value, "Keep Auxiliary draft");
    assert.equal(resend("Auxiliary").disabled, false);
    await click(resend("Auxiliary"));
    assert.equal(resend("Auxiliary").disabled, true, "an unknown acceptance must block a new request ID");
    assert.equal(f.requests.length, 2);
    const aux = f.requests[1]!;
    assert.deepEqual([aux.id, aux.request.target, aux.request.receiptId, aux.request.turnId],
      [f.aux.id, f.targets[f.aux.id], `${f.aux.id}:A`, "42"]);
    assert.deepEqual(f.receiptLookups, [{ id: f.aux.id, requestId: aux.request.clientRequestId }]);
    const retryOriginal = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Retry Original Turn");
    assert.ok(retryOriginal);
    await click(retryOriginal);
    assert.deepEqual(f.requests.slice(1), [aux, aux]);
    assert.equal(resend("Auxiliary").disabled, false);
    assert.equal(composer().value, "Keep Auxiliary draft");
    assertRunningB("Auxiliary");
    assert.deepEqual(f.unexpected, []);
    await click(container.querySelector<HTMLButtonElement>('.concurrent-chat-target-dock button[title="Main"]')!);
    assert.equal(composer().value, "Keep Main draft");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
