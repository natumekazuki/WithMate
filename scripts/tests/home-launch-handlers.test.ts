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
  // @test-value v2
  // kind = "contract"
  // claim = "launch dialog再表示はCharacter一覧を再取得しrandom選択へ戻し、workspace入力は検証へ渡す"
  // oracle = { type = "contract", ref = "src/home/home-launch-handlers.ts" }
  // fault = "古いCharacter選択を引き継ぐか、入力されたworkspaceを検証せず開始候補にする"
  // observable = "refresh回数、draftの選択状態とSessionFolder、feedback、検証に渡したraw path"
  // observation_boundary = "component-behavior"
  // scope = "Home launch dialog handlers"
  // lifecycle = "permanent"
  // @end-test-value
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
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionCharacterUsageLoadStatus: "loaded",
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
      createSession: async () => null,
      upsertSessionSummary: () => undefined,
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
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Character一覧再取得の失敗はloaded状態を解除し古い一覧でのrandom開始を防ぐ"
  // oracle = { type = "contract", ref = "src/home/home-launch-handlers.ts" }
  // fault = "取得に失敗したCharacter一覧を最新として扱い使用不能なCharacterで開始する"
  // observable = "charactersLoaded=false、dialogのrandom状態、失敗feedback"
  // observation_boundary = "component-behavior"
  // scope = "Home launch catalog refresh failure"
  // lifecycle = "permanent"
  // @end-test-value
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
      sessionCharacterUsage: [],
      openSessionWindowIds: [],
      openSessionWindowIdsLoadStatus: "loaded",
      sessionCharacterUsageLoadStatus: "loaded",
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
      createSession: async () => null,
      upsertSessionSummary: () => undefined,
    });

    await handlers.onOpenLaunchDialog();

    assert.equal(draft.open, true);
    assert.equal(draft.characterSelectionMode, "random");
    assert.equal(charactersLoaded, false);
    assert.deepEqual(feedback, ["", "Character catalog refresh failed"]);
  });
});
