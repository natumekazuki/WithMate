import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MermaidDiagram } from "../../src/ui/markdown/markdown-code.js";
import { MarkdownRenderContext } from "../../src/ui/markdown/markdown-context.js";

// @test-value v2
// kind = "contract"
// claim = "Mermaidの再計算中は前のSVGと画像resourceを保持し、取消した計算を採用せず最終errorを本文内だけで明示する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md: Streaming projection" }
// fault = "source更新で表示中SVGや画像を消す、stale計算で新図を上書きする、resourceを早期解放する、最終errorを古い図で隠す、またはrendererが本文外へerror SVGを残す"
// observable = "実parserのreject完了後のSVGのDOM同一性・内容・IDと本文内の所有範囲、aria-busy、resolver signal、解放URI、最終errorと原文"
// observation_boundary = "component-behavior"
// scope = "MermaidDiagramと実Mermaid rendererのsource更新・画像・未確定error後の追記と終了境界"
// lifecycle = "permanent"
// impact = "読み進めている図と画像を保持し、未完了と失敗を成功に見せず最新の図だけを表示する"
// distinction = "viewport操作と画像変換単体の既存testでは通らない実componentの非同期再描画とresource所有を小さな図で確認する"
// @end-test-value
/** Mermaid の再計算と配信中の構文エラーでは既存 SVG と画像を保持し、取消結果を解放して、確定したエラーでは本文内のエラーと原文だけを表示することを確認する。 */
test("Mermaidは再計算中の図を保持しstale結果を捨て最終errorを表示する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const revoked: string[] = [];
  const revokeObjectURL = URL.revokeObjectURL;
  /** 実画像のロードを必要とせず、画像サイズと読込完了を供給する。 */
  class LoadedImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 80;
    naturalHeight = 40;
    /** 画像の URL が設定された後、次のマイクロタスクで読込を完了する。 */
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
    /** DOM に属性を持たない疑似画像の属性除去を受け付ける。 */
    removeAttribute() {}
    /** 疑似画像のデコードを追加の待機なしで完了させる。 */
    async decode() {}
  }
  // ブラウザーでの位置・寸法とリソース読み込みだけを模擬し、実際の Mermaid パーサーと厳格なレンダラーは維持する。
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    CSSStyleSheet: dom.window.CSSStyleSheet,
    Image: LoadedImage,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      /** 固定寸法の試験なので resize の監視を開始しない。 */
      observe() {}
      /** 実監視を持たない resize fixture の解除口。 */
      disconnect() {}
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  Object.defineProperty(dom.window.SVGElement.prototype, "getBBox", {
    /** レイアウトエンジンがない DOM に固定の SVG 境界を与える。 */
    value: () => ({ x: 0, y: 0, width: 80, height: 20 }),
  });
  Object.defineProperty(
    dom.window.SVGElement.prototype,
    "getComputedTextLength",
    {
      /** Mermaid がラベルを配置できるよう固定テキスト幅を返す。 */ value: () =>
        80,
    },
  );
  Object.defineProperty(dom.window.SVGElement.prototype, "viewBox", {
    /** 描画後の寸法読み取りに固定 viewBox を返す。 */
    get: () => ({ baseVal: { x: 0, y: 0, width: 240, height: 120 } }),
  });
  URL.revokeObjectURL = (url) => revoked.push(url);
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const pending: Array<{
    signal: AbortSignal;
    resolve: (value: string) => void;
  }> = [];
  /** 遅い画像の結果と取消シグナルを観察できるよう、対象画像だけ取得を保留する。 */
  const resolver = async (source: string, signal?: AbortSignal) => {
    assert.ok(signal);
    return source === "slow.png"
      ? new Promise<string>((resolve) => pending.push({ signal, resolve }))
      : "blob:first";
  };
  const first =
    'flowchart LR\n A@{ img: "first.png", label: "First", h: 40 }\n A --> B[One]';
  const second =
    'flowchart LR\n A@{ img: "slow.png", label: "Second", h: 40 }\n A --> B[Two]';
  /** 配信中かどうかと画像解決を同じ Markdown の提供元から渡し、図を更新する。 */
  const render = async (source: string, isStreaming = false) => {
    await act(async () =>
      root.render(
        <MarkdownRenderContext.Provider
          value={{ markdown: "", isStreaming, resolveImageSource: resolver }}
        >
          <MermaidDiagram source={source} />
        </MarkdownRenderContext.Provider>,
      ),
    );
  };
  /** 非同期の実描画が検査条件を満たすまで待ち、期限を超えたら失敗させる。 */
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.ok(condition(), "非同期描画が期待する状態に到達する");
  };
  const mermaid = (await import("mermaid")).default;
  const originalMermaidAPI = mermaid.mermaidAPI;
  const originalRender = mermaid.render;
  const calculations = new Map<string, Promise<unknown>>();
  /** 対象の入力で実際に失敗した解析 Promise を待ち、失敗が構文由来であることを確認する。 */
  const waitForParseError = async (source: string) => {
    await waitFor(() => calculations.has(source));
    await act(async () => {
      await assert.rejects(calculations.get(source)!, /Parse error/);
    });
  };
  try {
    // 画像の事前解析と通常の描画の両経路で、実際の Promise を観測する。
    mermaid.mermaidAPI = {
      ...originalMermaidAPI,
      /** 画像つきの図が通る事前解析を置換せず、元の Promise だけを入力別に記録する。 */
      getDiagramFromText: (...args) => {
        const result = originalMermaidAPI.getDiagramFromText(...args);
        calculations.set(args[0], result);
        return result;
      },
    };
    mermaid.render = (...args) => {
      const result = originalRender(...args);
      calculations.set(args[1], result);
      return result;
    };
    await render(first);
    await waitFor(() => Boolean(container.querySelector("svg image")));
    const firstSvg = container.querySelector(".message-mermaid-canvas svg")!;
    assert.ok(firstSvg);
    await render(second);
    await waitFor(() => pending.length === 1);
    assert.equal(
      container.querySelector(".message-mermaid-canvas svg"),
      firstSvg,
    );
    assert.equal(firstSvg.isConnected, true);
    assert.equal(
      container.firstElementChild?.getAttribute("aria-busy"),
      "true",
    );
    assert.ok(!revoked.includes("blob:first"));

    await render(first);
    assert.equal(pending[0]!.signal.aborted, true);
    assert.equal(
      container.querySelector(".message-mermaid-canvas svg"),
      firstSvg,
    );
    assert.equal(
      container.firstElementChild?.getAttribute("aria-busy"),
      "false",
    );
    await act(async () => pending[0]!.resolve("blob:stale"));
    await waitFor(() => revoked.includes("blob:stale"));

    await render(second);
    await waitFor(() => pending.length === 2);
    await act(async () => pending[1]!.resolve("blob:second"));
    await waitFor(() =>
      Boolean(container.querySelector('svg image[href="blob:second"]')),
    );
    const secondSvg = container.querySelector(".message-mermaid-canvas svg")!;
    assert.ok(secondSvg && secondSvg !== firstSvg);
    assert.notEqual(secondSvg.id, firstSvg.id);
    assert.ok(secondSvg.textContent!.includes("Two"));
    assert.ok(revoked.includes("blob:first"));

    const partial = second + "\n B --> C[partial";
    await render(partial, true);
    await waitForParseError(partial);
    assert.equal(
      container.querySelector(".message-mermaid-canvas svg"),
      secondSvg,
    );
    assert.equal(secondSvg.isConnected, true);
    assert.ok(!revoked.includes("blob:second"));
    assert.equal(
      container.firstElementChild?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(container.querySelector(".message-mermaid-error"), null);
    assert.ok(
      [...dom.window.document.querySelectorAll("svg")].every((svg) =>
        container.contains(svg),
      ),
      "errorの仮描画を本文外へ残さない",
    );
    const finalSource = partial + "]";
    await render(finalSource, true);
    await render(finalSource, false);
    await waitFor(() => pending.length === 3);
    assert.equal(
      container.querySelector(".message-mermaid-canvas svg"),
      secondSvg,
    );
    assert.equal(secondSvg.isConnected, true);
    assert.ok(!revoked.includes("blob:second"));
    assert.equal(
      container.firstElementChild?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(container.querySelector(".message-mermaid-error"), null);
    await act(async () => pending[2]!.resolve("blob:final"));
    await waitFor(() =>
      Boolean(container.querySelector('svg image[href="blob:final"]')),
    );
    const finalSvg = container.querySelector(".message-mermaid-canvas svg")!;
    assert.ok(finalSvg && finalSvg !== secondSvg);
    assert.ok(finalSvg.textContent!.includes("partial"));
    assert.ok(revoked.includes("blob:second"));

    const invalid = "flowchart LR\n A[broken";
    await render(invalid, true);
    await waitForParseError(invalid);
    assert.equal(
      container.querySelector(".message-mermaid-canvas svg"),
      finalSvg,
    );
    assert.equal(finalSvg.isConnected, true);
    assert.ok(!revoked.includes("blob:final"));
    assert.equal(
      container.firstElementChild?.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(container.querySelector(".message-mermaid-error"), null);
    assert.ok(
      [...dom.window.document.querySelectorAll("svg")].every((svg) =>
        container.contains(svg),
      ),
      "errorの仮描画を本文外へ残さない",
    );
    await render(invalid, false);
    await waitFor(() =>
      Boolean(container.querySelector(".message-mermaid-error")),
    );
    assert.equal(container.querySelector(".message-mermaid-canvas svg"), null);
    assert.equal(container.querySelector("code")?.textContent, invalid);
    assert.equal(dom.window.document.querySelectorAll("svg").length, 0);
    assert.ok(revoked.includes("blob:final"));
  } finally {
    await act(async () => root.unmount());
    mermaid.mermaidAPI = originalMermaidAPI;
    mermaid.render = originalRender;
    URL.revokeObjectURL = revokeObjectURL;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
