import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
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
      session: main.sessions[0] ?? null, baseProps, enabled: true,
      liveRun: live.ownerSessionId === "benchmark-main" ? live.state : null,
    });
    const auxiliaryColumn = useConversationMessageColumn({
      session: auxiliary.selectedSession, baseProps, enabled: true, messageSourceKind: "auxiliary",
      liveRun: live.ownerSessionId === auxiliary.selectedId ? live.state : null,
    });
    return { main, auxiliary, live, setLive, mainColumn, auxiliaryColumn };
  }
  function View() { current = Probe(); return null; }
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(<View />); });
  return {
    api, registry,
    get current() { return current; },
    emit(state: OwnedLiveSessionRunState["state"]) { listener?.(current.auxiliary.selectedId!, state); },
    sendMain(text: string) {
      const session = current.main.sessions[0];
      const owner = { kind: "main" as const, id: session.id };
      registry.setDraft(owner, text);
      return current.main.runMainSessionTurn({
        sessionId: session.id, selectedSession: session, request: { userMessage: text, submitSource: "composer" },
        composerOwner: owner, clearDraft: true, shouldCollapseActionDock: false, isCentralPreviewActive: false,
        hasLiveRun: false, selectedSessionRunState: session.runState, blockedReason: null, isReadOnly: false,
        currentTimestamp: "sending", validateWorkspace: async () => true,
        liveRun: { getRevision: () => 0, setState: current.setLive },
        acknowledgePreviewChatMessageCount() {}, collapseActionDock() {}, log() {},
      });
    },
    sendAuxiliary(text: string) {
      const session = current.auxiliary.selectedSession!;
      const binding = current.auxiliary.getBinding(session.id);
      return runAuxiliarySessionSendOperationWithApi({
        activeSession: session, messageText: text, parentMessageCount: 4, updatedAt: "sending",
        draftSaveQueue: binding.draftSaveQueue, sessionSaveQueue: binding.sessionSaveQueue,
        mutationRevision: binding.mutationRevision, getCurrentSession: binding.getSession,
        applyRunningSession: createAuxiliarySessionRunningApplier({ setActiveSession: binding.setSession, updateLiveRunState: current.setLive }),
        ...createAuxiliarySessionSendResultAppliers({ setActiveSession: binding.setSession }),
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
// claim = "MainとAuxiliaryはProvider応答を待たず送信文とPendingを会話列へ反映し、完了結果で送信文を重複させない"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md: 送信直後の共通反映" }
// fault = "refだけを変更して状態ownerの通知を省略し、Pendingだけが表示されるか確定時に送信文が二重になる"
// observable = "実会話columnのmessagesとisRunning、更新ownerから返る確定本文"
// observation_boundary = "consumer"
// scope = "main-auxiliary-send-projection"
// lifecycle = "permanent"
// impact = "利用者が送信内容を確認できず、重複送信や応答との対応誤認を招く"
// distinction = "状態setterをstub化せずruntime/workspaceの実hookと送信operationから表示projectionまでを接続し、保留したAPI応答より前を観測する"
// @end-test-value
test("MainとAuxiliaryは応答待ちの間から送信文を会話列へ表示する", async () => {
  const view = await setup();
  try {
    const main = view.current.main.sessions[0];
    const auxiliary = view.current.auxiliary.selectedSession!;
    const mainRun = deferred<typeof main>();
    const auxiliaryRun = deferred<AuxiliarySession>();
    view.api.runSessionTurn = () => mainRun.promise;
    view.api.runAuxiliarySessionTurn = () => auxiliaryRun.promise;
    let mainOperation!: ReturnType<typeof view.sendMain>;
    let auxiliaryOperation!: ReturnType<typeof view.sendAuxiliary>;
    await act(async () => { mainOperation = view.sendMain("main prompt"); });
    assert.deepEqual(view.current.mainColumn?.messages.at(-1), { role: "user", text: "main prompt" });
    assert.equal(view.current.mainColumn?.isRunning, true);
    assert.deepEqual(structuredClone(view.current.auxiliaryColumn?.messages), structuredClone(auxiliary.messages));
    await act(async () => { auxiliaryOperation = view.sendAuxiliary("auxiliary prompt"); });
    assert.deepEqual(view.current.auxiliaryColumn?.messages.at(-1), { role: "user", text: "auxiliary prompt" });
    assert.equal(view.current.auxiliaryColumn?.isRunning, true);
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main prompt");
    await act(async () => {
      mainRun.resolve({ ...main, messages: [...main.messages, { role: "user", text: "main prompt" }, { role: "assistant", text: "main answer" }] });
      auxiliaryRun.resolve({ ...auxiliary, messages: [...auxiliary.messages, { role: "user", text: "auxiliary prompt" }, { role: "assistant", text: "auxiliary answer" }] });
      await Promise.all([mainOperation, auxiliaryOperation]);
      view.current.setLive({ ownerSessionId: auxiliary.id, state: null });
    });
    assert.equal(view.current.mainColumn?.messages.filter((message) => message.text === "main prompt").length, 1);
    assert.equal(view.current.auxiliaryColumn?.messages.filter((message) => message.text === "auxiliary prompt").length, 1);
    assert.equal(view.current.mainColumn?.messages.at(-1)?.text, "main answer");
    assert.equal(view.current.auxiliaryColumn?.messages.at(-1)?.text, "auxiliary answer");
    assert.equal(view.current.auxiliaryColumn?.isRunning, false);
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
