import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultAppSettings,
  getMemoryExtractionProviderSettings,
  getProviderAppSettings,
  getResolvedProviderSettingsBundle,
  normalizeAppSettings,
} from "../../src-shared/settings/provider-settings-state.js";
import {
  coerceModelSelection,
  parseModelCatalogDocument,
  reasoningEffortOptions,
  resolveModelChangeSelection,
  type ModelCatalogProvider,
} from "../../src-shared/settings/model-catalog.js";

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
  it("model 切り替え時は非対応 depth は許容される値へ fallback する", () => {
    const selection = resolveModelChangeSelection(providerCatalog, "gpt-5.1-mini", "high");

    assert.equal(selection.resolvedModel, "gpt-5.1-mini");
    assert.equal(selection.resolvedReasoningEffort, "medium");
  });

  it("model 自体が catalog に無い場合はエラーにする", () => {
    assert.throws(() => resolveModelChangeSelection(providerCatalog, "missing-model", "high"));
  });
});

describe("reasoning effort catalog contract", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "catalogのxhigh/max/ultraは保存値のまま受理し、selectorには別の表示labelを提供する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#表示言語・操作・状態" }
  // fault = "表示名の変更でcatalogの有効なreasoning値を拒否するかselectorの保存idを変更する"
  // observable = "parse結果のreasoningEffortsとselector optionのid/label"
  // observation_boundary = "public-boundary"
  // scope = "reasoning effort catalog parsing and display"
  // lifecycle = "permanent"
  // @end-test-value
  it("max / ultra を catalog の有効値として保持する", () => {
    const document = parseModelCatalogDocument({
      providers: [
        {
          id: "codex",
          label: "Codex",
          defaultModelId: "gpt-5.6-sol",
          defaultReasoningEffort: "max",
          models: [
            {
              id: "gpt-5.6-sol",
              label: "GPT-5.6 Sol",
              reasoningEfforts: ["xhigh", "max", "ultra"],
            },
          ],
        },
      ],
    });

    assert.deepEqual(document.providers[0]?.models[0]?.reasoningEfforts, ["xhigh", "max", "ultra"]);
    assert.deepEqual(
      reasoningEffortOptions.slice(-3),
      [
        { id: "xhigh", label: "XHigh" },
        { id: "max", label: "Max" },
        { id: "ultra", label: "Ultra" },
      ],
    );
  });
});

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
