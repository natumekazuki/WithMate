import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionTurnRecord } from "../../src-shared/session/session-turn-state.js";
import type { MessageArtifact } from "../../src-shared/session/session-state.js";
import { useLatestCommandHistory, type LatestCommandHistoryApi } from "../../src/chat/runtime/use-latest-command-history.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function turn(sessionId: string, phase: SessionTurnRecord["phase"] = "completed"): SessionTurnRecord {
  return { id: 1, sessionId, phase, createdAt: "now", provider: "codex", model: "model", reasoningEffort: "medium", approvalMode: "never", threadId: "thread", errorMessage: "", assistantMessageSeq: 3 };
}

function artifact(summary: string): MessageArtifact {
  return { title: "Response", runChecks: [], activitySummary: [], changedFiles: [], operationTimeline: [{ type: "command_execution", summary, status: "failed", exitCode: 2 }] };
}

// @test-value v2
// kind = "invariant"
// claim = "Latest Commandは対象会話とincarnationの最新turnに所属するartifactだけを採用し、遅延応答・取得失敗・未記録を分離する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md: Latest Command; src-shared/ipc/withmate-window-api.ts: getLatestSessionTurn/getSessionMessageArtifact" }
// fault = "対象切替後に古いartifactを表示する、commandなしturnで古いcommandへ遡る、または読取失敗を正常空へ変換する"
// observable = "production hookが返すoperations、commandHistoryLoading、commandHistoryError、commandHistoryUnrecordedとartifact取得対象"
// observation_boundary = "consumer"
// scope = "latest-command-history-owner-and-load-state"
// lifecycle = "permanent"
// impact = "別会話・別turnの実行結果を最新として誤認し、取得障害を未記録と取り違える"
// distinction = "型checkや同期projection testでは検出できない非同期owner切替、通知更新、incarnation境界をhook実行で観測する"
// @end-test-value
test("Latest Command history isolates turn, owner, incarnation, and read states", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const pending: Array<{ sessionId: string; index: number; result: ReturnType<typeof deferred<MessageArtifact | null>> }> = [];
  let latest: SessionTurnRecord | null = turn("main");
  let loadError: Error | null = null;
  let nextRead: ReturnType<typeof deferred<SessionTurnRecord | null>> | null = null;
  const listeners = new Set<(id: string) => void>();
  const api: LatestCommandHistoryApi = {
    getLatestSessionTurn: async () => {
      if (loadError) throw loadError;
      if (nextRead) { const read = nextRead; nextRead = null; return read.promise; }
      return latest;
    },
    onSessionTurnUpdated: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSessionMessageArtifact: (sessionId, index) => {
      const result = deferred<MessageArtifact | null>();
      pending.push({ sessionId, index, result });
      return result.promise;
    },
  };
  let output: ReturnType<typeof useLatestCommandHistory> | undefined;
  let sessionId: string | null = "main";
  let scope = "incarnation-1";
  let hasLiveRun = false;
  function Harness() {
    output = useLatestCommandHistory({ api, sessionId, scope, enabled: true, hasLiveRun });
    return null;
  }
  const state = () => { assert.ok(output); return output; };
  const render = async () => { await act(async () => root.render(<Harness />)); };
  const update = async () => { await act(async () => { for (const listener of listeners) listener(sessionId!); }); };
  try {
    await render();
    assert.equal(state().commandHistoryLoading, true);
    assert.deepEqual(pending.map(({ sessionId, index }) => [sessionId, index]), [["main", 3]]);
    latest = turn("auxiliary", "canceled");
    sessionId = "auxiliary";
    await render();
    await act(async () => pending[0].result.resolve(artifact("old command")));
    assert.deepEqual(state().operations, []);
    await act(async () => pending[1].result.resolve(artifact("auxiliary command")));
    assert.equal(state().operations[0]?.summary, "auxiliary command");
    assert.equal(state().operations[0]?.status, "failed");
    latest = { ...turn("auxiliary", "running"), id: 2, assistantMessageSeq: undefined };
    await update();
    assert.deepEqual(state().operations, []);
    assert.equal(state().commandHistoryUnrecorded, false);
    assert.equal(pending.length, 2);
    latest = { ...turn("auxiliary", "failed"), id: 2 };
    await update();
    await act(async () => pending[2].result.reject(new Error("artifact read failed")));
    assert.equal(state().commandHistoryError, "artifact read failed");
    assert.equal(state().commandHistoryUnrecorded, false);
    await act(async () => state().onRetryCommandHistory());
    await act(async () => pending[3].result.resolve({ ...artifact("unused"), operationTimeline: [] }));
    assert.deepEqual(state().operations, []);
    assert.equal(state().commandHistoryUnrecorded, false);
    await update();
    scope = "incarnation-2";
    await render();
    await act(async () => pending[4].result.resolve(artifact("stale incarnation")));
    assert.deepEqual(state().operations, []);
    await act(async () => pending[5].result.resolve(null));
    assert.equal(state().commandHistoryUnrecorded, true);
    assert.equal(state().commandHistoryError, null);
    loadError = new Error("turn read failed");
    await update();
    assert.equal(state().commandHistoryError, "turn read failed");
    assert.equal(state().commandHistoryUnrecorded, false);
    loadError = null;
    latest = turn("main");
    await update();
    assert.match(state().commandHistoryError ?? "", /another conversation/);
    latest = turn("auxiliary");
    await update();
    await act(async () => pending.at(-1)!.result.resolve(artifact("saved command")));
    hasLiveRun = true;
    await render();
    assert.deepEqual(state().operations, []);
    hasLiveRun = false;
    await render();
    assert.equal(state().operations[0]?.summary, "saved command");
    sessionId = null;
    await render();
    assert.deepEqual(state().operations, []);
    const delayedTurn = deferred<SessionTurnRecord | null>();
    nextRead = delayedTurn;
    sessionId = "main";
    latest = turn("main");
    await render();
    assert.equal(state().commandHistoryLoading, true);
    sessionId = "auxiliary";
    latest = turn("auxiliary");
    await render();
    await act(async () => pending.at(-1)!.result.resolve(artifact("current auxiliary command")));
    await act(async () => delayedTurn.resolve(turn("main")));
    assert.equal(state().operations[0]?.summary, "current auxiliary command");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
