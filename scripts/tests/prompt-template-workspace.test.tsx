import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { PromptTemplate } from "../../src/prompt-template.js";
import { PromptTemplateWorkspace } from "../../src/prompt-templates/PromptTemplateWorkspace.js";
import type { WithMateWindowPromptTemplateApi } from "../../src/withmate-window-api.js";

const FIRST_TEMPLATE: PromptTemplate = {
  id: "template-1",
  name: "レビュー依頼",
  prompt: "この変更をレビューして",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createApi(templates: PromptTemplate[]): WithMateWindowPromptTemplateApi {
  return {
    listPromptTemplates: async () => templates,
    createPromptTemplate: async () => templates,
    updatePromptTemplate: async () => templates,
    deletePromptTemplate: async () => templates,
    subscribePromptTemplates: () => () => {},
  };
}

function createDomHarness() {
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    PointerEvent: globalThis.PointerEvent,
    navigator: globalThis.navigator,
  };
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => true });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    MouseEvent: { configurable: true, value: dom.window.MouseEvent },
    KeyboardEvent: { configurable: true, value: dom.window.KeyboardEvent },
    PointerEvent: { configurable: true, value: dom.window.PointerEvent ?? dom.window.MouseEvent },
    navigator: { configurable: true, value: dom.window.navigator },
  });

  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  return {
    dom,
    container,
    root,
    restore: () => {
      Object.defineProperties(globalThis, {
        window: { configurable: true, value: previousGlobals.window },
        document: { configurable: true, value: previousGlobals.document },
        Node: { configurable: true, value: previousGlobals.Node },
        HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
        Event: { configurable: true, value: previousGlobals.Event },
        MouseEvent: { configurable: true, value: previousGlobals.MouseEvent },
        KeyboardEvent: { configurable: true, value: previousGlobals.KeyboardEvent },
        PointerEvent: { configurable: true, value: previousGlobals.PointerEvent },
        navigator: { configurable: true, value: previousGlobals.navigator },
      });
    },
  };
}

async function renderAndFlush(root: Root, element: React.ReactElement): Promise<void> {
  await act(async () => root.render(element));
  await act(async () => {
    await Promise.resolve();
  });
}

test("PromptTemplateWorkspace は初期表示を選択専用modeにする", async () => {
  const harness = createDomHarness();
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([FIRST_TEMPLATE])}
        onBack={() => {}}
        onInsert={() => {}}
      />,
    );

    assert.match(harness.container.textContent ?? "", /Templates/);
    assert.ok(harness.container.querySelector("button[aria-label=\"Templateを編集\"]"));
    assert.ok(harness.container.querySelector("[role=\"listbox\"]"));
    assert.equal(harness.container.querySelector("input"), null);
    assert.equal(harness.container.querySelector("textarea"), null);
    assert.equal(
      Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "挿入"),
      false,
    );
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

test("Template選択は保存済みpromptを即時挿入し、呼び出し側のChat表示へ戻れる", async () => {
  const harness = createDomHarness();
  const inserted: string[] = [];
  try {
    function Harness() {
      const [isOpen, setIsOpen] = React.useState(true);
      return isOpen ? (
        <PromptTemplateWorkspace
          api={createApi([FIRST_TEMPLATE])}
          onBack={() => setIsOpen(false)}
          onInsert={(prompt) => {
            inserted.push(prompt);
            setIsOpen(false);
          }}
        />
      ) : <p data-chat="true">Chat</p>;
    }

    await renderAndFlush(harness.root, <Harness />);
    const option = harness.container.querySelector<HTMLButtonElement>("[role=\"option\"]");
    assert.ok(option);
    assert.equal(harness.dom.window.document.activeElement, option);

    await act(async () => {
      option.dispatchEvent(new harness.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    assert.deepEqual(inserted, [FIRST_TEMPLATE.prompt]);
    assert.ok(harness.container.querySelector("[data-chat=\"true\"]"));
    assert.equal(harness.container.querySelector(".prompt-template-workspace"), null);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

test("編集modeのTemplate選択はeditorだけを切り替え、挿入導線を持たない", async () => {
  const harness = createDomHarness();
  const inserted: string[] = [];
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([FIRST_TEMPLATE])}
        onBack={() => {}}
        onInsert={(prompt) => inserted.push(prompt)}
      />,
    );

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Templateを編集\"]")?.click();
    });
    assert.ok(harness.container.querySelector("input"));
    assert.ok(harness.container.querySelector("textarea[aria-label=\"プロンプト\"]"));
    assert.ok(Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "保存"));
    assert.ok(Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "削除"));
    assert.equal(
      Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "挿入"),
      false,
    );

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>(".prompt-template-list-item")?.click();
    });
    assert.deepEqual(inserted, []);

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Back to Template selection\"]")?.click();
    });
    assert.ok(harness.container.querySelector("[role=\"option\"]"));
    assert.equal(harness.container.querySelector("textarea"), null);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

test("canInsert=false の選択項目は挿入せず、編集modeへの導線を維持する", async () => {
  const harness = createDomHarness();
  const inserted: string[] = [];
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([FIRST_TEMPLATE])}
        canInsert={false}
        onBack={() => {}}
        onInsert={(prompt) => inserted.push(prompt)}
      />,
    );

    const option = harness.container.querySelector<HTMLButtonElement>("[role=\"option\"]");
    assert.ok(option?.disabled);
    await act(async () => option?.click());
    assert.deepEqual(inserted, []);

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Templateを編集\"]")?.click();
    });
    assert.ok(harness.container.querySelector("textarea[aria-label=\"プロンプト\"]"));
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

test("Templateが0件でも選択modeから新規作成へ進める", async () => {
  const harness = createDomHarness();
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([])}
        onBack={() => {}}
        onInsert={() => {}}
      />,
    );

    assert.match(harness.container.textContent ?? "", /Templateがありません。/);
    const createButton = Array.from(harness.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "＋ 新規作成");
    assert.ok(createButton);
    assert.equal(harness.container.querySelector("input"), null);

    await act(async () => createButton.click());
    assert.ok(harness.container.querySelector("input"));
    assert.ok(harness.container.querySelector("textarea[aria-label=\"プロンプト\"]"));
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});
