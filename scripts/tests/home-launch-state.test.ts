import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src/character/character-catalog.js";
import {
  buildCreateSessionRequestFromLaunchDraft,
  applyLaunchWorkspacePathValidation,
  beginLaunchWorkspacePathValidation,
  markLaunchWorkspacePathValidationPending,
  closeLaunchDraft,
  createClosedLaunchDraft,
  openLaunchDraft,
  resolveLaunchCharacterId,
  resolveLaunchValidationMessage,
  selectWeightedRandomLaunchCharacterId,
  setLaunchWorkspaceFromPath,
  setLaunchWorkspaceToSessionFolder,
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
    createdAt: partial.createdAt ?? "",
    updatedAt: partial.updatedAt ?? "",
    archivedAt: partial.archivedAt ?? null,
  };
}

describe("home-launch-state", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "New Sessionを開くと既定providerとrandom選択で入力を初期化し、閉じると次回へ古い開始条件を持ち越さない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialog" }
  // fault = "再表示時に古いタイトル・workspace・provider選択を持ち越す"
  // observable = "open/close後のdraftの入力値・選択状態・検証状態"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-draft-lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
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
    );

    assert.deepEqual(opened, {
      open: true,
      title: "",
      workspacePathInput: "",
      workspaceValidation: "idle",
      workspaceValidationMessage: "",
      workspace: null,
      providerId: "codex",
      characterSelectionMode: "random",
      characterId: "",
    });

    assert.deepEqual(closeLaunchDraft(opened), {
      open: false,
      title: "",
      workspacePathInput: "",
      workspaceValidation: "idle",
      workspaceValidationMessage: "",
      workspace: null,
      providerId: "",
      characterSelectionMode: "random",
      characterId: "",
    });
  });

  it("workspace path から launch draft の workspace を更新する", () => {
    const draft = setLaunchWorkspaceFromPath(createClosedLaunchDraft(), "F:/work/demo");

    assert.deepEqual(draft.workspace, {
      label: "demo",
      path: "F:/work/demo",
      branch: "",
    });
    assert.equal(draft.workspacePathInput, "F:/work/demo");
    assert.equal(draft.workspaceValidation, "valid");
  });

  it("manual workspace は valid response のときだけ raw path から canonical tuple を作る", () => {
    const targetPath = "C:\\work space\\demo\\";
    const debouncing = beginLaunchWorkspacePathValidation(createClosedLaunchDraft(), targetPath);
    assert.equal(debouncing.workspace, null);
    assert.equal(debouncing.workspaceValidation, "debouncing");
    const pending = markLaunchWorkspacePathValidationPending(debouncing, targetPath);
    assert.equal(pending.workspaceValidation, "pending");

    const invalid = applyLaunchWorkspacePathValidation(pending, targetPath, {
      valid: false,
      reason: "not-directory",
    });
    assert.equal(invalid.workspace, null);
    assert.equal(invalid.workspaceValidationMessage, "Not a directory.");

    const valid = applyLaunchWorkspacePathValidation(pending, targetPath, { valid: true });
    assert.deepEqual(valid.workspace, {
      label: "demo",
      path: targetPath,
      branch: "",
    });
  });

  it("manual workspace validation は別入力の stale response を無視する", () => {
    const current = beginLaunchWorkspacePathValidation(createClosedLaunchDraft(), "C:\\new");
    assert.equal(
      markLaunchWorkspacePathValidationPending(current, "C:\\old"),
      current,
    );
    assert.equal(
      applyLaunchWorkspacePathValidation(current, "C:\\old", { valid: true }),
      current,
    );
  });

  // @test-value v2
  // kind = "contract"
  // claim = "validなmanual workspace pathを通常Session requestへ投影する"
  // oracle = { type = "contract", ref = "src/home/home-launch-state.ts" }
  // fault = "canonical workspace pathがSession requestから欠落する"
  // observable = "session requestのworkspace tuple"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-session-workspace"
  // lifecycle = "permanent"
  // @end-test-value
  it("validated manual workspace は session request に同じ path を投影する", () => {
    const targetPath = "\\\\server\\share\\work space\\";
    const draft = {
      ...applyLaunchWorkspacePathValidation(
        markLaunchWorkspacePathValidationPending(
          beginLaunchWorkspacePathValidation(createClosedLaunchDraft(), targetPath),
          targetPath,
        ),
        targetPath,
        { valid: true } as const,
      ),
      open: true,
      title: "task",
      providerId: "codex",
    };

    const sessionRequest = buildCreateSessionRequestFromLaunchDraft({
      draft,
      mateProfile: null,
      selectedProviderId: "codex",
    });
    assert.equal(sessionRequest?.workspace.kind, "directory");
    if (sessionRequest?.workspace.kind === "directory") {
      assert.deepEqual(sessionRequest.workspace, {
        kind: "directory",
        label: "work space",
        path: targetPath,
        branch: "",
      });
    }
  });

  it("provider 選択時に launch draft の providerId を更新する", () => {
    const draft = updateLaunchDraftForProviderSelection(createClosedLaunchDraft(), "codex");

    assert.equal(draft.providerId, "codex");
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

  it("specific character selection は指定したactive Characterだけを解決する", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];

    assert.equal(resolveLaunchCharacterId(entries, "noa"), "noa");
    assert.equal(resolveLaunchCharacterId(entries, "missing"), "");
    assert.equal(resolveLaunchCharacterId([], "missing"), "");
  });

  it("character selection は archived Character を候補にしない", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia", state: "archived" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];

    assert.equal(resolveLaunchCharacterId(entries, "mia"), "");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "通常Sessionの最終利用順に応じ未使用・古いCharacterほど選択されやすく、archivedは選ばれない"
  // oracle = { type = "contract", ref = "docs/adr/004-launch-character-random-selection.md#decision" }
  // fault = "authoring履歴を通常利用と混同する、重みの向きを逆転する、archivedを抽選候補に含める"
  // observable = "0から1を等分した600点で抽選した各Characterの回数の大小とarchivedの0回"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-character-random-selection"
  // lifecycle = "permanent"
  // @end-test-value
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
    const selectionCounts = new Map<string, number>(entries.map((entry) => [entry.id, 0]));

    for (let index = 0; index < 600; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        sessions,
        [],
        () => (index + 0.5) / 600,
      );
      selectionCounts.set(characterId, (selectionCounts.get(characterId) ?? 0) + 1);
    }

    assert.ok((selectionCounts.get("yui") ?? 0) > (selectionCounts.get("noa") ?? 0));
    assert.ok((selectionCounts.get("noa") ?? 0) > (selectionCounts.get("mia") ?? 0));
    assert.equal(selectionCounts.get("archived"), 0);
  });

  it("random character selection はactive Characterがなければ空IDを返す", () => {
    assert.equal(selectWeightedRandomLaunchCharacterId([], [], [], () => 0.5), "");
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "利用履歴がない2名のactive Characterは乱数範囲を半分ずつ占める"
  // oracle = { type = "contract", ref = "docs/adr/004-launch-character-random-selection.md#decision" }
  // fault = "履歴がない同順位の候補に異なる重みを割り当てる"
  // observable = "0から1を等分した200点で両候補が100回ずつ選択されること"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-character-random-selection"
  // lifecycle = "permanent"
  // @end-test-value
  it("random character selection は利用履歴がなければactive Characterを均等に選ぶ", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];
    const selectionCounts = new Map<string, number>(entries.map((entry) => [entry.id, 0]));

    for (let index = 0; index < 200; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        [],
        [],
        () => (index + 0.5) / 200,
      );
      selectionCounts.set(characterId, (selectionCounts.get(characterId) ?? 0) + 1);
    }

    assert.deepEqual(Object.fromEntries(selectionCounts), { mia: 100, noa: 100 });
  });

  it("random character selection は未使用のactive Characterがあれば使用中を候補から外す", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
      createCharacterEntry({ id: "yui", name: "Yui" }),
    ];

    assert.equal(
      selectWeightedRandomLaunchCharacterId(entries, [], ["mia", "noa"], () => 0),
      "yui",
    );
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "使用中の候補を除外後、履歴がある候補とない候補を1対2の重みで抽選する"
  // oracle = { type = "contract", ref = "docs/adr/004-launch-character-random-selection.md#decision" }
  // fault = "使用中候補を抽選する、除外前の順位で重みを計算する、残り候補を均等に扱う"
  // observable = "300個の等分乱数に対するmia/noa/yuiの選択回数0/100/200"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-character-random-selection"
  // lifecycle = "permanent"
  // @end-test-value
  it("random character selection は未使用候補の中で最終利用順の重み付けを維持する", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
      createCharacterEntry({ id: "yui", name: "Yui" }),
    ];
    const sessions = [
      { characterId: "mia", sessionKind: "default" as const },
      { characterId: "noa", sessionKind: "default" as const },
    ];
    const selectionCounts = new Map<string, number>(entries.map((entry) => [entry.id, 0]));

    for (let index = 0; index < 300; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        sessions,
        ["mia"],
        () => (index + 0.5) / 300,
      );
      selectionCounts.set(characterId, (selectionCounts.get(characterId) ?? 0) + 1);
    }

    assert.deepEqual(Object.fromEntries(selectionCounts), { mia: 0, noa: 100, yui: 200 });
  });

  it("random character selection は全active Characterが使用中なら重複を許容する", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];

    assert.equal(
      selectWeightedRandomLaunchCharacterId(
        entries,
        [{ characterId: "mia", sessionKind: "default" }],
        ["mia", "noa"],
        () => 0.4,
      ),
      "noa",
    );
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

  it("launch draft から directory workspace の session request を組み立てる", () => {
    const input = buildCreateSessionRequestFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "mia",
        characterSelectionMode: "specific",
      },
      mateProfile: createMateProfile({
        id: "mate-a",
        displayName: "Mia",
        avatarFilePath: "icon.png",
        themeMain: "#000000",
        themeSub: "#ffffff",
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
    });

    assert.deepEqual(input, {
      provider: "codex",
      taskTitle: "task",
      workspace: {
        kind: "directory",
        label: "demo",
        path: "F:/work/demo",
        branch: "main",
      },
      characterId: "mia",
      character: "Mia",
      characterIconPath: "icon.png",
      characterThemeColors: {
        main: "#000000",
        sub: "#ffffff",
      },
    });
    assert.equal("approvalMode" in (input ?? {}), false);
    assert.equal("codexSandboxMode" in (input ?? {}), false);
    assert.equal("model" in (input ?? {}), false);
    assert.equal("reasoningEffort" in (input ?? {}), false);
    assert.equal("customAgentName" in (input ?? {}), false);
  });

  it("Mate 未作成でも neutral character で session input を組み立てる", () => {
    const input = buildCreateSessionRequestFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        title: "  task  ",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
      },
      mateProfile: null,
      selectedProviderId: "codex",
    });

    assert.equal(input?.characterId, "withmate-neutral-character");
    assert.equal(input?.character, "WithMate");
    assert.equal(input?.characterIconPath, "");
    assert.deepEqual(input?.characterThemeColors, {
      main: "#6f8cff",
      sub: "#6fb8c7",
    });
  });

  it("specific Character がarchivedなら別Characterへ置換せずsession開始を拒否する", () => {
    const input = buildCreateSessionRequestFromLaunchDraft({
      draft: {
        ...createClosedLaunchDraft(),
        open: true,
        title: "task",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "codex",
        characterId: "mia",
        characterSelectionMode: "specific",
      },
      mateProfile: null,
      selectedProviderId: "codex",
      characterEntries: [
        createCharacterEntry({ id: "mia", name: "Mia", state: "archived" }),
        createCharacterEntry({ id: "noa", name: "Noa", description: "active profile" }),
      ],
    });

    assert.equal(input, null);
  });









  it("launch 条件が欠けている時は session input を返さない", () => {
    const input = buildCreateSessionRequestFromLaunchDraft({
      draft: createClosedLaunchDraft(),
      mateProfile: null,
      selectedProviderId: "codex",
    });

    assert.equal(input, null);
  });

  it("SessionFolder 選択は path を確定せず session request に保持する", () => {
    const draft = {
      ...setLaunchWorkspaceToSessionFolder(createClosedLaunchDraft()),
      open: true,
      title: "task",
      providerId: "codex",
    };

    assert.equal(
      resolveLaunchValidationMessage({
        draft,
        mateState: "active",
        mateProfile: null,
        selectedProviderId: "codex",
      }),
      "",
    );
    assert.deepEqual(
      buildCreateSessionRequestFromLaunchDraft({
        draft,
        mateProfile: null,
        selectedProviderId: "codex",
      })?.workspace,
      { kind: "session-folder" },
    );
  });
});
