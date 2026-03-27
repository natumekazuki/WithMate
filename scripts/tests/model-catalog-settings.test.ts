import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getCharacterReflectionProviderSettings,
  createDefaultAppSettings,
  getMemoryExtractionProviderSettings,
  getProviderAppSettings,
  normalizeAppSettings,
} from "../../src/app-state.js";
import { coerceModelSelection, type ModelCatalogProvider } from "../../src/model-catalog.js";

const providerCatalog: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "gpt-5.4",
  defaultReasoningEffort: "high",
  models: [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gpt-5.1-mini",
      label: "GPT-5.1 Mini",
      reasoningEfforts: ["medium"],
    },
  ],
};

describe("coerceModelSelection", () => {
  it("catalog に無い model は provider default へ正規化する", () => {
    const selection = coerceModelSelection(providerCatalog, "missing-model", "high");

    assert.equal(selection.requestedModel, "missing-model");
    assert.equal(selection.resolvedModel, "gpt-5.4");
    assert.equal(selection.resolvedReasoningEffort, "high");
  });

  it("model に無い reasoning depth は許容される最初の値へ寄せる", () => {
    const selection = coerceModelSelection(providerCatalog, "gpt-5.1-mini", "high");

    assert.equal(selection.resolvedModel, "gpt-5.1-mini");
    assert.equal(selection.resolvedReasoningEffort, "medium");
  });
});

describe("app settings provider helpers", () => {
  it("settings 未設定でも codex は既定で enabled になる", () => {
    const settings = normalizeAppSettings({ systemPromptPrefix: "" });

    assert.equal(getProviderAppSettings(settings, "codex").enabled, true);
    assert.equal(getProviderAppSettings(settings, "copilot").enabled, false);
  });

  it("provider ごとの enabled と apiKey を保持する", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      codingProviderSettings: {
        codex: {
          enabled: false,
          apiKey: "codex-key",
        },
        copilot: {
          enabled: true,
          apiKey: "copilot-key",
        },
      },
    });

    assert.deepEqual(getProviderAppSettings(settings, "codex"), {
      enabled: false,
      apiKey: "codex-key",
      skillRootPath: "",
    });
    assert.deepEqual(getProviderAppSettings(settings, "copilot"), {
      enabled: true,
      apiKey: "copilot-key",
      skillRootPath: "",
    });
  });

  it("canonical な codingProviderSettings だけを正本として扱う", () => {
    const settings = normalizeAppSettings({
      systemPromptPrefix: "canonical",
      codingProviderSettings: {
        codex: {
          enabled: false,
          apiKey: "canonical-key",
        },
      },
      providerSettings: {
        codex: {
          enabled: true,
          apiKey: "legacy-key",
        },
      },
    });

    assert.equal(settings.systemPromptPrefix, "canonical");
    assert.deepEqual(settings.codingProviderSettings, {
      codex: {
        enabled: false,
        apiKey: "canonical-key",
        skillRootPath: "",
      },
    });
    assert.deepEqual(getProviderAppSettings(settings, "codex"), {
      enabled: false,
      apiKey: "canonical-key",
      skillRootPath: "",
    });
  });

  it("memory extraction settings を provider ごとに保持する", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      memoryExtractionProviderSettings: {
        codex: {
          model: "gpt-5.1-mini",
          reasoningEffort: "medium",
          outputTokensThreshold: 280,
        },
      },
    });

    assert.deepEqual(getMemoryExtractionProviderSettings(settings, "codex"), {
      model: "gpt-5.1-mini",
      reasoningEffort: "medium",
      outputTokensThreshold: 280,
    });
  });

  it("character reflection settings を provider ごとに保持する", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      characterReflectionProviderSettings: {
        codex: {
          model: "gpt-5.1-mini",
          reasoningEffort: "medium",
        },
      },
    });

    assert.deepEqual(getCharacterReflectionProviderSettings(settings, "codex"), {
      model: "gpt-5.1-mini",
      reasoningEffort: "medium",
    });
  });
});
