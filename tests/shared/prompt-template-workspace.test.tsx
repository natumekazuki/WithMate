import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { PromptTemplate } from "../../src-shared/prompt-template.js";
import { PromptTemplateWorkspace } from "../../src/prompt-templates/PromptTemplateWorkspace.js";
import type { WithMateWindowPromptTemplateApi } from "../../src-shared/ipc/withmate-window-api.js";

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
    InputEvent: globalThis.InputEvent,
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
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.addEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", {
    configurable: true,
    value(this: HTMLElement, name: string, listener: EventListener) {
      this.removeEventListener(name.replace(/^on/, ""), listener);
    },
  });
  Object.defineProperty(dom.window, "confirm", { configurable: true, value: () => true });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    Event: { configurable: true, value: dom.window.Event },
    InputEvent: { configurable: true, value: dom.window.InputEvent },
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
        InputEvent: { configurable: true, value: previousGlobals.InputEvent },
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

// @test-value v2
// kind = "contract"
// claim = "Prompt template workspaceは外部close guardを登録し、未変更状態ではcloseを許可する"
// oracle = { type = "contract", ref = "PromptTemplateWorkspace close guard contract" }
// fault = "close guardが登録されない、またはclean stateを不要に拒否する"
// observable = "登録guardの存在とclean stateでの戻り値"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace external close guard"
// lifecycle = "permanent"
// @end-test-value
test("Templateは外部close guardを登録し、clean stateでは閉じられる", async () => {
  const harness = createDomHarness();
  const closeGuard: { current: (() => boolean) | null } = { current: null };
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace
        api={createApi([FIRST_TEMPLATE])}
        onRegisterCloseGuard={(guard) => {
          closeGuard.current = guard;
        }}
        onBack={() => {}}
        onInsert={() => {}}
      />,
    );

    assert.ok(closeGuard.current);
    assert.equal(closeGuard.current!(), true);
  } finally {
    await act(async () => harness.root.unmount());
    assert.equal(closeGuard.current, null);
    harness.dom.window.close();
    harness.restore();
  }
});

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

// @test-value v2
// kind = "contract"
// claim = "Template編集modeはprompt本文を挿入せず、sentence-caseの戻る操作で選択modeへ戻りfocusを復帰する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "編集modeの選択や戻る操作がchatへpromptを挿入する、または戻り先とaccessible labelが不一致になる"
// observable = "inserted prompt list、Prompt textareaの有無、Back to template selection button、選択optionへのfocus"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace edit navigation"
// lifecycle = "permanent"
// impact = "テンプレート本文を意図せずchatへ送らず、既存の選択・編集・戻る導線を維持する"
// distinction = "表示labelだけでなく、編集mode中の選択、戻り後のoption、focusと挿入callbackを同時に確認する"
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
    assert.ok(Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Save Template"));
    assert.ok(Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Delete Template"));
    assert.equal(
      Array.from(harness.container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Insert"),
      false,
    );

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>(".prompt-template-list-item")?.click();
    });
    assert.deepEqual(inserted, []);

    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Back to template selection\"]")?.click();
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

// @test-value v2
// kind = "contract"
// claim = "Prompt templateの主保存操作は短いlabelを維持し、保存中だけ局所busyを示す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "保存操作が無反応に見える、または保存中に別操作を許可してテンプレート本文を取り違える"
// observable = "Save buttonのlabel・aria-busy・spinner・disabled state"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace save action"
// lifecycle = "permanent"
// impact = "保存対象と処理中状態を識別でき、テンプレート本文・名前の既存編集境界を維持する"
// distinction = "API結果だけを確認するテストでは検出できない、保存中の操作フィードバックと入力制御を確認する"
// @end-test-value
test("Template保存は短いCTAと局所spinnerを表示する", async () => {
  const harness = createDomHarness();
  let resolveUpdate: ((templates: PromptTemplate[]) => void) | null = null;
  const api: WithMateWindowPromptTemplateApi = {
    ...createApi([FIRST_TEMPLATE]),
    updatePromptTemplate: async () => new Promise<PromptTemplate[]>((resolve) => {
      resolveUpdate = resolve;
    }),
  };
  try {
    await renderAndFlush(
      harness.root,
      <PromptTemplateWorkspace api={api} onBack={() => {}} onInsert={() => {}} />,
    );
    await act(async () => {
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Edit template\"]")?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const prompt = harness.container.querySelector<HTMLTextAreaElement>("textarea[aria-label=\"Prompt\"]");
    const templateName = harness.container.querySelector<HTMLInputElement>("input[aria-label=\"Template name\"]");
    assert.ok(prompt);
    assert.ok(templateName);
    await act(async () => {
      const nextPrompt = `${FIRST_TEMPLATE.prompt} (edited)`;
      const valueSetter = Object.getOwnPropertyDescriptor(
        harness.dom.window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      prompt.focus();
      valueSetter?.call(prompt, nextPrompt);
      const propertyChange = new harness.dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(propertyChange, "propertyName", { value: "value" });
      prompt.dispatchEvent(propertyChange);
      prompt.dispatchEvent(new harness.dom.window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: " (edited)",
      }));
    });

    const saveButton = Array.from(harness.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.getAttribute("aria-label") === "Save");
    assert.ok(saveButton);
    await act(async () => {
      saveButton.click();
    });

    assert.equal(saveButton.disabled, true);
    assert.equal(saveButton.getAttribute("aria-label"), "Saving template");
    assert.equal(saveButton.textContent?.trim(), "Save Template");
    assert.equal(saveButton.getAttribute("aria-busy"), "true");
    assert.ok(saveButton.querySelector(".chat-skill-picker-spinner"));
    assert.equal(prompt.disabled, true);
    assert.equal(templateName.disabled, true);

    await act(async () => {
      resolveUpdate?.([{ ...FIRST_TEMPLATE, prompt: `${FIRST_TEMPLATE.prompt} (edited)` }]);
      await Promise.resolve();
    });
    assert.equal(saveButton.getAttribute("aria-busy"), null);
    assert.equal(saveButton.getAttribute("aria-label"), "Save");
    assert.equal(saveButton.textContent?.trim(), "Save Template");
    assert.equal(prompt.disabled, false);
    assert.equal(templateName.disabled, false);
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
      harness.container.querySelector<HTMLButtonElement>("button[aria-label=\"Edit template\"]")?.click();
    });
    assert.ok(harness.container.querySelector("textarea[aria-label=\"Prompt\"]"));
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Templateが0件でもempty stateの新規作成iconから名前・本文の編集modeへ進める"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "empty stateから新規作成へ進めない、accessible nameが見つからない、または編集fieldを描画しない"
// observable = "New template accessible name、Template name input、Prompt textarea"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace empty template creation"
// lifecycle = "permanent"
// impact = "保存済みtemplateがない初回利用でも、選択workspaceから編集・作成の入口を失わない"
// distinction = "empty表示の文言だけでなく、実際に新規editorへ遷移して編集対象fieldが利用可能になることを確認する"
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

    const createButton = harness.container.querySelector<HTMLButtonElement>('button[aria-label="New template"]');
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
