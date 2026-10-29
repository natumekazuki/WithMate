import assert from "node:assert/strict";
import test from "node:test";
import type { ExperimentalUsageLimitsOutput, OpenCodeClient } from "@opencode/client";
import { OpenCodeAdapter } from "../../src-electron/providers/opencode/opencode-adapter.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";

// @test-value v2
// kind = "contract"
// claim = "OpenCodeのnative取得はGoの3窓だけを投影し、正常な枠なしと取得失敗を区別して保存keyで認証を上書きしない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "Console予算をGoへ混入、使用率を反転、月間を30日固定、枠なしを失敗または失敗を枠なしに変換、保存keyを注入する"
// observable = "公開adapterのtelemetry/null/error、native取得のlocation/signal、transport環境とclose回数"
// observation_boundary = "public-boundary"
// scope = "OpenCode Go quota取得と共通telemetryへの投影"
// lifecycle = "permanent"
// impact = "利用者がGo以外の予算や取得失敗を有効な残量と誤認する"
// distinction = "SDK型はWithMateの認証引数・projection・失敗と適用外の写像を検査しない"
// @end-test-value
test("OpenCode quotaはnative認証でGo枠だけを返し枠なしと失敗を区別する", async () => {
  const appSettings = createDefaultAppSettings();
  appSettings.codingProviderSettings.opencode = { enabled: true, apiKey: "synthetic-unused-setting", skillRootPath: "" };
  const reset = Date.parse("2026-11-01T00:00:00Z");
  let data = { workspace: { id: "workspace", usageURL: "https://example.invalid/usage" },
    go: { rolling: { percent: 0, limited: false, resetsAt: reset }, weekly: { percent: 25.5, limited: false, resetsAt: reset },
      monthly: { percent: 100, limited: true, resetsAt: reset } },
    budgets: [{ id: "not-go", spent: 99, limit: 100 }],
  } as ExperimentalUsageLimitsOutput["data"];
  let failure = false;
  let closed = 0;
  const client = { experimental: { usage: { limits: async (request, options) => {
    assert.deepEqual(request, { location: { directory: process.cwd() } });
    assert.ok(options?.signal instanceof AbortSignal);
    if (failure) throw new Error("synthetic-private-credential");
    return { location: { directory: process.cwd() }, data };
  } } } } as OpenCodeClient;
  const adapter = new OpenCodeAdapter({ createTransport: (options) => {
    assert.equal(options.cwd, process.cwd());
    assert.equal(options.databasePath, undefined);
    assert.equal(options.env?.OPENCODE_API_KEY, process.env.OPENCODE_API_KEY);
    assert.ok(!Object.values(options.env ?? {}).includes("synthetic-unused-setting"));
    return { start: async () => client, close: async () => { closed++; }, whenClosed: () => Promise.resolve() };
  } });
  const input = { providerId: "opencode", appSettings };
  const telemetry = await adapter.getProviderQuotaTelemetry(input);
  assert.equal(telemetry?.provider, "opencode");
  assert.equal(telemetry?.status, "ready");
  assert.ok(Number.isFinite(Date.parse(telemetry!.updatedAt!)));
  assert.deepEqual(telemetry?.snapshots, []);
  assert.deepEqual(telemetry?.rateLimits, [
    { quotaKey: "rolling", label: "5h", usedPercentage: 0, resetDate: "2026-11-01T00:00:00.000Z", windowDurationMinutes: 300 },
    { quotaKey: "weekly", label: "7d", usedPercentage: 25.5, resetDate: "2026-11-01T00:00:00.000Z", windowDurationMinutes: 10080 },
    { quotaKey: "monthly", label: "Monthly", usedPercentage: 100, resetDate: "2026-11-01T00:00:00.000Z" },
  ]);
  const valid = data!;
  data = { ...valid, go: undefined };
  assert.equal(await adapter.getProviderQuotaTelemetry(input), null);
  data = null;
  assert.equal(await adapter.getProviderQuotaTelemetry(input), null);
  failure = true;
  await assert.rejects(adapter.getProviderQuotaTelemetry(input), { message: "OpenCode Go quota could not be retrieved" });
  failure = false;
  for (const meter of [{ ...valid.go!.rolling, percent: 101 }, { ...valid.go!.rolling, resetsAt: 1e20 }]) {
    data = { ...valid, go: { ...valid.go!, rolling: meter } };
    await assert.rejects(adapter.getProviderQuotaTelemetry(input), { message: "OpenCode Go quota could not be retrieved" });
  }
  assert.equal(closed, 6);
});

// @test-value v2
// kind = "contract"
// claim = "Go quotaはabortで取得を打ち切ってprocessを閉じ、cleanup未確認なら同workspaceの再起動を阻止する"
// oracle = { type = "contract", ref = "docs/design/provider-adapter.md" }
// fault = "cancelを無視した結果を返すか、close失敗後のprocessを残して次の取得を起動する"
// observable = "中断時のreject/close、cleanup完了前後の取得可否とtransport生成数"
// observation_boundary = "public-boundary"
// scope = "OpenCode quota cancellation/owned process cleanup"
// lifecycle = "permanent"
// distinction = "transport単体ではadapterのsignal伝播、finallyとworkspace guardを確認できない"
// @end-test-value
test("OpenCode quotaは中断と未完了cleanupを成功扱いしない", async () => {
  const controller = new AbortController();
  const input = { providerId: "opencode", appSettings: createDefaultAppSettings() };
  let created = 0; let closed = 0; let failClose = false;
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  let onRead = () => controller.abort();
  const client = { experimental: { usage: { limits: async () => { onRead(); return { data: null }; } } } } as unknown as OpenCodeClient;
  const adapter = new OpenCodeAdapter({ createTransport: () => {
    created++;
    return { start: async (signal) => { assert.ok(signal); return client; },
      close: async () => { closed++; if (failClose) throw new Error("still running"); }, whenClosed: () => completion };
  } });
  await assert.rejects(adapter.getProviderQuotaTelemetry({ ...input, signal: controller.signal }), /canceled/);
  assert.equal(closed, 1);
  await assert.rejects(adapter.getProviderQuotaTelemetry({ ...input, signal: controller.signal }));
  assert.equal(created, 1);
  onRead = () => {};
  failClose = true;
  await assert.rejects(adapter.getProviderQuotaTelemetry(input), /cleanup failed/);
  await assert.rejects(adapter.getProviderQuotaTelemetry(input), /terminating/);
  assert.equal(created, 2);
  release(); await completion;
  failClose = false;
  assert.equal(await adapter.getProviderQuotaTelemetry(input), null);
  assert.equal(created, 3);
  assert.equal(closed, 3);
});
