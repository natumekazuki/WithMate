import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";

// @test-value v2
// kind = "contract"
// claim = "Graphを開くとAuxiliary折り畳み中でも送信対象の会話1つと共有Graphを並べ、Main/Auxiliaryの対象切替で表示会話だけを替えて同じGraphを保持し、Graph全体表示と復帰でもGraphを作り直さず、閉じるとMain/Auxiliaryの分割・折り畳みへ戻り、表示中に選んだ送信対象と下書きを保つ"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/899: 確定した表示契約" }
// fault = "Graphが会話全体を隠す、Auxiliary折り畳み中にMain＋Graphを出せない、対象切替で別会話が残るか送信先と表示が食い違う、切替・全体表示でGraphが作り直され閲覧状態を失う、Graph操作で送信対象・Auxiliaryの開閉・下書きが変わる、または閉じた後も単一会話表示が残る"
// observable = "実SessionWindowAppのGraph領域と会話領域のhidden、Main/Auxiliary列のinert、単一会話class、Auxiliary switcher、Graph DOM nodeの同一性、送信先button、Auxiliary splitterのaccessible name（折り畳み中の`Open Auxiliary`）、Composerのdraft"
// observation_boundary = "component-behavior"
// scope = "SessionWindowAppの中央Graph表示と会話分割の切替"
// lifecycle = "permanent"
// impact = "Graphを見ながらMain/Auxiliaryへ相談できない、または閉じた後に会話レイアウトや入力中の内容が失われる"
// distinction = "ChatWindowやGraph単体testでは、SessionWindowAppが持つGraph表示状態と送信対象・Auxiliaryの折り畳み・下書きの独立性を同時に観測できない"
// @end-test-value
test("Session Window shows the send target beside the shared Graph and restores the chat split on close", { timeout: 30_000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true });
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
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: ["--benchmark-auxiliary-count=1"] }, Buffer,
  });
  api.listSessionFileRoots = async () => [];
  api.getSessionGlossaryProjection = async (id) => ({ sessionId: id, scopeRevision: "fixture", sequence: 1,
    checkout: { repositoryName: "Fixture", branch: "test", pathLabel: "fixture" },
    state: { status: "valid", relativePath: ".withmate/glossary.yaml", revision: "fixture", entries: [] } });
  api.readSessionGraph = (async (_id: string, operation: string) => ({ status: "ok", revision: 1,
    items: operation === "overview" ? [{ id: "topic", title: "Topic", recordCount: 0, recency: null, latestRecordUpdatedAt: null,
      ...Object.fromEntries(["requirements", "constraints", "decisions", "activities", "observations", "issues"].map((category) => [category, { count: 0, states: {}, records: [] }])), actors: [],
    }] : [], total: operation === "overview" ? 1 : 0, offset: 0, recency: null, topicRelations: [],
    hasMore: false, incomplete: false, relations: [], externalEndpoints: [], relationsTruncated: false, relationOffset: 0, relationsHasMore: false })) as WithMateWindowApi["readSessionGraph"];
  api.subscribeSessionGraph = () => () => {};
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context);
  } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => cssImports.deregister());
  const root = createRoot(dom.window.document.getElementById("root")!);
  const doc = dom.window.document;
  const click = async (element: Element | null | undefined) => { assert.ok(element); await act(async () => { (element as HTMLElement).click(); }); };
  const button = (label: string) => [...doc.querySelectorAll("button")].find((element) => element.textContent === label || element.getAttribute("aria-label") === label);
  const targetButton = (label: string) => [...doc.querySelectorAll(".concurrent-chat-target-dock button")].find((element) => element.textContent === label);
  const target = () => doc.querySelector(".concurrent-chat-target-dock button[aria-pressed='true']")?.textContent;
  const conversation = () => doc.querySelector<HTMLElement>(".session-conversation-region")!;
  const graph = () => doc.querySelector(".session-side-region .session-graph-preview");
  // jsdom has no layout height, so only the central surface's own visibility boundaries are read.
  const shown = (selector: string) => {
    const element = doc.querySelector(selector);
    const hiddenBoundary = element?.closest("[hidden], [inert], [aria-hidden='true']");
    return Boolean(element && (!hiddenBoundary || !hiddenBoundary.closest(".session-central-surface")));
  };
  const draft = () => doc.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]')!;
  try {
    await act(async () => root.render(<App />));
    const expandHeader = button("Expand Header");
    if (expandHeader) await click(expandHeader);
    assert.ok(button("Open Auxiliary"), "the Auxiliary starts collapsed");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(draft(), "draft beside graph");
      draft().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });

    await click(button("Graph"));
    const openedGraph = graph();
    assert.ok(openedGraph, "the Graph opens beside the chat");
    assert.equal(shown(".session-side-region .session-graph-preview"), true);
    assert.equal(conversation().hidden, false);
    assert.ok(doc.querySelector(".session-concurrent-chat-columns.is-single-chat"));
    assert.equal(target(), "Main");
    assert.equal(shown(".session-concurrent-chat-main #session-main-chat-pane"), true);
    assert.equal(shown(".session-concurrent-chat-auxiliary #session-auxiliary-chat-pane"), false);

    await click(targetButton("Auxiliary"));
    assert.equal(target(), "Auxiliary");
    assert.equal(shown(".session-concurrent-chat-auxiliary #session-auxiliary-chat-pane"), true);
    assert.equal(shown(".session-concurrent-chat-main #session-main-chat-pane"), false);
    assert.ok(doc.querySelector("[aria-label='Auxiliary conversation']"), "another Auxiliary can be selected beside the Graph");
    assert.equal(graph(), openedGraph, "changing the conversation keeps the same Graph view");

    await click(button("Expand Graph"));
    assert.equal(conversation().hidden, true);
    assert.equal(graph(), openedGraph);
    assert.equal(target(), "Auxiliary");
    await click(button("Show Chat Beside Graph"));
    assert.equal(conversation().hidden, false);
    assert.equal(graph(), openedGraph);

    await click(button("Close Graph"));
    assert.equal(graph(), null);
    assert.equal(doc.querySelector(".session-concurrent-chat-columns.is-single-chat"), null);
    assert.equal(target(), "Auxiliary", "the target chosen while the Graph was open is kept");
    assert.ok(button("Open Auxiliary"), "the Auxiliary is collapsed again as before the Graph opened");
    await click(targetButton("Main"));
    assert.equal(draft().value, "draft beside graph", "the Main draft survives the Graph layout changes");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
