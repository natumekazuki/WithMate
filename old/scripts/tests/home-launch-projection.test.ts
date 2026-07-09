import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src/character/character-catalog.js";
import { createDefaultAppSettings } from "../../src/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeLaunchProjection, inferWorkspaceFromPath } from "../../src/home/home-launch-projection.js";

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

function createCharacters(): CharacterCatalogEntry[] {
  return [
    {
      id: "mia",
      name: "Mia",
      description: "default",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#eeeeee" },
      state: "active",
      isDefault: true,
      createdAt: "",
      updatedAt: "",
      archivedAt: null,
    },
    {
      id: "noa",
      name: "Noa",
      description: "",
      iconFilePath: "",
      theme: { main: "#222222", sub: "#dddddd" },
      state: "active",
      isDefault: false,
      createdAt: "",
      updatedAt: "",
      archivedAt: null,
    },
  ];
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
      characterEntries: createCharacters(),
      appSettings: settings,
      modelCatalog: createCatalog(),
    });

    assert.deepEqual(projection.enabledLaunchProviders.map((provider) => provider.id), []);
    assert.equal(projection.selectedLaunchProvider, null);
    assert.equal(projection.selectedCharacter?.id, "mia");
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
      launchCharacterId: "noa",
      characterEntries: createCharacters(),
      appSettings: settings,
      modelCatalog: createCatalog(),
    });

    assert.deepEqual(enabledOnlyCodex.enabledLaunchProviders.map((provider) => provider.id), ["codex"]);
    assert.equal(enabledOnlyCodex.selectedLaunchProvider?.id, "codex");
    assert.equal(enabledOnlyCodex.selectedCharacter?.id, "noa");
    assert.deepEqual(enabledOnlyCodex.characterOptions.map((character) => character.id), ["mia", "noa"]);
    assert.equal(enabledOnlyCodex.launchWorkspacePathLabel, "F:/work/demo");
    assert.equal(enabledOnlyCodex.canStartSession, true);
  });

  it("Character catalog 読み込み前は開始不可にする", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "task",
      launchWorkspace: { label: "demo", path: "F:/work/demo", branch: "" },
      characterEntries: [],
      charactersLoaded: false,
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
    });

    assert.equal(projection.charactersLoaded, false);
    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.canStartSession, false);
  });

  it("削除済み launch mode は通常 session と同じ開始条件を使う", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "",
      launchWorkspace: null,
      characterEntries: [],
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
    });

    assert.equal(projection.selectedLaunchProvider?.id, "codex");
    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.canStartSession, false);
  });
});
