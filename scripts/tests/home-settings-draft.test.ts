import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/app-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  updateCharacterReflectionModel,
  updateCharacterReflectionReasoningEffort,
  updateCodingProviderApiKey,
  updateCodingProviderEnabled,
  updateCodingProviderSkillRootPath,
  updateMemoryExtractionModel,
  updateMemoryExtractionReasoningEffort,
  updateMemoryExtractionThreshold,
} from "../../src/home-settings-draft.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["medium", "high"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      reasoningEfforts: ["low", "medium"],
    },
  ],
};

describe("home-settings-draft", () => {
  it("coding provider draft を更新できる", () => {
    const draft = createDefaultAppSettings();

    const enabled = updateCodingProviderEnabled(draft, "codex", false);
    const apiKey = updateCodingProviderApiKey(
      { ...draft, codingProviderSettings: enabled },
      "codex",
      "next-key",
    );
    const skillRootPath = updateCodingProviderSkillRootPath(
      { ...draft, codingProviderSettings: apiKey },
      "codex",
      "C:/skills",
    );

    assert.equal(skillRootPath.codex.enabled, false);
    assert.equal(skillRootPath.codex.apiKey, "next-key");
    assert.equal(skillRootPath.codex.skillRootPath, "C:/skills");
  });

  it("memory extraction model 更新時に resolved selection を返す", () => {
    const draft = createDefaultAppSettings();
    draft.memoryExtractionProviderSettings.codex = {
      model: "gpt-5.4",
      reasoningEffort: "high",
      outputTokensThreshold: 200,
    };

    const next = updateMemoryExtractionModel(draft, providerCatalog, "codex", "gpt-5.4-mini");

    assert.equal(next.codex.model, "gpt-5.4-mini");
    assert.equal(next.codex.reasoningEffort, "low");
  });

  it("memory extraction threshold は 1 未満を 1 に丸める", () => {
    const draft = createDefaultAppSettings();

    const nextReasoning = updateMemoryExtractionReasoningEffort(draft, "codex", "medium");
    const nextThreshold = updateMemoryExtractionThreshold(
      { ...draft, memoryExtractionProviderSettings: nextReasoning },
      "codex",
      "0",
    );

    assert.equal(nextThreshold.codex.reasoningEffort, "medium");
    assert.equal(nextThreshold.codex.outputTokensThreshold, 1);
  });

  it("character reflection model / reasoning を更新できる", () => {
    const draft = createDefaultAppSettings();
    draft.characterReflectionProviderSettings.codex = {
      model: "gpt-5.4",
      reasoningEffort: "high",
    };

    const nextModel = updateCharacterReflectionModel(draft, providerCatalog, "codex", "gpt-5.4-mini");
    const nextReasoning = updateCharacterReflectionReasoningEffort(
      { ...draft, characterReflectionProviderSettings: nextModel },
      "codex",
      "medium",
    );

    assert.equal(nextModel.codex.model, "gpt-5.4-mini");
    assert.equal(nextModel.codex.reasoningEffort, "low");
    assert.equal(nextReasoning.codex.reasoningEffort, "medium");
  });
});
