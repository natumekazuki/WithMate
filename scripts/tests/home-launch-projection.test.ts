import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeLaunchProjection, inferWorkspaceFromPath } from "../../src/home-launch-projection.js";

function createCatalog(): ModelCatalogSnapshot {
  return {
    revision: 1,
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
      },
    ],
  };
}

describe("home-launch-projection", () => {
  it("workspace path から launch workspace を作る", () => {
    assert.deepEqual(inferWorkspaceFromPath("F:/work/demo"), {
      label: "demo",
      path: "F:/work/demo",
      branch: "",
    });
  });

  it("provider と start 可否を返す", () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.codex = {
      enabled: false,
      apiKey: "",
      skillRootPath: "",
    };

    const projection = buildHomeLaunchProjection({
      launchProviderId: "",
      launchTitle: "",
      launchWorkspace: null,
      appSettings: settings,
      modelCatalog: createCatalog(),
    });

    assert.deepEqual(projection.enabledLaunchProviders.map((provider) => provider.id), []);
    assert.equal(projection.selectedLaunchProvider, null);
    assert.equal(projection.canStartSession, false);
  });

  it("有効な provider を選択でき、タイトル/ワークスペースで開始可否が変わる", () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.copilot = {
      enabled: false,
      apiKey: "",
      skillRootPath: "",
    };

    const enabledOnlyCodex = buildHomeLaunchProjection({
      launchProviderId: "",
      launchTitle: "task",
      launchWorkspace: { label: "demo", path: "F:/work/demo", branch: "" },
      appSettings: settings,
      modelCatalog: createCatalog(),
    });

    assert.deepEqual(enabledOnlyCodex.enabledLaunchProviders.map((provider) => provider.id), ["codex"]);
    assert.equal(enabledOnlyCodex.selectedLaunchProvider?.id, "codex");
    assert.equal(enabledOnlyCodex.launchWorkspacePathLabel, "F:/work/demo");
    assert.equal(enabledOnlyCodex.canStartSession, true);
  });
});
