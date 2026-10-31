import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import { buildNewSession, type MessageArtifact } from "../../src-shared/session/session-state.js";
import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import { SessionContextFeature } from "../../src/chat/runtime/session-context-feature.js";

const noop = () => {};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// @test-value v2
// kind = "invariant"
// claim = "Latest Commandは同ownerの再取得中・失敗時も取得済みcommandと詳細を保持し、errorとRetryを表示し、新turnでは旧commandを表示しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 表示言語・操作・状態 / Latest Command" }
// fault = "通知・Session revision・Retryで取得済みturnかartifactを消す、保持したcommandでerror/Retryを隠す、または新turnへ旧commandを持ち越す"
// observable = "実ContextFeatureのcommand・Command Details・busy/status・alert・Retryと新turnへの表示切替"
// observation_boundary = "consumer"
// scope = "latest-command-same-owner-refresh-and-recovery"
// lifecycle = "permanent"
// impact = "一時読取障害だけで既知の実行結果と回復導線を失い、旧結果を新turnの結果と誤認する"
// distinction = "同期projectionやowner切替testでは再取得状態との共存、live/Sessionで新turnを認識した後の読取障害を観測できない。短いdeferred API応答で実feature境界を検証する"
// @end-test-value
test("ContextFeature retains acquired commands through refresh failures and exposes Retry", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previous = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; }, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let session = buildNewSession({ id: "main", provider: "codex", taskTitle: "Context test", workspaceLabel: "fixture", workspacePath: "C:/fixture", branch: "main", characterId: "fixture-character", character: "Fixture", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "never" });
  let turn: SessionTurnRecord = { id: 1, sessionId: session.id, phase: "completed", createdAt: "now", provider: "codex", model: "model", reasoningEffort: "medium", approvalMode: "never", threadId: "thread", errorMessage: "", assistantMessageSeq: 3 };
  let nextTurn: ReturnType<typeof deferred<SessionTurnRecord | null>> | null = null;
  let latestLoadError: Error | null = null;
  let nextArtifact: ReturnType<typeof deferred<MessageArtifact | null>> | null = null;
  const saved: MessageArtifact = { title: "Result", runChecks: [], activitySummary: [], changedFiles: [], operationTimeline: [{ type: "command_execution", summary: "npm test", status: "completed", details: "acquired output", exitCode: 0 }] };
  const listeners = new Set<(id: string) => void>();
  const liveListeners = new Set<(id: string, state: LiveSessionRunState | null) => void>();
  let running = false;
  const api = {
    getLiveSessionRun: async () => null,
    subscribeLiveSessionRun: (listener: (id: string, state: LiveSessionRunState | null) => void) => { liveListeners.add(listener); return () => liveListeners.delete(listener); },
    getLatestSessionTurn: async () => { if (latestLoadError) throw latestLoadError; const pending = nextTurn; nextTurn = null; return pending ? pending.promise : turn; },
    onSessionTurnUpdated: (listener: (id: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSessionMessageArtifact: async () => { const pending = nextArtifact; nextArtifact = null; return pending ? pending.promise : saved; },
    getProviderQuotaTelemetry: async () => null,
    subscribeProviderQuotaTelemetry: () => noop,
    getSessionContextTelemetry: async () => null,
    subscribeSessionContextTelemetry: () => noop,
    subscribeSessionGlossary: () => noop,
    getSessionGlossaryProjection: async () => ({ sessionId: session.id, sequence: 1, scopeRevision: "fixture", checkout: { repositoryName: "fixture", branch: "main", pathLabel: "fixture" }, state: { status: "missing", relativePath: ".withmate/glossary.yaml", revision: null } }),
  } as unknown as WithMateWindowApi;
  const render = async () => { await act(async () => root.render(<SessionContextFeature api={api} selectedSession={session} displayedSession={session} activeRunSessionId={session.id} renderedIsRunning={running} visible availableReasoningEfforts={["medium"]} navigator={{}} onShowContextRail={noop} onAnnotationMatcherChange={noop} />)); };
  const publish = async () => { await act(async () => { for (const listener of listeners) listener(session.id); }); };
  const command = () => container.querySelector("[aria-label='Executed command']")?.textContent ?? "";
  const details = () => container.querySelector("details")?.textContent ?? "";
  const retry = async () => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Retry");
    assert.ok(button, "Retry remains available beside the acquired command");
    await act(async () => button.click());
  };
  try {
    await render();
    assert.match(command(), /npm test/);
    assert.match(details(), /Command Details.*acquired output/);
    for (const trigger of ["notification", "session revision"] as const) {
      const pending = deferred<SessionTurnRecord | null>();
      nextTurn = pending;
      if (trigger === "notification") await publish();
      else { session = { ...session, updatedAt: "refresh revision" }; await render(); }
      assert.match(command(), /npm test/, trigger);
      assert.match(details(), /Command Details.*acquired output/, trigger);
      assert.ok(container.querySelector("[aria-busy='true']"));
      await act(async () => pending.reject(new Error("temporary turn read failed")));
      assert.match(command(), /npm test/);
      assert.match(details(), /Command Details.*acquired output/);
      assert.match(container.querySelector("[role='alert']")!.textContent ?? "", /temporary turn read failed/);
      const retryTurn = deferred<SessionTurnRecord | null>();
      nextTurn = retryTurn;
      await retry();
      assert.match(command(), /npm test/);
      assert.match(details(), /Command Details.*acquired output/);
      await act(async () => retryTurn.resolve(turn));
      assert.equal(container.querySelector("[role='alert']"), null);
    }
    const artifactRead = deferred<MessageArtifact | null>();
    nextArtifact = artifactRead;
    await publish();
    assert.match(command(), /npm test/);
    assert.match(details(), /Command Details.*acquired output/);
    assert.ok(container.querySelector("[aria-busy='true']"));
    await act(async () => artifactRead.reject(new Error("temporary artifact read failed")));
    assert.match(command(), /npm test/);
    assert.match(details(), /Command Details.*acquired output/);
    assert.match(container.querySelector("[role='alert']")!.textContent ?? "", /temporary artifact read failed/);
    const retryArtifact = deferred<MessageArtifact | null>();
    nextArtifact = retryArtifact;
    await retry();
    assert.match(command(), /npm test/);
    assert.match(details(), /Command Details.*acquired output/);
    await act(async () => retryArtifact.resolve(saved));
    assert.equal(container.querySelector("[role='alert']"), null);
    for (const source of ["Session", "live"] as const) {
      latestLoadError = new Error("new turn start read failed");
      await act(async () => {
        if (source === "Session") running = true;
        else for (const listener of liveListeners) listener(session.id, { sessionId: session.id, threadId: "thread", runState: "running", assistantText: "", steps: [], backgroundTasks: [], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null });
        for (const listener of listeners) listener(session.id);
      });
      await render();
      assert.equal(command(), "", source);
      latestLoadError = new Error("new turn end read failed");
      await act(async () => {
        running = false;
        for (const listener of liveListeners) listener(session.id, null);
        for (const listener of listeners) listener(session.id);
      });
      await render();
      assert.equal(command(), "", source);
      assert.equal(details(), "", source);
      assert.match(container.querySelector("[role='alert']")!.textContent ?? "", /new turn end read failed/);
      turn = { ...turn, id: turn.id + 1, assistantMessageSeq: turn.assistantMessageSeq! + 1 };
      latestLoadError = null;
      await retry();
      assert.match(command(), /npm test/);
      assert.match(details(), /Command Details.*acquired output/);
      assert.equal(container.querySelector("[role='alert']"), null);
    }
    turn = { ...turn, id: turn.id + 1, phase: "running", assistantMessageSeq: undefined };
    await publish();
    assert.equal(command(), "");
    turn = { ...turn, phase: "completed", assistantMessageSeq: 4 };
    const newArtifact = deferred<MessageArtifact | null>();
    nextArtifact = newArtifact;
    await publish();
    assert.equal(command(), "");
    await act(async () => newArtifact.resolve({ ...saved, operationTimeline: [] }));
    assert.equal(command(), "");
    assert.equal(container.querySelector("[role='alert']"), null);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

// @test-value v2
// kind = "regression"
// claim = "ContextFeatureは終了後のReasoning/task保持を実行中と誤認せず最新turn操作を復元し、実行中・取消待ちでは前turnを表示しない"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: 操作履歴/Latest Command; src-electron/session/session-runtime-service.ts: runSessionTurn finally" }
// fault = "retained liveが非nullのため終了後artifactを抑止する、または復元のためReasoning/tasksを消す"
// observable = "実ContextFeatureのLatest Command status/exit/error/truncationとReasoning/Tasks、再mount後の表示、active/cancel中の保存command非表示"
// observation_boundary = "consumer"
// scope = "context-feature-terminal-retained-history"
// lifecycle = "permanent"
// impact = "正常完了・失敗・取消後に取得済み操作を読めないか、前turnの結果を実行中の結果と誤認する"
// distinction = "hookへ手動のhistory gateを渡さず実ContextFeatureのsubscriptionからterminal保持snapshotを供給する"
// @end-test-value
test("ContextFeature restores terminal history while retaining reasoning and tasks", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previous = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; }, IS_REACT_ACT_ENVIRONMENT: true });
  const container = dom.window.document.getElementById("root")!;
  let root = createRoot(container);
  let session = buildNewSession({ id: "main", provider: "copilot", taskTitle: "Context test", workspaceLabel: "fixture", workspacePath: "C:/fixture", branch: "main", characterId: "fixture-character", character: "Fixture", characterIconPath: "", characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "never" });
  let running = true;
  let live: LiveSessionRunState = { sessionId: session.id, threadId: "thread", runState: "running", assistantText: "", reasoningText: "retained reasoning", steps: [], backgroundTasks: [{ id: "task", kind: "shell", status: "running", title: "retained task", updatedAt: "now" }], usage: null, errorMessage: "", approvalRequest: null, elicitationRequest: null };
  let turn: SessionTurnRecord = { id: 1, sessionId: session.id, phase: "completed", createdAt: "now", provider: "copilot", model: "model", reasoningEffort: "medium", approvalMode: "never", threadId: "thread", errorMessage: "", assistantMessageSeq: 3 };
  let artifact: MessageArtifact = { title: "Result", runChecks: [], activitySummary: [], changedFiles: [], operationTimeline: [] };
  const liveListeners = new Set<(id: string, state: LiveSessionRunState | null) => void>();
  const turnListeners = new Set<(id: string) => void>();
  const reads: Array<[string, number]> = [];
  const api = {
    getLiveSessionRun: async () => live,
    subscribeLiveSessionRun: (listener: (id: string, state: LiveSessionRunState | null) => void) => { liveListeners.add(listener); return () => liveListeners.delete(listener); },
    getLatestSessionTurn: async () => turn,
    onSessionTurnUpdated: (listener: (id: string) => void) => { turnListeners.add(listener); return () => turnListeners.delete(listener); },
    getSessionMessageArtifact: async (id: string, seq: number) => { reads.push([id, seq]); return artifact; },
    getProviderQuotaTelemetry: async () => null,
    subscribeProviderQuotaTelemetry: () => noop,
    getSessionContextTelemetry: async () => null,
    subscribeSessionContextTelemetry: () => noop,
    subscribeSessionGlossary: () => noop,
    getSessionGlossaryProjection: async () => ({ sessionId: session.id, sequence: 1, scopeRevision: "fixture", checkout: { repositoryName: "fixture", branch: "main", pathLabel: "fixture" }, state: { status: "missing", relativePath: ".withmate/glossary.yaml", revision: null } }),
  } as unknown as WithMateWindowApi;
  const render = async () => { await act(async () => root.render(<SessionContextFeature api={api} selectedSession={session} displayedSession={session} activeRunSessionId={session.id} renderedIsRunning={running} visible availableReasoningEfforts={["medium"]} navigator={{}} onShowContextRail={noop} onAnnotationMatcherChange={noop} />)); };
  const publish = async () => { await act(async () => { for (const listener of liveListeners) listener(session.id, live); for (const listener of turnListeners) listener(session.id); }); await render(); };
  const select = async (label: string) => {
    await act(async () => container.querySelector<HTMLButtonElement>(".session-switcher-current")!.click());
    const option = [...container.querySelectorAll<HTMLButtonElement>("[role=option]")].find((item) => item.textContent === label);
    assert.ok(option, label);
    await act(async () => option.click());
  };
  const content = () => container.querySelector(".command-monitor-content")!.textContent ?? "";
  try {
    for (const phase of ["completed", "failed", "canceled"] as const) {
      running = true;
      live = { ...live, runState: "running", cancellationState: undefined, steps: [] };
      artifact = { ...artifact, operationTimeline: [{ type: "command_execution", summary: `saved-${phase}`, status: phase, details: "acquired output", exitCode: 2, error: { message: "acquired error" }, truncated: true }] };
      turn = { ...turn, id: turn.id + 1, phase, assistantMessageSeq: 3 };
      await publish();
      assert.doesNotMatch(content(), /saved-/);
      running = false;
      live = { ...live, runState: phase === "failed" ? "error" : "idle", steps: [] };
      await publish();
      assert.match(content(), new RegExp(`saved-${phase}`));
      assert.match(content(), /Exit Code: 2/);
      assert.match(content(), /acquired error/);
      assert.match(content(), /Output Truncated/);
      assert.match(content(), phase === "completed" ? /Completed/ : phase === "failed" ? /Failed/ : /Canceled/);
      await select("Reasoning");
      assert.match(content(), /retained reasoning/);
      await select("Tasks");
      assert.match(content(), /retained task/);
      await select("Latest Command");
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
      assert.match(content(), new RegExp(`saved-${phase}`));
    }
    for (const cancellationState of ["requested", "terminating"] as const) {
      live = { ...live, cancellationState, steps: [] };
      await publish();
      assert.doesNotMatch(content(), /saved-/);
      live = { ...live, steps: [{ id: "active", type: "command_execution", status: "in_progress", summary: `live-${cancellationState}` }] };
      await publish();
      assert.match(content(), new RegExp(`live-${cancellationState}`));
      assert.doesNotMatch(content(), /saved-/);
    }
    live = { ...live, cancellationState: undefined, steps: [] };
    artifact = { ...artifact, operationTimeline: [] };
    turn = { ...turn, id: turn.id + 1 };
    await publish();
    assert.doesNotMatch(content(), /saved-|live-/);
    assert.ok(reads.every(([id, seq]) => id === "main" && seq === 3));
    session = { ...session, incarnationId: "new-incarnation" };
    await render();
    assert.doesNotMatch(content(), /saved-|live-/);
    await act(async () => { for (const listener of liveListeners) listener("auxiliary", { ...live, sessionId: "auxiliary", steps: [{ id: "wrong-owner", type: "command_execution", status: "in_progress", summary: "wrong-owner-command" }] }); });
    assert.doesNotMatch(content(), /wrong-owner-command/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
