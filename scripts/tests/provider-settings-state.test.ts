import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD,
  normalizeAppSettings,
} from "../../src/provider-settings-state.js";

describe("provider-settings-state", () => {
  it("memory extraction threshold の default は 300000", () => {
    const settings = createDefaultAppSettings();

    assert.equal(DEFAULT_MEMORY_EXTRACTION_OUTPUT_TOKENS_THRESHOLD, 300000);
    assert.equal(settings.memoryExtractionProviderSettings.codex.outputTokensThreshold, 300000);
  });

  it("memory extraction threshold は normalize で 1000000 に clamp する", () => {
    const settings = normalizeAppSettings({
      memoryExtractionProviderSettings: {
        codex: {
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          outputTokensThreshold: 9000000,
        },
      },
    });

    assert.equal(settings.memoryExtractionProviderSettings.codex.outputTokensThreshold, 1000000);
  });
});
