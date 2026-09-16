import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuxiliarySessionSummary } from "../../src/auxiliary-session-state.js";
import {
  createHomeActiveAuxiliarySessionRefresher,
  resolveHomeActiveAuxiliarySessionsState,
} from "../../src/home/home-active-auxiliary-refresh.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createAuxiliarySummary(id: string): AuxiliarySessionSummary {
  return {
    id,
    parentSessionId: "session-1",
    status: "active",
    runState: "running",
    title: "Auxiliary",
    provider: "codex",
    catalogRevision: 1,
    model: "gpt-5.4",
    reasoningEffort: "high",
    approvalMode: "safety",
    codexSandboxMode: "danger-full-access",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "",
    displayAfterMessageIndex: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    closedAt: "",
  };
}

describe("createHomeActiveAuxiliarySessionRefresher", () => {
  it("in-flight 中の refresh 要求を完了後に再実行する", async () => {
    const firstFetch = createDeferred<AuxiliarySessionSummary[]>();
    const secondFetch = createDeferred<AuxiliarySessionSummary[]>();
    let fetchCallCount = 0;
    const setCalls: AuxiliarySessionSummary[][] = [];
    const pendingFetches = [firstFetch, secondFetch];
    const refresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: () => {
        fetchCallCount += 1;
        const fetch = pendingFetches.shift();
        assert.ok(fetch, "unexpected extra fetch");
        return fetch.promise;
      },
      setActiveAuxiliarySessions: (sessions) => setCalls.push(sessions),
    });

    refresher.refresh();
    refresher.refresh();

    assert.equal(fetchCallCount, 1);

    firstFetch.resolve([createAuxiliarySummary("aux-stale")]);
    await flushPromises();

    assert.equal(fetchCallCount, 2);
    assert.deepEqual(setCalls.map((sessions) => sessions.map((session) => session.id)), [["aux-stale"]]);

    secondFetch.resolve([]);
    await flushPromises();

    assert.deepEqual(setCalls.map((sessions) => sessions.map((session) => session.id)), [["aux-stale"], []]);
  });

  it("同じ summary が連続した場合は state を再適用しない", async () => {
    const summary = createAuxiliarySummary("aux-1");
    const responses = [
      [summary],
      [{ ...summary }],
      [{ ...summary, runState: "idle" as const }],
      [],
    ];
    const setCalls: AuxiliarySessionSummary[][] = [];
    const refresher = createHomeActiveAuxiliarySessionRefresher({
      async fetchActiveAuxiliarySessions() {
        const response = responses.shift();
        assert.ok(response, "unexpected extra fetch");
        return response;
      },
      setActiveAuxiliarySessions: (sessions) => setCalls.push(sessions),
    });

    for (let index = 0; index < 4; index += 1) {
      refresher.refresh();
      await flushPromises();
    }

    assert.deepEqual(
      setCalls.map((sessions) => sessions.map((session) => `${session.id}:${session.runState}`)),
      [["aux-1:running"], ["aux-1:idle"], []],
    );
  });

  it("refresher の再生成を跨いでも同じ summary の state 参照を維持する", async () => {
    const summary = createAuxiliarySummary("aux-1");
    let current = [summary];
    let changedStateCount = 0;
    const applySessions = (sessions: AuxiliarySessionSummary[]) => {
      const resolved = resolveHomeActiveAuxiliarySessionsState(current, sessions);
      if (resolved !== current) {
        changedStateCount += 1;
      }
      current = resolved;
    };

    const firstRefresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: async () => [{ ...summary }],
      setActiveAuxiliarySessions: applySessions,
    });
    firstRefresher.refresh();
    await flushPromises();
    firstRefresher.dispose();

    const secondRefresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: async () => [{ ...summary }],
      setActiveAuxiliarySessions: applySessions,
    });
    secondRefresher.refresh();
    await flushPromises();

    assert.equal(changedStateCount, 0);
    assert.equal(current[0], summary);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home MonitorのAuxiliary summary refreshはdispose後に取得結果や失敗をrenderer stateへ反映しない"
  // oracle = { type = "contract", ref = "Home Monitor refresh disposal contract" }
  // fault = "画面破棄後のin-flight結果やerrorがstate更新・feedbackを起こし、閉じたMonitorへ副作用が残る"
  // observable = "dispose後のsetActiveAuxiliarySessionsとonErrorの呼び出しが空であること"
  // observation_boundary = "implementation"
  // scope = "createHomeActiveAuxiliarySessionRefresher dispose guard"
  // lifecycle = "permanent"
  // impact = "Homeを閉じた後に古いAuxiliary summaryやエラーが再描画されない"
  // distinction = "summary load stateの通知契約とは分離して、破棄後の副作用抑止を検証する"
  // @end-test-value
  it("dispose 後はin-flight完了やerrorで副作用を起こさない", async () => {
    const firstFetch = createDeferred<AuxiliarySessionSummary[]>();
    const errorFetch = createDeferred<AuxiliarySessionSummary[]>();
    const setCalls: AuxiliarySessionSummary[][] = [];
    const errors: unknown[] = [];
    const refresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: () => firstFetch.promise,
      setActiveAuxiliarySessions: (sessions) => setCalls.push(sessions),
      onError: (error) => errors.push(error),
    });

    refresher.refresh();
    refresher.refresh();
    refresher.dispose();

    firstFetch.resolve([createAuxiliarySummary("aux-after-dispose")]);
    await flushPromises();

    assert.deepEqual(setCalls, []);
    assert.deepEqual(errors, []);

    const errorRefresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: () => errorFetch.promise,
      setActiveAuxiliarySessions: (sessions) => setCalls.push(sessions),
      onError: (error) => errors.push(error),
    });

    errorRefresher.refresh();
    errorRefresher.dispose();

    errorFetch.reject(new Error("after dispose"));
    await flushPromises();

    assert.deepEqual(setCalls, []);
    assert.deepEqual(errors, []);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary summary refresherは未確定、成功、失敗をload stateへ分離して通知する"
  // oracle = { type = "contract", ref = "issue-722 unknown Auxiliary data feedback" }
  // fault = "初期読み込み中や取得失敗を空配列・全停止として扱い、Monitorが誤った集約状態を表示する"
  // observable = "onLoadStateの通知順序と取得失敗時のonError"
  // observation_boundary = "implementation"
  // scope = "createHomeActiveAuxiliarySessionRefresher load state"
  // lifecycle = "permanent"
  // impact = "Home側がAuxiliary dataの確定状態を通知に応じて表示へ反映できる"
  // distinction = "summaryの差分適用やdispose guardとは分離して、データ確定状態を検証する"
  // @end-test-value
  it("Auxiliary summary refreshのloading/ready/errorを通知する", async () => {
    const states: string[] = [];
    const firstRefresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: async () => [createAuxiliarySummary("aux-ready")],
      setActiveAuxiliarySessions: () => undefined,
      onLoadState: (state) => states.push(state),
    });

    firstRefresher.refresh();
    await flushPromises();
    assert.deepEqual(states, ["loading", "ready"]);

    const errors: unknown[] = [];
    const secondRefresher = createHomeActiveAuxiliarySessionRefresher({
      fetchActiveAuxiliarySessions: async () => {
        throw new Error("summary unavailable");
      },
      setActiveAuxiliarySessions: () => undefined,
      onLoadState: (state) => states.push(state),
      onError: (error) => errors.push(error),
    });

    secondRefresher.refresh();
    await flushPromises();
    assert.deepEqual(states, ["loading", "ready", "loading", "error"]);
    assert.equal((errors[0] as Error).message, "summary unavailable");
  });
});
