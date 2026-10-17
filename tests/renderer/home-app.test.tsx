import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import { buildNewSession, projectHomeSessionSummary, type CreateSessionRequest } from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
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
    getProviderQuotaTelemetry: async () => null,
    subscribeProviderQuotaTelemetry: () => () => {},
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
    subscribeLiveSessionRunStatus: () => () => {},
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
    assert.ok(homeCharacters.querySelector('[aria-label="Loading characters"]'));
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

// @test-value v2
// kind = "contract"
// claim = "Settingsのapp settingsとmodel catalogは個別に読込・回復し、その未完了や失敗でMemory diagnosticsの表示と準備済みの操作を塞がずcatalogの購読更新も画面へ反映する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#runtime-policy and GitHub Issue #744" }
// fault = "Settingsの初回readを一括待機し、別領域の内容や操作を隠すか、失敗後の再取得またはcatalog購読更新の表示をできなくする"
// observable = "deferred API応答中のSettings section、独立したLoadError/LoadingIndicator、Import Models操作、Retry後と購読更新後のprovider row"
// observation_boundary = "component-behavior"
// scope = "Settings Window independent initial reads, recovery and model catalog subscription"
// lifecycle = "permanent"
// @end-test-value
test("Settingsは独立したreadのpending/error中も準備済み領域を表示・操作できる", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://withmate.local/?mode=settings",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const firstSettingsLoad = createDeferred<ReturnType<typeof createDefaultAppSettings>>();
  const firstCatalogLoad = createDeferred<ModelCatalogSnapshot | null>();
  let settingsCalls = 0;
  let catalogCalls = 0;
  const catalogListeners = new Set<(snapshot: ModelCatalogSnapshot) => void>();
  let imports = 0;
  const savedSettings: ReturnType<typeof createDefaultAppSettings>[] = [];
  const originalSettings = {
    ...createDefaultAppSettings(),
    memoryExtractionProviderSettings: {
      codex: {
        ...createDefaultAppSettings().memoryExtractionProviderSettings.codex,
        model: "preserve-this-memory-model",
      },
    },
  };
  const catalog: ModelCatalogSnapshot = {
    revision: 2,
    providers: [{
      id: "codex", label: "Codex", defaultModelId: "gpt-5.4", defaultReasoningEffort: "high",
      models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
    }],
  };
  const api: Partial<WithMateWindowApi> = {
    getAppSettings: async () => {
      settingsCalls += 1;
      if (settingsCalls === 1) return firstSettingsLoad.promise;
      return originalSettings;
    },
    subscribeAppSettings: () => () => {},
    getModelCatalog: async () => {
      catalogCalls += 1;
      if (catalogCalls === 1) return firstCatalogLoad.promise;
      return catalog;
    },
    subscribeModelCatalog: (listener) => {
      catalogListeners.add(listener);
      return () => { catalogListeners.delete(listener); };
    },
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
    importModelCatalogFile: async () => { imports += 1; return null; },
    updateAppSettings: async (settings) => { savedSettings.push(settings); return settings; },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  try {
    const [{ default: HomeApp }, { createRoot }] = await Promise.all([
      import("../../src/home/HomeApp.js"),
      import("react-dom/client"),
    ]);
    await act(async () => {
      const mountedRoot = createRoot(rootElement);
      root = mountedRoot;
      mountedRoot.render(<HomeApp />);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    assert.ok(rootElement.querySelector(".settings-window-shell"));
    assert.ok(rootElement.querySelector('[aria-label="Loading app settings"]'));
    assert.ok(rootElement.querySelector('[aria-label="Loading model catalog"]'));
    assert.ok(rootElement.textContent?.includes("stopped"), "diagnostics should resolve independently");
    const importButton = findButton(rootElement, "Import Models");
    assert.equal(importButton.disabled, false);
    await act(async () => importButton.click());
    assert.equal(imports, 1);

    await act(async () => firstSettingsLoad.reject(new Error("Settings unavailable")));
    assert.match(rootElement.textContent ?? "", /Settings unavailable/);
    await act(async () => firstCatalogLoad.reject(new Error("Catalog unavailable")));
    assert.match(rootElement.textContent ?? "", /Catalog unavailable/);
    assert.ok(rootElement.textContent?.includes("stopped"), "catalog error should not hide diagnostics");

    const settingsRetry = rootElement.querySelector<HTMLButtonElement>(".load-error button");
    assert.ok(settingsRetry);
    await act(async () => settingsRetry.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(settingsCalls, 2);
    assert.ok(rootElement.querySelector('[aria-label="Save Settings"]'));

    const appSettingToggle = rootElement.querySelector<HTMLInputElement>(
      ".settings-app-settings-fieldset input[type=checkbox]",
    );
    assert.ok(appSettingToggle);
    await act(async () => appSettingToggle.click());
    await act(async () => findButton(rootElement, "Save Settings").click());
    assert.equal(savedSettings[0]?.memoryExtractionProviderSettings.codex?.model, "preserve-this-memory-model");

    const catalogError = Array.from(rootElement.querySelectorAll(".load-error"))
      .find((error) => error.textContent?.includes("Catalog unavailable"));
    const catalogRetry = catalogError?.querySelector<HTMLButtonElement>("button");
    assert.ok(catalogRetry);
    await act(async () => catalogRetry.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(catalogCalls, 2);
    assert.ok(rootElement.textContent?.includes("Codex"));

    assert.equal(catalogListeners.size, 1);
    await act(async () => {
      for (const listener of catalogListeners) {
        listener({
          ...catalog,
          revision: 3,
          providers: catalog.providers.map((provider) => ({ ...provider, label: "Updated Codex" })),
        });
      }
    });
    assert.ok(rootElement.textContent?.includes("Updated Codex"));
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Homeの既存Session一覧とopen操作はmate statusの未完了から独立して利用できる"
// oracle = { type = "contract", ref = "GitHub Issue #744" }
// fault = "mate statusをHome全体のgateとして、取得中に既存Sessionを隠すかopen操作を無効にする"
// observable = "mate API readがpendingの間に描画された既存Session rowとopenSession API呼び出し"
// observation_boundary = "component-behavior"
// scope = "Home existing session operations during independent app-state read"
// lifecycle = "permanent"
// @end-test-value
test("Homeのmate status read中も既存Sessionを開ける", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://withmate.local/",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

  const mateLoad = createDeferred<MateStorageState>();
  const opened: string[] = [];
  const session = buildNewSession({
    id: "existing-during-mate-load",
    taskTitle: "Existing task",
    workspaceLabel: "Workspace",
    workspacePath: "C:\\workspace",
    branch: "main",
    characterId: "character-1",
    character: "Mia",
    characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
    approvalMode: "on-request",
  });
  const api: Partial<WithMateWindowApi> = {
    getMateState: () => mateLoad.promise,
    getAppSettings: async () => new Promise(() => {}),
    subscribeAppSettings: () => () => {},
    getModelCatalog: async () => new Promise(() => {}),
    subscribeModelCatalog: () => () => {},
    listCharacters: async () => new Promise(() => {}),
    listSessionSummaryPage: async (request) => ({
      entries: request?.scope === "recent" ? [session] : [],
      hasMore: false,
      nextCursor: null,
    }),
    listSessionCharacterUsage: async () => [],
    subscribeSessionInvalidation: () => () => {},
    listOpenSessionWindowIds: async () => [],
    subscribeOpenSessionWindowIds: () => () => {},
    listOpenAuxiliarySessionSummaries: async () => [],
    subscribeLiveSessionRunStatus: () => () => {},
    getSessionWindowRestoreSet: async () => [],
    subscribeSessionWindowRestoreSet: () => () => {},
    openSession: async (id) => { opened.push(id); },
  };
  dom.window.withmate = api as WithMateWindowApi;
  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  try {
    const [{ default: HomeApp }, { createRoot }] = await Promise.all([
      import("../../src/home/HomeApp.js"),
      import("react-dom/client"),
    ]);
    await act(async () => {
      const mountedRoot = createRoot(rootElement);
      root = mountedRoot;
      mountedRoot.render(<HomeApp />);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });

    assert.ok(rootElement.textContent?.includes("Existing task"));
    const openRow = rootElement.querySelector<HTMLButtonElement>(".home-session-card-open");
    assert.ok(openRow);
    assert.equal(openRow.disabled, false);
    await act(async () => openRow.click());
    assert.deepEqual(opened, ["existing-during-mate-load"]);
    assert.ok(rootElement.querySelector('[aria-label="Loading app state"]'));
  } finally {
    await act(async () => root?.unmount());
    mateLoad.resolve("active");
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Homeと独立Monitorは同じquota cache表示とlive通知の実行・取消・承認状態の変化から最新summaryを再取得し、MainとAuxiliaryをリロードなしで表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window / 共通仕様のlive eventと軽量summary再読込" }
// fault = "quotaの表示経路を接続し忘れる、実行・承認状態だけの変化を捨てる、通知payloadをsnapshotの代わりに表示する、終了後のlive stateを見落とす、または本文更新ごとにsummaryを再取得する"
// observable = "provider残率とcacheOnly引数、Approval/Running/Stopped sectionの親card、Main/Auxiliaryのaccessible状態、summary API取得回数、unmount後のlive購読数"
// observation_boundary = "component-behavior"
// scope = "HomeAppのlive event購読とMonitor描画（home/monitor mode、Main/Auxiliary）"
// lifecycle = "permanent"
// impact = "開いている会話の実行状態が古いまま残り、停止確認や実行中会話の識別ができなくなることを防ぐ"
// distinction = "projection単体・型検査・refresher単体では検出できない通知の重複判定からsummary取得と画面更新への結線を、小さなin-memory APIで確認する"
// @end-test-value
test("Homeと独立MonitorはMainとAuxiliaryの実行状態をlive通知から同期する", async () => {
  for (const mode of ["home", "monitor"]) {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: `https://withmate.local/?mode=${mode}`,
    });
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });

    let summary = projectHomeSessionSummary(buildNewSession({
      id: "monitor-parent", taskTitle: "Monitor task", workspaceLabel: "Workspace",
      workspacePath: "C:\\workspace", branch: "main", characterId: "character-1", character: "Mia",
      characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request",
    }));
    let auxiliary: AuxiliarySessionSummary = {
      id: "monitor-aux", parentSessionId: summary.id, status: "active", runState: "idle",
      title: "Auxiliary", preview: "Auxiliary task", provider: "codex", catalogRevision: 1,
      model: "gpt-5.4", reasoningEffort: "high", approvalMode: "on-request", codexSpeed: "standard",
      codexReviewer: "auto-review", codexSandboxMode: "danger-full-access", customAgentName: "",
      allowedAdditionalDirectories: [], threadId: "", displayAfterMessageIndex: null,
      createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", closedAt: "",
    };
    const liveListeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRunStatus"]>[0]>();
    let summaryReads = 0;
    let auxiliaryReads = 0;
    const quotaReads: Parameters<WithMateWindowApi["getProviderQuotaTelemetry"]>[] = [];
    const api: Partial<WithMateWindowApi> = {
      getMateState: async () => "not_created",
      getAppSettings: async () => createDefaultAppSettings(),
      subscribeAppSettings: () => () => {},
      getProviderQuotaTelemetry: async (...args) => {
        quotaReads.push(args);
        return { provider: "codex", updatedAt: null, snapshots: [], rateLimits: [
          { quotaKey: "codex:primary", usedPercentage: 34, windowDurationMinutes: 10080 },
        ] };
      },
      subscribeProviderQuotaTelemetry: () => () => {},
      getModelCatalog: async () => new Promise(() => {}),
      subscribeModelCatalog: () => () => {},
      listCharacters: async () => [],
      listSessionSummaryPage: async (request) => {
        summaryReads += 1;
        return { entries: request?.scope === "pinned" ? [] : [summary], hasMore: false, nextCursor: null };
      },
      listSessionCharacterUsage: async () => [],
      subscribeSessionInvalidation: () => () => {},
      listOpenSessionWindowIds: async () => [summary.id],
      subscribeOpenSessionWindowIds: () => () => {},
      getSessionWindowRestoreSet: async () => [],
      subscribeSessionWindowRestoreSet: () => () => {},
      listOpenAuxiliarySessionSummaries: async () => {
        auxiliaryReads += 1;
        return [auxiliary];
      },
      subscribeLiveSessionRunStatus: (listener) => {
        liveListeners.add(listener);
        return () => { liveListeners.delete(listener); };
      },
    };
    dom.window.withmate = api as WithMateWindowApi;
    const rootElement = dom.window.document.getElementById("root");
    assert.ok(rootElement);
    const createLiveState = (
      sessionId: string,
      runState: string,
      cancellationState?: LiveSessionRunState["cancellationState"],
    ): LiveSessionRunState => ({
      sessionId, threadId: "thread-1", runState, cancellationState, assistantText: "",
      steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
    });
    const emitLive = async (sessionId: string, state: LiveSessionRunState | null) => {
      await act(async () => {
        const status = projectLiveSessionRunStatus(state);
        for (const listener of liveListeners) listener(sessionId, status);
      });
    };
    const assertMonitor = (section: "approval" | "running" | "inactive", mainLabel: string, auxiliaryLabel: string) => {
      const card = rootElement.querySelector(`[aria-labelledby="home-monitor-${section}"] .home-monitor-card`);
      assert.ok(card, `${mode}: parent card should be in ${section}`);
      assert.ok(card.querySelector(`[aria-label="Main ${mainLabel}"]`), `${mode}: Main ${mainLabel}`);
      assert.ok(card.querySelector(`[aria-label="Auxiliary ${auxiliaryLabel}: 1"]`), `${mode}: Auxiliary ${auxiliaryLabel}`);
      assert.equal(rootElement.querySelectorAll(".home-monitor-card").length, 1);
    };
    let root: Root | null = null;
    try {
      const [{ default: HomeApp }, { createRoot }] = await Promise.all([
        import("../../src/home/HomeApp.js"), import("react-dom/client"),
      ]);
      await act(async () => {
        root = createRoot(rootElement);
        root.render(<HomeApp />);
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
      assertMonitor("inactive", "Idle", "Idle");
      const quotas = rootElement.querySelector('[aria-label="Provider Quotas"]');
      assert.ok(quotas);
      assert.match(quotas.textContent ?? "", /Codex7d 66%/);
      assert.deepEqual(quotaReads, [["codex", { cacheOnly: true }]]);
      await emitLive(summary.id, null);

      summary = { ...summary, status: "running", runState: "running" };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      assertMonitor("running", "Running", "Idle");

      const readsBeforeStreaming = [summaryReads, auxiliaryReads];
      await emitLive(summary.id, { ...createLiveState(summary.id, "running"), assistantText: "Streaming text" });
      assert.deepEqual([summaryReads, auxiliaryReads], readsBeforeStreaming);

      const approvalRequest = { requestId: "approval-1", provider: "codex", kind: "command", title: "Command", summary: "Run command", decisionMode: "direct-decision" as const };
      const pendingMain = { ...createLiveState(summary.id, "running"), approvalRequest };
      await emitLive(summary.id, pendingMain);
      assertMonitor("running", "Running", "Idle");
      summary = { ...summary, approvalPending: true };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      await emitLive(summary.id, pendingMain);
      assertMonitor("approval", "Approval Required", "Idle");
      const readsBeforeApprovalText = [summaryReads, auxiliaryReads];
      await emitLive(summary.id, { ...pendingMain, assistantText: "More text" });
      assert.deepEqual([summaryReads, auxiliaryReads], readsBeforeApprovalText);
      summary = { ...summary, approvalPending: false };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      assertMonitor("running", "Running", "Idle");

      summary = { ...summary, status: "idle", runState: "idle" };
      await emitLive(summary.id, null);
      assertMonitor("inactive", "Idle", "Idle");

      summary = { ...summary, status: "running", runState: "running" };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      assertMonitor("running", "Running", "Idle");
      for (const [cancellationState, label] of [["requested", "Canceling"], ["terminating", "Waiting For Stop"]] as const) {
        summary = { ...summary, cancellationState };
        await emitLive(summary.id, createLiveState(summary.id, "running", cancellationState));
        assertMonitor("running", label, "Idle");
      }
      summary = { ...summary, status: "idle", runState: "idle", cancellationState: undefined };
      await emitLive(summary.id, { ...createLiveState(summary.id, "idle"), reasoningText: "Retained reasoning" });
      assertMonitor("inactive", "Idle", "Idle");

      await emitLive(auxiliary.id, null);
      auxiliary = { ...auxiliary, runState: "running" };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "running"));
      assertMonitor("running", "Idle", "Running");
      auxiliary = { ...auxiliary, approvalPending: true };
      await emitLive(auxiliary.id, { ...createLiveState(auxiliary.id, "running"), approvalRequest });
      assertMonitor("approval", "Idle", "Approval Required");
      auxiliary = { ...auxiliary, approvalPending: false };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "running"));
      assertMonitor("running", "Idle", "Running");
      auxiliary = { ...auxiliary, runState: "error" };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "error"));
      assertMonitor("inactive", "Idle", "Error");
      auxiliary = { ...auxiliary, runState: "running" };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "running"));
      assertMonitor("running", "Idle", "Running");
      auxiliary = { ...auxiliary, runState: "idle" };
      await emitLive(auxiliary.id, null);
      assertMonitor("inactive", "Idle", "Idle");
    } finally {
      await act(async () => root?.unmount());
      assert.equal(liveListeners.size, 0);
      dom.window.close();
      Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
      Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
      Object.defineProperty(globalThis, "HTMLElement", { value: previousHTMLElement, configurable: true });
    }
  }
});
