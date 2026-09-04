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

function createSubscribedApi(templates: PromptTemplate[]) {
  let listener: ((nextTemplates: PromptTemplate[]) => void) | null = null;
  const api: WithMateWindowPromptTemplateApi = {
    ...createApi(templates),
    subscribePromptTemplates: (nextListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
  };
  return {
    api,
    emit: (nextTemplates: PromptTemplate[]) => listener?.(nextTemplates),
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

// @test-value v1
// kind = "contract"
// claim = "PromptTemplateWorkspaceは初期表示でtemplate選択操作を主導線にする"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "起動直後から編集modeになりprompt挿入導線が隠れる"
// scope = "PromptTemplateWorkspace initial mode"
// lifecycle = "permanent"
// @end-test-value
test("PromptTemplateWorkspace は初期表示を選択専用modeにする", async () => {
  const harness = createDomHarness();
  let backCount = 0;
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([FIRST_TEMPLATE])}
        onBack={() => {
          backCount += 1;
        }}
        onInsert={() => {}}
      />,
    );

    assert.match(harness.container.textContent ?? "", /Templates/);
    assert.ok(harness.container.querySelector("button[aria-label=\"Edit template\"]"));
    assert.ok(harness.container.querySelector("button.surface-close-button[aria-label=\"Close templates\"]"));
    assert.ok(harness.container.querySelector("[role=\"listbox\"]"));
    assert.equal(harness.container.querySelector("input"), null);
    assert.equal(harness.container.querySelector("textarea"), null);
    assert.equal(
      Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Insert"),
      false,
    );

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button.surface-close-button")?.click();
    });
    assert.equal(backCount, 1);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v1
// kind = "contract"
// claim = "Template workspaceは外部close guardを登録し未変更状態ならcloseを許可する"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "未変更でもwindow closeを阻止するかguard未登録で編集状態を失う"
// scope = "PromptTemplateWorkspace close guard"
// lifecycle = "permanent"
// @end-test-value
test("Templateは外部close guardを登録し、clean stateでは閉じられる", async () => {
  const harness = createDomHarness();
  let closeGuard: (() => boolean) | null = null;
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([FIRST_TEMPLATE])}
        onRegisterCloseGuard={(guard) => {
          closeGuard = guard;
        }}
        onBack={() => {}}
        onInsert={() => {}}
      />,
    );

    assert.ok(closeGuard);
    assert.equal(closeGuard?.(), true);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v1
// kind = "regression"
// claim = "template一覧更新はworkspace内の既存EditまたはClose buttonのfocusを維持する"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "background更新でkeyboard操作中のfocusが失われる"
// scope = "PromptTemplateWorkspace focus preservation"
// lifecycle = "permanent"
// @end-test-value
test("Template更新はworkspace内のEditとCloseの既存フォーカスを奪わない", async () => {
  const harness = createDomHarness();
  const subscribedApi = createSubscribedApi([FIRST_TEMPLATE]);
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={subscribedApi.api}
        onBack={() => {}}
        onInsert={() => {}}
      />,
    );

    const editButton = harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Edit template\"]");
    const closeButton = harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Close templates\"]");
    assert.ok(editButton);
    assert.ok(closeButton);

    editButton.focus();
    await act(async () => {
      subscribedApi.emit([{ ...FIRST_TEMPLATE, name: "更新されたテンプレート" }]);
      await Promise.resolve();
    });
    assert.equal(harness.dom.window.document.activeElement, editButton);

    closeButton.focus();
    await act(async () => {
      subscribedApi.emit([{ ...FIRST_TEMPLATE, prompt: "更新されたprompt" }]);
      await Promise.resolve();
    });
    assert.equal(harness.dom.window.document.activeElement, closeButton);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v1
// kind = "contract"
// claim = "選択modeのtemplate選択は保存済みpromptを挿入しChat表示へ戻す"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "選択したpromptがcomposerへ入らないかworkspaceが閉じない"
// scope = "PromptTemplateWorkspace insert flow"
// lifecycle = "permanent"
// @end-test-value
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

// @test-value v1
// kind = "invariant"
// claim = "編集modeでtemplateを選ぶとeditor対象だけが切り替わりcomposerへ挿入しない"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "編集対象の選択がprompt挿入として実行される"
// scope = "PromptTemplateWorkspace edit selection"
// lifecycle = "permanent"
// @end-test-value
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
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Edit template\"]")?.click();
    });
    assert.ok(harness.container.querySelector("input"));
    assert.ok(harness.container.querySelector("input[aria-label=\"Template name\"]"));
    assert.equal(harness.container.textContent?.includes("Name"), false);
    assert.ok(harness.container.querySelector("textarea[aria-label=\"Prompt\"]"));
    assert.ok(Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Save"));
    assert.ok(Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Delete"));
    assert.equal(
      Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Insert"),
      false,
    );

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>(".prompt-template-list-item")?.click();
    });
    assert.deepEqual(inserted, []);

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Back to Template selection\"]")?.click();
    });
    const option = harness.container.querySelector<HTMLButtonElement>("[role=\"option\"]");
    assert.ok(option);
    assert.equal(harness.dom.window.document.activeElement, option);
    assert.equal(harness.container.querySelector("textarea"), null);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v1
// kind = "contract"
// claim = "挿入不可状態のtemplateはpromptを挿入せず編集modeへの導線を残す"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "read-only等の挿入不可contextでcomposerを変更するか編集導線も失う"
// scope = "PromptTemplateWorkspace insertion capability"
// lifecycle = "permanent"
// @end-test-value
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
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Edit template\"]")?.click();
    });
    assert.ok(harness.container.querySelector("textarea[aria-label=\"Prompt\"]"));
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v1
// kind = "contract"
// claim = "templateが0件の選択modeでも新規template作成へ遷移できる"
// oracle = { type = "contract", ref = "docs/features/prompt-template-workspace.md" }
// failure_mode = "empty stateからtemplateを作成できず機能が行き止まりになる"
// scope = "PromptTemplateWorkspace empty state"
// lifecycle = "permanent"
// @end-test-value
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

    assert.match(harness.container.textContent ?? "", /No templates yet\./);
    const createButton = Array.from(harness.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "+ New template");
    assert.ok(createButton);
    assert.equal(harness.container.querySelector("input"), null);

    await act(async () => createButton.click());
    assert.ok(harness.container.querySelector("input"));
    assert.ok(harness.container.querySelector("textarea[aria-label=\"Prompt\"]"));
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});
