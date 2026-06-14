import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SETTINGS_API_KEY_LABEL,
  SETTINGS_API_KEY_PLACEHOLDER,
  SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE,
  SETTINGS_CODING_CREDENTIALS_HELP,
  SETTINGS_MATE_RESET_LABEL,
  SETTINGS_MATE_RESET_HELP,
  SETTINGS_RELEASE_COMPATIBILITY_NOTE,
  SETTINGS_RESET_DATABASE_HELP,
  SETTINGS_RESET_DATABASE_LABEL,
  buildResetMateConfirmMessage,
  buildResetDatabaseConfirmMessage,
  buildResetDatabaseSuccessMessage,
} from "../../src/settings/settings-ui.js";
import {
  buildDefaultCharacterDefinition,
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  isSettingsCharacterDraftDirty,
  resolveSettingsCharacterSelection,
  updateSettingsCharacterEditorDraft,
} from "../../src/settings/settings-character-editor-state.js";
import { HOME_WINDOW_DEFAULT_BOUNDS } from "../../src-electron/window-defaults.js";
import { DEFAULT_CHARACTER_THEME, type CharacterDetail } from "../../src/character/character-catalog.js";
import { ALL_RESET_APP_DATABASE_TARGETS } from "../../src/withmate-window-types.js";

describe("Settings UI constants", () => {
  it("coding credential の API key 文言は coding plane 専用だと分かる", () => {
    assert.equal(SETTINGS_API_KEY_LABEL, "OpenAI API Key (Coding Agent)");
    assert.equal(SETTINGS_API_KEY_PLACEHOLDER, "Coding Agent 用 OpenAI API Key を入力");
    assert.match(SETTINGS_CODING_CREDENTIALS_HELP, /Character Stream/);
    assert.match(SETTINGS_CODING_CREDENTIALS_FUTURE_NOTE, /future scope/);
  });

  it("初回リリース前の互換性方針と DB 初期化導線を文言で説明する", () => {
    assert.match(SETTINGS_RELEASE_COMPATIBILITY_NOTE, /初回リリース前/);
    assert.match(SETTINGS_RELEASE_COMPATIBILITY_NOTE, /後方互換性は考慮しない/);
    assert.equal(SETTINGS_RESET_DATABASE_LABEL, "DB を初期化");
    assert.match(SETTINGS_RESET_DATABASE_HELP, /Danger Zone/);
    assert.match(buildResetDatabaseConfirmMessage(ALL_RESET_APP_DATABASE_TARGETS), /本当に続ける/);
    assert.match(buildResetDatabaseConfirmMessage(ALL_RESET_APP_DATABASE_TARGETS), /実行中の session がある間は初期化できない/);
    assert.match(buildResetDatabaseSuccessMessage(ALL_RESET_APP_DATABASE_TARGETS), /初期状態へ戻した/);
  });

  it("Mate Reset は破壊的操作として意図と再確認文言が含まれる", () => {
    assert.equal(SETTINGS_MATE_RESET_LABEL, "Mate を初期化");
    assert.match(SETTINGS_MATE_RESET_HELP, /Danger Zone/);
    assert.match(SETTINGS_MATE_RESET_HELP, /破壊的/);
    assert.match(buildResetMateConfirmMessage(), /本当に続ける/);
  });

  it("Home Window は Settings overlay の余裕を確保する既定サイズを使う", () => {
    assert.deepEqual(HOME_WINDOW_DEFAULT_BOUNDS, {
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 680,
    });
  });

  it("Character editor draft は V5 character.md の初期本文を作る", () => {
    const draft = createNewCharacterEditorDraft("Mia");

    assert.equal(draft.mode, "create");
    assert.equal(draft.name, "Mia");
    assert.match(draft.definitionMarkdown, /schema: withmate-character-v5/);
    assert.match(draft.definitionMarkdown, /name: Mia/);
    assert.match(buildDefaultCharacterDefinition("   "), /name: New Character/);
  });

  it("Character editor draft は未編集の新規 character.md だけ name 変更に追従する", () => {
    const draft = createNewCharacterEditorDraft();
    const renamed = updateSettingsCharacterEditorDraft(draft, { name: "Mia" });

    assert.equal(renamed.name, "Mia");
    assert.match(renamed.definitionMarkdown, /name: Mia/);
    assert.match(renamed.definitionMarkdown, /- Mia/);

    const edited = updateSettingsCharacterEditorDraft(
      { ...draft, definitionMarkdown: `${draft.definitionMarkdown}\n## Custom\n` },
      { name: "Noa" },
    );
    assert.equal(edited.name, "Noa");
    assert.match(edited.definitionMarkdown, /name: New Character/);
    assert.match(edited.definitionMarkdown, /## Custom/);
  });

  it("Character editor は selection fallback と dirty 判定を持つ", () => {
    const detail: CharacterDetail = {
      id: "mia",
      name: "Mia",
      description: "first",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      state: "active",
      isDefault: true,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      archivedAt: null,
      definitionMarkdown: buildDefaultCharacterDefinition("Mia"),
      notesMarkdown: "# Character Notes\n",
    };
    const draft = createCharacterEditorDraftFromDetail(detail);

    assert.equal(resolveSettingsCharacterSelection([detail], "mia"), "mia");
    assert.equal(resolveSettingsCharacterSelection([detail], "missing"), "mia");
    assert.equal(isSettingsCharacterDraftDirty(draft, detail), false);
    assert.equal(isSettingsCharacterDraftDirty({ ...draft, description: "changed" }, detail), true);
    assert.equal(isSettingsCharacterDraftDirty(createNewCharacterEditorDraft(), null), true);
  });
});
