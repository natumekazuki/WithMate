import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CustomAgentPicker, type SessionCustomAgentItem } from "../../src/chat/composer/custom-agent-picker.js";

const candidates: SessionCustomAgentItem[] = [
  { key: "default", value: null, primaryLabel: "Default", secondaryLabel: "Provider default", title: "Default", isSelected: false },
  { key: "review", value: "review", primaryLabel: "Reviewer", secondaryLabel: "Review agent", title: "Reviewer", isSelected: true },
  { key: "build", value: "build", primaryLabel: "Builder", secondaryLabel: "Build agent", title: "Builder", isSelected: false },
];

async function withPicker(run: (context: {
  document: Document;
  render: (options?: { items?: SessionCustomAgentItem[]; loading?: boolean; disabled?: boolean }) => Promise<void>;
  trigger: () => HTMLButtonElement;
  options: () => HTMLButtonElement[];
  key: (key: string, shiftKey?: boolean) => Promise<KeyboardEvent>;
  selected: (string | null)[];
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">Outside</button></body>', { pretendToBeVisual: true });
  const globals = ["window", "document", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [dom.window, dom.window.document, dom.window.HTMLElement, dom.window.Node, true];
  globals.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = createRoot(dom.window.document.getElementById("root")!);
  const selected: (string | null)[] = [];
  let finishSelection!: () => void;
  const pendingSelection = new Promise<void>((resolve) => { finishSelection = resolve; });
  let settings = { items: candidates, loading: false, disabled: false };
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return <CustomAgentPicker {...settings} isOpen={open} label="Reviewer" title="Reviewer"
      onToggle={() => setOpen((value) => !value)} onClose={() => setOpen(false)}
      onSelect={(value) => { selected.push(value); return pendingSelection; }} />;
  }
  const render = async (options = {}) => {
    settings = { ...settings, ...options };
    await act(async () => root.render(<Harness />));
  };
  const document = dom.window.document;
  try {
    await render();
    await run({
      document, render, selected,
      trigger: () => document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!,
      options: () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')],
      key: async (key, shiftKey = false) => {
        const event = new dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
        await act(async () => document.activeElement!.dispatchEvent(event));
        return event;
      },
    });
  } finally {
    await act(async () => { finishSelection(); root.unmount(); });
    dom.window.close();
    globals.forEach((key, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

// @test-value v2
// kind = "contract"
// claim = "Custom Agentの矢印とHome/Endはfocusだけを動かし、明示選択だけが変更・同値・既定nullを通知して保存完了を待たず入口へfocusを戻す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action DockのCustom Agent選択" }
// fault = "候補移動で選択を確定する、候補値を取り違える、または非同期保存中にfocusを候補へ残す"
// observable = "optionのaria-selected、activeElement、onSelectの値と件数"
// observation_boundary = "component-behavior"
// scope = "CustomAgentPicker navigation and explicit selection; native Enter/Space default activation is excluded"
// lifecycle = "permanent"
// impact = "次turnのagentが意図せず変更されるか、閉鎖後のkeyboard操作の開始位置を失う"
// distinction = "型検査や選択保存の単体testでは実pickerのfocusと選択callback境界を確認できない"
// @end-test-value
test("Custom Agent navigates without selecting and returns focus on explicit selection", async () => {
  await withPicker(async ({ document, trigger, options, key, selected, render }) => {
    trigger().focus();
    await key("ArrowDown");
    assert.equal(document.activeElement, options()[1]);
    await key("ArrowDown");
    assert.equal(document.activeElement, options()[2]);
    await key("Home");
    assert.equal(document.activeElement, options()[0]);
    await key("End");
    assert.equal(document.activeElement, options()[2]);
    await key("ArrowUp");
    assert.equal(document.activeElement, options()[1]);
    await key("ArrowDown");
    await render({ items: candidates.map((item) => ({ ...item })) });
    assert.equal(document.activeElement, options()[2]);
    assert.deepEqual(options().map((option) => option.getAttribute("aria-selected")), ["false", "true", "false"]);
    assert.deepEqual(selected, []);
    for (const [index, value] of [[2, "build"], [1, "review"], [0, null]] as const) {
      await act(async () => options()[index].click());
      assert.equal(selected.at(-1), value);
      assert.equal(document.activeElement, trigger());
    }
    assert.deepEqual(selected, ["build", "review", null]);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Custom AgentはEscape・Close・Tabで選択せず入口へfocusを戻し、外側focusとpointerによるdismissは外側のfocusを奪わない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md: popoverの閉鎖とfocus復帰" }
// fault = "取消で値を通知するか、keyboard閉鎖でfocusを失うか、外側操作のfocusを入口へ強制移動する"
// observable = "listboxの開閉、activeElement、Tab eventのdefaultPrevented、onSelect履歴"
// observation_boundary = "component-behavior"
// scope = "CustomAgentPicker dismissal handlers; native Tab traversal after keydown is excluded"
// lifecycle = "permanent"
// impact = "pickerを取消した後に操作位置を見失うか外側での作業を妨げる"
// distinction = "共通a11y helperだけではportal内のイベントと外側dismissのfocus境界を検出できない"
// @end-test-value
test("Custom Agent dismissal preserves the appropriate focus origin", async () => {
  await withPicker(async ({ document, trigger, key, selected }) => {
    const open = async () => act(async () => trigger().click());
    const assertClosedAtTrigger = () => {
      assert.equal(document.querySelector('[role="listbox"]'), null);
      assert.equal(document.activeElement, trigger());
    };
    await open();
    await key("Escape");
    assertClosedAtTrigger();
    await open();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close Agent Picker"]')!.click());
    assertClosedAtTrigger();
    for (const shift of [false, true]) {
      await open();
      const event = await key("Tab", shift);
      assert.equal(event.defaultPrevented, false);
      assertClosedAtTrigger();
    }
    const outside = document.getElementById("outside")!;
    await open();
    await act(async () => outside.focus());
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(document.activeElement, outside);
    await open();
    await act(async () => {
      outside.dispatchEvent(new document.defaultView!.MouseEvent("pointerdown", { bubbles: true }));
      outside.focus();
    });
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.equal(document.activeElement, outside);
    assert.deepEqual(selected, []);
  });
});

// @test-value v2
// kind = "contract"
// claim = "Custom Agentの読込中は候補を操作できず、完了時は選択中または先頭候補へfocusし、disabledでは開かず値を通知しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Action DockのCustom Agent選択" }
// fault = "取得前の候補を選択可能にする、取得完了後にfocus先を失う、またはdisabled入口からpickerを開く"
// observable = "aria-busy、option数、activeElement、trigger disabled、listbox開閉、onSelect履歴"
// observation_boundary = "component-behavior"
// scope = "CustomAgentPicker loading completion and disabled control"
// lifecycle = "permanent"
// impact = "未取得の候補を確定するか、読込後のkeyboard選択が開始できなくなる"
// distinction = "loading component単体や型検査ではpickerへの候補到着とfocus更新を検出できない"
// @end-test-value
test("Custom Agent resolves loading focus and rejects disabled opening", async () => {
  await withPicker(async ({ document, trigger, options, render, selected }) => {
    await render({ items: [], loading: true });
    await act(async () => trigger().click());
    assert.equal(document.querySelector('[role="listbox"]')!.getAttribute("aria-busy"), "true");
    assert.equal(options().length, 0);
    await render({ items: candidates, loading: false });
    assert.equal(document.activeElement, options()[1]);
    await act(async () => trigger().click());
    await render({ items: candidates.map((item) => ({ ...item, isSelected: false })) });
    await act(async () => trigger().click());
    assert.equal(document.activeElement, options()[0]);
    await render({ disabled: true });
    assert.equal(trigger().disabled, true);
    await act(async () => trigger().click());
    assert.equal(document.querySelector('[role="listbox"]'), null);
    assert.deepEqual(selected, []);
  });
});
