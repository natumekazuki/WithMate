import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMateTalkModelSelection,
  isMateTalkReasoningEffortAllowed,
  resolveMateTalkModelChange,
} from "../../src/chat/mate-talk-model-selection.js";
import type { ModelCatalogProvider, ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { createDefaultAppSettings, type AppSettings } from "../../src/provider-settings-state.js";

const codexProvider: ModelCatalogProvider = {
  id: "codex",
  label: "Codex",
  defaultModelId: "codex-default",
  defaultReasoningEffort: "medium",
  models: [
    {
      id: "codex-default",
      label: "Codex Default",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "codex-fast",
      label: "Codex Fast",
      reasoningEfforts: ["low"],
    },
  ],
};

const copilotProvider: ModelCatalogProvider = {
  id: "copilot",
  label: "Copilot",
  defaultModelId: "copilot-default",
  defaultReasoningEffort: "low",
  models: [
    {
      id: "copilot-default",
      label: "Copilot Default",
      reasoningEfforts: ["low", "medium"],
    },
    {
      id: "copilot-priority",
      label: "Copilot Priority",
      reasoningEfforts: ["medium", "high"],
    },
  ],
};

const modelCatalog: ModelCatalogSnapshot = {
  revision: 1,
  providers: [codexProvider, copilotProvider],
};

function createSettings(): AppSettings {
  return {
    ...createDefaultAppSettings(),
    codingProviderSettings: {
      codex: {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
      },
      copilot: {
        enabled: true,
        apiKey: "",
        skillRootPath: "",
      },
    },
    mateMemoryGenerationSettings: {
      priorityList: [
        {
          provider: "copilot",
          model: "copilot-priority",
          reasoningEffort: "high",
          timeoutSeconds: 300,
        },
      ],
      triggerIntervalMinutes: 60,
    },
  };
}

describe("mate-talk model selection", () => {
  it("catalog 未ロード時は launch selection を保持する", () => {
    const selection = buildMateTalkModelSelection({
      appSettings: createSettings(),
      modelCatalog: null,
      providerId: "codex",
      model: "codex-fast",
      reasoningEffort: "low",
    });

    assert.equal(selection.providerId, "codex");
    assert.equal(selection.model, "codex-fast");
    assert.equal(selection.reasoningEffort, "low");
    assert.equal(selection.providerCatalog, null);
    assert.equal(selection.selectedModel, null);
    assert.deepEqual(selection.modelOptions, []);
    assert.deepEqual(selection.reasoningOptions, []);
  });

  it("未選択時は priority provider/model/reasoning effort を選ぶ", () => {
    const selection = buildMateTalkModelSelection({
      appSettings: createSettings(),
      modelCatalog,
      providerId: "",
      model: "",
      reasoningEffort: "low",
    });

    assert.equal(selection.providerId, "copilot");
    assert.equal(selection.model, "copilot-priority");
    assert.equal(selection.reasoningEffort, "high");
    assert.deepEqual(selection.modelOptions, [
      { value: "copilot-default", label: "Copilot Default" },
      { value: "copilot-priority", label: "Copilot Priority" },
    ]);
    assert.deepEqual(selection.reasoningOptions, [
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ]);
  });

  it("現在の provider/model/reasoning effort が有効なら維持する", () => {
    const selection = buildMateTalkModelSelection({
      appSettings: createSettings(),
      modelCatalog,
      providerId: "codex",
      model: "codex-default",
      reasoningEffort: "high",
    });

    assert.equal(selection.providerId, "codex");
    assert.equal(selection.model, "codex-default");
    assert.equal(selection.reasoningEffort, "high");
  });

  it("無効な現在選択は provider default と model の allowed efforts へ fallback する", () => {
    const selection = buildMateTalkModelSelection({
      appSettings: createSettings(),
      modelCatalog,
      providerId: "missing",
      model: "missing-model",
      reasoningEffort: "xhigh",
    });

    assert.equal(selection.providerId, "copilot");
    assert.equal(selection.model, "copilot-priority");
    assert.equal(selection.reasoningEffort, "high");
  });

  it("priority model が使えない場合は provider default model と compatible reasoning effort に fallback する", () => {
    const selection = buildMateTalkModelSelection({
      appSettings: {
        ...createSettings(),
        mateMemoryGenerationSettings: {
          priorityList: [
            {
              provider: "codex",
              model: "missing-model",
              reasoningEffort: "xhigh",
              timeoutSeconds: 300,
            },
          ],
          triggerIntervalMinutes: 60,
        },
      },
      modelCatalog,
      providerId: "",
      model: "",
      reasoningEffort: "xhigh",
    });

    assert.equal(selection.providerId, "codex");
    assert.equal(selection.model, "codex-default");
    assert.equal(selection.reasoningEffort, "medium");
  });

  it("model 変更時は現在の reasoning effort を維持し、使えなければ model 側へ fallback する", () => {
    assert.deepEqual(
      resolveMateTalkModelChange({
        providerCatalog: codexProvider,
        model: "codex-default",
        reasoningEffort: "high",
      }),
      {
        model: "codex-default",
        reasoningEffort: "high",
      },
    );

    assert.deepEqual(
      resolveMateTalkModelChange({
        providerCatalog: codexProvider,
        model: "codex-fast",
        reasoningEffort: "high",
      }),
      {
        model: "codex-fast",
        reasoningEffort: "low",
      },
    );
  });

  it("reasoning effort 変更は選択 model の allowed efforts だけを許可する", () => {
    assert.equal(isMateTalkReasoningEffortAllowed(codexProvider.models[0], "medium"), true);
    assert.equal(isMateTalkReasoningEffortAllowed(codexProvider.models[1], "medium"), false);
    assert.equal(isMateTalkReasoningEffortAllowed(null, "medium"), false);
  });
});
