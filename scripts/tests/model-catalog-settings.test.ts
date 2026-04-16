import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getCharacterReflectionProviderSettings,
  createDefaultAppSettings,
  getMemoryExtractionProviderSettings,
  getProviderAppSettings,
  getResolvedProviderSettingsBundle,
  normalizeAppSettings,
} from "../../src/provider-settings-state.js";
import { coerceModelSelection, resolveModelChangeSelection, type ModelCatalogProvider } from "../../src/model-catalog.js";

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

describe("resolveModelChangeSelection", () => {
  it("model 切り替え時は非対応 depth を許容される値へ fallback する", () => {
    const selection = resolveModelChangeSelection(providerCatalog, "gpt-5.1-mini", "high");

    assert.equal(selection.resolvedModel, "gpt-5.1-mini");
    assert.equal(selection.resolvedReasoningEffort, "medium");
  });

  it("model 自体が catalog に無い場合はエラーにする", () => {
    assert.throws(() => resolveModelChangeSelection(providerCatalog, "missing-model", "high"));
  });
});

describe("app settings provider helpers", () => {
  it("settings 未設定でも codex は既定で enabled になる", () => {
    const settings = normalizeAppSettings({ systemPromptPrefix: "" });

    assert.equal(getProviderAppSettings(settings, "codex").enabled, true);
    assert.equal(getProviderAppSettings(settings, "copilot").enabled, false);
    assert.equal(settings.memoryGenerationEnabled, true);
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
          timeoutSeconds: 240,
        },
      },
    });

    assert.deepEqual(getMemoryExtractionProviderSettings(settings, "codex"), {
      model: "gpt-5.1-mini",
      reasoningEffort: "medium",
      outputTokensThreshold: 280,
      timeoutSeconds: 240,
    });
  });

  it("character reflection settings を provider ごとに保持する", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      characterReflectionProviderSettings: {
        codex: {
          model: "gpt-5.1-mini",
          reasoningEffort: "medium",
          timeoutSeconds: 210,
        },
      },
    });

    assert.deepEqual(getCharacterReflectionProviderSettings(settings, "codex"), {
      model: "gpt-5.1-mini",
      reasoningEffort: "medium",
      timeoutSeconds: 210,
    });
  });

  it("resolved provider settings bundle で 3 種の設定をまとめて取得できる", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      memoryGenerationEnabled: false,
      codingProviderSettings: {
        codex: {
          enabled: false,
          apiKey: "codex-key",
          skillRootPath: "C:/skills",
        },
      },
      memoryExtractionProviderSettings: {
        codex: {
          model: "gpt-5.1-mini",
          reasoningEffort: "medium",
          outputTokensThreshold: 280,
          timeoutSeconds: 240,
        },
      },
      characterReflectionProviderSettings: {
        codex: {
          model: "gpt-5.1-mini",
          reasoningEffort: "medium",
          timeoutSeconds: 210,
        },
      },
    });

    assert.deepEqual(getResolvedProviderSettingsBundle(settings, "codex"), {
      coding: {
        enabled: false,
        apiKey: "codex-key",
        skillRootPath: "C:/skills",
      },
      memoryExtraction: {
        model: "gpt-5.1-mini",
        reasoningEffort: "medium",
        outputTokensThreshold: 280,
        timeoutSeconds: 240,
      },
      characterReflection: {
        model: "gpt-5.1-mini",
        reasoningEffort: "medium",
        timeoutSeconds: 210,
      },
    });
    assert.equal(settings.memoryGenerationEnabled, false);
  });
});
