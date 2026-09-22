import test from "node:test";
import assert from "node:assert/strict";

import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import type { LiveSessionRunState, ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src-shared/session/runtime-state.js";
import type { SessionBackgroundActivityKind, SessionBackgroundActivityState } from "../../src-shared/memory/session-memory-state.js";

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
