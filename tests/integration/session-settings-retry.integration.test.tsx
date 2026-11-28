import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

/** 設定とカタログの応答をテストから個別に成功・失敗させるため、決着前の Promise とその操作を返す。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// @test-value v2
// kind = "contract"
// claim = "Sessionの設定とcatalogの初回取得失敗を個別に再試行でき、会話とdraftを保持し、両方の回復後にSendを有効化する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "設定取得失敗でSendが永久に無効になる、Retryが別のreadまで再実行する、または会話やdraftを初期化する"
// observable = "実SessionWindowAppのRetry操作、取得回数、会話DOM identity、textarea値、Send disabled状態、関連errorのaria-describedby"
// observation_boundary = "component-behavior"
// scope = "Session settings read error recovery"
// lifecycle = "permanent"
// impact = "一時的なIPC失敗で作業が継続不能になり、Windowの再起動を強制される"
// distinction = "型検査やsubscription単体testでは取得失敗から実画面の再試行とSend回復への接続を確認できない"
// @end-test-value
/** 設定とカタログの初回失敗を別々に再試行し、会話 DOM・下書き・選択したタブを保ったまま、両方の成功後にだけ送信可能になることを確かめる。 */
test("Sessionの設定とcatalogを独立して再試行し会話とdraftを保持する", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://withmate.test/session.html?sessionId=benchmark-main",
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
    /** 描画待ちのコールバックを JSDOM 上のタイマーに予約する。 */
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    /** 予約した描画コールバックを取り消す。 */
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    ResizeObserver: class {
      observe /** サイズ通知を発生させずに監視を受け付ける。 */() {}
      disconnect /** サイズ監視の終了を受け付ける。 */() {}
      unobserve /** 要素単位のサイズ監視解除を受け付ける。 */() {}
    },
    IntersectionObserver: class {
      observe /** 交差通知を発生させずに監視を受け付ける。 */() {}
      disconnect /** 交差監視の終了を受け付ける。 */() {}
      unobserve /** 要素単位の交差監視解除を受け付ける。 */() {}
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
    /** メディアクエリに一致しない固定環境を返す。 */ value: () => ({
      matches: false,
      /** 一致条件の変更通知を登録しても発火させない。 */ addEventListener() {},
      /** メディアクエリの変更通知の解除を受け付ける。 */ removeEventListener() {},
    }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    /** JSDOM ではレイアウトを動かさず、表示位置へのスクロール要求を受け付ける。 */ value() {},
  });
  dom.window.HTMLElement.prototype.scrollTo = function () {};
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
      /** ベンチマーク用 preload に Electron の公開用ブリッジだけを渡す。 */
      require: () => ({
        contextBridge: {
          /** preload が公開した API を捕捉し、取得応答を試験で差し替えられるようにする。 */ exposeInMainWorld:
            (_key: string, value: WithMateWindowApi) => {
              api = value;
            },
        },
      }),
      process: { argv: [] },
      Buffer,
    },
  );
  const settings = await api.getAppSettings();
  let settingsRead = deferred<typeof settings>();
  let catalogRead =
    deferred<Awaited<ReturnType<WithMateWindowApi["getModelCatalog"]>>>();
  const calls = { settings: 0, catalog: 0, conversation: 0 };
  const getSession = api.getSession;
  api.getSession = (...args) => {
    calls.conversation += 1;
    return getSession(...args);
  };
  api.getAppSettings = () => {
    calls.settings += 1;
    return settingsRead.promise;
  };
  api.getModelCatalog = () => {
    calls.catalog += 1;
    return catalogRead.promise;
  };
  api.listAuxiliarySessions = async () => [];
  api.listSessionFileRoots = async () => [];
  api.getSessionGlossaryProjection = async () => ({
    sessionId: "benchmark-main",
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
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({
    /** Session 画面が読み込む CSS は空モジュールに換え、それ以外の読み込みは次のフックへ渡す。 */ load(
      url,
      context,
      next,
    ) {
      return url.endsWith(".css")
        ? { format: "module", shortCircuit: true, source: "" }
        : next(url, context);
    },
  });
  const { default: App } =
    await import("../../src/app/SessionWindowApp.js").finally(() =>
      cssImports.deregister(),
    );
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  /** 描画済みの画面から指定ラベルのボタンを取得し、見つからなければテストを失敗させる。 */
  const button = (label: string) => {
    const result = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((element) => element.textContent?.trim() === label);
    assert.ok(result, `Missing ${label}`);
    return result;
  };
  try {
    await act(async () => {
      root.render(<App />);
    });
    const conversation = container.querySelector(
      "#session-main-chat-pane .conversation-message-column",
    );
    assert.ok(conversation);
    await act(async () => {
      settingsRead.reject(new Error("Settings unavailable"));
      catalogRead.reject(new Error("Catalog unavailable"));
    });
    assert.equal(
      container.querySelectorAll('[role="alert"]').length,
      2,
      "Show each failure once",
    );
    const composer = container.querySelector<HTMLTextAreaElement>("textarea")!;
    for (const alert of container.querySelectorAll('[role="alert"]')) {
      assert.ok(
        composer
          .getAttribute("aria-describedby")
          ?.split(" ")
          .includes(alert.id),
      );
    }
    // 送信がブロックされている間に、実際の変更ハンドラーを通じて下書きを入力する。
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(composer, "Keep this draft");
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(button("Send").disabled, true);
    settingsRead = deferred<typeof settings>();
    await act(async () => {
      button("Retry App Settings").click();
    });
    assert.deepEqual(calls, { settings: 2, catalog: 1, conversation: 1 });
    assert.equal(button("Send").disabled, true);
    await act(async () => {
      settingsRead.resolve({
        ...settings,
        chatLayoutPreference: {
          header: "visible",
          sidePane: "files",
          actionDock: "expanded",
        },
      });
    });
    assert.equal(composer.value, "Keep this draft");
    assert.equal(
      button("Send").disabled,
      true,
      "Catalog failure still blocks sending",
    );
    const files = container.querySelector('[aria-label="File explorer"]');
    assert.ok(files);
    const changes = [
      ...files.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((element) => element.textContent === "Changes")!;
    await act(async () => {
      changes.click();
    });
    catalogRead =
      deferred<Awaited<ReturnType<WithMateWindowApi["getModelCatalog"]>>>();
    await act(async () => {
      button("Retry Model Catalog").click();
    });
    assert.deepEqual(calls, { settings: 2, catalog: 2, conversation: 1 });
    assert.equal(button("Send").disabled, true);
    await act(async () => {
      catalogRead.resolve({
        workspacePath: "benchmark-workspace",
        providers: [
          {
            id: "codex",
            label: "Codex",
            defaultModelId: "gpt-5.4-mini",
            defaultReasoningEffort: "medium",
            models: [
              {
                id: "gpt-5.4-mini",
                label: "GPT-5.4 Mini",
                reasoningEfforts: ["medium"],
              },
            ],
          },
        ],
      });
    });
    assert.equal(container.querySelectorAll('[role="alert"]').length, 0);
    assert.equal(
      container.querySelector(
        "#session-main-chat-pane .conversation-message-column",
      ),
      conversation,
    );
    assert.equal(composer.value, "Keep this draft");
    assert.equal(changes.getAttribute("aria-selected"), "true");
    assert.equal(button("Send").disabled, false);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
