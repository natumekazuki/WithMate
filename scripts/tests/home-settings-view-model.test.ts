import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import {
  buildPersistedAppSettingsFromRows,
  buildHomeProviderSettingRows,
  buildNormalizedCharacterReflectionProviderSettings,
  buildNormalizedMemoryExtractionProviderSettings,
} from "../../src/home-settings-view-model.js";

function createSnapshot(): ModelCatalogSnapshot {
  return {
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
}

describe("home-settings-view-model", () => {
  it("provider row は model / reasoning の resolved 値を持つ", () => {
    const settings = createDefaultAppSettings();
    settings.memoryExtractionProviderSettings.codex = {
      model: "missing-model",
      reasoningEffort: "high",
      outputTokensThreshold: 222,
    };
    settings.characterReflectionProviderSettings.codex = {
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    };

    const rows = buildHomeProviderSettingRows(createSnapshot(), settings);

    assert.equal(rows[0]?.resolvedMemoryExtractionModel, "gpt-5.4");
    assert.equal(rows[0]?.resolvedMemoryExtractionReasoningEffort, "high");
    assert.equal(rows[0]?.resolvedCharacterReflectionModel, "gpt-5.4-mini");
    assert.equal(rows[0]?.resolvedCharacterReflectionReasoningEffort, "low");
  });

  it("normalized settings は resolved 値を provider ごとに再構成する", () => {
    const rows = buildHomeProviderSettingRows(createSnapshot(), createDefaultAppSettings());

    assert.deepEqual(buildNormalizedMemoryExtractionProviderSettings(rows), {
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        outputTokensThreshold: 200,
      },
    });
    assert.deepEqual(buildNormalizedCharacterReflectionProviderSettings(rows), {
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
    });
  });

  it("persisted settings は draft の system prompt を維持したまま resolved provider settings を埋め込む", () => {
    const draft = createDefaultAppSettings();
    draft.systemPromptPrefix = "prefix";
    draft.memoryExtractionProviderSettings.codex = {
      model: "missing-model",
      reasoningEffort: "high",
      outputTokensThreshold: 333,
    };

    const rows = buildHomeProviderSettingRows(createSnapshot(), draft);
    const persisted = buildPersistedAppSettingsFromRows(draft, rows);

    assert.equal(persisted.systemPromptPrefix, "prefix");
    assert.deepEqual(persisted.memoryExtractionProviderSettings.codex, {
      model: "gpt-5.4",
      reasoningEffort: "high",
      outputTokensThreshold: 333,
    });
  });
});
