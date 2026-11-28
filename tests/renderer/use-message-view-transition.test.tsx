import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useMessageViewTransition } from "../../src/chat/use-message-view-transition.js";

/** 本文の描画とアニメーション完了を個別に進められる JSDOM の試験環境を用意する。 */
async function createHarness() {
  const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const saved = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  const media = new dom.window.EventTarget();
  let reduced = false;
  Object.defineProperty(media, "matches", {
    /** メディアクエリを作り直さずに最新の motion 抑制設定を返す。 */
    get: () => reduced,
  });
  /** motion 設定の切替を通知できる共通のメディアクエリを返す。 */
  dom.window.matchMedia = () => media as unknown as MediaQueryList;
  /** JSDOM でも対象がレイアウトに乗っていると判定される矩形を返す。 */
  dom.window.HTMLElement.prototype.getClientRects = () =>
    [{ width: 100 }] as unknown as DOMRectList;
  const animations: {
    /** 保留中の演出を指定の時点で完了させる。 */
    finish(): void;
    canceled: boolean;
    node: Element;
    frames: Keyframe[];
  }[] = [];
  /** アニメーションの対象とキーフレームを記録し、完了時点をテスト側に委ねる。 */
  dom.window.HTMLElement.prototype.animate = function (frames) {
    let finish!: () => void;
    let reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    const animation = {
      finish,
      canceled: false,
      node: this,
      frames: frames as Keyframe[],
    };
    animations.push(animation);
    return {
      finished,
      /** 取消を記録し、待機中の完了通知は拒否する。 */
      cancel: () => {
        animation.canceled = true;
        reject(new Error("canceled"));
      },
    } as unknown as Animation;
  };
  let transition!: ReturnType<typeof useMessageViewTransition>;
  /** 本文の表現だけを入れ替え、周囲のアバター・フォーム・状態表示を比較できるようにする。 */
  function Harness({ owner, visible }: { owner: string; visible: boolean }) {
    const main = useRef<HTMLDivElement>(null);
    const auxiliary = useRef<HTMLDivElement>(null);
    transition = useMessageViewTransition(main, auxiliary, owner, visible);
    return (
      <div ref={main}>
        <article>
          <span data-avatar="true">avatar</span>
          <div data-message-body="true">
            {transition.renderedMode === "preview" ? (
              <div className="rich-text">preview body</div>
            ) : (
              <pre className="rich-text">source body</pre>
            )}
            <form>
              <button>Submit</button>
            </form>
          </div>
        </article>
        <span role="status">Running</span>
      </div>
    );
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  /** 同じ root を指定の会話 owner と表示状態で再描画する。 */
  const render = async (owner = "a", visible = true) => {
    await act(async () =>
      root.render(<Harness owner={owner} visible={visible} />),
    );
  };
  await render();
  return {
    dom,
    animations,
    render,
    /** 描画をまたいで最新の hook の結果を読み取る。 */
    get transition() {
      return transition;
    },
    /** motion 抑制を有効にし、監視中のメディアクエリへ変更を通知する。 */
    reduce: async () => {
      reduced = true;
      await act(async () =>
        media.dispatchEvent(new dom.window.Event("change")),
      );
    },
    /** React をアンマウントしてから DOM を閉じ、上書きした globals を復元する。 */
    dispose: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Preview/Sourceは選択を即座に返し、本文のみをfade-out後に差し替え、再操作では最新の選択を表示する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#フィードバックとmotion" }
// fault = "選択反映を遅らせる、fade前に本文を交換する、古い完了が最新modeを上書きする、formやavatarを消す"
// observable = "hookの選択・描画mode、本文DOM、animation対象と既存row/avatar/formのidentity"
// observation_boundary = "component-behavior"
// scope = "会話本文の表現切替"
// lifecycle = "permanent"
// impact = "連打中に本文と選択が不一致になり、会話内の操作や読む対象を失う"
// distinction = "型検査では観測できないanimation完了とReact commitの順序を小さいDOMで検証する"
// @end-test-value
/** 選択は即時に変わり本文はフェード後に変わることと、連続切替でも周囲の DOM と最後の選択を保つことを確認する。 */
test("representation transition keeps controls stable and the latest selection wins", async () => {
  const h = await createHarness();
  try {
    const article = h.dom.window.document.querySelector("article");
    const avatar = h.dom.window.document.querySelector("[data-avatar]");
    const form = h.dom.window.document.querySelector("form");
    await act(async () => h.transition.changeMode("source"));
    assert.equal(h.transition.selectedMode, "source");
    assert.equal(h.transition.renderedMode, "preview");
    assert.equal(h.animations.length, 1);
    assert.equal(h.animations[0]!.node.className, "rich-text");
    assert.deepEqual(
      h.animations[0]!.frames.map((frame) => frame.opacity),
      ["1", "0"],
    );
    await act(async () => h.animations[0]!.finish());
    assert.equal(h.transition.renderedMode, "source");
    assert.equal(
      h.dom.window.document.querySelector("pre")?.textContent,
      "source body",
    );
    assert.deepEqual(
      h.animations[1]!.frames.map((frame) => frame.opacity),
      ["0", "1"],
    );
    await act(async () => h.transition.changeMode("preview"));
    const stale = h.animations.at(-1)!;
    await act(async () => h.transition.changeMode("source"));
    await act(async () => stale.finish());
    assert.equal(h.transition.selectedMode, "source");
    assert.equal(h.transition.renderedMode, "source");
    assert.equal(h.dom.window.document.querySelector("article"), article);
    assert.equal(h.dom.window.document.querySelector("[data-avatar]"), avatar);
    assert.equal(h.dom.window.document.querySelector("form"), form);
    assert.equal(
      h.dom.window.document.querySelector("[role=status]")?.textContent,
      "Running",
    );
  } finally {
    await h.dispose();
  }
});

// @test-value v2
// kind = "contract"
// claim = "非表示・会話owner変更・reduced motion・unmountでは旧演出を取消し最新modeへ安全に収束する"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#フィードバックとmotion" }
// fault = "非表示や別会話で旧演出を継続し、再表示時に古い表現へ戻す"
// observable = "描画modeとanimationの取消状態および旧完了後の描画mode"
// observation_boundary = "component-behavior"
// scope = "会話本文切替のlifecycle"
// lifecycle = "permanent"
// impact = "motion抑制設定を無視し、対象切替後に古い本文表現が割り込む"
// distinction = "複数のlifecycle境界で非同期完了を制御し、通常描画testでは観測できない取消を検証する"
// @end-test-value
/** owner・可視性・motion 設定の変更や破棄で旧演出を取り消し、古い完了通知で表示が戻らないことを確認する。 */
test("representation transition settles on lifecycle boundaries", async () => {
  for (const boundary of [
    "owner",
    "hidden",
    "document-hidden",
    "reduced",
    "unmount",
  ]) {
    const h = await createHarness();
    let disposed = false;
    try {
      await act(async () => h.transition.changeMode("source"));
      const stale = h.animations[0]!;
      if (boundary === "owner") await h.render("b");
      if (boundary === "hidden") await h.render("a", false);
      if (boundary === "document-hidden") {
        Object.defineProperty(h.dom.window.document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        await act(async () =>
          h.dom.window.document.dispatchEvent(
            new h.dom.window.Event("visibilitychange"),
          ),
        );
      }
      if (boundary === "reduced") await h.reduce();
      if (boundary === "unmount") {
        await h.dispose();
        disposed = true;
      }
      assert.equal(stale.canceled, true, boundary);
      if (!disposed) {
        assert.equal(h.transition.renderedMode, "source", boundary);
        await act(async () => stale.finish());
        assert.equal(h.transition.renderedMode, "source", boundary);
      }
    } finally {
      if (!disposed) await h.dispose();
    }
  }
});
