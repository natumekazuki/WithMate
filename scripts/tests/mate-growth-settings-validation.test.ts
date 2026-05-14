import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { validateMateGrowthSettingsAgainstModelCatalog } from "../../src-electron/mate-growth-settings-validation.js";

describe("validateMateGrowthSettingsAgainstModelCatalog", () => {
  const snapshot: ModelCatalogSnapshot = {
    revision: 1,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["medium", "high"] },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", reasoningEfforts: ["low", "medium"] },
        ],
      },
    ],
  };

  it("model catalog に存在する provider / model / depth を許可する", () => {
    assert.doesNotThrow(() =>
      validateMateGrowthSettingsAgainstModelCatalog({
        modelPreferences: [{
          purpose: "memory_candidate",
          provider: "codex",
          model: "gpt-5.4",
          depth: "high",
        }],
      }, snapshot)
    );
  });

  it("未知の provider / model / depth を拒否する", () => {
    assert.throws(
      () =>
        validateMateGrowthSettingsAgainstModelCatalog({
          modelPreferences: [{
            purpose: "memory_candidate",
            provider: "unknown",
            model: "gpt-5.4",
            depth: "high",
          }],
        }, snapshot),
      /provider/,
    );

    assert.throws(
      () =>
        validateMateGrowthSettingsAgainstModelCatalog({
          modelPreferences: [{
            purpose: "memory_candidate",
            provider: "codex",
            model: "unknown-model",
            depth: "high",
          }],
        }, snapshot),
      /selected model/,
    );

    assert.throws(
      () =>
        validateMateGrowthSettingsAgainstModelCatalog({
          modelPreferences: [{
            purpose: "memory_candidate",
            provider: "codex",
            model: "gpt-5.4-mini",
            depth: "high",
          }],
        }, snapshot),
      /selected depth/,
    );
  });
});
