import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CharacterCatalogEntry } from "../../src-shared/character/character-catalog.js";
import { createDefaultAppSettings } from "../../src-shared/settings/provider-settings-state.js";
import type { ModelCatalogSnapshot } from "../../src-shared/settings/model-catalog.js";
import {
  buildHomeLaunchProjection,
  inferWorkspaceFromPath,
} from "../../src/home/home-launch-projection.js";

/** CodexとCopilotで同じモデルを提供する候補一覧を組み立てる。 */
function createCatalog(): ModelCatalogSnapshot {
  return {
    providers: [
      {
        id: "codex",
        label: "Codex",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] },
        ],
      },
      {
        id: "copilot",
        label: "Copilot",
        defaultModelId: "gpt-5.4",
        defaultReasoningEffort: "high",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", reasoningEfforts: ["high"] },
        ],
      },
    ],
  };
}

/** 起動時に選択可能な二人の有効なキャラクターを用意する。 */
function createCharacters(): CharacterCatalogEntry[] {
  return [
    {
      id: "mia",
      name: "Mia",
      description: "default",
      iconFilePath: "",
      theme: { main: "#111111", sub: "#eeeeee" },
      state: "active",
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
      createdAt: "",
      updatedAt: "",
      archivedAt: null,
    },
  ];
}

/** 起動フォームが選択肢と入力から表示内容・開始可否を求める契約を確かめる。 */
describe("home-launch-projection", () => {
  /** ディレクトリパスの末尾を表示名に採用し、ブランチは未指定のまま扱う。 */
  it("workspace path から launch workspace を作る", () => {
    assert.deepEqual(inferWorkspaceFromPath("F:/work/demo"), {
      label: "demo",
      path: "F:/work/demo",
      branch: "",
    });
  });

  // @test-value v2
  // kind = "contract"
  // claim = "有効providerがない場合は選択providerなしとなりSessionを開始できない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog" }
  // fault = "無効providerを開始候補に含める"
  // observable = "enabledLaunchProviders、selectedLaunchProvider、canStartSession"
  // observation_boundary = "public-boundary"
  // scope = "Home launch provider availability"
  // lifecycle = "permanent"
  // @end-test-value
  /** 有効なプロバイダーがない場合、ランダム表示でもプロバイダーとキャラクターが未選択で起動できない。 */
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
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.deepEqual(
      projection.enabledLaunchProviders.map((provider) => provider.id),
      [],
    );
    assert.equal(projection.selectedLaunchProvider, null);
    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.randomCharacterSelected, true);
    assert.equal(projection.canStartSession, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "有効provider・Character・タイトル・directory workspaceが揃うと開始可能になり選択内容を表示へ投影する"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialog" }
  // fault = "有効providerを選べない、明示Characterを取り違える、またはdirectory開始をSessionFolderとして投影する"
  // observable = "providerとCharacter選択値、workspace表示、sessionFolderSelected=false、canStartSession=true"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-positive-projection"
  // lifecycle = "permanent"
  // @end-test-value
  /** 有効なCodexだけを表示し、指定キャラクター、タイトル、ディレクトリが揃えば起動できる。 */
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
      launchCharacterSelectionMode: "specific",
      characterEntries: createCharacters(),
      appSettings: settings,
      modelCatalog: createCatalog(),
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.deepEqual(
      enabledOnlyCodex.enabledLaunchProviders.map((provider) => provider.id),
      ["codex"],
    );
    assert.equal(enabledOnlyCodex.selectedLaunchProvider?.id, "codex");
    assert.equal(enabledOnlyCodex.selectedCharacter?.id, "noa");
    assert.equal(enabledOnlyCodex.randomCharacterSelected, false);
    assert.deepEqual(
      enabledOnlyCodex.characterOptions.map((character) => character.id),
      ["mia", "noa"],
    );
    assert.equal(enabledOnlyCodex.launchWorkspacePathLabel, "F:/work/demo");
    assert.equal(enabledOnlyCodex.sessionFolderSelected, false);
    assert.equal(enabledOnlyCodex.canStartSession, true);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Session Folder選択時は未確定pathを表示せず、選択状態として投影して開始可能にする"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md: New Session dialog" }
  // fault = "未確定pathを表示するか、Session Folderの選択を未選択として扱う"
  // observable = "Session Folder表示、sessionFolderSelected、workspaceSelected、canStartSession"
  // observation_boundary = "public-boundary"
  // scope = "home-launch-session-folder-projection"
  // lifecycle = "permanent"
  // @end-test-value
  /** 起動前の未確定パスは表示せず、Session Folderの指定を有効なワークスペース選択として扱う。 */
  it("SessionFolder 選択時は未確定 path の代わりに選択状態を投影する", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "task",
      launchWorkspace: { kind: "session-folder" },
      characterEntries: createCharacters(),
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.equal(projection.launchWorkspacePathLabel, "Session Folder");
    assert.equal(projection.sessionFolderSelected, true);
    assert.equal(projection.workspaceSelected, true);
    assert.equal(projection.canStartSession, true);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "Random選択は固定Character選択と排他で、取得前提と入力が揃えば開始できる"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog" }
  // fault = "Randomと固定Characterを同時選択にするか、準備済みのRandomを開始不可にする"
  // observable = "selectedCharacter、randomCharacterSelected、canStartSession"
  // observation_boundary = "public-boundary"
  // scope = "Home launch random selection projection"
  // lifecycle = "permanent"
  // @end-test-value
  /** 固定IDが残っていてもランダム選択と同時表示せず、必要な取得が済めば起動を許可する。 */
  it("random character選択時は固定Characterを選択状態にしない", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "task",
      launchWorkspace: { label: "demo", path: "F:/work/demo", branch: "" },
      launchCharacterId: "mia",
      launchCharacterSelectionMode: "random",
      characterEntries: createCharacters(),
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.randomCharacterSelected, true);
    assert.equal(projection.canStartSession, true);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "固定Characterがactive一覧に存在しない場合はSessionを開始できない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog" }
  // fault = "不存在のCharacterを選択済みとして開始可能にする"
  // observable = "selectedCharacter、randomCharacterSelected、canStartSession"
  // observation_boundary = "public-boundary"
  // scope = "Home launch specific Character validity"
  // lifecycle = "permanent"
  // @end-test-value
  /** 有効な候補一覧にない固定IDを、ランダムや選択済みとして扱わない。 */
  it("specific Character がactive一覧に存在しない場合は開始不可にする", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "task",
      launchWorkspace: { label: "demo", path: "F:/work/demo", branch: "" },
      launchCharacterId: "missing",
      launchCharacterSelectionMode: "specific",
      characterEntries: createCharacters(),
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.randomCharacterSelected, false);
    assert.equal(projection.canStartSession, false);
  });

  // @test-value v2
  // kind = "invariant"
  // claim = "Character catalogが未取得の間は履歴等が取得済みでもSessionを開始できない"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md New Session dialog" }
  // fault = "未取得catalogを正常0件としてneutralで開始可能にする"
  // observable = "charactersLoaded、selectedCharacter、canStartSession"
  // observation_boundary = "public-boundary"
  // scope = "Home launch Character catalog readiness"
  // lifecycle = "permanent"
  // @end-test-value
  /** キャラクターの未取得を取得済みの空一覧と区別し、履歴を取得済みでも開始を待たせる。 */
  it("Character catalog 読み込み前は開始不可にする", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "task",
      launchWorkspace: { label: "demo", path: "F:/work/demo", branch: "" },
      characterEntries: [],
      charactersLoaded: false,
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.equal(projection.charactersLoaded, false);
    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.canStartSession, false);
  });

  // @test-value v2
  // kind = "contract"
  // claim = "有効providerがあってもtitleが空かつworkspace未選択の通常Sessionは開始不可とする"
  // oracle = { type = "contract", ref = "docs/design/desktop-ui.md#home-window New Session dialog" }
  // fault = "titleが空かつworkspace未選択の入力を開始可能とする"
  // observable = "projected canStartSession, sessionFolderSelected, and selectedCharacter"
  // observation_boundary = "public-boundary"
  // scope = "home launch projection normal session"
  // lifecycle = "permanent"
  // distinction = "このcaseは入力欠落時のprojectionを確認し、有効入力は同fileのpositive case、個々の不足条件とvalidation messageはhome-launch-state.test.tsが担う"
  // @end-test-value
  /** プロバイダーを選べても、通常起動のタイトルとワークスペースが未入力なら起動不可にする。 */
  it("通常 Session は標準の開始条件を使う", () => {
    const projection = buildHomeLaunchProjection({
      launchProviderId: "codex",
      launchTitle: "",
      launchWorkspace: null,
      characterEntries: [],
      appSettings: createDefaultAppSettings(),
      modelCatalog: createCatalog(),
      sessionCharacterUsageLoadStatus: "loaded",
      openSessionWindowIdsLoadStatus: "loaded",
    });

    assert.equal(projection.selectedLaunchProvider?.id, "codex");
    assert.equal(projection.selectedCharacter, null);
    assert.equal(projection.canStartSession, false);
    assert.equal(projection.sessionFolderSelected, false);
  });
});
