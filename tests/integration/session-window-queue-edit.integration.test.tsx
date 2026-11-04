import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import { getSessionIncarnationId } from "../../src-shared/session/session-state.js";

async function mount() {
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
  dom.window.alert = (message) => { throw new Error(String(message)); };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: ["--benchmark-auxiliary-count=1"] }, Buffer,
  });
  const main = (await api.getSession("benchmark-main"))!;
  const auxiliary = (await api.listAuxiliarySessions(main.id))[0];
  const aux = (await api.getAuxiliarySession(auxiliary.id))!;
  const rows = [main, { ...main, id: aux.id, incarnationId: aux.createdAt }].map((session, index): SessionTurnQueueReceipt => ({
    sessionId: session.id, incarnationId: getSessionIncarnationId(session), id: `queued-${index}`, requestId: `request-${index}`, sequence: 10 + index, queuePosition: 10 + index,
    state: "queued", captured: { request: { clientRequestId: `request-${index}`, userMessage: `Original queued message ${index}`, executionOptions: captureSessionExecutionOptions(session) }, attachments: [], provider: session.provider, workspacePath: session.workspacePath },
    turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: "now", updatedAt: "now",
  }));
  const queueListeners = new Set<(id: string) => void>();
  api.onSessionTurnQueueChanged = (listener) => { queueListeners.add(listener); return () => { queueListeners.delete(listener); }; };
  api.listSessionTurnQueue = async (id) => rows.filter((row) => row.sessionId === id).map((row) => structuredClone(row));
  api.getSessionTurnQueueReceipt = async (id, requestId) => rows.find((row) => row.sessionId === id && row.requestId === requestId) ?? null;
  const paused = new Set<string>();
  const updates: Array<{ sessionId: string; userMessage: string }> = [];
  let failUpdate = false;
  let releaseUpdate: (() => void) | undefined;
  api.beginQueuedSessionTurnEdit = async (sessionId, request) => {
    const row = rows.find((item) => item.sessionId === sessionId && item.id === request.id)!;
    assert.equal(request.incarnationId, row.incarnationId);
    paused.add(sessionId);
    return structuredClone(row);
  };
  api.cancelQueuedSessionTurnEdit = async (id) => { paused.delete(id); };
  api.updateQueuedSessionTurn = async (sessionId, request) => {
    updates.push({ sessionId, userMessage: request.userMessage });
    await new Promise<void>((resolve) => { releaseUpdate = resolve; });
    if (failUpdate) throw new Error("Queue storage unavailable");
    const row = rows.find((item) => item.sessionId === sessionId && item.id === request.id)!;
    row.captured.request.userMessage = request.userMessage;
    paused.delete(sessionId);
    queueListeners.forEach((listener) => listener(sessionId));
    return structuredClone(row);
  };
  let sends = 0;
  api.enqueueSessionTurn = async () => { sends++; throw new Error("Edit must not enqueue a new turn"); };
  api.steerSessionTurn = async () => { sends++; throw new Error("Edit must not steer a running turn"); };
  api.steerAuxiliarySessionTurn = api.steerSessionTurn;
  api.getLiveSessionRun = async (sessionId) => ({ sessionId, threadId: "thread", turnId: "running", inputAvailable: true, assistantText: "Current response", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null });
  api.listSessionFileRoots = async () => [];
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const css = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", shortCircuit: true, source: "" } : next(url, context); } });
  const { default: App } = await import("../../src/app/SessionWindowApp.js").finally(() => css.deregister());
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(<App />); });
  await act(async () => { dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Open Auxiliary']")!.click(); });
  const textarea = () => dom.window.document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  const editButton = (row: SessionTurnQueueReceipt) => dom.window.document.querySelector<HTMLButtonElement>(`[data-queue-receipt-id="${row.id}"] button[title="Edit queued message"]`)!;
  const cancel = () => dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Cancel Edit']")!;
  const submit = () => dom.window.document.querySelector<HTMLButtonElement>(".composer-send-control > button.session-send-button")!;
  const fill = async (value: string) => act(async () => {
    const field = textarea();
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const click = async (button: HTMLButtonElement) => { assert.ok(button); await act(async () => { button.click(); }); };
  return { dom, rows, paused, updates, textarea, editButton, cancel, submit, fill, click,
    get sends() { return sends; },
    async resolveUpdate(fail = false) { failUpdate = fail; await act(async () => { releaseUpdate!(); }); },
    async switchTarget(index: number) { await click(dom.window.document.querySelectorAll<HTMLButtonElement>(".concurrent-chat-target-dock button")[index]); },
    async close() { await act(async () => { root.unmount(); }); dom.window.close(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Main/AuxiliaryのEditは既存textareaで同じ予約を更新し、通常下書きを保持し、失敗時は編集入力と保留を残す。更新待機中の重複操作と通常送信・Steerへの誤配送を防ぐ"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Queued Message Edit; docs/design/session-run-lifecycle.md: Queue Editing" }
// fault = "通常下書きを編集本文で上書きする、編集を新規受付やSteerへ送る、失敗で本文を消す、または保存待ちの重複更新を送る"
// observable = "実SessionWindowのEdit/Submit/Cancel Edit操作、textarea値、ボタンdisabled、更新API要求と呼出数、通常下書き復帰、失敗時の保留とエラー表示"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp queue edit wiring across Main and Auxiliary"
// lifecycle = "permanent"
// impact = "予約と通常下書きの混同、別経路への誤送信、未保存の入力消失を防ぐ"
// distinction = "Main側storage/service testや型検査では実ActionDockの入力owner・ボタン・shortcutの接続と下書き復帰を検出できない"
// @end-test-value
test("Session Windowのキュー編集は通常下書きと送信経路を分離する", { timeout: 30_000 }, async () => {
  const view = await mount();
  try {
    for (const [index, row] of view.rows.entries()) {
      await view.switchTarget(index);
      await view.fill(`Normal draft ${index}`);
      assert.ok(view.editButton(row), `Missing ${row.id}: ${view.dom.window.document.body.textContent}`);
      await view.click(view.editButton(row));
      assert.equal(view.textarea().value, row.captured.request.userMessage);
      assert.equal(view.paused.has(row.sessionId), true);
      assert.equal(view.submit().title.split(" (")[0], "Submit");
      await view.fill(`Edited message ${index}`);
      await act(async () => { view.textarea().dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true })); });
      assert.equal(view.sends, 0);
      if (index === 0) {
        await view.switchTarget(1);
        await view.fill("Other conversation draft");
        await view.switchTarget(0);
        assert.equal(view.textarea().value, "Edited message 0");
      }
      await view.click(view.submit());
      assert.equal(view.textarea().disabled, true);
      assert.equal(view.cancel().disabled, true);
      assert.equal(view.updates.length, index + 1);
      await view.resolveUpdate(index === 0);
      if (index === 0) {
        assert.equal(view.textarea().value, "Edited message 0");
        assert.equal(view.paused.has(row.sessionId), true);
        await view.click(view.dom.window.document.querySelector<HTMLButtonElement>("button[aria-label='Message Submission Error Details']")!);
        assert.match(view.dom.window.document.body.textContent!, /update could not be confirmed/);
        await view.click(view.cancel());
        assert.equal(row.captured.request.userMessage, "Original queued message 0");
      } else {
        assert.equal(row.captured.request.userMessage, "Edited message 1");
      }
      assert.equal(view.textarea().value, `Normal draft ${index}`);
      assert.equal(view.paused.has(row.sessionId), false);
      assert.equal(view.sends, 0);
    }
  } finally { await view.close(); }
});
