import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { installFailedTurnRetryFixture } from "./failed-turn-retry-fixture.js";

// @test-value v2
// kind = "contract"
// claim = "MainとAuxiliaryでBの実行中に履歴の確定失敗Aを明示受付でき、結果不明の旧失敗を再送せず、現draftと表示済みのBの応答本文・行を保持する。今回の受付結果が不明なら新IDを発行せず同じ要求で回復する"
// oracle = { type = "contract", ref = "docs/design/session-run-lifecycle.md#failed-turn-retry; docs/design/desktop-ui.md: Action Dock・回復操作、pending 中の live activity / streaming response" }
// fault = "実行中に確定失敗の操作を止める、旧結果不明を確定失敗に読み替える、選択した履歴やownerを取り違える、現在Turnの本文・応答行やdraftを失う、現在Turnを停止またはSteerする、不明受付を新IDで作り直す"
// observable = "実SessionWindowの履歴ボタン・既に表示した本文と応答行の操作直後の継続・draft、preloadに渡る保存receipt/Turn/owner、受付と照会のID、Stop/Steer/通常送信の呼出有無"
// observation_boundary = "component-behavior"
// scope = "SessionWindowAppの実行中の履歴Resend。読み取り・受付IPCのみ合成"
// lifecycle = "permanent"
// impact = "必要な再試行を予約できない、別依頼を並行実行する、または下書き・現在実行を失う"
// distinction = "Facadeの成功だけでは実画面が実行中に操作を無効化する不具合を検出できない"
// @end-test-value
/** 生成中の B を表示したまま確定失敗 A の再送を受け付け、受付結果が不明な Auxiliary では同じ要求 ID で回復することを確認する。 */
test(
  "実行中でもMain/Auxの確定失敗Resendを受け付け、未知の受付は同じIDで回復する",
  { timeout: 10_000 },
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
      /** 履歴内のスクロール要求を副作用なしで受け付け、JSDOM が持たない動作を補う。 */ value() {},
    });
    const measure = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("session-message-list"))
        return dom.window.DOMRect.fromRect({ width: 800, height: 720 });
      return measure.call(this);
    };
    for (const property of ["offsetHeight", "clientHeight"])
      Object.defineProperty(dom.window.HTMLElement.prototype, property, {
        configurable: true,
        /** 履歴リストの高さを固定し、生成中の応答が仮想化で非表示にならないようにする。 */ get(
          this: HTMLElement,
        ) {
          return this.classList.contains("session-message-list") ? 720 : 0;
        },
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
        /** Electron の contextBridge を模した入口を preload に提供する。 */
        require: () => ({
          contextBridge: {
            /** preload が公開した API を取得し、失敗履歴と再送受付の fixture を接続できるようにする。 */ exposeInMainWorld:
              (_key: string, value: WithMateWindowApi) => {
                api = value;
              },
          },
        }),
        process: { argv: [] },
        Buffer,
      },
    );
    const f = await installFailedTurnRetryFixture(api, {
      loseFirstAuxReply: true,
    });
    Object.defineProperty(dom.window, "withmate", { value: api });
    const { createRoot } = await import("react-dom/client");
    const cssImports = registerHooks({
      /** 実画面を import できるよう、CSS だけを空のモジュールに置き換える。 */ load(
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
    /** 送信対象を切り替えた後の Composer から、現在の入力欄を取得する。 */
    const composer = () =>
      container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    /** Main と Auxiliary の応答を混同しないよう、表示名に対応するペインに絞る。 */
    const pane = (label: string) =>
      container.querySelector(`#session-${label.toLowerCase()}-chat-pane`)!;
    /** 実行中の B を含む応答行を取得し、再送操作の前後で同じ DOM 行か比較できるようにする。 */
    const displayedB = (label: string) =>
      [...pane(label).querySelectorAll(".message-row.assistant")].find((row) =>
        row
          .querySelector('[data-message-body="true"]')
          ?.textContent?.includes("B: Still generating"),
      );
    /** A の再送に先立ち、B の応答行が実際に表示されたことを短い期限付きで待つ。 */
    const waitForDisplayedB = async (label: string) => {
      const deadline = performance.now() + 2_000;
      let row = displayedB(label);
      while (!row && performance.now() < deadline) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        row = displayedB(label);
      }
      assert.ok(row, `${label} must present B before retrying A`);
      return row;
    };
    /** 指定ペインで、結果不明な旧失敗を除く確定失敗の再送操作が一つだけあることを確認する。 */
    const resend = (label: string) => {
      const buttons = pane(label).querySelectorAll<HTMLButtonElement>(
        `button[aria-label="${label}: Resend Failed Turn"]`,
      );
      assert.equal(
        buttons.length,
        1,
        `only the confirmed failed start is eligible in ${label}`,
      );
      return buttons[0]!;
    };
    /** クリックに伴う React の状態更新を反映するまで待つ。 */
    const click = async (button: HTMLButtonElement) =>
      act(async () => {
        button.click();
      });
    try {
      await act(async () => root.render(<App />));
      const mainB = await waitForDisplayedB("Main");
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(composer(), "Keep Main draft");
        composer().dispatchEvent(
          new dom.window.Event("input", { bubbles: true }),
        );
      });
      const mainResend = resend("Main");
      assert.equal(
        mainResend.disabled,
        false,
        "B must not block acceptance of saved A",
      );
      await act(async () => {
        mainResend.click();
        mainResend.click();
      });
      assert.equal(f.requests.length, 1);
      const main = f.requests[0]!;
      assert.deepEqual(
        [
          main.id,
          main.request.target,
          main.request.receiptId,
          main.request.turnId,
        ],
        [f.main.id, f.targets[f.main.id], `${f.main.id}:A`, "42"],
      );
      assert.equal(composer().value, "Keep Main draft");
      assert.equal(displayedB("Main"), mainB);
      await click(
        container.querySelector<HTMLButtonElement>(
          'button.concurrent-chat-splitter[aria-label="Open Auxiliary"]',
        )!,
      );
      await click(
        container.querySelector<HTMLButtonElement>(
          '.concurrent-chat-target-dock button[title="Auxiliary"]',
        )!,
      );
      assert.equal(composer().value, "Keep Auxiliary draft");
      const auxB = await waitForDisplayedB("Auxiliary");
      assert.equal(resend("Auxiliary").disabled, false);
      await click(resend("Auxiliary"));
      assert.equal(displayedB("Auxiliary"), auxB);
      assert.equal(
        resend("Auxiliary").disabled,
        true,
        "an unknown acceptance must block a new request ID",
      );
      assert.equal(f.requests.length, 2);
      const aux = f.requests[1]!;
      assert.deepEqual(
        [aux.id, aux.request.target, aux.request.receiptId, aux.request.turnId],
        [f.aux.id, f.targets[f.aux.id], `${f.aux.id}:A`, "42"],
      );
      assert.deepEqual(f.receiptLookups, [
        { id: f.aux.id, requestId: aux.request.clientRequestId },
      ]);
      const retryOriginal = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Retry Original Turn");
      assert.ok(retryOriginal);
      await click(retryOriginal);
      assert.deepEqual(f.requests.slice(1), [aux, aux]);
      assert.equal(resend("Auxiliary").disabled, false);
      assert.equal(composer().value, "Keep Auxiliary draft");
      assert.equal(displayedB("Auxiliary"), auxB);
      assert.deepEqual(f.unexpected, []);
      await click(
        container.querySelector<HTMLButtonElement>(
          '.concurrent-chat-target-dock button[title="Main"]',
        )!,
      );
      assert.equal(composer().value, "Keep Main draft");
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);
