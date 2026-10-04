import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { LiveSessionRunState, SteerSessionTurnRequest } from "../../src-shared/session/runtime-state.js";
import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

// @test-value v2
// kind = "invariant"
// claim = "Codexの受付可能な現在turnだけにMain/Auxiliary composerから追加入力し、重複送信を防ぎ、受付確認したrevisionだけを消す。Auxiliary拒否後はconsume/restore後のdurable revisionで明示再送でき、対象切替ではdraftを保持する。nonblocking質問では生成を継続表示する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 実行中のSend Inputとdraft revision" }
// fault = "追加入力を新turnへ振り替える、二重送信する、拒否や編集後のdraftを消す、対象切替後の古い送信を開始する、Auxiliaryの失敗後に古いdurable revisionで再送する、またはnonblocking質問を承認待ちと表示する"
// observable = "実SessionWindowのSend Input/Cancel、textarea、pending status、preload steer/run呼出とrequest、CAS付きdraft record"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp mid-turn composer input"
// lifecycle = "permanent"
// impact = "追加入力の消失、別会話への送信、新turnの誤開始を防ぐ"
// distinction = "型やprovider単体testでは実composerのguard、shortcut、非同期preview、Main/Auxiliary切替とrevision clearingの接続を検証できない"
// @end-test-value
test("Session Windowは現在turnへ入力しdraft revisionと対象を保護する", { timeout: 30_000 }, async () => {
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
  const boundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value: function (this: HTMLElement) {
    return this.classList.contains("session-message-list")
      ? { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 720, width: 800, height: 720, toJSON() {} }
      : boundingClientRect.call(this);
  } });
  for (const property of ["offsetHeight", "clientHeight"]) Object.defineProperty(dom.window.HTMLElement.prototype, property, {
    configurable: true, get(this: HTMLElement) { return this.classList.contains("session-message-list") ? 720 : 0; },
  });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) { this.scrollTop = typeof options === "object" ? options.top ?? 0 : 0; };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: ["--benchmark-auxiliary-count=1"] }, Buffer,
  });
  const listeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]>();
  api.subscribeLiveSessionRun = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  api.getLiveSessionRun = async () => null;
  api.listSessionFileRoots = async () => [];
  const getSession = api.getSession;
  api.getSession = async (id) => { const session = await getSession(id); return session ? { ...session, runState: "running" } : null; };
  const getAuxiliary = api.getAuxiliarySession;
  let auxiliaryId = "";
  api.getAuxiliarySession = async (id) => { auxiliaryId = id; const session = await getAuxiliary(id); return session ? { ...session, runState: "running" } : null; };
  const getAuxiliaryStatus = api.getAuxiliarySessionStatus;
  api.getAuxiliarySessionStatus = async (id) => { const status = await getAuxiliaryStatus(id); return status ? { ...status, runState: "running" } : null; };
  const records = new Map<string, AuxiliaryDraftRecord>();
  const getDraft = api.getAuxiliaryDraft;
  api.getAuxiliaryDraft = async (id) => {
    const record = records.get(id) ?? await getDraft(id);
    if (record) records.set(id, record);
    return record ? { ...record } : null;
  };
  api.saveAuxiliaryDraft = async (request) => {
    const record = await api.getAuxiliaryDraft(request.auxiliarySessionId);
    if (!record || record.incarnation !== request.incarnation || record.durableRevision !== request.expectedDurableRevision) return { outcome: "stale" };
    const saved = { ...record, text: request.text, durableRevision: record.durableRevision + 1, updatedAt: request.updatedAt };
    records.set(saved.auxiliarySessionId, saved);
    return { outcome: "saved", ack: { auxiliarySessionId: saved.auxiliarySessionId, incarnation: saved.incarnation, durableRevision: saved.durableRevision, updatedAt: saved.updatedAt } };
  };
  let runCalls = 0;
  api.runSessionTurn = async () => { runCalls++; throw new Error("unexpected new turn"); };
  api.runAuxiliarySessionTurn = async () => { runCalls++; throw new Error("unexpected auxiliary new turn"); };
  const calls: Array<{ id: string; request: SteerSessionTurnRequest }> = [];
  let accept!: () => void;
  let reject!: (error: Error) => void;
  const steer = (id: string, request: SteerSessionTurnRequest) => {
    calls.push({ id, request });
    const auxiliaryDraft = id === auxiliaryId ? records.get(id) : undefined;
    if (auxiliaryDraft && auxiliaryDraft.durableRevision !== request.auxiliaryDraftDurableRevision) return Promise.reject(new Error("draft changed"));
    if (auxiliaryDraft) records.set(id, { ...auxiliaryDraft, text: "", durableRevision: auxiliaryDraft.durableRevision + 1 });
    return new Promise<{ turnId: string }>((resolve, rejectResult) => {
      accept = () => resolve({ turnId: request.expectedTurnId });
      reject = (error) => {
        if (auxiliaryDraft) records.set(id, { ...auxiliaryDraft, durableRevision: auxiliaryDraft.durableRevision + 2 });
        rejectResult(error);
      };
    });
  };
  api.steerSessionTurn = steer;
  api.steerAuxiliarySessionTurn = steer;
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("../../src/app/SessionWindowApp.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const emit = async (id: string, inputAvailable: boolean, cancellationState?: "requested", extra?: Partial<LiveSessionRunState>) => {
    const state: LiveSessionRunState = { sessionId: id, threadId: "thread", turnId: "current-turn", inputAvailable, cancellationState,
      assistantText: "", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null, ...extra };
    await act(async () => { listeners.forEach((listener) => listener(id, state)); });
  };
  const textarea = () => dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  const button = (text: string) => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text)!;
  const draft = async (value: string) => act(async () => {
    const field = textarea();
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  try {
    await act(async () => { root.render(<App />); });
    await emit("benchmark-main", false);
    assert.equal(button("Send").disabled, true);
    await emit("benchmark-main", true);
    assert.ok(button("Cancel"));
    assert.equal(textarea().disabled, false);
    await emit("benchmark-main", true, undefined, { assistantText: "Generating current response", elicitationRequest: {
      requestId: "nonblocking-question", provider: "codex", mode: "form", blocking: false, message: "Optional direction", fields: [],
    } });
    assert.match(dom.window.document.body.textContent!, /Input Requested/);
    assert.match(dom.window.document.body.textContent!, /Generating a response/);
    await emit("benchmark-main", true);
    await draft("first input");
    await act(async () => { button("Send Input").click(); });
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].id, calls[0].request.expectedTurnId, calls[0].request.userMessage], ["benchmark-main", "current-turn", "first input"]);
    assert.equal(button("Send Input").disabled, true);
    await act(async () => { textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    assert.equal(calls.length, 1);
    await draft("newer draft");
    await act(async () => { accept(); });
    assert.equal(textarea().value, "newer draft");
    await act(async () => { button("Send Input").click(); });
    await act(async () => { reject(new Error("turn ended")); });
    assert.equal(textarea().value, "newer draft");
    assert.match(dom.window.document.body.textContent!, /Main was not confirmed.*draft is preserved/);
    await act(async () => { textarea().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    await act(async () => { accept(); });
    assert.equal(textarea().value, "");
    await emit("benchmark-main", true, "requested");
    assert.equal(button("Send").disabled, true);
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Open Auxiliary']")!.click(); });
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".concurrent-chat-target-dock button:last-child")!.click(); });
    await emit(auxiliaryId, true);
    assert.ok(button("Send Input"));
    await draft("auxiliary input");
    await act(async () => { button("Send Input").click(); });
    assert.equal(calls.at(-1)!.id, auxiliaryId);
    assert.equal(calls.at(-1)!.request.auxiliaryDraftIncarnation, "benchmark-incarnation");
    assert.equal(typeof calls.at(-1)!.request.auxiliaryDraftDurableRevision, "number");
    const rejectedDraftRevision = calls.at(-1)!.request.auxiliaryDraftDurableRevision!;
    await act(async () => { reject(new Error("steer was rejected")); });
    assert.equal(textarea().value, "auxiliary input");
    assert.equal(records.get(auxiliaryId)!.durableRevision, rejectedDraftRevision + 2);
    await act(async () => { button("Send Input").click(); });
    assert.equal(calls.at(-1)!.request.auxiliaryDraftDurableRevision, rejectedDraftRevision + 2);
    await act(async () => { accept(); });
    assert.equal(textarea().value, "");
    await draft("preserved after switch");
    const preview = api.previewComposerInput;
    let releasePreview!: () => void;
    const delayedPreview = new Promise<void>((resolve) => { releasePreview = resolve; });
    api.previewComposerInput = async (id, message) => { await delayedPreview; return preview(id, message); };
    const beforeSwitch = calls.length;
    await act(async () => { button("Send Input").click(); });
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".concurrent-chat-target-dock button:first-child")!.click(); });
    await act(async () => { releasePreview(); });
    assert.equal(calls.length, beforeSwitch);
    api.previewComposerInput = preview;
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".concurrent-chat-target-dock button:last-child")!.click(); });
    assert.equal(textarea().value, "preserved after switch");
    assert.equal(runCalls, 0);
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
