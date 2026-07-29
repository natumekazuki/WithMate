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
});
