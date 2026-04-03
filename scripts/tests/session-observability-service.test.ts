import test from "node:test";
import assert from "node:assert/strict";

import { SessionObservabilityService } from "../../src-electron/session-observability-service.js";
import type {
  LiveSessionRunState,
  ProviderQuotaTelemetry,
  SessionBackgroundActivityKind,
  SessionBackgroundActivityState,
  SessionContextTelemetry,
} from "../../src/app-state.js";

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
    kind: "memory-generation",
    status: "running",
    updatedAt: new Date().toISOString(),
    summary: "memory generating",
  };

  service.setLiveSessionRun("s-1", liveRun);
  service.setProviderQuotaTelemetry("copilot", quota);
  service.setSessionContextTelemetry("s-1", context);
  service.setSessionBackgroundActivity("s-1", "memory-generation", background);

  assert.equal(service.getLiveSessionRun("s-1")?.threadId, "thread-1");
  assert.equal(service.getProviderQuotaTelemetry("copilot")?.provider, "copilot");
  assert.equal(service.getSessionContextTelemetry("s-1")?.currentTokens, 120);
  assert.equal(service.getSessionBackgroundActivity("s-1", "memory-generation")?.status, "running");
  assert.equal(events.length, 4);
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

test("SessionObservabilityService は background activity を session 単位で clear できる", () => {
  const { service, events } = createService();
  const updatedAt = new Date().toISOString();
  const kinds: SessionBackgroundActivityKind[] = ["memory-generation", "character-memory-generation", "monologue"];

  for (const kind of kinds) {
    service.setSessionBackgroundActivity("s-1", kind, {
      kind,
      status: "completed",
      updatedAt,
      summary: kind,
    });
  }

  service.clearSessionBackgroundActivities("s-1");

  assert.equal(service.getSessionBackgroundActivity("s-1", "memory-generation"), null);
  assert.equal(service.getSessionBackgroundActivity("s-1", "character-memory-generation"), null);
  assert.equal(service.getSessionBackgroundActivity("s-1", "monologue"), null);
  assert.deepEqual(events.slice(-3), [
    { type: "background", payload: { sessionId: "s-1", kind: "memory-generation", state: null } },
    { type: "background", payload: { sessionId: "s-1", kind: "character-memory-generation", state: null } },
    { type: "background", payload: { sessionId: "s-1", kind: "monologue", state: null } },
  ]);
});
