import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeCodexTokenUsage,
  normalizeCopilotTokenUsage,
} from "../../src-electron/provider-token-usage.js";

describe("provider token usage", () => {
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
});
