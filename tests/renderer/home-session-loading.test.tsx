import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import {
  buildNewSession,
  type CreateSessionRequest,
  type HomeSessionSummary,
  type HomeSessionSummaryPageResult,
  type SessionSummaryPageRequest,
} from "../../src-shared/session/session-state.js";
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

function character(id: string): CharacterCatalogEntry {
  return {
    id, name: id, description: "", iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    state: "active", createdAt: "", updatedAt: "", archivedAt: null,
  };
}

function session(id: string, characterId = "used", isPinned = false): HomeSessionSummary {
  return {
    id, taskTitle: id, status: "idle", updatedAt: "2026-09-01T00:00:00.000Z",
    isPinned, workspaceLabel: "Session Folder", workspacePath: `C:\\sessions\\${id}`,
    sessionKind: "default", accessMode: "active", sourceSchemaVersion: 6,
    characterId, character: characterId, characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, runState: "idle",
  };
}

function page(entries: HomeSessionSummary[], nextCursor: string | null = null): HomeSessionSummaryPageResult {
  return { entries, hasMore: nextCursor !== null, nextCursor };
}

function button(container: Element, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  assert.ok(found, `${label} button should exist`);
  return found;
}

type Harness = {
  dom: JSDOM;
  element: HTMLElement;
  requests: CreateSessionRequest[];
  setListPage: (handler: (request: SessionSummaryPageRequest) => Promise<HomeSessionSummaryPageResult>) => void;
  setUsage: (handler: () => Promise<Array<{ characterId: string; sessionKind: "default" }>>) => void;
  setCreate: (handler: (input: CreateSessionRequest) => Promise<ReturnType<typeof buildNewSession>>) => void;
  focus: () => Promise<void>;
  settle: () => Promise<void>;
  launch: () => Promise<HTMLElement>;
  close: () => Promise<void>;
};

async function mountHome(): Promise<Harness> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://withmate.local/",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  let listPage = async (request: SessionSummaryPageRequest) => page(
    request.scope === "open" ? [session("open")] : [],
  );
  let usage = async () => [{ characterId: "used", sessionKind: "default" as const }];
  let create = async (input: CreateSessionRequest) => buildNewSession({
    ...input, id: "created-session", workspaceLabel: "Session Folder",
    workspacePath: "C:\\sessions\\created-session", branch: "", approvalMode: "on-request",
  });
  const requests: CreateSessionRequest[] = [];
  const api: Partial<WithMateWindowApi> = {
    listCharacters: async () => [character("used"), character("unused")],
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
    listSessionSummaryPage: async (request) => listPage(request ?? {}),
    listSessionCharacterUsage: async () => usage(),
    subscribeSessionInvalidation: () => () => {},
    listOpenSessionWindowIds: async () => ["open"],
    subscribeOpenSessionWindowIds: () => () => {},
    getSessionWindowRestoreSet: async () => [],
    subscribeSessionWindowRestoreSet: () => () => {},
    listOpenAuxiliarySessionSummaries: async () => [],
    subscribeLiveSessionRun: () => () => {},
    createSession: async (input) => {
      requests.push(input);
      return create(input);
    },
    openSession: async () => {},
  };
  dom.window.withmate = api as WithMateWindowApi;
  const element = dom.window.document.getElementById("root");
  assert.ok(element);
  let root: Root | null = null;
  const settle = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
  };
  const focus = async () => {
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
  };
  const launch = async () => {
    const newSession = element.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    assert.ok(newSession);
    await act(async () => newSession.click());
    const dialog = element.querySelector<HTMLElement>('[role="dialog"][aria-label="New Session"]');
    assert.ok(dialog);
    const title = dialog.querySelector<HTMLInputElement>("#launch-session-title");
    assert.ok(title);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(title, "Task");
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      button(dialog, "Session Folder").click();
    });
    return dialog;
  };
  const close = async () => {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  };
  try {
    const { createRoot } = await import("react-dom/client");
    const { default: HomeApp } = await import("../../src/home/HomeApp.js");
    await act(async () => {
      root = createRoot(element);
      root.render(<HomeApp />);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    dom, element, requests,
    setListPage: (handler) => { listPage = handler; },
    setUsage: (handler) => { usage = handler; },
    setCreate: (handler) => { create = handler; },
    focus, settle, launch, close,
  };
}

// @test-value v2
// kind = "contract"
// claim = "RecentまたはPinnedだけの取得失敗で他方のSessionは表示され、使用中Characterを除いたRandom開始も可能である"
// oracle = { type = "contract", ref = "GitHub Issue #754 / docs/adr/004-launch-character-random-selection.md Decision" }
// fault = "一覧scopeの一件の失敗を全取得失敗として扱い、成功scopeの表示か独立した抽選入力を捨てる"
// observable = "HomeのSession cardとcreateSessionのcharacterId"
// observation_boundary = "component-behavior"
// scope = "HomeAppの初回・focus再取得とNew Session Random開始"
// lifecycle = "permanent"
// impact = "一部の一覧が使えないだけでSession再開・新規開始を失い、使用中Characterを重複選択する"
// distinction = "summary query単体では確認できないHome表示とdialog起動要求までの結線を実API mockで観測する"
// @end-test-value
test("RecentとPinnedの単独失敗を分離し、Randomは使用中Characterを避ける", async () => {
  const home = await mountHome();
  try {
    home.setListPage(async (request) => {
      if (request.scope === "recent") throw new Error("Recent unavailable");
      return page(request.scope === "open" ? [session("open")] : [session("pinned", "used", true)]);
    });
    await home.settle();
    assert.match(home.element.textContent ?? "", /pinned/);
    assert.match(home.element.textContent ?? "", /Recent unavailable/);
    const dialog = await home.launch();

    home.setListPage(async (request) => {
      if (request.scope === "pinned") throw new Error("Pinned unavailable");
      return page(request.scope === "open" ? [session("open")] : [session("recent")]);
    });
    await home.focus();
    assert.match(home.element.textContent ?? "", /recent/);
    assert.match(home.element.textContent ?? "", /Pinned unavailable/);
    assert.doesNotMatch(dialog.textContent ?? "", /Recent unavailable|Pinned unavailable/);
    assert.equal(dialog.querySelector<HTMLInputElement>("#launch-session-title")?.value, "Task");

    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 1);
    assert.equal(home.requests[0]?.characterId, "unused");
  } finally {
    await home.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "使用履歴の未完了・失敗中はRandomを拒否するが固定Characterは開始でき、回復時はreadiness警告だけが消える"
// oracle = { type = "contract", ref = "docs/adr/004-launch-character-random-selection.md Decision / GitHub Issue #754" }
// fault = "未取得の履歴を0件とみなしてRandom開始するか、一覧の状態変化で無関係な作成失敗を消す"
// observable = "createSession呼出件数、dialog feedback、固定CharacterでのcreateSession要求"
// observation_boundary = "component-behavior"
// scope = "HomeAppの履歴取得とNew Session開始"
// lifecycle = "permanent"
// impact = "抽選重みが未確定の起動や固定Characterの不要な停止、実際の作成失敗の見落としにつながる"
// distinction = "純粋なlaunch guardでは検出できない非同期取得・feedbackの所有と回復遷移を検証する"
// @end-test-value
test("履歴待機・失敗・回復はRandom guardと作成失敗feedbackを分離する", async () => {
  const home = await mountHome();
  const pending = deferred<Array<{ characterId: string; sessionKind: "default" }>>();
  try {
    home.setUsage(() => pending.promise);
    await home.settle();
    const dialog = await home.launch();
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 0);
    assert.match(dialog.textContent ?? "", /history is not ready/i);

    await act(async () => pending.reject(new Error("History unavailable")));
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 0);
    assert.match(dialog.textContent ?? "", /history is unavailable/i);

    home.setUsage(async () => [{ characterId: "used", sessionKind: "default" }]);
    await home.focus();
    assert.doesNotMatch(dialog.textContent ?? "", /history is unavailable/i);

    home.setUsage(async () => { throw new Error("History unavailable again"); });
    await home.focus();

    home.setCreate(async () => { throw new Error("Create failed"); });
    const fixed = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
      .find((item) => item.textContent?.includes("used"));
    assert.ok(fixed);
    await act(async () => fixed.click());
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 1);
    assert.equal(home.requests[0]?.characterId, "used");
    assert.match(dialog.textContent ?? "", /Create failed/);

    home.setListPage(async (request) => {
      if (request.scope === "recent") throw new Error("Recent unavailable during launch");
      return page(request.scope === "open" ? [session("open")] : []);
    });
    home.setUsage(async () => [{ characterId: "used", sessionKind: "default" }]);
    await home.focus();
    assert.match(home.element.querySelector(".home-session-list-feedback")?.textContent ?? "", /Recent unavailable during launch/);
    assert.match(dialog.textContent ?? "", /Create failed/);
    assert.doesNotMatch(dialog.textContent ?? "", /Recent unavailable during launch/);
    home.setListPage(async (request) => page(request.scope === "open" ? [session("open")] : []));
    await home.focus();
    assert.equal(home.element.querySelector(".home-session-list-feedback"), null);
    assert.match(dialog.textContent ?? "", /Create failed/);
  } finally {
    await home.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Open summaryの失敗中は成功したRecent/Pinnedを保持しRandomを拒否し、回復後は再び開始できる"
// oracle = { type = "contract", ref = "docs/adr/004-launch-character-random-selection.md Decision / GitHub Issue #754" }
// fault = "open Window IDだけを確定済みと扱い、使用中Characterのsummary未取得でRandomを開始する"
// observable = "HomeのRecent/Pinned card、createSession呼出件数とcharacterId"
// observation_boundary = "component-behavior"
// scope = "HomeAppのopen summary取得とNew Session Random開始"
// lifecycle = "permanent"
// impact = "使用中Characterが除外されず、同じCharacterでSession Windowが重複起動する"
// distinction = "open ID購読や抽選関数単体と異なり、summary取得失敗をまたぐHome全体の起動経路を検証する"
// @end-test-value
test("Open summary失敗でも一覧を保ちRandomだけ停止し、回復後は使用中Characterを除外する", async () => {
  const home = await mountHome();
  try {
    home.setListPage(async (request) => {
      if (request.scope === "open") throw new Error("Open summary unavailable");
      return page([session(request.scope === "recent" ? "recent" : "pinned", "used", request.scope === "pinned")]);
    });
    await home.settle();
    assert.match(home.element.textContent ?? "", /recent/);
    assert.match(home.element.textContent ?? "", /pinned/);
    const dialog = await home.launch();
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 0);
    assert.match(dialog.textContent ?? "", /open session/i);

    home.setListPage(async (request) => page(
      request.scope === "open" ? [session("open")] : [session(request.scope === "recent" ? "recent" : "pinned")],
    ));
    await home.focus();
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 1);
    assert.equal(home.requests[0]?.characterId, "unused");
  } finally {
    await home.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "履歴とopen summaryが遅延中に追加pageを読み込んでも、後で届く履歴とopen summaryがRandom開始へ反映される"
// oracle = { type = "contract", ref = "docs/adr/004-launch-character-random-selection.md Decision / GitHub Issue #754" }
// fault = "paginationのrequest generation更新が進行中の履歴・open summary結果を破棄し、Randomを止め続けるか使用中Characterを除外しない"
// observable = "追加Session card、createSession呼出件数・characterId"
// observation_boundary = "component-behavior"
// scope = "HomeAppの履歴・open summary取得とRecent pagination、New Session Random開始"
// lifecycle = "permanent"
// impact = "一覧を進めた後にRandom開始が不必要に停止するか、使用中Characterが重複して選ばれる"
// distinction = "取得generation helper単体では検出できないpaginationと独立scope取得の競合を実HomeAppで検証する"
// @end-test-value
test("履歴とopen summaryの遅延中に追加pageが成功してもRandom開始へ反映する", async () => {
  const pendingUsage = deferred<Array<{ characterId: string; sessionKind: "default" }>>();
  const pendingOpen = deferred<HomeSessionSummaryPageResult>();
  const previousObserver = globalThis.IntersectionObserver;
  let trigger!: () => void;
  class TestObserver {
    constructor(callback: IntersectionObserverCallback) {
      trigger = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { value: TestObserver, configurable: true });
  let home: Harness | null = null;
  let pageCalls = 0;
  try {
    home = await mountHome();
    home.setUsage(() => pendingUsage.promise);
    home.setListPage((request) => {
      if (request.scope === "open") return pendingOpen.promise;
      if (request.scope === "pinned") return Promise.resolve(page([]));
      if (request.cursor) {
        pageCalls += 1;
        return Promise.resolve(page([session("second")]));
      }
      return Promise.resolve(page([session("first")], "next"));
    });
    await home.settle();
    assert.match(home.element.textContent ?? "", /first/);
    assert.ok(home.element.querySelector(".home-session-list-load-sentinel"));
    await act(async () => trigger());
    assert.equal(pageCalls, 1);
    assert.match(home.element.textContent ?? "", /second/);

    const dialog = await home.launch();
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 0);
    await act(async () => {
      pendingUsage.resolve([{ characterId: "used", sessionKind: "default" }]);
      pendingOpen.resolve(page([session("open")]));
    });
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 1);
    assert.equal(home.requests[0]?.characterId, "unused");
  } finally {
    await home?.close();
    Object.defineProperty(globalThis, "IntersectionObserver", { value: previousObserver, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "追加page取得失敗時は既存rowを保持し、明示Retry成功後に続きを表示してerrorを解消する"
// oracle = { type = "contract", ref = "GitHub Issue #754 / docs/design/desktop-ui.md RecentSessions" }
// fault = "page失敗を空一覧へ変換するか、errorのままscroll監視が同じpageを自動再試行する"
// observable = "Homeの既存・追加Session card、errorとRetry、page API呼出回数"
// observation_boundary = "component-behavior"
// scope = "HomeRecentSessionsPanelのpaginationとHomeApp取得"
// lifecycle = "permanent"
// impact = "既存Sessionへの到達性が失われるか、継続的な自動再試行で失敗を利用者が回復できない"
// distinction = "page query helper単体では確認できない既存rowの保持とUI Retry導線を観測する"
// @end-test-value
test("追加pageの失敗は行を残し、Retryで続きを表示する", async () => {
  const home = await mountHome();
  let pageCalls = 0;
  try {
    home.setListPage(async (request) => {
      if (request.scope === "open") return page([session("open")]);
      if (request.scope === "pinned") return page([]);
      if (!request.cursor) return page([session("first")], "next");
      pageCalls += 1;
      if (pageCalls === 1) throw new Error("Next page unavailable");
      return page([session("second")]);
    });
    await home.settle();
    assert.match(home.element.textContent ?? "", /first/);
    const sentinel = home.element.querySelector(".home-session-list-load-sentinel");
    assert.ok(sentinel);
    // JSDOM has no IntersectionObserver; install one for the panel's actual pagination callback.
    const previousObserver = globalThis.IntersectionObserver;
    let trigger!: () => void;
    class TestObserver {
      constructor(callback: IntersectionObserverCallback) {
        trigger = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    }
    Object.defineProperty(globalThis, "IntersectionObserver", { value: TestObserver, configurable: true });
    try {
      await home.focus();
      await act(async () => trigger());
      assert.equal(pageCalls, 1);
      assert.match(home.element.textContent ?? "", /first/);
      assert.match(home.element.textContent ?? "", /Next page unavailable/);
      await act(async () => trigger());
      assert.equal(pageCalls, 1);
      await act(async () => button(home.element, "Retry").click());
      assert.equal(pageCalls, 2);
      assert.match(home.element.textContent ?? "", /first/);
      assert.match(home.element.textContent ?? "", /second/);
      assert.doesNotMatch(home.element.textContent ?? "", /Next page unavailable/);
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", { value: previousObserver, configurable: true });
    }
  } finally {
    await home.close();
  }
});

// @test-value v2
// kind = "contract"
// claim = "検索変更後の取得成功を先行するfocus再取得の遅延失敗が上書きせず、最新の一覧とRandom開始条件を維持する"
// oracle = { type = "contract", ref = "docs/features/home-session-pagination.md queryの分離 / GitHub Issue #754" }
// fault = "古いRecentまたは履歴の失敗が新しい取得成功後に反映され、最新の表示とRandom開始を失う"
// observable = "検索後のSession card、一覧feedback、createSessionの呼出件数とCharacter"
// observation_boundary = "component-behavior"
// scope = "HomeAppの検索・focus取得競合とRandom開始"
// lifecycle = "permanent"
// impact = "遅延した失敗が回復済みの一覧を失敗扱いにし、利用可能なSession開始を止める"
// distinction = "generation helper単体では検出できない一覧と利用履歴それぞれの結果反映境界を観測する"
// @end-test-value
test("検索後の成功を先行する一覧・利用履歴の遅延失敗で上書きしない", async () => {
  const home = await mountHome();
  const oldRecent = deferred<HomeSessionSummaryPageResult>();
  const oldUsage = deferred<Array<{ characterId: string; sessionKind: "default" }>>();
  try {
    await home.settle();
    home.setListPage((request) => request.scope === "recent" ? oldRecent.promise
      : Promise.resolve(page(request.scope === "open" ? [session("open")] : [])));
    home.setUsage(() => oldUsage.promise);
    await home.focus();

    home.setListPage(async (request) => page(request.scope === "open" ? [session("open")]
      : request.scope === "recent" ? [session("fresh-recent")] : []));
    home.setUsage(async () => []);
    const search = home.element.querySelector<HTMLInputElement>('[aria-label="Search sessions"] input');
    assert.ok(search);
    await act(async () => {
      Object.getOwnPropertyDescriptor(home.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "fresh");
      search.dispatchEvent(new home.dom.window.Event("input", { bubbles: true }));
    });
    await home.settle();
    await act(async () => {
      oldRecent.reject(new Error("Obsolete recent failure"));
      oldUsage.reject(new Error("Obsolete history failure"));
    });
    assert.match(home.element.querySelector(".home-session-card-list")?.textContent ?? "", /fresh-recent/);
    assert.equal(home.element.querySelector(".home-session-list-feedback"), null);
    const dialog = await home.launch();
    await act(async () => button(dialog, "Start").click());
    assert.equal(home.requests.length, 1);
    assert.equal(home.requests[0]?.characterId, "unused");
  } finally {
    await home.close();
  }
});
