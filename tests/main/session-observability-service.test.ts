import test from "node:test";
import assert from "node:assert/strict";

import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import type { LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityKind, SessionBackgroundActivityState } from "../../src-shared/memory/session-memory-state.js";

async function flushQuotaTasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function quota(provider = "codex", usedPercentage = 0): ProviderQuotaTelemetry {
  return { provider, updatedAt: new Date().toISOString(), snapshots: [],
    rateLimits: [{ quotaKey: "weekly", usedPercentage, windowDurationMinutes: 10080 }], status: "ready" };
}

// @test-value v2
// kind = "contract"
// claim = "clear後の旧account応答は再通知されず、新しい取得の重複抑止を解除しない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "古いPromiseがclear後にcacheを復活させるか新しい取得の管理を消す"
// observable = "clear通知後のgetter、abort signal、新世代の取得回数と結果"
// observation_boundary = "public-boundary"
// scope = "provider quota account invalidation"
// lifecycle = "permanent"
// impact = "別accountの残量を誤表示し、重複するprovider processを起動する"
// distinction = "型検査では非同期完了順序を検証できず、制御した2つのPromiseで低コストに検出する"
// @end-test-value
test("quota clearは旧応答を破棄し新世代のdedupeを守る", async () => {
  const { service, events } = createService();
  let finishOld!: (value: ProviderQuotaTelemetry) => void;
  let finishNew!: (value: ProviderQuotaTelemetry) => void;
  let oldSignal: AbortSignal | undefined;
  const old = service.refreshProviderQuotaTelemetry("codex", (signal) => {
    oldSignal = signal;
    return new Promise((resolve) => { finishOld = resolve; });
  });
  await flushQuotaTasks();
  service.clearProviderQuotaTelemetry("codex");
  assert.equal(oldSignal?.aborted, true);
  assert.equal(service.getProviderQuotaTelemetry("codex"), null);
  const next = service.refreshProviderQuotaTelemetry("codex", () => new Promise((resolve) => { finishNew = resolve; }));
  await flushQuotaTasks();
  const newLoading = service.getProviderQuotaTelemetry("codex");
  const eventCount = events.length;
  finishOld(quota("codex", 90));
  assert.equal(await old, null);
  assert.equal(events.length, eventCount);
  assert.equal(service.getProviderQuotaTelemetry("codex"), newLoading);
  let extraCalls = 0;
  const duplicate = service.refreshProviderQuotaTelemetry("codex", async () => { extraCalls++; return quota(); });
  const expected = quota("codex", 10);
  finishNew(expected);
  assert.deepEqual(await Promise.all([next, duplicate]), [expected, expected]);
  assert.equal(extraCalls, 0);
  assert.deepEqual(service.getProviderQuotaTelemetry("codex"), expected);
  service.dispose();
});

// @test-value v2
// kind = "contract"
// claim = "未取得・loading・実測0・失敗・非対応を区別し、失敗時は最終成功値と時刻を保持して次周期まで再取得しない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "取得失敗を使用率0に変換するか、前回値を消すか、短時間に再試行する"
// observable = "getterのstatusとupdatedAtと実測値、失敗後のcallback回数"
// observation_boundary = "public-boundary"
// scope = "provider quota freshness and failure"
// lifecycle = "permanent"
// impact = "残量を誤認させ、認証失敗中にもリクエストが集中する"
// distinction = "値の型では実測0と未観測を区別できず、mock clockで5分を実時間待機せず検査する"
// @end-test-value
test("quotaは失敗時も最終成功値を保持し再取得を抑制する", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const { service } = createService();
  assert.equal(service.getProviderQuotaTelemetry("codex"), null);
  const expected = quota();
  const ready = service.refreshProviderQuotaTelemetry("codex", async () => expected);
  assert.equal(service.getProviderQuotaTelemetry("codex")?.status, "loading");
  await ready;
  assert.equal(service.getProviderQuotaTelemetry("codex")?.rateLimits?.[0]?.usedPercentage, 0);
  t.mock.timers.tick(1000);
  await assert.rejects(service.refreshProviderQuotaTelemetry("codex", async () => { throw new Error("auth error"); }));
  assert.deepEqual(service.getProviderQuotaTelemetry("codex"), { ...expected, status: "error" });
  let retries = 0;
  const retry = async () => { retries++; return quota("codex", 12); };
  await service.refreshProviderQuotaTelemetry("codex", retry);
  assert.equal(retries, 0);
  t.mock.timers.tick(300000);
  await service.refreshProviderQuotaTelemetry("codex", retry);
  assert.equal(retries, 1);
  assert.equal(service.getProviderQuotaTelemetry("codex")?.status, "ready");
  await service.refreshProviderQuotaTelemetry("claude", async () => null);
  assert.deepEqual(service.getProviderQuotaTelemetry("claude"), { provider: "claude", updatedAt: null, snapshots: [], status: "unsupported" });
  service.dispose();
});

// @test-value v2
// kind = "contract"
// claim = "起動直後と5分ごとにsession非依存で取得し、turn後3秒の更新を集約し、clearAll/disposeで予約と進行中取得を止める"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "初回/周期更新が欠ける、短時間終端を集約しない、clear後にもtimerが発火する"
// observable = "mock clock経過ごとのprovider別取得回数、dispose後のabortとcache"
// observation_boundary = "public-boundary"
// scope = "provider quota polling lifecycle"
// lifecycle = "permanent"
// impact = "無操作中に残量が更新されないか、reset/終了後の取得processが残る"
// distinction = "SDK mockだけではMainの定期更新を通らず、fake timerによる少数の発火で確認する"
// @end-test-value
test("quota pollingとturn後の予約はclearAllとdisposeで停止する", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const { service, events } = createService();
  let calls = 0;
  const refresh = async () => { calls++; return quota(); };
  service.startProviderQuotaPolling("codex", 300000, refresh);
  assert.equal(calls, 0);
  t.mock.timers.tick(1); await flushQuotaTasks();
  assert.equal(calls, 1);
  service.scheduleProviderQuotaTelemetryRefresh("codex", [3000], refresh);
  t.mock.timers.tick(1000);
  service.scheduleProviderQuotaTelemetryRefresh("codex", [3000], refresh);
  t.mock.timers.tick(2999); await flushQuotaTasks();
  assert.equal(calls, 1);
  t.mock.timers.tick(1); await flushQuotaTasks();
  assert.equal(calls, 2);
  t.mock.timers.tick(300000); await flushQuotaTasks();
  assert.equal(calls, 3);
  service.scheduleProviderQuotaTelemetryRefresh("claude", [3000], refresh);
  service.clearAllProviderQuotaTelemetry();
  t.mock.timers.tick(600000); await flushQuotaTasks();
  assert.equal(calls, 3);
  let signal: AbortSignal | undefined;
  let finish!: (value: ProviderQuotaTelemetry) => void;
  const pending = service.refreshProviderQuotaTelemetry("codex", (input) => {
    signal = input; return new Promise((resolve) => { finish = resolve; });
  });
  await flushQuotaTasks();
  service.dispose();
  assert.equal(signal?.aborted, true);
  const count = events.length;
  finish(quota());
  assert.equal(await pending, null);
  await service.waitForProviderQuotaRefreshes();
  assert.equal(events.length, count);
  assert.equal(service.getProviderQuotaTelemetry("codex"), null);
});

function createService() {
  const events: Array<{ type: string; payload: unknown }> = [];
  const service = new SessionObservabilityService({
    onProviderQuotaTelemetryChanged: (providerId, telemetry) => {
      events.push({ type: "quota", payload: { providerId, telemetry } });
    },
    onSessionContextTelemetryChanged: (sessionId, telemetry) => {
      events.push({ type: "context", payload: { sessionId, telemetry } });
    },
    onSessionBackgroundActivityChanged: (sessionId, kind, state) => {
      events.push({ type: "background", payload: { sessionId, kind, state } });
    },
    onLiveSessionRunChanged: (sessionId, state) => {
      events.push({ type: "live", payload: { sessionId, state } });
    },
  });

  return { service, events };
}

// @test-value v2
// kind = "invariant"
// claim = "live run、provider quota、context telemetry、background activityをsession/provider単位で保持し、更新通知へ反映する"
// oracle = { type = "contract", ref = "src-electron/session-observability-service.ts#public-state-accessors" }
// fault = "状態を別session/providerへ混線させるか、更新通知または取得結果へ反映しない"
// observable = "2つのsession/providerキーごとのgetter状態と更新通知イベント数"
// observation_boundary = "public-boundary"
// scope = "session-observability-state-notification"
// lifecycle = "permanent"
// @end-test-value
test("SessionObservabilityService は live run / telemetry / background state を保持して通知する", () => {
  const { service, events } = createService();

  const liveRun: LiveSessionRunState = {
    sessionId: "s-1",
    threadId: "thread-1",
    assistantText: "running",
    steps: [],
    backgroundTasks: [],
    usage: null,
    errorMessage: "",
    approvalRequest: null,
    elicitationRequest: null,
  };
  const quota: ProviderQuotaTelemetry = {
    provider: "copilot",
    updatedAt: new Date().toISOString(),
    snapshots: [],
  };
  const context: SessionContextTelemetry = {
    provider: "copilot",
    sessionId: "s-1",
    updatedAt: new Date().toISOString(),
    tokenLimit: 1000,
    currentTokens: 120,
    messagesLength: 4,
  };
  const background: SessionBackgroundActivityState = {
    sessionId: "s-1",
    title: "Memory generation",
    kind: "memory-generation",
    status: "running",
    updatedAt: new Date().toISOString(),
    summary: "memory generating",
    errorMessage: "",
  };

  service.setLiveSessionRun("s-1", liveRun);
  service.setProviderQuotaTelemetry("copilot", quota);
  service.setSessionContextTelemetry("s-1", context);
  service.setSessionBackgroundActivity("s-1", "memory-generation", background);

  const otherLiveRun = { ...liveRun, sessionId: "s-2", threadId: "thread-2" };
  const otherQuota = { ...quota, provider: "codex" };
  const otherContext = { ...context, provider: "codex", sessionId: "s-2", currentTokens: 240 };
  const otherBackground: SessionBackgroundActivityState = { ...background, sessionId: "s-2", status: "completed" };
  service.setLiveSessionRun("s-2", otherLiveRun);
  service.setProviderQuotaTelemetry("codex", otherQuota);
  service.setSessionContextTelemetry("s-2", otherContext);
  service.setSessionBackgroundActivity("s-2", "memory-generation", otherBackground);

  assert.equal(service.getLiveSessionRun("s-1")?.threadId, "thread-1");
  assert.equal(service.getProviderQuotaTelemetry("copilot")?.provider, "copilot");
  assert.equal(service.getSessionContextTelemetry("s-1")?.currentTokens, 120);
  assert.equal(service.getSessionBackgroundActivity("s-1", "memory-generation")?.status, "running");
  assert.equal(service.getLiveSessionRun("s-2")?.threadId, "thread-2");
  assert.equal(service.getProviderQuotaTelemetry("codex")?.provider, "codex");
  assert.equal(service.getSessionContextTelemetry("s-2")?.currentTokens, 240);
  assert.equal(service.getSessionBackgroundActivity("s-2", "memory-generation")?.status, "completed");
  assert.deepEqual(events.map((event) => event.type), [
    "live", "quota", "context", "background",
    "live", "quota", "context", "background",
  ]);
  assert.equal((events[0]?.payload as { sessionId: string }).sessionId, "s-1");
  assert.equal((events[1]?.payload as { providerId: string }).providerId, "copilot");
  assert.equal((events[2]?.payload as { sessionId: string }).sessionId, "s-1");
  assert.equal((events[3]?.payload as { sessionId: string }).sessionId, "s-1");
  assert.equal((events[4]?.payload as { sessionId: string }).sessionId, "s-2");
  assert.equal((events[5]?.payload as { providerId: string }).providerId, "codex");
  assert.equal((events[6]?.payload as { sessionId: string }).sessionId, "s-2");
  assert.equal((events[7]?.payload as { sessionId: string }).sessionId, "s-2");
});

test("SessionObservabilityService は provider quota refresh を dedupe して clear できる", async () => {
  const { service, events } = createService();
  let refreshCount = 0;

  const refresh = async (): Promise<ProviderQuotaTelemetry> => {
    refreshCount += 1;
    await Promise.resolve();
    return {
      provider: "copilot",
      updatedAt: new Date().toISOString(),
      snapshots: [],
    };
  };

  const [first, second] = await Promise.all([
    service.refreshProviderQuotaTelemetry("copilot", refresh),
    service.refreshProviderQuotaTelemetry("copilot", refresh),
  ]);

  assert.equal(refreshCount, 1);
  assert.equal(first?.provider, "copilot");
  assert.equal(second?.provider, "copilot");

  service.clearProviderQuotaTelemetry("copilot");
  assert.equal(service.getProviderQuotaTelemetry("copilot"), null);
  assert.deepEqual(events.at(-1), {
    type: "quota",
    payload: { providerId: "copilot", telemetry: null },
  });
});

// @test-value v2
// kind = "invariant"
// claim = "指定sessionのbackground activityだけをclearし、各kindの削除通知を発行する"
// oracle = { type = "contract", ref = "src-electron/session-observability-service.ts#clearSessionBackgroundActivities" }
// fault = "別sessionのactivityまで削除するか、clear後のgetterと削除通知が不整合になる"
// observable = "指定sessionの各kind getter結果、別sessionの保持状態、clear通知payload"
// observation_boundary = "public-boundary"
// scope = "session-observability-background-clear"
// lifecycle = "permanent"
// @end-test-value
test("SessionObservabilityService は background activity を session 単位で clear できる", () => {
  const { service, events } = createService();
  const updatedAt = new Date().toISOString();
  const kinds: SessionBackgroundActivityKind[] = ["memory-generation", "monologue"];

  for (const kind of kinds) {
    service.setSessionBackgroundActivity("s-1", kind, {
      sessionId: "s-1",
      title: kind,
      kind,
      status: "completed",
      updatedAt,
      summary: kind,
      errorMessage: "",
    });
  }
  service.setSessionBackgroundActivity("s-2", "memory-generation", {
    sessionId: "s-2",
    title: "Other session",
    kind: "memory-generation",
    status: "running",
    updatedAt,
    summary: "must remain",
    errorMessage: "",
  });

  service.clearSessionBackgroundActivities("s-1");

  assert.equal(service.getSessionBackgroundActivity("s-1", "memory-generation"), null);
  assert.equal(service.getSessionBackgroundActivity("s-1", "monologue"), null);
  assert.equal(service.getSessionBackgroundActivity("s-2", "memory-generation")?.summary, "must remain");
  assert.deepEqual(events.slice(-2), [
    { type: "background", payload: { sessionId: "s-1", kind: "memory-generation", state: null } },
    { type: "background", payload: { sessionId: "s-1", kind: "monologue", state: null } },
  ]);
});
