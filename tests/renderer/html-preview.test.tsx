import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HtmlPreview } from "../../src/ui/html-preview/HtmlPreview.js";
import type { HtmlPreviewEvent, HtmlPreviewMountRequest, HtmlPreviewMountResult, WithMateHtmlPreviewApi } from "../../src-shared/window/html-preview.js";
import { installIntersectionObserver } from "../support/intersection-observer.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: (mount: HtmlPreviewMountResult) => void;
  const promise = new Promise<HtmlPreviewMountResult>((done) => { resolve = done; });
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
  const mounts: Array<HtmlPreviewMountRequest & { pending: ReturnType<typeof deferred> }> = [];
  const disposed: string[] = [];
  const responses: Array<{ id: string; requestId: string; choice: number | null }> = [];
  const listeners = new Set<(event: HtmlPreviewEvent) => void>();
  const api: WithMateHtmlPreviewApi = {
    mountHtmlPreview(request) {
      const pending = deferred();
      mounts.push({ ...request, pending });
      return pending.promise;
    },
    async disposeHtmlPreview(id) { disposed.push(id); },
    async respondHtmlPreview(id, requestId, choice) { responses.push({ id, requestId, choice }); },
    subscribeHtmlPreviewEvents(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  Object.defineProperty(dom.window, "withmate", { configurable: true, value: api });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  return {
    dom, container, mounts, disposed, listeners, responses,
    async render(onFind: () => void) { await act(async () => root.render(<HtmlPreview html="<h1>Preview</h1>" source={{ kind: "resource", resource: { sessionId: "session-1", rootId: "workspace", relativePath: "index.html" } }} title="HTML Result" onFind={onFind} />)); },
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
// claim = "HTML previewは可視世代の出自・partitionをguestへ渡し、旧完了を無視してready・失敗・keyboardの状態を現在世代へ反映する"
// oracle = { type = "contract", ref = "docs/design/electron-window-runtime.md#html-preview-isolation; HtmlPreview keyboard accessible description" }
// fault = "旧URLを表示する、画面外や失敗後もguestを実行する、誤ったsource/partitionを渡す、またはfocus/Findを接続しない"
// observable = "webviewのsrc/title/partition、mountのsourceとdispose、busy・alert・status、activeElementとFind callback"
// observation_boundary = "component-behavior"
// scope = "HtmlPreviewの可視性・非同期mount登録からwebviewとrenderer状態へのlifecycle"
// lifecycle = "permanent"
// impact = "画面外HTMLの実行継続、誤った本文の実行、親画面へのアクセス、keyboardでappへ戻れない状態を防ぐ"
// distinction = "配信service testや型検査ではrendererの世代・guest属性・focus接続を観測できない。実際の重なりとprocess隔離はruntimeで確認する"
// @end-test-value
test("HTML previewは可視世代のguestと状態・focusを維持する", async () => {
  const h = setup();
  let finds = 0;
  try {
    await h.render(() => { finds += 1; });
    assert.equal(h.mounts.length, 0);
    await h.intersect(true);
    assert.equal(h.mounts[0].html, "<h1>Preview</h1>");
    assert.deepEqual(h.mounts[0].source, { kind: "resource", resource: { sessionId: "session-1", rootId: "workspace", relativePath: "index.html" } });
    await h.render(() => { finds += 1; });
    assert.equal(h.mounts.length, 1);
    await h.intersect(true);
    assert.equal(h.mounts.length, 1);
    await h.intersect(false);
    assert.deepEqual(h.disposed, [h.mounts[0].id]);
    assert.equal(h.listeners.size, 0);
    await h.intersect(true);
    const current = h.mounts[1];
    await act(async () => h.mounts[0].pending.resolve({ url: "withmate-html-preview://old/", partition: "old" }));
    assert.equal(h.container.querySelector("webview"), null);
    await act(async () => current.pending.resolve({ url: "withmate-html-preview://current/", partition: "current" }));
    const frame = h.container.querySelector<HTMLElement>("webview")!;
    assert.equal(frame.getAttribute("src"), "withmate-html-preview://current/");
    assert.equal(frame.getAttribute("partition"), "current");
    assert.equal(frame.hasAttribute("allowpopups"), true);
    assert.equal(frame.hasAttribute("preload"), false);
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
    assert.equal(h.container.querySelector("webview"), null);
    await h.intersect(false);
    assert.deepEqual(h.disposed, h.mounts.map((mount) => mount.id));
    assert.equal(h.listeners.size, 0);
  } finally { await h.restore(); }
});

// @test-value v2
// kind = "contract"
// claim = "HTML browser requests are shown in trusted host UI with target details, explicit choices, keyboard cancellation and reload recovery"
// oracle = { type = "contract", ref = "user request: risky browser actions require explicit host confirmation; docs/design/ui-design-guidelines.md keyboard and recovery requirements" }
// fault = "guest remains interactive while confirmation is open, choice responds to the wrong request, Escape approves, or rendering failure has no recovery"
// observable = "dialog text and focus, guest inertness and preserved DOM, respond IPC arguments, Reload mount generation"
// observation_boundary = "component-behavior"
// scope = "HtmlPreview host prompt and error recovery"
// lifecycle = "permanent"
// impact = "users retain control of permission/external actions and can restart a failed guest"
// distinction = "main policy tests cannot observe trusted renderer controls or focus; this short DOM interaction checks prompt-to-IPC wiring while real composition is verified in Electron"
// @end-test-value
test("HTML preview prompts require explicit choices and support Escape and Reload", async () => {
  const h = setup();
  try {
    await h.render(() => {});
    await h.intersect(true);
    const current = h.mounts[0];
    await act(async () => current.pending.resolve({ url: "withmate-html-preview://current/", partition: "current" }));
    const prompt = { requestId: "download-1", title: "Download File", detail: "https://example.invalid/file.txt", choices: ["Save File"] };
    await h.emit({ id: current.id, type: "prompt", prompt });
    const dialog = h.container.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog.textContent?.includes(prompt.detail));
    const guest = h.container.querySelector<HTMLElement>("webview")!;
    assert.equal(guest.style.visibility, "");
    assert.equal(guest.style.pointerEvents, "none");
    assert.equal(h.container.querySelector<HTMLElement>(".html-preview-guest-host")?.inert, true);
    assert.equal(h.dom.window.document.activeElement?.textContent, "Cancel");
    await act(async () => dialog.querySelectorAll("button")[1].click());
    assert.deepEqual(h.responses, [{ id: current.id, requestId: "download-1", choice: 0 }]);
    assert.equal(h.container.querySelector('[role="dialog"]'), null);
    assert.equal(h.container.querySelector("webview"), guest);
    assert.equal(guest.style.pointerEvents, "");
    assert.equal(h.container.querySelector<HTMLElement>(".html-preview-guest-host")?.inert, false);
    await h.emit({ id: current.id, type: "prompt", prompt: { ...prompt, requestId: "download-2" } });
    await act(async () => h.container.querySelector('[role="dialog"]')!.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.deepEqual(h.responses[1], { id: current.id, requestId: "download-2", choice: null });
    await h.emit({ id: current.id, type: "error", message: "Guest crashed." });
    const reload = Array.from(h.container.querySelectorAll("button")).find((button) => button.textContent === "Reload")!;
    await act(async () => reload.click());
    assert.equal(h.mounts.length, 2);
    assert.notEqual(h.mounts[1].id, current.id);
    assert.deepEqual(h.disposed, [current.id]);
  } finally { await h.restore(); }
});
