import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import {
  PdfFilePreview,
  type PdfFilePreviewHandle,
} from "../../src/file-explorer/PdfFilePreview.js";
import { PreviewWheelZoomStepContext } from "../../src/settings/preview-zoom-settings-context.js";
import { detectSessionFileResourceKind } from "../../src-shared/file-explorer/file-content-detection.js";
import {
  PDF_READER_CHANNEL,
  PDF_READER_ORIGIN,
} from "../../src-shared/file-explorer/pdf-reader-contract.js";
import { readPdfSelection } from "../../src/pdf-reader/pdf-reader-selection.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// @test-value v2
// kind = "invariant"
// claim = "PDF extension and signature select the PDF reader instead of text or binary preview"
// oracle = { type = "contract", ref = "Issue #853: PDF rendering via the common File Preview" }
// fault = "PDF bytes are classified as text or binary and never reach the reader"
// observable = "detected resource kind and MIME type"
// observation_boundary = "public-boundary"
// scope = "file content classification"
// lifecycle = "permanent"
// distinction = "Runtime byte classification is not checked by the resource-kind union type"
// @end-test-value
/** 拡張子が大文字の場合や識別子のないファイル名でも、拡張子またはデータの署名でPDFを判定することを確認する。 */
test("PDF files are classified by extension or signature", () => {
  for (const [name, bytes] of [
    ["REPORT.PDF", Uint8Array.of(0, 1, 2)],
    ["document", new TextEncoder().encode("%PDF-1.7\n")],
  ] as const) {
    assert.deepEqual(detectSessionFileResourceKind(name, bytes), {
      kind: "pdf",
      mimeType: "application/pdf",
    });
  }
  assert.equal(
    detectSessionFileResourceKind("note.txt", new TextEncoder().encode("hello"))
      .kind,
    "text",
  );
});

// @test-value v2
// kind = "invariant"
// claim = "Each reader accepts only its own frame proposals; fixed host controls act on a live selection response correlated to a host click"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: PDF Copy Text/Quote; docs/design/window-architecture.md#pdf-readerの隔離境界" }
// fault = "A forged or stale frame message invokes clipboard, quote, or navigation callbacks without host user confirmation"
// observable = "host callback calls, confirmation target, and transfer messages"
// observation_boundary = "component-behavior"
// scope = "PdfFilePreview frame message boundary and host controls"
// lifecycle = "permanent"
// risk_tags = ["security", "authorization"]
// distinction = "Type checking cannot enforce message origin/source identity or absence of automatic host side effects"
// @end-test-value
/** 現在のPDFフレームからの通知だけを受け付け、ホスト側の操作には利用者の明示選択を求めることを確認する。 */
test("PDF frame proposals require matching identity and explicit host actions", async () => {
  const dom = new JSDOM(
    "<!doctype html><body><header id='actions'></header><div id='root'></div></body>",
    { url: "https://withmate.test" },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const actions = dom.window.document.getElementById("actions")!;
  const siblingContainer = dom.window.document.createElement("div");
  const siblingActions = dom.window.document.createElement("header");
  dom.window.document.body.append(siblingContainer, siblingActions);
  const siblingRoot = createRoot(siblingContainer);
  const copied: string[] = [];
  const quoted: string[] = [];
  const opened: string[] = [];
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  try {
    await act(async () =>
      root.render(
        <PdfFilePreview
          bytes={bytes}
          name="report.pdf"
          actionsContainer={actions}
          onCopyText={(text) => copied.push(text)}
          onQuoteText={(text) => quoted.push(text)}
          onOpenLink={(target) => opened.push(target)}
        />,
      ),
    );
    await act(async () =>
      siblingRoot.render(
        <PdfFilePreview
          bytes={bytes}
          name="sibling.pdf"
          actionsContainer={siblingActions}
          onCopyText={(text) => copied.push(`sibling:${text}`)}
          onOpenLink={(target) => opened.push(target)}
        />,
      ),
    );
    const frame = container.querySelector("iframe")!;
    const siblingFrame = siblingContainer.querySelector("iframe")!;
    const siblingId = new URLSearchParams(
      new URL(siblingFrame.src).hash.slice(1),
    ).get("instanceId")!;
    const controls = [...actions.querySelectorAll("button")];
    assert.deepEqual(
      controls.map((button) => [button.textContent, button.disabled]),
      [
        ["Copy Text", true],
        ["Quote", true],
      ],
    );
    assert.equal(
      frame.getAttribute("sandbox"),
      "allow-scripts allow-same-origin",
    );
    const instanceId = new URLSearchParams(
      new URL(frame.src).hash.slice(1),
    ).get("instanceId")!;
    const sent: Array<{
      message: unknown;
      origin: string;
      transfer: Transferable[];
    }> = [];
    frame.contentWindow!.postMessage = (
      message: unknown,
      target?: string | WindowPostMessageOptions,
      transfer?: Transferable[],
    ) => {
      sent.push({
        message,
        origin:
          typeof target === "string" ? target : (target?.targetOrigin ?? ""),
        transfer: transfer ?? [],
      });
    };
    /** 指定したリーダーの通知をDOMへ送り、Reactによる表示更新を待つ。 */
    const emit = async (
      type: string,
      extra = {},
      origin = PDF_READER_ORIGIN,
      source: Window | null = frame.contentWindow,
      id = instanceId,
    ) => {
      await act(async () => {
        dom.window.dispatchEvent(
          new dom.window.MessageEvent("message", {
            origin,
            source,
            data: {
              channel: PDF_READER_CHANNEL,
              instanceId: id,
              type,
              ...extra,
            },
          }),
        );
      });
    };
    await emit(
      "ready",
      {},
      PDF_READER_ORIGIN,
      siblingFrame.contentWindow,
      siblingId,
    );
    await emit(
      "selection",
      { text: "sibling selection" },
      PDF_READER_ORIGIN,
      siblingFrame.contentWindow,
      siblingId,
    );
    assert.ok(controls.every((button) => button.disabled));
    assert.equal(siblingActions.querySelector("button")!.disabled, false);
    await emit("ready", {}, "https://attacker.test");
    await emit("ready", {}, PDF_READER_ORIGIN, dom.window as unknown as Window);
    await emit("ready", {}, PDF_READER_ORIGIN, frame.contentWindow, "obsolete");
    assert.equal(sent.length, 0);
    await emit("ready");
    await emit("ready");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.origin, PDF_READER_ORIGIN);
    const payload = sent[0]!.message as { bytes: ArrayBuffer };
    assert.deepEqual(new Uint8Array(payload.bytes), bytes);
    assert.notEqual(payload.bytes, bytes.buffer);
    assert.deepEqual(sent[0]?.transfer, [payload.bytes]);
    await emit("loaded");
    for (const [origin, source, id] of [
      ["https://attacker.test", frame.contentWindow, instanceId],
      [PDF_READER_ORIGIN, siblingFrame.contentWindow, instanceId],
      [PDF_READER_ORIGIN, frame.contentWindow, "obsolete"],
    ] as const) {
      await emit("selection", { text: "forged selection" }, origin, source, id);
      await emit(
        "open-link",
        { target: "https://attacker.test/forged" },
        origin,
        source,
        id,
      );
      assert.ok(controls.every((button) => button.disabled));
      assert.equal(
        container.querySelector('[aria-label="Open PDF Link"]'),
        null,
      );
    }
    await emit("selection", { text: "selected text" });
    await emit("open-link", { target: "https://example.com/document" });
    assert.deepEqual([copied, quoted, opened], [[], [], []]);
    assert.match(container.textContent!, /https:\/\/example.com\/document/);
    /** ホスト側の可視ラベルでボタンを選び、利用者の操作として押す。 */
    const click = async (label: string) => {
      const button = [...dom.window.document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === label,
      )!;
      await act(async () => button.click());
    };
    assert.deepEqual([...actions.querySelectorAll("button")], controls);
    assert.ok(controls.every((button) => !button.disabled));
    /** フレームへ送った最後の要求のIDを取り出し、応答を対応付ける。 */
    const requestedId = () =>
      (sent.at(-1)!.message as { requestId: string }).requestId;
    await click("Copy Text");
    const copyId = requestedId();
    await emit("selection", { text: "unsolicited", requestId: "obsolete" });
    for (const [origin, source, id] of [
      ["https://attacker.test", frame.contentWindow, instanceId],
      [PDF_READER_ORIGIN, siblingFrame.contentWindow, instanceId],
      [PDF_READER_ORIGIN, frame.contentWindow, "obsolete"],
    ] as const)
      await emit(
        "selection",
        { text: "forged", requestId: copyId },
        origin,
        source,
        id,
      );
    assert.deepEqual(copied, []);
    await emit("selection", { text: "current text", requestId: copyId });
    await emit("selection", { text: "duplicate", requestId: copyId });
    await click("Quote");
    await emit("selection", {
      text: "current quote",
      requestId: requestedId(),
    });
    await click("Open");
    assert.deepEqual(copied, ["current text"]);
    assert.deepEqual(quoted, ["current quote"]);
    assert.deepEqual(opened, ["https://example.com/document"]);
    await click("Copy Text");
    await emit("selection", { text: "", requestId: requestedId() });
    assert.ok(controls.every((button) => button.disabled));
    assert.deepEqual(copied, ["current text"]);
    await emit("selection", { text: "selected again" });
    await click("Quote");
    const clearedId = requestedId();
    await emit("selection", { text: "" });
    await emit("selection", { text: "old", requestId: clearedId });
    assert.ok(controls.every((button) => button.disabled));
    assert.deepEqual(quoted, ["current quote"]);
    await act(async () => root.unmount());
    assert.equal(actions.childNodes.length, 0);
    await emit("open-link", { target: "https://example.com/stale" });
    assert.deepEqual(opened, ["https://example.com/document"]);
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
    await act(async () => siblingRoot.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Changing the saved wheel step reaches the existing reader without reloading bytes, and host Find targets that reader"
// oracle = { type = "contract", ref = "Issue #853: saved preview wheel step applies from the next wheel action and common File Preview Find remains available" }
// fault = "A setting update resets the load handshake or host Find never reaches the PDF reader"
// observable = "messages sent to the same reader frame after a setting change and host Find command"
// observation_boundary = "component-behavior"
// scope = "PDF host live settings and Find command"
// lifecycle = "permanent"
// distinction = "Runtime context updates and the imperative host-to-frame command are not enforced by message types"
// @end-test-value
/** ズーム設定と検索要求が既存フレームへ届き、表示するPDFを再転送しないことを確認する。 */
test("PDF settings and host Find reach the existing frame without retransferring bytes", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "https://withmate.test",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const ref = React.createRef<PdfFilePreviewHandle>();
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  /** 同じPDFを保ったままホイールズーム設定だけを更新する。 */
  const render = (step: number | null) => (
    <PreviewWheelZoomStepContext value={step}>
      <PdfFilePreview
        ref={ref}
        actionsContainer={null}
        bytes={bytes}
        name="report.pdf"
        onCopyText={() => {}}
        onOpenLink={() => {}}
      />
    </PreviewWheelZoomStepContext>
  );
  try {
    await act(async () => root.render(render(10)));
    const frame = container.querySelector("iframe")!;
    const instanceId = new URLSearchParams(
      new URL(frame.src).hash.slice(1),
    ).get("instanceId")!;
    const messages: Array<{ type: string; zoomWheelStep?: number | null }> = [];
    frame.contentWindow!.postMessage = (message: unknown) => {
      messages.push(message as (typeof messages)[number]);
    };
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          origin: PDF_READER_ORIGIN,
          source: frame.contentWindow,
          data: { channel: PDF_READER_CHANNEL, instanceId, type: "ready" },
        }),
      );
    });
    await act(async () => root.render(render(25)));
    await act(async () => ref.current!.find());
    await act(async () => root.render(render(null)));
    assert.equal(container.querySelector("iframe"), frame);
    assert.deepEqual(
      messages.map(({ type, zoomWheelStep }) => ({ type, zoomWheelStep })),
      [
        { type: "load", zoomWheelStep: 10 },
        { type: "settings", zoomWheelStep: 25 },
        { type: "find", zoomWheelStep: undefined },
        { type: "settings", zoomWheelStep: null },
      ],
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

// @test-value v2
// kind = "invariant"
// claim = "Reader startup without an authenticated ready ends in a terminal error, while ready cancels only the startup deadline and a recreated reader is independent of old timers and messages"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: PDF startup failure, Reload and reader lifetime" }
// fault = "Missing ready leaves Loading indefinitely, a late ready revives a failed reader, or an old startup deadline or message corrupts the replacement reader"
// observable = "Loading and aria-busy, error text, iframe visibility, messages transferred to the reader, and state after keyed recreation or unmount"
// observation_boundary = "component-behavior"
// scope = "PdfFilePreview initial handshake and error lifetime"
// lifecycle = "permanent"
// impact = "Users can distinguish a failed viewer startup from ongoing work and explicitly retry without stale failures or a false PDF corruption diagnosis"
// distinction = "Existing identity and settings tests deliver ready immediately; fake time detects absent or late ready and cleanup without real-time waits, which type checks and normal rendering cannot cover"
// @end-test-value
/** リーダー起動の待機期限とエラーを確認し、失敗または終了した旧リーダーの通知が交換後に反映されないことを確かめる。 */
test("PDF startup waits finitely and a failed or removed reader cannot affect its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "https://withmate.test",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  const messages: unknown[] = [];
  /** 指定キーで新しいプレビューを描画し、リーダーの通信用識別情報を取得する。 */
  const render = async (key: string) => {
    await act(async () =>
      root.render(
        <PdfFilePreview
          key={key}
          bytes={bytes}
          name="report.pdf"
          actionsContainer={null}
          onCopyText={() => {}}
          onOpenLink={() => {}}
        />,
      ),
    );
    const frame = container.querySelector("iframe")!;
    const source = frame.contentWindow;
    const id = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      "instanceId",
    )!;
    frame.contentWindow!.postMessage = (message: unknown) => {
      messages.push(message);
    };
    return { frame, source, id };
  };
  /** 起動状態の通知を対象リーダーから受け取る場合のDOM更新を進める。 */
  const emit = async (
    reader: Awaited<ReturnType<typeof render>>,
    type: string,
    extra = {},
    origin = PDF_READER_ORIGIN,
    source: Window | null = reader.source,
    id = reader.id,
  ) => {
    await act(async () => {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          origin,
          source,
          data: { channel: PDF_READER_CHANNEL, instanceId: id, type, ...extra },
        }),
      );
    });
  };
  /** 起動期限の前後を待機なしで再現できるよう仮想時間を進める。 */
  const tick = async (milliseconds: number) => {
    await act(async () => {
      t.mock.timers.tick(milliseconds);
    });
  };
  /** 起動エラーとして利用者に見えるアラート本文を取得する。 */
  const alert = () => container.querySelector('[role="alert"]')?.textContent;
  /** PDFリーダーが読込中であることを示す属性を取得する。 */
  const busy = () =>
    container
      .querySelector('[aria-label="PDF Reader"]')
      ?.getAttribute("aria-busy");
  try {
    const timedOut = await render("timeout");
    await tick(14_999);
    assert.equal(alert(), undefined);
    assert.equal(busy(), "true");
    assert.ok(container.querySelector(".session-pdf-loading"));
    await emit(timedOut, "ready", {}, "https://attacker.test");
    await emit(
      timedOut,
      "ready",
      {},
      PDF_READER_ORIGIN,
      dom.window as unknown as Window,
    );
    await emit(
      timedOut,
      "ready",
      {},
      PDF_READER_ORIGIN,
      timedOut.source,
      "obsolete",
    );
    await tick(1);
    const startupError = alert();
    assert.match(startupError ?? "", /viewer.*15 seconds.*Reload/);
    assert.equal(busy(), null);
    assert.equal(container.querySelector(".session-pdf-loading"), null);
    assert.equal(timedOut.frame.hidden, true);
    await emit(timedOut, "ready");
    await emit(timedOut, "loaded");
    assert.equal(alert(), startupError);
    assert.equal(messages.length, 0);
    assert.equal(timedOut.frame.hidden, true);

    const failed = await render("reported-error");
    await emit(failed, "error", { message: "Reader entry failed." });
    await tick(15_000);
    await emit(failed, "ready");
    assert.equal(alert(), "Reader entry failed.");
    assert.equal(busy(), null);
    assert.equal(messages.length, 0);

    const removed = await render("removed");
    await tick(5_000);
    await act(async () => root.render(null));
    const replacement = await render("replacement");
    await tick(10_000);
    await emit(removed, "ready");
    await emit(removed, "error", { message: "Stale reader error." });
    await emit(timedOut, "loaded");
    assert.equal(alert(), undefined);
    assert.equal(busy(), "true");
    assert.equal(messages.length, 0);
    await emit(replacement, "ready");
    assert.equal(messages.length, 1);
    assert.equal(container.querySelector("iframe"), replacement.frame);
    await tick(120_000);
    assert.equal(alert(), undefined);
    assert.equal(busy(), null);
    assert.equal(replacement.frame.hidden, false);
    await emit(replacement, "loaded");
    assert.equal(alert(), undefined);

    await act(async () => root.unmount());
    await tick(120_000);
    await emit(replacement, "error", { message: "Unmounted reader error." });
    assert.equal(container.childNodes.length, 0);
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
    t.mock.timers.reset();
  }
});

// @test-value v2
// kind = "contract"
// claim = "Host PDF text actions read only the current visible PDF range, not a cleared range, hidden document, toolbar or another document"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#session-window: PDF current selection; docs/design/window-architecture.md#pdf-readerの隔離境界" }
// fault = "A non-PDF or hidden document range is returned as current selected PDF text"
// observable = "text read from native DOM selection"
// observation_boundary = "component-behavior"
// scope = "reader-side selection used by both selection updates and explicit host requests"
// lifecycle = "permanent"
// impact = "Copy/Quote can reuse unrelated or obsolete text"
// distinction = "Host message mocks cannot validate which native range the actual reader reports; type checks do not enforce DOM selection scope"
// @end-test-value
/** 単一の可視PDF内にある選択だけを読み取り、ツールバーや別文書にまたがる選択は無視することを確認する。 */
test("PDF selection reads only a range within one visible PDF document", () => {
  const dom = new JSDOM(
    '<section id="primary"><span>Toolbar</span><div class="pdfViewer">Primary text</div></section><section><div class="pdfViewer">Attachment text</div></section>',
  );
  try {
    const document = dom.window.document;
    const [primary, attachment] = [...document.querySelectorAll(".pdfViewer")];
    const selection = dom.window.getSelection()!;
    /** 指定されたノード間でテキストを選択し、読取関数に渡すブラウザーの選択状態を作る。 */
    const select = (start: Node, end = start) => {
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent!.length);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    select(primary!.firstChild!);
    assert.equal(readPdfSelection(document), "Primary text");
    document.getElementById("primary")!.hidden = true;
    assert.equal(readPdfSelection(document), "");
    select(attachment!.firstChild!);
    assert.equal(readPdfSelection(document), "Attachment text");
    select(document.querySelector("span")!.firstChild!);
    assert.equal(readPdfSelection(document), "");
    document.getElementById("primary")!.hidden = false;
    select(primary!.firstChild!, attachment!.firstChild!);
    assert.equal(readPdfSelection(document), "");
    selection.removeAllRanges();
    assert.equal(readPdfSelection(document), "");
  } finally {
    dom.window.close();
  }
});
