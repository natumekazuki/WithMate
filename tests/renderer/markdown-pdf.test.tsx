import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionFileDescriptor, SessionFileChunkResult } from "../../src-shared/file-explorer/file-explorer-contract.js";
import { PDF_READER_CHANNEL, PDF_READER_ORIGIN } from "../../src-shared/file-explorer/pdf-reader-contract.js";
import { MessageRichText } from "../../src/ui/markdown/MessageRichText.js";
import { SESSION_FILE_LARGE_WARNING_BYTES, SESSION_FILE_READ_CHUNK_BYTES } from "../../src/file-explorer/file-preview-utils.js";
import { isMessageRenderedSearchTextNode } from "../../src/chat/conversation/message-rendered-search-text.js";
import { createRenderedTextSearchIndex } from "../../src/file-explorer/rendered-text-search.js";
import { projectMessageRenderedSearchText } from "../../src-shared/session/message-search.js";

const target = "C:/work/日本語 report.PDF";
const marker = (path = target) => `visualize${JSON.stringify({ path, mode: "wide" })}`;
const descriptor = (path = target, byteLength = 5): SessionFileDescriptor => ({
  sessionId: "session", absolutePath: path, absoluteFilePath: path, name: path.split("/").at(-1)!,
  kind: "pdf", mimeType: "application/pdf", byteLength, modifiedAt: "now", suggestedEncoding: "utf-8", revision: path,
});
const chunk = (file: SessionFileDescriptor, offset = 0, length = file.byteLength): SessionFileChunkResult => ({
  data: new Uint8Array(length).buffer, offset, nextOffset: offset + length,
  totalBytes: file.byteLength, done: offset + length === file.byteLength, revision: file.revision,
});

async function mount(api: Partial<WithMateWindowApi>, run: (fixture: {
  document: Document; render: (text: string, props?: Partial<React.ComponentProps<typeof MessageRichText>>) => Promise<void>;
  reveal: () => Promise<void>; emit: (type: string, extra?: object) => Promise<void>; click: (label: string) => Promise<void>;
}) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://withmate.test" });
  let reveal = () => {};
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: class {
      constructor(callback: IntersectionObserverCallback) { reveal = () => callback([{ isIntersecting: true }] as IntersectionObserverEntry[], this as unknown as IntersectionObserver); }
      observe() {} disconnect() {}
    },
  };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.entries(globals).forEach(([name, value]) => Object.defineProperty(globalThis, name, { configurable: true, value }));
  Object.defineProperty(dom.window, "withmate", { value: api });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({ document: dom.window.document,
      render: async (text, props) => { await act(async () => root.render(<MessageRichText text={text} responseProvider="codex"
        markdownLinkFileContext={{ sessionId: "session" }} {...props} />)); },
      reveal: async () => { await act(async () => reveal()); },
      emit: async (type, extra = {}) => {
        const frame = dom.window.document.querySelector("iframe")!;
        const instanceId = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("instanceId");
        await act(async () => dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
          source: frame.contentWindow, origin: PDF_READER_ORIGIN, data: { channel: PDF_READER_CHANNEL, instanceId, type, ...extra },
        })));
      },
      click: async (label) => {
        const button = [...dom.window.document.querySelectorAll("button")].find((entry) => entry.textContent === label
          || entry.getAttribute("aria-label") === (label === "Reload" ? "Reload PDF Preview" : label));
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
// fault = "全PDF linkを自動読込する、本文更新で再転送する、補助UIが検索へ混入する、引用やlinkが別文脈へ渡る"
// observable = "inspect/chunk request・iframe同一性・load転送回数・検索index・callbackとlink request・Source原文"
// observation_boundary = "consumer"
// scope = "MessageRichTextのvisualize PDFと共有reader接続"
// lifecycle = "permanent"
// impact = "会話中にPDFを読めない、読書位置を失う、検索位置がずれる、操作先を誤る"
// distinction = "parser単体と型検査ではrenderer接続・可視化・再描画lifecycle・操作文脈を確認できない"
// @end-test-value
test("visualize PDFs reuse the inline reader without disrupting chat actions or search", async () => {
  const inspected: unknown[] = [], read: unknown[] = [], opened: unknown[] = [], copied: string[] = [], quoted: string[] = [];
  const file = descriptor();
  await mount({ inspectSessionPdf: async (request) => { inspected.push(request); return file; },
    readSessionPdfChunk: async (request) => { read.push(request); return chunk(file); },
    openSessionFilePreviewWindow: async (request) => { opened.push(request); return { status: "opened", targetType: "external-url", target: "https://example.test" }; },
  }, async ({ render, reveal, document, emit, click }) => {
    const props = { onCopyText: (text: string) => { copied.push(text); }, onQuoteText: (text: string) => { quoted.push(text); } };
    const text = `Before ${marker()} after`;
    await render(text, props);
    assert.deepEqual(inspected, []);
    await reveal();
    assert.deepEqual(inspected, [{ sessionId: "session", target }]);
    assert.equal(read.length, 1);
    const frame = document.querySelector("iframe")!;
    assert.ok(frame);
    assert.ok(document.querySelector('p > .message-file-preview[data-format="pdf"]'));
    assert.equal(document.querySelector('.message-file-preview')?.querySelector("div"), null);
    const sent: unknown[] = [];
    frame.contentWindow!.postMessage = (message: unknown) => sent.push(message);
    await emit("ready");
    await render(`${text} more`, { ...props });
    await emit("ready");
    assert.equal(document.querySelector("iframe"), frame);
    assert.equal(sent.length, 1);
    assert.equal(inspected.length, 1);
    await emit("selection", { text: "PDF selected text" });
    await emit("open-link", { target: "../other.pdf" });
    assert.deepEqual([copied, quoted, opened], [[], [], []]);
    await click("Copy"); await click("Quote"); await click("Open");
    assert.deepEqual(copied, ["PDF selected text"]); assert.deepEqual(quoted, ["PDF selected text"]);
    assert.deepEqual(opened, [{ kind: "link", sessionId: "session", target: "../other.pdf", baseResource: file }]);
    const index = createRenderedTextSearchIndex(document.querySelector<HTMLElement>(".rich-text")!, isMessageRenderedSearchTextNode);
    assert.equal(index.normalizedText, projectMessageRenderedSearchText(`${text} more`, "codex").toLocaleLowerCase());
    await render(text, { displayMode: "source" });
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(document.querySelector("pre")?.textContent, text);
    for (const notation of [`[file](${target.replaceAll(" ", "%20")})`, `:codex-file-citation{path="${target}"}`,
      marker("C:/work/chart.xlsx")]) {
      await render(notation); assert.equal(document.querySelector('.message-file-preview[data-format="pdf"]'), null);
    }
    for (const responseProvider of [undefined, "claude", "copilot"]) {
      await render(marker(), { responseProvider }); assert.equal(document.querySelector('.message-file-preview[data-format="pdf"]'), null);
    }
    assert.equal(inspected.length, 1);
  });
});

// @test-value v2
// kind = "contract"
// claim = "50MiB以上は明示確認前にbytesを取得せず、読込revision不一致は失敗表示しReloadで回復する"
// oracle = { type = "contract", ref = "docs/design/message-rich-text.md#assistant-file-references" }
// fault = "大容量を無確認で読み込む、revision不一致を成功表示する、失敗後に再読込できない"
// observable = "読込回数・Load Anyway・error文言・Reload後のiframe"
// observation_boundary = "component-behavior"
// scope = "inline PDF大容量確認とerror/retry"
// lifecycle = "permanent"
// impact = "意図しない大量メモリー使用、異なる版の混在表示、再表示不能"
// distinction = "Mainは容量確認UIや取得結果のrendererへの反映を観測できない"
// @end-test-value
test("inline PDFs require large-file consent and recover from a stale read", async () => {
  let file = descriptor(target, SESSION_FILE_LARGE_WARNING_BYTES), reads = 0;
  await mount({ inspectSessionPdf: async () => file,
    readSessionPdfChunk: async () => { reads++; return reads === 1 ? { ...chunk(file, 0, 5), revision: "changed" } : chunk(file); },
  }, async ({ render, reveal, document, click }) => {
    await render(marker()); await reveal();
    assert.equal(reads, 0); assert.match(document.body.textContent!, /50.0 MiB/);
    await click("Load Anyway");
    assert.equal(reads, 1); assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /changed/);
    file = descriptor();
    await click("Reload");
    assert.equal(reads, 2); assert.ok(document.querySelector("iframe"));
  });
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
test("switching to Source prevents stale PDF reads from continuing", async () => {
  const large = descriptor(target, SESSION_FILE_READ_CHUNK_BYTES + 5);
  let complete!: (result: SessionFileChunkResult) => void;
  let reads = 0;
  await mount({ inspectSessionPdf: async (request) => request.target === target ? large : descriptor(request.target),
    readSessionPdfChunk: async (request) => {
      reads++;
      return request.target === target ? new Promise((resolve) => { complete = resolve; }) : chunk(descriptor(request.target));
    },
  }, async ({ render, reveal, document }) => {
    await render(marker()); await reveal(); assert.equal(reads, 1);
    await render(marker(), { displayMode: "source" });
    await act(async () => complete(chunk(large, 0, SESSION_FILE_READ_CHUNK_BYTES)));
    assert.equal(reads, 1); assert.equal(document.querySelector("iframe"), null);
    assert.equal(document.querySelector("pre")?.textContent, marker());
    await render(marker("C:/work/current.pdf")); await reveal();
    assert.equal(reads, 2); assert.equal(document.querySelector("iframe")?.title, "PDF Reader: current.pdf");
  });
});
