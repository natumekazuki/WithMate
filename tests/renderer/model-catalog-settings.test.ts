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

  // @test-value v2
  // kind = "contract"
  // claim = "provider設定の正規化はOpenCode keyを利用せず、他providerのkeyと各providerのfile設定を保持する"
  // oracle = { type = "contract", ref = "docs/design/settings-ui.md#current-scope" }
  // fault = "OpenCode keyを返すか、他providerのkeyまたはOpenCodeの設定を消す"
  // observable = "normalizeAppSettingsとgetProviderAppSettingsのprovider設定"
  // observation_boundary = "public-boundary"
  // scope = "provider-settings-normalization"
  // lifecycle = "permanent"
  // impact = "廃止したcredentialの再利用や他providerの認証設定消失を防ぐ"
  // distinction = "型ではJSON入力に残るcredentialの対象限定除去を保証できない"
  // @end-test-value
  it("provider ごとの設定を保持しOpenCode keyだけを正規化する", () => {
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
        opencode: {
          enabled: true,
          apiKey: "retired-key",
          skillRootPath: "C:/opencode",
          skillRelativePath: "skills",
          instructionRelativePath: "AGENTS.md",
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
    assert.deepEqual(getProviderAppSettings(settings, "opencode"), {
      enabled: true,
      apiKey: "",
      skillRootPath: "C:/opencode",
      skillRelativePath: "skills",
      instructionRelativePath: "AGENTS.md",
    });
    assert.equal(settings.codingProviderSettings.opencode.apiKey, "");
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
