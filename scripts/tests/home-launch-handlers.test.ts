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
  it("launch dialog を開く直前に Character catalog を再取得してrandom選択へ戻す", async () => {
    let draft: HomeLaunchDraft = {
      ...createClosedLaunchDraft(),
      characterId: "old",
    };
    const latestEntries = [
      createCharacterEntry({ id: "new-character", name: "New Character" }),
    ];
    const feedback: string[] = [];
    const scheduledWorkspacePaths: string[] = [];
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
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionSummariesLoadStatus: "loaded",
      refreshCharacterEntries: async () => {
        refreshCount += 1;
        return latestEntries;
      },
      setCharactersLoaded: () => undefined,
      setLaunchFeedback: (message) => feedback.push(message),
      setLaunchStarting: () => undefined,
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      pickWorkspaceDirectory: async () => "C:\\browse workspace\\",
      scheduleWorkspaceValidation: (targetPath) => scheduledWorkspacePaths.push(targetPath),
      cancelWorkspaceValidation: () => {},
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
    assert.equal(draft.characterId, "");
    assert.equal(draft.characterSelectionMode, "random");
    assert.deepEqual(feedback, [""]);

    handlers.onSelectRandomLaunchCharacter();
    assert.equal(draft.characterSelectionMode, "random");

    handlers.onSelectLaunchCharacter("new-character");
    assert.equal(draft.characterSelectionMode, "specific");

    handlers.onCloseLaunchDialog();
    await handlers.onOpenLaunchDialog();
    assert.equal(draft.characterSelectionMode, "random");

    handlers.onSelectSessionFolder();
    assert.deepEqual(draft.workspace, { kind: "session-folder" });
    assert.equal(draft.workspacePathInput, "");

    handlers.onChangeWorkspacePath("\\\\server\\share\\manual workspace\\");
    handlers.onBrowseWorkspace();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(scheduledWorkspacePaths, [
      "\\\\server\\share\\manual workspace\\",
      "C:\\browse workspace\\",
    ]);

    handlers.onChangeMode("companion");
    assert.equal(draft.mode, "companion");
    assert.equal(draft.workspace, null);
  });

  it("Character catalog の再取得失敗時はstale一覧でrandom開始できない状態にする", async () => {
    let draft = createClosedLaunchDraft();
    let charactersLoaded = true;
    const feedback: string[] = [];

    const handlers = buildHomeLaunchHandlers({
      launchDraft: draft,
      launchStarting: false,
      mateState: "active",
      mateProfile: null,
      enabledLaunchProviders: [createProvider()],
      characterEntries: [createCharacterEntry({ id: "stale", name: "Stale" })],
      selectedLaunchProviderId: "codex",
      sessions: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionSummariesLoadStatus: "loaded",
      refreshCharacterEntries: async () => {
        throw new Error("Character catalog refresh failed");
      },
      setCharactersLoaded: (loaded) => {
        charactersLoaded = loaded;
      },
      setLaunchFeedback: (message) => feedback.push(message),
      setLaunchStarting: () => undefined,
      setLaunchDraft: (updater) => {
        draft = typeof updater === "function" ? updater(draft) : updater;
      },
      pickWorkspaceDirectory: async () => null,
      scheduleWorkspaceValidation: () => {},
      cancelWorkspaceValidation: () => {},
      openSessionWindow: async () => undefined,
      openCompanionReviewWindow: async () => undefined,
      createSession: async () => null,
      createCompanionSession: async () => null,
      upsertSessionSummary: () => undefined,
      upsertCompanionSessionSummary: () => undefined,
    });

    await handlers.onOpenLaunchDialog();

    assert.equal(draft.open, true);
    assert.equal(draft.characterSelectionMode, "random");
    assert.equal(charactersLoaded, false);
    assert.deepEqual(feedback, ["", "Character catalog refresh failed"]);
  });
});
