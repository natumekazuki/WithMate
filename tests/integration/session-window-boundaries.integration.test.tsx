import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

// @test-value v2
// kind = "invariant"
// claim = "Session WindowのMain/Auxiliary live本文は選択中の会話へ届き、Auxiliaryのterminalは保存本文へ一度だけ収束する。本文だけの更新、Files tab変更、Glossary検索は無関係なAuxiliary一覧の全summaryを再投影せず、Auxiliary draftを保持する。Directory追加dialogは送信先切替で閉じ、Files取得ownerは送信先切替へ追従する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: UI Implementation Boundary; pending中のlive activity / streaming response; AgentのFile Explorer" }
// fault = "rootが全文live snapshotやFiles tab/Glossary検索で一覧summaryを全件評価する、会話のlive購読が失われる、terminal後にliveと保存本文が二重表示される、補助機能の操作でAuxiliary draftが消える、送信先切替で追加dialogが残る、またはFiles取得ownerが送信先切替へ追従しない"
// observable = "実AppのMain/Auxiliary会話本文、Glossary検索owner、Auxiliary composer draft、summary characterIconPath getter読取回数、追加dialogの開閉状態、Files取得APIのSession ID"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp conversation update boundariesとFiles／Directory追加対象。live本文は非同期の表示反映を待ち、terminal本文は直ちに確認する"
// lifecycle = "permanent"
// impact = "長い会話・多数Auxiliaryの実行中に無関係な一覧処理が波及し、応答の消失や重複で会話を読めなくなる"
// distinction = "hook単体や型検査ではroot→ChatWindow→会話列の購読・表示とAuxiliary一覧への伝播を同時に検証できない。壁時計性能値をCI合否に使わない"
// @end-test-value
/** 実行中の本文が対象会話だけに届いて保存済み本文へ収束し、補助機能の操作が一覧投影や別対象の草稿に波及しないことを確認する。 */
test(
  "Session Windowのlive本文は一覧投影を広げず会話へ届きterminal本文へ収束する",
  { timeout: 30_000 },
  async () => {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", {
      url: "http://withmate.test/session.html?sessionId=benchmark-main",
      pretendToBeVisual: true,
    });
    const globals = {
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
      localStorage: dom.window.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
      /** 描画フレームをタイマーで代替し、コールバックに現在時刻を渡す。 */
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0),
      /** フレームの取り消しを、予約したタイマーの解除に対応させる。 */
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
        clearTimeout(id),
      ResizeObserver: class {
        /** 実測値を通知せず、サイズ監視の登録だけを受け付ける。 */ observe() {}
        /** サイズ監視の後処理を受け付ける。登録状態は持たない。 */ disconnect() {}
        /** サイズ監視からの個別解除を副作用なしで受け付ける。 */ unobserve() {}
      },
      IntersectionObserver: class {
        /** 交差状態を計算せず、可視性の監視登録を受け付ける。 */ observe() {}
        /** 可視性監視の後処理を受け付ける。登録状態は持たない。 */ disconnect() {}
        /** 可視性監視からの個別解除を副作用なしで受け付ける。 */ unobserve() {}
      },
    };
    const originals = new Map(
      Object.keys(globals).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    Object.defineProperty(dom.window, "matchMedia", {
      /** メディアクエリを非一致に固定し、条件変化に左右されない表示を作る。 */ value:
        () => ({
          matches: false,
          /** メディアクエリの変化通知は配信せず、登録だけを受け付ける。 */ addEventListener() {},
          /** 保存していないメディアクエリのリスナーを副作用なく解除した扱いにする。 */ removeEventListener() {},
        }),
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      /** スクロール位置の変更を描画環境に依存させず、履歴の更新だけを観測できるようにする。 */ value() {},
    });
    const getBoundingClientRect =
      dom.window.HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(
      dom.window.HTMLElement.prototype,
      "getBoundingClientRect",
      {
        configurable: true,
        /** 履歴リストの測定結果だけを固定し、それ以外の要素は JSDOM の標準値を使う。 */
        value: function (this: HTMLElement) {
          return this.classList.contains("session-message-list")
            ? {
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                right: 800,
                bottom: 720,
                width: 800,
                height: 720,
                /** 矩形が備えるシリアライズ用のメソッドを形だけ用意する。このケースでは矩形をシリアライズしない。 */ toJSON() {},
              }
            : getBoundingClientRect.call(this);
        },
      },
    );
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      /** 仮想化された履歴の表示領域が確保されるよう、リストの外寸を固定する。 */
      get(this: HTMLElement) {
        return this.classList.contains("session-message-list") ? 720 : 0;
      },
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      /** 会話列のスクロール判定で使う履歴リストの内寸を固定する。 */
      get(this: HTMLElement) {
        return this.classList.contains("session-message-list") ? 720 : 0;
      },
    });
    dom.window.HTMLElement.prototype.scrollTo = function (
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      this.scrollTop =
        typeof options === "number"
          ? (y ?? this.scrollTop)
          : (options?.top ?? this.scrollTop);
    };
    let api!: WithMateWindowApi;
    runInNewContext(
      readFileSync(
        new URL(
          "../../scripts/benchmarks/benchmark-composer-input-preload.cjs",
          import.meta.url,
        ),
        "utf8",
      ),
      {
        /** 検証用 preload が Electron 以外のモジュールを要求していないことを確認し、bridge を提供する。 */
        require: (name: string) => {
          assert.equal(name, "electron");
          return {
            contextBridge: {
              /** 公開 API を VM から取得し、live 本文とファイル取得対象を記録する差し替えを可能にする。 */ exposeInMainWorld:
                (_key: string, value: WithMateWindowApi) => {
                  api = value;
                },
            },
          };
        },
        process: { argv: ["--benchmark-auxiliary-count=40"] },
        Buffer,
      },
    );
    const liveListeners = new Set<
      Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]
    >();
    api.subscribeLiveSessionRun = (listener) => {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    };
    const liveStates = new Map<string, LiveSessionRunState | null>();
    api.getLiveSessionRun = async (id) => liveStates.get(id) ?? null;
    const fileOwners: string[] = [];
    api.listSessionFileRoots = async (id) => {
      fileOwners.push(id);
      return [];
    };
    api.getSessionGlossaryProjection = async (id) => ({
      sessionId: id,
      scopeRevision: "fixture",
      sequence: 1,
      checkout: {
        repositoryName: "Fixture",
        branch: "test",
        pathLabel: "fixture",
      },
      state: {
        status: "valid",
        relativePath: ".withmate/glossary.yaml",
        revision: "fixture",
        entries: [],
      },
    });
    const glossarySearchOwners: string[] = [];
    api.searchSessionGlossary = async (id, request) => {
      glossarySearchOwners.push(id);
      return {
        ok: true,
        revision: "fixture",
        entries: [
          {
            term: request.query,
            aliases: [],
            definition: "fixture definition",
          },
        ],
        total: 1,
        offset: 0,
        pageSize: 100,
      };
    };
    const getSession = api.getSession;
    api.getSession = async (id) => {
      const session = await getSession(id);
      return session
        ? {
            ...session,
            messages: [{ role: "user", text: "main current prompt" }],
          }
        : null;
    };
    let summaryReads = 0;
    const listAuxiliary = api.listAuxiliarySessions;
    api.listAuxiliarySessions = async (id) =>
      (await listAuxiliary(id)).map((summary) => ({
        ...summary,
        /** 全 Auxiliary の一覧投影が再実行されたか識別するため、一覧項目のアイコン読み取り回数を数える。 */
        get characterIconPath() {
          summaryReads += 1;
          return "";
        },
      }));
    const originalAuxiliary = api.getAuxiliarySession;
    let savedAuxiliaryResponse = "";
    let terminalTargetId = "";
    let loadedAuxiliaryId = "";
    api.getAuxiliarySession = async (id) => {
      loadedAuxiliaryId = id;
      const session = await originalAuxiliary(id);
      if (!session) return null;
      const messages = [{ role: "user" as const, text: "aux current prompt" }];
      return id === terminalTargetId && savedAuxiliaryResponse
        ? {
            ...session,
            runState: "idle",
            messages: [
              ...messages,
              { role: "assistant", text: savedAuxiliaryResponse },
            ],
          }
        : { ...session, messages };
    };
    const originalStatus = api.getAuxiliarySessionStatus;
    api.getAuxiliarySessionStatus = async (id) => {
      const status = await originalStatus(id);
      return status
        ? { ...status, runState: savedAuxiliaryResponse ? "idle" : "running" }
        : null;
    };
    Object.defineProperty(dom.window, "withmate", { value: api });
    const cssImports = registerHooks({
      /** CSS だけ空モジュールに置換し、実際の Session 画面の import を通す。 */ load(
        url,
        context,
        next,
      ) {
        return url.endsWith(".css")
          ? { format: "module", shortCircuit: true, source: "" }
          : next(url, context);
      },
    });
    const { createRoot } = await import("react-dom/client");
    const { default: App } = await import("../../src/app/SessionWindowApp.js");
    const root = createRoot(dom.window.document.getElementById("root")!);
    /** 応答本文以外の要素を空にした live 状態を作り、本文更新だけが伝わるか調べる。 */
    const run = (
      sessionId: string,
      assistantText: string,
    ): LiveSessionRunState => ({
      sessionId,
      threadId: `${sessionId}-thread`,
      assistantText,
      steps: [],
      backgroundTasks: [],
      usage: null,
      errorMessage: "",
      approvalRequest: null,
      elicitationRequest: null,
    });
    /** Session ごとの live 状態を更新し、購読通知を React の再描画まで反映する。 */
    const emit = async (
      sessionId: string,
      state: LiveSessionRunState | null,
    ) => {
      liveStates.set(sessionId, state);
      await act(async () => {
        liveListeners.forEach((listener) => listener(sessionId, state));
      });
    };
    /** 指定した会話ペインから、実際に画面に出ている本文を取り出す。 */
    const columnText = (selector: string) =>
      dom.window.document.querySelector(selector)?.textContent ?? "";
    /** ライブ通知後に本文が届くまで短い期限付きで待ち、未描画なら対象の文言を示して失敗させる。 */
    const waitForColumnText = async (selector: string, text: string) => {
      const deadline = Date.now() + 2_000;
      while (!columnText(selector).includes(text) && Date.now() < deadline) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      assert.ok(
        columnText(selector).includes(text),
        `Expected conversation text: ${text}`,
      );
    };
    /** 最新位置へ飛ぶ操作が提示されている場合だけ実行し、応答本文の可視化を待てる状態にする。 */
    const jumpLatest = async (selector: string) => {
      const button = dom.window.document.querySelector<HTMLButtonElement>(
        `${selector} button[aria-label='Jump to latest']`,
      );
      if (button)
        await act(async () => {
          button.click();
        });
    };
    try {
      await act(async () => {
        root.render(<App />);
      });
      const initialReads = summaryReads;
      await emit("benchmark-main", run("benchmark-main", "main live first"));
      await emit("benchmark-main", run("benchmark-main", "main live latest"));
      await jumpLatest("#session-main-chat-pane");
      await waitForColumnText("#session-main-chat-pane", "main live latest");
      assert.match(columnText("#session-main-chat-pane"), /main live latest/);
      assert.doesNotMatch(
        columnText("#session-main-chat-pane"),
        /main live first/,
      );
      assert.equal(
        summaryReads,
        initialReads,
        "main live text must not reproject every Auxiliary summary",
      );

      const openAuxiliary =
        dom.window.document.querySelector<HTMLButtonElement>(
          "button[aria-label='Open Auxiliary']",
        );
      assert.ok(openAuxiliary);
      await act(async () => {
        openAuxiliary.click();
      });
      const auxiliaryTarget = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".concurrent-chat-target-dock button",
        ),
      ).find((button) => button.textContent === "Auxiliary");
      assert.ok(auxiliaryTarget);
      await act(async () => {
        auxiliaryTarget.click();
      });
      terminalTargetId = loadedAuxiliaryId;
      assert.ok(terminalTargetId);
      await emit(terminalTargetId, run(terminalTargetId, "aux live first"));
      const auxiliaryReads = summaryReads;
      await emit(terminalTargetId, run(terminalTargetId, "aux live latest"));
      await jumpLatest("#session-auxiliary-chat-pane");
      await waitForColumnText(
        "#session-auxiliary-chat-pane",
        "aux live latest",
      );
      assert.match(
        columnText("#session-auxiliary-chat-pane"),
        /aux live latest/,
      );
      assert.doesNotMatch(
        columnText("#session-auxiliary-chat-pane"),
        /aux live first/,
      );
      assert.equal(
        summaryReads,
        auxiliaryReads,
        "auxiliary live text must not reproject every summary",
      );

      savedAuxiliaryResponse = "auxiliary final response";
      await emit(terminalTargetId, null);
      const rendered = columnText("#session-auxiliary-chat-pane");
      assert.equal(rendered.split(savedAuxiliaryResponse).length - 1, 1);
      assert.doesNotMatch(rendered, /aux live latest/);

      const textarea = dom.window.document.querySelector<HTMLTextAreaElement>(
        'textarea[data-shortcut-scope="composer"]',
      );
      assert.ok(textarea);
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(textarea, "auxiliary draft to keep");
        textarea.dispatchEvent(
          new dom.window.Event("input", { bubbles: true }),
        );
      });
      assert.equal(textarea.value, "auxiliary draft to keep");
      const openFiles = dom.window.document.querySelector<HTMLButtonElement>(
        "button[aria-label='Open File explorer']",
      );
      assert.ok(openFiles);
      const beforeFileTab = summaryReads;
      await act(async () => {
        openFiles.click();
      });
      assert.equal(fileOwners.at(-1), terminalTargetId);
      const changesTab = dom.window.document.querySelector<HTMLButtonElement>(
        ".session-file-explorer-tabs button[role='tab']:nth-child(2)",
      );
      assert.ok(changesTab);
      await act(async () => {
        changesTab.click();
      });
      assert.equal(textarea.value, "auxiliary draft to keep");
      assert.equal(
        summaryReads,
        beforeFileTab,
        "local Files tab changes must not reproject Auxiliary summaries",
      );

      const mainTarget = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>(
          ".concurrent-chat-target-dock button",
        ),
      ).find((button) => button.textContent === "Main");
      assert.ok(mainTarget);
      await act(async () => {
        mainTarget.click();
      });
      assert.equal(fileOwners.at(-1), "benchmark-main");
      const addByPath = dom.window.document.querySelector<HTMLButtonElement>(
        'button[title="Add Directory By Path"]',
      );
      assert.ok(addByPath);
      await act(async () => {
        addByPath.click();
      });
      assert.ok(
        dom.window.document.querySelector(
          '[role="dialog"][aria-label="Add Directory By Path"]',
        ),
      );
      await act(async () => {
        auxiliaryTarget.click();
      });
      assert.equal(
        dom.window.document.querySelector(
          '[role="dialog"][aria-label="Add Directory By Path"]',
        ),
        null,
      );
      assert.equal(fileOwners.at(-1), terminalTargetId);
      assert.equal(textarea.value, "auxiliary draft to keep");

      const openContext = dom.window.document.querySelector<HTMLButtonElement>(
        "button[aria-label='Open right pane']",
      );
      assert.ok(openContext);
      await act(async () => {
        openContext.click();
      });
      const rightPaneSwitcher =
        dom.window.document.querySelector<HTMLButtonElement>(
          "[aria-label='Right pane view'] .session-switcher-current",
        );
      assert.ok(rightPaneSwitcher);
      await act(async () => {
        rightPaneSwitcher.click();
      });
      const glossaryOption = Array.from(
        dom.window.document.querySelectorAll<HTMLButtonElement>(
          "[aria-label='Right pane view list'] [role='option']",
        ),
      ).find((option) => option.textContent?.trim() === "Glossary");
      assert.ok(glossaryOption);
      await act(async () => {
        glossaryOption.click();
      });
      const glossarySearch =
        dom.window.document.querySelector<HTMLInputElement>(
          ".glossary-search-field input",
        );
      assert.ok(glossarySearch);
      const beforeSearch = summaryReads;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(glossarySearch, "fixture term");
        glossarySearch.dispatchEvent(
          new dom.window.Event("input", { bubbles: true }),
        );
      });
      assert.deepEqual(glossarySearchOwners, ["benchmark-main"]);
      assert.equal(textarea.value, "auxiliary draft to keep");
      assert.equal(
        summaryReads,
        beforeSearch,
        "glossary search must not reproject Auxiliary summaries",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      cssImports.deregister();
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);
