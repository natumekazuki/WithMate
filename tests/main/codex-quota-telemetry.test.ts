import assert from "node:assert/strict";
import { it } from "node:test";
import { projectCodexQuotaTelemetry } from "../../src-electron/providers/codex/codex-quota-telemetry.js";

// @test-value v2
// kind = "contract"
// claim = "Codex quotaは複数bucketを優先し動的windowとresetを保持し、欠落値を推測しない"
// oracle = { type = "contract", ref = "https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt; Issue #827" }
// fault = "single bucketを重複追加する、固定windowを使う、または欠落resetを生成する"
// observable = "quota projectionのrateLimitsとsnapshots"
// observation_boundary = "component-behavior"
// scope = "Codex account rate limitsから共通telemetryへの投影"
// lifecycle = "permanent"
// impact = "利用者が別bucketの残量やreset時刻を誤認する"
// distinction = "外部応答の動的値と欠落は型検査で保証されず、小さい純粋fixtureで検出できる"
// @end-test-value
it("Codex quotaは複数bucketを優先して未知の値を生成しない", () => {
  const result = projectCodexQuotaTelemetry({
    rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 0, windowDurationMins: 15, resetsAt: 1730947200 }, secondary: { usedPercent: 100 } },
      other: { primary: { usedPercent: 42, windowDurationMins: 60 }, secondary: null },
    },
  }, "codex");
  assert.deepEqual(result.rateLimits, [
    { quotaKey: "codex:primary", label: "Codex", usedPercentage: 0, windowDurationMinutes: 15, resetDate: "2024-11-07T02:40:00.000Z" },
    { quotaKey: "codex:secondary", label: "Codex", usedPercentage: 100 },
    { quotaKey: "other:primary", usedPercentage: 42, windowDurationMinutes: 60 },
  ]);
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.status, "ready");
  assert.deepEqual(projectCodexQuotaTelemetry({ rateLimits: { primary: null, secondary: null } }, "codex").rateLimits, []);
});

// @test-value v2
// kind = "invariant"
// claim = "Codexの不正quota応答は正常値へ補正せず失敗する"
// oracle = { type = "contract", ref = "Issue #827; https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt" }
// fault = "不正応答を空quotaや0%へ変換する"
// observable = "quota projectionが投げる例外"
// observation_boundary = "component-behavior"
// scope = "外部Codex quota応答のruntime検証"
// lifecycle = "permanent"
// impact = "不正な残量やresetが正常に見え、利用可否の判断を誤る"
// distinction = "unknownなRPC応答の非有限値や範囲外値はTypeScript型検査では防げない"
// @end-test-value
it("Codex quotaの不正な応答と数値を拒否する", () => {
  for (const response of [null, {}, { rateLimits: {} }, { rateLimitsByLimitId: [] },
    ...[-1, 101, NaN, Infinity, "25", undefined].map(usedPercent => ({ rateLimits: { primary: { usedPercent } } })),
    { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 0 } } },
    { rateLimits: { primary: { usedPercent: 20, resetsAt: Infinity } } },
    { rateLimitsByLimitId: { codex: { limitId: "other", primary: null } } },
  ]) assert.throws(() => projectCodexQuotaTelemetry(response, "codex"), /Invalid Codex rate limits/);
});
