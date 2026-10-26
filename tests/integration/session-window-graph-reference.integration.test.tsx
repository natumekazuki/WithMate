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
// claim = "MainとAuxiliaryのどちらを選んでも中央Graph参照の失敗理由を表示・dismissでき、成功時は解除し、親Main ownerと会話送信先を維持する"
// oracle = { type = "contract", ref = "docs/design/session-graph.md: 閲覧UI" }
// fault = "Auxiliary選択中のGraph参照エラーが隠れるかdismissできない、成功後もエラーが残る、参照ownerや送信先がAuxiliaryへ切り替わる"
// observable = "実Appの失敗応答・例外後のalertとdismiss、成功後のalert解除、参照openのsessionId、選択中の送信先button"
// observation_boundary = "component-behavior"
// scope = "SessionWindowAppの中央Graph参照から共通error surfaceへの接続"
// lifecycle = "permanent"
// impact = "開けない理由を利用者へ伝え、別の会話への誤送信と不適切なownerでの参照解決を防ぐ"
// distinction = "Graph単体やfeedback投影testではrootの親ownerと選択中会話の接続差を検出できない"
// @end-test-value
test("Session Window shows Graph reference failures for Main and Auxiliary without changing owners", { timeout: 30_000 }, async () => {
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
  const record = { id: "reference", topicId: "topic", kind: "decision", title: "Graph Reference", detail: "", scope: "",
    actor: { label: "User" }, recordedBy: { sessionId: "benchmark-main", sessionTitle: "Main", role: "main" },
    references: [{ role: "evidence", label: "Open Reference", href: "evidence.md" }], createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z" };
  api.readSessionGraph = (async (_id: string, operation: string) => ({ status: "ok", revision: 1,
    items: operation === "list_topics" ? [{ id: "topic", title: "Topic" }] : [record], total: 1, offset: 0,
    hasMore: false, incomplete: false, relations: [], externalEndpoints: [], relationsTruncated: false })) as WithMateWindowApi["readSessionGraph"];
  api.subscribeSessionGraph = () => () => {};
  let outcome: "failed" | "throw" | "opened" = "failed";
  const owners: string[] = [];
  api.openSessionFilePreviewWindow = async (request) => {
    assert.ok(request.kind === "link");
    owners.push(request.sessionId);
    if (outcome === "throw") throw new Error("Graph reference exception");
    return outcome === "opened" ? { status: "opened", targetType: "external-url", target: "evidence.md" }
      : { status: "failed", targetType: "unknown", target: "evidence.md", message: "Graph reference unavailable" };
  };
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
  const target = () => doc.querySelector(".concurrent-chat-target-dock button[aria-pressed='true']")?.textContent;
  try {
    await act(async () => root.render(<App />));
    for (const selection of ["Main", "Auxiliary"]) {
      if (selection === "Auxiliary") { await click(button("Open Auxiliary")); await click([...doc.querySelectorAll(".concurrent-chat-target-dock button")].find((element) => element.textContent === "Auxiliary")); }
      const previousTarget = target();
      assert.equal(previousTarget, selection);
      await click(button("Graph"));
      if (!doc.querySelector(".session-graph-details")) await click(doc.querySelector(".session-graph-node"));
      outcome = "failed";
      await click(doc.querySelector(".session-graph-references button"));
      assert.match(doc.querySelector("[role='alert']")?.textContent ?? "", /Graph reference unavailable/);
      await click(button("Dismiss path result"));
      assert.doesNotMatch(doc.body.textContent!, /Graph reference unavailable/);
      outcome = "throw";
      await click(doc.querySelector(".session-graph-references button"));
      assert.match(doc.querySelector("[role='alert']")?.textContent ?? "", /Graph reference exception/);
      outcome = "opened";
      await click(doc.querySelector(".session-graph-references button"));
      assert.doesNotMatch(doc.body.textContent!, /Graph reference exception/);
      assert.equal(target(), previousTarget);
      await click(button("Back To Chat"));
      assert.equal(target(), previousTarget);
    }
    assert.deepEqual(owners, Array(6).fill("benchmark-main"));
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
