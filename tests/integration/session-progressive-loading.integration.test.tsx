import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  Session,
  SessionSummary,
} from "../../src-shared/session/session-state.js";

/** 基本情報と会話の取得を別々に完了・失敗させ、画面への反映順をテスト側で制御できるようにする。 */
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
// kind = "invariant"
// claim = "Session基本情報の取得後は会話待ち・失敗でもFilesを操作でき、会話だけを再試行できる。読込待ちを送信中・成功した空会話と区別する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/744; docs/design/ui-design-guidelines.md#ボタン; docs/design/ui-design-guidelines.md#読込・空・失敗" }
// fault = "会話取得をshell表示の条件にする、読込中を送信中に見せる、失敗を空会話と扱う、または未取得の会話を送信可能とする"
// observable = "実SessionWindowAppの基本情報・Files tab操作・会話パネルのloading/status/alert・Retry後の会話DOM・Send disabled/busyと理由"
// observation_boundary = "component-behavior"
// scope = "Session Window progressive data reads"
// lifecycle = "permanent"
// impact = "長い履歴や読込失敗で無関係なパーツが使えず、未取得データを空として上書きする危険がある"
// distinction = "型検査とstorage単体testでは複数IPCの解決順と実画面の独立操作を検出できない。deferred promiseで時間に依存せず確認する"
// @end-test-value
/** 会話取得の完了を待たずに Files を操作でき、読込中・取得失敗・取得済みの空会話を区別することを確かめる。 */
test("Sessionは基本情報から描画し会話の失敗と空状態を独立して扱う", async () => {
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
    /** JSDOM で未実装のスクロール要求を受け付ける。スクロール位置はこのケースの検証対象外。 */ value() {},
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
      /** Electron の bridge を模した依存だけを提供し、検証用 preload を VM で読み込む。 */
      require: () => ({
        contextBridge: {
          /** preload の公開 API を捕捉し、取得完了順を制御できるよう読み取りを差し替える。 */ exposeInMainWorld:
            (_key: string, value: WithMateWindowApi) => {
              api = value;
            },
        },
      }),
      process: { argv: [] },
      Buffer,
    },
  );
  const session = (await api.getSession("benchmark-main"))!;
  const summary = (await api.getSessionSummary("benchmark-main"))!;
  const summaryRead = deferred<SessionSummary | null>();
  let conversationRead = deferred<Session | null>();
  let conversationCalls = 0;
  let filesCalls = 0;
  /** 購読者に通知する関数へ差し替えられるよう、何もしない初期処理を置く。 */
  let invalidate: Parameters<
    WithMateWindowApi["subscribeSessionInvalidation"]
  >[0] = () => {};
  const listeners = new Set<
    Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]
  >();
  api.subscribeSessionInvalidation = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  invalidate = (event) => listeners.forEach((listener) => listener(event));
  api.getSessionSummary = () => summaryRead.promise;
  api.getSession = () => {
    conversationCalls += 1;
    return conversationRead.promise;
  };
  api.listSessionFileRoots = async () => {
    filesCalls += 1;
    return [];
  };
  api.listAuxiliarySessions = async () => [];
  api.getSessionGlossaryProjection = async () => ({
    sessionId: session.id,
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
  const originalSettings = api.getAppSettings;
  api.getAppSettings = async () => ({
    ...(await originalSettings()),
    chatLayoutPreference: {
      header: "visible",
      sidePane: "files",
      actionDock: "expanded",
    },
  });
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({
    /** CSS だけを空モジュールで代用し、本番の Session 画面を Node で import する。 */ load(
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
  try {
    await act(async () => {
      root.render(<App />);
    });
    assert.ok(
      container.querySelector('[role="status"][aria-label="Loading session"]'),
    );
    assert.doesNotMatch(container.textContent!, /No session is selected/);
    await act(async () => {
      summaryRead.resolve(summary);
    });
    assert.match(container.textContent!, /Composer input benchmark/);
    assert.ok(
      container.querySelector(
        '#session-main-chat-pane [role="status"][aria-label="Loading conversation"][aria-busy="true"]',
      ),
    );
    assert.equal(
      container.querySelectorAll('[role="alert"]').length,
      0,
      container.querySelector('[role="alert"]')?.textContent ??
        "Loading is not an error",
    );
    assert.ok(
      filesCalls > 0,
      "Files read starts without waiting for conversation",
    );
    const files = container.querySelector('[aria-label="File explorer"]')!;
    const changes = [
      ...files.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((button) => button.textContent === "Changes")!;
    await act(async () => {
      changes.click();
    });
    assert.equal(changes.getAttribute("aria-selected"), "true");
    const composer = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(composer, "A valid draft");
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(composer.value, "A valid draft");
    const send = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === "Send")!;
    assert.equal(send.disabled, true);
    assert.equal(send.hasAttribute("aria-busy"), false);
    assert.match(
      dom.window.document.getElementById(send.getAttribute("aria-describedby")!)
        ?.textContent ?? "",
      /conversation is loading/i,
    );
    assert.doesNotMatch(
      container.textContent ?? "",
      /Message submission is in progress/,
    );
    assert.equal(
      container.querySelector<HTMLSelectElement>('[aria-label="Approval"]')!
        .disabled,
      true,
    );
    await act(async () => {
      conversationRead.reject(new Error("history unavailable"));
    });
    const alert = container.querySelector(
      '#session-main-chat-pane [role="alert"]',
    )!;
    assert.match(alert.textContent!, /history unavailable/);
    assert.equal(
      container.querySelector('[aria-label="Loading conversation"]'),
      null,
    );
    assert.ok(container.querySelector('[aria-label="File explorer"]'));
    assert.equal(changes.getAttribute("aria-selected"), "true");
    conversationRead = deferred<Session | null>();
    await act(async () => {
      alert.querySelector<HTMLButtonElement>("button")!.click();
    });
    assert.equal(conversationCalls, 2);
    assert.ok(container.querySelector('[aria-label="Loading conversation"]'));
    await act(async () => {
      conversationRead.resolve({ ...session, messages: [] });
    });
    assert.equal(
      container.querySelector('[aria-label="Loading conversation"]'),
      null,
    );
    assert.equal(
      container.querySelector('#session-main-chat-pane [role="alert"]'),
      null,
    );
    assert.ok(
      container.querySelector(
        "#session-main-chat-pane .conversation-message-column",
      ),
    );
    assert.equal(changes.getAttribute("aria-selected"), "true");
    // 再取得に失敗しても、読み込み済みの会話表示は維持される。
    conversationRead = deferred<Session | null>();
    await act(async () => {
      invalidate({ scope: "ids", sessionIds: [session.id] });
    });
    await act(async () => {
      conversationRead.reject(new Error("refresh unavailable"));
    });
    assert.ok(
      container.querySelector(
        "#session-main-chat-pane .conversation-message-column",
      ),
    );
    assert.match(
      container.querySelector('#session-main-chat-pane [role="alert"]')!
        .textContent!,
      /refresh unavailable/,
    );
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
