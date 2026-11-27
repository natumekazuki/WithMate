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
// claim = "New SessionのStartと取得待ちのaccessible statusはRandom/固定選択と未取得・失敗・回復を区別する。Randomの設定済みfocusとtitle入力を保ち、Cancelで起点へ戻す"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialog; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "待っている対象が状態に追従しないか取得待ちと実際の開始busyを混同するか、固定選択を妨げるか、取得状態更新・Cancelで設定済みfocusを失う"
// observable = "HomeAppのStart disabled/aria-disabled/busy、取得対象のrole=status名と領域のaria-busyと失敗alert、title値、document.activeElement、作成要求回数"
// observation_boundary = "component-behavior"
// scope = "HomeApp New Session prerequisite transitions"
// lifecycle = "permanent"
// impact = "取得待ちや失敗から回復した利用者がdialogを開き直さず正しい条件で開始・取消できる"
// distinction = "実際の購読からmemo・dialog・buttonまでの更新を外部APIのstubで検証する。click自体のfocus保持・Tab移動・OS/browser挙動は観測せず、Issue #732の#755ブラウザー確認記録が別境界を担う"
// @end-test-value
test("Startは取得状態と選択に追従し、取得状態更新は設定済みfocusを保つ", async () => {
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
    executeCoordination: async () => ({ items: [], total: 0, nextOffset: null }),
    subscribeCoordinationChanged: () => () => {},
    getSessionSummary: async () => null,
    listCharacters: async () => [{
      id: "mia", name: "Mia", description: "", iconFilePath: "",
      theme: { main: "#6f8cff", sub: "#6fb8c7" },
      state: "active", createdAt: "", updatedAt: "", archivedAt: null,
    }],
    getMateState: async () => "not_created",
    getAppSettings: async () => createDefaultAppSettings(),
    subscribeAppSettings: () => () => {},
    getProviderQuotaTelemetry: async () => null,
    subscribeProviderQuotaTelemetry: () => () => {},
    getModelCatalog: async () => ({
      revision: 1,
      providers: [{
        id: "codex", label: "Codex", defaultModelId: "gpt-5.4", defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      }],
    }),
    listSessionSummaryPage: async () => ({ entries: [], hasMore: false, nextCursor: null }),
    listSessionMonitorPage: async () => ({ entries: [], auxiliarySessions: [], hasMore: false, nextCursor: null }),
    listSessionCharacterUsage: async () => {
      usageRequested.resolve();
      if (usageFailed) throw new Error("Usage unavailable");
      return usage.promise;
    },
    onSessionTurnUpdated: () => () => {},
    subscribeSessionInvalidation: (listener) => {
      invalidationListeners.add(listener);
      return () => { invalidationListeners.delete(listener); };
    },
    listOpenSessionWindowIds: () => openWindows.promise,
    subscribeOpenSessionWindowIds: (listener) => { onOpenWindows = listener; return () => {}; },
    getSessionWindowRestoreSet: async () => [],
    subscribeSessionWindowRestoreSet: () => () => {},
    subscribeLiveSessionRunStatus: () => () => {},
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
      assert.equal(dialog.querySelector('.home-launch-feedback [role="status"]'), null);
      await act(async () => random.click());
      // JSDOMのclickはnative focus移動を再現しない。以降の取得状態更新の前提を設定する。
      random.focus();
      assertReady(randomReady);
    };

    assertReady(false);
    const readiness = dialog.querySelector(".home-launch-feedback")!;
    const pending = (label: string) => {
      assert.equal(readiness.getAttribute("aria-busy"), "true");
      assert.ok(readiness.querySelector(`[role="status"][aria-label="${label}"]`));
      assert.equal(readiness.textContent, "");
    };
    const settled = (error?: string) => {
      assert.equal(readiness.hasAttribute("aria-busy"), false);
      assert.equal(readiness.querySelector('[role="status"]'), null);
      assert.equal(readiness.querySelector('[role="alert"]')?.textContent, error);
    };
    pending("Loading session history for random character selection");
    await assertFixedThenRandom(false);
    await act(async () => usage.resolve([]));
    assertReady(false);
    pending("Loading open session windows for random character selection");
    await act(async () => openWindows.reject(new Error("Windows unavailable")));
    assertReady(false);
    settled("Open session windows are unavailable, so random selection cannot start.");
    await assertFixedThenRandom(false);
    await act(async () => onOpenWindows([]));
    assertReady(true);
    settled();
    assert.equal(dom.window.document.activeElement, random);

    usageFailed = true;
    await act(async () => invalidate());
    assertReady(false);
    settled("Session history is unavailable, so random selection cannot start.");
    assert.equal(dom.window.document.activeElement, random);
    await assertFixedThenRandom(false);
    usageFailed = false;
    await act(async () => invalidate());
    assertReady(true);
    settled();
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
