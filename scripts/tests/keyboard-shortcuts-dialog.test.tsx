import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeyboardShortcutsDialog } from "../../src/settings/KeyboardShortcutsDialog.js";

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
        />,
      );
    });

    const dialog = container.querySelector<HTMLElement>("[role='dialog']");
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-label"), "Keyboard shortcuts");
    assert.match(container.textContent ?? "", /Find messages/);
    assert.match(container.textContent ?? "", /⌘F/);
    assert.match(container.textContent ?? "", /Send message/);
    assert.match(container.textContent ?? "", /⌘Enter/);

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const closeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Close");
    assert.ok(closeButton);
    assert.equal(dom.window.document.activeElement, closeButton);

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
