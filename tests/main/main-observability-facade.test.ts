import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderCodingAdapter } from "../../src-electron/providers/provider-runtime.js";
import { MainObservabilityFacade } from "../../src-electron/app/main-observability-facade.js";
import { SessionObservabilityService } from "../../src-electron/session/session-observability-service.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";

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
// claim = "有効化したOpenCodeのquota取得が未対応なら、実adapterのnull結果を残量なしのunsupportedとして公開する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "OpenCodeをpoll対象から除外するか、未対応の取得結果をreadyや残量の数値へ変換する"
// observable = "実OpenCode adapterの取得回数と、Main cacheが公開するstatus、updatedAt、snapshots、rateLimits"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota facade lifecycle"
// lifecycle = "permanent"
// impact = "取得不能を有効な残量と誤表示してprovider選択や利用判断を誤らせる"
// distinction = "実adapterとMainのpolling/cache経路を通し、nullがrenderer向けのunsupported状態となる境界を検証する"
// @end-test-value
test("OpenCode quotaの未対応を実adapterからMain cacheへ投影する", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const service = createService();
  t.after(() => service.dispose());
  const settings = createDefaultAppSettings();
  settings.codingProviderSettings.codex.enabled = false;
  settings.codingProviderSettings.opencode = { enabled: true, apiKey: "", skillRootPath: "" };
  const adapter = new OpenCodeAdapter();
  const fetchQuota = t.mock.method(adapter, "getProviderQuotaTelemetry");
  const facade = new MainObservabilityFacade({
    getSessionObservabilityService: () => service,
    getAppSettings: () => settings,
    providerQuotaStaleTtlMs: 1,
    getProviderCodingAdapter: () => adapter,
  });
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(1); await flush();
  assert.equal(fetchQuota.mock.callCount(), 1);
  const unsupported = { provider: "opencode", updatedAt: null, snapshots: [], status: "unsupported" };
  assert.deepEqual(await facade.getOrRefreshProviderQuotaTelemetry("opencode"), unsupported);
  assert.equal(fetchQuota.mock.callCount(), 1);
  t.mock.timers.tick(300000); await flush();
  assert.equal(fetchQuota.mock.callCount(), 2);
  assert.deepEqual(facade.getProviderQuotaTelemetry("opencode"), unsupported);
  settings.codingProviderSettings.opencode.enabled = false;
  facade.configureProviderQuotaPolling(settings);
  t.mock.timers.tick(600000); await flush();
  assert.equal(fetchQuota.mock.callCount(), 2);
  assert.equal(await facade.getOrRefreshProviderQuotaTelemetry("opencode"), null);
});

// @test-value v2
// kind = "contract"
// claim = "共通残量UIのcacheOnly読取はCopilotもremote取得せず、既存の通常読取はstale時に更新できる"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md#共通の残量表示" }
// fault = "cacheOnlyを無視してWindow追加でprovider取得を増やすか、通常のCopilot読取までcacheOnlyにする"
// observable = "cache空時・stale時の返値とadapter呼出回数、通常読取後の返値"
// observation_boundary = "public-boundary"
// scope = "Main quota cacheOnly / Copilot refresh boundary"
// lifecycle = "permanent"
// impact = "Window数に比例したproviderアクセス、または既存Copilot残量更新の停止を招く"
// distinction = "renderer mockではMainのremote取得抑止と通常経路の維持を観測できない"
// @end-test-value
test("quota cacheOnlyはCopilotのremote更新を増やさず通常readを維持する", async (t) => {
  const service = createService();
  t.after(() => service.dispose());
  let calls = 0;
  const fresh = { provider: "copilot", updatedAt: new Date().toISOString(), snapshots: [] };
  const facade = new MainObservabilityFacade({
    getSessionObservabilityService: () => service,
    getAppSettings: () => createDefaultAppSettings(),
    getProviderCodingAdapter: () => ({
      composePrompt() { throw new Error("not used"); },
      async invalidateSessionThread() {},
      async invalidateAllSessionThreads() {},
      async runSessionTurn() { throw new Error("not used"); },
      getProviderQuotaTelemetry: async () => { calls++; return fresh; },
    } satisfies ProviderCodingAdapter),
    providerQuotaStaleTtlMs: 0,
  });
  assert.equal(await facade.getOrRefreshProviderQuotaTelemetry("copilot", { cacheOnly: true }), null);
  const stale = { ...fresh, updatedAt: "2000-01-01T00:00:00Z" };
  facade.setProviderQuotaTelemetry("copilot", stale);
  assert.deepEqual(await facade.getOrRefreshProviderQuotaTelemetry("copilot", { cacheOnly: true }), stale);
  assert.equal(calls, 0);
  assert.deepEqual(await facade.getOrRefreshProviderQuotaTelemetry("copilot"), fresh);
  assert.equal(calls, 1);
});

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
