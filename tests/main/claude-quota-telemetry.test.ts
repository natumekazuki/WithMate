import assert from "node:assert/strict";
import { it } from "node:test";
import { projectClaudeQuotaTelemetry } from "../../src-electron/providers/claude/claude-quota-telemetry.js";

// @test-value v2
// kind = "contract"
// claim = "Claudeの既知利用窓とモデル窓を0..100の使用率として投影し、null resetを捏造しない"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "窓を落とす、使用率を逆転する、または不明resetを補完する"
// observable = "projectClaudeQuotaTelemetryのrateLimitsとstatus"
// observation_boundary = "component-behavior"
// scope = "Claude control usage projection"
// lifecycle = "permanent"
// distinction = "SDK型検査ではruntime応答から共通型への値変換を保証できない"
// @end-test-value
it("projects Claude plan and model windows without invented reset dates", () => {
  const keys = ["five_hour", "seven_day", "seven_day_oauth_apps", "seven_day_opus", "seven_day_sonnet"];
  const telemetry = projectClaudeQuotaTelemetry({ rate_limits_available: true, rate_limits: {
    ...Object.fromEntries(keys.map((key, index) => [key, { utilization: index * 25, resets_at: null }])),
    model_scoped: [{ display_name: "Fable", utilization: 32, resets_at: "2026-10-18T00:00:00Z" }],
    extra_usage: { utilization: 50, used_credits: 12, monthly_limit: 20 },
  } });
  assert.equal(telemetry?.status, "ready");
  assert.deepEqual(telemetry?.snapshots, []);
  assert.deepEqual(telemetry?.rateLimits?.map(({ quotaKey, usedPercentage, resetDate, windowDurationMinutes }) => ({ quotaKey, usedPercentage, resetDate, windowDurationMinutes })), [
    ...keys.map((quotaKey, index) => ({ quotaKey, usedPercentage: index * 25, resetDate: undefined, windowDurationMinutes: index ? 10_080 : 300 })),
    { quotaKey: "model_scoped:Fable", usedPercentage: 32, resetDate: "2026-10-18T00:00:00Z", windowDurationMinutes: 10_080 },
  ]);
});

// @test-value v2
// kind = "contract"
// claim = "Claudeの未対応はnull、不正な利用可能応答は失敗として区別する"
// oracle = { type = "contract", ref = "docs/design/provider-usage-telemetry.md" }
// fault = "不正なusage応答を正常emptyや0%として公開する"
// observable = "projectionのnull戻り値またはthrow"
// observation_boundary = "component-behavior"
// scope = "Claude quota malformed response boundary"
// lifecycle = "permanent"
// distinction = "外部SDKのruntimeデータはTypeScriptの型だけでは検証できない"
// @end-test-value
it("distinguishes unsupported Claude accounts from malformed available limits", () => {
  assert.equal(projectClaudeQuotaTelemetry({ rate_limits_available: false, rate_limits: null }), null);
  for (const rate_limits of [null, {}, { five_hour: { utilization: null, resets_at: null } },
    ...[-1, 101, NaN, Infinity, "50"].map((utilization) => ({ five_hour: { utilization, resets_at: null } })),
    { five_hour: { utilization: 50, resets_at: "invalid" } }, { model_scoped: {} }]) {
    assert.throws(() => projectClaudeQuotaTelemetry({ rate_limits_available: true, rate_limits }));
  }
});
