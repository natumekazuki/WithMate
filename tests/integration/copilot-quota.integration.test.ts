import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCopilotProviderQuotaTelemetry,
  readCopilotQuotaSnapshots,
} from "../../src-electron/providers/copilot/copilot-quota-telemetry.js";
import { projectQuotaRemaining } from "../../src/provider-usage/provider-quota-projection.js";
import { buildCopilotQuotaProjection } from "../../src/chat/runtime/session-ui-projection.js";

// @test-value v2
// kind = "contract"
// claim = "Copilotの非有限残率はadapterから両表示projectionまで不明として届き、正常な0%と0-1/0-100の残率・件数・resetを維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/842" }
// fault = "adapterが非有限残率を0へ変換する、Copilot UsageがNaN/Infinityを割合として表示する、または有限残率を誤変換する"
// observable = "正規化したsnapshotと共通残量表示・Copilot Usageの残率、件数、reset表示"
// observation_boundary = "consumer"
// scope = "Copilot quota snapshot読取・telemetry正規化からprojectQuotaRemainingとbuildCopilotQuotaProjectionまで"
// lifecycle = "permanent"
// impact = "利用者が不明な残量を枯渇と誤認するか、有効な残率や件数を判断できなくなる"
// distinction = "rendererへ直接NaNを渡す既存testはadapterによる0変換を検出できず、型検査では数値の有限性を保証できない。小さい入力表で両表示経路を継続検証する"
// @end-test-value
test("Copilot quotaは非有限残率と正常な残率をadapterから表示まで区別する", () => {
  const cases = [
    [NaN, NaN, "—", "unavailable"],
    [Infinity, Infinity, "—", "unavailable"],
    [-Infinity, -Infinity, "—", "unavailable"],
    [0, 0, "0%", "0% left"],
    [0.75, 75, "75%", "75% left"],
    [75, 75, "75%", "75% left"],
    [1, 100, "100%", "100% left"],
    [100, 100, "100%", "100% left"],
  ] as const;
  for (const [input, normalized, remaining, copilotRemaining] of cases) {
    const snapshot = {
      entitlementRequests: 500,
      usedRequests: 125,
      remainingPercentage: input,
      overage: 3,
      overageAllowedWithExhaustedQuota: true,
      resetDate: "2026-10-20T00:00:00.000Z",
    };
    const telemetry = buildCopilotProviderQuotaTelemetry(
      "copilot",
      readCopilotQuotaSnapshots({ quotaSnapshots: { premium_interactions: snapshot } }),
      "2026-10-19T00:00:00.000Z",
    );
    assert.deepEqual(telemetry, {
      provider: "copilot",
      updatedAt: "2026-10-19T00:00:00.000Z",
      snapshots: [{ ...snapshot, quotaKey: "premium_interactions", remainingPercentage: normalized }],
    });
    assert.deepEqual(projectQuotaRemaining(telemetry), [{
      key: "premium_interactions",
      label: "Premium",
      remaining,
      resetDate: snapshot.resetDate,
      summary: true,
    }]);
    const copilot = buildCopilotQuotaProjection(telemetry);
    assert.equal(copilot.remainingPercentLabel, copilotRemaining);
    assert.equal(copilot.remainingRequestsLabel, "375 / 500 requests left");
    assert.match(copilot.resetLabel, /\d{2}\/\d{2}, \d{2}:\d{2} [AP]M/);
  }
});
