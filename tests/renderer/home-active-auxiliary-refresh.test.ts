import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { AuxiliarySessionSummary } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import { createHomeAuxiliarySessionRefresher } from "../../src/home/home-active-auxiliary-refresh.js";

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
    approvalMode: "on-request",
    codexSpeed: "standard",
    codexReviewer: "auto-review",
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

describe("createHomeAuxiliarySessionRefresher", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary summary refresherは取得中の無効化より古いsnapshotを適用せず、繰り越した取得から現行summaryを反映する"
  // oracle = { type = "contract", ref = "GitHub Issue #783 / docs/design/desktop-ui.md Home Window" }
  // fault = "無効化済みsnapshotを適用して現行の取消待ちを消すか、後続の取得を捨てる"
  // observable = "fetchCallCountとsetAuxiliarySessionSummariesへ渡されたsummary列"
  // observation_boundary = "implementation"
  // scope = "createHomeAuxiliarySessionRefresher in-flight scheduling"
  // lifecycle = "permanent"
  // impact = "遅い取得が取消待ちの表示を巻き戻し、実停止していない会話をStoppedへ移す"
  // distinction = "型検査では判別できないdeferred取得と無効化の順序を、2応答の低コストなtestで直接確認する"
  // @end-test-value
  it("無効化済みsnapshotを破棄し、in-flight中のrefreshを再実行する", async () => {
    const firstFetch = createDeferred<AuxiliarySessionSummary[]>();
    const secondFetch = createDeferred<AuxiliarySessionSummary[]>();
    let fetchCallCount = 0;
    const setCalls: AuxiliarySessionSummary[][] = [];
    const pendingFetches = [firstFetch, secondFetch];
    const refresher = createHomeAuxiliarySessionRefresher({
      fetchAuxiliarySessionSummaries: () => {
        fetchCallCount += 1;
        const fetch = pendingFetches.shift();
        assert.ok(fetch, "unexpected extra fetch");
        return fetch.promise;
      },
      setAuxiliarySessionSummaries: (sessions) => setCalls.push(sessions),
    });

    refresher.refresh();
    refresher.refresh();

    assert.equal(fetchCallCount, 1);

    firstFetch.resolve([createAuxiliarySummary("aux-stale")]);
    await flushPromises();

    assert.equal(fetchCallCount, 2);
    assert.deepEqual(setCalls, []);

    secondFetch.resolve([]);
    await flushPromises();

    assert.deepEqual(setCalls, [[]]);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Auxiliary summary refresherは内容が同じ連続取得結果をstateへ再適用しない"
  // oracle = { type = "contract", ref = "Home Monitor summary identity contract" }
  // fault = "同一summaryを毎回新しい配列としてstateへ渡し、不要な再描画や状態更新を起こす"
  // observable = "setAuxiliarySessionSummariesへ渡されたsummary列の呼び出し履歴"
  // observation_boundary = "implementation"
  // scope = "createHomeAuxiliarySessionRefresher summary equality"
  // lifecycle = "permanent"
  // distinction = "取得の繰り越し、refresher再生成、load state通知とは分離して、同一内容の差分抑制だけを検証する"
  // @end-test-value
  it("同じ summary が連続した場合は state を再適用しない", async () => {
    const summary = createAuxiliarySummary("aux-1");
    const responses = [
      [summary],
      [{ ...summary }],
      [{ ...summary, runState: "idle" as const }],
      [],
    ];
    const setCalls: AuxiliarySessionSummary[][] = [];
    const refresher = createHomeAuxiliarySessionRefresher({
      async fetchAuxiliarySessionSummaries() {
        const response = responses.shift();
        assert.ok(response, "unexpected extra fetch");
        return response;
      },
      setAuxiliarySessionSummaries: (sessions) => setCalls.push(sessions),
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

  // @test-value v2
  // kind = "invariant"
  // claim = "HomeApp.tsxはAuxiliary refresh effectを指定APIとsummary state resolverへ接続する"
  // oracle = { type = "contract", ref = "HomeApp Auxiliary summary refresh source wiring" }
  // fault = "HomeApp.tsxのrefresh wiringが指定APIを呼ばない、またはsummary state resolverを介さずにstateを置換する"
  // observable = "HomeAppのrefresher wiring snippetにlistOpenAuxiliarySessionSummariesとsummary state resolverが含まれること"
  // observation_boundary = "implementation"
  // scope = "HomeApp Auxiliary summary refresh source wiring"
  // lifecycle = "permanent"
  // distinction = "runtime effectの実行結果ではなく、HomeApp.tsxの取得・state接続source contractだけを検証する"
  // @end-test-value
  it("refresher の再生成を跨いでも同じ summary の state 参照を維持する", async () => {
    const source = await readFile(new URL("../../src/home/HomeApp.tsx", import.meta.url), "utf8");
    const refresherStart = source.indexOf("const refresher = createHomeAuxiliarySessionRefresher({");
    assert.notEqual(refresherStart, -1);
    const refresherEnd = source.indexOf("\n    });", refresherStart);
    assert.notEqual(refresherEnd, -1);
    const refresherSnippet = source.slice(refresherStart, refresherEnd + "\n    });".length);

    assert.match(
      refresherSnippet,
      /fetchAuxiliarySessionSummaries: \(\) => withmateApi\.listOpenAuxiliarySessionSummaries\(\)/,
    );
    assert.match(refresherSnippet, /setAuxiliarySessionSummaries: \(sessions\) => \{/);
    assert.match(
      refresherSnippet,
      /setAuxiliarySessionSummaries\(\(current\) =>\s*resolveHomeAuxiliarySessionSummariesState\(current, sessions\),\s*\)/s,
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Home MonitorのAuxiliary summary refreshはdispose後に取得結果や失敗をrenderer stateへ反映しない"
  // oracle = { type = "contract", ref = "src/home/home-active-auxiliary-refresh.ts" }
  // fault = "画面破棄後のin-flight結果やerrorがstate更新・feedbackを起こし、閉じたMonitorへ副作用が残る"
  // observable = "dispose後のsetAuxiliarySessionSummariesとonErrorの呼び出しが空であること"
  // observation_boundary = "implementation"
  // scope = "createHomeAuxiliarySessionRefresher dispose guard"
  // lifecycle = "permanent"
  // impact = "Homeを閉じた後に古いAuxiliary summaryやエラーが再描画されない"
  // distinction = "summary load stateの通知契約とは分離して、破棄後の副作用抑止を検証する"
  // @end-test-value
  it("dispose 後はin-flight完了やerrorで副作用を起こさない", async () => {
    const firstFetch = createDeferred<AuxiliarySessionSummary[]>();
    const errorFetch = createDeferred<AuxiliarySessionSummary[]>();
    const setCalls: AuxiliarySessionSummary[][] = [];
    const errors: unknown[] = [];
    const recordSetCall = (sessions: AuxiliarySessionSummary[]) => { setCalls.push(sessions); };
    const recordError = (error: unknown) => { errors.push(error); };
    const refresher = createHomeAuxiliarySessionRefresher({
      fetchAuxiliarySessionSummaries: () => firstFetch.promise,
      setAuxiliarySessionSummaries: recordSetCall,
      onError: recordError,
    });

    refresher.refresh();
    refresher.refresh();
    refresher.dispose();

    firstFetch.resolve([createAuxiliarySummary("aux-after-dispose")]);
    await flushPromises();

    assert.deepEqual(setCalls, []);
    assert.deepEqual(errors, []);

    const errorRefresher = createHomeAuxiliarySessionRefresher({
      fetchAuxiliarySessionSummaries: () => errorFetch.promise,
      setAuxiliarySessionSummaries: recordSetCall,
      onError: recordError,
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
  // claim = "Auxiliary summary refresherは未確定、成功、失敗をload stateへ分離し、失敗時に既存summaryを消去しない"
  // oracle = { type = "contract", ref = "src/home/home-active-auxiliary-refresh.ts" }
  // fault = "初期読み込み中や取得失敗を空配列・全停止として扱う、または成功済みsummaryを失敗時に消去する"
  // observable = "onLoadStateの通知順序、取得失敗時のonError、setAuxiliarySessionSummariesの適用履歴"
  // observation_boundary = "implementation"
  // scope = "createHomeAuxiliarySessionRefresher load state"
  // lifecycle = "permanent"
  // impact = "Home側がAuxiliary dataの確定状態を通知に応じて表示へ反映できる"
  // distinction = "summaryの差分適用やdispose guardとは分離して、データ確定状態を検証する"
  // @end-test-value
  it("Auxiliary summary refreshのloading/ready/errorを通知する", async () => {
    const states: string[] = [];
    const appliedSummaries: string[][] = [];
    const firstRefresher = createHomeAuxiliarySessionRefresher({
      fetchAuxiliarySessionSummaries: async () => [createAuxiliarySummary("aux-ready")],
      setAuxiliarySessionSummaries: (sessions) => appliedSummaries.push(sessions.map((session) => session.id)),
      onLoadState: (state) => states.push(state),
    });

    firstRefresher.refresh();
    await flushPromises();
    assert.deepEqual(states, ["loading", "ready"]);
    assert.deepEqual(appliedSummaries, [["aux-ready"]]);

    const errors: unknown[] = [];
    let unavailable = true;
    const secondRefresher = createHomeAuxiliarySessionRefresher({
      fetchAuxiliarySessionSummaries: async () => {
        if (unavailable) {
          throw new Error("summary unavailable");
        }
        return [createAuxiliarySummary("aux-recovered")];
      },
      setAuxiliarySessionSummaries: (sessions) => appliedSummaries.push(sessions.map((session) => session.id)),
      onLoadState: (state) => states.push(state),
      onError: (error) => errors.push(error),
    });

    secondRefresher.refresh();
    await flushPromises();
    assert.deepEqual(states, ["loading", "ready", "loading", "error"]);
    assert.equal((errors[0] as Error).message, "summary unavailable");
    assert.deepEqual(appliedSummaries, [["aux-ready"]]);

    unavailable = false;
    secondRefresher.refresh();
    await flushPromises();
    assert.deepEqual(states, ["loading", "ready", "loading", "error", "loading", "ready"]);
    assert.deepEqual(appliedSummaries, [["aux-ready"], ["aux-recovered"]]);
  });
});
