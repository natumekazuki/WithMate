import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { MainObservabilityFacade } from "../../src-electron/app/main-observability-facade.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

function createService() {
  return new SessionObservabilityService({
    onProviderQuotaTelemetryChanged() {},
    onSessionContextTelemetryChanged() {},
    onSessionBackgroundActivityChanged() {},
    onLiveSessionRunChanged() {},
  });
}

// @test-value v2
// kind = "contract"
// claim = "有効providerだけを起動/設定変更時に取得し、無効化で停止し、Window取得はcache参照だけになる"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "無効providerを起動するか、認証変更で旧値を残すか、Window読取ごとに取得する"
// observable = "providerと認証設定ごとのadapter呼出し、設定変更直後とWindow取得結果"
// observation_boundary = "public-boundary"
// scope = "Main quota settings and window boundary"
// lifecycle = "permanent"
// impact = "意図しない認証先へのアクセスや別accountの残量表示を招く"
// distinction = "service単体では設定とadapterへの接続を通らず、mock clockで呼出し回数を直接確認する"
// @end-test-value
test("Main quotaは有効化と認証変更を反映しWindowから再取得しない", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const service = createService();
  t.after(() => service.dispose());
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.claude = { ...settings.codingProviderSettings.codex, enabled: false };
  const calls: Array<[string, string]> = [];
  const facade = new MainObservabilityFacade({
    getSessionObservabilityService: () => service,
    getAppSettings: () => settings,
    getProviderCodingAdapter: () => ({
      composePrompt() { throw new Error("not used"); },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() { throw new Error("not used"); },
      async getProviderQuotaTelemetry(input) {
        calls.push([input.providerId, input.appSettings.codingProviderSettings[input.providerId].apiKey]);
        return { provider: input.providerId, updatedAt: new Date().toISOString(), snapshots: [], status: "ready" };
      },
    } satisfies ProviderCodingAdapter),
    providerQuotaStaleTtlMs: 1,
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  facade.configureProviderQuotaPolling(settings);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(calls.map(([id]) => id), ["codex"]);
  t.mock.timers.tick(100);
  const cached = service.getProviderQuotaTelemetry("codex");
  assert.equal(await facade.getOrRefreshProviderQuotaTelemetry("codex"), cached);
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 1);
  settings.codingProviderSettings.claude.enabled = true;
  settings.codingProviderSettings.codex.apiKey = "changed-fixture";
  facade.configureProviderQuotaPolling(settings);
  assert.equal(service.getProviderQuotaTelemetry("codex"), null);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(calls.slice(1), [["codex", "changed-fixture"], ["claude", ""]]);
  settings.codingProviderSettings.codex.enabled = false;
  settings.codingProviderSettings.claude.enabled = false;
  facade.configureProviderQuotaPolling(settings);
  facade.scheduleProviderQuotaTelemetryRefresh("codex", [3000]);
  t.mock.timers.tick(600000); await flush();
  assert.equal(calls.length, 3);
  assert.equal(await facade.getOrRefreshProviderQuotaTelemetry("codex"), null);
  service.clearAllProviderQuotaTelemetry();
  settings.codingProviderSettings.codex.enabled = true;
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 4);
});

// @test-value v2
// kind = "contract"
// claim = "MainObservabilityFacadeがquota更新とsession observability stateをserviceへ委譲する"
// oracle = { type = "contract", ref = "src-electron/app/main-observability-facade.ts" }
// fault = "provider quotaまたはbackground activityがfacade境界で欠落・誤変換される"
// observable = "adapterへのquota入力とserviceから取得したtelemetry state"
// observation_boundary = "public-boundary"
// scope = "main-observability-facade"
// lifecycle = "permanent"
// @end-test-value
test("MainObservabilityFacade は observability service を透過し quota refresh を helper 経由で行う", async () => {
  const service = createService();
  const appSettings = createDefaultAppSettings();
  appSettings.codingProviderSettings.codex.apiKey = "quota-settings-fixture";
  const calls: Parameters<ProviderCodingAdapter["getProviderQuotaTelemetry"]>[0][] = [];
  const adapterProviderIds: Array<string | null | undefined> = [];
  const adapter = {
    composePrompt() {
      throw new Error("not used");
    },
    async getProviderQuotaTelemetry(input) {
      calls.push(input);
      return {
        provider: input.providerId,
        updatedAt: new Date().toISOString(),
        snapshots: [],
      };
    },
    async invalidateSessionThread() {},
    async invalidateAllSessionThreads() {},
    async runSessionTurn() {
      throw new Error("not used");
    },
  } satisfies ProviderCodingAdapter;

  const facade = new MainObservabilityFacade({
    getSessionObservabilityService: () => service,
    getAppSettings: () => appSettings,
    getProviderCodingAdapter(providerId) {
      adapterProviderIds.push(providerId);
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
    sessionId: "s-1",
    status: "running",
    title: "Memory generation",
    updatedAt: new Date().toISOString(),
    summary: "running",
    errorMessage: "",
  });

  assert.equal(refreshed?.provider, "codex");
  assert.equal(facade.getProviderQuotaTelemetry("codex")?.provider, "codex");
  assert.equal(facade.getSessionContextTelemetry("s-1")?.currentTokens, 200);
  assert.equal(facade.getSessionBackgroundActivity("s-1", "memory-generation")?.status, "running");
  assert.deepEqual(calls.map(({ signal, ...input }) => input), [{ providerId: "codex", appSettings }]);
  assert.equal(calls[0]?.signal?.aborted, false);
  assert.deepEqual(adapterProviderIds, ["codex"]);
});
