import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src/character/character-catalog.js";
import { buildHomeLaunchHandlers } from "../../src/home/home-launch-handlers.js";
import { createClosedLaunchDraft, type HomeLaunchDraft } from "../../src/home/home-launch-state.js";
import type { ModelCatalogProvider } from "../../src/model-catalog.js";

function createCharacterEntry(partial: Partial<CharacterCatalogEntry> & Pick<CharacterCatalogEntry, "id" | "name">): CharacterCatalogEntry {
  return {
    id: partial.id,
    name: partial.name,
    description: partial.description ?? "",
    iconFilePath: partial.iconFilePath ?? "",
    theme: partial.theme ?? { main: "#6f8cff", sub: "#6fb8c7" },
    state: partial.state ?? "active",
    isDefault: partial.isDefault ?? false,
    createdAt: partial.createdAt ?? "",
    updatedAt: partial.updatedAt ?? "",
    archivedAt: partial.archivedAt ?? null,
  };
}

function createProvider(): ModelCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    defaultModelId: "gpt-5.4",
    defaultReasoningEffort: "high",
    models: [{ id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] }],
  };
}

describe("home-launch-handlers", () => {
  it("launch dialog を開く直前に Character catalog を再取得して選択を更新する", async () => {
    let draft: HomeLaunchDraft = {
      ...createClosedLaunchDraft(),
      characterId: "old",
    };
    const latestEntries = [
      createCharacterEntry({ id: "new-default", name: "New Default", isDefault: true }),
    ];
    const feedback: string[] = [];
    let refreshCount = 0;

    const handlers = buildHomeLaunchHandlers({
      launchDraft: draft,
      launchStarting: false,
      mateState: "active",
      mateProfile: null,
      enabledLaunchProviders: [createProvider()],
      characterEntries: [createCharacterEntry({ id: "old", name: "Old" })],
      selectedLaunchProviderId: "codex",
      sessions: [],
      refreshCharacterEntries: async () => {
        refreshCount += 1;
        return latestEntries;
      },
      setLaunchFeedback: (message) => feedback.push(message),
      setLaunchStarting: () => undefined,
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      pickWorkspaceDirectory: async () => null,
      openSessionWindow: async () => undefined,
      openCompanionReviewWindow: async () => undefined,
      createSession: async () => null,
      createCompanionSession: async () => null,
      upsertSessionSummary: () => undefined,
      upsertCompanionSessionSummary: () => undefined,
    });

    await handlers.onOpenLaunchDialog();

    assert.equal(refreshCount, 1);
    assert.equal(draft.open, true);
    assert.equal(draft.characterId, "new-default");
    assert.deepEqual(feedback, [""]);
  });
});
