import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { Session } from "../../src-shared/session/session-state.js";

// @test-value v2
// kind = "contract"
// claim = "Mainの取消受付と終了待ちは保存SessionがidleでもCancelingと送信不可へ投影され、終了通知後は次のSendを受け付ける。遅い旧取消応答は次Turnを巻き戻さない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Mainの取消受付後; https://github.com/natumekazuki/WithMate/issues/773" }
// fault = "liveの取消状態変更をshellが無視する、保存idleを優先してSendや再送を許す、解放後もbusyが残る、または遅い取消応答で新Turnをidleに戻す"
// observable = "実SessionWindowAppのexpanded/compact Canceling button、Send disabled、送信shortcutのrun呼出数、次Turnのrunning表示"
// observation_boundary = "component-behavior"
// scope = "Main cancellation live projection and composer actions"
// lifecycle = "permanent"
// impact = "取消後のSend拒否や次Turnの状態破損で同じSessionの会話を継続できなくなる"
// distinction = "Mainのguard単体や型検査ではlive購読の更新抑制・保存snapshotとの優先順位・二つのdockとshortcutの実配線を検査できない。合成IPCとdeferredで待機順序を固定する"
// @end-test-value
test("Mainの取消完了までSendを止め、遅い取消応答は次Turnへ反映しない", { timeout: 30_000 }, async () => {
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
  dom.window.HTMLElement.prototype.scrollTo = function () {};
  const alerts: string[] = [];
  dom.window.alert = (message) => { alerts.push(String(message)); };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: [] }, Buffer,
  });
  let session: Session = { ...(await api.getSession("benchmark-main"))!, runState: "running", status: "running" };
  const liveListeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]>();
  const sessionListeners = new Set<Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]>();
  let live: LiveSessionRunState | null = {
    sessionId: session.id, threadId: session.threadId, assistantText: "partial response",
    steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null,
  };
  api.getSession = async () => session;
  api.getLiveSessionRun = async () => live;
  api.subscribeLiveSessionRun = (listener) => { liveListeners.add(listener); return () => { liveListeners.delete(listener); }; };
  api.subscribeSessionInvalidation = (listener) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; };
  api.listSessionFileRoots = async () => [];
  api.getSessionGlossaryProjection = async () => ({
    sessionId: session.id, scopeRevision: "fixture", sequence: 1,
    checkout: { repositoryName: "Fixture", branch: "test", pathLabel: "fixture" },
    state: { status: "valid", relativePath: ".withmate/glossary.yaml", revision: "fixture", entries: [] },
  });
  const broadcastLive = () => liveListeners.forEach((listener) => listener(session.id, live));
  let finishCancel!: () => void;
  const cancelAck = new Promise<void>((resolve) => { finishCancel = resolve; });
  let cancelCalls = 0;
  api.cancelSessionRun = async () => {
    cancelCalls += 1;
    live = { ...live!, cancellationState: "requested" };
    broadcastLive();
    await cancelAck;
  };
  let finishNextRun!: (value: Session) => void;
  let sendCalls = 0;
  api.runSessionTurn = async (_id, request) => {
    sendCalls += 1;
    session = { ...session, runState: "running", status: "running", messages: [...session.messages, { role: "user", text: request.userMessage }] };
    return new Promise<Session>((resolve) => { finishNextRun = resolve; });
  };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("../../src/app/SessionWindowApp.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const buttons = (label: string) => Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => button.textContent?.trim() === label);
  const send = () => {
    const button = buttons("Send")[0];
    assert.ok(button);
    return button;
  };
  try {
    await act(async () => { root.render(<App />); });
    const cancel = buttons("Cancel")[0];
    assert.ok(cancel);
    await act(async () => { cancel.click(); });
    assert.equal(cancelCalls, 1);
    for (const button of buttons("Canceling")) {
      assert.equal(button.disabled, true);
      assert.equal(button.getAttribute("aria-busy"), "true");
      await act(async () => { button.click(); });
    }
    assert.equal(cancelCalls, 1);
    assert.ok(buttons("Canceling").length >= 2, "expanded and compact docks must both reflect cancellation");
    assert.equal(send().disabled, true);
    await act(async () => {
      session = { ...session, runState: "idle", status: "idle" };
      live = { ...live!, cancellationState: "terminating" };
      broadcastLive();
      sessionListeners.forEach((listener) => listener({ scope: "ids", sessionIds: [session.id] }));
    });
    assert.equal(send().disabled, true, "stored idle cannot enable Send before the runtime releases the run");
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]')!;
    assert.ok(textarea);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "next prompt");
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      send().click();
    });
    assert.equal(sendCalls, 0);
    await act(async () => { live = null; broadcastLive(); });
    assert.equal(buttons("Canceling").length, 0);
    assert.equal(send().disabled, false);
    await act(async () => { send().click(); });
    assert.equal(sendCalls, 1);
    assert.equal(send().disabled, true);
    await act(async () => { finishCancel(); });
    assert.ok(buttons("Cancel").length >= 2, "old cancel acknowledgement must leave the next run active");
    assert.equal(send().disabled, true);
    await act(async () => { finishNextRun({ ...session, runState: "idle", status: "idle" }); });
    assert.deepEqual(alerts, []);
  } finally {
    finishCancel();
    finishNextRun?.({ ...session, runState: "idle", status: "idle" });
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
