import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuxiliarySessionSummary } from "../../src/auxiliary-session-state.js";
import { createHomeActiveAuxiliarySessionRefresher } from "../../src/home/home-active-auxiliary-refresh.js";

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
    const fetchCalls: string[][] = [];
    const setCalls: AuxiliarySessionSummary[][] = [];
    const pendingFetches = [firstFetch, secondFetch];
    const refresher = createHomeActiveAuxiliarySessionRefresher({
      getMonitorParentSessionIds: () => ["session-1", "session-2"],
      fetchActiveAuxiliarySessions: (parentSessionIds) => {
        fetchCalls.push(parentSessionIds);
        const fetch = pendingFetches.shift();
        assert.ok(fetch, "unexpected extra fetch");
        return fetch.promise;
      },
      setActiveAuxiliarySessions: (sessions) => setCalls.push(sessions),
    });

    refresher.refresh();
    refresher.refresh();

    assert.deepEqual(fetchCalls, [["session-1", "session-2"]]);

    firstFetch.resolve([createAuxiliarySummary("aux-stale")]);
    await flushPromises();

    assert.deepEqual(fetchCalls, [
      ["session-1", "session-2"],
      ["session-1", "session-2"],
    ]);
    assert.deepEqual(setCalls.map((sessions) => sessions.map((session) => session.id)), [["aux-stale"]]);

    secondFetch.resolve([]);
    await flushPromises();

    assert.deepEqual(setCalls.map((sessions) => sessions.map((session) => session.id)), [["aux-stale"], []]);
  });

  it("dispose 後はin-flight完了やerrorで副作用を起こさない", async () => {
    const firstFetch = createDeferred<AuxiliarySessionSummary[]>();
    const errorFetch = createDeferred<AuxiliarySessionSummary[]>();
    const setCalls: AuxiliarySessionSummary[][] = [];
    const errors: unknown[] = [];
    const refresher = createHomeActiveAuxiliarySessionRefresher({
      getMonitorParentSessionIds: () => ["session-1"],
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
      getMonitorParentSessionIds: () => ["session-1"],
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
