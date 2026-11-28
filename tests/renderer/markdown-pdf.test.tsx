import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type {
  SessionFileDescriptor,
  SessionFileChunkResult,
} from "../../src-shared/file-explorer/file-explorer-contract.js";
import {
  PDF_READER_CHANNEL,
  PDF_READER_ORIGIN,
} from "../../src-shared/file-explorer/pdf-reader-contract.js";
import { MessageRichText } from "../../src/ui/markdown/MessageRichText.js";
import {
  SESSION_FILE_LARGE_WARNING_BYTES,
  SESSION_FILE_READ_CHUNK_BYTES,
} from "../../src/file-explorer/file-preview-utils.js";
import { isMessageRenderedSearchTextNode } from "../../src/chat/conversation/message-rendered-search-text.js";
import { createRenderedTextSearchIndex } from "../../src/file-explorer/rendered-text-search.js";
import { projectMessageRenderedSearchText } from "../../src-shared/session/message-search.js";

const target = "C:/work/日本語 report.PDF";
/** 対象パスを含む Codex の visualize マーカーを組み立てる。 */
const marker = (path = target) =>
  `visualize${JSON.stringify({ path, mode: "wide" })}`;
/** パス・サイズ・改訂を指定できる PDF の検査結果を作る。 */
const descriptor = (path = target, byteLength = 5): SessionFileDescriptor => ({
  sessionId: "session",
  absolutePath: path,
  absoluteFilePath: path,
  name: path.split("/").at(-1)!,
  kind: "pdf",
  mimeType: "application/pdf",
  byteLength,
  modifiedAt: "now",
  suggestedEncoding: "utf-8",
  revision: path,
});
/** 指定範囲のバイト列と次のオフセット、同じ改訂を含む読取結果を作る。 */
const chunk = (
  file: SessionFileDescriptor,
  offset = 0,
  length = file.byteLength,
): SessionFileChunkResult => ({
  data: new Uint8Array(length).buffer,
  offset,
  nextOffset: offset + length,
  totalBytes: file.byteLength,
  done: offset + length === file.byteLength,
  revision: file.revision,
});

/** Markdown を DOM に描画し、可視化と隔離 reader からの応答をテストで制御する。 */
async function mount(
  api: Partial<WithMateWindowApi>,
  run: (fixture: {
    document: Document;
    render: (
      text: string,
      props?: Partial<React.ComponentProps<typeof MessageRichText>>,
    ) => Promise<void>;
    reveal: () => Promise<void>;
    emit: (type: string, extra?: object) => Promise<void>;
    click: (label: string) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "https://withmate.test",
  });
  /** 可視性監視が設定されるまでは何も通知しない。 */
  let reveal = () => {};
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: class {
      /** 可視化を明示したときだけ交差通知が届くようコールバックを保持する。 */
      constructor(callback: IntersectionObserverCallback) {
        reveal = () =>
          callback(
            [{ isIntersecting: true }] as IntersectionObserverEntry[],
            this as unknown as IntersectionObserver,
          );
      }
      /** 監視開始だけでは可視として報告しない。 */
      observe() {}
      /** 実ブラウザーの監視リソースを持たないため解除時は処理しない。 */
      disconnect() {}
    },
  };
  const previous = Object.keys(globals).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.entries(globals).forEach(([name, value]) =>
    Object.defineProperty(globalThis, name, { configurable: true, value }),
  );
  Object.defineProperty(dom.window, "withmate", { value: api });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({
      document: dom.window.document,
      /** 同じ会話のファイル文脈を使い、本文と指定された描画プロパティを渡す。 */
      render: async (text, props) => {
        await act(async () =>
          root.render(
            <MessageRichText
              text={text}
              responseProvider="codex"
              markdownLinkFileContext={{ sessionId: "session" }}
              {...props}
            />,
          ),
        );
      },
      /** 埋め込み PDF が可視領域に入ったことを通知して描画更新を待つ。 */
      reveal: async () => {
        await act(async () => reveal());
      },
      /** 現在の iframe の識別子と送信元を使って reader のメッセージを発生させる。 */
      emit: async (type, extra = {}) => {
        const frame = dom.window.document.querySelector("iframe")!;
        const instanceId = new URLSearchParams(
          new URL(frame.src).hash.slice(1),
        ).get("instanceId");
        await act(async () =>
          dom.window.dispatchEvent(
            new dom.window.MessageEvent("message", {
              source: frame.contentWindow,
              origin: PDF_READER_ORIGIN,
              data: { channel: PDF_READER_CHANNEL, instanceId, type, ...extra },
            }),
          ),
        );
      },
      /** 表示文言またはアクセシブル名から操作を特定し、クリックする。 */
      click: async (label) => {
        const button = [...dom.window.document.querySelectorAll("button")].find(
          (entry) =>
            entry.textContent === label ||
            entry.getAttribute("aria-label") ===
              (label === "Reload" ? "Reload PDF Preview" : label),
        );
        assert.ok(button, `button ${label}`);
        await act(async () => button.click());
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const [name, value] of previous) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
}

// @test-value v2
// kind = "contract"
// claim = "Codex visualize PDFだけが可視化後に共有readerへ渡り、追記でも保持され、本文検索と明示Copy・Quote・PDF基準linkが成立する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "全PDF linkを自動読込する、未取得や初回待機をReload中と扱う、本文更新で再転送する、補助UIが検索へ混入する、引用やlinkが別文脈へ渡る"
// observable = "可視化前と初回inspect中のstatus・busy、inspect/chunk request・iframe同一性・load転送回数・検索index・callbackとlink request・Source原文"
// observation_boundary = "consumer"
// scope = "MessageRichTextのvisualize PDFと共有reader接続"
// lifecycle = "permanent"
// impact = "会話中にPDFを読めない、読書位置を失う、検索位置がずれる、操作先を誤る"
// distinction = "parser単体と型検査ではrenderer接続・可視化・再描画lifecycle・操作文脈を確認できない"
// @end-test-value
/** 表示された visualize PDF だけを読み、本文の追記でも reader を保持しつつ、検索・コピー・引用・PDF 文脈のリンク操作が独立して使えることを確認する。 */
test("visualize PDFs reuse the inline reader without disrupting chat actions or search", async () => {
  const inspected: unknown[] = [],
    read: unknown[] = [],
    opened: unknown[] = [],
    copied: string[] = [],
    quoted: string[] = [];
  const file = descriptor();
  let finishInitialInspection!: () => void;
  const initialInspection = new Promise<void>((resolve) => {
    finishInitialInspection = resolve;
  });
  await mount(
    {
      /** 検査対象を記録し、最初の読込中の UI を確認するまで応答を保留する。 */
      inspectSessionPdf: async (request) => {
        inspected.push(request);
        if (inspected.length === 1) await initialInspection;
        return file;
      },
      /** 要求された PDF チャンクを記録し、そのファイルの内容を返す。 */
      readSessionPdfChunk: async (request) => {
        read.push(request);
        return chunk(file);
      },
      /** 別ウィンドウへの引数を記録し、プレビュー起動に成功した結果を返す。 */
      openSessionFilePreviewWindow: async (request) => {
        opened.push(request);
        return {
          status: "opened",
          targetType: "external-url",
          target: "https://example.test",
        };
      },
    },
    async ({ render, reveal, document, emit, click }) => {
      const props = {
        /** コピー操作で会話側へ渡されたテキストを保持する。 */
        onCopyText: (text: string) => {
          copied.push(text);
        },
        /** 引用操作で会話側へ渡されたテキストを保持する。 */
        onQuoteText: (text: string) => {
          quoted.push(text);
        },
      };
      const text = `Before ${marker()} after`;
      await render(text, props);
      assert.deepEqual(inspected, []);
      const content = document.querySelector("[aria-label='Embedded PDF']");
      assert.ok(content);
      assert.equal(content.textContent, "");
      assert.equal(content.getAttribute("aria-busy"), "false");
      assert.equal(content.querySelector("[role='status']"), null);
      await reveal();
      assert.deepEqual(inspected, [{ sessionId: "session", target }]);
      assert.equal(content.getAttribute("aria-busy"), "true");
      assert.ok(
        content.querySelector("[role='status'][aria-label='Loading PDF']"),
      );
      const reload = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Reload PDF Preview']",
      );
      assert.ok(reload?.disabled);
      assert.equal(reload.getAttribute("aria-busy"), null);
      await act(async () => finishInitialInspection());
      assert.equal(read.length, 1);
      const frame = document.querySelector("iframe")!;
      assert.ok(frame);
      assert.ok(
        document.querySelector('p > .message-file-preview[data-format="pdf"]'),
      );
      assert.equal(
        document.querySelector(".message-file-preview")?.querySelector("div"),
        null,
      );
      const sent: unknown[] = [];
      frame.contentWindow!.postMessage = (message: unknown) => {
        sent.push(message);
        const request = message as { type: string; requestId?: string };
        if (request.type === "get-selection")
          queueMicrotask(() =>
            document.defaultView!.dispatchEvent(
              new document.defaultView!.MessageEvent("message", {
                source: frame.contentWindow,
                origin: PDF_READER_ORIGIN,
                data: {
                  channel: PDF_READER_CHANNEL,
                  instanceId: new URLSearchParams(
                    new URL(frame.src).hash.slice(1),
                  ).get("instanceId"),
                  type: "selection",
                  text: "PDF selected text",
                  requestId: request.requestId,
                },
              }),
            ),
          );
      };
      const controls = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".message-file-preview-header .session-pdf-selection-actions button",
        ),
      ];
      assert.deepEqual(
        controls.map((button) => [button.textContent, button.disabled]),
        [
          ["Copy Text", true],
          ["Quote", true],
        ],
      );
      await emit("ready");
      await render(`${text} more`, { ...props });
      await emit("ready");
      assert.equal(document.querySelector("iframe"), frame);
      assert.equal(sent.length, 1);
      assert.equal(inspected.length, 1);
      await emit("selection", { text: "PDF selected text" });
      await emit("open-link", { target: "../other.pdf" });
      assert.deepEqual([copied, quoted, opened], [[], [], []]);
      assert.ok(controls.every((button) => !button.disabled));
      await click("Copy Text");
      await click("Quote");
      await click("Open");
      assert.deepEqual(copied, ["PDF selected text"]);
      assert.deepEqual(quoted, ["PDF selected text"]);
      assert.deepEqual(opened, [
        {
          kind: "link",
          sessionId: "session",
          target: "../other.pdf",
          baseResource: file,
        },
      ]);
      await emit("selection", { text: "" });
      assert.deepEqual(
        [
          ...document.querySelectorAll(
            ".message-file-preview-header .session-pdf-selection-actions button",
          ),
        ],
        controls,
      );
      assert.ok(controls.every((button) => button.disabled));
      const index = createRenderedTextSearchIndex(
        document.querySelector<HTMLElement>(".rich-text")!,
        isMessageRenderedSearchTextNode,
      );
      assert.equal(
        index.normalizedText,
        projectMessageRenderedSearchText(
          `${text} more`,
          "codex",
        ).toLocaleLowerCase(),
      );
      await emit("selection", { text: "before reload" });
      await click("Reload");
      assert.notEqual(document.querySelector("iframe"), frame);
      assert.ok(
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".session-pdf-selection-actions button",
          ),
        ].every((button) => button.disabled),
      );
      await render(text, { displayMode: "source" });
      assert.equal(document.querySelector("iframe"), null);
      assert.equal(document.querySelector("pre")?.textContent, text);
      for (const notation of [
        `[file](${target.replaceAll(" ", "%20")})`,
        `:codex-file-citation{path="${target}"}`,
        marker("C:/work/chart.xlsx"),
      ]) {
        await render(notation);
        assert.equal(
          document.querySelector('.message-file-preview[data-format="pdf"]'),
          null,
        );
      }
      for (const responseProvider of [undefined, "claude", "copilot"]) {
        await render(marker(), { responseProvider });
        assert.equal(
          document.querySelector('.message-file-preview[data-format="pdf"]'),
          null,
        );
      }
      assert.equal(inspected.length, 2);
    },
  );
});

// @test-value v2
// kind = "contract"
// claim = "50MiB以上は明示確認前にbytesを取得せず、確認後は通常のReload待機と区別し、読込revision不一致は失敗表示してReloadで回復する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "大容量を無確認で読み込む、確認後に別操作のReloadを再びbusyにする、revision不一致を成功表示する、失敗後に再読込できない"
// observable = "読込回数・Load Anyway・明示読込中の本文statusとReloadのaria-busy・error文言・Reload後のiframe"
// observation_boundary = "component-behavior"
// scope = "inline PDF大容量確認とerror/retry"
// lifecycle = "permanent"
// impact = "意図しない大量メモリー使用、異なる版の混在表示、再表示不能"
// distinction = "Mainは容量確認UIや取得結果のrendererへの反映を観測できない"
// @end-test-value
/** 大容量 PDF は再読み込みだけでは取得せず、読み込みを承認した後の改訂不一致を表示して、再試行で新しいファイルを開けることを確認する。 */
test("inline PDFs require large-file consent and recover from a stale read", async () => {
  let file = descriptor(target, SESSION_FILE_LARGE_WARNING_BYTES),
    reads = 0;
  let finishFirstRead!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    finishFirstRead = resolve;
  });
  await mount(
    {
      /** 最初は警告対象サイズ、再検査時はテストが差し替えた通常サイズを返す。 */
      inspectSessionPdf: async () => file,
      /** 初回読取だけ応答を保留して改訂不一致を返し、再読取は現在の改訂で成功させる。 */
      readSessionPdfChunk: async () => {
        reads++;
        if (reads !== 1) return chunk(file);
        await firstRead;
        return { ...chunk(file, 0, 5), revision: "changed" };
      },
    },
    async ({ render, reveal, document, click }) => {
      await render(marker());
      await reveal();
      assert.equal(reads, 0);
      assert.match(document.body.textContent!, /50.0 MiB/);
      await click("Reload");
      assert.equal(reads, 0);
      await click("Load Anyway");
      assert.ok(
        document.querySelector("[role='status'][aria-label^='Loading PDF:']"),
      );
      const reload = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Reload PDF Preview']",
      );
      assert.ok(reload?.disabled);
      assert.equal(reload.getAttribute("aria-busy"), null);
      await act(async () => finishFirstRead());
      assert.equal(reads, 1);
      assert.match(
        document.querySelector('[role="alert"]')?.textContent ?? "",
        /changed/,
      );
      file = descriptor();
      await click("Reload");
      assert.equal(reads, 2);
      assert.ok(document.querySelector("iframe"));
    },
  );
});

// @test-value v2
// kind = "invariant"
// claim = "PDF取得中のSource切替は旧readの継続と表示を止め、再表示時は現在のresourceを読み直す"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "unmount済みresourceが残りchunkを取得する、stale結果がSourceや別resourceへ反映される"
// observable = "chunk request数、Source原文、現在resourceのiframe"
// observation_boundary = "consumer"
// scope = "inline PDF取消と再表示lifecycle"
// lifecycle = "permanent"
// impact = "画面外処理による不要なI/Oとメモリー使用、古い文書の誤表示"
// distinction = "実際の非同期read途中の画面切替は型検査とparserのtestでは検証できない"
// @end-test-value
/** PDF 読取中に Source 表示へ変えると古い応答から後続チャンクやフレームを作らず、次の PDF は新しい対象から読み直すことを確認する。 */
test("switching to Source prevents stale PDF reads from continuing", async () => {
  const large = descriptor(target, SESSION_FILE_READ_CHUNK_BYTES + 5);
  let complete!: (result: SessionFileChunkResult) => void;
  let reads = 0;
  await mount(
    {
      /** 切替前の PDF だけを複数チャンクのファイルとして扱う。 */
      inspectSessionPdf: async (request) =>
        request.target === target ? large : descriptor(request.target),
      /** 旧 PDF の初回応答を保留し、新しい PDF は直ちに読み終わらせる。 */
      readSessionPdfChunk: async (request) => {
        reads++;
        return request.target === target
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : chunk(descriptor(request.target));
      },
    },
    async ({ render, reveal, document }) => {
      await render(marker());
      await reveal();
      assert.equal(reads, 1);
      await render(marker(), { displayMode: "source" });
      await act(async () =>
        complete(chunk(large, 0, SESSION_FILE_READ_CHUNK_BYTES)),
      );
      assert.equal(reads, 1);
      assert.equal(document.querySelector("iframe"), null);
      assert.equal(document.querySelector("pre")?.textContent, marker());
      await render(marker("C:/work/current.pdf"));
      await reveal();
      assert.equal(reads, 2);
      assert.equal(
        document.querySelector("iframe")?.title,
        "PDF Reader: current.pdf",
      );
    },
  );
});
