import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";

// @test-value v2
// kind = "invariant"
// claim = "Session WindowのMain/Auxiliary live本文は選択中の会話へ届き、Auxiliaryのterminalは保存本文へ一度だけ収束する。本文だけの更新、Files tab変更、Glossary検索は無関係なAuxiliary一覧の全summaryを再投影せず、Auxiliary draftを保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: UI Implementation Boundary; pending中のlive activity / streaming response" }
// fault = "rootが全文live snapshotやFiles tab/Glossary検索で一覧summaryを全件評価する、会話のlive購読が失われる、terminal後にliveと保存本文が二重表示される、または補助機能の操作でAuxiliary draftが消える"
// observable = "実AppのMain/Auxiliary会話本文、Glossary検索owner、Auxiliary composer draft、summary characterIconPath getter読取回数"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp conversation update boundaries"
// lifecycle = "permanent"
// impact = "長い会話・多数Auxiliaryの実行中に無関係な一覧処理が波及し、応答の消失や重複で会話を読めなくなる"
// distinction = "hook単体や型検査ではroot→ChatWindow→会話列の購読・表示とAuxiliary一覧への伝播を同時に検証できない。壁時計性能値をCI合否に使わない"
// @end-test-value
test("Session Windowのlive本文は一覧投影を広げず会話へ届きterminal本文へ収束する", { timeout: 30_000 }, async () => {
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
  const getBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function (this: HTMLElement) {
      return this.classList.contains("session-message-list")
        ? { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 720, width: 800, height: 720, toJSON() {} }
        : getBoundingClientRect.call(this);
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("session-message-list") ? 720 : 0; },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("session-message-list") ? 720 : 0; },
  });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === "number" ? (y ?? this.scrollTop) : (options?.top ?? this.scrollTop);
  };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: (name: string) => {
      assert.equal(name, "electron");
      return { contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } };
    },
    process: { argv: ["--benchmark-auxiliary-count=40"] },
    Buffer,
  });
  const liveListeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]>();
  api.subscribeLiveSessionRun = (listener) => { liveListeners.add(listener); return () => { liveListeners.delete(listener); }; };
  const liveStates = new Map<string, LiveSessionRunState | null>();
  api.getLiveSessionRun = async (id) => liveStates.get(id) ?? null;
  api.listSessionFileRoots = async () => [];
  api.getSessionGlossaryProjection = async (id) => ({
    sessionId: id, scopeRevision: "fixture", sequence: 1,
    checkout: { repositoryName: "Fixture", branch: "test", pathLabel: "fixture" },
    state: { status: "valid", relativePath: ".withmate/glossary.yaml", revision: "fixture", entries: [] },
  });
  const glossarySearchOwners: string[] = [];
  api.searchSessionGlossary = async (id, request) => {
    glossarySearchOwners.push(id);
    return { ok: true, revision: "fixture", entries: [{ term: request.query, aliases: [], definition: "fixture definition" }], total: 1, offset: 0, pageSize: 100 };
  };
  const getSession = api.getSession;
  api.getSession = async (id) => {
    const session = await getSession(id);
    return session ? { ...session, messages: [{ role: "user", text: "main current prompt" }] } : null;
  };
  let summaryReads = 0;
  const listAuxiliary = api.listAuxiliarySessions;
  api.listAuxiliarySessions = async (id) => (await listAuxiliary(id)).map((summary) => ({
    ...summary,
    get characterIconPath() { summaryReads += 1; return ""; },
  }));
  const originalAuxiliary = api.getAuxiliarySession;
  let savedAuxiliaryResponse = "";
  let terminalTargetId = "";
  let loadedAuxiliaryId = "";
  api.getAuxiliarySession = async (id) => {
    loadedAuxiliaryId = id;
    const session = await originalAuxiliary(id);
    if (!session) return null;
    const messages = [{ role: "user" as const, text: "aux current prompt" }];
    return id === terminalTargetId && savedAuxiliaryResponse
      ? { ...session, runState: "idle", messages: [...messages, { role: "assistant", text: savedAuxiliaryResponse }] }
      : { ...session, messages };
  };
  const originalStatus = api.getAuxiliarySessionStatus;
  api.getAuxiliarySessionStatus = async (id) => {
    const status = await originalStatus(id);
    return status ? { ...status, runState: savedAuxiliaryResponse ? "idle" : "running" } : null;
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("../../src/app/SessionWindowApp.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const run = (sessionId: string, assistantText: string): LiveSessionRunState => ({
    sessionId, threadId: `${sessionId}-thread`, assistantText, steps: [], backgroundTasks: [],
    usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
  });
  const emit = async (sessionId: string, state: LiveSessionRunState | null) => {
    liveStates.set(sessionId, state);
    await act(async () => { liveListeners.forEach((listener) => listener(sessionId, state)); });
  };
  const columnText = (selector: string) => dom.window.document.querySelector(selector)?.textContent ?? "";
  const jumpLatest = async (selector: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`${selector} button[aria-label='Jump to latest']`);
    if (button) await act(async () => { button.click(); });
  };
  try {
    await act(async () => { root.render(<App />); });
    const initialReads = summaryReads;
    await emit("benchmark-main", run("benchmark-main", "main live first"));
    await emit("benchmark-main", run("benchmark-main", "main live latest"));
    await jumpLatest("#session-main-chat-pane");
    assert.match(columnText("#session-main-chat-pane"), /main live latest/);
    assert.doesNotMatch(columnText("#session-main-chat-pane"), /main live first/);
    assert.equal(summaryReads, initialReads, "main live text must not reproject every Auxiliary summary");

    const openAuxiliary = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Open Auxiliary']");
    assert.ok(openAuxiliary);
    await act(async () => { openAuxiliary.click(); });
    const auxiliaryTarget = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".concurrent-chat-target-dock button"))
      .find((button) => button.textContent === "Auxiliary");
    assert.ok(auxiliaryTarget);
    await act(async () => { auxiliaryTarget.click(); });
    terminalTargetId = loadedAuxiliaryId;
    assert.ok(terminalTargetId);
    await emit(terminalTargetId, run(terminalTargetId, "aux live first"));
    const auxiliaryReads = summaryReads;
    await emit(terminalTargetId, run(terminalTargetId, "aux live latest"));
    await jumpLatest("#session-auxiliary-chat-pane");
    assert.match(columnText("#session-auxiliary-chat-pane"), /aux live latest/);
    assert.doesNotMatch(columnText("#session-auxiliary-chat-pane"), /aux live first/);
    assert.equal(summaryReads, auxiliaryReads, "auxiliary live text must not reproject every summary");

    savedAuxiliaryResponse = "auxiliary final response";
    await emit(terminalTargetId, null);
    const rendered = columnText("#session-auxiliary-chat-pane");
    assert.equal(rendered.split(savedAuxiliaryResponse).length - 1, 1);
    assert.doesNotMatch(rendered, /aux live latest/);

    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]');
    assert.ok(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "auxiliary draft to keep");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(textarea.value, "auxiliary draft to keep");
    const openFiles = dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Open File explorer']");
    assert.ok(openFiles);
    const beforeFileTab = summaryReads;
    await act(async () => { openFiles.click(); });
    const changesTab = dom.window.document.querySelector<HTMLButtonElement>(".session-file-explorer-tabs button[role='tab']:nth-child(2)");
    assert.ok(changesTab);
    await act(async () => { changesTab.click(); });
    assert.equal(textarea.value, "auxiliary draft to keep");
    assert.equal(summaryReads, beforeFileTab, "local Files tab changes must not reproject Auxiliary summaries");

    const rightPaneSwitcher = dom.window.document.querySelector<HTMLButtonElement>("[aria-label='Right pane view'] .session-switcher-current");
    assert.ok(rightPaneSwitcher);
    await act(async () => { rightPaneSwitcher.click(); });
    const glossaryOption = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("[aria-label='Right pane view list'] [role='option']"))
      .find((option) => option.textContent?.trim() === "Glossary");
    assert.ok(glossaryOption);
    await act(async () => { glossaryOption.click(); });
    const glossarySearch = dom.window.document.querySelector<HTMLInputElement>(".glossary-search-field input");
    assert.ok(glossarySearch);
    const beforeSearch = summaryReads;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(glossarySearch, "fixture term");
      glossarySearch.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.deepEqual(glossarySearchOwners, ["benchmark-main"]);
    assert.equal(textarea.value, "auxiliary draft to keep");
    assert.equal(summaryReads, beforeSearch, "glossary search must not reproject Auxiliary summaries");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
