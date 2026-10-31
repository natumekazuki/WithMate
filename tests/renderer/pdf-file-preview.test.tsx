import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { PdfFilePreview, type PdfFilePreviewHandle } from "../../src/file-explorer/PdfFilePreview.js";
import { PreviewWheelZoomStepContext } from "../../src/settings/preview-zoom-settings-context.js";
import { detectSessionFileResourceKind } from "../../src-shared/file-explorer/file-content-detection.js";
import { PDF_READER_CHANNEL, PDF_READER_ORIGIN } from "../../src-shared/file-explorer/pdf-reader-contract.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
test("PDF files are classified by extension or signature", () => {
  for (const [name, bytes] of [
    ["REPORT.PDF", Uint8Array.of(0, 1, 2)],
    ["document", new TextEncoder().encode("%PDF-1.7\n")],
  ] as const) {
    assert.deepEqual(detectSessionFileResourceKind(name, bytes), { kind: "pdf", mimeType: "application/pdf" });
  }
  assert.equal(detectSessionFileResourceKind("note.txt", new TextEncoder().encode("hello")).kind, "text");
});

// @test-value v2
// kind = "invariant"
// claim = "Only the current reader frame can propose selections and links, and host actions require a host button click"
// oracle = { type = "contract", ref = "Issue #853: PDF isolation and explicit user action boundary" }
// fault = "A forged or stale frame message invokes clipboard, quote, or navigation callbacks without host user confirmation"
// observable = "host callback calls, confirmation target, and transfer messages"
// observation_boundary = "component-behavior"
// scope = "PdfFilePreview frame message boundary and host controls"
// lifecycle = "permanent"
// risk_tags = ["security", "authorization"]
// distinction = "Type checking cannot enforce message origin/source identity or absence of automatic host side effects"
// @end-test-value
test("PDF frame proposals require matching identity and explicit host actions", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://withmate.test" });
  const previous = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const copied: string[] = [];
  const quoted: string[] = [];
  const opened: string[] = [];
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  try {
    await act(async () => root.render(<PdfFilePreview bytes={bytes} name="report.pdf"
      onCopyText={(text) => copied.push(text)} onQuoteText={(text) => quoted.push(text)} onOpenLink={(target) => opened.push(target)} />));
    const frame = container.querySelector("iframe")!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
    const instanceId = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("instanceId")!;
    const sent: Array<{ message: unknown; origin: string; transfer: Transferable[] }> = [];
    frame.contentWindow!.postMessage = (message: unknown, target?: string | WindowPostMessageOptions, transfer?: Transferable[]) => {
      sent.push({ message, origin: typeof target === "string" ? target : target?.targetOrigin ?? "", transfer: transfer ?? [] });
    };
    const emit = async (type: string, extra = {}, origin = PDF_READER_ORIGIN, source: Window | null = frame.contentWindow, id = instanceId) => {
      await act(async () => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { origin, source,
        data: { channel: PDF_READER_CHANNEL, instanceId: id, type, ...extra } })); });
    };
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
      [PDF_READER_ORIGIN, dom.window as unknown as Window, instanceId],
      [PDF_READER_ORIGIN, frame.contentWindow, "obsolete"],
    ] as const) {
      await emit("selection", { text: "forged selection" }, origin, source, id);
      await emit("open-link", { target: "https://attacker.test/forged" }, origin, source, id);
      assert.equal(container.querySelector('[aria-label="Selected PDF Text"]'), null);
      assert.equal(container.querySelector('[aria-label="Open PDF Link"]'), null);
    }
    await emit("selection", { text: "selected text" });
    await emit("open-link", { target: "https://example.com/document" });
    assert.deepEqual([copied, quoted, opened], [[], [], []]);
    assert.match(container.textContent!, /https:\/\/example.com\/document/);
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
      await act(async () => button.click());
    };
    await click("Copy");
    await click("Quote");
    await click("Open");
    assert.deepEqual(copied, ["selected text"]);
    assert.deepEqual(quoted, ["selected text"]);
    assert.deepEqual(opened, ["https://example.com/document"]);
    await act(async () => root.unmount());
    await emit("open-link", { target: "https://example.com/stale" });
    assert.deepEqual(opened, ["https://example.com/document"]);
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
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
test("PDF settings and host Find reach the existing frame without retransferring bytes", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://withmate.test" });
  const previous = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const ref = React.createRef<PdfFilePreviewHandle>();
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  const render = (step: number | null) => <PreviewWheelZoomStepContext value={step}><PdfFilePreview ref={ref}
    bytes={bytes} name="report.pdf" onCopyText={() => {}} onOpenLink={() => {}} /></PreviewWheelZoomStepContext>;
  try {
    await act(async () => root.render(render(10)));
    const frame = container.querySelector("iframe")!;
    const instanceId = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("instanceId")!;
    const messages: Array<{ type: string; zoomWheelStep?: number | null }> = [];
    frame.contentWindow!.postMessage = (message: unknown) => { messages.push(message as typeof messages[number]); };
    await act(async () => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      origin: PDF_READER_ORIGIN, source: frame.contentWindow, data: { channel: PDF_READER_CHANNEL, instanceId, type: "ready" },
    })); });
    await act(async () => root.render(render(25)));
    await act(async () => ref.current!.find());
    await act(async () => root.render(render(null)));
    assert.equal(container.querySelector("iframe"), frame);
    assert.deepEqual(messages.map(({ type, zoomWheelStep }) => ({ type, zoomWheelStep })), [
      { type: "load", zoomWheelStep: 10 }, { type: "settings", zoomWheelStep: 25 },
      { type: "find", zoomWheelStep: undefined }, { type: "settings", zoomWheelStep: null },
    ]);
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
test("PDF startup waits finitely and a failed or removed reader cannot affect its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://withmate.test" });
  const previous = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  const messages: unknown[] = [];
  const render = async (key: string) => {
    await act(async () => root.render(<PdfFilePreview key={key} bytes={bytes} name="report.pdf"
      onCopyText={() => {}} onOpenLink={() => {}} />));
    const frame = container.querySelector("iframe")!;
    const source = frame.contentWindow;
    const id = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("instanceId")!;
    frame.contentWindow!.postMessage = (message: unknown) => { messages.push(message); };
    return { frame, source, id };
  };
  const emit = async (reader: Awaited<ReturnType<typeof render>>, type: string, extra = {},
    origin = PDF_READER_ORIGIN, source: Window | null = reader.source, id = reader.id) => {
    await act(async () => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
      origin, source, data: { channel: PDF_READER_CHANNEL, instanceId: id, type, ...extra },
    })); });
  };
  const tick = async (milliseconds: number) => { await act(async () => { t.mock.timers.tick(milliseconds); }); };
  const alert = () => container.querySelector('[role="alert"]')?.textContent;
  const busy = () => container.querySelector('[aria-label="PDF Reader"]')?.getAttribute("aria-busy");
  try {
    const timedOut = await render("timeout");
    await tick(14_999);
    assert.equal(alert(), undefined);
    assert.equal(busy(), "true");
    assert.ok(container.querySelector(".session-pdf-loading"));
    await emit(timedOut, "ready", {}, "https://attacker.test");
    await emit(timedOut, "ready", {}, PDF_READER_ORIGIN, dom.window as unknown as Window);
    await emit(timedOut, "ready", {}, PDF_READER_ORIGIN, timedOut.source, "obsolete");
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
