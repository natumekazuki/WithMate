import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { LiveSessionRunState } from "../../src/app-state.js";
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

test("startLiveSessionRunSubscription は対象 session の購読更新だけを反映する", async () => {
  const subscribedState = createLiveRunState("subscribed");
  const updates: LiveSessionRunStateUpdate[] = [];
  const refreshedSessionIds: string[] = [];
  let subscribedListener: ((sessionId: string, state: LiveSessionRunState | null) => void) | null = null;
  let resolveInitialLiveRun: (state: LiveSessionRunState | null) => void = () => undefined;
  let unsubscribeCount = 0;
  const api: LiveSessionRunSubscriptionApi = {
    getLiveSessionRun: () => new Promise((resolve) => {
      resolveInitialLiveRun = resolve;
    }),
    subscribeLiveSessionRun: (listener) => {
      subscribedListener = listener;
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
  subscribedListener?.("session-other", createLiveRunState("ignored"));
  subscribedListener?.("session-1", subscribedState);
  cleanup();
  subscribedListener?.("session-1", createLiveRunState("stale"));
  resolveInitialLiveRun(null);
  await flushPromises();

  assert.deepEqual(updates, [
    { ownerSessionId: "session-1", state: null },
    { ownerSessionId: "session-1", state: subscribedState },
  ]);
  assert.deepEqual(refreshedSessionIds, ["session-1"]);
  assert.equal(unsubscribeCount, 1);
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

test("CompanionReview の live run subscription 呼び出し前に session / merge guard が残る", async () => {
  const source = await readFile(new URL("../../src/CompanionReviewApp.tsx", import.meta.url), "utf8");
  const guardIndex = source.indexOf("if (!withmateApi || !sessionId || isMergeView)");
  const subscriptionIndex = source.indexOf("startLiveSessionRunSubscription({");

  assert.notEqual(guardIndex, -1);
  assert.notEqual(subscriptionIndex, -1);
  assert.ok(guardIndex < subscriptionIndex);
  assert.match(
    source.slice(guardIndex, subscriptionIndex),
    /setLiveRunState\(\{ ownerSessionId: sessionId, state: null \}\);/,
  );
});
