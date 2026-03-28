import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderCodingAdapter } from "../../src-electron/provider-runtime.js";
import { MainObservabilityFacade } from "../../src-electron/main-observability-facade.js";
import { SessionObservabilityService } from "../../src-electron/session-observability-service.js";

function createService() {
  return new SessionObservabilityService({
    onProviderQuotaTelemetryChanged() {},
    onSessionContextTelemetryChanged() {},
    onSessionBackgroundActivityChanged() {},
    onLiveSessionRunChanged() {},
  });
}

test("MainObservabilityFacade は observability service を透過し quota refresh を helper 経由で行う", async () => {
  const service = createService();
  const calls: string[] = [];
  const adapter = {
    composePrompt() {
      throw new Error("not used");
    },
    async getProviderQuotaTelemetry(input) {
      calls.push(`${input.providerId}:${input.appSettings.providers.codex?.model ?? ""}`);
      return {
        provider: input.providerId,
        updatedAt: new Date().toISOString(),
        snapshots: [],
      };
    },
    async extractSessionMemoryDelta() {
      throw new Error("not used");
    },
    async runCharacterReflection() {
      throw new Error("not used");
    },
    invalidateSessionThread() {},
    invalidateAllSessionThreads() {},
    async runSessionTurn() {
      throw new Error("not used");
    },
  } satisfies ProviderCodingAdapter;

  const facade = new MainObservabilityFacade({
    getSessionObservabilityService: () => service,
    getAppSettings: () =>
      ({
        providers: { codex: { model: "gpt-5.4" } },
        codingProviderSettings: {},
        memoryExtractionProviderSettings: {},
        characterReflectionProviderSettings: {},
      }) as never,
    getProviderCodingAdapter() {
      return adapter;
    },
    providerQuotaStaleTtlMs: 1000,
  });

  const refreshed = await facade.refreshProviderQuotaTelemetry("codex");
  facade.setSessionContextTelemetry("s-1", {
    provider: "copilot",
    sessionId: "s-1",
    updatedAt: new Date().toISOString(),
    tokenLimit: 1000,
    currentTokens: 200,
    messagesLength: 4,
  });
  facade.setSessionBackgroundActivity("s-1", "memory-generation", {
    kind: "memory-generation",
    status: "running",
    updatedAt: new Date().toISOString(),
    summary: "running",
  });

  assert.equal(refreshed?.provider, "codex");
  assert.equal(facade.getProviderQuotaTelemetry("codex")?.provider, "codex");
  assert.equal(facade.getSessionContextTelemetry("s-1")?.currentTokens, 200);
  assert.equal(facade.getSessionBackgroundActivity("s-1", "memory-generation")?.status, "running");
  assert.deepEqual(calls, ["codex:gpt-5.4"]);
});
