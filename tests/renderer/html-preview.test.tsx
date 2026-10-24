import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HtmlPreview } from "../../src/ui/html-preview/HtmlPreview.js";
import type { HtmlPreviewEvent, WithMateHtmlPreviewApi } from "../../src-shared/window/html-preview.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: (url: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const intersection = installIntersectionObserver(false);
  const mounts: Array<{ id: string; html: string; pending: ReturnType<typeof deferred> }> = [];
  const disposed: string[] = [];
  const listeners = new Set<(event: HtmlPreviewEvent) => void>();
  const api: WithMateHtmlPreviewApi = {
    mountHtmlPreview(request) {
      const pending = deferred();
      mounts.push({ ...request, pending });
      return pending.promise;
    },
    async disposeHtmlPreview(id) { disposed.push(id); },
    subscribeHtmlPreviewEvents(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  return {
    dom, container, mounts, disposed, listeners,
    async render(onFind: () => void) { await act(async () => root.render(<HtmlPreview html="<h1>Preview</h1>" title="HTML Result" onFind={onFind} />)); },
    async intersect(visible: boolean) { await act(async () => intersection.observers[0].intersect(visible)); },
    async emit(event: HtmlPreviewEvent) { await act(async () => { listeners.forEach((listener) => listener(event)); }); },
    async restore() {
      await act(async () => root.unmount());
      intersection.restore();
      for (const [key, previous] of globals) {
        if (previous) Object.defineProperty(globalThis, key, previous);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "HTML previewは可視世代のURLだけをsandbox iframeへ表示し、旧完了を無視してready・失敗・keyboardの状態を現在世代へ反映する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation; HtmlPreview keyboard accessible description" }
// fault = "旧URLを表示する、画面外や失敗後もiframeを実行する、sandboxで同一originを許可する、またはfocus/Findを接続しない"
// observable = "iframeのsrc/title/sandbox、mount/dispose、busy・alert・status、activeElementとFind callback"
// observation_boundary = "component-behavior"
// scope = "HtmlPreviewの可視性・非同期URL登録からiframeとrenderer状態へのlifecycle"
// lifecycle = "permanent"
// impact = "画面外HTMLの実行継続、誤った本文の実行、親画面へのアクセス、keyboardでappへ戻れない状態を防ぐ"
// distinction = "配信service testや型検査ではrendererの世代・DOM sandbox属性・focus接続を観測できない。実際の重なりとprocess隔離はruntimeで確認する"
// @end-test-value
test("HTML previewは可視世代のsandbox iframeと状態・focusを維持する", async () => {
  const h = setup();
  let finds = 0;
  try {
    await h.render(() => { finds += 1; });
    assert.equal(h.mounts.length, 0);
    await h.intersect(true);
    assert.equal(h.mounts[0].html, "<h1>Preview</h1>");
    await h.intersect(true);
    assert.equal(h.mounts.length, 1);
    await h.intersect(false);
    assert.deepEqual(h.disposed, [h.mounts[0].id]);
    assert.equal(h.listeners.size, 0);
    await h.intersect(true);
    const current = h.mounts[1];
    await act(async () => h.mounts[0].pending.resolve("withmate-html-preview://old/"));
    assert.equal(h.container.querySelector("iframe"), null);
    await act(async () => current.pending.resolve("withmate-html-preview://current/"));
    const frame = h.container.querySelector("iframe")!;
    assert.equal(frame.getAttribute("src"), "withmate-html-preview://current/");
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(frame.title, "HTML Result");
    assert.equal(h.container.querySelector(".html-preview-viewport")?.getAttribute("aria-busy"), "true");
    await h.emit({ id: current.id, type: "ready" });
    assert.equal(h.container.querySelector(".html-preview-viewport")?.getAttribute("aria-busy"), "false");
    const group = h.container.querySelector<HTMLElement>('[role="group"]')!;
    await act(async () => { group.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(h.dom.window.document.activeElement, frame);
    await h.emit({ id: current.id, type: "return-focus" });
    assert.equal(h.dom.window.document.activeElement, group);
    await h.emit({ id: current.id, type: "find" });
    assert.equal(finds, 1);
    await h.emit({ id: current.id, type: "warning", message: "External resources were blocked." });
    assert.equal(h.container.querySelector('[role="status"]')?.textContent, "External resources were blocked.");
    await h.emit({ id: h.mounts[0].id, type: "error", message: "Old failure" });
    assert.equal(h.container.querySelector('[role="alert"]'), null);
    await h.emit({ id: current.id, type: "error", message: "Rendering failed." });
    assert.equal(h.container.querySelector('[role="alert"]')?.textContent, "Rendering failed.");
    assert.equal(h.container.querySelector("iframe"), null);
    await h.intersect(false);
    assert.deepEqual(h.disposed, h.mounts.map((mount) => mount.id));
    assert.equal(h.listeners.size, 0);
  } finally { await h.restore(); }
});
