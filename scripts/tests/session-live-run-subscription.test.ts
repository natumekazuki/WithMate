import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { LiveSessionRunState } from "../../src-shared/session/runtime-state.js";
import {
  startLiveSessionRunSubscription,
  type LiveSessionRunStateUpdate,
  type LiveSessionRunSubscriptionApi,
} from "../../src/session-live-run-subscription.js";

const createLiveRunState = (message: string): LiveSessionRunState => ({
  sessionId: "session-1",
  threadId: "thread-1",
  assistantText: message,
  steps: [],
  backgroundTasks: [],
  usage: null,
  errorMessage: "",
  approvalRequest: null,
  elicitationRequest: null,
});
const flushPromises = () => new Promise<void>((resolve) => {
  queueMicrotask(resolve);
});

test("startLiveSessionRunSubscription は reset 後に初回 live run を反映する", async () => {
  const initialState = createLiveRunState("initial");
  const updates: LiveSessionRunStateUpdate[] = [];
  const refreshedSessionIds: string[] = [];
  const api: LiveSessionRunSubscriptionApi = {
    getLiveSessionRun: async () => initialState,
    subscribeLiveSessionRun: () => () => undefined,
  };

  const cleanup = startLiveSessionRunSubscription({
    sessionId: "session-1",
    api,
    applyLiveRunState: (update) => updates.push(update),
    onSessionRunUpdated: (sessionId) => refreshedSessionIds.push(sessionId),
  });
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", state: null },
    { ownerSessionId: "session-1", state: initialState },
  ]);
  assert.deepEqual(refreshedSessionIds, ["session-1"]);
});

// @test-value v2
// kind = "invariant"
// claim = "live run subscriptionは対象sessionの更新だけを反映しcleanup後の更新を無視する"
// oracle = { type = "contract", ref = "live run subscription ownership" }
// fault = "別sessionまたはcleanup後のstale updateが現在のlive stateへ混入する"
// observable = "applied owner state, refreshed ids, and unsubscribe count"
// observation_boundary = "public-boundary"
// scope = "live-run-subscription-owner-filter"
// lifecycle = "permanent"
// @end-test-value
test("startLiveSessionRunSubscription は対象 session の購読更新だけを反映する", async () => {
  const subscribedState = createLiveRunState("subscribed");
  const updates: LiveSessionRunStateUpdate[] = [];
  const refreshedSessionIds: string[] = [];
  const control: { subscribedListener: ((sessionId: string, state: LiveSessionRunState | null) => void) | null } = { subscribedListener: null };
  let resolveInitialLiveRun: (state: LiveSessionRunState | null) => void = () => undefined;
  let unsubscribeCount = 0;
  const api: LiveSessionRunSubscriptionApi = {
    getLiveSessionRun: () => new Promise((resolve) => {
      resolveInitialLiveRun = resolve;
    }),
    subscribeLiveSessionRun: (listener) => {
      control.subscribedListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  const cleanup = startLiveSessionRunSubscription({
    sessionId: "session-1",
    api,
    applyLiveRunState: (update) => updates.push(update),
    onSessionRunUpdated: (sessionId) => refreshedSessionIds.push(sessionId),
  });
  if (control.subscribedListener) control.subscribedListener("session-other", createLiveRunState("ignored"));
  if (control.subscribedListener) control.subscribedListener("session-1", subscribedState);
  cleanup();
  if (control.subscribedListener) control.subscribedListener("session-1", createLiveRunState("stale"));
  resolveInitialLiveRun(null);
  await flushPromises();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", state: null },
    { ownerSessionId: "session-1", state: subscribedState },
  ]);
  assert.deepEqual(refreshedSessionIds, ["session-1"]);
  assert.equal(unsubscribeCount, 1);
});

// @test-value v2
// kind = "invariant"
// claim = "live run購読更新後の遅い初回取得は新しいlive stateを巻き戻さない"
// oracle = { type = "contract", ref = "live run subscription ordering" }
// fault = "遅い初回nullが購読済みlive runを消去する"
// observable = "applied live run update sequence"
// observation_boundary = "public-boundary"
// scope = "live-run-stale-initial"
// lifecycle = "permanent"
// @end-test-value
test("startLiveSessionRunSubscription は購読更新後に遅い初回取得で live run を巻き戻さない", async () => {
  const subscribedState = createLiveRunState("subscribed");
  const updates: LiveSessionRunStateUpdate[] = [];
  const refreshedSessionIds: string[] = [];
  const control: { subscribedListener: ((sessionId: string, state: LiveSessionRunState | null) => void) | null } = { subscribedListener: null };
  let resolveInitialLiveRun: (state: LiveSessionRunState | null) => void = () => undefined;
  const api: LiveSessionRunSubscriptionApi = {
    getLiveSessionRun: () => new Promise((resolve) => {
      resolveInitialLiveRun = resolve;
    }),
    subscribeLiveSessionRun: (listener) => {
      control.subscribedListener = listener;
      return () => undefined;
    },
  };

  const cleanup = startLiveSessionRunSubscription({
    sessionId: "session-1",
    api,
    applyLiveRunState: (update) => updates.push(update),
    onSessionRunUpdated: (sessionId) => refreshedSessionIds.push(sessionId),
  });
  if (control.subscribedListener) control.subscribedListener("session-1", subscribedState);
  resolveInitialLiveRun(null);
  await flushPromises();
  cleanup();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", state: null },
    { ownerSessionId: "session-1", state: subscribedState },
  ]);
  assert.deepEqual(refreshedSessionIds, ["session-1"]);
});

test("startLiveSessionRunSubscription は cleanup 後の初回取得結果を反映しない", async () => {
  const updates: LiveSessionRunStateUpdate[] = [];
  const refreshedSessionIds: string[] = [];
  let resolveLiveRun: (state: LiveSessionRunState | null) => void = () => undefined;
  const api: LiveSessionRunSubscriptionApi = {
    getLiveSessionRun: () => new Promise((resolve) => {
      resolveLiveRun = resolve;
    }),
    subscribeLiveSessionRun: () => () => undefined,
  };

  const cleanup = startLiveSessionRunSubscription({
    sessionId: "session-1",
    api,
    applyLiveRunState: (update) => updates.push(update),
    onSessionRunUpdated: (sessionId) => refreshedSessionIds.push(sessionId),
  });
  cleanup();
  resolveLiveRun(createLiveRunState("stale"));
  await flushPromises();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", state: null },
  ]);
  assert.deepEqual(refreshedSessionIds, []);
});

// @test-value v2
// kind = "invariant"
// claim = "Appは有効なselected sessionとactive runだけにlive subscriptionを作成し、購読前に表示状態をresetする"
// oracle = { type = "contract", ref = "issue-710 concurrent live-run ownership" }
// fault = "無効な選択状態で購読を開始する、または前の会話のlive stateを新しいsessionへ表示する"
// observable = "App.tsxのguardとsubscription前reset"
// observation_boundary = "declaration"
// scope = "app-live-run-subscription-guard"
// lifecycle = "permanent"
// @end-test-value
test("App の live run subscription 呼び出し前に session guard が残る", async () => {
  const source = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const guardIndex = source.indexOf("if (!withmateApi || !selectedSession || !activeRunSessionId)");
  const subscriptionIndex = source.indexOf("startLiveSessionRunSubscription({");

  assert.notEqual(guardIndex, -1);
  assert.notEqual(subscriptionIndex, -1);
  assert.ok(guardIndex < subscriptionIndex);
  assert.match(
    source.slice(guardIndex, subscriptionIndex),
    /setLiveRunState\(\{ ownerSessionId: null, state: null \}\);/,
  );
});
