import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { buildNewSession, type CreateSessionRequest } from "../../src-shared/session/session-state.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createCharacter(id: string): CharacterCatalogEntry {
  return {
    id, name: id, description: "", iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    state: "active", createdAt: "", updatedAt: "", archivedAt: null,
  };
}

function createDeferred<T>() {
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
// claim = "New Sessionは開いた時のCharacter一覧を表示・選択・起動候補に保持し、Homeの遅延取得や再フォーカス取得から分離する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog / GitHub Issue #745" }
// fault = "Homeの取得開始・成功・失敗が開いているdialogの一覧、選択、focus、scroll、起動候補を上書きする"
// observable = "Home管理一覧の更新とエラー、dialogの選択済みradioとfocus/scroll保持、createSessionのCharacter、再表示後の最新一覧"
// observation_boundary = "component-behavior"
// scope = "HomeAppのCharacter取得とNew Sessionの開閉・開始"
// lifecycle = "permanent"
// impact = "別Windowから戻った際の入力中断や、表示と異なるCharacterでの起動を防ぐ"
// distinction = "dialog単体では検出できないHomeのfocus購読・初回取得・起動要求とのstate結線を検証する"
// @end-test-value
test("HomeのCharacter再取得中もNew Sessionの一覧を維持し、再表示時に最新化する", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://withmate.local/",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const initialLoad = createDeferred<CharacterCatalogEntry[]>();
  const focusLoad = createDeferred<CharacterCatalogEntry[]>();
  const failedFocusLoad = createDeferred<CharacterCatalogEntry[]>();
  const openingEntries = [createCharacter("Opening Character")];
  const latestEntries = [createCharacter("Latest Character")];
  let listCalls = 0;
  const requests: CreateSessionRequest[] = [];
  const openedSessionIds: string[] = [];
  const api: Partial<WithMateWindowApi> = {
    listCharacters: async () => {
      listCalls += 1;
      switch (listCalls) {
        case 1: return initialLoad.promise;
        case 2: return openingEntries;
        case 3: return focusLoad.promise;
        case 4: return failedFocusLoad.promise;
        default: return latestEntries;
      }
    },
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
    listSessionCharacterUsage: async () => [],
    subscribeSessionInvalidation: () => () => {},
    listOpenSessionWindowIds: async () => [],
    subscribeOpenSessionWindowIds: () => () => {},
    getSessionWindowRestoreSet: async () => [],
    subscribeSessionWindowRestoreSet: () => () => {},
    listOpenAuxiliarySessionSummaries: async () => [],
    subscribeLiveSessionRun: () => () => {},
    createSession: async (input) => {
      requests.push(input);
      return buildNewSession({
        ...input, id: "created-session", workspaceLabel: "Session Folder",
        workspacePath: "C:\\sessions\\created-session", branch: "", approvalMode: "on-request",
      });
    },
    openSession: async (id) => { openedSessionIds.push(id); },
  };
  dom.window.withmate = api as WithMateWindowApi;

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  try {
    const { createRoot } = await import("react-dom/client");
    const { default: HomeApp } = await import("../../src/home/HomeApp.js");
    await act(async () => {
      root = createRoot(rootElement);
      root.render(<HomeApp />);
    });
    await act(async () => findButton(rootElement, "Characters").click());
    const homeCharacters = rootElement.querySelector('[role="tabpanel"][aria-label="Characters"]');
    assert.ok(homeCharacters);
    const newSession = rootElement.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    assert.ok(newSession);
    await act(async () => newSession.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const dialog = rootElement.querySelector('[role="dialog"][aria-label="New Session"]');
    assert.ok(dialog);
    const title = dialog.querySelector<HTMLInputElement>("#launch-session-title");
    const list = dialog.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Character"]');
    const selected = list?.querySelector<HTMLButtonElement>('button:last-child');
    assert.ok(title && list && selected);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(title, "Task");
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      findButton(dialog, "Session Folder").click();
      selected.click();
      selected.focus();
    });
    list.scrollTop = 80;
    const start = findButton(dialog, "Start");
    const assertDialogStable = () => {
      assert.equal(dialog.querySelector('[role="radiogroup"][aria-label="Character"]'), list);
      assert.equal(list.querySelector('[aria-checked="true"]'), selected);
      assert.equal(dom.window.document.activeElement, selected);
      assert.equal(list.scrollTop, 80);
      assert.equal(title.value, "Task");
      assert.equal(start.disabled, false);
      assert.deepEqual(Array.from(list.querySelectorAll("strong"), (node) => node.textContent), ["Random", "Opening Character"]);
    };
    assertDialogStable();

    await act(async () => initialLoad.resolve([createCharacter("Late Initial Character")]));
    assert.match(homeCharacters.textContent ?? "", /Late Initial Character/);
    assertDialogStable();

    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(listCalls, 3);
    assert.match(homeCharacters.textContent ?? "", /Loading characters/);
    assertDialogStable();
    await act(async () => focusLoad.resolve(latestEntries));
    assert.match(homeCharacters.textContent ?? "", /Latest Character/);
    assertDialogStable();

    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.equal(listCalls, 4);
    assertDialogStable();
    await act(async () => failedFocusLoad.reject(new Error("Home catalog refresh failed")));
    assert.match(homeCharacters.textContent ?? "", /Home catalog refresh failed/);
    assertDialogStable();

    const randomOption = list.querySelector<HTMLButtonElement>('[role="radio"]');
    assert.ok(randomOption);
    await act(async () => randomOption.click());
    await act(async () => start.click());
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.characterId, "Opening Character");
    assert.equal(requests[0]?.character, "Opening Character");
    assert.deepEqual(openedSessionIds, ["created-session"]);
    assert.equal(rootElement.querySelector('[role="dialog"]'), null);

    await act(async () => newSession.click());
    assert.equal(listCalls, 5);
    const reopenedList = rootElement.querySelector('[role="dialog"] [role="radiogroup"][aria-label="Character"]');
    assert.ok(reopenedList);
    assert.deepEqual(Array.from(reopenedList.querySelectorAll("strong"), (node) => node.textContent), ["Random", "Latest Character"]);
    assert.match(reopenedList.querySelector('[aria-checked="true"]')?.textContent ?? "", /Random/);
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});
