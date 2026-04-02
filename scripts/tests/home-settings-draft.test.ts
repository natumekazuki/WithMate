import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";
import {
  updateAutoCollapseActionDockOnSend,
  updateCharacterReflectionCharDeltaThreshold,
  updateCharacterReflectionCooldownSeconds,
  updateCharacterReflectionModel,
  updateCharacterReflectionModelDraft,
  updateCharacterReflectionMessageDeltaThreshold,
  updateCharacterReflectionReasoningEffort,
  updateCharacterReflectionReasoningEffortDraft,
  updateCharacterReflectionTimeoutSeconds,
  updateCharacterReflectionTimeoutSecondsDraft,
  updateCodingProviderApiKey,
  updateCodingProviderApiKeyDraft,
  updateCodingProviderEnabled,
  updateCodingProviderEnabledDraft,
  updateCodingProviderSkillRootPath,
  updateCodingProviderSkillRootPathDraft,
  updateMemoryExtractionModel,
  updateMemoryExtractionModelDraft,
  updateMemoryExtractionReasoningEffort,
  updateMemoryExtractionReasoningEffortDraft,
  updateMemoryExtractionThreshold,
  updateMemoryExtractionThresholdDraft,
  updateMemoryExtractionTimeoutSeconds,
  updateMemoryExtractionTimeoutSecondsDraft,
  updateMemoryGenerationEnabled,
  updateSystemPromptPrefix,
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
      outputTokensThreshold: 300000,
      timeoutSeconds: 180,
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

  it("memory extraction timeout は 1 未満を 30 に丸める", () => {
    const draft = createDefaultAppSettings();

    const nextTimeout = updateMemoryExtractionTimeoutSeconds(draft, "codex", "0");

    assert.equal(nextTimeout.codex.timeoutSeconds, 30);
  });

  it("memory extraction threshold の draft は大きい値もそのまま保持する", () => {
    const draft = createDefaultAppSettings();

    const nextThreshold = updateMemoryExtractionThreshold(draft, "codex", "300000");

    assert.equal(nextThreshold.codex.outputTokensThreshold, 300000);
  });

  it("character reflection model / reasoning を更新できる", () => {
    const draft = createDefaultAppSettings();
    draft.characterReflectionProviderSettings.codex = {
      model: "gpt-5.4",
      reasoningEffort: "high",
      timeoutSeconds: 180,
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

  it("character reflection timeout を更新できる", () => {
    const draft = createDefaultAppSettings();

    const nextTimeout = updateCharacterReflectionTimeoutSeconds(draft, "codex", "240");

    assert.equal(nextTimeout.codex.timeoutSeconds, 240);
  });

  it("character reflection trigger settings を更新できる", () => {
    const draft = createDefaultAppSettings();

    const nextCooldown = updateCharacterReflectionCooldownSeconds(draft, "180");
    const nextCharDelta = updateCharacterReflectionCharDeltaThreshold(nextCooldown, "600");
    const nextMessageDelta = updateCharacterReflectionMessageDeltaThreshold(nextCharDelta, "3");

    assert.deepEqual(nextMessageDelta.characterReflectionTriggerSettings, {
      cooldownSeconds: 180,
      charDeltaThreshold: 600,
      messageDeltaThreshold: 3,
    });
  });

  it("draft wrapper は AppSettings 全体を更新する", () => {
    const draft = createDefaultAppSettings();

    const next = updateCharacterReflectionReasoningEffortDraft(
      updateCharacterReflectionModelDraft(
        updateMemoryExtractionThresholdDraft(
          updateMemoryExtractionTimeoutSecondsDraft(
          updateMemoryExtractionReasoningEffortDraft(
            updateMemoryExtractionModelDraft(
              updateCodingProviderSkillRootPathDraft(
                updateCodingProviderApiKeyDraft(
                  updateCodingProviderEnabledDraft(
                    updateAutoCollapseActionDockOnSend(
                      updateMemoryGenerationEnabled(updateSystemPromptPrefix(draft, "prefix"), false),
                      false,
                    ),
                    "codex",
                    false,
                  ),
                  "codex",
                  "key",
                ),
                "codex",
                "C:/skills",
              ),
              providerCatalog,
              "codex",
              "gpt-5.4-mini",
            ),
            "codex",
            "medium",
          ),
          "codex",
          "240",
        ),
          "codex",
          "321",
        ),
        providerCatalog,
        "codex",
        "gpt-5.4-mini",
      ),
      "codex",
      "medium",
    );
    const nextWithTriggers = updateCharacterReflectionMessageDeltaThreshold(
      updateCharacterReflectionCharDeltaThreshold(
        updateCharacterReflectionCooldownSeconds(
          updateCharacterReflectionTimeoutSecondsDraft(next, "codex", "210"),
          "180",
        ),
        "600",
      ),
      "3",
    );

    assert.equal(nextWithTriggers.systemPromptPrefix, "prefix");
    assert.equal(nextWithTriggers.memoryGenerationEnabled, false);
    assert.equal(nextWithTriggers.autoCollapseActionDockOnSend, false);
    assert.equal(nextWithTriggers.codingProviderSettings.codex.enabled, false);
    assert.equal(nextWithTriggers.codingProviderSettings.codex.apiKey, "key");
    assert.equal(nextWithTriggers.codingProviderSettings.codex.skillRootPath, "C:/skills");
    assert.equal(nextWithTriggers.memoryExtractionProviderSettings.codex.outputTokensThreshold, 321);
    assert.equal(nextWithTriggers.memoryExtractionProviderSettings.codex.timeoutSeconds, 240);
    assert.equal(nextWithTriggers.characterReflectionProviderSettings.codex.reasoningEffort, "medium");
    assert.equal(nextWithTriggers.characterReflectionProviderSettings.codex.timeoutSeconds, 210);
    assert.equal(nextWithTriggers.characterReflectionTriggerSettings.cooldownSeconds, 180);
    assert.equal(nextWithTriggers.characterReflectionTriggerSettings.charDeltaThreshold, 600);
    assert.equal(nextWithTriggers.characterReflectionTriggerSettings.messageDeltaThreshold, 3);
  });

  it("action dock auto close を toggle できる", () => {
    const draft = createDefaultAppSettings();

    const next = updateAutoCollapseActionDockOnSend(draft, false);

    assert.equal(next.autoCollapseActionDockOnSend, false);
  });
});
