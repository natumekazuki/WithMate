import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getProviderTokenUsageConfidence,
  normalizeCodexTokenUsage,
  normalizeCopilotTokenUsage,
} from "../../src-electron/provider-token-usage.js";

describe("provider token usage", () => {
  // @test-value v2
  // kind = "invariant"
  // claim = "providerが明示したtotal tokenだけをreportedとし、componentから補完した合計はestimated、usage欠落はunknownとして区別できる"
  // oracle = { type = "contract", ref = "docs/plans/20260830-agent-autonomy-capability-expansion/designs/08-resource-budget.md#Budget-model" }
  // fault = "欠落tokenを0としてreported扱いする、またはprovider明示totalと推定合計を区別できない"
  // observable = "normalized usageに対応するconfidence"
  // observation_boundary = "component-behavior"
  // scope = "provider-token-usage-confidence"
  // lifecycle = "permanent"
  // distinction = "audit用数値projectionを維持しながらbudget ledgerへ渡す根拠の強さを別途観測する"
  // @end-test-value
  it("token usageのreported / estimated / unknownを区別する", () => {
    const reported = normalizeCopilotTokenUsage({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    const estimated = normalizeCopilotTokenUsage({ inputTokens: 8, outputTokens: 2 });

    assert.equal(getProviderTokenUsageConfidence(reported), "reported");
    assert.equal(getProviderTokenUsageConfidence(estimated), "estimated");
    assert.equal(getProviderTokenUsageConfidence(null), null);
  });

  it("Codex usage を共通形式へ正規化する", () => {
    assert.deepEqual(
      normalizeCodexTokenUsage({
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 25,
        reasoning_output_tokens: 5,
      }),
      {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        totalTokens: 125,
      },
    );
  });

  it("Copilot assistant.usage を共通形式へ正規化する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 80,
        cacheReadTokens: 12,
        outputTokens: 20,
      }),
      {
        inputTokens: 80,
        cachedInputTokens: 12,
        outputTokens: 20,
        totalTokens: 100,
      },
    );
  });

  it("usage event に token 情報がない場合は null にする", () => {
    assert.equal(normalizeCodexTokenUsage({}), null);
    assert.equal(normalizeCopilotTokenUsage({}), null);
    assert.equal(normalizeCodexTokenUsage(null), null);
    assert.equal(normalizeCopilotTokenUsage(null), null);
  });

  it("Copilot の新旧 cache token field を受け取れる", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 10,
        cachedInputTokens: 3,
        cacheReadTokens: 1,
        outputTokens: 2,
        totalTokens: 15,
      }),
      {
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 2,
        totalTokens: 15,
      },
    );
  });

  it("Copilot の reasoningTokens を共通 reasoningOutputTokens に正規化する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 30,
        outputTokens: 7,
        reasoningTokens: 4,
      }),
      {
        inputTokens: 30,
        cachedInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 4,
        totalTokens: 37,
      },
    );
  });

  it("Copilot の cacheReadTokens と reasoningTokens を同時に受け取っても reasoningTokens を正規化する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 30,
        cacheReadTokens: 12,
        outputTokens: 7,
        reasoningTokens: 4,
      }),
      {
        inputTokens: 30,
        cachedInputTokens: 12,
        outputTokens: 7,
        reasoningOutputTokens: 4,
        totalTokens: 37,
      },
    );
  });

  it("Copilot の reasoningOutputTokens がある場合は reasoningTokens より優先する", () => {
    assert.deepEqual(
      normalizeCopilotTokenUsage({
        inputTokens: 30,
        outputTokens: 7,
        reasoningTokens: 4,
        reasoningOutputTokens: 9,
      }),
      {
        inputTokens: 30,
        cachedInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 9,
        totalTokens: 37,
      },
    );
  });
});
