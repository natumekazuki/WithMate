import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { DiffViewer } from "../../src/ui/DiffViewer.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "Diff Viewerの表示方式buttonは初期状態と切替後の現在選択をaria-pressedで一つだけ通知し、対応する差分paneを表示する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#操作とアクセシビリティ" }
// fault = "表示方式の選択状態を通知しない、または選択通知と表示paneが不一致になる"
// observable = "Side By Side/Inline buttonのaria-pressedとBefore diff/Inline diff paneの存在"
// observation_boundary = "component-behavior"
// scope = "DiffViewer mode selection"
// lifecycle = "permanent"
// impact = "支援技術を使う利用者が現在の差分表示方式を判断できない問題を防ぐ"
// distinction = "CSS/static checkでは検証できない実componentのmode切替と選択通知の同期を小さなDOM testで守る"
// @end-test-value
test("DiffViewer は現在の表示方式を同期して通知する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DiffViewer file={{ kind: "edit", path: "test.txt", summary: "", diffRows: [] }} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Diff view mode"] button')];
    const [split, inline] = buttons;
    assert.equal(split.textContent?.trim(), "Side By Side");
    assert.equal(inline.textContent?.trim(), "Inline");
    assert.equal(split.getAttribute("aria-pressed"), "true");
    assert.equal(inline.getAttribute("aria-pressed"), "false");
    assert.ok(container.querySelector('[aria-label="Before diff"]'));
    await act(async () => inline.click());
    assert.equal(split.getAttribute("aria-pressed"), "false");
    assert.equal(inline.getAttribute("aria-pressed"), "true");
    assert.ok(container.querySelector('[aria-label="Inline diff"]'));
    await act(async () => split.click());
    assert.equal(split.getAttribute("aria-pressed"), "true");
    assert.equal(inline.getAttribute("aria-pressed"), "false");
    assert.ok(container.querySelector('[aria-label="Before diff"]'));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
