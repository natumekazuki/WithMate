import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDefaultAppSettings, type CharacterProfile } from "../../src/app-state.js";
import type { ModelCatalogSnapshot } from "../../src/model-catalog.js";
import { buildHomeLaunchProjection, inferWorkspaceFromPath } from "../../src/home-launch-projection.js";

function createCharacter(partial: Partial<CharacterProfile> & Pick<CharacterProfile, "id" | "name">): CharacterProfile {
  return {
    description: "",
    iconPath: "icon.png",
    roleMarkdown: "",
    themeColors: {
      main: "#000000",
      sub: "#ffffff",
    },
    sessionCopy: {
      pendingApproval: [],
      pendingWorking: [],
      pendingResponding: [],
      pendingPreparing: [],
      retryInterruptedTitle: [],
      retryFailedTitle: [],
      retryCanceledTitle: [],
      latestCommandWaiting: [],
      latestCommandEmpty: [],
      changedFilesEmpty: [],
      contextEmpty: [],
    },
    ...partial,
  };
}

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

  it("character search と launch search を別々に投影する", () => {
    const projection = buildHomeLaunchProjection({
      characters: [
        createCharacter({ id: "a", name: "Mia", description: "azure" }),
        createCharacter({ id: "b", name: "Luna", description: "moon" }),
      ],
      characterSearchText: "mi",
      launchCharacterSearchText: "lu",
      launchCharacterId: "b",
      launchProviderId: "",
      launchTitle: "",
      launchWorkspace: null,
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
    });

    assert.deepEqual(projection.filteredCharacters.map((character) => character.id), ["a"]);
    assert.deepEqual(projection.filteredLaunchCharacters.map((character) => character.id), ["b"]);
    assert.equal(projection.selectedCharacter?.id, "b");
  });

  it("enabled provider と start 可否を返す", () => {
    const settings = createDefaultAppSettings();
    settings.codingProviderSettings.copilot = {
      enabled: false,
      apiKey: "",
      skillRootPath: "",
    };

    const projection = buildHomeLaunchProjection({
      characters: [createCharacter({ id: "a", name: "Mia" })],
      characterSearchText: "",
      launchCharacterSearchText: "",
      launchCharacterId: "a",
      launchProviderId: "",
      launchTitle: "task",
      launchWorkspace: { label: "demo", path: "F:/work/demo", branch: "" },
      appSettings: settings,
      modelCatalog: createCatalog(),
    });

    assert.deepEqual(projection.enabledLaunchProviders.map((provider) => provider.id), ["codex"]);
    assert.equal(projection.selectedLaunchProvider?.id, "codex");
    assert.equal(projection.launchWorkspacePathLabel, "F:/work/demo");
    assert.equal(projection.canStartSession, true);
  });
});
