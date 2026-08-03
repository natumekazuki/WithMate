import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ComposerAttachmentMenu } from "../../src/chat/composer-attachment-menu.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("ComposerAttachmentMenu は単一popoverに添付操作を分類し、選択後に閉じる", async () => {
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    PointerEvent: globalThis.PointerEvent,
  };
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div><button id=\"outside\">Outside</button></body></html>", {
    pretendToBeVisual: true,
  });
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  let copiedToSessionFiles = 0;

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    MouseEvent: { configurable: true, value: dom.window.MouseEvent },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
  });

  function Harness() {
    const [isOpen, setIsOpen] = useState(false);
    return (
      <ComposerAttachmentMenu
        disabled={false}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        onPickFile={() => {}}
        onPickFolder={() => {}}
        onPickImage={() => {}}
        onAddToSessionFiles={() => {
          copiedToSessionFiles += 1;
        }}
        onPickSessionFiles={() => {}}
        onPickSessionFolder={() => {}}
        onPickSessionImage={() => {}}
      />
    );
  }

  try {
    await act(async () => root.render(<Harness />));
    const attachButton = container.querySelector<HTMLButtonElement>("[aria-haspopup=\"menu\"]");
    assert.equal(attachButton?.textContent?.trim(), "＋Attach");
    assert.equal(container.querySelectorAll("[aria-haspopup=\"menu\"]").length, 1);

    await act(async () => {
      attachButton?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    assert.deepEqual(
      Array.from(container.querySelectorAll(".composer-attachment-menu-section-label")).map((item) => item.textContent),
      ["Attach", "Session files"],
    );
    const menuItems = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=\"menuitem\"]"));
    assert.deepEqual(menuItems.map((item) => item.textContent), ["File", "Folder", "Image", "Copy", "File", "Folder", "Image"]);
    assert.equal(dom.window.document.activeElement, menuItems[0]);

    await act(async () => {
      menuItems[0]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    assert.equal(dom.window.document.activeElement, menuItems[1]);

    await act(async () => {
      menuItems[1]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(container.querySelector("[role=\"menu\"]"), null);
    assert.equal(dom.window.document.activeElement, attachButton);

    await act(async () => attachButton?.click());
    const copyButton = container.querySelector<HTMLButtonElement>("[aria-label=\"ファイルをSession Filesへコピーして添付\"]");
    await act(async () => copyButton?.click());
    assert.equal(copiedToSessionFiles, 1);
    assert.equal(container.querySelector("[role=\"menu\"]"), null);

    await act(async () => attachButton?.click());
    await act(async () => {
      dom.window.document.getElementById("outside")?.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    });
    assert.equal(container.querySelector("[role=\"menu\"]"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previousGlobals.window },
      document: { configurable: true, value: previousGlobals.document },
      Node: { configurable: true, value: previousGlobals.Node },
      HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
      Event: { configurable: true, value: previousGlobals.Event },
      MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
      KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
      PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
    });
  }
});
