import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HtmlPreview } from "../../src/ui/html-preview/HtmlPreview.js";
import type { HtmlPreviewEvent, HtmlPreviewLayout, WithMateHtmlPreviewApi } from "../../src-shared/window/html-preview.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) };
}

function setup(deferMount = false) {
  const dom = new JSDOM('<!doctype html><div id="clip" style="overflow-x:hidden;overflow-y:hidden"><div id="root"></div></div>', {
    url: "http://localhost/", pretendToBeVisual: true,
  });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const values = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  for (const [key, value] of Object.entries(values)) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const intersection = installIntersectionObserver(false);
  const mounts: Array<{ id: string; html: string; pending: ReturnType<typeof deferred> }> = [];
  const layouts: Array<{ id: string; layout: HtmlPreviewLayout }> = [];
  const disposed: string[] = [], focused: string[] = [];
  const listeners = new Set<(event: HtmlPreviewEvent) => void>();
  const api: WithMateHtmlPreviewApi = {
    mountHtmlPreview(request) {
      const pending = deferred();
      mounts.push({ ...request, pending });
      if (!deferMount) pending.resolve();
      return pending.promise;
    },
    layoutHtmlPreview(id, layout) { layouts.push({ id, layout }); },
    async disposeHtmlPreview(id) { disposed.push(id); },
    focusHtmlPreview(id) { focused.push(id); },
    subscribeHtmlPreviewEvents(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  const container = dom.window.document.getElementById("root")!;
  const clip = dom.window.document.getElementById("clip")!;
  clip.getBoundingClientRect = () => rect(30, 40, 180, 140);
  Object.defineProperties(clip, { clientWidth: { value: 180 }, clientHeight: { value: 140 } });
  Object.defineProperties(dom.window, { innerWidth: { value: 300, configurable: true }, innerHeight: { value: 200, configurable: true } });
  const root = createRoot(container);
  let unmounted = false;
  return {
    dom, container, mounts, layouts, disposed, focused, listeners,
    async render(onFind?: () => void) {
      await act(async () => root.render(<HtmlPreview html="<h1>Preview</h1>" title="HTML Result" onFind={onFind} />));
      const viewport = container.querySelector<HTMLElement>(".html-preview-viewport")!;
      viewport.getBoundingClientRect = () => rect(-10, 20, 400, 300);
    },
    async intersect(visible: boolean) { await act(async () => intersection.observers[0].intersect(visible)); },
    async frame() {
      const pending = [...frames.values()]; frames.clear();
      await act(async () => { pending.forEach((callback) => callback(0)); });
    },
    async emit(event: HtmlPreviewEvent) { await act(async () => { listeners.forEach((listener) => listener(event)); }); },
    async unmount() { if (!unmounted) { await act(async () => root.unmount()); unmounted = true; } },
    async restore() {
      if (!unmounted) { await act(async () => root.unmount()); unmounted = true; }
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
// claim = "HTML previewは可視領域への出入りでnative viewを生成・解放し、旧mount完了を無視して現在の状態・focus操作だけを反映する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation; HtmlPreview keyboard accessible description" }
// fault = "非表示でもnative viewを保持する、旧mount完了で新viewをreadyにする、またはnative eventを現在のfocusとFindへ接続しない"
// observable = "mount/dispose/focus API呼出し、busy・alert・status表示、activeElementとFind callback"
// observation_boundary = "component-behavior"
// scope = "HtmlPreviewのIntersectionObserverからnative APIとrenderer状態へのlifecycle"
// lifecycle = "permanent"
// impact = "非表示の会話HTMLがnative資源を占有し続ける、読込状態が誤表示される、keyboardでappへ戻れなくなる"
// distinction = "native service testではrenderer可視性と非同期React更新の世代・focus接続を観測できない"
// @end-test-value
test("HTML previewは可視世代ごとにnative viewを解放し現在の状態とfocusを反映する", async () => {
  const h = setup(true);
  let finds = 0;
  try {
    await h.render(() => { finds += 1; });
    assert.equal(h.mounts.length, 0);
    await h.intersect(true);
    assert.equal(h.mounts.length, 1);
    assert.equal(h.mounts[0].html, "<h1>Preview</h1>");
    await h.intersect(true);
    assert.equal(h.mounts.length, 1);
    await h.intersect(false);
    assert.deepEqual(h.disposed, [h.mounts[0].id]);
    assert.equal(h.listeners.size, 0);
    await h.intersect(true);
    assert.equal(h.mounts.length, 2);
    const current = h.mounts[1];
    assert.notEqual(current.id, h.mounts[0].id);
    await act(async () => h.mounts[0].pending.resolve());
    assert.equal(h.container.querySelector(".html-preview-viewport")?.getAttribute("aria-busy"), "true");
    assert.equal(h.layouts.length, 0);
    await act(async () => current.pending.resolve());
    assert.equal(h.container.querySelector(".html-preview-viewport")?.getAttribute("aria-busy"), "false");
    const group = h.container.querySelector<HTMLElement>('[role="group"]')!;
    await act(async () => { group.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(h.focused, [current.id]);
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
    await h.unmount();
    assert.deepEqual(h.disposed, h.mounts.map((mount) => mount.id));
    assert.equal(h.listeners.size, 0);
  } finally { await h.restore(); }
});

// @test-value v2
// kind = "contract"
// claim = "HTML native viewの表示範囲はviewportとscroll祖先でclipされ、非重複のmodalでもappのmodal操作中は非表示になる"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation; WAI-ARIA modal dialog interaction boundary" }
// fault = "native viewを祖先のclip外へ描画する、またはmodalがpreviewと重ならない場合にnative viewを表示し続ける"
// observable = "layoutHtmlPreview APIへ渡されたbounds・clip・visible"
// observation_boundary = "component-behavior"
// scope = "HtmlPreviewのDOM geometryからnative layout境界への投影"
// lifecycle = "permanent"
// impact = "HTMLが会話pane外やmodalの上に描画され、app操作を覆う"
// distinction = "native view単体testにはDOMのscroll祖先・modal関係がなくrenderer側のclip算出を検出できない"
// @end-test-value
test("HTML previewのnative layoutは祖先clipと非重複modalの表示境界を維持する", async () => {
  const h = setup();
  try {
    await h.render();
    await h.intersect(true);
    assert.deepEqual(h.layouts.at(-1)?.layout, {
      bounds: { x: -10, y: 20, width: 400, height: 300 },
      clip: { x: 30, y: 40, width: 180, height: 140 }, visible: true,
    });
    const modal = h.dom.window.document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.getBoundingClientRect = () => rect(250, 0, 20, 20);
    modal.checkVisibility = () => true;
    h.dom.window.document.body.append(modal);
    await h.frame();
    assert.equal(h.layouts.at(-1)?.layout.visible, false);
    modal.remove();
    await h.frame();
    assert.equal(h.layouts.at(-1)?.layout.visible, true);
    Object.defineProperty(h.dom.window, "innerWidth", { value: 100, configurable: true });
    await h.frame();
    assert.deepEqual(h.layouts.at(-1)?.layout.clip, { x: 30, y: 40, width: 70, height: 140 });
  } finally { await h.restore(); }
});
