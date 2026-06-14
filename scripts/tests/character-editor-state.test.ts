import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CHARACTER_THEME, type CharacterDetail } from "../../src/character/character-catalog.js";
import {
  buildDefaultCharacterDefinition,
  buildCharacterEditorValidationSummary,
  buildCreateCharacterInputFromDraft,
  createCharacterEditorDraftFromDetail,
  createNewCharacterEditorDraft,
  isCharacterEditorDraftDirty,
  replaceCharacterDefinitionDraft,
  updateCharacterEditorDraft,
} from "../../src/character-editor/character-editor-state.js";

describe("Character editor state", () => {
  it("新規 draft は V5 character.md の初期本文を作る", () => {
    const draft = createNewCharacterEditorDraft("Mia");

    assert.equal(draft.mode, "create");
    assert.equal(draft.name, "Mia");
    assert.match(draft.definitionMarkdown, /schema: withmate-character-v5/);
    assert.match(draft.definitionMarkdown, /name: Mia/);
    assert.match(buildDefaultCharacterDefinition("   "), /name: New Character/);
  });

  it("未編集の新規 character.md だけ name 変更に追従する", () => {
    const draft = createNewCharacterEditorDraft();
    const renamed = updateCharacterEditorDraft(draft, { name: "Mia" });

    assert.equal(renamed.name, "Mia");
    assert.match(renamed.definitionMarkdown, /name: Mia/);
    assert.match(renamed.definitionMarkdown, /- Mia/);

    const edited = updateCharacterEditorDraft(
      { ...draft, definitionMarkdown: `${draft.definitionMarkdown}\n## Custom\n` },
      { name: "Noa" },
    );
    assert.equal(edited.name, "Noa");
    assert.match(edited.definitionMarkdown, /name: New Character/);
    assert.match(edited.definitionMarkdown, /## Custom/);
  });

  it("persisted detail から dirty 判定できる", () => {
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

    assert.equal(isCharacterEditorDraftDirty(draft, detail), false);
    assert.equal(isCharacterEditorDraftDirty({ ...draft, description: "changed" }, detail), true);
    assert.equal(isCharacterEditorDraftDirty({ ...draft, state: "archived" }, detail), true);
    assert.equal(isCharacterEditorDraftDirty(createNewCharacterEditorDraft(), null), true);
  });

  it("create payload は default fallback を潰す setDefault false を渡さない", () => {
    const draft = createNewCharacterEditorDraft("Mia");

    assert.deepEqual(buildCreateCharacterInputFromDraft(draft), {
      name: "Mia",
      description: "",
      iconFilePath: "",
      theme: { ...DEFAULT_CHARACTER_THEME },
      definitionMarkdown: draft.definitionMarkdown,
      notesMarkdown: "# Character Notes\n",
    });
    assert.equal(buildCreateCharacterInputFromDraft({ ...draft, isDefault: true }).setDefault, true);
  });

  it("import / replace は character.md draft だけを置き換える", () => {
    const draft = createNewCharacterEditorDraft("Mia");
    const replaced = replaceCharacterDefinitionDraft(draft, "---\nschema: withmate-character-v5\nname: Noa\n---\n\n# Noa\n");

    assert.match(replaced.definitionMarkdown, /name: Noa/);
    assert.equal(replaced.notesMarkdown, draft.notesMarkdown);
    assert.equal(replaced.name, "Mia");
  });

  it("definition / notes validation issue を集約する", () => {
    const summary = buildCharacterEditorValidationSummary({
      ...createNewCharacterEditorDraft("Mia"),
      definitionMarkdown: "# missing frontmatter",
      notesMarkdown: "invalid\0notes",
    });

    assert.ok(summary.definitionIssues.length > 0);
    assert.ok(summary.notesIssues.length > 0);
    assert.equal(summary.blockingIssues.length, summary.definitionIssues.length + summary.notesIssues.length);
  });
});
