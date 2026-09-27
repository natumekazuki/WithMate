import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { Session, SessionCharacterUsage } from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function findButton(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.trim() === text
  );
  assert.ok(button, `${text} button should exist`);
  return button;
}

// @test-value v2
// kind = "contract"
// claim = "New SessionのStartはRandomの取得状態と固定選択への切替に追従し、入力・focusと開始中busyを維持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog / docs/manual-test-checklist.md MT-014D" }
// fault = "取得状態の配線やmemo依存が欠落してStartが更新されないか、固定選択を妨げるか、状態更新で入力・focusを失う"
// observable = "HomeAppのStart disabled/aria-disabled/busy、title値、Character選択focus、作成要求回数、Cancel後のfocus"
// observation_boundary = "component-behavior"
// scope = "HomeApp New Session prerequisite transitions"
// lifecycle = "permanent"
// impact = "取得待ちや失敗から回復した利用者がdialogを開き直さず正しい条件で開始・取消できる"
// distinction = "純粋関数の状態表では検出できない実際の購読からmemo・dialog・buttonまでの更新を、外部APIだけをstubして検証する"
// @end-test-value
test("Startは取得状態とRandom/固定切替に追従してbusyとfocusを保つ", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://withmate.local/",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const usageRequested = deferred<void>();
  const usage = deferred<SessionCharacterUsage[]>();
  const openWindows = deferred<string[]>();
  const creation = deferred<Session>();
  let usageFailed = false;
  let createCount = 0;
  let onOpenWindows: Parameters<WithMateWindowApi["subscribeOpenSessionWindowIds"]>[0] = () => {};
  const invalidationListeners = new Set<Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]>();
  const invalidate = () => invalidationListeners.forEach((listener) => listener({ scope: "all" }));
  const api: Partial<WithMateWindowApi> = {
    listCharacters: async () => [{
      id: "mia", name: "Mia", description: "", iconFilePath: "",
      theme: { main: "#6f8cff", sub: "#6fb8c7" },
      state: "active", createdAt: "", updatedAt: "", archivedAt: null,
    }],
    getMateState: async () => "not_created",
    getAppSettings: async () => createDefaultAppSettings(),
    subscribeAppSettings: () => () => {},
    getModelCatalog: async () => ({
      revision: 1,
      providers: [{
        id: "codex", label: "Codex", defaultModelId: "gpt-5.4", defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      }],
    }),
    getMemoryV6Diagnostics: async () => ({
      generatedAt: "",
      runtime: {
        status: "stopped", applicationInstanceId: null, runtimeGenerationId: null,
        buildChannel: null, discoveryPublished: false,
      },
      cliShim: {
        platform: "win32", commandName: "withmate-memory", supported: true,
        status: "not-installed", pathContainsShimDirectory: false,
      },
      lastErrors: [],
    }),
    listSessionSummaryPage: async () => ({ entries: [], hasMore: false, nextCursor: null }),
    listSessionCharacterUsage: async () => {
      usageRequested.resolve();
      if (usageFailed) throw new Error("Usage unavailable");
      return usage.promise;
    },
    subscribeSessionInvalidation: (listener) => {
      invalidationListeners.add(listener);
      return () => { invalidationListeners.delete(listener); };
    },
    listOpenSessionWindowIds: () => openWindows.promise,
    subscribeOpenSessionWindowIds: (listener) => { onOpenWindows = listener; return () => {}; },
    getSessionWindowRestoreSet: async () => [],
    subscribeSessionWindowRestoreSet: () => () => {},
    listOpenAuxiliarySessionSummaries: async () => [],
    subscribeLiveSessionRun: () => () => {},
    createSession: () => { createCount += 1; return creation.promise; },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const container = dom.window.document.getElementById("root")!;
  let root: Root | null = null;
  try {
    const { createRoot } = await import("react-dom/client");
    const { default: HomeApp } = await import("../../src/home/HomeApp.js");
    await act(async () => { root = createRoot(container); root.render(<HomeApp />); });
    await act(async () => { await usageRequested.promise; });
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="New session"]')!;
    opener.focus();
    await act(async () => opener.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = container.querySelector('[role="dialog"][aria-label="New Session"]')!;
    const title = dialog.querySelector<HTMLInputElement>("#launch-session-title")!;
    const characters = dialog.querySelector('[role="radiogroup"][aria-label="Character"]')!;
    const random = characters.querySelector<HTMLButtonElement>('[role="radio"]:first-child')!;
    const specific = characters.querySelector<HTMLButtonElement>('[role="radio"]:last-child')!;
    const start = findButton(dialog, "Start");
    const cancel = findButton(dialog, "Cancel");
    assert.equal(dom.window.document.activeElement, title);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(title, "Task");
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      findButton(dialog, "Session Folder").click();
      random.focus();
    });
    const assertReady = (ready: boolean) => {
      assert.equal(start.disabled, !ready);
      assert.equal(start.getAttribute("aria-disabled"), String(!ready));
      assert.equal(start.hasAttribute("aria-busy"), false);
      assert.equal(title.value, "Task");
      assert.equal(cancel.disabled, false);
    };
    const assertFixedThenRandom = async (randomReady: boolean) => {
      await act(async () => specific.click());
      assertReady(true);
      await act(async () => random.click());
      random.focus();
      assertReady(randomReady);
    };

    assertReady(false);
    await assertFixedThenRandom(false);
    await act(async () => usage.resolve([]));
    assertReady(false);
    await act(async () => openWindows.reject(new Error("Windows unavailable")));
    assertReady(false);
    await assertFixedThenRandom(false);
    await act(async () => onOpenWindows([]));
    assertReady(true);
    assert.equal(dom.window.document.activeElement, random);

    usageFailed = true;
    await act(async () => invalidate());
    assertReady(false);
    assert.equal(dom.window.document.activeElement, random);
    await assertFixedThenRandom(false);
    usageFailed = false;
    await act(async () => invalidate());
    assertReady(true);
    assert.equal(dom.window.document.activeElement, random);

    assert.equal(createCount, 0);
    await act(async () => start.click());
    assert.equal(createCount, 1);
    assert.equal(start.disabled, true);
    assert.equal(start.getAttribute("aria-busy"), "true");
    assert.equal(start.getAttribute("aria-label"), "Starting session");
    await act(async () => creation.reject(new Error("Creation stopped for test")));
    assertReady(true);
    await act(async () => cancel.click());
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(dom.window.document.activeElement, opener);
    assert.equal(createCount, 1);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});
