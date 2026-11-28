import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
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
  setLaunchWorkspaceFromPath,
  setLaunchWorkspaceToSessionFolder,
  updateLaunchDraftForCharacterSelection,
  updateLaunchDraftForProviderSelection,
  updateLaunchDraftForRandomCharacterSelection,
} from "../../src/home/home-launch-state.js";
import { selectWeightedRandomLaunchCharacterId } from "../../src-shared/character/launch-character-selection.js";
import type { MateProfile } from "../../src-shared/mate/mate-state.js";

/** activeなMateの既定値を用意し、指定されたID・表示名とケース固有の上書きを反映する。 */
function createMateProfile(
  partial: Partial<MateProfile> & Pick<MateProfile, "id" | "displayName">,
): MateProfile {
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

/** 抽選や固定選択で使うCharacterカタログの項目を作り、状態と利用時刻を個別に指定できるようにする。 */
function createCharacterEntry(
  partial: Partial<CharacterCatalogEntry> &
    Pick<CharacterCatalogEntry, "id" | "name">,
): CharacterCatalogEntry {
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

/** Homeの開始ドラフト、Character選択、Session作成要求への変換を検査する。 */
describe("home-launch-state", () => {
  // @test-value v2
  // kind = "contract"
  // claim = "New Sessionを開くとStandalone・既定providerとrandom選択で入力を初期化し、閉じると次回へ古い開始条件を持ち越さない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialog" }
  // fault = "再表示時に古いタイトル・workspace・provider選択を持ち越す"
  // observable = "open/close後のdraftの入力値・選択状態・検証状態"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-draft-lifecycle"
  // lifecycle = "permanent"
  // @end-test-value
  /** New Sessionを開くと起点Role・provider・Random選択の既定値へ戻り、閉じる際も前回のタイトルやWorkspace検証結果を残さない。 */
  it("open と close で launch draft を reset する", () => {
    const opened = openLaunchDraft(
      {
        ...createClosedLaunchDraft(),
        open: false,
        title: "keep",
        workspace: { label: "demo", path: "F:/work/demo", branch: "main" },
        providerId: "old",
        characterSelectionMode: "specific",
        characterId: "old-character",
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
      sessionRole: "standalone",
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
      sessionRole: "standalone",
    });
  });

  /** 指定directoryパスから表示ラベルとWorkspace tupleを作り、同じパスを入力欄に保持して検証済みとする。 */
  it("workspace path から launch draft の workspace を更新する", () => {
    const draft = setLaunchWorkspaceFromPath(
      createClosedLaunchDraft(),
      "F:/work/demo",
    );

    assert.deepEqual(draft.workspace, {
      label: "demo",
      path: "F:/work/demo",
      branch: "",
    });
    assert.equal(draft.workspacePathInput, "F:/work/demo");
    assert.equal(draft.workspaceValidation, "valid");
  });

  /** 手入力の検証中や失敗時はWorkspaceを確定せず、成功したときだけ末尾区切り付きの原文パスと表示名の組を作る。 */
  it("manual workspace は valid response のときだけ raw path から canonical tuple を作る", () => {
    const targetPath = "C:\\work space\\demo\\";
    const debouncing = beginLaunchWorkspacePathValidation(
      createClosedLaunchDraft(),
      targetPath,
    );
    assert.equal(debouncing.workspace, null);
    assert.equal(debouncing.workspaceValidation, "debouncing");
    const pending = markLaunchWorkspacePathValidationPending(
      debouncing,
      targetPath,
    );
    assert.equal(pending.workspaceValidation, "pending");

    const invalid = applyLaunchWorkspacePathValidation(pending, targetPath, {
      valid: false,
      reason: "not-directory",
    });
    assert.equal(invalid.workspace, null);
    assert.equal(invalid.workspaceValidationMessage, "Not a directory.");

    const valid = applyLaunchWorkspacePathValidation(pending, targetPath, {
      valid: true,
    });
    assert.deepEqual(valid.workspace, {
      label: "demo",
      path: targetPath,
      branch: "",
    });
  });

  /** 別パスの検証開始や成功応答が遅れても、新しい入力のドラフトをそのまま返す。 */
  it("manual workspace validation は別入力の stale response を無視する", () => {
    const current = beginLaunchWorkspacePathValidation(
      createClosedLaunchDraft(),
      "C:\\new",
    );
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
  /** 検証済みの手入力Workspaceを作成要求のdirectoryとして確定し、パスと表示情報を失わない。 */
  it("validated manual workspace は session request に同じ path を投影する", () => {
    const targetPath = "\\\\server\\share\\work space\\";
    const draft = {
      ...applyLaunchWorkspacePathValidation(
        markLaunchWorkspacePathValidationPending(
          beginLaunchWorkspacePathValidation(
            createClosedLaunchDraft(),
            targetPath,
          ),
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

  /** provider選択でドラフトが指定されたprovider IDを保持することを確認する。 */
  it("provider 選択時に launch draft の providerId を更新する", () => {
    const draft = updateLaunchDraftForProviderSelection(
      createClosedLaunchDraft(),
      "codex",
    );

    assert.equal(draft.providerId, "codex");
  });

  /** 特定Characterの選択はIDを保存し、起動条件を固定選択モードへ切り替える。 */
  it("character 選択時に launch draft の characterId を更新する", () => {
    const draft = updateLaunchDraftForCharacterSelection(
      createClosedLaunchDraft(),
      "mia",
    );

    assert.equal(draft.characterId, "mia");
    assert.equal(draft.characterSelectionMode, "specific");
  });

  /** Randomへ戻すと固定選択のIDをドラフトに残したまま、選択モードだけを切り替える。 */
  it("random character 選択時に launch draft の選択modeを更新する", () => {
    const draft = updateLaunchDraftForRandomCharacterSelection({
      ...createClosedLaunchDraft(),
      characterId: "mia",
    });

    assert.equal(draft.characterId, "mia");
    assert.equal(draft.characterSelectionMode, "random");
  });

  /** 固定選択は指定IDのactive Characterだけを解決し、カタログに無い場合は他の候補で代用しない。 */
  it("specific character selection は指定したactive Characterだけを解決する", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];

    assert.equal(resolveLaunchCharacterId(entries, "noa"), "noa");
    assert.equal(resolveLaunchCharacterId(entries, "missing"), "");
    assert.equal(resolveLaunchCharacterId([], "missing"), "");
  });

  /** 固定選択で指定したCharacterがarchivedなら、起動に使うIDを返さない。 */
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
  /** 通常Sessionの利用履歴が無い候補、最終利用が古い候補、最近の候補の順に抽選範囲を狭め、archivedは抽選しない。 */
  it("random character selection は最近使っていないactive Characterほど選択範囲を広くする", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
      createCharacterEntry({ id: "yui", name: "Yui" }),
      createCharacterEntry({
        id: "archived",
        name: "Archived",
        state: "archived",
      }),
    ];
    const sessions = [
      { characterId: "mia", sessionKind: "default" as const },
      { characterId: "yui", sessionKind: "character-authoring" as const },
      { characterId: "archived", sessionKind: "default" as const },
      { characterId: "noa", sessionKind: "default" as const },
    ];
    const selectionCounts = new Map<string, number>(
      entries.map((entry) => [entry.id, 0]),
    );

    for (let index = 0; index < 600; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        sessions,
        [],
        () => (index + 0.5) / 600,
      );
      selectionCounts.set(
        characterId,
        (selectionCounts.get(characterId) ?? 0) + 1,
      );
    }

    assert.ok(
      (selectionCounts.get("yui") ?? 0) > (selectionCounts.get("noa") ?? 0),
    );
    assert.ok(
      (selectionCounts.get("noa") ?? 0) > (selectionCounts.get("mia") ?? 0),
    );
    assert.equal(selectionCounts.get("archived"), 0);
  });

  /** 抽選対象が空のとき、存在しないCharacterの代替IDを作らず空文字を返す。 */
  it("random character selection はactive Characterがなければ空IDを返す", () => {
    assert.equal(
      selectWeightedRandomLaunchCharacterId([], [], [], () => 0.5),
      "",
    );
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
  /** いずれも利用履歴がない2候補の乱数範囲が等しく、200個の等分点で100回ずつ当たることを確認する。 */
  it("random character selection は利用履歴がなければactive Characterを均等に選ぶ", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
    ];
    const selectionCounts = new Map<string, number>(
      entries.map((entry) => [entry.id, 0]),
    );

    for (let index = 0; index < 200; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        [],
        [],
        () => (index + 0.5) / 200,
      );
      selectionCounts.set(
        characterId,
        (selectionCounts.get(characterId) ?? 0) + 1,
      );
    }

    assert.deepEqual(Object.fromEntries(selectionCounts), {
      mia: 100,
      noa: 100,
    });
  });

  /** 使用されていないactive Characterが一人でもいれば、現在使用中の候補を抽選から外す。 */
  it("random character selection は未使用のactive Characterがあれば使用中を候補から外す", () => {
    const entries = [
      createCharacterEntry({ id: "mia", name: "Mia" }),
      createCharacterEntry({ id: "noa", name: "Noa" }),
      createCharacterEntry({ id: "yui", name: "Yui" }),
    ];

    assert.equal(
      selectWeightedRandomLaunchCharacterId(
        entries,
        [],
        ["mia", "noa"],
        () => 0,
      ),
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
  /** 使用中を除外してから履歴で重みを付け、残った履歴ありと未使用の候補が1対2になる。 */
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
    const selectionCounts = new Map<string, number>(
      entries.map((entry) => [entry.id, 0]),
    );

    for (let index = 0; index < 300; index += 1) {
      const characterId = selectWeightedRandomLaunchCharacterId(
        entries,
        sessions,
        ["mia"],
        () => (index + 0.5) / 300,
      );
      selectionCounts.set(
        characterId,
        (selectionCounts.get(characterId) ?? 0) + 1,
      );
    }

    assert.deepEqual(Object.fromEntries(selectionCounts), {
      mia: 0,
      noa: 100,
      yui: 200,
    });
  });

  /** active候補が全員使用中なら、重複利用を許して候補から選べることを確認する。 */
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

  // @test-value v2
  // kind = "invariant"
  // claim = "launch validation messageはtitle、workspace、providerの既存優先順位を保ち、全条件充足時は空文字を返す"
  // oracle = { type = "contract", ref = "Issue #731 New session validation state" }
  // fault = "複数の不備があるとき優先順位が変わるか、条件充足後もvalidation errorを残してSession開始を妨げる"
  // observable = "resolveLaunchValidationMessageの各draft状態に対するmessage string"
  // observation_boundary = "public-boundary"
  // scope = "resolveLaunchValidationMessage validation precedence"
  // lifecycle = "permanent"
  // impact = "利用者が最初に修正すべき入力理由を一貫して識別でき、valid draftは開始可能になる"
  // distinction = "個別validatorの判定だけでなく、複数条件下の優先順位とvalid終端を同じ公開helperで確認する"
  // @end-test-value
  /** 開始条件の不足はタイトル、Workspace、providerの順で案内し、すべて揃えばエラーを残さない。 */
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
      "Enter a session title.",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: { ...baseDraft, title: "  " },
        mateState: "active",
        mateProfile,
        selectedProviderId: "codex",
      }),
      "Enter a session title.",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: { ...baseDraft, workspace: null },
        mateState: "active",
        mateProfile,
        selectedProviderId: "codex",
      }),
      "Choose a workspace.",
    );
    assert.equal(
      resolveLaunchValidationMessage({
        draft: baseDraft,
        mateState: "active",
        mateProfile,
        selectedProviderId: null,
      }),
      "Choose an enabled coding provider.",
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

  // @test-value v2
  // kind = "contract"
  // claim = "起点Session作成要求はdraftのtitle・directory workspace・provider・Character snapshotと既定Standalone Roleを保持する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog / GitHub Issue #834 Roleと作成経路" }
  // fault = "起点Roleを欠落させるか、選択したworkspaceやCharacterを異なる作成条件へ変換する"
  // observable = "buildCreateSessionRequestFromLaunchDraftが返す作成要求全体"
  // observation_boundary = "public-boundary"
  // scope = "directory workspaceを選択した起点Sessionの作成要求"
  // lifecycle = "permanent"
  // impact = "ユーザーの選択と異なるRole・作業場所・CharacterでSessionを作ることを防ぐ"
  // distinction = "型だけでは値の対応を保証できず、UIの非同期試験より小さな純粋処理で作成条件の対応を確認する"
  // @end-test-value
  /** directoryを選んだドラフトから起点RoleとCharacterの表示情報を引き継ぎ、実行オプションは要求側で上書きしない。 */
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
      sessionRole: "standalone",
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

  /** Mate未作成でも、WithMateの中立ID・表示名・配色を持つ作成要求を返す。 */
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

  /** 固定選択したCharacterがarchivedへ変わった場合は、別のCharacterで作成要求を成立させない。 */
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
        createCharacterEntry({
          id: "noa",
          name: "Noa",
          description: "active profile",
        }),
      ],
    });

    assert.equal(input, null);
  });

  /** 必須の開始条件を満たさないドラフトからはSession作成要求を返さない。 */
  it("launch 条件が欠けている時は session input を返さない", () => {
    const input = buildCreateSessionRequestFromLaunchDraft({
      draft: createClosedLaunchDraft(),
      mateProfile: null,
      selectedProviderId: "codex",
    });

    assert.equal(input, null);
  });

  /** Session Folderを選んだ場合はdirectoryパスを事前確定せず、作成要求に選択種別だけを渡す。 */
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
