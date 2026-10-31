import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";

// @test-value v2
// kind = "contract"
// claim = "SessionのModel再openは同workspaceの取得中状態を反映し、候補・現在選択・draftを保持し、先着通知やworkspace切替を遅い応答や失敗で巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Modelはcacheを先に表示し、古い一覧はbackground更新する; docs/design/model-catalog.md" }
// fault = "同workspaceのloading応答を捨てる、更新で開いている候補やdraftを置換する、または旧requestのloading/errorで現在の状態を上書きする"
// observable = "実AppのModel busy/status・選択label、開いている候補列、composer draft、getModelCatalogの対象workspace"
// observation_boundary = "component-behavior"
// scope = "SessionWindowAppのModel open要求とcatalog購読の結線・workspace寿命"
// lifecycle = "permanent"
// impact = "再取得中も失敗に見える表示、古いrequestによる別workspace状態の混入、編集中の入力消失を防ぐ"
// distinction = "ModelPicker単体と購読単体では両経路を結ぶ実Appの応答競合を確認できない。既存preload fixtureと少数deferredを使い実provider接続や壁時計判定を不要にする"
// @end-test-value
test("Session Modelは再取得状態を受理し通知とworkspaceの新しい状態を保持する", { timeout: 30_000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "http://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === "number" ? (y ?? this.scrollTop) : (options?.top ?? this.scrollTop);
  };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: (name: string) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } };
    }, process: { argv: [] }, Buffer,
  });
  let workspacePath = "C:/workspace/a";
  const getSession = api.getSession;
  const getSummary = api.getSessionSummary;
  api.getSession = async (id) => { const value = await getSession(id); return value ? { ...value, workspacePath } : null; };
  api.getSessionSummary = async (id) => { const value = await getSummary(id); return value ? { ...value, workspacePath } : null; };
  api.listSessionFileRoots = async () => [];
  const invalidations = new Set<Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]>();
  api.subscribeSessionInvalidation = (listener) => { invalidations.add(listener); return () => { invalidations.delete(listener); }; };
  const catalogs = new Set<Parameters<WithMateWindowApi["subscribeModelCatalog"]>[0]>();
  api.subscribeModelCatalog = (listener) => { catalogs.add(listener); return () => { catalogs.delete(listener); }; };
  const catalog = (workspace: string, status: "error" | "loading" | "ready", updated = false): ModelCatalogSnapshot => ({
    workspacePath: workspace,
    providers: [{ id: "codex", label: "Codex", defaultModelId: "gpt-5.4-mini", defaultReasoningEffort: "medium",
      models: [{ id: "gpt-5.4-mini", label: updated ? "Updated Model" : "Current Model", reasoningEfforts: ["medium"] },
        { id: "second", label: "Second Model", reasoningEfforts: [] }] }],
    discovery: { codex: { status, fetchedAt: "2026-10-28T00:00:00Z", ...(status === "error" ? { error: "model discovery failed" } : {}) } },
  });
  const requests: Array<{ workspace: string; resolve: (snapshot: ModelCatalogSnapshot) => void; reject: (error: Error) => void }> = [];
  api.getModelCatalog = async (request) => {
    if (!request?.providerId) return catalog(request?.workspacePath ?? workspacePath, requests.length ? "ready" : "error");
    return new Promise((resolve, reject) => requests.push({ workspace: request.workspacePath!, resolve, reject }));
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context);
  } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => cssImports.deregister());
  const root = createRoot(dom.window.document.getElementById("root")!);
  const button = (label: string) => {
    const element = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
    assert.ok(element, `${label} should be available`);
    return element;
  };
  const open = async () => { await act(async () => { button("Model").click(); }); };
  const close = async () => { await act(async () => { button("Close Model Picker").click(); }); };
  const busy = () => dom.window.document.querySelector(".composer-setting-model")?.getAttribute("aria-busy");
  const options = () => [...dom.window.document.querySelectorAll(".composer-model-option")].map((option) => option.textContent);
  const currentDraft = () => dom.window.document.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]')?.value;
  const switchWorkspace = async (next: string) => {
    workspacePath = next;
    await act(async () => { invalidations.forEach((listener) => listener({ scope: "all" })); });
  };
  try {
    await act(async () => { root.render(<App />); });
    assert.match(button("Model").title, /model discovery failed/);
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]');
    assert.ok(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "draft to keep");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await open();
    const initialOptions = options();
    assert.equal(initialOptions.length, 2);
    assert.equal(requests[0]?.workspace, workspacePath);
    await act(async () => { requests[0]!.resolve(catalog(workspacePath, "loading", true)); });
    assert.equal(busy(), "true");
    assert.deepEqual(options(), initialOptions);
    assert.equal(button("Model").textContent?.includes("Current Model"), true);
    assert.equal(currentDraft(), "draft to keep");
    await close();

    await open();
    await act(async () => { catalogs.forEach((listener) => listener(catalog(workspacePath, "ready", true))); });
    await act(async () => { requests[1]!.resolve(catalog(workspacePath, "loading")); });
    assert.equal(busy(), null);
    assert.deepEqual(options(), initialOptions);
    assert.equal(currentDraft(), "draft to keep");
    await close();
    assert.match(button("Model").title, /Updated Model/);

    await open();
    await switchWorkspace("C:/workspace/b");
    await act(async () => { requests[2]!.resolve(catalog("C:/workspace/a", "loading")); });
    assert.equal(busy(), null);
    await close();
    await open();
    assert.equal(requests[3]?.workspace, "C:/workspace/b");
    await switchWorkspace("C:/workspace/c");
    await act(async () => { requests[3]!.reject(new Error("stale workspace failure")); });
    assert.equal(busy(), null);
    assert.doesNotMatch(button("Model").title, /stale workspace failure/);
    assert.equal(currentDraft(), "draft to keep");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
