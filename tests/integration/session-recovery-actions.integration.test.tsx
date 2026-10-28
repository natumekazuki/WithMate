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
// claim = "実Session画面は最新turn取得中と失敗時にも回復操作を保持し、選択Main/Auxiliaryの前回本文を再送して各draftを保持し、Editの明示置換を対象draftだけに適用し、会話切替で確認を無効化する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: terminal state 後の再送導線" }
// fault = "再送に現在draftや別会話を使う、draftを消す、Editで無確認上書きする、または切替後も旧確認を適用する"
// observable = "実SessionWindowAppの最新turn loading/errorとRetry、enqueueSessionTurn引数、各ownerのtextarea値、確認dialog.open、focusとAuxiliary durable draft"
// observation_boundary = "component-behavior"
// scope = "session-main-auxiliary-recovery-routing"
// lifecycle = "permanent"
// impact = "違う依頼を送信したり別会話の未送信本文を失う"
// distinction = "callback単体や静的描画では実Appのowner routingとdraft persistenceを横断する欠陥を検出できない"
// @end-test-value
test("Main/AuxiliaryのResendとEditは前回依頼とdraftのownerを維持する", { timeout: 10000 }, async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", {
    url: "https://withmate.test/session.html?sessionId=benchmark-main", pretendToBeVisual: true,
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
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: [] }, Buffer,
  });

  const getModelCatalog = api.getModelCatalog;
  api.getModelCatalog = async (request) => {
    const snapshot = await getModelCatalog(request);
    return snapshot ? { ...snapshot, workspacePath: request?.workspacePath } : snapshot;
  };
 const main = (await api.getSession("benchmark-main"))!;
  const auxiliary = (await api.getAuxiliarySession("benchmark-aux-1"))!;
  main.runState = "error";
  main.messages = [{ role: "user", text: "Previous Main request" }];
  auxiliary.runState = "error";
  auxiliary.messages = [{ role: "user", text: "Previous Auxiliary request" }];
  auxiliary.composerDraft = "Preserve Auxiliary draft";
  let rejectLatestTurn!: (reason: Error) => void;
  const latestTurnRead = new Promise<null>((_resolve, reject) => { rejectLatestTurn = reject; });
  let mainLatestTurnReads = 0;
  api.getLatestSessionTurn = (owner) => {
    if (owner === main.id && ++mainLatestTurnReads === 1) return latestTurnRead;
    return Promise.resolve(null);
  };
  const sent: { owner: string; text: string }[] = [];
  const enqueue = api.enqueueSessionTurn;
  api.enqueueSessionTurn = async (owner, request) => {
    assert.equal(request.submitSource, "retry", "Recovery must use the non-consuming queue submission contract");
    if (owner === auxiliary.id) {
      assert.equal(request.auxiliaryDraftIncarnation, undefined);
      assert.equal(request.auxiliaryDraftDurableRevision, undefined);
    }
    sent.push({ owner, text: request.userMessage });
    return enqueue(owner, request);
  };
  let resolveRestoredDraft!: () => void;
  const restoredDraftSaved = new Promise<void>((resolve) => { resolveRestoredDraft = resolve; });
  const saveDraft = api.saveAuxiliaryDraft;
  api.saveAuxiliaryDraft = async (request) => {
    const result = await saveDraft(request);
    if (request.text === "Previous Auxiliary request") resolveRestoredDraft();
    return result;
  };
  api.listSessionFileRoots = async () => [];
  api.getSessionGlossaryProjection = async () => ({
    sessionId: main.id, scopeRevision: "fixture", sequence: 1,
    checkout: { repositoryName: "Fixture", branch: "test", pathLabel: "fixture" },
    state: { status: "valid", relativePath: ".withmate/glossary.yaml", revision: "fixture", entries: [] },
  });
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const cssImports = registerHooks({ load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context);
  } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => cssImports.deregister());
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const composer = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
  const button = (label: string) => {
    const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
    assert.ok(result, `Missing ${label}`);
    return result;
  };
  const click = async (label: string) => { await act(async () => { button(label).click(); }); };
  const target = async (label: string) => {
    const control = container.querySelector<HTMLButtonElement>(`.concurrent-chat-target-dock button[title="${label}"]`);
    assert.ok(control, `Missing target ${label}`);
    await act(async () => { control.click(); });
  };
  const conflict = () => container.querySelector<HTMLDialogElement>("dialog.session-recovery-conflict")!;
  try {
    await act(async () => { root.render(<App />); });
    assert.equal(container.querySelector('[aria-label="Main: Previous Request Actions"]')?.getAttribute("aria-busy"), "true");
    assert.equal(button("Resend").disabled, false);
    await act(async () => { rejectLatestTurn(new Error("Latest turn unavailable")); });
    assert.match(container.textContent!, /Could not load the latest execution: Latest turn unavailable/);
    assert.equal(button("Resend").disabled, false);
    await click("Retry");
    assert.equal(mainLatestTurnReads, 2);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer(), "Preserve Main draft");
      composer().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Resend");
    assert.deepEqual(sent, [{ owner: main.id, text: "Previous Main request" }]);
    assert.equal(composer().value, "Preserve Main draft");
    await click("Edit");
    assert.equal(conflict().open, true);
    assert.equal(composer().value, "Preserve Main draft");
    await click("Keep Current Draft");
    assert.equal(conflict().open, false);
    assert.equal(composer().value, "Preserve Main draft");
    await click("Edit");
    assert.equal(conflict().open, true);
    await target("Auxiliary");
    assert.equal(conflict().open, false, "Main confirmation must not transfer to Auxiliary");
    assert.equal(composer().value, "Preserve Auxiliary draft");
    await click("Resend");
    assert.deepEqual(sent, [
      { owner: main.id, text: "Previous Main request" },
      { owner: auxiliary.id, text: "Previous Auxiliary request" },
    ]);
    assert.equal(composer().value, "Preserve Auxiliary draft");
    assert.equal((await api.getAuxiliaryDraft(auxiliary.id))!.text, "Preserve Auxiliary draft");
    await click("Edit");
    assert.equal(conflict().open, true);
    await click("Replace With Previous Request");
    await act(async () => { await restoredDraftSaved; });
    assert.equal(composer().value, "Previous Auxiliary request");
    assert.equal((await api.getAuxiliaryDraft(auxiliary.id))!.text, "Previous Auxiliary request");
    assert.equal(dom.window.document.activeElement, composer());
    await target("Main");
    assert.equal(composer().value, "Preserve Main draft");
    assert.equal(conflict().open, false, "Returning to Main must require a new confirmation");
    await click("Edit");
    await click("Replace With Previous Request");
    assert.equal(composer().value, "Previous Main request");
    assert.equal(sent.length, 2, "Edit never sends automatically");
    await target("Auxiliary");
    assert.equal(composer().value, "Previous Auxiliary request");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
