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

const SECOND_TEMPLATE: PromptTemplate = {
  ...FIRST_TEMPLATE,
  id: "template-2",
  name: "実装依頼",
  prompt: "この機能を実装して",
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

// @test-value v2
// kind = "contract"
// claim = "Template購読更新後に遅延した初期一覧が返っても選択肢は購読の新しい内容を保持する"
// oracle = { type = "contract", ref = "Issue #737 SessionWindow asynchronous operation lifecycle" }
// fault = "遅延した初期一覧を購読更新より後に適用して古いtemplateへ戻す"
// observable = "pickerに表示されるtemplate名"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace initial load and subscription ordering"
// lifecycle = "permanent"
// impact = "別Windowで更新されたtemplateの古い文面を選択・挿入してしまう"
// distinction = "型検査と通常の初期読込testでは通知が先行する順序を検出できない"
// @end-test-value
test("Template購読更新は遅い初期一覧に巻き戻されない", async () => {
  const harness = createDomHarness();
  let resolveInitial: (templates: PromptTemplate[]) => void = () => {};
  let listener: ((templates: PromptTemplate[]) => void) | null = null;
  const api: WithMateWindowPromptTemplateApi = {
    ...createApi([]),
    listPromptTemplates: () => new Promise((resolve) => { resolveInitial = resolve; }),
    subscribePromptTemplates: (nextListener) => {
      listener = nextListener;
      return () => { listener = null; };
    },
  };
  try {
    await renderAndFlush(harness.root, <PromptTemplateWorkspace api={api} onBack={() => {}} onInsert={() => {}} />);
    await act(async () => {
      listener?.([{ ...FIRST_TEMPLATE, name: "新しいテンプレート" }]);
    });
    await act(async () => {
      resolveInitial([FIRST_TEMPLATE]);
    });
    assert.match(harness.container.textContent ?? "", /新しいテンプレート/);
    assert.doesNotMatch(harness.container.textContent ?? "", /レビュー依頼/);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

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

// @test-value v2
// kind = "contract"
// claim = "一覧取得失敗は編集を開始せずRetryでき、再取得中のbusyを経て一覧とkeyboard focusへ復帰する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "取得失敗を空一覧扱いして編集を許可する、再取得できない、または回復後も操作できない"
// observable = "取得API呼出数、error、Retry、編集buttonのdisabled、busy、optionとfocus、editorへの遷移"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace list failure and retry"
// lifecycle = "permanent"
// impact = "一時的な取得失敗から画面内で回復できず、未取得の一覧を空と誤認する"
// distinction = "正常0件testや型検査では失敗から再取得への非同期遷移とfocusを検出できない"
// @end-test-value
test("Template一覧の取得失敗はRetryから一覧と編集導線へ復帰する", async () => {
  const harness = createDomHarness();
  let listCalls = 0;
  let resolveRetry: (templates: PromptTemplate[]) => void = () => {};
  const api: WithMateWindowPromptTemplateApi = {
    ...createApi([]),
    listPromptTemplates: () => {
      listCalls += 1;
      return listCalls === 1
        ? Promise.reject(new Error("Template storage unavailable"))
        : new Promise((resolve) => { resolveRetry = resolve; });
    },
  };
  try {
    await renderAndFlush(harness.root, <PromptTemplateWorkspace api={api} onBack={() => {}} onInsert={() => {}} />);
    assert.match(harness.container.querySelector('[role="alert"]')?.textContent ?? "", /Template storage unavailable/);
    const edit = harness.container.querySelector<HTMLButtonElement>('[aria-label="Edit template"]')!;
    const retry = Array.from(harness.container.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    assert.ok(retry);
    assert.equal(harness.dom.window.document.activeElement, retry);
    assert.equal(edit.disabled, true);
    assert.equal(harness.container.querySelector('[aria-label="New template"]'), null);
    await act(async () => edit.click());
    assert.equal(harness.container.querySelector("input"), null);

    await act(async () => retry.click());
    assert.equal(listCalls, 2);
    assert.equal(harness.container.querySelector('[aria-label="Template status"]')?.getAttribute("aria-busy"), "true");
    assert.ok(harness.container.querySelector('[aria-label="Loading templates"]'));
    assert.equal(edit.disabled, true);
    assert.equal(harness.dom.window.document.activeElement, harness.container.querySelector('[aria-label="Template status"]'));

    await act(async () => resolveRetry([FIRST_TEMPLATE]));
    const option = harness.container.querySelector('[role="option"]');
    assert.equal(option?.textContent?.trim(), FIRST_TEMPLATE.name);
    assert.equal(harness.dom.window.document.activeElement, option);
    assert.equal(harness.container.querySelector('[role="alert"]'), null);
    assert.equal(harness.container.querySelector('[role="listbox"]')?.getAttribute("aria-busy"), null);
    assert.equal(edit.disabled, false);
    await act(async () => edit.click());
    assert.equal(harness.container.querySelector<HTMLInputElement>('[aria-label="Template name"]')?.value, FIRST_TEMPLATE.name);
  } finally {
    await act(async () => harness.root.unmount());
    harness.dom.window.close();
    harness.restore();
  }
});

// @test-value v2
// kind = "contract"
// claim = "取得失敗後の購読通知は一覧を回復させ、Retry中の通知は後着の取得失敗より優先される"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "取得errorが新しい購読一覧を隠す、または遅延した取得失敗が回復済み一覧を隠す"
// observable = "購読通知後のoption、alertの有無、編集buttonの操作可否"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace list recovery through subscription"
// lifecycle = "permanent"
// impact = "別Windowから受信済みのテンプレートを利用できなくなる"
// distinction = "初期一覧成功の順序testとは異なり取得失敗状態からの回復と遅延rejectを確認する"
// @end-test-value
test("Template購読通知は取得失敗と遅いRetry失敗から一覧を回復する", async () => {
  for (const retryBeforeNotification of [false, true]) {
    const harness = createDomHarness();
    const subscribed = createSubscribedApi([]);
    let listCalls = 0;
    let rejectRetry: (error: Error) => void = () => {};
    subscribed.api.listPromptTemplates = () => {
      listCalls += 1;
      return listCalls === 1
        ? Promise.reject(new Error("Load failed"))
        : new Promise((_resolve, reject) => { rejectRetry = reject; });
    };
    try {
      await renderAndFlush(harness.root, <PromptTemplateWorkspace api={subscribed.api} onBack={() => {}} onInsert={() => {}} />);
      if (retryBeforeNotification) {
        await act(async () => {
          Array.from(harness.container.querySelectorAll("button")).find((button) => button.textContent === "Retry")!.click();
        });
      }
      await act(async () => subscribed.emit([SECOND_TEMPLATE]));
      await act(async () => rejectRetry(new Error("Late load failure")));
      assert.equal(harness.container.querySelector('[role="option"]')?.textContent?.trim(), SECOND_TEMPLATE.name);
      assert.equal(harness.container.querySelector('[role="alert"]'), null);
      assert.equal(harness.container.querySelector<HTMLButtonElement>('[aria-label="Edit template"]')?.disabled, false);
    } finally {
      await act(async () => harness.root.unmount());
      harness.dom.window.close();
      harness.restore();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Save/Delete待ち中は編集対象と退出を固定し、成功・失敗後に操作を戻し、失敗時は入力を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window" }
// fault = "保存・削除待ち中にBやpickerへ切り替わる、遅延応答が別対象を上書きする、失敗時の入力が消える、または操作が復帰しない"
// observable = "API対象IDと本文、一覧選択・Back・New・入力のdisabled、close guard、editor値、busy、完了後の対象切替と再入場"
// observation_boundary = "component-behavior"
// scope = "PromptTemplateWorkspace delayed save/delete success and failure"
// lifecycle = "permanent"
// impact = "利用者が意図した編集対象を取り違え、未保存入力を失う"
// distinction = "既存spinner testや型検査では検出しない、対象切替・退出・応答順・失敗後の入力保護を4つの決定論的caseで確認する"
// @end-test-value
test("Template保存・削除は処理中の対象を固定し成功・失敗後に操作を戻す", async () => {
  for (const action of ["save", "delete"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      const harness = createDomHarness();
      const closeGuard: { current: (() => boolean) | null } = { current: null };
      let resolveMutation: (templates: PromptTemplate[]) => void = () => {};
      let rejectMutation: (error: Error) => void = () => {};
      let targetId: string | undefined;
      let savedPrompt: string | undefined;
      let confirmCalls = 0;
      harness.dom.window.confirm = () => { confirmCalls += 1; return true; };
      const pending = new Promise<PromptTemplate[]>((resolve, reject) => {
        resolveMutation = resolve;
        rejectMutation = reject;
      });
      const api: WithMateWindowPromptTemplateApi = {
        ...createApi([FIRST_TEMPLATE, SECOND_TEMPLATE]),
        updatePromptTemplate: (input) => { targetId = input.id; savedPrompt = input.prompt; return pending; },
        deletePromptTemplate: (id) => { targetId = id; return pending; },
      };
      try {
        await renderAndFlush(harness.root, <PromptTemplateWorkspace
          api={api}
          onRegisterCloseGuard={(guard) => { closeGuard.current = guard; }}
          onBack={() => {}}
          onInsert={() => {}}
        />);
        await act(async () => harness.container.querySelector<HTMLButtonElement>('[aria-label="Edit template"]')!.click());
        const prompt = harness.container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!;
        const editedPrompt = `${FIRST_TEMPLATE.prompt} (edited)`;
        await act(async () => {
          prompt.focus();
          Object.getOwnPropertyDescriptor(harness.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, editedPrompt);
          const change = new harness.dom.window.Event("propertychange", { bubbles: true });
          Object.defineProperty(change, "propertyName", { value: "value" });
          prompt.dispatchEvent(change);
          prompt.dispatchEvent(new harness.dom.window.Event("input", { bubbles: true }));
        });
        const actionButton = harness.container.querySelector<HTMLButtonElement>(`[aria-label="${action === "save" ? "Save" : "Delete"}"]`)!;
        await act(async () => actionButton.click());
        assert.equal(targetId, FIRST_TEMPLATE.id);
        if (action === "save") assert.equal(savedPrompt, editedPrompt);
        assert.equal(actionButton.getAttribute("aria-busy"), "true");
        assert.equal(prompt.disabled, true);
        const back = harness.container.querySelector<HTMLButtonElement>('[aria-label="Back to template selection"]')!;
        const create = harness.container.querySelector<HTMLButtonElement>('[aria-label="New template"]')!;
        const second = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('[aria-pressed]')).find((button) => button.textContent === SECOND_TEMPLATE.name)!;
        assert.equal(back.disabled, true);
        assert.equal(create.disabled, true);
        assert.equal(second.disabled, true);
        const confirmationsBeforeNavigation = confirmCalls;
        await act(async () => { second.click(); back.click(); create.click(); });
        assert.equal(closeGuard.current?.(), false);
        assert.equal(confirmCalls, confirmationsBeforeNavigation);
        assert.equal(harness.container.querySelector<HTMLInputElement>('[aria-label="Template name"]')?.value, FIRST_TEMPLATE.name);
        assert.equal(prompt.value, editedPrompt);

        await act(async () => {
          if (outcome === "failure") rejectMutation(new Error(`${action} failed`));
          else resolveMutation(action === "save" ? [{ ...FIRST_TEMPLATE, prompt: editedPrompt }, SECOND_TEMPLATE] : [SECOND_TEMPLATE]);
        });
        assert.equal(back.disabled, false);
        assert.equal(create.disabled, false);
        assert.equal(second.disabled, false);
        assert.equal(prompt.disabled, false);
        assert.equal(actionButton.getAttribute("aria-busy"), null);
        const expectedName = action === "delete" && outcome === "success" ? SECOND_TEMPLATE.name : FIRST_TEMPLATE.name;
        assert.equal(harness.container.querySelector<HTMLInputElement>('[aria-label="Template name"]')?.value, expectedName);
        assert.equal(prompt.value, action === "delete" && outcome === "success" ? SECOND_TEMPLATE.prompt : editedPrompt);
        if (outcome === "failure") {
          assert.equal(harness.container.querySelector('[role="alert"]')?.textContent, `${action} failed`);
          assert.equal(actionButton.disabled, false);
        }
        assert.equal(closeGuard.current?.(), true);
        await act(async () => second.click());
        assert.equal(prompt.value, SECOND_TEMPLATE.prompt);
        await act(async () => back.click());
        assert.ok(harness.container.querySelector('[role="listbox"]'));
        await act(async () => harness.container.querySelector<HTMLButtonElement>('[aria-label="Edit template"]')!.click());
        assert.equal(harness.container.querySelector<HTMLInputElement>('[aria-label="Template name"]')?.value,
          action === "delete" && outcome === "success" ? SECOND_TEMPLATE.name : FIRST_TEMPLATE.name);
      } finally {
        await act(async () => harness.root.unmount());
        harness.dom.window.close();
        harness.restore();
      }
    }
  }
});

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
    assert.ok(saveButton.querySelector(".button-content-spinner[aria-hidden='true']"));
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
