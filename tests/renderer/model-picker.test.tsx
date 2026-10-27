import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "contract"
// claim = "大量Modelを仮想表示し、空候補の読込・失敗・正常0件・検索0件を区別し、初回取得だけ検索とfocusを保って反映し、cache更新・IME確定・Escapeで選択を変えない"
// oracle = { type = "contract", ref = "docs/design/model-catalog.md#model-ui" }
// fault = "全候補をDOMへ展開するか読込・失敗・background更新で操作対象を変え、IME確定を選択操作として扱う"
// observable = "busy/error状態と空結果のstatus文言、保持された現在値、option DOM数、選択option、scrollTop、callback値、検索結果、focus先"
// observation_boundary = "component-behavior"
// scope = "model-picker"
// lifecycle = "permanent"
// impact = "大量候補で入力が滞るか、検索・日本語入力中に意図しないmodelで次turnを送る"
// distinction = "helper testや型検査が扱わないDOM・keyboard・snapshot境界を一つの利用flowで確認する"
// @end-test-value
test("Model picker virtualizes, freezes open options and preserves keyboard/IME selection", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">Outside</button></body>', { pretendToBeVisual: true });
  const globals = ["window", "document", "Node", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "KeyboardEvent"] as const;
  const previous = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const { createRoot } = await import("react-dom/client");
  const { ModelPicker } = await import("../../src/chat/composer/model-picker.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const options = Array.from({ length: 5000 }, (_, index) => ({ value: `id-${index}`, label: `Model ${index}`, sourceLabel: "Source" }));
  const selected: string[] = [];
  const render = (items = options, value = "id-4500", disabled = false, discoveryStatus?: "idle" | "loading" | "ready" | "error", discoveryHasCache?: boolean) => root.render(<ModelPicker options={items} value={value} onChange={(next) => selected.push(next)} disabled={disabled} discoveryStatus={discoveryStatus} discoveryError="Provider is unavailable." discoveryHasCache={discoveryHasCache} />);
  const trigger = () => dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
  const search = () => dom.window.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const key = async (name: string, isComposing = false) => act(async () => search().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, isComposing, bubbles: true })));
  try {
    await act(async () => render());
    await act(async () => render(options, "id-4500", false, "loading"));
    assert.ok(dom.window.document.querySelector('[aria-label="Loading Models"][aria-busy="true"]'));
    assert.match(trigger().textContent!, /Model 4500/);
    await act(async () => render(options, "id-4500", false, "error"));
    assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /Provider is unavailable/);
    assert.match(trigger().textContent!, /Model 4500/);
    assert.match(trigger().title, /Provider is unavailable/);
    assert.deepEqual(selected, []);
    await act(async () => render());
    await act(async () => trigger().click());
    assert.equal(dom.window.document.activeElement, search());
    assert.ok(dom.window.document.querySelectorAll('[role="option"]').length < 30);
    assert.match(dom.window.document.querySelector('[aria-selected="true"]')!.textContent!, /Model 4500/);
    assert.ok(dom.window.document.querySelector<HTMLDivElement>('[role="listbox"]')!.scrollTop > 0);
    await act(async () => render([{ value: "replacement", label: "Replacement", sourceLabel: "Other" }]));
    assert.match(dom.window.document.querySelector('[aria-selected="true"]')!.textContent!, /Model 4500/);
    await key("Enter", true);
    assert.deepEqual(selected, []);
    assert.ok(search());
    await key("Escape");
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    assert.equal(dom.window.document.activeElement, trigger());
    await act(async () => render());
    await act(async () => trigger().click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search(), "Model 12");
      search().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(dom.window.document.querySelector('[role="option"]')!.textContent!, /Model 12/);
    await key("Enter");
    assert.deepEqual(selected, ["id-12"]);
    assert.equal(dom.window.document.activeElement, trigger());
    await act(async () => render([], "saved-model"));
    assert.match(trigger().textContent!, /saved-model/);
    await act(async () => trigger().click());
    assert.equal(dom.window.document.querySelector('[role="option"]')?.getAttribute("aria-disabled"), "true");
    await key("Enter");
    assert.deepEqual(selected, ["id-12"]);
    const outside = dom.window.document.getElementById("outside")!;
    await act(async () => {
      outside.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
      outside.focus();
    });
    assert.equal(dom.window.document.activeElement, outside);
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    await act(async () => render(options, "id-1", true));
    await act(async () => trigger().click());
    assert.equal(dom.window.document.querySelector('[role="listbox"]'), null);
    await act(async () => render([], "saved-model", false, "loading", false));
    await act(async () => trigger().click());
    const firstSearch = search();
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(firstSearch, "Model 12");
      firstSearch.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => render([], "saved-model", false, "error", false));
    await act(async () => render(options, "saved-model", false, "ready", true));
    assert.equal(search(), firstSearch);
    assert.equal(dom.window.document.activeElement, firstSearch);
    assert.equal(search().value, "Model 12");
    assert.match(dom.window.document.querySelector('[role="option"]')!.textContent!, /Model 12/);
    await act(async () => render([{ value: "replacement", label: "Replacement", sourceLabel: "Other" }], "saved-model", false, "ready", true));
    assert.match(dom.window.document.querySelector('[role="option"]')!.textContent!, /Model 12/);
    await key("Escape");
    await act(async () => render([], "saved-model", false, "loading", false));
    await act(async () => trigger().click());
    await act(async () => render([], "saved-model", false, "ready", true));
    await act(async () => render(options, "saved-model", false, "ready", true));
    assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 1);
    assert.match(dom.window.document.querySelector('[role="option"]')!.textContent!, /saved-model/);
    await key("Escape");
    await act(async () => render([], "", false, "loading", false));
    await act(async () => trigger().click());
    assert.equal(dom.window.document.querySelector('.composer-model-empty')?.textContent, "Loading models…");
    await act(async () => render([], "", false, "error", false));
    assert.equal(dom.window.document.querySelector('.composer-model-empty')?.textContent, "Could not load models.");
    await act(async () => render([], "", false, "ready", true));
    assert.equal(dom.window.document.querySelector('.composer-model-empty')?.textContent, "No models available.");
    await key("Escape");
    await act(async () => render());
    await act(async () => trigger().click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search(), "no-such-model");
      search().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(dom.window.document.querySelector('.composer-model-empty')?.textContent, "No matching models.");
    assert.equal(dom.window.document.activeElement, search());
    assert.deepEqual(selected, ["id-12"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
