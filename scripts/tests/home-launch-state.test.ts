import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_APPROVAL_MODE } from "../../src/approval-mode.js";
import { DEFAULT_CODEX_SANDBOX_MODE } from "../../src/codex-sandbox-mode.js";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT, type ModelCatalogProvider } from "../../src/model-catalog.js";
import type { SessionSummary } from "../../src/app-state.js";
import type { CharacterCatalogEntry } from "../../src/character/character-catalog.js";
import {
  buildCreateCompanionSessionInputFromLaunchDraft,
  buildCreateSessionInputFromLaunchDraft,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  resolveLastUsedSessionSelection,
  resolveLaunchCharacterId,
  resolveLaunchValidationMessage,
  selectWeightedRandomLaunchCharacterId,
  setLaunchWorkspaceFromPath,
  updateLaunchDraftForCharacterSelection,
  updateLaunchDraftForProviderSelection,
  updateLaunchDraftForRandomCharacterSelection,
} from "../../src/home/home-launch-state.js";
import type { MateProfile } from "../../src/mate/mate-state.js";

function createMateProfile(partial: Partial<MateProfile> & Pick<MateProfile, "id" | "displayName">): MateProfile {
  const { id, displayName, ...rest } = partial;
  return {
    id,
    state: "active",
    displayName,
    description: "",
    themeMain: "#000000",
    themeSub: "#ffffff",
    avatarFilePath: "avatar.png",
    avatarSha256: "",
    avatarByteSize: 0,
    activeRevisionId: null,
    profileGeneration: 1,
    createdAt: "",
    updatedAt: "",
    deletedAt: null,
    sections: [],
    ...rest,
  };
}

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

describe("home-launch-state", () => {
  it("open と close で launch draft を reset する", () => {
    const opened = openLaunchDraft(
      {
        ...createClosedLaunchDraft(),
        open: false,
        title: "keep",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "old",
      },
      "codex",
      "session",
      "mia",
    );

    assert.deepEqual(opened, {
      open: true,
      mode: "session",
      title: "",
      workspace: null,
      providerId: "codex",
      characterSelectionMode: "specific",
      characterId: "mia",
      model: DEFAULT_MODEL_ID,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    });

    assert.deepEqual(closeLaunchDraft(opened), {
      open: false,
      mode: "session",
      title: "",
      workspace: null,
      providerId: "",
      characterSelectionMode: "specific",
      characterId: "",
      model: DEFAULT_MODEL_ID,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      approvalMode: DEFAULT_APPROVAL_MODE,
      codexSandboxMode: DEFAULT_CODEX_SANDBOX_MODE,
    });
  });

  it("workspace path から launch draft の workspace を更新する", () => {
    const draft = setLaunchWorkspaceFromPath(createClosedLaunchDraft(), "F:/work/demo");

    assert.deepEqual(draft.workspace, {
      label: "demo",
      path: "F:/work/demo",
      branch: "",
    });
  });

  it("provider 選択時に launch draft の provider/model/reasoningEffort を更新する", () => {
    const providers: ModelCatalogProvider[] = [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4-mini",
        defaultReasoningEffort: "medium",
        models: [
          {
            id: "gpt-5.4-mini",
            label: "GPT 5.4 mini",
            reasoningEfforts: ["low", "medium"],
          },
        ],
      },
    ];
    const draft = updateLaunchDraftForProviderSelection(createClosedLaunchDraft(), "codex", providers);

    assert.equal(draft.providerId, "codex");
    assert.equal(draft.model, "gpt-5.4-mini");
    assert.equal(draft.reasoningEffort, "low");
  });

  it("存在しない provider 選択時は providerId だけ更新して model/reasoningEffort を維持する", () => {
    const current = {
      ...createClosedLaunchDraft(),
      providerId: "codex",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium" as const,
    };
    const draft = updateLaunchDraftForProviderSelection(current, "missing", []);

    assert.equal(draft.providerId, "missing");
    assert.equal(draft.model, "gpt-5.4-mini");
    assert.equal(draft.reasoningEffort, "medium");
  });

  it("character 選択時に launch draft の characterId を更新する", () => {
    const draft = updateLaunchDraftForCharacterSelection(createClosedLaunchDraft(), "mia");

    assert.equal(draft.characterId, "mia");
    assert.equal(draft.characterSelectionMode, "specific");
  });

  it("random character 選択時に launch draft の選択modeを更新する", () => {
    const draft = updateLaunchDraftForRandomCharacterSelection({
      ...createClosedLaunchDraft(),
      characterId: "mia",
    });

    assert.equal(draft.characterId, "mia");
    assert.equal(draft.characterSelectionMode, "random");
  });

  it("character selection は既存選択、default順の先頭、空文字の順で解決する", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia", isDefault: true }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];

    assert.equal(resolveLaunchCharacterId(entries, "noa"), "noa");
    assert.equal(resolveLaunchCharacterId(entries, "missing"), "mia");
    assert.equal(resolveLaunchCharacterId([], "missing"), "");
  });

  it("character selection は archived Character を候補にしない", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia", state: "archived" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];

    assert.equal(resolveLaunchCharacterId(entries, "mia"), "noa");
  });

  it("random character selection は最近使っていないactive Characterほど選択範囲を広くする", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
      createCharacterEntry({ id: "yui", name: "Yui" }),
      createCharacterEntry({ id: "archived", name: "Archived", state: "archived" }),
    ];
    const sessions = [
      { characterId: "mia", sessionKind: "default" as const },
      { characterId: "yui", sessionKind: "character-authoring" as const },
      { characterId: "archived", sessionKind: "default" as const },
      { characterId: "noa", sessionKind: "default" as const },
    ];
    const selectionCounts = new Map(entries.map((entry) => [entry.id, 0] as const));

    for (let index = 0; index < 600; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        sessions,
        () => (index + 0.5) / 600,
      );
      selectionCounts.set(characterId, (selectionCounts.get(characterId) ?? 0) + 1);
    }

    assert.ok((selectionCounts.get("yui") ?? 0) > (selectionCounts.get("noa") ?? 0));
    assert.ok((selectionCounts.get("noa") ?? 0) > (selectionCounts.get("mia") ?? 0));
    assert.equal(selectionCounts.get("archived"), 0);
  });

  it("random character selection はactive Characterがなければ空IDを返す", () => {
    assert.equal(selectWeightedRandomLaunchCharacterId([], [], () => 0.5), "");
  });

  it("random character selection は利用履歴がなければactive Characterを均等に選ぶ", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];
    const selectionCounts = new Map(entries.map((entry) => [entry.id, 0] as const));

    for (let index = 0; index < 200; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        [],
        () => (index + 0.5) / 200,
      );
      selectionCounts.set(characterId, (selectionCounts.get(characterId) ?? 0) + 1);
    }

    assert.deepEqual(Object.fromEntries(selectionCounts), { mia: 100, noa: 100 });
  });

  it("launch validation message は既存の優先順位で返す", () => {
    const baseDraft = {
      ...createClosedLaunchDraft(),
      open: true,
      title: "task",
      workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
      providerId: "codex",
    };
    const mateProfile = createMateProfile({ id: "mate-a", displayName: "Mia" });

    assert.equal(
      resolveLaunchValidationMessage({
        draft: { ...baseDraft, title: "" },
        mateState: "not_created",
        mateProfile: null,
        selectedProviderId: null,
      }),
      "タイトルを入力してね。",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: { ...baseDraft, title: "  " },
        mateState: "active",
        mateProfile,
        selectedProviderId: "codex",
      }),
      "タイトルを入力してね。",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: { ...baseDraft, workspace: null },
        mateState: "active",
        mateProfile,
        selectedProviderId: "codex",
      }),
      "workspace を選んでね。",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: baseDraft,
        mateState: "active",
        mateProfile,
        selectedProviderId: null,
      }),
      "有効な Coding Provider を選んでね。",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: baseDraft,
        mateState: "active",
        mateProfile,
        selectedProviderId: "codex",
      }),
      "",
    );
  });

  it("launch draft から session input を組み立てる", () => {
    const input = buildCreateSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "mia",
      },
      mateProfile: createMateProfile({
        id: "mate-a",
        displayName: "Mia",
        avatarFilePath: "icon.png",
        themeMain: "#000000",
        themeSub: "#ffffff",
      }),
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
      characterEntries: [
        createCharacterEntry({
          id: "mia",
          name: "Mia",
          description: "assistant profile",
          iconFilePath: "icon.png",
          theme: { main: "#000000", sub: "#ffffff" },
          isDefault: true,
        }),
      ],
      lastUsedSelection: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        customAgentName: "reviewer",
      },
    });

    assert.deepEqual(input, {
      provider: "codex",
      taskTitle: "task",
      workspaceLabel: "demo",
      workspacePath: "F:/work/demo",
      branch: "main",
      characterId: "mia",
      character: "Mia",
      characterIconPath: "icon.png",
      characterThemeColors: {
        main: "#000000",
        sub: "#ffffff",
      },
      approvalMode: DEFAULT_APPROVAL_MODE,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      customAgentName: "reviewer",
    });
  });

  it("Mate 未作成でも neutral character で session input を組み立てる", () => {
    const input = buildCreateSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
      },
      mateProfile: null,
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
    });

    assert.equal(input?.characterId, "withmate-neutral-character");
    assert.equal(input?.character, "WithMate");
    assert.equal(input?.characterIconPath, "");
    assert.deepEqual(input?.characterThemeColors, {
      main: "#6f8cff",
      sub: "#6fb8c7",
    });
  });

  it("archived Character が draft に残っていても active Character で session input を組み立てる", () => {
    const input = buildCreateSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        title: "task",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "mia",
      },
      mateProfile: null,
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
      characterEntries: [
        createCharacterEntry({ id: "mia", name: "Mia", state: "archived" }),
        createCharacterEntry({ id: "noa", name: "Noa", description: "active profile" }),
      ],
    });

    assert.equal(input?.characterId, "noa");
    assert.equal(input?.character, "Noa");
  });

  it("Mate 未作成でも neutral character で Companion input を組み立てる", () => {
    const input = buildCreateCompanionSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        mode: "companion",
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
      },
      mateProfile: null,
      selectedProviderId: "codex",
    });

    assert.equal(input?.characterId, "withmate-neutral-character");
    assert.equal(input?.character, "WithMate");
    assert.equal(input?.characterRoleMarkdown, "");
    assert.equal(input?.characterIconPath, "");
    assert.deepEqual(input?.characterThemeColors, {
      main: "#6f8cff",
      sub: "#6fb8c7",
    });
  });

  it("Companion launch は provider の last-used model を優先する", () => {
    const input = buildCreateCompanionSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        mode: "companion",
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "mia",
      },
      mateProfile: createMateProfile({
        id: "mate-a",
        displayName: "Mia",
        description: "assistant profile",
      }),
      selectedProviderId: "codex",
      characterEntries: [
        createCharacterEntry({
          id: "mia",
          name: "Mia",
          description: "assistant profile",
          iconFilePath: "icon.png",
          theme: { main: "#000000", sub: "#ffffff" },
        }),
      ],
      lastUsedSelection: {
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        customAgentName: "reviewer",
      },
    });

    assert.equal(input?.model, "gpt-5.4-mini");
    assert.equal(input?.reasoningEffort, "medium");
    assert.equal(input?.customAgentName, "reviewer");
  });

  it("active Character がない時だけ Companion input は neutral fallback を使う", () => {
    const input = buildCreateCompanionSessionInputFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        mode: "companion",
        title: "task",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "mia",
      },
      mateProfile: null,
      selectedProviderId: "codex",
      characterEntries: [
        createCharacterEntry({ id: "mia", name: "Mia", state: "archived" }),
      ],
    });

    assert.equal(input?.characterId, "withmate-neutral-character");
    assert.equal(input?.character, "WithMate");
  });

  it("selected provider の直近 session から last-used selection を引く", () => {
    const sessions: Pick<SessionSummary, "provider" | "model" | "reasoningEffort" | "customAgentName">[] = [
      {
        provider: "copilot",
        model: "gpt-4.1",
        reasoningEffort: "high",
        customAgentName: "planner",
      },
      {
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        customAgentName: "",
      },
    ];
    const selection = resolveLastUsedSessionSelection(
      sessions,
      "codex",
    );

    assert.deepEqual(selection, {
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      customAgentName: "",
    });
  });

  it("selected provider の既存 session が無ければ last-used selection を返さない", () => {
    const sessions: Pick<SessionSummary, "provider" | "model" | "reasoningEffort" | "customAgentName">[] = [
      {
        provider: "copilot",
        model: "gpt-4.1",
        reasoningEffort: "high",
        customAgentName: "planner",
      },
    ];
    const selection = resolveLastUsedSessionSelection(
      sessions,
      "codex",
    );

    assert.equal(selection, null);
  });

  it("launch 条件が欠けている時は session input を返さない", () => {
    const input = buildCreateSessionInputFromLaunchDraft({
      draft: createClosedLaunchDraft(),
      mateProfile: null,
      selectedProviderId: "codex",
      approvalMode: DEFAULT_APPROVAL_MODE,
    });

    assert.equal(input, null);
  });
});
