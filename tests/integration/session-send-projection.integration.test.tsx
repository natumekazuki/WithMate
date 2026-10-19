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
import { useAuxiliaryDraftPersistence } from "../../src/chat/auxiliary/use-auxiliary-draft-persistence.js";
import type { AuxiliaryDraftRecord } from "../../src-shared/auxiliary/auxiliary-draft-contract.js";

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
  const drafts = new Map<string, AuxiliaryDraftRecord>();
  api.getAuxiliaryDraft = async (id) => {
    if (drafts.has(id)) return drafts.get(id)!;
    const session = await api.getAuxiliarySession(id);
    if (!session) return null;
    const record = { auxiliarySessionId: id, parentSessionId: session.parentSessionId, incarnation: session.createdAt, durableRevision: 0, text: session.composerDraft, updatedAt: session.updatedAt };
    drafts.set(id, record);
    return record;
  };
  api.getAuxiliarySessionStatus = async (id) => {
    const session = await api.getAuxiliarySession(id);
    return session ? { id, parentSessionId: session.parentSessionId, status: session.status, createdAt: session.createdAt, incarnation: session.createdAt, runState: session.runState } : null;
  };
  api.saveAuxiliaryDraft = async (request) => {
    const current = drafts.get(request.auxiliarySessionId);
    if (!current || current.incarnation !== request.incarnation || current.durableRevision !== request.expectedDurableRevision) return { outcome: "stale" };
    const record = { ...current, text: request.text, durableRevision: current.durableRevision + 1, updatedAt: request.updatedAt };
    drafts.set(record.auxiliarySessionId, record);
    return { outcome: "saved", ack: record };
  };
  let listener: Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0] | undefined;
  const queueListeners = new Set<(id: string) => void>();
  api.onSessionTurnQueueChanged = (next) => { queueListeners.add(next); return () => { queueListeners.delete(next); }; };
  api.subscribeLiveSessionRun = (next) => { listener = next; return () => { listener = undefined; }; };
  const baseProps = createStaticTextConversationMessageColumnProps({
    sessionId: "benchmark-main", characterId: "character", characterName: "Mate", characterIconPath: "",
    messages: [], messageListRef: React.createRef(), isRunning: false,
  });
  let current!: ReturnType<typeof Probe>;
  function Probe() {
    const main = useMainSessionRuntime({ api, selectedId: "benchmark-main", composerRegistry: registry });
    const auxiliary = useAuxiliaryWorkspace({ api, parentSessionId: "benchmark-main" });
    const persistence = useAuxiliaryDraftPersistence({ api, composerRegistry: registry, touchRecency: auxiliary.touchRecency, isFrozen: () => registry.isFrozen });
    const [live, setLive] = useState<OwnedLiveSessionRunState>({ ownerSessionId: null, state: null });
    const mainColumn = useConversationMessageColumn({
      session: main.sessions[0] ?? null, baseProps, enabled: true, api,
      liveRun: live.ownerSessionId === "benchmark-main" ? live.state : null,
    });
    const auxiliaryColumn = useConversationMessageColumn({
      session: auxiliary.selectedSession ? { ...auxiliary.selectedSession, incarnationId: auxiliary.selectedSession.createdAt } : null, baseProps, enabled: true, api, messageSourceKind: "auxiliary",
      liveRun: live.ownerSessionId === auxiliary.selectedId ? live.state : null,
    });
    return { main, auxiliary, persistence, live, setLive, mainColumn, auxiliaryColumn };
  }
  function View() { current = Probe(); return null; }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(<View />); });
  return {
    api, registry,
    get current() { return current; },
    emit(state: OwnedLiveSessionRunState["state"]) { listener?.(current.auxiliary.selectedId!, state); },
    emitQueue(id = "benchmark-main") { queueListeners.forEach((listener) => listener(id)); },
    sendMain(text: string) {
      const session = current.main.sessions[0];
      const owner = { kind: "main" as const, id: session.id };
      registry.setDraft(owner, text);
      return current.main.runMainSessionTurn({
        sessionId: session.id, selectedSession: session, request: { userMessage: text, clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bc", submitSource: "composer", executionOptions: captureSessionExecutionOptions(session) },
        composerOwner: owner, clearDraft: true, queueTurn: true, shouldCollapseActionDock: false,
        selectedSessionRunState: session.runState, blockedReason: null, isReadOnly: false,
        validateWorkspace: async () => true, collapseActionDock() {}, log() {},
      });
    },
    async sendAuxiliary(text: string) {
      const session = current.auxiliary.selectedSession!;
      const owner = { kind: "auxiliary" as const, id: session.id };
      registry.setDraft(owner, text);
      const draftOwner = current.persistence.getOwner(session)!;
      const saving = draftOwner.enqueue(text);
      await draftOwner.flush(); await saving;
      return current.main.runMainSessionTurn({
        sessionId: session.id, selectedSession: { ...current.main.sessions[0], id: session.id, incarnationId: session.createdAt },
        request: { userMessage: text, clientRequestId: "7c26d875-9117-4ad5-97b5-e9af775b94bd", submitSource: "composer", executionOptions: captureSessionExecutionOptions(session), displayAnchorParentMessageCount: 4 },
        composerOwner: owner, auxiliaryDraftOwner: draftOwner, queueTurn: true, clearDraft: true, shouldCollapseActionDock: false,
        selectedSessionRunState: session.runState, blockedReason: null, isReadOnly: false,
        validateWorkspace: async () => true, collapseActionDock() {}, log() {},
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
// claim = "MainとAuxiliaryのdurable受付はACK前のdraftを保持し、starting receiptを独立投影してcanonical到着後も本文・Bookmark・後続実行設定を維持する"
// oracle = { type = "contract", ref = "Issue #801: common durable admission and canonical queue projection; docs/features/message-bookmark-filter.md" }
// fault = "未ACK本文を送信済みにする、owner間でqueueを混ぜる、canonical更新で本文を重複させる、または後続Bookmark/実行設定を旧snapshotで戻す"
// observable = "両columnのmessages、ACK前後draft、canonical本文件数とBookmark、Auxiliaryのmodel選択"
// observation_boundary = "consumer"
// scope = "main-auxiliary-durable-queue-projection"
// lifecycle = "permanent"
// impact = "受付本文の消失・重複・会話混入とBookmarkの巻戻りを防ぐ"
// distinction = "実runtime/workspace/queue購読hookへ接続してACKとcanonicalの順序を検証する"
// @end-test-value
test("MainとAuxiliaryのqueue受付は独立してcanonicalへ接続する", async () => {
  const view = await setup();
  try {
    const main = view.current.main.sessions[0];
    const auxiliary = view.current.auxiliary.selectedSession!;
    const receipts = new Map<string, SessionTurnQueueReceipt>();
    const runs = new Map<string, ReturnType<typeof deferred<SessionTurnQueueReceipt>>>();
    const requests = new Map<string, Parameters<WithMateWindowApi["enqueueSessionTurn"]>[1]>();
    view.api.listSessionTurnQueue = async (id) => receipts.has(id) && receipts.get(id)!.state !== "completed" ? [receipts.get(id)!] : [];
    view.api.getSessionTurnQueueReceipt = async (id) => receipts.get(id) ?? null;
    view.api.enqueueSessionTurn = (id, request) => {
      requests.set(id, request);
      const pending = deferred<SessionTurnQueueReceipt>(); runs.set(id, pending);
      return pending.promise;
    };
    let mainOperation!: ReturnType<typeof view.sendMain>;
    let auxiliaryOperation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => {
      mainOperation = view.sendMain("main prompt");
      auxiliaryOperation = view.sendAuxiliary("auxiliary prompt");
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(structuredClone(view.current.mainColumn?.messages), structuredClone(main.messages));
    assert.deepEqual(structuredClone(view.current.auxiliaryColumn?.messages), structuredClone(auxiliary.messages));
    assert.equal(view.registry.get({ kind: "main", id: main.id }).draft, "main prompt");
    assert.equal(view.registry.get({ kind: "auxiliary", id: auxiliary.id }).draft, "auxiliary prompt");
    await act(async () => {
      for (const [id, request] of requests) {
        const receipt: SessionTurnQueueReceipt = { sessionId: id, incarnationId: request.incarnationId, id: id + "-queue", requestId: request.clientRequestId!, sequence: 1,
          state: "starting", captured: { request: { ...request, clientRequestId: request.clientRequestId! }, attachments: [], provider: main.provider, workspacePath: main.workspacePath },
          turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: main.updatedAt, updatedAt: main.updatedAt };
        receipts.set(id, receipt); runs.get(id)!.resolve(receipt);
      }
      await Promise.all([mainOperation, auxiliaryOperation]);
      view.emitQueue(main.id); view.emitQueue(auxiliary.id);
    });
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main prompt");
    assert.equal(view.current.auxiliaryColumn?.messages.at(-1)?.text, "auxiliary prompt");
    assert.equal(view.registry.get({ kind: "main", id: main.id }).draft, "");
    assert.equal(view.registry.get({ kind: "auxiliary", id: auxiliary.id }).draft, "");
    const bookmarked = { role: "assistant" as const, text: "bookmarked before", isBookmarked: true };
    const canonicalAuxiliary = deferred<AuxiliarySession>();
    await act(async () => {
      const savedMain = { ...main, messages: [bookmarked, ...main.messages, { role: "user" as const, text: "main prompt" }, { role: "assistant" as const, text: "main answer" }] };
      view.api.getSession = async () => savedMain;
      view.current.main.retryRead();
      view.current.auxiliary.getBinding(auxiliary.id).setExecutionSelection({ ...auxiliary, model: "model-c" });
      view.api.getAuxiliarySession = () => canonicalAuxiliary.promise;
      view.emit(null);
      view.current.auxiliary.getBinding(auxiliary.id).setMessageBookmark(0, true);
      canonicalAuxiliary.resolve({ ...auxiliary, messages: [...auxiliary.messages, { role: "user", text: "auxiliary prompt" }, { role: "assistant", text: "auxiliary answer" }] });
      for (const [id, receipt] of receipts) receipts.set(id, { ...receipt, state: "completed", userMessageSeq: id === main.id ? main.messages.length + 1 : auxiliary.messages.length, turnId: id + "-turn" });
      view.emitQueue(main.id); view.emitQueue(auxiliary.id);
    });
    for (const [column, prompt, answer] of [
      [view.current.mainColumn, "main prompt", "main answer"],
      [view.current.auxiliaryColumn, "auxiliary prompt", "auxiliary answer"],
    ] as const) {
      assert.equal(column?.messages.filter((message) => message.text === prompt).length, 1);
      assert.equal(column?.messages.at(-1)?.text, answer);
    }
    assert.equal(view.current.mainColumn?.messages.find((message) => message.text === bookmarked.text)?.isBookmarked, true);
    assert.equal(view.current.auxiliaryColumn?.messages[0]?.isBookmarked, true);
    assert.equal(view.current.auxiliary.selectedSession?.model, "model-c");
  } finally { await view.unmount(); }
});

// @test-value v2
// kind = "contract"
// claim = "Auxiliaryの受付不明は会話切替後も元要求を保持し、元ownerの新draftを保護しながら同IDで受付とqueue投影を回復する"
// oracle = { type = "contract", ref = "Issue #801: uncertain acceptance identity and auxiliary draft ownership" }
// fault = "切替で不明受付を忘れる、新IDで再送する、別会話へ反映する、または後続draftを消す"
// observable = "対象別uncertain状態、再試行request列、元owner draft、回復後column本文"
// observation_boundary = "consumer"
// scope = "auxiliary-durable-acceptance-races"
// lifecycle = "permanent"
// impact = "結果不明時の二重実行と入力消失を防ぐ"
// distinction = "acceptance class単体と異なり実workspace切替とqueue購読まで検証する"
// @end-test-value
test("Auxiliaryは切替後も不明受付の元IDと新draftを保護して回復する", async () => {
  const view = await setup();
  try {
    const initial = view.current.auxiliary.selectedSession!;
    const otherId = view.current.auxiliary.summaries.find((item) => item.id !== initial.id)!.id;
    const run = deferred<SessionTurnQueueReceipt>();
    const started = deferred<void>();
    const requests: Parameters<WithMateWindowApi["enqueueSessionTurn"]>[1][] = [];
    let receipt: SessionTurnQueueReceipt | null = null;
    view.api.listSessionTurnQueue = async (id) => id === initial.id && receipt ? [receipt] : [];
    view.api.getSessionTurnQueueReceipt = async () => null;
    view.api.enqueueSessionTurn = (_id, request) => { requests.push(request); started.resolve(); return run.promise; };
    let operation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => { operation = view.sendAuxiliary("retry prompt"); await started.promise; });
    assert.deepEqual(structuredClone(view.current.auxiliaryColumn?.messages), structuredClone(initial.messages));
    await act(async () => { view.current.auxiliary.selectSession(otherId); });
    await act(async () => {
      const rejected = assert.rejects(operation, /acceptance could not be confirmed/);
      run.reject(new Error("disconnected")); await rejected;
    });
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), true);
    assert.equal(view.current.main.hasUncertainTurnFor(otherId), false);
    await act(async () => { view.current.auxiliary.selectSession(initial.id); });
    await act(async () => { await view.current.persistence.changeDraft(initial, "new draft", 9); });
    const original = requests[0];
    view.api.enqueueSessionTurn = async (_id, request) => {
      requests.push(request);
      receipt = { sessionId: initial.id, incarnationId: original.incarnationId, id: "aux-queue", requestId: original.clientRequestId!, sequence: 1,
        state: "starting", captured: { request: { ...request, clientRequestId: request.clientRequestId! }, attachments: [], provider: initial.provider, workspacePath: "workspace" },
        turnId: null, userMessageSeq: null, reason: null, releasedAt: null, createdAt: initial.updatedAt, updatedAt: initial.updatedAt };
      return receipt;
    };
    await act(async () => { await view.current.main.retryOriginalTurn(initial.id); view.emitQueue(initial.id); });
    assert.deepEqual(requests, [original, original]);
    assert.equal(view.current.main.hasUncertainTurnFor(initial.id), false);
    assert.equal(view.registry.get({ kind: "auxiliary", id: initial.id }).draft, "new draft");
    assert.equal(view.current.auxiliaryColumn?.messages.filter((message) => message.text === "retry prompt").length, 1);
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
// claim = "Main/Auxiliary共通durable受付は旧rejectで新入力を上書きせず、Auxiliaryの未確定受付では送信本文を先行表示し、不明・拒否では本文と理由を保持する。受付後のcanonical失敗通知は送信済みuser・partial・失敗本文を保持する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信受付の共通反映" }
// fault = "Appが旧受付rejectで新入力を上書きする、先行表示した送信本文を不明・拒否で消すか理由を示さない、またはcanonical失敗更新を未受付と混同して入力と本文を巻き戻す"
// observable = "実SessionWindowAppのtextarea値、送信APIの対象IDと本文、要求待機中とsettle後の対象会話のuser/assistant本文数、送信bubbleのエラー理由、rejectのalert"
// observation_boundary = "component-behavior"
// scope = "SessionWindowApp common durable admission and canonical Provider failure"
// lifecycle = "permanent"
// impact = "送信失敗時の後続入力消失、送信済み本文・途中応答の消失、旧入力の復活による再送を防ぐ"
// distinction = "実AppのMain/Auxiliary両Sendからdurable ACKとcanonical通知、および同一owner編集後の旧rejectをtextareaと会話まで接続する。Provider実通信・永続化・OS操作は対象にしない"
// @end-test-value
test("Session Windowはdurable受付の旧rejectから新入力を保護し、canonical Provider失敗の本文を保持する", { timeout: 30_000 }, async () => {
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
  let auxiliaryDraft: AuxiliaryDraftRecord = { auxiliarySessionId: auxiliary.id, parentSessionId: auxiliary.parentSessionId, incarnation: auxiliary.createdAt, durableRevision: 0, text: auxiliary.composerDraft, updatedAt: auxiliary.updatedAt };
  api.getSession = async (id) => id === main.id ? main : null;
  api.getAuxiliarySession = async (id) => id === auxiliary.id ? auxiliary : null;
  api.getAuxiliarySessionStatus = async () => ({ id: auxiliary.id, parentSessionId: auxiliary.parentSessionId, status: auxiliary.status, createdAt: auxiliary.createdAt, incarnation: auxiliary.createdAt, runState: auxiliary.runState });
  api.getAuxiliaryDraft = async () => ({ ...auxiliaryDraft });
  api.saveAuxiliaryDraft = async (request) => {
    if (request.expectedDurableRevision !== auxiliaryDraft.durableRevision || request.incarnation !== auxiliaryDraft.incarnation) return { outcome: "stale" };
    auxiliaryDraft = { ...auxiliaryDraft, text: request.text, durableRevision: auxiliaryDraft.durableRevision + 1, updatedAt: request.updatedAt };
    return { outcome: "saved", ack: auxiliaryDraft };
  };
  const receipts = new Map<string, SessionTurnQueueReceipt>();
  api.getSessionTurnQueueReceipt = async () => null;
  api.listSessionTurnQueue = async (id) => receipts.has(id) ? [receipts.get(id)!] : [];
  const queueListeners = new Set<(id: string) => void>();
  api.onSessionTurnQueueChanged = (listener) => { queueListeners.add(listener); return () => { queueListeners.delete(listener); }; };
  const notifyQueue = (id: string) => queueListeners.forEach((listener) => listener(id));
  const liveListeners = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRun"]>[0]>();
  api.subscribeLiveSessionRun = (listener) => {
    liveListeners.add(listener);
    return () => { liveListeners.delete(listener); };
  };
  const emitTerminal = (id: string) => liveListeners.forEach((listener) => listener(id, null));
  const invalidationListeners = new Set<{ listener: Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0] }>();
  api.subscribeSessionInvalidation = (listener) => {
    const registration = { listener };
    invalidationListeners.add(registration);
    return () => { invalidationListeners.delete(registration); };
  };
  const notifyMain = () => invalidationListeners.forEach(({ listener }) => listener({ scope: "ids", sessionIds: [main.id] }));
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
        const result = deferred<SessionTurnQueueReceipt>();
        const requests: Array<{ id: string; text: string }> = [];
        api.enqueueSessionTurn = async (sessionId, request) => {
          requests.push({ id: sessionId, text: request.userMessage });
          started.resolve();
          if (outcome === "reject") return result.promise;
          if (target === "Main") {
            main = { ...main, status: "running", runState: "running", messages: [...main.messages, { role: "user", text: request.userMessage }] };
            notifyMain();
          } else {
            assert.equal(request.auxiliaryDraftIncarnation, auxiliaryDraft.incarnation);
            assert.equal(request.auxiliaryDraftDurableRevision, auxiliaryDraft.durableRevision);
            auxiliaryDraft = { ...auxiliaryDraft, text: "", durableRevision: auxiliaryDraft.durableRevision + 1 };
            auxiliary = { ...auxiliary, runState: "running", messages: [...auxiliary.messages, { role: "user", text: request.userMessage }] };
            emitTerminal(id);
          }
          const receipt: SessionTurnQueueReceipt = { sessionId, incarnationId: request.incarnationId, id: request.clientRequestId!, requestId: request.clientRequestId!, sequence: 1, state: "running",
            captured: { request: { ...request, clientRequestId: request.clientRequestId! }, attachments: [], provider: main.provider, workspacePath: main.workspacePath },
            turnId: "turn", userMessageSeq: (target === "Main" ? main : auxiliary).messages.length - 1, reason: null, releasedAt: null, createdAt: main.updatedAt, updatedAt: main.updatedAt };
          receipts.set(id, receipt); notifyQueue(id);
          return receipt;
        };
        await input(prompt);
        await act(async () => { send(); await started.promise; });
        assert.deepEqual(requests, [{ id, text: prompt }]);
        if (outcome === "reject") {
          assert.equal(textarea().value, prompt, "unacknowledged input remains in the composer");
          assert.equal(messageTexts(pane, "user").filter((text) => text === prompt).length, 1, "unacknowledged submission is shown once before admission completes");
          await input(newInput);
          const error = new Error(`${target} request rejected`);
          await act(async () => { result.reject(error); });
          assert.equal(textarea().value, newInput, `${target}: old rejection must not restore over a later edit`);
          assert.equal(messageTexts(pane, "user").filter((text) => text === prompt).length, 1, "uncertain admission retains the submitted bubble");
          assert.match(dom.window.document.querySelector(`${pane} .pending-run-error-note`)?.textContent ?? "", /acceptance could not be confirmed/);
          api.enqueueSessionTurn = async () => ({ state: "rejected", reason: "Original turn was not accepted." });
          reportedError = deferred<string>();
          await act(async () => {
            const retry = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Retry Original Turn");
            assert.ok(retry); retry.click(); await reportedError.promise;
          });
          assert.equal(textarea().value, newInput);
          assert.equal(messageTexts(pane, "user").filter((text) => text === prompt).length, 1, "explicit rejection retains the submitted bubble without duplication");
          assert.equal(dom.window.document.querySelector(`${pane} .pending-run-error-note`)?.textContent, "Original turn was not accepted.");
        } else {
          assert.equal(textarea().value, "");
          assert.equal(messageTexts(pane, "user").filter((text) => text === prompt).length, 1);
          await act(async () => {
            if (target === "Main") {
              main = { ...main, status: "idle", runState: "error", messages: [
                ...main.messages, { role: "assistant", text: `${partial}\n\n${failureNotice}` },
              ] };
              notifyMain();
            } else {
              auxiliary = { ...auxiliary, runState: "error", composerDraft: "", messages: [
                ...auxiliary.messages, { role: "assistant", text: `${partial}\n\n${failureNotice}` },
              ] };
              emitTerminal(id);
            }
            receipts.set(id, { ...receipts.get(id)!, state: "failed", reason: failureNotice }); notifyQueue(id);
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
    assert.deepEqual(alerts, ["Original turn was not accepted."]);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
