import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { SessionFilePreview } from "../../src/file-explorer/SessionFilePreview.js";
import {
  PDF_READER_CHANNEL,
  PDF_READER_ORIGIN,
} from "../../src-shared/file-explorer/pdf-reader-contract.js";

// @test-value v2
// kind = "contract"
// claim = "Central and detached PDF previews keep header text controls with the correct Quote capability and scope current selections to each reader across reload and file switches"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: PDF header actions and File Preview Window; docs/design/window-architecture.md#pdf-readerの隔離境界" }
// fault = "Header controls disappear on selection clear, Quote appears in detached preview, or a stale or foreign-source response is used for text actions"
// observable = "Header buttons and disabled state, frame replacement, and Copy/Quote callback text"
// observation_boundary = "consumer"
// scope = "SessionFilePreview central/detached PDF host integration"
// lifecycle = "permanent"
// impact = "Reading controls become unavailable or an action copies or quotes the wrong PDF text"
// distinction = "PdfFilePreview unit tests cannot verify consumer placement, Quote capability or resource lifecycle; types and builds cannot detect stale runtime messages"
// @end-test-value
/** 中央と別ウィンドウ相当の PDF プレビューで引用の可否を区別し、再読込・ファイル切替前や別フレームの選択をコピーや引用に使わないことを確認する。 */
test("PDF file headers scope text actions to central and detached reader lifetimes", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "https://withmate.test",
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const document = dom.window.document;
  const root = createRoot(document.getElementById("root")!);
  const copied: string[] = [],
    quoted: string[] = [];
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  /** ファイルプレビューが要求する境界 API にテスト用の応答を適合させる。 */
  type Api = NonNullable<
    React.ComponentProps<typeof SessionFilePreview>["api"]
  >;
  const api: Api = {
    /** リクエストに対し、PDF の内容種別と読取りに必要な長さ・改訂を返す。 */
    inspectSessionFile: async (request) => ({
      ...request,
      absoluteFilePath: "C:/fixtures/report.pdf",
      name: "report.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      suggestedEncoding: "utf-8",
      byteLength: bytes.length,
      modifiedAt: "now",
      revision: "r1",
    }),
    /** 同じ改訂の PDF バイト列が一回で読み終わる応答を返す。 */
    readSessionFileChunk: async () => ({
      data: bytes.slice().buffer,
      offset: 0,
      nextOffset: bytes.length,
      totalBytes: bytes.length,
      done: true,
      revision: "r1",
    }),
    /** 選択テキストとは別のファイルコピー操作を表示可能にする。 */
    isSessionFileObjectCopyAvailable: () => true,
    /** 実ファイルを操作せず、ファイルコピーの成功を返す。 */
    copySessionFileObject: async () => ({
      status: "copied",
      message: "File copied.",
    }),
    /** 確認用の PDF をローカルファイルとして開いた結果を返す。 */
    openSessionFile: async () => ({
      status: "opened",
      targetType: "local-path",
      target: "C:/fixtures/report.pdf",
    }),
    /** 汎用パスを開く操作には要求された対象をそのまま返す。 */
    openPath: async (target) => ({
      status: "opened",
      targetType: "local-path",
      target,
    }),
    /** 別プレビューを開く API に外部 URL の成功応答を用意する。 */
    openSessionFilePreviewWindow: async () => ({
      status: "opened",
      targetType: "external-url",
      target: "https://example.test",
    }),
    /** PDF を画像として検査する経路には画像でないことを返す。 */
    inspectSessionImage: async () => {
      throw new Error("Not an image");
    },
    /** PDF は画像チャンクの読取り対象ではないことを示す。 */
    readSessionImageChunk: async () => {
      throw new Error("Not an image");
    },
    /** プレビュー画像のコピーに実クリップボードを使わない。 */
    copySessionFilePreviewImage: async () => ({ status: "copied" }),
    /** 画像用のコンテキストメニューに閉じた状態を返す。 */
    showSessionFilePreviewImageContextMenu: async () => ({
      status: "dismissed",
    }),
  };
  /** ファイルのパスと引用の可否を変えて描画し、コピーと引用に渡された文字列を記録する。 */
  const render = async (path = "C:/fixtures/report.pdf", detached = false) => {
    await act(async () =>
      root.render(
        <SessionFilePreview
          api={api}
          request={{ sessionId: "central", absolutePath: path }}
          onCopyText={(text) => copied.push(text)}
          onQuoteText={detached ? undefined : (text) => quoted.push(text)}
        />,
      ),
    );
  };
  /** フレームに割り当てられた reader ID と実際のメッセージ送信元を取得する。 */
  const reader = (frame: HTMLIFrameElement) => ({
    frame,
    id: new URLSearchParams(new URL(frame.src).hash.slice(1)).get("instanceId"),
    source: frame.contentWindow,
  });
  /** 契約のチャンネルと reader ID でメッセージを送信し、必要に応じて送信元だけを差し替える。 */
  const emit = async (
    entry: ReturnType<typeof reader>,
    type: string,
    extra = {},
    source = entry.source,
  ) => {
    await act(async () =>
      document.defaultView!.dispatchEvent(
        new dom.window.MessageEvent("message", {
          source,
          origin: PDF_READER_ORIGIN,
          data: {
            channel: PDF_READER_CHANNEL,
            instanceId: entry.id,
            type,
            ...extra,
          },
        }),
      ),
    );
  };
  /** ヘッダー操作をクリックし、React の更新を待つ。 */
  const click = async (button: HTMLButtonElement) => {
    await act(async () => button.click());
  };
  try {
    await render();
    const central = document.querySelector(
      "section[aria-label='File preview']",
    )!;
    /** ヘッダーに属する PDF の選択テキスト操作だけを取得する。 */
    const buttons = (surface: Element) => [
      ...surface.querySelectorAll<HTMLButtonElement>(
        "header .session-pdf-selection-actions button",
      ),
    ];
    const centralButtons = buttons(central);
    assert.deepEqual(
      centralButtons.map((button) => [button.textContent, button.disabled]),
      [
        ["Copy Text", true],
        ["Quote", true],
      ],
    );
    assert.ok(
      [...central!.querySelectorAll("header button")].some(
        (button) => button.textContent === "Copy File",
      ),
    );
    const first = reader(central.querySelector("iframe")!);
    let requestId = "";
    first.source!.postMessage = (message: {
      type: string;
      requestId: string;
    }) => {
      if (message.type === "get-selection") requestId = message.requestId;
    };
    await emit(first, "ready");
    await emit(first, "selection", { text: "central selection" });
    assert.ok(centralButtons.every((button) => !button.disabled));
    await click(centralButtons[0]!);
    await emit(
      first,
      "selection",
      { text: "wrong reader", requestId },
      dom.window as unknown as Window,
    );
    assert.deepEqual(copied, []);
    await emit(first, "selection", { text: "live text", requestId });
    assert.deepEqual(copied, ["live text"]);
    await emit(first, "selection", { text: "" });
    assert.deepEqual(buttons(central!), centralButtons);
    assert.ok(centralButtons.every((button) => button.disabled));
    await emit(first, "selection", { text: "before reload" });
    await click(centralButtons[1]!);
    const obsoleteRequest = requestId;
    await click(
      [...central!.querySelectorAll<HTMLButtonElement>("header button")].find(
        (button) => button.textContent === "Reload",
      )!,
    );
    assert.notEqual(central!.querySelector("iframe"), first.frame);
    await emit(first, "selection", {
      text: "obsolete",
      requestId: obsoleteRequest,
    });
    assert.deepEqual(quoted, []);
    assert.ok(buttons(central!).every((button) => button.disabled));
    const reloaded = reader(central!.querySelector("iframe")!);
    await emit(reloaded, "ready");
    await emit(reloaded, "selection", { text: "before switch" });
    await render("C:/fixtures/other.pdf");
    await emit(reloaded, "selection", { text: "obsolete selection" });
    assert.notEqual(central!.querySelector("iframe"), reloaded.frame);
    assert.ok(buttons(central!).every((button) => button.disabled));
    assert.deepEqual(copied, ["live text"]);
    await render("C:/fixtures/detached.pdf", true);
    assert.deepEqual(
      buttons(central).map((button) => [button.textContent, button.disabled]),
      [["Copy Text", true]],
    );
    const detached = reader(central.querySelector("iframe")!);
    detached.source!.postMessage = (message: {
      type: string;
      requestId: string;
    }) => {
      if (message.type === "get-selection") requestId = message.requestId;
    };
    await emit(detached, "ready");
    await emit(detached, "selection", { text: "detached range" });
    await click(buttons(central)[0]!);
    await emit(detached, "selection", {
      text: "detached live text",
      requestId,
    });
    assert.deepEqual(copied, ["live text", "detached live text"]);
    assert.deepEqual(quoted, []);
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
