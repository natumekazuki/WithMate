import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import type { Root } from "react-dom/client";

import CharacterEditorApp from "../../src/character-editor/CharacterEditorApp.js";
import type { StartCharacterAuthoringSessionInput } from "../../src-shared/character/character-authoring.js";
import {
  DEFAULT_CHARACTER_THEME,
  type CharacterDetail,
} from "../../src-shared/character/character-catalog.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { buildNewSession } from "../../src-shared/session/session-state.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Profileと定義、ノートを含み、既存キャラクターとして開ける編集用データを作る。 */
function createCharacterDetail(): CharacterDetail {
  return {
    id: "char-1",
    name: "Muse",
    description: "作業を一緒に進める相手",
    iconFilePath: "",
    theme: DEFAULT_CHARACTER_THEME,
    state: "active",
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z",
    archivedAt: null,
    definitionMarkdown: [
      "---",
      "schema: withmate-character-v5",
      'name: "Muse"',
      'description: "作業を一緒に進める相手"',
      "---",
      "",
      "# Profile",
    ].join("\n"),
    notesMarkdown: "# Profile Notes",
  };
}

/** テキストが一致する操作ボタンを取得し、操作の導線が無い場合は失敗にする。 */
function findButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  assert.ok(button, `${text} button should exist`);
  return button as HTMLButtonElement;
}

/** 作成エージェントの選択に使えるProviderとモデルのカタログを用意する。 */
function createModelCatalog(): ModelCatalogSnapshot {
  return {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          {
            id: "gpt-5.4",
            label: "GPT-5.4",
            reasoningEfforts: ["medium", "high"],
          },
        ],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "claude-sonnet-4.5",
        defaultReasoningEffort: "medium",
        models: [
          {
            id: "claude-sonnet-4.5",
            label: "Claude Sonnet 4.5",
            reasoningEfforts: ["medium"],
          },
        ],
      },
    ],
  };
}

/** 取得や保存の完了・失敗をテスト側から制御できるようにする。 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** DOMをセットアップした後にReactクライアントを読み込み、Editorの描画ルートを作る。 */
async function createEditorRoot(container: HTMLElement) {
  const { createRoot } = await import("react-dom/client");
  return createRoot(container);
}

/** 対象IDの有無で既存編集と新規作成を選び、IPCの応答をケースごとに差し替えられる状態でEditorを描画する。 */
async function mountEditor(
  api: Partial<WithMateWindowApi>,
  characterId: string | null = "char-1",
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: `https://withmate.local/character-editor.html${characterId ? `?characterId=${characterId}` : ""}`,
  });
  const previous = Object.fromEntries(
    ["window", "document", "navigator", "HTMLElement"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const key of Object.keys(previous)) {
    Object.defineProperty(globalThis, key, {
      value: Reflect.get(dom.window, key),
      configurable: true,
    });
  }
  dom.window.withmate = {
    /** 標準の作成エージェントの候補を返す。 */
    async getModelCatalog() {
      return createModelCatalog();
    },
    /** 設定が未変更の状態でEditorを動かす。 */
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    /** 既定の作成セッションを返して、ウィンドウ再フォーカス後の再取得を検証できるようにする。 */
    async startCharacterAuthoringSession() {
      return {
        session: buildNewSession({
          taskTitle: "Improve Muse",
          workspaceLabel: "Authoring",
          workspacePath: "C:/tmp/authoring",
          branch: "main",
          characterId: "char-1",
          character: "Muse",
          characterIconPath: "",
          characterThemeColors: DEFAULT_CHARACTER_THEME,
          approvalMode: "on-request",
        }),
        workspacePath: "C:/tmp/authoring",
        runId: "authoring-run",
      };
    },
    ...api,
  } as WithMateWindowApi;
  const container = dom.window.document.getElementById("root")!;
  const root = await createEditorRoot(container);
  await act(async () => root.render(<CharacterEditorApp />));
  /** 表示ラベルで指定されたボタンを押し、その結果の再描画を待つ。 */
  const click = async (label: string) => {
    await act(async () => findButtonByText(container, label).click());
  };
  return {
    dom,
    container,
    click,
    /** 作成セッションからEditorウィンドウに戻るフォーカスイベントを送る。 */
    async focus() {
      await act(async () =>
        dom.window.dispatchEvent(new dom.window.Event("focus")),
      );
    },
    /** 作成エージェントのダイアログを開き、現在の選択で開始する。 */
    async startAuthoring() {
      await click("Improve With Agent");
      await click("Start");
    },
    /** React管理下の入力欄へ利用者の入力を届けるため、ネイティブのsetterと入力通知を使う。 */
    async fill(selector: string, value: string) {
      const input = container.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(selector);
      assert.ok(input, selector);
      await act(async () => {
        const prototype =
          input.tagName === "TEXTAREA"
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    /** 描画を解除してDOMを閉じ、差し替えたグローバルを戻す。 */
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "既存Characterの未取得・失敗・not foundは編集/保存を許可せず、失敗概要と原文の詳細入口を提供し、同じIDのRetry成功後だけ対象draftを操作できる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
// fault = "未取得の既存IDを新規作成として保存する、失敗や診断原文への入口を失う、またはRetryで別対象を開く"
// observable = "loading status/busy、error alert、詳細buttonのaccessible name/expanded/controlsと非modal popoverの診断原文、見出し・編集入力・Save/Archive/Improve disabled、getCharacterのID列、書込API呼出数"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp initial read and retry"
// lifecycle = "permanent"
// impact = "既存Characterの取得障害による別Characterの誤作成を防ぎ、同一対象への復帰経路を守る"
// distinction = "型検査やstate helperでは判定できない取得Promiseと表示・操作gateの接続を少数の制御Promiseで検証する"
// @end-test-value
/** 既存IDの取得に失敗しても新規作成へ切り替えず、同じIDで再試行することを確認する。 */
test("CharacterEditorApp は既存IDの取得失敗から同じ対象へRetryする", async () => {
  const requests: Array<
    ReturnType<typeof createDeferred<CharacterDetail | null>>
  > = [];
  const ids: string[] = [];
  let writes = 0;
  const editor = await mountEditor({
    /** 要求されたIDを記録し、取得の完了・失敗を順次制御する。 */
    getCharacter: async (id) => {
      ids.push(id);
      const request = createDeferred<CharacterDetail | null>();
      requests.push(request);
      return request.promise;
    },
    /** 失敗中に既存対象が新規作成されないことを呼出件数で検出する。 */
    async createCharacter() {
      writes += 1;
      return createCharacterDetail();
    },
    /** 読み出せない既存キャラクターへの定義保存がないかを数える。 */
    async updateCharacterDefinition() {
      writes += 1;
      return createCharacterDetail();
    },
    /** 読み出し失敗の間にアーカイブまで到達した場合を検出する。 */
    async archiveCharacter() {
      writes += 1;
      return createCharacterDetail();
    },
  });
  const { container, dom } = editor;
  /** 取得が成立するまでは編集欄と保存・アーカイブ・作成エージェントの操作を開放しないことを確かめる。 */
  const assertBlocked = async () => {
    assert.equal(
      container.querySelector("h1")?.textContent,
      "Character Editor",
    );
    assert.equal(container.querySelector("main input, main textarea"), null);
    for (const label of ["Save", "Archive", "Improve With Agent"]) {
      assert.equal(findButtonByText(container, label).disabled, true);
      await editor.click(label);
    }
    const close = new dom.window.Event("beforeunload", { cancelable: true });
    await act(async () => dom.window.dispatchEvent(close));
    assert.equal(close.defaultPrevented, false);
    assert.equal(writes, 0);
  };
  try {
    await assertBlocked();
    assert.equal(
      container.querySelector("main")?.getAttribute("aria-busy"),
      "true",
    );
    assert.ok(
      container.querySelector(
        '[role="status"][aria-label="Loading character"]',
      ),
    );
    await act(async () =>
      requests[0]!.reject(
        new Error("Could not load character: access denied."),
      ),
    );
    await assertBlocked();
    assert.equal(
      container.querySelector('[role="alert"]')?.textContent,
      "Character could not be loaded.",
    );
    const detailsButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Show Character Load Error Details"]',
    );
    assert.ok(detailsButton);
    assert.equal(detailsButton.getAttribute("aria-expanded"), "false");
    const details = dom.window.document.getElementById(
      detailsButton.getAttribute("aria-controls")!,
    );
    assert.ok(details);
    assert.equal(details.getAttribute("popover"), "auto");
    assert.equal(details.getAttribute("aria-modal"), null);
    assert.equal(
      details.querySelector("pre")?.textContent,
      "Could not load character: access denied.",
    );
    await editor.click("Retry");
    await assertBlocked();
    assert.equal(
      container.querySelector("main")?.getAttribute("aria-busy"),
      "true",
    );
    await act(async () => requests[1]!.resolve(null));
    await assertBlocked();
    assert.equal(
      container.querySelector('[role="alert"]')?.textContent,
      "Character Not Found",
    );
    assert.equal(
      container.querySelector("[popover] pre")?.textContent,
      "Character not found.",
    );
    await editor.click("Retry");
    await act(async () => requests[2]!.resolve(createCharacterDetail()));
    assert.deepEqual(ids, ["char-1", "char-1", "char-1"]);
    assert.equal(container.querySelector("h1")?.textContent, "Muse");
    assert.equal(
      container.querySelector<HTMLInputElement>("input")?.value,
      "Muse",
    );
    assert.equal(findButtonByText(container, "Save").disabled, true);
    assert.equal(
      findButtonByText(container, "Improve With Agent").disabled,
      false,
    );
    assert.equal(
      container.querySelector("main")?.getAttribute("aria-busy"),
      null,
    );
  } finally {
    await editor.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "IDなしの新規作成では編集内容をcreate APIへ渡し、保存されたCharacterを同じEditorで継続する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
// fault = "既存IDの取得gateが新規作成を止める、または作成成功後もcreate modeで再保存する"
// observable = "createCharacter入力・呼出数、Name入力、SaveとImproveのdisabled state"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp create mode"
// lifecycle = "permanent"
// impact = "Character新規作成の主要経路と保存後の同一対象継続を維持する"
// distinction = "draft生成unit testが観測しないcreate APIとの接続と成功後の操作可否を1回の保存で確認する"
// @end-test-value
/** IDなしで入力した新規キャラクターが保存され、その結果を同じEditorで編集できることを確認する。 */
test("CharacterEditorApp は新規Characterを作成して編集を継続する", async () => {
  const inputs: unknown[] = [];
  const editor = await mountEditor(
    {
      /** 新規作成へ渡った入力を記録し、既定の配色に変更を反映して返す。 */
      async createCharacter(input) {
        inputs.push(input);
        return {
          ...createCharacterDetail(),
          ...input,
          theme: { ...DEFAULT_CHARACTER_THEME, ...input.theme },
        };
      },
    },
    null,
  );
  try {
    await editor.fill("input", "New Muse");
    assert.equal(editor.container.querySelector("h1")?.textContent, "New Muse");
    await editor.click("Save");
    assert.equal(inputs.length, 1);
    assert.equal((inputs[0] as { name: string }).name, "New Muse");
    assert.equal(findButtonByText(editor.container, "Save").disabled, true);
    assert.equal(
      findButtonByText(editor.container, "Improve With Agent").disabled,
      false,
    );
  } finally {
    await editor.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Authoring後の再取得中にProfileと本文を編集してもdraftを保持し、失敗とnot found後のfocus/Retry再試行でも入力と診断詳細へのアクセスを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
// fault = "再取得の応答が新しい入力を置換する、focus/Retryで重複要求する、または失敗後の入力や診断詳細/回復操作を失う"
// observable = "Name・Description・definition・notes入力値、未保存badge、Save disabled、Retry busy/disabled、再取得回数、alert概要とpopover診断原文、成功status"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp authoring refresh and draft preservation"
// lifecycle = "permanent"
// impact = "未保存のCharacter定義とProfile入力の消失を防ぐ"
// distinction = "reconciliation unit testだけでは観測しないfocus event・非同期API・controlled inputの接続を制御Promiseで確認する"
// @end-test-value
/** 作成エージェントから戻った後の再取得に失敗しても再試行でき、成功時も未保存のProfile・定義・ノートを残すことを確認する。 */
test("CharacterEditorApp はAuthoring再取得中のProfileと本文編集を保護する", async () => {
  let current = createCharacterDetail();
  let refresh = createDeferred<CharacterDetail | null>();
  let reads = 0;
  const editor = await mountEditor({
    /** 初回は既存値を返し、再フォーカスによる読取の応答を保留して重複要求を観測する。 */
    async getCharacter() {
      reads += 1;
      return reads === 1 ? current : refresh.promise;
    },
  });
  const { container } = editor;
  const localDefinition = `${current.definitionMarkdown}\n## Local edit`;
  try {
    await editor.startAuthoring();
    await editor.focus();
    await editor.focus();
    assert.equal(reads, 2);
    await editor.fill("input", "Local Muse");
    await editor.fill(
      ".settings-character-form-grid > label:nth-child(2) input",
      "Local description",
    );
    await editor.click("character.md");
    await editor.fill("textarea", localDefinition);
    await editor.click("character-notes.md");
    await editor.fill("textarea", "# Local Notes");
    await act(async () => refresh.reject(new Error("reload failed")));
    assert.equal(
      container.querySelector('footer [role="alert"]')?.textContent,
      "Character files could not be reloaded.",
    );
    assert.equal(
      container.querySelector("footer [popover] pre")?.textContent,
      "reload failed",
    );
    assert.ok(
      container.querySelector(
        '[aria-label="Show Character Reload Error Details"]',
      ),
    );
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "# Local Notes",
    );
    refresh = createDeferred<CharacterDetail | null>();
    const retry = findButtonByText(container, "Retry");
    await editor.click("Retry");
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    await editor.focus();
    assert.equal(reads, 3);
    await act(async () => refresh.resolve(null));
    assert.equal(
      container.querySelector("footer [popover] pre")?.textContent,
      "The character could not be found while reloading its files.",
    );
    assert.equal(findButtonByText(container, "Retry").disabled, false);
    refresh = createDeferred<CharacterDetail | null>();
    await editor.focus();
    current = {
      ...current,
      definitionMarkdown: `${current.definitionMarkdown}\n## Agent edit`,
      notesMarkdown: "# Agent Notes",
    };
    await act(async () => refresh.resolve(current));
    assert.equal(reads, 4);
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "# Local Notes",
    );
    assert.match(
      container.querySelector('footer [role="status"]')?.textContent ?? "",
      /Unsaved edits kept/,
    );
    assert.equal(findButtonByText(container, "Save").disabled, false);
    assert.equal(
      container.querySelector(".settings-character-badge")?.textContent,
      "Unsaved",
    );
    await editor.click("character.md");
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      localDefinition,
    );
    await editor.click("Profile");
    assert.equal(
      container.querySelector<HTMLInputElement>("input")?.value,
      "Local Muse",
    );
    assert.equal(
      container.querySelector<HTMLInputElement>(
        ".settings-character-form-grid > label:nth-child(2) input",
      )?.value,
      "Local description",
    );
  } finally {
    await editor.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "後続Authoringの再取得とSaveが完了した後は、古い再取得の成功/失敗でdraft・保存状態・feedbackを上書きしない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
// fault = "古い再取得応答が後続の取得内容や保存した本文を巻き戻す、または過去の失敗を現在の通知にする"
// observable = "definition本文、Save disabled、再取得回数、footer feedback"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp stale authoring refresh responses"
// lifecycle = "permanent"
// impact = "後続操作の確定した内容を古い応答から保護する"
// distinction = "helperの比較testでは検出できないrequest lifetimeと後続操作の競合を、API応答順序を逆転して確認する"
// @end-test-value
/** 次の作成エージェントや保存の前に始まった再読込が遅れても、最新の本文・状態を上書きしないことを確認する。 */
test("CharacterEditorApp は後続AuthoringとSave後の古い再取得応答を無視する", async () => {
  let current = createCharacterDetail();
  let nextRead: Promise<CharacterDetail | null> | null = null;
  let reads = 0;
  const editor = await mountEditor({
    /** 現在のキャラクターを返すほか、応答順序を逆転させる読取を個別に保留する。 */
    async getCharacter() {
      reads += 1;
      return nextRead ?? current;
    },
    /** 定義とノートの保存結果を次回読取の現在値に反映する。 */
    async updateCharacterDefinition(input) {
      current = {
        ...current,
        definitionMarkdown: input.definitionMarkdown,
        notesMarkdown: input.notesMarkdown ?? "",
      };
      return current;
    },
    /** 定義保存後のProfile更新にも同じ確定済みのキャラクターを返す。 */
    async updateCharacterMetadata() {
      return current;
    },
  });
  const { container } = editor;
  try {
    await editor.startAuthoring();
    const old = createDeferred<CharacterDetail | null>();
    nextRead = old.promise;
    await editor.focus();
    await editor.startAuthoring();
    const newer = createDeferred<CharacterDetail | null>();
    nextRead = newer.promise;
    await editor.focus();
    current = {
      ...current,
      definitionMarkdown: `${current.definitionMarkdown}\n## Latest Agent`,
    };
    await act(async () => newer.resolve(current));
    await act(async () => old.reject(new Error("obsolete failure")));
    await editor.click("character.md");
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      current.definitionMarkdown,
    );
    assert.equal(
      container.querySelector("footer span[role=status]")?.textContent,
      "Character Files Reloaded",
    );
    await editor.focus();
    assert.equal(reads, 3);

    await editor.startAuthoring();
    const beforeSave = createDeferred<CharacterDetail | null>();
    const obsoleteDetail = current;
    nextRead = beforeSave.promise;
    await editor.focus();
    const savedDefinition = `${current.definitionMarkdown}\n## Saved local edit`;
    await editor.fill("textarea", savedDefinition);
    nextRead = null;
    await editor.click("Save");
    assert.equal(findButtonByText(container, "Save").disabled, true);
    await act(async () => beforeSave.resolve(obsoleteDetail));
    assert.equal(
      container.querySelector<HTMLTextAreaElement>("textarea")?.value,
      savedDefinition,
    );
    assert.equal(findButtonByText(container, "Save").disabled, true);
    assert.equal(
      container.querySelector("footer span[role=status]")?.textContent,
      "Saved",
    );
    await editor.focus();
    assert.equal(reads, 5);
  } finally {
    await editor.cleanup();
  }
});

// @test-value v2
// kind = "contract"
// claim = "再取得に重なったSave/Archive/Authoring開始が失敗しても、次のfocusで同じCharacterを再取得し、未保存入力と後続の取得結果を古い応答から守る"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window; docs/design/character-authoring-growth.md#product-flow" }
// fault = "後続操作の失敗で再取得要求を消費し回復不能になる、または旧応答が後続のdraft/通知を上書きする"
// observable = "getCharacterのID列と回数、失敗通知、definition/notes/Profile入力値、Save disabled、再取得後のstatus"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp interrupted refresh recovery after failed operations"
// lifecycle = "permanent"
// impact = "操作失敗後もAuthoringの保存済み更新を確認でき、未保存入力を失わずEditorを継続できる"
// distinction = "成功する後続操作と単独の取得失敗だけでは観測できない、effect無効化と後続操作失敗の交差を少数のJSDOM/制御Promiseで検証する"
// @end-test-value
/** 保存・アーカイブ・作成開始が失敗しても、再フォーカスの再取得と未保存入力の保護が機能することを確認する。 */
test("CharacterEditorApp は後続操作失敗後も再取得と入力保護を継続する", async () => {
  const scenarios = [
    { operation: "archive", localEdits: false },
    { operation: "archive", localEdits: true },
    { operation: "authoring", localEdits: false },
    { operation: "authoring", localEdits: true },
    { operation: "save", localEdits: true },
  ] as const;
  for (const { operation, localEdits } of scenarios) {
    const original = createCharacterDetail();
    const updated = {
      ...original,
      definitionMarkdown: `${original.definitionMarkdown}\n## Latest Agent`,
      notesMarkdown: "# Latest Agent Notes",
    };
    const refreshes: Array<
      ReturnType<typeof createDeferred<CharacterDetail | null>>
    > = [];
    const ids: string[] = [];
    const operationRequest = createDeferred<never>();
    let operationCalls = 0;
    const editor = await mountEditor({
      /** 同じIDへの初回読取と、応答順を制御する後続の再取得を区別する。 */
      async getCharacter(id) {
        ids.push(id);
        if (ids.length === 1) return original;
        const request = createDeferred<CharacterDetail | null>();
        refreshes.push(request);
        return request.promise;
      },
    });
    const { container, dom } = editor;
    const localDefinition = `${original.definitionMarkdown}\n## Local Edit`;
    try {
      await editor.startAuthoring();
      await editor.focus();
      /** 対象操作の呼出を数え、再取得と競合させるために応答を保留する。 */
      const failOperation = () => {
        operationCalls += 1;
        return operationRequest.promise;
      };
      const api = dom.window.withmate;
      assert.ok(api);
      api.archiveCharacter = failOperation;
      api.startCharacterAuthoringSession = failOperation;
      api.updateCharacterDefinition = failOperation;
      dom.window.confirm = () => true;
      if (operation === "archive") {
        await editor.click("Archive");
      } else if (operation === "authoring") {
        await editor.startAuthoring();
      } else {
        await editor.click("character.md");
        await editor.fill("textarea", localDefinition);
        await editor.click("Save");
      }
      assert.equal(operationCalls, 1, operation);
      await editor.focus();
      assert.equal(ids.length, 2, "Busy operation must not start a refresh");
      await act(async () =>
        operationRequest.reject(new Error(`${operation} failed`)),
      );
      assert.match(
        container.querySelector('footer [role="status"]')?.textContent ?? "",
        new RegExp(`${operation} failed`),
      );
      if (operation === "authoring") {
        const close = container.querySelector<HTMLButtonElement>(
          '[aria-label="Close"]',
        );
        assert.ok(close);
        await act(async () => close.click());
      }
      if (localEdits) {
        await editor.click("Profile");
        await editor.fill("input", "Local Muse");
        await editor.click("character.md");
        await editor.fill("textarea", localDefinition);
        await editor.click("character-notes.md");
        await editor.fill("textarea", "# Local Notes");
      }
      await editor.focus();
      await editor.focus();
      assert.deepEqual(
        ids,
        ["char-1", "char-1", "char-1"],
        `${operation}: next focus retries without duplication`,
      );
      await act(async () => refreshes[1]!.resolve(updated));
      const feedback = container.querySelector(
        'footer [role="status"]',
      )?.textContent;
      assert.equal(
        feedback,
        localEdits
          ? "Unsaved edits kept after reloading character files."
          : "Character Files Reloaded",
      );
      if (localEdits) {
        await act(async () =>
          refreshes[0]!.reject(new Error("obsolete refresh failure")),
        );
      } else {
        await act(async () => refreshes[0]!.resolve(original));
      }
      assert.equal(
        container.querySelector('footer [role="status"]')?.textContent,
        feedback,
      );
      await editor.click("character.md");
      assert.equal(
        container.querySelector<HTMLTextAreaElement>("textarea")?.value,
        localEdits ? localDefinition : updated.definitionMarkdown,
      );
      await editor.click("character-notes.md");
      assert.equal(
        container.querySelector<HTMLTextAreaElement>("textarea")?.value,
        localEdits ? "# Local Notes" : updated.notesMarkdown,
      );
      await editor.click("Profile");
      assert.equal(
        container.querySelector<HTMLInputElement>("input")?.value,
        localEdits ? "Local Muse" : "Muse",
      );
      assert.equal(findButtonByText(container, "Save").disabled, !localEdits);
      await editor.focus();
      assert.equal(ids.length, 3, "Successful refresh consumes the request");
    } finally {
      await editor.cleanup();
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Character Editorは実行したSaveまたはArchiveだけをbusyとして通知し、失敗後にdraftを保持して再試行でき、保存中の追加編集を上書きせず、現在の編集面を通知する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#操作とアクセシビリティ; docs/design/ui-design-guidelines.md#ボタン; docs/design/desktop-ui.md#character-editor-window" }
// fault = "ArchiveをSaveのbusyとして通知する、失敗後に操作不能となる、保存応答で追加編集を消す、または選択状態を通知しない"
// observable = "button aria-busy/aria-label/aria-pressed/disabled、spinner、保存API入力、icon入力値、feedback、archive確認回数"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp save/archive lifecycle and editor selectors"
// lifecycle = "permanent"
// impact = "操作と状態の誤通知、失敗後の再試行不能、保存中のdraft消失を防ぐ"
// distinction = "state helperと型検査では観測できない実componentの操作別busy・API応答後の編集保持を少数の保留promiseで検証する"
// @end-test-value
/** 保存やアーカイブを待つ間に対応する操作だけが進行を示し、失敗や保存中の編集が適切に扱われることを確認する。 */
test("CharacterEditorApp は操作別busyと編集状態を成功・失敗後も保つ", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://withmate.local/character-editor.html?characterId=char-1",
  });
  const previous = Object.fromEntries(
    ["window", "document", "navigator", "HTMLElement"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const key of Object.keys(previous)) {
    Object.defineProperty(globalThis, key, {
      value: Reflect.get(dom.window, key),
      configurable: true,
    });
  }
  const container = dom.window.document.getElementById("root")!;
  const root = await createEditorRoot(container);
  let currentCharacter = createCharacterDetail();
  let saveRequest = createDeferred<void>();
  let archiveRequest = createDeferred<CharacterDetail>();
  let selectedIcon = "C:\\icons\\first.png";
  let confirmations = 0;
  const savedIcons: string[] = [];
  dom.window.confirm = () => {
    confirmations += 1;
    return true;
  };
  dom.window.withmate = {
    /** 作成エージェントに表示する候補モデルを返す。 */
    async getModelCatalog() {
      return createModelCatalog();
    },
    /** カタログ利用のための標準設定を返す。 */
    async getAppSettings() {
      return createDefaultAppSettings();
    },
    /** 試行ごとに差し替える現在のキャラクターを返す。 */
    async getCharacter() {
      return currentCharacter;
    },
    /** ファイル選択による入力変更を再現し、ネイティブダイアログは開かない。 */
    async pickImageFile() {
      return selectedIcon;
    },
    /** 保存処理を保留し、保存要求の応答時に現在値を返す。 */
    async updateCharacterDefinition() {
      await saveRequest.promise;
      return currentCharacter;
    },
    /** 保存されたアイコンのパスを記録し、そのパスを確定済みのキャラクターに反映する。 */
    async updateCharacterMetadata(input) {
      savedIcons.push(input.iconFilePath ?? "");
      currentCharacter = {
        ...currentCharacter,
        iconFilePath: input.iconFilePath ?? "",
      };
      return currentCharacter;
    },
    /** アーカイブ処理中の操作表示を観測できるよう、応答を保留する。 */
    async archiveCharacter() {
      return archiveRequest.promise;
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;
  /** 表示ラベルから操作を選び、React更新を反映する。 */
  const click = async (label: string) => {
    await act(async () => findButtonByText(container, label).click());
  };
  /** ボタンの進行状態・アクセシブル名・インジケーターが同じ操作を表すことを確かめる。 */
  const assertBusy = (
    button: HTMLButtonElement,
    busy: boolean,
    label: string,
  ) => {
    assert.equal(button.getAttribute("aria-busy"), busy ? "true" : null);
    assert.equal(button.getAttribute("aria-label"), label);
    assert.equal(
      Boolean(button.querySelector(".button-content-spinner")),
      busy,
    );
  };
  try {
    await act(async () => root.render(<CharacterEditorApp />));
    assert.equal(
      findButtonByText(container, "Profile").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      container.querySelectorAll('nav button[aria-pressed="true"]').length,
      1,
    );
    for (const label of [
      "Profile",
      "character.md",
      "character-notes.md",
      "Preview",
      "Profile",
    ]) {
      await click(label);
      const selectors = [
        ...container.querySelectorAll<HTMLButtonElement>("nav button"),
      ];
      assert.equal(
        selectors.filter(
          (button) => button.getAttribute("aria-pressed") === "true",
        ).length,
        1,
      );
      assert.equal(
        findButtonByText(container, label).getAttribute("aria-pressed"),
        "true",
      );
    }
    await click("Import Image");
    const save = findButtonByText(container, "Save");
    const archive = findButtonByText(container, "Archive");
    await click("Save");
    assertBusy(save, true, "Saving character");
    assertBusy(archive, false, "Archive");
    assert.equal(save.disabled, true);
    assert.equal(archive.disabled, true);
    selectedIcon = "C:\\icons\\second.png";
    await click("Import Image");
    await act(async () => saveRequest.resolve());
    assert.deepEqual(savedIcons, ["C:\\icons\\first.png"]);
    assert.equal(container.querySelectorAll("input")[2]?.value, selectedIcon);
    assert.equal(save.disabled, false);
    assertBusy(save, false, "Save");

    saveRequest = createDeferred<void>();
    await click("Save");
    await act(async () => saveRequest.reject(new Error("save failed")));
    assert.match(container.textContent ?? "", /save failed/);
    assert.equal(container.querySelectorAll("input")[2]?.value, selectedIcon);
    assert.equal(save.disabled, false);
    saveRequest = createDeferred<void>();
    await click("Save");
    await act(async () => saveRequest.resolve());
    assert.equal(save.disabled, true);
    assert.equal(archive.disabled, false);

    await click("Archive");
    assertBusy(archive, true, "Archiving character");
    assertBusy(save, false, "Save");
    assert.equal(save.disabled, true);
    assert.equal(archive.disabled, true);
    await act(async () => archiveRequest.reject(new Error("archive failed")));
    assert.match(container.textContent ?? "", /archive failed/);
    assertBusy(archive, false, "Archive");
    assert.equal(archive.disabled, false);
    archiveRequest = createDeferred<CharacterDetail>();
    await click("Archive");
    await act(async () =>
      archiveRequest.resolve({ ...currentCharacter, state: "archived" }),
    );
    assert.equal(confirmations, 2);
    assertBusy(archive, false, "Archive");
    assert.equal(archive.disabled, true);
    assert.match(container.textContent ?? "", /Character archived\./);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Character Editorはproviderのloading/errorを正常emptyと区別し、catalog/settings読取失敗の診断と明示Retryを提供して同じCharacter内容のままStart可能へ復帰する"
// oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md#launch-boundary; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "読取失敗をempty扱いする、診断やRetryを失う、RetryでCharacterを再読込し内容を置換する、またはStart disabledのまま復帰しない"
// observable = "editor/providerのbusy status、error詳細の原文、Retry後のStart disabledとprovider option、Character入力値とgetCharacter回数"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp authoring provider initial loading and catalog/settings retry lifecycle"
// lifecycle = "permanent"
// impact = "provider読取の一時障害でWindow再起動が必須になることと、再試行によるCharacter内容の消失を防ぐ"
// distinction = "型検査では確認できない実componentの失敗から明示Retryへの配線と、独立したCharacter読込を繰り返さないことをdeferredで検証する"
// @end-test-value
/** Providerの読込中や取得障害を空一覧と混同せず、再試行でも読み込み済みのキャラクターを再取得しないことを確認する。 */
test("CharacterEditorApp はauthoring providerのloading/errorを空一覧と区別する", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/character-editor.html?characterId=char-1",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)
    ?.withmate;
  const characterDeferred = createDeferred<CharacterDetail>();
  let catalogDeferred = createDeferred<ModelCatalogSnapshot>();
  let settingsFailure = false;
  let characterReads = 0;
  let catalogReads = 0;

  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoder,
    configurable: true,
  });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;

  dom.window.withmate = {
    /** モデルカタログの取得回数を記録し、応答の成功と失敗を制御する。 */
    async getModelCatalog() {
      catalogReads += 1;
      return catalogDeferred.promise;
    },
    /** 設定読込だけが失敗する場合と、既定設定まで揃った回復時を区別する。 */
    async getAppSettings() {
      if (settingsFailure) throw new Error("settings request failed");
      return createDefaultAppSettings();
    },
    /** 指定された既存IDを確認し、キャラクター取得がProvider取得とは独立して進むことを観測する。 */
    async getCharacter(characterId: string) {
      characterReads += 1;
      assert.equal(characterId, "char-1");
      return characterDeferred.promise;
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = await createEditorRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    const editorBody = rootElement.querySelector(
      "main.character-editor-window-body",
    );
    assert.equal(editorBody?.getAttribute("aria-busy"), "true");

    await act(async () => {
      characterDeferred.resolve(createCharacterDetail());
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const improveButton = findButtonByText(rootElement, "Improve With Agent");
    await act(async () => {
      improveButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.ok(
      rootElement.querySelector(
        '[role="status"][aria-label="Loading coding providers"]',
      ),
    );
    assert.doesNotMatch(
      rootElement.textContent ?? "",
      /No enabled coding providers\./,
    );
    const providerStatus = rootElement.querySelector(
      '[role="status"][aria-busy="true"]',
    );
    assert.ok(providerStatus);
    assert.ok(providerStatus.querySelector(".loading-indicator-spinner"));

    await act(async () => {
      catalogDeferred.reject(new Error("catalog request failed"));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const start = findButtonByText(rootElement, "Start");
    assert.equal(start.disabled, true);
    assert.doesNotMatch(
      rootElement.textContent ?? "",
      /No enabled coding providers\./,
    );
    assert.match(
      rootElement.querySelector('[role="alert"]')?.textContent ?? "",
      /Could not load coding providers/,
    );
    await act(async () =>
      rootElement
        .querySelector<HTMLButtonElement>(
          '[aria-label="Provider Load Error Details"]',
        )!
        .click(),
    );
    assert.match(
      dom.window.document.querySelector(
        '[role="dialog"][aria-label="Provider Load Error Details"]',
      )?.textContent ?? "",
      /catalog request failed/,
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('[aria-label="Close Error Details"]')!
        .click(),
    );

    catalogDeferred = createDeferred<ModelCatalogSnapshot>();
    settingsFailure = true;
    await act(async () => findButtonByText(rootElement, "Retry").click());
    assert.equal(start.disabled, true);
    assert.equal(catalogReads, 2);
    catalogDeferred.resolve(createModelCatalog());
    await act(async () => {
      await Promise.resolve();
    });
    assert.equal(start.disabled, true);
    await act(async () =>
      rootElement
        .querySelector<HTMLButtonElement>(
          '[aria-label="Provider Load Error Details"]',
        )!
        .click(),
    );
    assert.match(
      dom.window.document.querySelector(
        '[role="dialog"][aria-label="Provider Load Error Details"]',
      )?.textContent ?? "",
      /settings request failed/,
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('[aria-label="Close Error Details"]')!
        .click(),
    );

    settingsFailure = false;
    catalogDeferred = createDeferred<ModelCatalogSnapshot>();
    await act(async () => findButtonByText(rootElement, "Retry").click());
    assert.ok(
      rootElement.querySelector(
        '[role="status"][aria-label="Loading coding providers"]',
      ),
    );
    assert.equal(start.disabled, true);
    await act(async () => catalogDeferred.resolve(createModelCatalog()));
    assert.equal(start.disabled, false);
    assert.ok(
      rootElement.querySelector('[role="option"][aria-selected="true"]'),
    );
    assert.equal(rootElement.querySelector("input")?.value, "Muse");
    assert.equal(characterReads, 1);
    assert.equal(catalogReads, 3);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      value: previousTextEncoder,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextDecoder", {
      value: previousTextDecoder,
      configurable: true,
    });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "Character Editorは不正iconのfeedbackで保存を止め、workspace外の定義path errorを表示し、未保存変更の保存後に選択providerとCharacterでauthoringを開始する"
// oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md#product-flow; docs/design/character-definition-format.md#executable-format-contract" }
// fault = "validation errorを表示せず保存する、未保存変更のままauthoringを開始する、または選択provider・Characterを取り違える"
// observable = "validation/feedback text、definition/metadata更新回数、startCharacterAuthoringSession input、icon picker calls"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp validation/save and Improve with Agent"
// lifecycle = "permanent"
// distinction = "shared validatorとstorage拒否testでは観測できないEditorのerror表示、保存API非呼出し、保存後のauthoring開始を同じ操作経路で確認する"
// @end-test-value
/** 検証と保存を経た既存キャラクターで、選択したProviderへ作成エージェント開始を渡し、復帰後の変更を扱うことを確認する。 */
test("CharacterEditorApp は Improve with Agent 押下で authoring session を開始する", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/character-editor.html?characterId=char-1",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)
    ?.withmate;
  const startInputs: StartCharacterAuthoringSessionInput[] = [];
  const metadataUpdates: Array<{
    name: string;
    description: string;
    iconFilePath: string;
  }> = [];
  const iconPickerCalls: Array<{
    initialPath: string | null;
    purpose: string | undefined;
  }> = [];
  let selectedIconPath: string | null = "C:\\icons\\muse.webp";
  let definitionUpdateCount = 0;

  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoder,
    configurable: true,
  });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;
  let currentCharacter = createCharacterDetail();

  dom.window.prompt = () => {
    throw new Error("Improve with Agent should not depend on window.prompt");
  };
  dom.window.withmate = {
    /** エージェントの選択ダイアログで使うモデル一覧を返す。 */
    async getModelCatalog() {
      return createModelCatalog();
    },
    /** ダイアログが有効なProviderを選択できるよう、コーディング用Providerの設定を返す。 */
    async getAppSettings() {
      return {
        ...createDefaultAppSettings(),
        codingProviderSettings: {
          codex: {
            enabled: true,
            apiKey: "",
            skillRootPath: "",
            skillRelativePath: "",
            instructionRelativePath: "",
          },
          copilot: {
            enabled: true,
            apiKey: "",
            skillRootPath: "",
            skillRelativePath: "",
            instructionRelativePath: "",
          },
        },
      };
    },
    /** 編集対象のIDを確認し、エージェントによる変更後は最新の定義を返す。 */
    async getCharacter(characterId: string) {
      assert.equal(characterId, "char-1");
      return currentCharacter;
    },
    /** 開始に渡されたモード・対象・Providerを記録し、起動したセッションの情報を返す。 */
    async startCharacterAuthoringSession(input) {
      startInputs.push(input);
      const session = buildNewSession({
        taskTitle: "Muse の character.md 改善",
        workspaceLabel: "Muse authoring",
        workspacePath: "C:/tmp/withmate-authoring",
        branch: "main",
        sessionKind: "character-authoring",
        characterId: "char-1",
        character: "Muse",
        characterIconPath: "",
        characterThemeColors: {
          main: DEFAULT_CHARACTER_THEME.main,
          sub: DEFAULT_CHARACTER_THEME.sub,
        },
        approvalMode: "on-request",
      });
      return {
        session,
        workspacePath: "C:/tmp/withmate-authoring",
        runId: "run-1",
      };
    },
    /** 対象IDを確認し、定義保存の回数とノートへの反映を記録する。 */
    async updateCharacterDefinition(input) {
      assert.equal(input.characterId, "char-1");
      definitionUpdateCount += 1;
      currentCharacter = {
        ...currentCharacter,
        definitionMarkdown: input.definitionMarkdown,
        notesMarkdown: input.notesMarkdown ?? "",
      };
      return currentCharacter;
    },
    /** 定義保存に伴う名前・説明・アイコンの変更を記録し、メタデータの確定値を返す。 */
    async updateCharacterMetadata(input) {
      assert.equal(input.characterId, "char-1");
      metadataUpdates.push({
        name: input.name ?? "",
        description: input.description ?? "",
        iconFilePath: input.iconFilePath ?? "",
      });
      currentCharacter = {
        ...currentCharacter,
        name: input.name ?? "",
        description: input.description ?? "",
        iconFilePath: input.iconFilePath ?? "",
        theme: { ...currentCharacter.theme, ...(input.theme ?? {}) },
      };
      return currentCharacter;
    },
    /** アイコン選択に渡す初期パスと用途を記録する。 */
    async pickImageFile(initialPath, purpose) {
      iconPickerCalls.push({
        initialPath: initialPath ?? null,
        purpose,
      });
      return selectedIconPath;
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = await createEditorRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      findButtonByText(rootElement, "Import Image").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    assert.deepEqual(iconPickerCalls, [
      {
        initialPath: null,
        purpose: "character-icon",
      },
    ]);

    await act(async () => {
      findButtonByText(rootElement, "Save").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    assert.equal(definitionUpdateCount, 0);
    assert.equal(metadataUpdates.length, 0);
    assert.match(
      rootElement.textContent ?? "",
      /Character icon must be a PNG, JPG, or JPEG image file\./,
    );
    selectedIconPath = "C:\\icons\\muse.png";
    await act(async () => {
      findButtonByText(rootElement, "Import Image").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    const button = findButtonByText(rootElement, "Improve With Agent");
    assert.equal(button.disabled, false);

    await act(async () => {
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.equal(startInputs.length, 0);
    assert.match(
      rootElement.textContent ?? "",
      /Save your changes before starting an authoring session\./,
    );

    await act(async () => {
      findButtonByText(rootElement, "Save").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    assert.equal(definitionUpdateCount, 1);
    assert.equal(metadataUpdates.length, 1);

    await act(async () => {
      button.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });

    const codexProviderButton = findButtonByText(rootElement, "Codex");
    assert.equal(codexProviderButton.getAttribute("aria-selected"), "true");
    const copilotProviderButton = findButtonByText(rootElement, "Copilot");
    await act(async () => {
      copilotProviderButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });

    const startButton = findButtonByText(rootElement, "Start");
    assert.equal(startButton.disabled, false);
    await act(async () => {
      startButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });

    assert.deepEqual(startInputs, [
      {
        mode: "improve",
        characterId: "char-1",
        provider: "copilot",
      },
    ]);

    currentCharacter = {
      ...currentCharacter,
      definitionMarkdown: [
        "---",
        "schema: withmate-character-v5",
        'name: "Muse Prime"',
        'description: "agent が更新した説明"',
        "---",
        "",
        "# Updated By Agent",
      ].join("\n"),
      notesMarkdown: "# Updated Notes",
    };

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await Promise.resolve();
    });

    const definitionTab = findButtonByText(rootElement, "character.md");
    await act(async () => {
      definitionTab.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    const definitionTextarea = rootElement.querySelector(
      "textarea.character-editor-textarea",
    ) as HTMLTextAreaElement | null;
    assert.ok(definitionTextarea);
    assert.match(definitionTextarea.value, /# Updated By Agent/);

    const saveButton = findButtonByText(rootElement, "Save");
    assert.equal(saveButton.disabled, false);
    await act(async () => {
      saveButton.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    assert.deepEqual(metadataUpdates.at(-1), {
      name: "Muse Prime",
      description: "agent が更新した説明",
      iconFilePath: "C:\\icons\\muse.png",
    });

    await act(async () => {
      findButtonByText(rootElement, "Improve With Agent").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      findButtonByText(rootElement, "Start").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    currentCharacter = {
      ...currentCharacter,
      definitionMarkdown: `${currentCharacter.definitionMarkdown}\n![outside](../outside.png)\n`,
    };
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await Promise.resolve();
    });
    const validationList = rootElement.querySelector(
      ".character-editor-validation-list",
    );
    assert.match(validationList?.textContent ?? "", /unsafe_path_reference/);
    assert.match(
      validationList?.textContent ?? "",
      /Unsafe character definition path reference: \.\.\/outside\.png/,
    );
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      value: previousTextEncoder,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextDecoder", {
      value: previousTextDecoder,
      configurable: true,
    });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "未保存のCharacterではauthoring開始操作を無効にする"
// oracle = { type = "contract", ref = "docs/design/character-authoring-growth.md#launch-boundary" }
// fault = "未保存draftでauthoring開始操作が可能になる"
// observable = "Author With Agent buttonのdisabled state"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp unsaved authoring gate"
// lifecycle = "permanent"
// impact = "保存前の不正なCharacterをauthoringへ渡さず、次に必要な修正操作をユーザーへ残す"
// distinction = "service境界の拒否testとは別にEditor上の開始操作を確認する"
// @end-test-value
/** キャラクターをまだ保存していない場合、作成エージェントを開始できないことを確認する。 */
test("CharacterEditorApp は未保存 Character では Author with Agent を開始できない", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/character-editor.html",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)
    ?.withmate;

  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoder,
    configurable: true,
  });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;

  dom.window.withmate = {
    /** 未保存時にも通常のモデル一覧を与え、開始を妨げる条件を保存状態だけにする。 */
    async getModelCatalog() {
      return createModelCatalog();
    },
    /** Provider設定が取得できる既定状態で開始の制約を検証する。 */
    async getAppSettings() {
      return createDefaultAppSettings();
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = await createEditorRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const button = findButtonByText(rootElement, "Author With Agent");
    assert.equal(button.disabled, true);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    dom.window.close();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      value: previousTextEncoder,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextDecoder", {
      value: previousTextDecoder,
      configurable: true,
    });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});

// @test-value v2
// kind = "contract"
// claim = "新規Character Editorのdirtyなnative closeは破棄確認を表示し、Cancelでは保持し明示的な破棄後だけWindowを閉じる"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#character-editor-window" }
// fault = "dirty draftのnative closeを確認なしで閉じる、Cancelで内容を失う、または確認後もcloseを実行しない"
// observable = "beforeunload defaultPrevented、discard dialog copy、Cancel/Discard And Close controls、window close call count"
// observation_boundary = "component-behavior"
// scope = "CharacterEditorApp dirty native close"
// lifecycle = "permanent"
// impact = "ユーザーのCharacter定義・notes・metadataを意図しないcloseから保護する"
// distinction = "beforeunloadの抑止だけでなく、確認のキャンセルと明示破棄後のcloseを連続操作で確認する"
// @end-test-value
/** 未保存の新規入力があるウィンドウの終了で確認を出し、取消なら残し明示破棄のときだけ閉じることを確認する。 */
test("CharacterEditorApp は新規作成中のnative closeで破棄確認を表示する", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "https://withmate.local/character-editor.html",
    },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousTextEncoder = globalThis.TextEncoder;
  const previousTextDecoder = globalThis.TextDecoder;
  const previousWithMate = (globalThis.window as typeof window | undefined)
    ?.withmate;
  const closeDom = dom.window.close.bind(dom.window);
  let closeCalls = 0;

  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoder,
    configurable: true,
  });
  Object.defineProperty(dom.window, "close", {
    configurable: true,
    /** 利用者の選択後にウィンドウを閉じる要求が届いた回数を記録する。 */
    value: () => {
      closeCalls += 1;
    },
  });

  const rootElement = dom.window.document.getElementById("root");
  assert.ok(rootElement);
  let root: Root | null = null;

  dom.window.withmate = {
    /** ウィンドウ終了テストで編集画面の初期化に使うカタログを返す。 */
    async getModelCatalog() {
      return createModelCatalog();
    },
    /** 編集画面の初期化に必要な既定設定を返す。 */
    async getAppSettings() {
      return createDefaultAppSettings();
    },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;

  try {
    await act(async () => {
      root = await createEditorRoot(rootElement);
      root.render(<CharacterEditorApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const firstCloseEvent = new dom.window.Event("beforeunload", {
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(firstCloseEvent);
    });
    assert.equal(firstCloseEvent.defaultPrevented, true);
    assert.match(rootElement.textContent ?? "", /Discard new character\?/);
    assert.doesNotMatch(
      rootElement.textContent ?? "",
      /The unsaved content will be lost\./,
    );
    const closeDialog = rootElement.querySelector(
      ".character-editor-close-dialog",
    );
    assert.ok(closeDialog);
    assert.equal(closeDialog.querySelector(".launch-section"), null);
    assert.equal(closeCalls, 0);

    await act(async () => {
      findButtonByText(rootElement, "Cancel").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.doesNotMatch(
      rootElement.textContent ?? "",
      /Discard new character\?/,
    );
    assert.equal(closeCalls, 0);

    const secondCloseEvent = new dom.window.Event("beforeunload", {
      cancelable: true,
    });
    await act(async () => {
      dom.window.dispatchEvent(secondCloseEvent);
    });
    assert.equal(secondCloseEvent.defaultPrevented, true);

    await act(async () => {
      findButtonByText(rootElement, "Discard And Close").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.equal(closeCalls, 1);

    const confirmedCloseEvent = new dom.window.Event("beforeunload", {
      cancelable: true,
    });
    assert.equal(dom.window.dispatchEvent(confirmedCloseEvent), true);
    assert.equal(confirmedCloseEvent.defaultPrevented, false);
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    closeDom();
    Object.defineProperty(globalThis, "window", {
      value: previousWindow,
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: previousDocument,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator,
      configurable: true,
    });
    Object.defineProperty(globalThis, "HTMLElement", {
      value: previousHTMLElement,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      value: previousTextEncoder,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextDecoder", {
      value: previousTextDecoder,
      configurable: true,
    });
    if (previousWindow) {
      previousWindow.withmate = previousWithMate;
    }
  }
});
