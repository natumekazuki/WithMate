import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Session } from "../../src-shared/session/session-state.js";
import type { SessionTurnQueueReceipt } from "../../src-shared/session/session-turn-queue.js";
import { captureSessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { ComposerControllerRegistry } from "../../src/chat/composer-controller.js";
import { createStaticTextConversationMessageColumnProps } from "../../src/chat/chat-window-adapter.js";
import { useConversationMessageColumn } from "../../src/chat/conversation-message-column.js";
import { useMainSessionRuntime } from "../../src/chat/runtime/use-main-session-runtime.js";
import { useAuxiliaryWorkspace } from "../../src/chat/use-auxiliary-workspace.js";
import type { OwnedLiveSessionRunState } from "../../src/chat/runtime/session-live-run-state.js";
import {
  createAuxiliarySessionPendingLiveRunClearer,
  createAuxiliarySessionRunningApplier,
  createAuxiliarySessionSendResultAppliers,
  runAuxiliarySessionSendOperationWithApi,
} from "../../src/chat/auxiliary/auxiliary-session-send-operation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function setup() {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://withmate.test" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: ["--benchmark-auxiliary-count=2"] }, Buffer,
  });
  const registry = new ComposerControllerRegistry();
  let listener: Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0] | undefined;
  let queueListener: ((id: string) => void) | undefined;
  api.onSessionTurnQueueChanged = (next) => { queueListener = next; return () => { queueListener = undefined; }; };
  api.subscribeLiveSessionRun = (next) => { listener = next; return () => { listener = undefined; }; };
  const baseProps = createStaticTextConversationMessageColumnProps({
    sessionId: "benchmark-main", characterId: "character", characterName: "Mate", characterIconPath: "",
    messages: [], messageListRef: React.createRef(), isRunning: false,
  });
  let current!: ReturnType<typeof Probe>;
  function Probe() {
    const main = useMainSessionRuntime({ api, selectedId: "benchmark-main", composerRegistry: registry });
    const auxiliary = useAuxiliaryWorkspace({ api, parentSessionId: "benchmark-main" });
    const [live, setLive] = useState<OwnedLiveSessionRunState>({ ownerSessionId: null, state: null });
    const mainColumn = useConversationMessageColumn({
      session: main.sessions[0] ?? null, baseProps, enabled: true, api,
      liveRun: live.ownerSessionId === "benchmark-main" ? live.state : null,
    });
    const auxiliaryColumn = useConversationMessageColumn({
      session: auxiliary.selectedSession, baseProps, enabled: true, messageSourceKind: "auxiliary",
      liveRun: live.ownerSessionId === auxiliary.selectedId ? live.state : null,
    });
    return { main, auxiliary, live, setLive, mainColumn, auxiliaryColumn };
  }
  function View() { current = Probe(); return null; }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(<View />); });
  return {
    api, registry,
    get current() { return current; },
    emit(state: OwnedLiveSessionRunState["state"]) { listener?.(current.auxiliary.selectedId!, state); },
    emitQueue() { queueListener?.("benchmark-main"); },
    sendMain(text: string) {
      const session = current.main.sessions[0];
      const owner = { kind: "main" as const, id: session.id };
      registry.setDraft(owner, text);
      return current.main.runMainSessionTurn({
        sessionId: session.id, selectedSession: session, request: { userMessage: text, clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc", submitSource: "composer", executionOptions: captureSessionExecutionOptions(session) },
        composerOwner: owner, clearDraft: true, shouldCollapseActionDock: false,
        selectedSessionRunState: session.runState, blockedReason: null, isReadOnly: false,
        validateWorkspace: async () => true, collapseActionDock() {}, log() {},
      });
    },
    sendAuxiliary(text: string) {
      const session = current.auxiliary.selectedSession!;
      const binding = current.auxiliary.getBinding(session.id);
      return runAuxiliarySessionSendOperationWithApi({
        activeSession: session, messageText: text, parentMessageCount: 4, updatedAt: "sending",
        executionOptions: captureSessionExecutionOptions(session),
        draftSaveQueue: binding.draftSaveQueue,
        mutationRevision: binding.mutationRevision, getCurrentSession: binding.getSession,
        applyRunningSession: createAuxiliarySessionRunningApplier({ activeSessionRef: binding.sessionRef, setActiveSession: binding.setSession, updateLiveRunState: current.setLive }),
        ...createAuxiliarySessionSendResultAppliers({ activeSessionRef: binding.sessionRef, setActiveSession: binding.setSession }),
        clearPendingLiveRun: createAuxiliarySessionPendingLiveRunClearer({ updateLiveRunState: current.setLive }),
        api,
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// @test-value v2
// kind = "contract"
// claim = "Mainのdurable受付後starting本文はcanonical到着まで会話に保持し、Auxiliaryの応答待ち本文と独立する"
// oracle = { type = "contract", ref = "Issue #801: durable queue canonical projection; docs/design/auxiliary-session.md: 送信直後の共通反映" }
// fault = "未ACK Mainを送信済み表示にする、starting receiptを表示しない、canonical arrivalで重複させる、またはAuxiliaryへ本文を混入する"
// observable = "実会話columnのmessages、ACK前後のdraft、canonical更新後の本文件数、AuxiliaryのPending"
// observation_boundary = "consumer"
// scope = "main-queue-auxiliary-send-projection"
// lifecycle = "permanent"
// impact = "利用者が受付された入力を見失うことと会話間の誤表示を防ぐ"
// distinction = "runtime/workspaceの実hookから会話列のqueue購読へ接続し、ACKとcanonical読込の順序を制御する"
// @end-test-value
test("Mainのqueue受付とAuxiliaryの送信は独立してcanonicalへ接続する", async () => {
  const view = await setup();
  try {
    const main = view.current.main.sessions[0];
    const auxiliary = view.current.auxiliary.selectedSession!;
    const mainRun = deferred<SessionTurnQueueReceipt>();
    const auxiliaryRun = deferred<AuxiliarySession>();
    let received!: Parameters<WithMateWindowApi["enqueueSessionTurn"]>[1];
    let receipt: SessionTurnQueueReceipt | null = null;
    view.api.listSessionTurnQueue = async () => receipt && receipt.state !== "completed" ? [receipt] : [];
    view.api.getSessionTurnQueueReceipt = async () => receipt;
    view.api.enqueueSessionTurn = (_id, request) => { received = request; return mainRun.promise; };
    view.api.runAuxiliarySessionTurn = () => auxiliaryRun.promise;
    let mainOperation!: ReturnType<typeof view.sendMain>;
    let auxiliaryOperation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => { mainOperation = view.sendMain("main prompt"); });
    assert.deepEqual(structuredClone(view.current.mainColumn?.messages), structuredClone(main.messages));
    assert.equal(view.registry.get({ kind: "main", id: main.id }).draft, "main prompt");
    await act(async () => {
      receipt = { sessionId: main.id, incarnationId: received.incarnationId, id: "queue-item", requestId: received.clientRequestId!, sequence: 1,
        state: "starting", captured: { request: { ...received, clientRequestId: received.clientRequestId! }, attachments: [], provider: main.provider, workspacePath: main.workspacePath },
        turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: main.updatedAt, updatedAt: main.updatedAt };
      mainRun.resolve(receipt); await mainOperation;
      view.current.main.retryRead();
    });
    await act(async () => { view.emitQueue(); });
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main prompt");
    assert.equal(view.registry.get({ kind: "main", id: main.id }).draft, "");
    await act(async () => { auxiliaryOperation = view.sendAuxiliary("auxiliary prompt"); });
    assert.deepEqual(view.current.auxiliaryColumn?.messages.at(-1), { role: "user", text: "auxiliary prompt" });
    assert.equal(view.current.auxiliaryColumn?.isRunning, true);
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main prompt");
    await act(async () => {
      const saved = { ...main, messages: [...main.messages, { role: "user" as const, text: "main prompt" }, { role: "assistant" as const, text: "main answer" }] };
      view.api.getSession = async () => saved;
      receipt = { ...receipt!, state: "completed", userMessageSeq: main.messages.length, turnId: "turn" };
      view.current.main.retryRead(); view.emitQueue();
      auxiliaryRun.resolve({ ...auxiliary, messages: [...auxiliary.messages, { role: "user", text: "auxiliary prompt" }, { role: "assistant", text: "auxiliary answer" }] });
      await auxiliaryOperation;
      view.current.setLive({ ownerSessionId: auxiliary.id, state: null });
    });
    assert.equal(view.current.mainColumn?.messages.filter((message) => message.text === "main prompt").length, 1);
    assert.equal(view.current.auxiliaryColumn?.messages.filter((message) => message.text === "auxiliary prompt").length, 1);
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main answer");
    assert.equal(view.current.auxiliaryColumn?.messages.at(-1)?.text, "auxiliary answer");
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "invariant"
// claim = "Auxiliary送信は先行取得の遅い結果と会話切替で本文を巻き戻さず、失敗時は送信前の会話と再試行可能な状態へ戻る"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
// fault = "送信時のdetail更新世代を進めず古いterminal/statusを採用するか、失敗復元をrefだけに適用してPendingを残す"
// observable = "切替後のcolumn本文、失敗結果とisRunning、再送信APIへ到達した本文"
// observation_boundary = "consumer"
// scope = "auxiliary-send-projection-races"
// lifecycle = "permanent"
// impact = "送信文の消失や別会話への混入、失敗後に再送信できない状態を防ぐ"
// distinction = "単体の世代guardではなく送信adapterによる実workspaceの更新を通じて、遅延取得と失敗復元の競合を検証する"
// @end-test-value
test("Auxiliaryは遅い取得と切替で送信文を失わず失敗後に再試行できる", async () => {
  const view = await setup();
  try {
    const initial = view.current.auxiliary.selectedSession!;
    const otherId = view.current.auxiliary.summaries.find((item) => item.id !== initial.id)!.id;
    const staleDetail = deferred<AuxiliarySession>();
    const staleStatus = deferred<Awaited<ReturnType<WithMateWindowApi["getAuxiliarySessionStatus"]>>>();
    view.api.getAuxiliarySession = () => staleDetail.promise;
    view.api.getAuxiliarySessionStatus = () => staleStatus.promise;
    const run = deferred<AuxiliarySession>();
    view.api.runAuxiliarySessionTurn = () => run.promise;
    await act(async () => { view.emit(null); });
    let operation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => { operation = view.sendAuxiliary("retry prompt"); });
    await act(async () => { view.emit(view.current.live.state); });
    await act(async () => { view.current.auxiliary.selectSession(otherId); });
    await act(async () => { view.current.auxiliary.selectSession(initial.id); });
    assert.equal(view.current.auxiliaryColumn?.messages.at(-1)?.text, "retry prompt");
    await act(async () => { staleDetail.resolve(initial); });
    assert.equal(view.current.auxiliaryColumn?.messages.at(-1)?.text, "retry prompt");
    const failure = new Error("send rejected");
    await act(async () => { run.reject(failure); await operation; });
    assert.deepEqual(await operation, { status: "error", error: failure });
    await act(async () => { staleStatus.resolve({ id: initial.id, parentSessionId: initial.parentSessionId, createdAt: initial.createdAt, status: initial.status, incarnation: "benchmark-incarnation", runState: "running" }); });
    assert.deepEqual(structuredClone(view.current.auxiliaryColumn?.messages), structuredClone(initial.messages));
    assert.equal(view.current.auxiliaryColumn?.isRunning, false);
    let retriedText = "";
    view.api.runAuxiliarySessionTurn = async (_id, request) => {
      retriedText = request.userMessage;
      return { ...initial, messages: [...initial.messages, { role: "user", text: request.userMessage }, { role: "assistant", text: "retried answer" }] };
    };
    await act(async () => { await view.sendAuxiliary("retry prompt"); });
    assert.equal(retriedText, "retry prompt");
    assert.equal(view.current.auxiliaryColumn?.messages.filter((message) => message.text === "retry prompt").length, 1);
    assert.equal(view.current.auxiliaryColumn?.messages.at(-1)?.text, "retried answer");
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "Main送信runtimeはACK待機中のdraftを保持し、受付結果不明でも同じComposer ownerの新入力を上書きしない"
// oracle = { type = "contract", ref = "Issue #801: durable ACK and uncertain acceptance" }
// fault = "runtimeがACK前にdraftを消し、旧rejectで新しいdraftを旧送信文に戻す"
// observable = "実ComposerControllerRegistryのdraft、要求開始時のIDと本文、reject後の実会話column"
// observation_boundary = "consumer"
// scope = "Main runtime rejected request and Composer owner revision"
// lifecycle = "permanent"
// impact = "遅い送信失敗が同一ownerの後続編集を失わせる"
// distinction = "controller単体では検出できないruntimeのcaptureとdurable受付待機、結果不明の接続を検証する"
// @end-test-value
test("Main runtimeの旧rejectは同じComposer ownerの新入力を上書きしない", async () => {
  const view = await setup();
  try {
    const initial = view.current.main.sessions[0];
    const owner = { kind: "main" as const, id: initial.id };
    const started = deferred<void>();
    const run = deferred<SessionTurnQueueReceipt>();
    view.api.enqueueSessionTurn = (id, request) => {
      assert.equal(id, initial.id);
      assert.equal(request.userMessage, "old prompt");
      started.resolve();
      return run.promise;
    };
    let operation!: ReturnType<typeof view.sendMain>;
    await act(async () => { operation = view.sendMain("old prompt"); await started.promise; });
    assert.equal(view.registry.capture(owner).draft, "old prompt");
    view.registry.setDraft(owner, "new draft");
    assert.equal(view.registry.capture(owner).draft, "new draft");
    await act(async () => {
      const rejected = assert.rejects(operation, /acceptance could not be confirmed/);
      run.reject(new Error("old request rejected"));
      await rejected;
    });
    assert.equal(view.registry.capture(owner).draft, "new draft");
    assert.deepEqual(structuredClone(view.current.mainColumn?.messages), structuredClone(initial.messages));
    assert.equal(view.current.mainColumn?.isRunning, false);
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryは終了通知後の新入力を旧rejectで上書きしない。Mainのqueue受付後のcanonical失敗通知とAuxiliaryのresolve失敗は送信済みuser・partial・失敗本文を保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映 / docs/manual-test-checklist.md MT-030, MT-030A" }
// fault = "Appが旧Auxiliary rejectで新入力を上書きする、またはMain canonical失敗更新やAuxiliary resolve失敗を未受付と混同して入力と本文を巻き戻す"
// observable = "実SessionWindowAppのtextarea値、送信APIの対象IDと本文、要求待機中とsettle後の対象会話のuser/assistant本文、rejectのalert"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp Main/Auxiliary rejected request and resolved Provider failure"
// lifecycle = "permanent"
// impact = "送信失敗時の後続入力消失、送信済み本文・途中応答の消失、旧入力の復活による再送を防ぐ"
// distinction = "実Appでqueue ACK後のMain canonical通知と、Auxiliary terminal通知→同一owner編集→旧rejectをtextareaと会話まで接続する。Provider実通信・永続化・OS操作は対象にしない"
// @end-test-value
test("Session Windowは旧rejectから新入力を保護し、resolveするProvider失敗の本文を保持する", { timeout: 30_000 }, async () => {
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
  // JSDOMで会話のvirtual rowを描画するためのviewport。OS/browserのlayout検証ではない。
  Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get() { return 720; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get() { return 720; } });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === "number" ? (y ?? this.scrollTop) : (options?.top ?? this.scrollTop);
  };
  let api!: WithMateWindowApi;
  runInNewContext(readFileSync(new URL("../../scripts/benchmarks/benchmark-composer-input-preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_key: string, value: WithMateWindowApi) => { api = value; } } }),
    process: { argv: ["--benchmark-auxiliary-count=1"] }, Buffer,
  });
  const initialMain = await api.getSession("benchmark-main");
  const initialAuxiliary = await api.getAuxiliarySession("benchmark-aux-1");
  assert.ok(initialMain);
  assert.ok(initialAuxiliary);
  let main = initialMain;
  let auxiliary = initialAuxiliary;
  api.getSession = async (id) => id === main.id ? main : null;
  api.getAuxiliarySession = async (id) => id === auxiliary.id ? auxiliary : null;
  const liveListeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]>();
  api.subscribeLiveSessionRun = (listener) => {
    liveListeners.add(listener);
    return () => { liveListeners.delete(listener); };
  };
  const emitTerminal = (id: string) => liveListeners.forEach((listener) => listener(id, null));
  let mainInvalidation: Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0] | undefined;
  api.subscribeSessionInvalidation = (listener) => { mainInvalidation = listener; return () => { mainInvalidation = undefined; }; };
  const notifyMain = () => mainInvalidation?.({ scope: "ids", sessionIds: [main.id] });
  let reportedError = deferred<string>();
  const alerts: string[] = [];
  dom.window.alert = (message) => { alerts.push(String(message)); reportedError.resolve(String(message)); };
  Object.defineProperty(dom.window, "withmate", { value: api });
  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("../../src/app/SessionWindowApp.js");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const textarea = () => {
    const element = dom.window.document.querySelector<HTMLTextAreaElement>('textarea[data-shortcut-scope="composer"]');
    assert.ok(element);
    return element;
  };
  const input = async (text: string) => {
    assert.equal(textarea().disabled, false);
    await act(async () => {
      const element = textarea();
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, text);
      element.setSelectionRange(text.length, text.length);
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(textarea().value, text);
  };
  const send = () => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(".composer-control-row .session-send-button");
    assert.ok(button);
    assert.equal(button.disabled, false);
    button.click();
  };
  const messageTexts = (pane: string, role: "user" | "assistant") =>
    Array.from(dom.window.document.querySelectorAll(`${pane} .message-row.${role} .rich-text`))
      .map((element) => element.textContent ?? "");
  try {
    await act(async () => { root.render(<App />); });
    for (const target of ["Main", "Auxiliary"] as const) {
      if (target === "Auxiliary") {
        const opener = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Open Auxiliary"]');
        assert.ok(opener);
        await act(async () => { opener.click(); });
        const switcher = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>(".concurrent-chat-target-dock button"))
          .find((button) => button.textContent === target);
        assert.ok(switcher);
        await act(async () => { switcher.click(); });
      }
      const id = target === "Main" ? main.id : auxiliary.id;
      const pane = target === "Main" ? "#session-main-chat-pane" : "#session-auxiliary-chat-pane";
      const outcomes = target === "Main" ? ["provider-error"] as const : ["reject", "provider-error"] as const;
      for (const outcome of outcomes) {
        const prompt = `${target} ${outcome} prompt`;
        const newInput = `${target} next draft`;
        const partial = `${target} partial answer`;
        const failureNotice = `${target} provider execution failed`;
        const started = deferred<void>();
        const auxiliaryResult = deferred<AuxiliarySession>();
        const requests: Array<{ id: string; text: string }> = [];
        api.enqueueSessionTurn = async (sessionId, request) => {
          requests.push({ id: sessionId, text: request.userMessage });
          main = { ...main, status: "running", runState: "running", messages: [...main.messages, { role: "user", text: request.userMessage }] };
          notifyMain();
          started.resolve();
          return { sessionId, incarnationId: request.incarnationId, id: request.clientRequestId!, requestId: request.clientRequestId!, sequence: 1, state: "running",
            captured: { request: { ...request, clientRequestId: request.clientRequestId! }, attachments: [], provider: main.provider, workspacePath: main.workspacePath },
            turnId: "turn", userMessageSeq: main.messages.length - 1, reason: null, releasedAt: null, createdAt: main.updatedAt, updatedAt: main.updatedAt };
        };
        api.runAuxiliarySessionTurn = (sessionId, request) => {
          requests.push({ id: sessionId, text: request.userMessage });
          started.resolve();
          return auxiliaryResult.promise;
        };
        await input(prompt);
        await act(async () => { send(); await started.promise; });
        assert.deepEqual(requests, [{ id, text: prompt }]);
        assert.equal(textarea().value, "");
        assert.equal(messageTexts(pane, "user").filter((text) => text === prompt).length, 1);
        if (outcome === "reject") {
          assert.equal(textarea().disabled, true, "running input is blocked until the terminal notification");
          await act(async () => { emitTerminal(id); });
          await input(newInput);
          reportedError = deferred<string>();
          const error = new Error(`${target} request rejected`);
          await act(async () => {
            auxiliaryResult.reject(error);
            assert.equal(await reportedError.promise, error.message);
          });
          assert.equal(textarea().value, newInput, `${target}: old rejection must not restore over a later edit`);
          assert.equal(messageTexts(pane, "user").includes(prompt), false, "rejected request converges to the pre-send session");
        } else {
          await act(async () => {
            if (target === "Main") {
              main = { ...main, status: "idle", runState: "error", messages: [
                ...main.messages, { role: "assistant", text: `${partial}\n\n${failureNotice}` },
              ] };
              notifyMain();
            } else {
              auxiliary = { ...auxiliary, runState: "error", composerDraft: "", messages: [
                ...auxiliary.messages, { role: "user", text: prompt }, { role: "assistant", text: `${partial}\n\n${failureNotice}` },
              ] };
              auxiliaryResult.resolve(auxiliary);
            }
          });
          const assertFailedBody = () => {
            assert.equal(messageTexts(pane, "user").filter((text) => text === prompt).length, 1);
            const answers = messageTexts(pane, "assistant");
            assert.equal(answers.filter((text) => text.includes(partial)).length, 1);
            assert.equal(answers.filter((text) => text.includes(failureNotice)).length, 1);
            assert.equal(textarea().value, "", `${target}: resolved Provider failure must not restore the sent draft`);
          };
          assertFailedBody();
          await act(async () => { emitTerminal(id); });
          assertFailedBody();
        }
      }
    }
    assert.deepEqual(alerts, ["Auxiliary request rejected"]);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
