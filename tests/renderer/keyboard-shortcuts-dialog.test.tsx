import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeyboardShortcutsDialog } from "../../src/settings/KeyboardShortcutsDialog.js";
import { DEFAULT_KEYBOARD_SHORTCUT_SETTINGS } from "../../src/settings/shortcut-registry.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installDomGlobals(dom: JSDOM): () => void {
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "MutationObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: dom.window.MutationObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });

  return () => {
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  };
}

// @test-value v2
// kind = "contract"
// claim = "Keyboard shortcuts dialogはregistry由来のPascalCase labelを表示し、最初のChange操作へfocusしてEscapeで閉じられる"
// oracle = { type = "contract", ref = "src/settings/KeyboardShortcutsDialog.tsx#KeyboardShortcutsDialog" }
// fault = "registry labelがdialogへ投影されない、最初の操作へfocusしない、またはEscapeでdialogを閉じられない"
// observable = "dialog textContent、最初のChange buttonへのfocus、Close callback回数、Escape eventのdefaultPrevented"
// observation_boundary = "component-behavior"
// scope = "keyboard-shortcuts-dialog-projection"
// lifecycle = "permanent"
// impact = "利用者がshortcutの対象を識別できず、最初の編集操作へ到達できないか、dialogをキーボードで閉じられない"
// distinction = "registryの表示label、初期focus、dialog固有のEscape closeを同じ描画経路で確認する"
// @end-test-value
test("Keyboard shortcuts dialogはregistry projectionを表示し、Escapeで閉じる", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const restore = installDomGlobals(dom);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root: Root = createRoot(container);
  let closeCount = 0;

  try {
    await act(async () => {
      root.render(
        <KeyboardShortcutsDialog
          open
          platform="macos"
          onClose={() => {
            closeCount += 1;
          }}
          onChange={() => undefined}
        />,
      );
    });

    const dialog = container.querySelector<HTMLElement>("[role='dialog']");
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-label"), "Keyboard shortcuts");
    assert.match(container.textContent ?? "", /FindMessages/);
    assert.match(container.textContent ?? "", /⌘F/);
    assert.match(container.textContent ?? "", /SendMessage/);
    assert.match(container.textContent ?? "", /⌘Enter/);

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const firstChangeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Change");
    assert.ok(firstChangeButton);
    assert.equal(dom.window.document.activeElement, firstChangeButton);

    const dialogContent = container.querySelector<HTMLElement>(".settings-keyboard-shortcuts-dialog");
    assert.ok(dialogContent);
    const escapeEvent = new dom.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      dialogContent.dispatchEvent(escapeEvent);
    });
    assert.equal(closeCount, 1);
    assert.equal(escapeEvent.defaultPrevented, true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
    dom.window.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Keyboard shortcuts dialogのChange操作はPascalCase registry labelで対象rowを識別し、押下したacceleratorを設定へ反映する"
// oracle = { type = "contract", ref = "src/settings/KeyboardShortcutsDialog.tsx#shortcut change" }
// fault = "対象shortcut rowを見つけられないか、Change後のacceleratorをsettingsへ反映しない"
// observable = "ToggleMessageCollapse/SendMessage/FindMessages row、PressKeys状態、更新後accelerator"
// observation_boundary = "component-behavior"
// scope = "keyboard-shortcuts-dialog-change"
// lifecycle = "permanent"
// impact = "利用者が意図したshortcutを登録できない"
// distinction = "表示labelの変更とChange・keydownによるsettings更新を同一componentで確認する"
// @end-test-value
test("Keyboard shortcuts dialogはChangeで押下した組み合わせを設定へ反映する", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const restore = installDomGlobals(dom);
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root: Root = createRoot(container);

  function Harness() {
    const [settings, setSettings] = useState(DEFAULT_KEYBOARD_SHORTCUT_SETTINGS);
    return (
      <KeyboardShortcutsDialog
        open
        platform="windows"
        settings={settings}
        onChange={setSettings}
        onClose={() => undefined}
      />
    );
  }

  try {
    await act(async () => {
      root.render(<Harness />);
    });

    const row = Array.from(container.querySelectorAll<HTMLElement>(".settings-keyboard-shortcut-row"))
      .find((candidate) => candidate.textContent?.includes("ToggleMessageCollapse"));
    assert.ok(row);
    const changeButton = Array.from(row.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Change");
    assert.ok(changeButton);

    const sendRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-keyboard-shortcut-row"))
      .find((candidate) => candidate.textContent?.includes("SendMessage"));
    assert.ok(sendRow);
    assert.ok(Array.from(sendRow.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Change"));

    const browserShortcutRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-keyboard-shortcut-row"))
      .find((candidate) => candidate.textContent?.includes("FindMessages"));
    assert.ok(browserShortcutRow);
    assert.equal(browserShortcutRow.querySelector("button"), null);

    act(() => {
      changeButton.click();
    });
    assert.match(row.textContent ?? "", /PressKeys/);

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "x",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    assert.match(row.textContent ?? "", /Ctrl\+Shift\+X/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
    dom.window.close();
  }
});
