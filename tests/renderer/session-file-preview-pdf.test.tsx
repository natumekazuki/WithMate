import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { SessionFilePreview } from "../../src/file-explorer/SessionFilePreview.js";
import { PDF_READER_CHANNEL, PDF_READER_ORIGIN } from "../../src-shared/file-explorer/pdf-reader-contract.js";

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
test("PDF file headers scope text actions to central and detached reader lifetimes", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://withmate.test", pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const document = dom.window.document;
  const root = createRoot(document.getElementById("root")!);
  const copied: string[] = [], quoted: string[] = [];
  const bytes = Uint8Array.of(37, 80, 68, 70, 45);
  type Api = NonNullable<React.ComponentProps<typeof SessionFilePreview>["api"]>;
  const api: Api = {
    inspectSessionFile: async (request) => ({ ...request, absoluteFilePath: "C:/fixtures/report.pdf", name: "report.pdf",
      kind: "pdf", mimeType: "application/pdf", suggestedEncoding: "utf-8", byteLength: bytes.length, modifiedAt: "now", revision: "r1" }),
    readSessionFileChunk: async () => ({ data: bytes.slice().buffer, offset: 0, nextOffset: bytes.length, totalBytes: bytes.length, done: true, revision: "r1" }),
    isSessionFileObjectCopyAvailable: () => true,
    copySessionFileObject: async () => ({ status: "copied", message: "File copied." }),
    openSessionFile: async () => ({ status: "opened", targetType: "local-path", target: "C:/fixtures/report.pdf" }),
    openPath: async (target) => ({ status: "opened", targetType: "local-path", target }),
    openSessionFilePreviewWindow: async () => ({ status: "opened", targetType: "external-url", target: "https://example.test" }),
    inspectSessionImage: async () => { throw new Error("Not an image"); },
    readSessionImageChunk: async () => { throw new Error("Not an image"); },
    copySessionFilePreviewImage: async () => ({ status: "copied" }), showSessionFilePreviewImageContextMenu: async () => ({ status: "dismissed" }),
  };
  const render = async (path = "C:/fixtures/report.pdf", detached = false) => {
    await act(async () => root.render(
      <SessionFilePreview api={api} request={{ sessionId: "central", absolutePath: path }}
        onCopyText={(text) => copied.push(text)} onQuoteText={detached ? undefined : (text) => quoted.push(text)} />
    ));
  };
  const reader = (frame: HTMLIFrameElement) => ({ frame, id: new URLSearchParams(new URL(frame.src).hash.slice(1)).get("instanceId"), source: frame.contentWindow });
  const emit = async (entry: ReturnType<typeof reader>, type: string, extra = {}, source = entry.source) => {
    await act(async () => document.defaultView!.dispatchEvent(new dom.window.MessageEvent("message", {
      source, origin: PDF_READER_ORIGIN, data: { channel: PDF_READER_CHANNEL, instanceId: entry.id, type, ...extra },
    })));
  };
  const click = async (button: HTMLButtonElement) => { await act(async () => button.click()); };
  try {
    await render();
    const central = document.querySelector("section[aria-label='File preview']")!;
    const buttons = (surface: Element) => [...surface.querySelectorAll<HTMLButtonElement>("header .session-pdf-selection-actions button")];
    const centralButtons = buttons(central);
    assert.deepEqual(centralButtons.map((button) => [button.textContent, button.disabled]), [["Copy Text", true], ["Quote", true]]);
    assert.ok([...central!.querySelectorAll("header button")].some((button) => button.textContent === "Copy File"));
    const first = reader(central.querySelector("iframe")!);
    let requestId = "";
    first.source!.postMessage = (message: { type: string; requestId: string }) => { if (message.type === "get-selection") requestId = message.requestId; };
    await emit(first, "ready");
    await emit(first, "selection", { text: "central selection" });
    assert.ok(centralButtons.every((button) => !button.disabled));
    await click(centralButtons[0]!);
    await emit(first, "selection", { text: "wrong reader", requestId }, dom.window as unknown as Window);
    assert.deepEqual(copied, []);
    await emit(first, "selection", { text: "live text", requestId });
    assert.deepEqual(copied, ["live text"]);
    await emit(first, "selection", { text: "" });
    assert.deepEqual(buttons(central!), centralButtons);
    assert.ok(centralButtons.every((button) => button.disabled));
    await emit(first, "selection", { text: "before reload" });
    await click(centralButtons[1]!);
    const obsoleteRequest = requestId;
    await click([...central!.querySelectorAll<HTMLButtonElement>("header button")].find((button) => button.textContent === "Reload")!);
    assert.notEqual(central!.querySelector("iframe"), first.frame);
    await emit(first, "selection", { text: "obsolete", requestId: obsoleteRequest });
    assert.deepEqual(quoted, []);
    assert.ok(buttons(central!).every((button) => button.disabled));
    const reloaded = reader(central!.querySelector("iframe")!);
    await emit(reloaded, "ready"); await emit(reloaded, "selection", { text: "before switch" });
    await render("C:/fixtures/other.pdf");
    await emit(reloaded, "selection", { text: "obsolete selection" });
    assert.notEqual(central!.querySelector("iframe"), reloaded.frame);
    assert.ok(buttons(central!).every((button) => button.disabled));
    assert.deepEqual(copied, ["live text"]);
    await render("C:/fixtures/detached.pdf", true);
    assert.deepEqual(buttons(central).map((button) => [button.textContent, button.disabled]), [["Copy Text", true]]);
    const detached = reader(central.querySelector("iframe")!);
    detached.source!.postMessage = (message: { type: string; requestId: string }) => { if (message.type === "get-selection") requestId = message.requestId; };
    await emit(detached, "ready"); await emit(detached, "selection", { text: "detached range" });
    await click(buttons(central)[0]!);
    await emit(detached, "selection", { text: "detached live text", requestId });
    assert.deepEqual(copied, ["live text", "detached live text"]);
    assert.deepEqual(quoted, []);
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
