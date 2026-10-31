import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { WithMateWindowApi } from "../../src-shared/ipc/withmate-window-api.js";
import type { SessionMonitorPageResult } from "../../src-shared/window/withmate-window-types.js";
import { buildNewSession, projectHomeSessionSummary } from "../../src-shared/session/session-state.js";
import { fetchHomeSessionMonitorSnapshot, useHomeSessionMonitor } from "../../src/home/use-home-session-monitor.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(id: string) {
  return projectHomeSessionSummary(buildNewSession({
    id, taskTitle: id, workspaceLabel: "Workspace", workspacePath: "C:\\workspace", branch: "",
    characterId: "mia", character: "Mia", characterIconPath: "",
    characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" }, approvalMode: "on-request",
  }));
}

function page(id: string): SessionMonitorPageResult {
  return { entries: [entry(id)], auxiliarySessions: [], nextCursor: null, hasMore: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

// @test-value v2
// kind = "contract"
// claim = "Monitor snapshotは100親単位の全pageを連結し、失効した取得では後続pageを要求しない"
// oracle = { type = "contract", ref = "GitHub Issue #876 専用Monitor queryのbounded paging" }
// fault = "最初のpageだけ表示する、cursorを引き継がない、または失効後も追加取得を続ける"
// observable = "API requestのcursor/limitと結合後の親ID、失効後のrequest数"
// observation_boundary = "consumer"
// scope = "Home Monitor snapshot paging"
// lifecycle = "permanent"
// impact = "履歴pageの外にいる実行中Sessionを監視から欠落させない"
// distinction = "型checkや単一pageのHome描画testでは複数pageの取得制御と失効時の中断を確認できない"
// @end-test-value
test("Monitor snapshotは全pageを結合し、失効後の後続pageを止める", async () => {
  const requests: unknown[] = [];
  const snapshot = await fetchHomeSessionMonitorSnapshot({
    listSessionMonitorPage: async (request) => {
      requests.push(request);
      return request?.cursor ? page("z") : { ...page("a"), nextCursor: "a", hasMore: true };
    },
  }, () => true);
  assert.deepEqual(snapshot.entries.map(({ id }) => id), ["a", "z"]);
  assert.deepEqual(requests, [{ cursor: null, limit: 100 }, { cursor: "a", limit: 100 }]);
  let current = true;
  let calls = 0;
  const discarded = await fetchHomeSessionMonitorSnapshot({
    listSessionMonitorPage: async () => {
      calls += 1;
      current = false;
      return { ...page("obsolete"), nextCursor: "obsolete", hasMore: true };
    },
  }, () => current);
  assert.equal(calls, 1);
  assert.deepEqual(discarded.entries, []);
});

// @test-value v2
// kind = "contract"
// claim = "Monitor hookはlive状態変化・Session無効化・open ID変更・focusでsnapshotを更新し、通知集中時の旧応答と同状態streamingを捨て、失敗時も既存行と再試行を保持する"
// oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window" }
// fault = "古い応答を適用する、通知ごとに同時取得する、同状態streamingで再取得する、または取得失敗で既存行を消す"
// observable = "hook公開snapshot/status/feedback、API取得数、購読解除数"
// observation_boundary = "component-behavior"
// scope = "Home Monitor hook query lifecycle"
// lifecycle = "permanent"
// impact = "実行監視の古い表示・取得増殖・失敗中のSession到達不能を防ぐ"
// distinction = "pure projectionでは検出できないReact lifecycle・購読・非同期取得・再試行の結線を小さいhook consumerで観測する"
// @end-test-value
test("Monitor hookは更新を集約し、stale応答と同状態streamingを除外して失敗後に再試行する", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://withmate.local/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  const stale = deferred<SessionMonitorPageResult>();
  let calls = 0;
  let query = async () => page("latest");
  const live = new Set<Parameters<WithMateWindowApi["subscribeLiveSessionRunStatus"]>[0]>();
  const invalidations = new Set<Parameters<WithMateWindowApi["subscribeSessionInvalidation"]>[0]>();
  const turns = new Set<Parameters<WithMateWindowApi["onSessionTurnUpdated"]>[0]>();
  dom.window.withmate = {
    listSessionMonitorPage: async () => ++calls === 1 ? stale.promise : query(),
    subscribeLiveSessionRunStatus: (listener) => { live.add(listener); return () => { live.delete(listener); }; },
    subscribeSessionInvalidation: (listener) => { invalidations.add(listener); return () => { invalidations.delete(listener); }; },
    onSessionTurnUpdated: (listener) => { turns.add(listener); return () => { turns.delete(listener); }; },
  } as Partial<WithMateWindowApi> as WithMateWindowApi;
  let state!: ReturnType<typeof useHomeSessionMonitor>;
  function Probe({ ids }: { ids: string[] }) {
    state = useHomeSessionMonitor(true, ids);
    return <div>{state.entries.map(({ id }) => id).join(",")}</div>;
  }
  const element = dom.window.document.getElementById("root")!;
  const root = createRoot(element);
  try {
    await act(async () => root.render(<Probe ids={[]} />));
    assert.equal(state.status, "loading");
    await act(async () => {
      for (const listener of invalidations) listener({ scope: "all" });
      dom.window.dispatchEvent(new dom.window.Event("focus"));
    });
    assert.equal(calls, 1);
    await act(async () => stale.resolve(page("obsolete")));
    assert.equal(calls, 2);
    assert.equal(element.textContent, "latest");
    assert.equal(state.status, "loaded");
    query = async () => page("running");
    await act(async () => { for (const listener of live) listener("latest", { runState: "running" }); });
    assert.equal(element.textContent, "running");
    const beforeStreaming = calls;
    await act(async () => { for (const listener of live) listener("latest", { runState: "running" }); });
    assert.equal(calls, beforeStreaming);
    query = async () => { throw new Error("Monitor unavailable"); };
    await act(async () => root.render(<Probe ids={["open-window"]} />));
    assert.equal(element.textContent, "running");
    assert.equal(state.status, "error");
    assert.equal(state.feedback, "Monitor unavailable");
    query = async () => page("recovered");
    await act(async () => state.refresh());
    assert.equal(element.textContent, "recovered");
    assert.equal(state.status, "loaded");
    assert.equal(state.feedback, "");
    const late = deferred<SessionMonitorPageResult>();
    query = () => late.promise;
    await act(async () => state.refresh());
    await act(async () => root.unmount());
    assert.equal(live.size, 0);
    assert.equal(invalidations.size, 0);
    assert.equal(turns.size, 0);
    await act(async () => late.resolve(page("after-unmount")));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperty(globalThis, "window", { value: previousWindow, configurable: true });
    Object.defineProperty(globalThis, "document", { value: previousDocument, configurable: true });
  }
});
