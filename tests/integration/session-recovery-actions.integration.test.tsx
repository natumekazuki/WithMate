import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

// @test-value v2
// kind = "contract"
// claim = "実Session画面のMain中断とAuxiliary取消の回復は選択会話の前回本文を再送して各draftを保持し、Editの明示置換を対象draftだけに適用し、会話切替で確認を無効化する。Main中断は最新turn取得中と取得失敗時にも操作を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "再送に現在draftや別会話を使う、draftを消す、Editで無確認上書きする、または切替後も旧確認を適用する"
// observable = "実SessionWindowAppの最新turn loading/errorとRetry、enqueueSessionTurn引数、各ownerのtextarea値、確認dialog.open、focusとAuxiliary durable draft"
// observation_boundary = "component-behavior"
// scope = "session-main-auxiliary-recovery-routing"
// lifecycle = "permanent"
// impact = "違う依頼を送信したり別会話の未送信本文を失う"
// distinction = "callback単体や静的描画では実Appのowner routingとdraft persistenceを横断する欠陥を検出できない"
// @end-test-value
/** Main 中断と Auxiliary 取消の回復操作で、Resend が選択中の会話の前回本文を送り、Edit の明示的な置換だけがその下書きを変えることを確かめる。Main の最新 Turn 読み込み失敗や会話切替も検証する。 */
test(
  "Main/AuxiliaryのResendとEditは前回依頼とdraftのownerを維持する",
  { timeout: 10000 },
  async () => {
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
      /** JSDOM で描画コールバックをタイマーに予約する。 */
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0),
      /** テストで予約した描画タイマーを取り消す。 */
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
        clearTimeout(id),
      ResizeObserver: class {
        observe /** サイズの変化は通知せず監視登録だけを受け付ける。 */() {}
        disconnect /** サイズ監視の一括終了を受け付ける。 */() {}
        unobserve /** 要素単位でのサイズ監視解除を受け付ける。 */() {}
      },
      IntersectionObserver: class {
        observe /** 交差判定を模倣せず監視登録を受け付ける。 */() {}
        disconnect /** 交差監視の終了を受け付ける。 */() {}
        unobserve /** 個別要素に対する交差監視解除を受け付ける。 */() {}
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
      /** メディアクエリに一致しない画面条件を返す。 */ value: () => ({
        matches: false,
        /** 画面条件の変更登録を受けても通知は送らない。 */ addEventListener() {},
        /** 条件変更の監視解除を受け付ける。 */ removeEventListener() {},
      }),
    });
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
      /** 表示位置へのスクロール要求を実レイアウトなしで受け付ける。 */ value() {},
    });
    dom.window.HTMLElement.prototype.scrollTo = function () {};
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new dom.window.Event("close"));
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
        /** ベンチマーク用 preload が使う公開用ブリッジを返す。 */
        require: () => ({
          contextBridge: {
            /** 公開された API を捕捉し、回復と下書き保存の経路を差し替えられるようにする。 */ exposeInMainWorld:
              (_key: string, value: WithMateWindowApi) => {
                api = value;
              },
          },
        }),
        process: { argv: [] },
        Buffer,
      },
    );

    const getModelCatalog = api.getModelCatalog;
    api.getModelCatalog = async (request) => {
      const snapshot = await getModelCatalog(request);
      return snapshot
        ? { ...snapshot, workspacePath: request?.workspacePath }
        : snapshot;
    };
    const main = (await api.getSession("benchmark-main"))!;
    const auxiliary = (await api.getAuxiliarySession("benchmark-aux-1"))!;
    main.runState = "interrupted";
    main.messages = [{ role: "user", text: "Previous Main request" }];
    auxiliary.runState = "idle";
    auxiliary.messages = [{ role: "user", text: "Previous Auxiliary request" }];
    auxiliary.composerDraft = "Preserve Auxiliary draft";
    let rejectLatestTurn!: (reason: Error) => void;
    const latestTurnRead = new Promise<null>((_resolve, reject) => {
      rejectLatestTurn = reject;
    });
    let mainLatestTurnReads = 0;
    api.getLatestSessionTurn = (owner) => {
      if (owner === main.id && ++mainLatestTurnReads === 1)
        return latestTurnRead;
      if (owner === auxiliary.id)
        return Promise.resolve({
          id: 1,
          sessionId: owner,
          phase: "canceled",
          createdAt: "now",
          provider: "codex",
          model: "model",
          reasoningEffort: "medium",
          approvalMode: "never",
          threadId: "thread",
          errorMessage: "",
          userMessageSeq: 0,
        });
      return Promise.resolve(null);
    };
    const sent: { owner: string; text: string }[] = [];
    const enqueue = api.enqueueSessionTurn;
    api.enqueueSessionTurn = async (owner, request) => {
      assert.equal(
        request.submitSource,
        "retry",
        "Recovery must use the non-consuming queue submission contract",
      );
      if (owner === auxiliary.id) {
        assert.equal(request.auxiliaryDraftIncarnation, undefined);
        assert.equal(request.auxiliaryDraftDurableRevision, undefined);
      }
      sent.push({ owner, text: request.userMessage });
      return enqueue(owner, request);
    };
    let resolveRestoredDraft!: () => void;
    const restoredDraftSaved = new Promise<void>((resolve) => {
      resolveRestoredDraft = resolve;
    });
    const saveDraft = api.saveAuxiliaryDraft;
    api.saveAuxiliaryDraft = async (request) => {
      const result = await saveDraft(request);
      if (request.text === "Previous Auxiliary request") resolveRestoredDraft();
      return result;
    };
    api.listSessionFileRoots = async () => [];
    api.getSessionGlossaryProjection = async () => ({
      sessionId: main.id,
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
      /** Session 画面に必要な CSS import だけを空のモジュールに差し替える。 */ load(
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
    /** 選択中の会話の Composer 入力欄を取得する。 */
    const composer = () =>
      container.querySelector<HTMLTextAreaElement>("textarea")!;
    /** ボタンを表示名で取得し、なければテストの失敗として報告する。 */
    const button = (label: string) => {
      const result = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((element) => element.textContent?.trim() === label);
      assert.ok(result, `Missing ${label}`);
      return result;
    };
    /** 指定ラベルのボタンをクリックし、React の更新を待つ。 */
    const click = async (label: string) => {
      await act(async () => {
        button(label).click();
      });
    };
    /** ドック内の指定会話のボタンを探し、選択を切り替えて描画を反映させる。 */
    const target = async (label: string) => {
      const control = container.querySelector<HTMLButtonElement>(
        `.concurrent-chat-target-dock button[title="${label}"]`,
      );
      assert.ok(control, `Missing target ${label}`);
      await act(async () => {
        control.click();
      });
    };
    /** 既存の下書きの置換確認ダイアログを取得する。 */
    const conflict = () =>
      container.querySelector<HTMLDialogElement>(
        "dialog.session-recovery-conflict",
      )!;
    try {
      await act(async () => {
        root.render(<App />);
      });
      assert.equal(
        container
          .querySelector('[aria-label="Main: Previous Request Actions"]')
          ?.getAttribute("aria-busy"),
        "true",
      );
      assert.equal(button("Resend").disabled, false);
      await act(async () => {
        rejectLatestTurn(new Error("Latest turn unavailable"));
      });
      assert.match(
        container.textContent!,
        /Could not load the latest execution: Latest turn unavailable/,
      );
      assert.equal(button("Resend").disabled, false);
      await click("Retry");
      assert.equal(mainLatestTurnReads, 2);
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(composer(), "Preserve Main draft");
        composer().dispatchEvent(
          new dom.window.Event("input", { bubbles: true }),
        );
      });
      await click("Resend");
      assert.deepEqual(sent, [
        { owner: main.id, text: "Previous Main request" },
      ]);
      assert.equal(composer().value, "Preserve Main draft");
      await click("Edit");
      assert.equal(conflict().open, true);
      assert.equal(composer().value, "Preserve Main draft");
      await click("Keep Current Draft");
      assert.equal(conflict().open, false);
      assert.equal(composer().value, "Preserve Main draft");
      await click("Edit");
      assert.equal(conflict().open, true);
      await target("Auxiliary");
      assert.equal(
        conflict().open,
        false,
        "Main confirmation must not transfer to Auxiliary",
      );
      assert.equal(composer().value, "Preserve Auxiliary draft");
      await click("Resend");
      assert.deepEqual(sent, [
        { owner: main.id, text: "Previous Main request" },
        { owner: auxiliary.id, text: "Previous Auxiliary request" },
      ]);
      assert.equal(composer().value, "Preserve Auxiliary draft");
      assert.equal(
        (await api.getAuxiliaryDraft(auxiliary.id))!.text,
        "Preserve Auxiliary draft",
      );
      await click("Edit");
      assert.equal(conflict().open, true);
      await click("Replace With Previous Request");
      await act(async () => {
        await restoredDraftSaved;
      });
      assert.equal(composer().value, "Previous Auxiliary request");
      assert.equal(
        (await api.getAuxiliaryDraft(auxiliary.id))!.text,
        "Previous Auxiliary request",
      );
      assert.equal(dom.window.document.activeElement, composer());
      await target("Main");
      assert.equal(composer().value, "Preserve Main draft");
      assert.equal(
        conflict().open,
        false,
        "Returning to Main must require a new confirmation",
      );
      await click("Edit");
      await click("Replace With Previous Request");
      assert.equal(composer().value, "Previous Main request");
      assert.equal(sent.length, 2, "Edit never sends automatically");
      await target("Auxiliary");
      assert.equal(composer().value, "Previous Auxiliary request");
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
  },
);
