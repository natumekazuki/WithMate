import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { ButtonContent } from "../../src/ui/button-content.js";

// @test-value v2
// kind = "invariant"
// claim = "ButtonContentは通常内容を同じDOMとレイアウトに保持し、busy中だけ視覚的に隠して共通spinnerを重ね、終了後に通常表示へ戻す"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#ボタン" }
// fault = "busy切替で通常内容を取り除くか支援技術から隠す、spinnerを通常flowへ追加する、または完了後も通常表示へ戻さない"
// observable = "idle・busy・終了後のlabel DOM identityとtext、computed opacity・position、aria-hiddenとspinnerの所属"
// observation_boundary = "component-behavior"
// scope = "shared-button-content-lifecycle"
// lifecycle = "permanent"
// impact = "保存等の操作名の喪失と、状態切替による操作領域の伸縮につながる共通部品の欠陥を防ぐ"
// distinction = "consumerごとのdisabledや文言testでは共通部品と実CSSの接続を確認できない。小さいDOM検証で状態表現の契約を保ち、実寸は実描画で確認する"
// @end-test-value
test("ButtonContent は通常内容を保持してbusy表示から復帰する", async () => {
  const css = await readFile(new URL("../../src/styles/common.css", import.meta.url), "utf8");
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { pretendToBeVisual: true });
  const style = dom.window.document.createElement("style");
  style.textContent = css;
  dom.window.document.head.append(style);
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (busy: boolean) => {
    await act(async () => root.render(<button type="button"><ButtonContent busy={busy}>Save Settings</ButtonContent></button>));
  };
  try {
    await render(false);
    const label = dom.window.document.querySelector<HTMLElement>(".button-content-label")!;
    const slot = label.parentElement!;
    assert.equal(label.textContent, "Save Settings");
    assert.equal(Number(dom.window.getComputedStyle(label).opacity || "1"), 1);
    await render(true);
    assert.equal(dom.window.document.querySelector(".button-content-label"), label);
    assert.equal(label.textContent, "Save Settings");
    assert.equal(Number(dom.window.getComputedStyle(label).opacity), 0);
    assert.notEqual(dom.window.getComputedStyle(label).display, "none");
    assert.notEqual(dom.window.getComputedStyle(label).visibility, "hidden");
    assert.equal(label.hasAttribute("aria-hidden"), false);
    assert.equal(dom.window.getComputedStyle(slot).position, "relative");
    const spinner = slot.querySelector<HTMLElement>(".loading-indicator-spinner")!;
    assert.ok(spinner);
    assert.equal(spinner.getAttribute("aria-hidden"), "true");
    assert.equal(dom.window.getComputedStyle(spinner).position, "absolute");
    await render(false);
    assert.equal(dom.window.document.querySelector(".button-content-label"), label);
    assert.equal(Number(dom.window.getComputedStyle(label).opacity || "1"), 1);
    assert.equal(slot.querySelector(".loading-indicator-spinner"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
