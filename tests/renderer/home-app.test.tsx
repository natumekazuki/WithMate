import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Root } from "react-dom/client";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import type { MateStorageState } from "../../src-shared/mate/mate-state.js";
import {
  buildNewSession,
  projectHomeSessionSummary,
  type CreateSessionRequest,
} from "../../src-shared/session/session-state.js";
import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type {
  LiveElicitationRequest,
  LiveSessionRunState,
} from "../../src-shared/session/runtime-state.js";
import { projectLiveSessionRunStatus } from "../../src-shared/session/live-session-run-status.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** 起動ダイアログで表示名と選択 ID が一致する有効な Character を用意する。 */
function createCharacter(id: string): CharacterCatalogEntry {
  return {
    id,
    name: id,
    description: "",
    iconFilePath: "",
    theme: { main: "#6f8cff", sub: "#6fb8c7" },
    state: "active",
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
  };
}

/** 非同期データの成功と失敗を、画面操作の前後で任意に発生させる。 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 指定範囲から表示名の一致するボタンを探し、見つからなければ失敗とする。 */
function findButton(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
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
/** 開いている起動ダイアログの選択、入力、フォーカスを Home の一覧再取得から分離し、次回の表示でだけ最新の一覧を使う。 */
test("HomeのCharacter再取得中もNew Sessionの一覧を維持し、再表示時に最新化する", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });

  const initialLoad = createDeferred<CharacterCatalogEntry[]>();
  const focusLoad = createDeferred<CharacterCatalogEntry[]>();
  const failedFocusLoad = createDeferred<CharacterCatalogEntry[]>();
  const openingEntries = [createCharacter("Opening Character")];
  const latestEntries = [createCharacter("Latest Character")];
  let listCalls = 0;
  const requests: CreateSessionRequest[] = [];
  const openedSessionIds: string[] = [];
  const api: Partial<WithMateWindowApi> = {
    /** 初回取得、起動時の一覧、再フォーカス時の成否を呼び出し順に再現する。 */
    listCharacters: async () => {
      listCalls += 1;
      switch (listCalls) {
        case 1:
          return initialLoad.promise;
        case 2:
          return openingEntries;
        case 3:
          return focusLoad.promise;
        case 4:
          return failedFocusLoad.promise;
        default:
          return latestEntries;
      }
    },
    /** Mate が未作成の Home を使用する。 */
    getMateState: async () => "not_created",
    /** 起動時の設定に規定のプロバイダーを用意する。 */
    getAppSettings: async () => createDefaultAppSettings(),
    /** 設定変更を発生させず、Character の再取得だけを操作する。 */
    subscribeAppSettings: () => () => {},
    /** 未表示のプロバイダー使用枠は空として返す。 */
    getProviderQuotaTelemetry: async () => null,
    /** クォータの変化は Character 一覧に影響させない。 */
    subscribeProviderQuotaTelemetry: () => () => {},
    /** 選択できるプロバイダーと既定モデルを一件に固定する。 */
    getModelCatalog: async () => ({
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-5.4",
          defaultReasoningEffort: "high",
          models: [
            { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] },
          ],
        },
      ],
    }),
    /** 既存会話の履歴を空とする。 */
    listSessionSummaryPage: async () => ({
      entries: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** 稼働一覧に Main と Auxiliary がいない場合を返す。 */
    listSessionMonitorPage: async () => ({
      entries: [],
      auxiliarySessions: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** 調整画面の項目は空として返す。 */
    executeCoordination: async () => ({
      items: [],
      total: 0,
      nextOffset: null,
    }),
    /** 調整一覧の変更通知は配信しない。 */
    subscribeCoordinationChanged: () => () => {},
    /** 個別要約の読取から既存会話を返さない。 */
    getSessionSummary: async () => null,
    /** Character の過去の使用状況は用意しない。 */
    listSessionCharacterUsage: async () => [],
    /** 会話一覧の失効通知は発生させない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 既存ターンの進行通知は発生させない。 */
    onSessionTurnUpdated: () => () => {},
    /** 起動前に開いた会話を列挙しない。 */
    listOpenSessionWindowIds: async () => [],
    /** 既存ウィンドウの開閉イベントを発生させない。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** 再起動から復元するウィンドウはない状態にする。 */
    getSessionWindowRestoreSet: async () => [],
    /** 復元対象の変化は通知しない。 */
    subscribeSessionWindowRestoreSet: () => () => {},
    /** 既存会話の実行通知は配信しない。 */
    subscribeLiveSessionRunStatus: () => () => {},
    /** ダイアログのスナップショットから送られた作成要求を保存し、成功した会話を返す。 */
    createSession: async (input) => {
      requests.push(input);
      return buildNewSession({
        ...input,
        id: "created-session",
        workspaceLabel: "Session Folder",
        workspacePath: "C:\\sessions\\created-session",
        branch: "",
        approvalMode: "on-request",
      });
    },
    /** 作成成功後に開く対象の会話 ID を記録する。 */
    openSession: async (id) => {
      openedSessionIds.push(id);
    },
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
    const homeCharacters = rootElement.querySelector(
      '[role="tabpanel"][aria-label="Characters"]',
    );
    assert.ok(homeCharacters);
    const newSession = rootElement.querySelector<HTMLButtonElement>(
      '[aria-label="New session"]',
    );
    assert.ok(newSession);
    await act(async () => newSession.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const dialog = rootElement.querySelector(
      '[role="dialog"][aria-label="New Session"]',
    );
    assert.ok(dialog);
    const title = dialog.querySelector<HTMLInputElement>(
      "#launch-session-title",
    );
    const list = dialog.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="Character"]',
    );
    const selected =
      list?.querySelector<HTMLButtonElement>("button:last-child");
    assert.ok(title && list && selected);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(title, "Task");
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      findButton(dialog, "Session Folder").click();
      selected.click();
      selected.focus();
    });
    list.scrollTop = 80;
    const start = findButton(dialog, "Start");
    /** 一覧の要素、選択・フォーカス・スクロール、タイトルと起動可否が変化していないことをまとめて確かめる。 */
    const assertDialogStable = () => {
      assert.equal(
        dialog.querySelector('[role="radiogroup"][aria-label="Character"]'),
        list,
      );
      assert.equal(list.querySelector('[aria-checked="true"]'), selected);
      assert.equal(dom.window.document.activeElement, selected);
      assert.equal(list.scrollTop, 80);
      assert.equal(title.value, "Task");
      assert.equal(start.disabled, false);
      assert.deepEqual(
        Array.from(list.querySelectorAll("strong"), (node) => node.textContent),
        ["Random", "Opening Character"],
      );
    };
    assertDialogStable();

    await act(async () =>
      initialLoad.resolve([createCharacter("Late Initial Character")]),
    );
    assert.match(homeCharacters.textContent ?? "", /Late Initial Character/);
    assertDialogStable();

    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.equal(listCalls, 3);
    assert.ok(
      homeCharacters.querySelector('[aria-label="Loading characters"]'),
    );
    assertDialogStable();
    await act(async () => focusLoad.resolve(latestEntries));
    assert.match(homeCharacters.textContent ?? "", /Latest Character/);
    assertDialogStable();

    await act(async () =>
      dom.window.dispatchEvent(new dom.window.Event("focus")),
    );
    assert.equal(listCalls, 4);
    assertDialogStable();
    await act(async () =>
      failedFocusLoad.reject(new Error("Home catalog refresh failed")),
    );
    assert.match(
      homeCharacters.textContent ?? "",
      /Home catalog refresh failed/,
    );
    assertDialogStable();

    const randomOption =
      list.querySelector<HTMLButtonElement>('[role="radio"]');
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
    const reopenedList = rootElement.querySelector(
      '[role="dialog"] [role="radiogroup"][aria-label="Character"]',
    );
    assert.ok(reopenedList);
    assert.deepEqual(
      Array.from(
        reopenedList.querySelectorAll("strong"),
        (node) => node.textContent,
      ),
      ["Random", "Latest Character"],
    );
    assert.match(
      reopenedList.querySelector('[aria-checked="true"]')?.textContent ?? "",
      /Random/,
    );
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Settingsのapp settingsとmodel catalogは個別に読込・回復し、その未完了や失敗で準備済みの操作を塞がずcatalogの購読更新も画面へ反映する"
// oracle = { type = "contract", ref = "docs/design/settings-ui.md#runtime-policy and GitHub Issue #744" }
// fault = "Settingsの初回readを一括待機し、別領域の内容や操作を隠すか、失敗後の再取得またはcatalog購読更新の表示をできなくする"
// observable = "deferred API応答中のSettings section、独立したLoadError/LoadingIndicator、catalog失敗中の保存回数とpayload、Retry後と購読更新後のprovider row"
// observation_boundary = "component-behavior"
// scope = "Settings Window independent initial reads, recovery and model catalog subscription"
// lifecycle = "permanent"
// @end-test-value
/** 設定とモデル一覧を独立して取得し、一方が失敗しても復旧済みの側を操作できる。 */
test("Settingsは独立したreadのpending/error中も準備済み領域を表示・操作できる", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/?mode=settings",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });

  const firstSettingsLoad =
    createDeferred<ReturnType<typeof createDefaultAppSettings>>();
  const firstCatalogLoad = createDeferred<ModelCatalogSnapshot | null>();
  let settingsCalls = 0;
  let catalogCalls = 0;
  const catalogListeners = new Set<(snapshot: ModelCatalogSnapshot) => void>();
  const savedSettings: ReturnType<typeof createDefaultAppSettings>[] = [];
  const originalSettings = {
    ...createDefaultAppSettings(),
  };
  const catalog: ModelCatalogSnapshot = {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] },
        ],
      },
    ],
  };
  const api: Partial<WithMateWindowApi> = {
    /** 初回設定取得を保留し、再試行には保存済み設定を返す。 */
    getAppSettings: async () => {
      settingsCalls += 1;
      if (settingsCalls === 1) return firstSettingsLoad.promise;
      return originalSettings;
    },
    /** 設定購読による更新は使わず、再試行の取得を観測する。 */
    subscribeAppSettings: () => () => {},
    /** 初回のモデル取得を保留し、再試行には既知の一覧を返す。 */
    getModelCatalog: async () => {
      catalogCalls += 1;
      if (catalogCalls === 1) return firstCatalogLoad.promise;
      return catalog;
    },
    /** 復旧後のモデル更新を配信できるようにモデル購読を記録する。 */
    subscribeModelCatalog: (listener) => {
      catalogListeners.add(listener);
      return () => {
        catalogListeners.delete(listener);
      };
    },
    /** 画面が保持した操作値を保存要求として記録し、そのまま反映する。 */
    updateAppSettings: async (settings) => {
      savedSettings.push(settings);
      return settings;
    },
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.ok(rootElement.querySelector(".settings-window-shell"));
    assert.ok(rootElement.querySelector('[aria-label="Loading app settings"]'));
    assert.ok(
      rootElement.querySelector('[aria-label="Loading model catalog"]'),
    );

    await act(async () =>
      firstSettingsLoad.reject(new Error("Settings unavailable")),
    );
    assert.match(rootElement.textContent ?? "", /Settings unavailable/);
    await act(async () =>
      firstCatalogLoad.reject(new Error("Catalog unavailable")),
    );
    assert.match(rootElement.textContent ?? "", /Catalog unavailable/);

    const settingsRetry =
      rootElement.querySelector<HTMLButtonElement>(".load-error button");
    assert.ok(settingsRetry);
    await act(async () => settingsRetry.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(settingsCalls, 2);
    assert.ok(rootElement.querySelector('[aria-label="Save Settings"]'));

    const appSettingToggle = rootElement.querySelector<HTMLInputElement>(
      ".settings-app-settings-fieldset input[type=checkbox]",
    );
    assert.ok(appSettingToggle);
    await act(async () => appSettingToggle.click());
    await act(async () => findButton(rootElement, "Save Settings").click());
    assert.match(rootElement.textContent ?? "", /Catalog unavailable/);
    assert.equal(savedSettings.length, 1);
    assert.equal(
      savedSettings[0]?.launchAtLoginEnabled,
      !originalSettings.launchAtLoginEnabled,
    );

    const catalogError = Array.from(
      rootElement.querySelectorAll(".load-error"),
    ).find((error) => error.textContent?.includes("Catalog unavailable"));
    const catalogRetry =
      catalogError?.querySelector<HTMLButtonElement>("button");
    assert.ok(catalogRetry);
    await act(async () => catalogRetry.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(catalogCalls, 2);
    assert.ok(rootElement.textContent?.includes("Codex"));

    assert.equal(catalogListeners.size, 1);
    await act(async () => {
      for (const listener of catalogListeners) {
        listener({
          ...catalog,
          providers: catalog.providers.map((provider) => ({
            ...provider,
            label: "Updated Codex",
          })),
        });
      }
    });
    assert.ok(rootElement.textContent?.includes("Updated Codex"));
  } finally {
    await act(async () => root?.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
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
/** Mate 状態・設定・モデル・Character が未取得でも、既存会話は一覧に現れて開ける。 */
test("Homeのmate status read中も既存Sessionを開ける", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });

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
    /** 既存会話を開く間は Mate 状態の取得を保留する。 */
    getMateState: () => mateLoad.promise,
    /** 設定も未取得のままにし、一覧の表示を待機させないか調べる。 */
    getAppSettings: async () => new Promise(() => {}),
    /** 設定取得の未完了を購読からも解除しない。 */
    subscribeAppSettings: () => () => {},
    /** モデル一覧を待ち続ける状態でも既存会話を開けるか確かめる。 */
    getModelCatalog: async () => new Promise(() => {}),
    /** モデル変更の通知で取得を完了させない。 */
    subscribeModelCatalog: () => () => {},
    /** Character 一覧も未取得のまま操作を続ける。 */
    listCharacters: async () => new Promise(() => {}),
    /** 既知の会話は最近の一覧だけに含める。 */
    listSessionSummaryPage: async (request) => ({
      entries: request?.scope === "recent" ? [session] : [],
      hasMore: false,
      nextCursor: null,
    }),
    /** 過去の Character 使用状況を表示しない。 */
    listSessionCharacterUsage: async () => [],
    /** 会話一覧はこの操作で外部から失効させない。 */
    subscribeSessionInvalidation: () => () => {},
    /** 既存会話についてターンの更新を発生させない。 */
    onSessionTurnUpdated: () => () => {},
    /** 対象の会話ウィンドウは事前に開いていない。 */
    listOpenSessionWindowIds: async () => [],
    /** ウィンドウの開閉更新はこの操作に割り込ませない。 */
    subscribeOpenSessionWindowIds: () => () => {},
    /** 独立した Monitor の項目は用意しない。 */
    listSessionMonitorPage: async () => ({
      entries: [],
      auxiliarySessions: [],
      hasMore: false,
      nextCursor: null,
    }),
    /** 調整項目はない状態で表示する。 */
    executeCoordination: async () => ({
      items: [],
      total: 0,
      nextOffset: null,
    }),
    /** 調整データの変化を配信しない。 */
    subscribeCoordinationChanged: () => () => {},
    /** 選択対象の ID でのみ既存会話の情報を返す。 */
    getSessionSummary: async (id) => (id === session.id ? session : null),
    /** 実行中の会話からの状態変更は配信しない。 */
    subscribeLiveSessionRunStatus: () => () => {},
    /** 復元待ちのウィンドウはないものとする。 */
    getSessionWindowRestoreSet: async () => [],
    /** 復元対象の変更を通知しない。 */
    subscribeSessionWindowRestoreSet: () => () => {},
    /** 既存会話を開く要求の引数を記録する。 */
    openSession: async (id) => {
      opened.push(id);
    },
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    assert.ok(rootElement.textContent?.includes("Existing task"));
    const openRow = rootElement.querySelector<HTMLButtonElement>(
      ".home-session-card-open",
    );
    assert.ok(openRow);
    assert.equal(openRow.disabled, false);
    await act(async () => openRow.click());
    assert.deepEqual(opened, ["existing-during-mate-load"]);
    assert.ok(rootElement.querySelector('[aria-label="Loading app state"]'));
  } finally {
    await act(async () => root?.unmount());
    mateLoad.resolve("active");
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
  }
});

// @test-value v2
// kind = "contract"
// claim = "Homeと独立Monitorはopen Windowや履歴pageにない親も専用Monitor snapshotから表示し、quota cacheとlive通知の実行・取消・承認・入力待ち変化をMain/Auxiliaryへ反映する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-monitor-window / 共通仕様のlive eventと軽量summary再読込" }
// fault = "Monitorをopen IDsや履歴に制限する、quota経路を失う、実行・承認・入力待ち変化を捨てる、通知payloadをsnapshotの代わりに表示する、または本文更新ごとに再取得する"
// observable = "provider残率とcacheOnly引数、Attention/Running/Stopped sectionの親card、Main/Auxiliaryのaccessible状態、summary API取得回数、unmount後のlive購読数"
// observation_boundary = "component-behavior"
// scope = "HomeAppのlive event購読とMonitor描画（home/monitor mode、Main/Auxiliary）"
// lifecycle = "permanent"
// impact = "開いている会話の実行状態が古いまま残り、停止確認や実行中会話の識別ができなくなることを防ぐ"
// distinction = "projection単体・型検査・refresher単体では検出できない通知の重複判定からsummary取得と画面更新への結線を、小さなin-memory APIで確認する"
// @end-test-value
/** Home と独立 Monitor が実行通知から専用一覧を再取得し、Main と Auxiliary の稼働・応答待ち・停止を表示する。 */
test("Homeと独立MonitorはMainとAuxiliaryの実行状態をlive通知から同期する", async () => {
  for (const mode of ["home", "monitor"]) {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        url: `https://withmate.local/?mode=${mode}`,
      },
    );
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "window", {
      value: dom.window,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: dom.window.HTMLElement,
      configurable: true,
    });

    let summary = projectHomeSessionSummary(
      buildNewSession({
        id: "monitor-parent",
        taskTitle: "Monitor task",
        workspaceLabel: "Workspace",
        workspacePath: "C:\\workspace",
        branch: "main",
        characterId: "character-1",
        character: "Mia",
        characterIconPath: "",
        characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
        approvalMode: "on-request",
      }),
    );
    let auxiliary: AuxiliarySessionSummary = {
      id: "monitor-aux",
      parentSessionId: summary.id,
      runState: "idle",
      title: "Auxiliary",
      preview: "Auxiliary task",
      provider: "codex",
      catalogRevision: 1,
      model: "gpt-5.4",
      reasoningEffort: "high",
      approvalMode: "on-request",
      codexSpeed: "standard",
      codexReviewer: "auto-review",
      codexSandboxMode: "danger-full-access",
      customAgentName: "",
      threadId: "",
      displayAfterMessageIndex: null,
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    const liveListeners = new Set<
      Parameters<WithMateWindowApi["subscribeLiveSessionRunStatus"]>[0]
    >();
    let summaryReads = 0;
    let monitorReads = 0;
    const quotaReads: Parameters<
      WithMateWindowApi["getProviderQuotaTelemetry"]
    >[] = [];
    const api: Partial<WithMateWindowApi> = {
      /** Mate が未作成でも Monitor の描画を進める。 */
      getMateState: async () => "not_created",
      /** 表示に必要なプロバイダー構成を既定値から返す。 */
      getAppSettings: async () => createDefaultAppSettings(),
      /** Monitor テストでは設定を途中で更新しない。 */
      subscribeAppSettings: () => () => {},
      /** キャッシュ限定で取得したか記録し、使用済み割合から残量を表示できるようにする。 */
      getProviderQuotaTelemetry: async (...args) => {
        quotaReads.push(args);
        return {
          provider: "codex",
          updatedAt: null,
          snapshots: [],
          rateLimits: [
            {
              quotaKey: "codex:primary",
              usedPercentage: 34,
              windowDurationMinutes: 10080,
            },
          ],
        };
      },
      /** 使用枠の取得結果は購読で変更しない。 */
      subscribeProviderQuotaTelemetry: () => () => {},
      /** モデル一覧が未取得のままでも Monitor を表示できるよう保留する。 */
      getModelCatalog: async () => new Promise(() => {}),
      /** モデル一覧の変更通知は発生させない。 */
      subscribeModelCatalog: () => () => {},
      /** Monitor の稼働表示には有効 Character の一覧を必要としない。 */
      listCharacters: async () => [],
      /** 通常の履歴には対象を含めず、本文更新で無駄に取得しないか回数を数える。 */
      listSessionSummaryPage: async (request) => {
        summaryReads += 1;
        return { entries: [], hasMore: false, nextCursor: null };
      },
      /** Character 使用状況は Monitor の分類に加えない。 */
      listSessionCharacterUsage: async () => [],
      /** 会話の一括失効通知は発生させず、実行状態通知から再取得させる。 */
      subscribeSessionInvalidation: () => () => {},
      /** ターン更新通知を送らず、実行通知と履歴取得の区別を保つ。 */
      onSessionTurnUpdated: () => () => {},
      /** 稼働一覧の親会話は開いているウィンドウの集合に含めない。 */
      listOpenSessionWindowIds: async () => [],
      /** 実行状態を変更してもウィンドウの開閉は通知しない。 */
      subscribeOpenSessionWindowIds: () => () => {},
      /** 表示確認にウィンドウの復元を使わない。 */
      getSessionWindowRestoreSet: async () => [],
      /** 復元一覧を変えず、専用の稼働一覧を検証する。 */
      subscribeSessionWindowRestoreSet: () => () => {},
      /** 現在の親と Auxiliary の要約を返し、実行状態の変化による読取回数を数える。 */
      listSessionMonitorPage: async () => {
        monitorReads += 1;
        return {
          entries: [summary],
          auxiliarySessions: [auxiliary],
          hasMore: false,
          nextCursor: null,
        };
      },
      /** 調整一覧は空にし、Monitor の分類を独立して観測する。 */
      executeCoordination: async () => ({
        items: [],
        total: 0,
        nextOffset: null,
      }),
      /** 調整の通知を使わずに実行状態の更新を調べる。 */
      subscribeCoordinationChanged: () => () => {},
      /** 個別会話を直接読み込まず、専用の一覧から最新状態を取得させる。 */
      getSessionSummary: async () => null,
      /** 変更の配信と破棄時の解除を確認できるよう、実行状態の購読を記録する。 */
      subscribeLiveSessionRunStatus: (listener) => {
        liveListeners.add(listener);
        return () => {
          liveListeners.delete(listener);
        };
      },
    };
    dom.window.withmate = api as WithMateWindowApi;
    const rootElement = dom.window.document.getElementById("root");
    assert.ok(rootElement);
    /** 指定会話の実行・取消状態だけを持つライブ状態を組み立てる。 */
    const createLiveState = (
      sessionId: string,
      runState: string,
      cancellationState?: LiveSessionRunState["cancellationState"],
    ): LiveSessionRunState => ({
      sessionId,
      threadId: "thread-1",
      runState,
      cancellationState,
      assistantText: "",
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    });
    /** ライブ状態を軽量な通知データに投影し、登録された購読先へ届ける。 */
    const emitLive = async (
      sessionId: string,
      state: LiveSessionRunState | null,
    ) => {
      await act(async () => {
        const status = projectLiveSessionRunStatus(state);
        for (const listener of liveListeners) listener(sessionId, status);
      });
    };
    /** 対象の分類に親カードが一件だけあり、Main と Auxiliary のアクセシブルな状態が一致することを確かめる。 */
    const assertMonitor = (
      section: "approval" | "running" | "inactive",
      mainLabel: string,
      auxiliaryLabel: string,
    ) => {
      const card = rootElement.querySelector(
        `[aria-labelledby="home-monitor-${section}"] .home-monitor-card`,
      );
      assert.ok(card, `${mode}: parent card should be in ${section}`);
      assert.ok(
        card.querySelector(`[aria-label="Main ${mainLabel}"]`),
        `${mode}: Main ${mainLabel}`,
      );
      assert.ok(
        card.querySelector(`[aria-label="Auxiliary ${auxiliaryLabel}: 1"]`),
        `${mode}: Auxiliary ${auxiliaryLabel}`,
      );
      assert.equal(
        rootElement.querySelectorAll(".home-monitor-card").length,
        1,
      );
    };
    let root: Root | null = null;
    try {
      const [{ default: HomeApp }, { createRoot }] = await Promise.all([
        import("../../src/home/HomeApp.js"),
        import("react-dom/client"),
      ]);
      await act(async () => {
        root = createRoot(rootElement);
        root.render(<HomeApp />);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      assertMonitor("inactive", "Idle", "Idle");
      const quotas = rootElement.querySelector(
        '[aria-label="Provider Quotas"]',
      );
      assert.ok(quotas);
      assert.match(quotas.textContent ?? "", /Codex7d 66%/);
      assert.deepEqual(quotaReads, [["codex", { cacheOnly: true }]]);
      await emitLive(summary.id, null);

      summary = { ...summary, status: "running", runState: "running" };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      assertMonitor("running", "Running", "Idle");

      const readsBeforeStreaming = [summaryReads, monitorReads];
      await emitLive(summary.id, {
        ...createLiveState(summary.id, "running"),
        assistantText: "Streaming text",
      });
      assert.deepEqual([summaryReads, monitorReads], readsBeforeStreaming);

      const approvalRequest = {
        requestId: "approval-1",
        provider: "codex",
        kind: "command",
        title: "Command",
        summary: "Run command",
        decisionMode: "direct-decision" as const,
      };
      const pendingMain = {
        ...createLiveState(summary.id, "running"),
        approvalRequest,
      };
      await emitLive(summary.id, pendingMain);
      assertMonitor("running", "Running", "Idle");
      summary = { ...summary, approvalPending: true };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      await emitLive(summary.id, pendingMain);
      assertMonitor("approval", "Attention", "Idle");
      const readsBeforeApprovalText = [summaryReads, monitorReads];
      await emitLive(summary.id, {
        ...pendingMain,
        assistantText: "More text",
      });
      assert.deepEqual([summaryReads, monitorReads], readsBeforeApprovalText);
      summary = { ...summary, approvalPending: false };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      assertMonitor("running", "Running", "Idle");

      const questions: LiveElicitationRequest[] = [
        {
          requestId: "native",
          provider: "codex",
          kind: "question",
          mode: "form",
          blocking: true,
          message: "Choose",
          fields: [],
        },
        {
          requestId: "nonblocking",
          provider: "codex",
          kind: "question",
          mode: "form",
          blocking: false,
          message: "Choose",
          fields: [],
        },
        {
          requestId: "async",
          provider: "codex",
          kind: "question",
          mode: "form",
          delivery: "user-message",
          turnId: "turn-1",
          message: "Choose",
          fields: [],
        },
        {
          requestId: "mcp",
          provider: "codex",
          mode: "url",
          message: "Authorize",
          url: "https://example.com/auth",
          fields: [],
        },
      ];
      for (const elicitationRequest of questions) {
        summary = { ...summary, approvalPending: true };
        await emitLive(summary.id, {
          ...createLiveState(summary.id, "running"),
          elicitationRequest,
        });
        assertMonitor("approval", "Attention", "Idle");
        summary = { ...summary, approvalPending: false };
        await emitLive(summary.id, createLiveState(summary.id, "running"));
        assertMonitor("running", "Running", "Idle");
      }

      summary = { ...summary, status: "idle", runState: "idle" };
      await emitLive(summary.id, null);
      assertMonitor("inactive", "Idle", "Idle");

      summary = { ...summary, status: "running", runState: "running" };
      await emitLive(summary.id, createLiveState(summary.id, "running"));
      assertMonitor("running", "Running", "Idle");
      for (const [cancellationState, label] of [
        ["requested", "Canceling"],
        ["terminating", "Waiting For Stop"],
      ] as const) {
        summary = { ...summary, cancellationState };
        await emitLive(
          summary.id,
          createLiveState(summary.id, "running", cancellationState),
        );
        assertMonitor("running", label, "Idle");
      }
      summary = {
        ...summary,
        status: "idle",
        runState: "idle",
        cancellationState: undefined,
      };
      await emitLive(summary.id, {
        ...createLiveState(summary.id, "idle"),
        reasoningText: "Retained reasoning",
      });
      assertMonitor("inactive", "Idle", "Idle");

      await emitLive(auxiliary.id, null);
      auxiliary = { ...auxiliary, runState: "running" };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "running"));
      assertMonitor("running", "Idle", "Running");
      auxiliary = { ...auxiliary, approvalPending: true };
      await emitLive(auxiliary.id, {
        ...createLiveState(auxiliary.id, "running"),
        approvalRequest,
      });
      assertMonitor("approval", "Idle", "Attention");
      auxiliary = { ...auxiliary, approvalPending: false };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "running"));
      assertMonitor("running", "Idle", "Running");
      for (const elicitationRequest of questions) {
        auxiliary = { ...auxiliary, approvalPending: true };
        await emitLive(auxiliary.id, {
          ...createLiveState(auxiliary.id, "running"),
          elicitationRequests: [elicitationRequest],
        });
        assertMonitor("approval", "Idle", "Attention");
        auxiliary = { ...auxiliary, approvalPending: false };
        await emitLive(auxiliary.id, createLiveState(auxiliary.id, "running"));
        assertMonitor("running", "Idle", "Running");
      }
      auxiliary = { ...auxiliary, runState: "error" };
      await emitLive(auxiliary.id, createLiveState(auxiliary.id, "error"));
      assertMonitor("inactive", "Idle", "Failed");
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
      Object.defineProperty(globalThis, "window", {
        value: previousWindow,
        configurable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: previousDocument,
        configurable: true,
      });
      Object.defineProperty(globalThis, "HTMLElement", {
        value: previousHTMLElement,
        configurable: true,
      });
    }
  }
});
