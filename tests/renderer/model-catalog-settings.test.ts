import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  getMemoryExtractionProviderSettings,
  getProviderAppSettings,
  getResolvedProviderSettingsBundle,
  normalizeAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
describe("app settings provider helpers", () => {
  it("settings 未設定でも codex は既定で enabled になる", () => {
    const settings = normalizeAppSettings({});

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
      skillRelativePath: "",
      instructionRelativePath: "",
    });
    assert.deepEqual(getProviderAppSettings(settings, "copilot"), {
      enabled: true,
      apiKey: "copilot-key",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
    });
  });

  it("canonical な codingProviderSettings だけを正本として扱う", () => {
    const settings = normalizeAppSettings({
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

    assert.deepEqual(settings.codingProviderSettings, {
      codex: {
        enabled: false,
        apiKey: "canonical-key",
        skillRootPath: "",
        skillRelativePath: "",
        instructionRelativePath: "",
      },
    });
    assert.deepEqual(getProviderAppSettings(settings, "codex"), {
      enabled: false,
      apiKey: "canonical-key",
      skillRootPath: "",
      skillRelativePath: "",
      instructionRelativePath: "",
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

  it("resolved provider settings bundle で provider 設定をまとめて取得できる", () => {
    const settings = normalizeAppSettings({
      ...createDefaultAppSettings(),
      memoryGenerationEnabled: false,
      codingProviderSettings: {
        codex: {
          enabled: false,
          apiKey: "codex-key",
          skillRootPath: "C:/skills",
          instructionRelativePath: "AGENTS.md",
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
    });

    assert.deepEqual(getResolvedProviderSettingsBundle(settings, "codex"), {
      coding: {
        enabled: false,
        apiKey: "codex-key",
        skillRootPath: "C:/skills",
        skillRelativePath: "",
        instructionRelativePath: "AGENTS.md",
      },
      memoryExtraction: {
        model: "gpt-5.1-mini",
        reasoningEffort: "medium",
        outputTokensThreshold: 280,
        timeoutSeconds: 240,
      },
    });
    assert.equal(settings.memoryGenerationEnabled, false);
  });
});
